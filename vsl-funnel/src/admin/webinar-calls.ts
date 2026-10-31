import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { saveSettings } from '../settings';
import type { Lead } from '../funnel/leads';
import { dial, elevenConfigured } from '../integrations/elevenlabs';
import { FLOWS, type FlowId, W_KINDS, type WKind, callVariables, provisionWebinarAgent, sampleCtx, saveConfig, webinarCallsReport } from '../integrations/webinar-calls';

/**
 * Funnel HQ → AI calls → Webinar calls (mounted at /admin/api/webinar-calls, admin only): per-flow toggles,
 * scripts and cadence, the upcoming queue, outcomes and revenue after calls, the agent and a "call me" test.
 */
export const webinarCallsAdmin = new Hono<AppEnv>();

const body = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
const fail = (c: Context<AppEnv>, e: unknown, status: 400 | 500 = 400) => c.json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 600) }, status);
const range = (c: Context<AppEnv>) => {
  const to = Number(c.req.query('to')) || Date.now();
  const from = Number(c.req.query('from')) || to - 30 * 86_400_000;
  return { from, to };
};

webinarCallsAdmin.get('/', async (c) => c.json(await webinarCallsReport(runtimeFrom(c), range(c))));

webinarCallsAdmin.post('/config', async (c) => {
  const r = await saveConfig(runtimeFrom(c), await body(c));
  return r.ok ? c.json(r) : c.json(r, 400);
});

webinarCallsAdmin.post('/toggle', async (c) => {
  const b = await body(c);
  const flow = FLOWS.find((f) => f.id === (b.flow as FlowId));
  if (!flow) return fail(c, 'Unknown flow');
  await saveSettings(c.env, { [flow.setting]: b.on ? 'true' : 'false' });
  return c.json({ ok: true });
});

webinarCallsAdmin.post('/rules', async (c) => {
  const b = await body(c);
  const vals: Record<string, string> = {};
  const num = (v: unknown, lo: number, hi: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? String(n) : null; };
  const wait = num(b.leftWaitMin, 3, 60), week = num(b.weeklyCap, 0, 14);
  if (b.leftWaitMin != null && wait) vals.AI_CALL_W_LEFT_WAIT_MIN = wait;
  if (b.weeklyCap != null && week) vals.AI_CALL_WEEKLY_CAP = week;
  if (typeof b.ownerNumber === 'string') {
    const n = b.ownerNumber.replace(/[^\d+]/g, '');
    if (n && !/^\+\d{8,15}$/.test(n)) return fail(c, 'Enter your number in international format, e.g. +61412345678');
    vals.AI_CALL_OWNER_NUMBER = n;
  }
  await saveSettings(c.env, vals);
  return c.json({ ok: true });
});

webinarCallsAdmin.post('/provision', async (c) => {
  try {
    const r = await provisionWebinarAgent(runtimeFrom(c));
    await saveSettings(c.env, { ELEVENLABS_WEBINAR_AGENT_ID: r.id });
    return c.json({ ok: true, ...r });
  } catch (e) { return fail(c, e); }
});

webinarCallsAdmin.post('/cancel/:id', async (c) => {
  await c.env.DB.prepare("UPDATE outbound_calls SET status = 'cancelled', error = 'cancelled in Funnel HQ', updated_at = ? WHERE id = ? AND status = 'queued' AND kind LIKE 'w\\_%' ESCAPE '\\'").bind(Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

// Rings the owner's phone with one flow's script, real offer settings and a made-up session.
webinarCallsAdmin.post('/test', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings as Partial<Record<string, string>>;
  if (!elevenConfigured(rt.settings) || !s.ELEVENLABS_WEBINAR_AGENT_ID) return fail(c, 'Connect ElevenLabs, pick a phone number and create the webinar call agent first.');
  const b = await body(c);
  const number = String(b.to || s.AI_CALL_OWNER_NUMBER || '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(number)) return fail(c, 'Enter your number in international format, e.g. +61412345678');
  const kind = (W_KINDS as readonly string[]).includes(String(b.kind)) ? (b.kind as WKind) : 'w_pre_welcome';
  const lead = { id: 'test', ref_code: 'TEST01', first_name: 'there', email: null, phone: number, timezone: null, country: null } as unknown as Lead;
  const sample = sampleCtx(rt, kind);
  try {
    const vars = await callVariables(rt, kind, lead, sample.ctx, sample.purchase, sample.meta, 1);
    const r = await dial(rt, lead, 'test', undefined, number, { agentId: String(s.ELEVENLABS_WEBINAR_AGENT_ID), vars });
    return c.json({ ok: true, conversationId: r.conversationId });
  } catch (e) { return fail(c, e); }
});
