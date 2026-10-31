/**
 * Funnel HQ → Ads autopilot and Follow-up actions (mounted at /admin/api/autopilot).
 *
 *   GET    /                      ads with badges, ad sets, proposals waiting, history, angle drafts, settings
 *   POST   /sync                  read Meta at ad level now, then run the rules
 *   POST   /run                   run the rules on what's stored
 *   POST   /actions/:id/approve   { manual?: true } approve (manual = "I applied it in Ads Manager myself")
 *   POST   /actions/:id/reject
 *   PUT    /actions/:id           Edit before approving: { amount } (budget shift, currency units) or { drafts, adset_id, creative_id }
 *   POST   /angle                 { angle, evidence?, adset_id?, creative_id? } draft three ads and queue the launch
 *   PUT    /settings              the ADS_* thresholds and targets
 *   GET    /followups             the plays, recent batches
 *   POST   /followups             { play, days?, stages?, channels? } draft and queue one bulk proposal
 *   GET    /followups/:batch      every drafted message in a batch
 *   PUT    /followups/msg/:id     { subject?, text } edit one drafted message
 *   DELETE /followups/msg/:id     drop one message from the batch
 */
import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { saveSettings } from '../settings';
import { decideAction, getAction, listActions, updateActionPayload } from '../ops/actions';
import { metaAdsConfigured, metaWriteConfigured, syncAdLevel } from '../integrations/meta-ads';
import { adsTargets, autopilotOn, boundShift, loadAdStats, logSync, runAutopilot, verdicts } from './autopilot';
import { type AdDraft, auditDraft, draftAndPropose } from './angles';
import { type Channel, type Play, MAX_PER_BATCH, QUIET_STAGES, SALES_PLAYS, emailPreviewText, proposeFollowups } from '../sales/followups';
import type { EmailContent } from '../integrations/templates';

export const autopilotAdmin = new Hono<AppEnv>();

const fail = (c: { json: (b: unknown, s?: number) => Response }, e: unknown) => c.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400);
const SETTING_KEYS = ['ADS_AUTOPILOT', 'ADS_TARGET_CPL', 'ADS_TARGET_CPA_TICKET', 'ADS_TARGET_CPA_DEPOSIT', 'ADS_TARGET_CPA_BOOKING', 'ADS_LOSER_SPEND', 'ADS_MAX_DAILY_SHIFT_PCT', 'ADS_MAX_DAILY_BUDGET', 'ADS_FATIGUE_FREQUENCY', 'ADS_FATIGUE_CTR_DROP_PCT', 'ADS_WINNER_MIN_RESULTS', 'ADS_PAGE_ID', 'ADS_LANDING_URL', 'SALES_QUIET_DAYS'] as const;
const parse = (s: string | null) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };

autopilotAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings as unknown as Record<string, string>;
  const t = adsTargets(s);
  const db = rt.env.DB;
  const [stats, adsets, proposals, history, drafts, synced, shifts] = await Promise.all([
    loadAdStats(rt, 14),
    db.prepare("SELECT id, name, daily_budget, effective_status, campaign_id FROM ad_entities WHERE level = 'adset' ORDER BY name").all<{ id: string; name: string | null; daily_budget: number | null; effective_status: string | null; campaign_id: string | null }>(),
    listActions(rt, { dept: 'marketing', status: ['proposed'], limit: 100 }),
    listActions(rt, { dept: 'marketing', status: ['done', 'failed', 'rejected', 'approved'], limit: 60 }),
    db.prepare('SELECT id, angle, drafts, adset_id, creative_id, status, ad_ids, spec, action_id, error, created_at FROM ads_angle_drafts ORDER BY created_at DESC LIMIT 20').all<Record<string, unknown>>(),
    db.prepare("SELECT value FROM settings WHERE key = '_meta_ads_level_synced_at'").first<{ value: string }>().catch(() => null),
    db.prepare('SELECT day, adset_id, delta, before_amt, after_amt, applied, created_at FROM ads_budget_shifts ORDER BY created_at DESC LIMIT 20').all(),
  ]);
  const ads = stats.map((a) => {
    const v = verdicts(a, t);
    return {
      ad_id: a.ad_id, name: a.name, adset_id: a.adset_id, status: a.status, currency: a.currency,
      spend: a.spend, impressions: a.impressions, link_clicks: a.link_clicks, ctr: a.ctr, cpc: a.cpc, frequency: a.frequency,
      results: { ...a.results, leadDays: undefined },
      cpl: a.results.leads ? a.spend / a.results.leads : null,
      cpaTicket: a.results.tickets ? a.spend / a.results.tickets : null,
      cpaDeposit: a.results.deposits ? a.spend / a.results.deposits : null,
      badges: v.map((x) => x.rule), reasons: v.flatMap((x) => x.reasons),
      trend: a.days.slice(-14).map((d) => ({ day: d.day, ctr: d.impressions ? (d.link_clicks * 100) / d.impressions : null, spend: d.spend })),
    };
  });
  const notes: string[] = [];
  if (!metaAdsConfigured(rt)) notes.push('Connect Meta first: a token with ads_read and the ad account (Traffic & ads → Connect ad account). Until then there is nothing to read.');
  if (!metaWriteConfigured(rt)) notes.push('No write token yet: proposals come with apply-manually steps. Add a Meta system-user token with ads_management under Keys & settings → Ads (META_ADS_WRITE_TOKEN) so approved changes reach Meta.');
  if (!t.ticket && !t.deposit && !t.booking) notes.push('Set at least one target cost (ticket, deposit or booked call) below so the autopilot can call winners.');
  if (stats.length && !stats.some((a) => a.results.leads)) notes.push('No leads matched to an ad yet. Add utm_content={{ad.id}} to every ad\'s URL parameters so results are counted per ad.');
  if (!rt.settings.ANTHROPIC_API_KEY) notes.push('Ad drafts from angles need the Anthropic API key (Keys & settings → Email).');
  return c.json({
    configured: metaAdsConfigured(rt), write: metaWriteConfigured(rt), on: autopilotOn(s), syncedAt: synced ? Number(synced.value) : null,
    targets: t, settings: Object.fromEntries(SETTING_KEYS.map((k) => [k, s[k] ?? ''])),
    ads, adsets: adsets.results, shifts: shifts.results,
    proposals: proposals.map((p) => ({ ...p, payload: parse(p.payload) })),
    history: history.map((p) => ({ ...p, payload: parse(p.payload) })),
    drafts: drafts.results.map((d) => ({ ...d, drafts: parse(d.drafts as string), ad_ids: parse(d.ad_ids as string) })),
    notes,
  });
});

autopilotAdmin.post('/sync', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const synced = await syncAdLevel(rt, 14);
    if (!synced) return c.json({ ok: false, error: 'Connect a Meta token and ad account first.' }, 400);
    const run = autopilotOn(rt.settings as unknown as Record<string, string>) ? await runAutopilot(rt) : null;
    await logSync(rt, `Read ${synced.rows} ad-days from Meta; ${run ? `${run.proposed.length} new proposal${run.proposed.length === 1 ? '' : 's'}` : 'autopilot off'}.`);
    return c.json({ ok: true, synced, run });
  } catch (e) { return fail(c, e); }
});
autopilotAdmin.post('/run', async (c) => { try { return c.json({ ok: true, run: await runAutopilot(runtimeFrom(c)) }); } catch (e) { return fail(c, e); } });

autopilotAdmin.post('/actions/:id/approve', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as { manual?: boolean };
  const row = await getAction(rt, id);
  if (!row) return c.json({ ok: false, error: 'Not found' }, 404);
  if (body.manual && row.status === 'proposed') await updateActionPayload(rt, id, { ...(parse(row.payload) ?? {}), manual_ack: true });
  const r = await decideAction(rt, id, 'approve', 'you');
  return c.json({ ok: r.ok, summary: r.summary });
});
autopilotAdmin.post('/actions/:id/reject', async (c) => {
  const r = await decideAction(runtimeFrom(c), c.req.param('id'), 'reject', 'you');
  return c.json({ ok: r.ok, summary: r.summary });
});
autopilotAdmin.put('/actions/:id', async (c) => {
  const rt = runtimeFrom(c);
  const id = c.req.param('id');
  const row = await getAction(rt, id);
  if (!row || row.status !== 'proposed') return c.json({ ok: false, error: 'Only a proposal still waiting can be edited.' }, 400);
  const payload = (parse(row.payload) ?? {}) as Record<string, unknown>;
  const b = (await c.req.json().catch(() => ({}))) as { amount?: number; drafts?: AdDraft[]; adset_id?: string; creative_id?: string };
  if (row.kind === 'marketing.shift_budget' && b.amount != null) {
    const t = adsTargets(rt.settings as unknown as Record<string, string>);
    const minor = Math.round(Number(b.amount) * 100);
    const bounded = boundShift({ fromBudget: Number(payload.from_before) || 0, toBudget: Number(payload.to_before) || 0, requested: minor, maxPct: t.maxShiftPct, cap: t.maxDailyBudget != null ? t.maxDailyBudget * 100 : null });
    if (bounded.amount < 100) return c.json({ ok: false, error: `That's outside today's limit (${t.maxShiftPct}% of either daily budget).` }, 400);
    payload.amount = bounded.amount;
    await updateActionPayload(rt, id, payload, `Move ${(bounded.amount / 100).toFixed(2)}/day from "${payload.from_name}" to "${payload.to_name}"`);
    return c.json({ ok: true, amount: bounded.amount / 100, capped: bounded.amount !== minor });
  }
  if (row.kind === 'marketing.launch_angle_ads') {
    if (Array.isArray(b.drafts)) {
      const drafts = b.drafts.slice(0, 3).map((d, i) => ({ primary: String(d.primary ?? '').trim(), headline: String(d.headline ?? '').trim(), description: String(d.description ?? '').trim(), utm_content: (payload.drafts as AdDraft[] | undefined)?.[i]?.utm_content ?? `edit-v${i + 1}` }));
      const issues = drafts.flatMap((d, i) => auditDraft(d).map((x) => `Variant ${i + 1}: ${x.rule} ("${x.excerpt}")`));
      if (issues.length) return c.json({ ok: false, error: issues.slice(0, 5).join(' · ') }, 400);
      payload.drafts = drafts;
    }
    if (b.adset_id !== undefined) payload.adset_id = /^\d{1,30}$/.test(String(b.adset_id)) ? String(b.adset_id) : null;
    if (b.creative_id !== undefined) payload.creative_id = /^\d{1,30}$/.test(String(b.creative_id)) ? String(b.creative_id) : null;
    await updateActionPayload(rt, id, payload);
    return c.json({ ok: true });
  }
  return c.json({ ok: false, error: 'This proposal has nothing to edit: approve or reject it.' }, 400);
});

autopilotAdmin.post('/angle', async (c) => {
  const rt = runtimeFrom(c);
  const b = (await c.req.json().catch(() => ({}))) as { angle?: string; evidence?: string; adset_id?: string; creative_id?: string };
  try {
    const r = await draftAndPropose(rt, { angle: String(b.angle ?? ''), evidence: b.evidence ? String(b.evidence) : undefined, adset_id: b.adset_id ? String(b.adset_id) : undefined, creative_id: b.creative_id ? String(b.creative_id) : undefined });
    return c.json({ ok: true, id: r.id, actionId: r.actionId, drafts: r.drafts, dropped: r.dropped });
  } catch (e) { return fail(c, e); }
});

autopilotAdmin.put('/settings', async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const k of SETTING_KEYS) if (k in b) values[k] = String(b[k] ?? '').trim().slice(0, 300);
  if (values.ADS_MAX_DAILY_SHIFT_PCT && !(Number(values.ADS_MAX_DAILY_SHIFT_PCT) > 0 && Number(values.ADS_MAX_DAILY_SHIFT_PCT) <= 100)) return c.json({ ok: false, error: 'The daily shift limit is a percentage between 1 and 100.' }, 400);
  await saveSettings(c.env, values);
  return c.json({ ok: true });
});

// ───────────── Sales: follow-up actions ─────────────

autopilotAdmin.get('/followups', async (c) => {
  const rt = runtimeFrom(c);
  const { results: batches } = await rt.env.DB.prepare(
    `SELECT batch_id, action_id, play, MIN(created_at) AS created_at, COUNT(*) AS messages, COUNT(DISTINCT lead_id) AS leads,
            SUM(status IN ('sent', 'simulated')) AS sent, SUM(status = 'simulated') AS simulated, SUM(status = 'queued') AS queued, SUM(status = 'skipped') AS skipped, SUM(status = 'failed') AS failed, SUM(status = 'draft') AS drafts
       FROM ops_followup_messages GROUP BY batch_id ORDER BY created_at DESC LIMIT 30`,
  ).all<Record<string, unknown> & { action_id: string | null }>();
  const actions = await Promise.all(batches.map((b) => (b.action_id ? getAction(rt, b.action_id) : null)));
  return c.json({
    plays: (Object.keys(SALES_PLAYS) as Play[]).map((id) => ({ id, label: SALES_PLAYS[id].label, describe: SALES_PLAYS[id].describe })),
    stages: QUIET_STAGES, quietDays: Number(rt.settings.SALES_QUIET_DAYS) || 5, maxPerBatch: MAX_PER_BATCH,
    batches: batches.map((b, i) => ({ ...b, action_status: actions[i]?.status ?? null, result: actions[i]?.result ?? null, summary: actions[i]?.summary ?? null })),
  });
});
autopilotAdmin.post('/followups', async (c) => {
  const rt = runtimeFrom(c);
  const b = (await c.req.json().catch(() => ({}))) as { play?: string; days?: number; stages?: string[]; channels?: string[] };
  if (!b.play || !(b.play in SALES_PLAYS)) return c.json({ ok: false, error: 'Pick a follow-up action.' }, 400);
  try {
    const r = await proposeFollowups(rt, b.play as Play, { days: b.days ? Number(b.days) : undefined, stages: Array.isArray(b.stages) ? b.stages.map(String) : undefined, channels: Array.isArray(b.channels) ? (b.channels.map(String) as Channel[]) : undefined });
    return c.json({ ok: true, ...r });
  } catch (e) { return fail(c, e); }
});
autopilotAdmin.get('/followups/:batch', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.lead_id, f.channel, f.to_addr, f.subject, f.body, f.status, f.send_at, f.sent_at, f.error, f.play, l.first_name, l.last_name, l.status AS lead_status
       FROM ops_followup_messages f LEFT JOIN leads l ON l.id = f.lead_id WHERE f.batch_id = ? ORDER BY l.first_name, f.channel`,
  ).bind(c.req.param('batch')).all<Record<string, unknown> & { channel: string; body: string }>();
  return c.json({ messages: results.map((m) => ({ ...m, text: m.channel === 'email' ? emailPreviewText(JSON.parse(m.body) as EmailContent) : m.body, body: undefined })) });
});
const editable = async (db: D1Database, id: string) => db.prepare("SELECT id, channel, body, status FROM ops_followup_messages WHERE id = ? AND status = 'draft'").bind(id).first<{ id: string; channel: string; body: string; status: string }>();
autopilotAdmin.put('/followups/msg/:id', async (c) => {
  const m = await editable(c.env.DB, c.req.param('id'));
  if (!m) return c.json({ ok: false, error: 'Only a message still waiting for approval can be edited.' }, 400);
  const b = (await c.req.json().catch(() => ({}))) as { subject?: string; text?: string };
  const text = String(b.text ?? '').trim();
  if (!text) return c.json({ ok: false, error: 'The message is empty.' }, 400);
  if (m.channel === 'sms') {
    const body = /\bSTOP\b/.test(text) ? text : `${text}\nReply STOP to opt out.`;
    await c.env.DB.prepare('UPDATE ops_followup_messages SET body = ? WHERE id = ?').bind(body.slice(0, 640), m.id).run();
  } else {
    const content = JSON.parse(m.body) as EmailContent;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // The button line in the preview ("[label] url") stays as drafted; only the paragraphs and subject change.
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p && !/^\[[^\]]+\] https?:\/\//.test(p) && !/^P\.S\. /.test(p));
    content.body = paras.map((p) => esc(p).replace(/\n/g, '<br>'));
    if (b.subject?.trim()) content.subject = b.subject.trim().slice(0, 150);
    await c.env.DB.prepare('UPDATE ops_followup_messages SET body = ?, subject = ? WHERE id = ?').bind(JSON.stringify(content), content.subject, m.id).run();
  }
  return c.json({ ok: true });
});
autopilotAdmin.delete('/followups/msg/:id', async (c) => {
  const r = await c.env.DB.prepare("UPDATE ops_followup_messages SET status = 'rejected', error = 'removed before approval' WHERE id = ? AND status = 'draft'").bind(c.req.param('id')).run();
  return c.json({ ok: Boolean(r.meta.changes) });
});
