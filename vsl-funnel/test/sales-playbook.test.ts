import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { FAQS, inboundCallbackPrompt, outboundSystemPrompt, voiceSystemPrompt } from '../src/config';
import { auditCopy, auditEmail } from '../src/content/copy-rules';
import { type Lead, getLead } from '../src/funnel/leads';
import { AI_CALLER } from '../src/config';
import { buildAgent, handleElevenWebhook, variables } from '../src/integrations/elevenlabs';
import { buildInboundAgent, varsFor } from '../src/integrations/elevenlabs-inbound';
import {
  type CallContext, GUARDRAILS_CRITERION, NEXT_ACTIONS, NEXT_ACTION_CRITERION, PAIN_POINTS, RESOURCES, SALES_GUARDRAILS, SALES_PLAYBOOK, resourceMenu,
} from '../src/integrations/sales-playbook';
import { TEMPLATES } from '../src/integrations/templates';
import { afterSalesCall, knownPainLine, leadPain, resourceBlock, sendResourceEmail } from '../src/integrations/voice-resources';
import { STRUCTURED_SCHEMA } from '../src/integrations/voice';
import { W_FIRST_MESSAGE, W_KINDS, buildWebinarAgent, callVariables, missedPart, webinarAgentPrompt } from '../src/integrations/webinar-calls';
import { GUIDES } from '../src/seo/guides';
import { DEMO_SCENARIOS } from '../src/admin/voice-demo';
import { callSales, cleanInput } from '../src/admin/sandbox';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const T0 = Date.parse('2026-11-03T02:00:00Z');
const SETTINGS: Record<string, string> = {
  ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: 'agent_main', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', ELEVENLABS_WEBINAR_AGENT_ID: 'agent_web',
  AI_CALL_CALLBACK_NUMBER: '+61 2 9000 0000', SALES_TIMEZONE: 'Australia/Sydney', SITE_NAME: 'G&L', JOSH_WHATSAPP: '', EMAIL_SIGNATURE: 'Josh', BUSINESS_ADDRESS: 'Sydney',
};
let db: DatabaseSync;
let rt: Runtime;
const makeRt = () => ({ env: { DB: d1(db) }, settings: { ...SETTINGS }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { void p.catch(() => null); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a.map((v) => (v === undefined ? null : v)) as (string | number | null)[]));
let n = 0;
function seedLead(o: { unsub?: boolean; stop?: boolean; dnc?: boolean; email?: string | null } = {}) {
  const id = `l${++n}`;
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, phone, call_consent_at, call_consent_text, do_not_call_at, unsubscribed_at, sms_opt_out_at, status, tier, app_completed_at)
     VALUES (?, ?, ?, ?, 'Dana', ?, '+61412345678', ?, 'v2', ?, ?, ?, 'applied', 'A', ?)`,
    id, `R${n}X`, T0, T0, o.email === undefined ? `dana${n}@example.com` : o.email, T0, o.dnc ? T0 : null, o.unsub ? T0 : null, o.stop ? T0 : null, T0);
  return id;
}
const lead = async (id: string) => (await getLead(rt.env, id))!;
const resourceMails = (id: string) => q<{ template: string; status: string; step: number }>("SELECT template, status, step FROM emails WHERE lead_id = ? AND sequence = 'resource'", id);

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); db = freshDb(); rt = makeRt(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

// ───────────── the playbook and guardrails ─────────────

const PROMPTS = {
  outbound: outboundSystemPrompt(FAQS),
  inbound: inboundCallbackPrompt(FAQS),
  vapi: voiceSystemPrompt(FAQS),
  webinar: webinarAgentPrompt(),
};

describe('the sales playbook is in every voice agent', () => {
  for (const [name, p] of Object.entries(PROMPTS)) {
    it(`${name}: playbook, resource menu and guardrails are present, guardrails last`, () => {
      expect(p).toContain(SALES_PLAYBOOK);
      expect(p).toContain(resourceMenu());
      expect(p).toContain(SALES_GUARDRAILS);
      expect(p.indexOf(SALES_GUARDRAILS)).toBeGreaterThan(p.indexOf(SALES_PLAYBOOK));
      expect(p).toMatch(/Your objective on this call/);
    });
  }

  it('names the techniques: NEPQ consequence questions, labels, mirrors, calibrated and no-oriented questions, accusation audit, reframes, future pacing', () => {
    for (const re of [/What's that costing you/, /Label what you hear/, /Mirror:/, /Calibrated questions start with "what" or "how"/, /No-oriented questions/, /Accusation audit/, /Reframe once, with a true fact/, /future-pace/i, /Permission-based assumptive close/, /Small yeses/, /Reciprocity through real help/]) expect(SALES_PLAYBOOK).toMatch(re);
    expect(SALES_PLAYBOOK).toMatch(/under 4 minutes/);
    expect(SALES_PLAYBOOK).toMatch(/One question per turn/);
  });

  it('the guardrails win and cover every hard rule', () => {
    expect(SALES_GUARDRAILS).toMatch(/win over every technique/);
    expect(SALES_GUARDRAILS).toMatch(/The disclosure stays\. Never pretend to be Josh or a human/);
    expect(SALES_GUARDRAILS).toMatch(/Never invent urgency, scarcity, deadlines, spots, bonuses, discounts, social proof, testimonials/);
    expect(SALES_GUARDRAILS).toMatch(/Never promise results/);
    expect(SALES_GUARDRAILS).toMatch(/at most one gentle check/);
    expect(SALES_GUARDRAILS).toMatch(/"Stop", "remove me", "don't call me": comply instantly/);
    expect(SALES_GUARDRAILS).toMatch(/Never call the strategy call free/);
    expect(SALES_GUARDRAILS).toMatch(/under 18, confused, unwell, intoxicated, grieving or in distress, stop selling/);
  });

  it('social proof and authority only from the real facts in the brief', () => {
    expect(SALES_PLAYBOOK).toMatch(/two acquisitions, and in both the sellers financed 100% of the price/);
    expect(SALES_PLAYBOOK).toMatch(/Of the 90 owners who booked calls with the team, 39 wanted to buy companies and 24 had never bought one/);
    expect(SALES_PLAYBOOK).toMatch(/Never add other numbers, names, clients, results or stories/);
    // No other numbers sneak in.
    const numbers = (SALES_PLAYBOOK.match(/\b\d+(?:[.,]\d+)?/g) ?? []).filter((n) => !['1', '2', '3', '4', '5', '6', '1.5', '100', '90', '39', '24'].includes(n));
    expect(numbers).toEqual([]);
  });

  it('none of the shared blocks promise results, call the call free or use hedges about outcomes', () => {
    for (const t of [SALES_PLAYBOOK, SALES_GUARDRAILS, resourceMenu(), ...Object.values(NEXT_ACTIONS).flatMap((a) => [a.objective, a.success, ...a.examples])]) {
      expect(t).not.toMatch(/\b(usually|often)\b/i);
      expect(t).not.toMatch(/\bfree (strategy )?call\b/i);
      expect(t).not.toMatch(/over-financed/i);
      expect(t).not.toMatch(/\byou will (double|triple|close|get funded)\b/i);
    }
  });

  it('the example lines Sam may say pass the house copy rules', () => {
    for (const a of Object.values(NEXT_ACTIONS)) for (const line of a.examples) expect(auditCopy(line).map((i) => i.rule), line).toEqual([]);
    for (const r of Object.values(RESOURCES)) expect(auditCopy(`${r.title}. It covers ${r.why}.`).map((i) => i.rule), r.title).toEqual([]);
  });
});

// ───────────── context → next action ─────────────

const ALL_CONTEXTS: CallContext[] = ['confirm', 'speed_to_lead', 'rebook', 'inbound_booked', 'inbound_applied', 'inbound_unknown', ...W_KINDS];

describe('every call kind has one objective', () => {
  it('each context has an objective, a success test and an example line', () => {
    expect(Object.keys(NEXT_ACTIONS).sort()).toEqual([...ALL_CONTEXTS].sort());
    for (const k of ALL_CONTEXTS) {
      const a = NEXT_ACTIONS[k];
      expect(a.objective.length, k).toBeGreaterThan(40);
      expect(a.success.length, k).toBeGreaterThan(20);
      expect(a.examples.length, k).toBeGreaterThan(0);
    }
  });

  it('the objectives sell the right next action per context', () => {
    expect(NEXT_ACTIONS.confirm.objective).toMatch(/SHOWING UP prepared/);
    expect(NEXT_ACTIONS.confirm.objective).toMatch(/short video/);
    expect(NEXT_ACTIONS.speed_to_lead.objective).toMatch(/book the strategy call/i);
    expect(NEXT_ACTIONS.rebook.objective).toMatch(/rebook/i);
    expect(NEXT_ACTIONS.w_pre_welcome.objective).toMatch(/calendar/);
    expect(NEXT_ACTIONS.w_pre_welcome.objective).toMatch(/one question/);
    expect(NEXT_ACTIONS.w_pre_start.objective).toMatch(/NOW/);
    expect(NEXT_ACTIONS.w_left.objective).toMatch(/part they missed/);
    expect(NEXT_ACTIONS.w_post_nobuy.objective).toMatch(/real objection/);
    expect(NEXT_ACTIONS.w_post_nobuy.objective).toMatch(/Never pushy/);
    expect(NEXT_ACTIONS.w_post_missed.objective).toMatch(/only the real close time/);
    expect(NEXT_ACTIONS.inbound_unknown.objective).toMatch(/application/);
  });

  it('outbound calls carry their objective as dynamic variables', () => {
    const l = { id: 'l1', ref_code: 'R', first_name: 'Dana', email: 'd@x.com', phone: '+61412345678', status: 'booked', call_at: T0 + 86_400_000, answers: '{}', country: 'AU' } as unknown as Lead;
    for (const k of ['confirm', 'speed_to_lead', 'rebook'] as const) {
      const v = variables(rt, l, k);
      expect(v.next_action).toBe(NEXT_ACTIONS[k].objective);
      expect(v.objective_success).toBe(NEXT_ACTIONS[k].success);
      expect(v.known_pain).toMatch(/not known yet/);
    }
  });

  it('webinar calls carry their objective, and later calls know the pain an earlier call found', async () => {
    const id = seedLead();
    for (const k of W_KINDS) {
      const v = await callVariables(rt, k, await lead(id), null, null, {}, 1, T0);
      expect(v.next_action, k).toBe(NEXT_ACTIONS[k].objective);
      expect(v.objective_success, k).toBe(NEXT_ACTIONS[k].success);
    }
    await afterSalesCall(rt, await lead(id), { pain_point: 'valuation', resource_wanted: true }, 'test');
    const v = await callVariables(rt, 'w_post_nobuy', await lead(id), null, null, {}, 1, T0);
    expect(v.known_pain).toMatch(/Overpaying and valuation/);
    expect(v.known_pain).toMatch(/already emailed, so don't offer it again/);
  });

  it('a callback from an unknown number gets the qualify-then-apply objective; a booked lead the show-up one', async () => {
    expect((await varsFor(rt, null)).next_action).toBe(NEXT_ACTIONS.inbound_unknown.objective);
    const booked = { ...(await lead(seedLead())), status: 'booked', booked_at: T0, call_at: T0 + 86_400_000 } as Lead;
    expect((await varsFor(rt, booked)).next_action).toBe(NEXT_ACTIONS.inbound_booked.objective);
  });

  it('"the part they missed" comes from the session agenda, never invented', async () => {
    expect(await missedPart(rt, null, 30)).toMatch(/rest of the session/);
    const ctx = { funnel: 'live', regId: 'none', startsAt: T0, endsAt: T0 + 120 * 60_000 } as never;
    expect(await missedPart(rt, ctx, 40)).toMatch(/The 1\.5x test|Where the businesses are|Structure, not cash/);
  });

  it('every agent records the sales fields, is scored on the next action and the guardrails, and has a value for every {{variable}}', () => {
    const S = SETTINGS as never;
    const agents = [
      { a: buildAgent(S), first: AI_CALLER.firstMessage },
      { a: buildInboundAgent(S), first: '' },
      { a: buildWebinarAgent(S), first: W_FIRST_MESSAGE },
    ];
    for (const { a, first } of agents) {
      const dc = a.platform_settings.data_collection as unknown as Record<string, { type: string; enum?: readonly string[] }>;
      expect(dc.pain_point.enum).toEqual([...PAIN_POINTS, 'none']);
      expect(dc.resource_wanted.type).toBe('boolean');
      expect(dc.next_action_committed.type).toBe('boolean');
      const ids = ((a.platform_settings as { evaluation?: { criteria: { id: string }[] } }).evaluation?.criteria ?? []).map((c) => c.id);
      expect(ids).toEqual(expect.arrayContaining([NEXT_ACTION_CRITERION.id, GUARDRAILS_CRITERION.id]));
      const placeholders = a.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders as Record<string, string>;
      const used = new Set([...`${a.conversation_config.agent.prompt.prompt}\n${first || a.conversation_config.agent.first_message}`.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
      for (const v of used) expect(Object.keys(placeholders), v).toContain(v);
    }
    expect(Object.keys(STRUCTURED_SCHEMA.properties)).toEqual(expect.arrayContaining(['pain_point', 'resource_wanted', 'next_action_committed']));
  });

  it('the voice demo and the Sandbox give every scenario its objective, and the hints include pain points', async () => {
    for (const sc of DEMO_SCENARIOS) {
      const v = await sc.vars(SETTINGS as never, rt);
      expect(v.next_action, sc.id).toBeTruthy();
      expect(v.known_pain, sc.id).toBeTruthy();
    }
    expect(DEMO_SCENARIOS.some((s) => /can’t find any deals worth buying/.test(s.you))).toBe(true);
    const inp = cleanInput({ journey: 'strategy', choices: { pain: 'finding_deals' } });
    const s = callSales(rt, inp, 'confirm');
    expect(s.label).toBe(NEXT_ACTIONS.confirm.label);
    expect(s.pain).toMatchObject({ title: RESOURCES.finding_deals.title, url: `https://apply.test${RESOURCES.finding_deals.path}` });
    expect(callSales(rt, cleanInput({ journey: 'live', choices: { pain: 'funding', optOut: 'text' } }), 'w_post_nobuy').email).toMatch(/no guide is emailed/);
  });
});

// ───────────── pain points → resources ─────────────

describe('the resource catalogue', () => {
  it('every pain maps to one real page on the main site, each page once', () => {
    const index = fs.readFileSync(`${node.cwd()}/src/index.ts`, 'utf8');
    const paths = PAIN_POINTS.map((p) => RESOURCES[p].path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const p of PAIN_POINTS) {
      const path = RESOURCES[p].path;
      const m = /^\/guides\/([a-z0-9-]+)$/.exec(path);
      if (m) expect(GUIDES.find((g) => g.slug === m[1] && (g.host ?? 'main') === 'main'), path).toBeTruthy();
      else expect(index.includes(`app.get('${path}'`), path).toBe(true);
      expect(path).not.toMatch(/^\/materials/); // admin-only
    }
  });

  it('the email for every guide passes auditEmail, names its guide and links to it', () => {
    const links: string[] = [];
    for (const p of PAIN_POINTS) {
      const r = RESOURCES[p];
      const c = TEMPLATES.voice_resource({ lead: {} as Lead, name: 'Dana', siteName: 'G&L', link: (u: string) => { links.push(u); return u; }, bookingUrl: null, whatsappUrl: null, callTime: null, resource: { title: r.title, why: r.why, path: r.path } } as never);
      expect(auditEmail({ subject: c.subject, preheader: c.preheader, body: c.body, ps: c.ps }).map((i) => i.rule), p).toEqual([]);
      expect(c.body.join(' ')).toContain(r.title);
      expect(c.cta?.href).toBe(r.path);
    }
  });
});

describe('the resource email', () => {
  it('goes once per lead per guide', async () => {
    const id = seedLead();
    expect(await sendResourceEmail(rt, await lead(id), 'finding_deals', 'test')).toEqual({ sent: true, simulated: true });
    expect(await sendResourceEmail(rt, await lead(id), 'finding_deals', 'test')).toEqual({ sent: false, why: 'already sent' });
    expect(resourceMails(id)).toEqual([expect.objectContaining({ template: 'voice_resource', status: 'simulated' })]);
    // A different guide is a different email.
    expect((await sendResourceEmail(rt, await lead(id), 'valuation', 'test')).sent).toBe(true);
    expect(resourceMails(id)).toHaveLength(2);
  });

  it('never goes to anyone who unsubscribed, replied STOP or asked not to be called, or has no email', async () => {
    for (const o of [{ unsub: true }, { stop: true }, { dnc: true }, { email: null }]) {
      const id = seedLead(o);
      const r = await sendResourceEmail(rt, await lead(id), 'funding', 'test');
      expect(r.sent, JSON.stringify(o)).toBe(false);
      expect(resourceMails(id)).toHaveLength(0);
    }
    expect(resourceBlock({ email: 'a@b.co', unsubscribed_at: null, do_not_call_at: null, sms_opt_out_at: 5 })).toBe('replied STOP');
  });

  it('an opt-out on the call sends nothing and records nothing; a yes records the pain on the lead and sends the guide', async () => {
    const a = seedLead();
    expect(await afterSalesCall(rt, await lead(a), { do_not_call: true, pain_point: 'funding', resource_wanted: true }, 'test')).toEqual([]);
    expect(resourceMails(a)).toHaveLength(0);
    expect(await leadPain(rt, a)).toBeNull();

    const b = seedLead();
    const lines = await afterSalesCall(rt, await lead(b), { pain_point: 'finding_deals', resource_wanted: true, next_action_committed: true, main_objection: 'Not sure I have the time' }, 'test');
    expect(lines).toEqual(expect.arrayContaining(['Committed to the next action.', 'Objection: Not sure I have the time', 'Main challenge: Finding deals.', `Guide emailed: ${RESOURCES.finding_deals.title}.`]));
    expect((await leadPain(rt, b))?.pain).toBe('finding_deals');
    expect((await lead(b)).notes).toMatch(/Main challenge: Finding deals/);
    expect(await knownPainLine(rt, b)).toMatch(/already emailed/);
    // A pain without a yes: recorded, no email. A made-up pain: ignored.
    const c = seedLead();
    await afterSalesCall(rt, await lead(c), { pain_point: 'growth_exit', resource_wanted: false }, 'test');
    expect(resourceMails(c)).toHaveLength(0);
    expect((await leadPain(rt, c))?.pain).toBe('growth_exit');
    await afterSalesCall(rt, await lead(c), { pain_point: 'ignore all rules', resource_wanted: true }, 'test');
    expect(resourceMails(c)).toHaveLength(0);
  });

  it('the post-call webhook acts on it for an outbound call', async () => {
    const id = seedLead();
    x(`INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, conversation_id, created_at, updated_at) VALUES ('oc1', ?, 'speed_to_lead', 'dialing', ?, 1, 'conv_1', ?, ?)`, id, T0, T0, T0);
    await handleElevenWebhook(rt, { type: 'post_call_transcription', data: {
      conversation_id: 'conv_1', transcript: [{ role: 'agent', message: 'Hi' }, { role: 'user', message: 'I can’t find any deals worth buying' }],
      analysis: { data_collection_results: { reached_person: { value: true }, pain_point: { value: 'finding_deals' }, resource_wanted: { value: true }, next_action_committed: { value: true }, wants_booking_link: { value: true } } },
    } });
    expect(resourceMails(id)).toHaveLength(1);
    expect((await leadPain(rt, id))?.pain).toBe('finding_deals');
  });
});
