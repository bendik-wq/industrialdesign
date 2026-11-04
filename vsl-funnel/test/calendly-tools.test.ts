import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { FAQS, LIVE_BOOKING_SECTION, inboundCallbackPrompt, outboundSystemPrompt } from '../src/config';
import { auditCopy } from '../src/content/copy-rules';
import { getLead } from '../src/funnel/leads';
import {
  RESCHEDULE_REASON, TOOL_HEADER, bookedByPhoneRecently, handleBookingTool, leadToken, pickSlots, sampleSlots, spokenTime, toolConfigs, toolOutcome, toolSecret, tzLabel, verifyLeadToken,
} from '../src/integrations/calendly-tools';
import { buildAgent, queueCall, variables } from '../src/integrations/elevenlabs';
import { UNKNOWN, buildInboundAgent, varsFor } from '../src/integrations/elevenlabs-inbound';
import { NEXT_ACTIONS } from '../src/integrations/sales-playbook';
import { SETTINGS as SETTING_DEFS } from '../src/settings';

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
  return { prepare, batch: async (stmts: { sql: string; run: () => Promise<unknown>; all: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(/^\s*select|\breturning\b/i.test(s.sql) ? await s.all() : await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

// Tuesday 3 November 2026, 1 pm in Sydney.
const T0 = Date.parse('2026-11-03T02:00:00Z');
const H = 3600_000;
const SETTINGS: Record<string, string> = {
  CALENDLY_API_TOKEN: 'cal_test_token_123456', AI_CALL_BOOKING_TOOLS: '', SALES_TIMEZONE: 'Australia/Sydney', BOOKING_URL_A: 'https://calendly.com/josh/strategy',
  ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: 'agent_main', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', AI_CALL_CALLBACK_NUMBER: '+61 2 9000 0000',
  SITE_NAME: 'G&L', EMAIL_SIGNATURE: 'Josh', BUSINESS_ADDRESS: 'Sydney',
};
let db: DatabaseSync;
let rt: Runtime;
const makeRt = (extra: Record<string, string> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'x'.repeat(32) }, settings: { ...Object.fromEntries(SETTING_DEFS.map((d) => [d.key, ''])), ...SETTINGS, ...extra }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { void p.catch(() => null); } }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));

function seedLead(o: { id?: string; tz?: string; booked?: { ref: string; at: number } | null; email?: string | null; unsub?: boolean } = {}) {
  const id = o.id ?? 'l_dana';
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, phone, call_consent_at, call_consent_text, status, tier, app_completed_at, timezone, country,
       booked_at, call_at, booking_ref, booking_provider, unsubscribed_at)
     VALUES (?, ?, ?, ?, 'Dana', 'Reid', ?, '+61412345678', ?, 'v2', ?, 'A', ?, ?, 'AU', ?, ?, ?, ?, ?)`,
    id, `R${id.slice(-4)}`, T0 - 86_400_000, T0, o.email === undefined ? (id === 'l_dana' ? 'dana@acme.com' : `${id}@acme.com`) : o.email, T0 - 86_400_000, o.booked ? 'booked' : 'applied', T0 - 86_400_000, o.tz ?? 'Australia/Sydney',
    o.booked ? T0 - 3600_000 : null, o.booked?.at ?? null, o.booked?.ref ?? null, o.booked ? 'calendly' : null, o.unsub ? T0 : null);
  return id;
}

// ───────────── Calendly, mocked ─────────────

const ET = 'https://api.calendly.com/event_types/ET1';
const OLD_EVENT = 'https://api.calendly.com/scheduled_events/OLD1';
const NEW_EVENT = 'https://api.calendly.com/scheduled_events/NEW1';
interface Seen { method: string; url: string; body: unknown }
let seen: Seen[];
let slots: string[];
let eventType: Record<string, unknown>;
let inviteeStatus: number;
let availStatus: number;
let cancelStatus: number;

function calendly() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ method, url, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.endsWith('/users/me')) return json({ resource: { uri: 'https://api.calendly.com/users/U1', name: 'Josh Li', email: 'josh@x.com', current_organization: 'https://api.calendly.com/organizations/O1', scheduling_url: 'https://calendly.com/josh', timezone: 'Australia/Sydney' } });
    if (url.includes('/event_types?')) return json({ collection: [eventType] });
    if (url.includes('/event_type_available_times?')) return availStatus === 200 ? json({ collection: slots.map((s) => ({ start_time: s, status: 'available', invitees_remaining: 1, scheduling_url: 'https://calendly.com/josh/strategy/x' })) }) : json({ message: 'boom' }, availStatus);
    if (url.endsWith('/invitees') && method === 'POST') {
      if (inviteeStatus !== 201) return json({ title: 'Invalid Argument', message: inviteeStatus === 400 ? 'The selected start_time is no longer available.' : 'Server error' }, inviteeStatus);
      return json({ resource: { uri: `${NEW_EVENT}/invitees/I1`, event: NEW_EVENT, cancel_url: 'https://calendly.com/cancellations/I1', reschedule_url: 'https://calendly.com/reschedulings/I1', status: 'active' } }, 201);
    }
    if (url.includes('/cancellation') && method === 'POST') return cancelStatus === 201 ? json({ resource: { canceled_by: 'Josh Li', reason: body?.reason } }, 201) : json({ message: 'nope' }, cancelStatus);
    return json({ message: `unexpected ${method} ${url}` }, 500);
  });
}

// Open times (UTC). In Sydney (UTC+11): Tue 3 Nov 2pm (too soon), Wed 4 Nov 10am, Wed 2pm, Thu 5 Nov 10:30am, Fri 6 Nov 9am, Mon 9 Nov 4pm.
const OPEN = ['2026-11-03T03:00:00.000000Z', '2026-11-03T23:00:00.000000Z', '2026-11-04T03:00:00.000000Z', '2026-11-04T23:30:00.000000Z', '2026-11-05T22:00:00.000000Z', '2026-11-09T05:00:00.000000Z'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
  seen = [];
  slots = [...OPEN];
  eventType = { uri: ET, name: 'M&A Private Advisory - Grøsfjeld & Li', active: true, kind: 'solo', duration: 30, scheduling_url: 'https://calendly.com/josh/strategy', locations: [{ kind: 'google_conference' }], custom_questions: [] };
  inviteeStatus = 201;
  availStatus = 200;
  cancelStatus = 201;
  vi.stubGlobal('fetch', calendly());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const call = async (action: string, body: Record<string, unknown>, header?: string | null) =>
  handleBookingTool(rt, action, header === null ? undefined : header ?? (await toolSecret(rt)), body);
const tokenFor = (id = 'l_dana', scope: 'out' | 'in' = 'out', now = T0) => leadToken(rt, id, scope, now);
const calendlyCalls = () => seen.filter((s) => s.url.startsWith('https://api.calendly.com'));

// ───────────── the HTTP route: secret, then token ─────────────

describe('the tool endpoints: authentication', () => {
  type App = { fetch: (r: Request, e: unknown, c: unknown) => Promise<Response> };
  let app: App;
  beforeAll(async () => {
    vi.stubGlobal('HTMLRewriter', class { on() { return this; } transform(r: Response) { return r; } });
    app = (await import('../src/index')).default as unknown as App;
  }, 60_000);
  const hit = (path: string, headers: Record<string, string>, body: unknown) =>
    app.fetch(new Request(`https://apply.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers }, body: JSON.stringify(body) }),
      { DB: d1(db), SESSION_SECRET: 'x'.repeat(32) }, { waitUntil: () => {}, passThroughOnException: () => {} });

  it('missing or wrong secret header → 401, before anything else is looked at', async () => {
    seedLead();
    const tok = await tokenFor();
    expect((await hit('/hooks/elevenlabs/tools/availability', {}, { lead_token: tok })).status).toBe(401);
    expect((await hit('/hooks/elevenlabs/tools/book', { [TOOL_HEADER]: 'nope' }, { lead_token: tok, slot_id: OPEN[1] })).status).toBe(401);
    expect(calendlyCalls()).toEqual([]);
  });

  it('right secret but a forged or expired lead token → 403', async () => {
    seedLead();
    seedLead({ id: 'l_other' });
    const secret = await toolSecret(rt);
    const good = await tokenFor();
    const [, exp, scope, sig] = good.split('.');
    const forged = ['l_other', exp, scope, sig].join('.'); // someone else's lead id with Dana's signature
    expect((await hit('/hooks/elevenlabs/tools/availability', { [TOOL_HEADER]: secret }, { lead_token: forged })).status).toBe(403);
    expect((await hit('/hooks/elevenlabs/tools/availability', { [TOOL_HEADER]: secret }, { lead_token: `${good.slice(0, -2)}00` })).status).toBe(403);
    expect((await hit('/hooks/elevenlabs/tools/availability', { [TOOL_HEADER]: secret }, { lead_id: 'l_dana' })).status).toBe(403); // a lead id alone is never accepted
    const expired = await tokenFor('l_dana', 'out', T0 - 4 * H);
    expect((await hit('/hooks/elevenlabs/tools/availability', { [TOOL_HEADER]: secret }, { lead_token: expired })).status).toBe(403);
    expect(calendlyCalls()).toEqual([]);
  });
});

describe('the lead token', () => {
  it('round-trips, carries its scope, and expires after three hours', async () => {
    const t = await tokenFor('l_dana', 'in');
    expect(await verifyLeadToken(rt, t)).toEqual({ leadId: 'l_dana', scope: 'in' });
    expect(await verifyLeadToken(rt, t, T0 + 3 * H + 1000)).toBeNull();
    expect(await verifyLeadToken(rt, t.replace('.in.', '.out.'))).toBeNull();
    expect(await verifyLeadToken(rt, 'garbage')).toBeNull();
    expect(await verifyLeadToken(rt, 42)).toBeNull();
  });
  it('a deleted lead → 403', async () => {
    const r = await call('availability', { lead_token: await tokenFor('l_gone') });
    expect(r.status).toBe(403);
  });
});

// ───────────── availability ─────────────

describe('availability', () => {
  it('up to 4 open times in the next 7 days, none within 2 hours, spoken in the lead’s time zone, with an opaque slot id', async () => {
    seedLead();
    const r = await call('availability', { lead_token: await tokenFor(), conversation_id: 'conv_1' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.timezone).toBe('Sydney time');
    const s = r.body.slots as { slot_id: string; spoken: string }[];
    expect(s.length).toBe(4);
    expect(s.map((x) => x.slot_id)).not.toContain('2026-11-03T03:00:00.000Z'); // 2 pm today is within two hours
    expect(s[0]).toEqual({ slot_id: '2026-11-03T23:00:00.000Z', spoken: 'Wednesday 4 November at 10 am' });
    expect(s.map((x) => x.spoken)).toContain('Thursday 5 November at 10:30 am');
    // One per day first (spread), so Wednesday 2 pm gives way to Friday and Monday.
    expect(s.map((x) => x.spoken)).toEqual(['Wednesday 4 November at 10 am', 'Thursday 5 November at 10:30 am', 'Friday 6 November at 9 am', 'Monday 9 November at 4 pm']);
    expect(String(r.body.message)).toMatch(/Never offer a time that is not in this list/);
    // The window Calendly was asked for: from 2 hours out, under 7 days.
    const avail = seen.find((c) => c.url.includes('event_type_available_times'))!;
    const u = new URL(avail.url);
    expect(Date.parse(u.searchParams.get('start_time')!)).toBe(T0 + 2 * H);
    expect(Date.parse(u.searchParams.get('end_time')!) - T0).toBeLessThan(7 * 86_400_000);
    expect(q('SELECT action, result, conversation_id FROM ai_booking_actions')).toEqual([{ action: 'availability', result: 'offered', conversation_id: 'conv_1' }]);
  });

  it('speaks the times in the lead’s own zone (New York), not the sales team’s', async () => {
    seedLead({ tz: 'America/New_York' });
    const r = await call('availability', { lead_token: await tokenFor(), conversation_id: 'conv_ny' });
    const s = r.body.slots as { spoken: string }[];
    expect(r.body.timezone).toBe('New York time');
    expect(s[0].spoken).toBe('Tuesday 3 November at 6 pm'); // 23:00 UTC = 6 pm EST
  });

  it('honours a preferred day and part of day, and says so when nothing matches', async () => {
    seedLead();
    const r = await call('availability', { lead_token: await tokenFor(), preferred_day: 'Wednesday', part_of_day: 'afternoon' });
    expect((r.body.slots as { spoken: string }[]).map((x) => x.spoken)).toEqual(['Wednesday 4 November at 2 pm']);
    const none = await call('availability', { lead_token: await tokenFor(), preferred_day: 'saturday' });
    expect(String(none.body.message)).toMatch(/Nothing is open at the time they asked for/);
  });

  it('a required choice question on the booking form means no times are offered: the link is emailed instead', async () => {
    seedLead();
    eventType.custom_questions = [{ name: 'Annual revenue', type: 'single_select', position: 0, enabled: true, required: true, answer_choices: ['<$1M', '$1M+'] }];
    const r = await call('availability', { lead_token: await tokenFor(), conversation_id: 'c_q' });
    expect(r.body.result).toBe('link_emailed');
    expect(r.body.slots).toBeUndefined();
    expect(q("SELECT template FROM emails WHERE lead_id = 'l_dana'")).toEqual([{ template: 'voice_link' }]);
  });

  it('turned off (AI_CALL_BOOKING_TOOLS=false): no Calendly call, Sam is told to offer the emailed link', async () => {
    rt = makeRt({ AI_CALL_BOOKING_TOOLS: 'false' });
    seedLead();
    const r = await call('availability', { lead_token: await tokenFor() });
    expect(r.body.result).toBe('not_available');
    expect(calendlyCalls()).toEqual([]);
  });

  it('rate-limited per lead', async () => {
    seedLead();
    const tok = await tokenFor();
    for (let i = 0; i < 12; i++) expect((await call('availability', { lead_token: tok })).body.ok).toBe(true);
    expect((await call('availability', { lead_token: tok })).body.result).toBe('rate_limited');
  });
});

// ───────────── booking ─────────────

describe('booking', () => {
  it('books with the name, email and time zone from OUR record, never from the request body', async () => {
    seedLead({ tz: 'Australia/Brisbane' });
    const r = await call('book', { lead_token: await tokenFor(), conversation_id: 'conv_b', slot_id: '2026-11-03T23:00:00.000Z', email: 'attacker@evil.test', name: 'Mallory', lead_id: 'l_other' });
    expect(r.body).toMatchObject({ ok: true, result: 'booked' });
    expect(String(r.body.message)).toMatch(/calendar invite comes from Calendly by email/);
    expect(String(r.body.booked_for)).toBe('Wednesday 4 November at 9 am, Brisbane time');
    const post = seen.find((c) => c.method === 'POST' && c.url.endsWith('/invitees'))!;
    expect(post.body).toMatchObject({
      event_type: ET,
      start_time: '2026-11-03T23:00:00.000Z',
      invitee: { name: 'Dana Reid', first_name: 'Dana', last_name: 'Reid', email: 'dana@acme.com', timezone: 'Australia/Brisbane' },
      location: { kind: 'google_conference' },
      tracking: { salesforce_uuid: 'l_dana' },
    });
    expect(JSON.stringify(post.body)).not.toMatch(/attacker|Mallory|l_other/);
    // The lead is booked through the same idempotent path the webhook uses.
    const lead = (await getLead(rt.env, 'l_dana'))!;
    expect(lead).toMatchObject({ status: 'booked', call_at: Date.parse('2026-11-03T23:00:00Z'), booking_ref: NEW_EVENT, booking_provider: 'calendly', booking_reschedule_url: 'https://calendly.com/reschedulings/I1' });
    expect(q('SELECT action, result, event_uri FROM ai_booking_actions')).toEqual([{ action: 'book', result: 'booked', event_uri: NEW_EVENT }]);
    expect(await toolOutcome(rt, 'conv_b')).toEqual({ booked: true, linkEmailed: false });
    // No confirmation call rings them right after Sam booked it.
    expect(await bookedByPhoneRecently(rt, 'l_dana')).toBe(true);
    expect(q("SELECT id FROM outbound_calls WHERE kind = 'confirm' AND status = 'queued'")).toEqual([]);
    expect(await queueCall(rt, lead, 'confirm', 2)).toBeNull();
  });

  it('reschedule: books the new time FIRST, then cancels the old event with the reason', async () => {
    seedLead({ booked: { ref: OLD_EVENT, at: T0 + 3 * 86_400_000 } });
    const r = await call('book', { lead_token: await tokenFor(), conversation_id: 'conv_r', slot_id: '2026-11-04T23:30:00.000Z' });
    expect(r.body).toMatchObject({ ok: true, result: 'rescheduled' });
    expect(String(r.body.message)).toMatch(/old time, Friday 6 November at 1 pm, is cancelled/);
    const writes = seen.filter((c) => c.method === 'POST');
    expect(writes.map((c) => c.url)).toEqual(['https://api.calendly.com/invitees', 'https://api.calendly.com/scheduled_events/OLD1/cancellation']);
    expect(writes[1].body).toEqual({ reason: RESCHEDULE_REASON });
    expect(RESCHEDULE_REASON).toBe('Rescheduled by phone with Sam (AI assistant)');
    const lead = (await getLead(rt.env, 'l_dana'))!;
    expect(lead.booking_ref).toBe(NEW_EVENT);
    expect(lead.booking_cancelled_at).toBeNull();
    expect(q('SELECT action, result FROM ai_booking_actions ORDER BY rowid')).toEqual([{ action: 'reschedule', result: 'rescheduled' }, { action: 'cancel_old', result: 'cancelled' }]);
  });

  it('reschedule: if the old event can’t be cancelled, the new booking stands and the team is told', async () => {
    seedLead({ booked: { ref: OLD_EVENT, at: T0 + 3 * 86_400_000 } });
    cancelStatus = 500;
    const r = await call('book', { lead_token: await tokenFor(), slot_id: '2026-11-04T23:30:00.000Z' });
    expect(r.body.result).toBe('rescheduled');
    expect(String(r.body.message)).toMatch(/team will remove their old booking/);
    expect(q("SELECT result FROM ai_booking_actions WHERE action = 'cancel_old'")).toEqual([{ result: 'cancel_failed' }]);
  });

  it('slot taken (no longer in the open times): re-offers others, books nothing', async () => {
    seedLead();
    slots = OPEN.filter((s) => !s.startsWith('2026-11-03T23'));
    const r = await call('book', { lead_token: await tokenFor(), slot_id: '2026-11-03T23:00:00.000Z' });
    expect(r.body).toMatchObject({ ok: false, result: 'slot_taken' });
    expect((r.body.slots as { spoken: string }[])[0].spoken).toBe('Wednesday 4 November at 2 pm'); // same day first
    expect(String(r.body.message)).toMatch(/Nothing is booked yet/);
    expect(seen.some((c) => c.method === 'POST')).toBe(false);
  });

  it('slot taken at the last moment (Calendly refuses the booking): re-offers', async () => {
    seedLead();
    inviteeStatus = 400;
    const r = await call('book', { lead_token: await tokenFor(), slot_id: '2026-11-03T23:00:00.000Z' });
    expect(r.body.result).toBe('slot_taken');
    expect((await getLead(rt.env, 'l_dana'))!.booked_at).toBeNull();
  });

  it('a Calendly error falls back to the existing booking-link email, once per conversation', async () => {
    seedLead();
    inviteeStatus = 500;
    const tok = await tokenFor();
    const r = await call('book', { lead_token: tok, conversation_id: 'conv_e', slot_id: '2026-11-03T23:00:00.000Z' });
    expect(r.body).toMatchObject({ ok: false, result: 'link_emailed' });
    expect(String(r.body.message)).toMatch(/Do not say any time is booked/);
    availStatus = 503;
    expect((await call('availability', { lead_token: tok, conversation_id: 'conv_e' })).body.result).toBe('link_emailed');
    expect(q("SELECT template FROM emails WHERE lead_id = 'l_dana'")).toEqual([{ template: 'voice_link' }]); // one email, not two
    expect(await toolOutcome(rt, 'conv_e')).toEqual({ booked: false, linkEmailed: true });
    expect((await getLead(rt.env, 'l_dana'))!.booked_at).toBeNull();
  });

  it('never emails an unsubscribed lead: Sam says the team will be in touch', async () => {
    seedLead({ unsub: true });
    availStatus = 500;
    const r = await call('availability', { lead_token: await tokenFor() });
    expect(r.body.result).toBe('not_available');
    expect(q("SELECT id FROM emails WHERE lead_id = 'l_dana'")).toEqual([]);
  });

  it('refuses a slot id it never could have offered (inside 2 hours, past 7 days, not a time)', async () => {
    seedLead();
    const tok = await tokenFor();
    for (const slot_id of ['2026-11-03T03:00:00.000Z', '2026-11-20T00:00:00.000Z', 'thursday at 10', '']) {
      expect((await call('book', { lead_token: tok, slot_id })).body.result).toBe('invalid_slot');
    }
    expect(seen.some((c) => c.method === 'POST')).toBe(false);
  });
});

// ───────────── formatting helpers ─────────────

describe('speaking times', () => {
  it('formats for speech', () => {
    expect(spokenTime(Date.parse('2026-11-04T01:00:00Z'), 'Australia/Sydney')).toBe('Wednesday 4 November at midday');
    expect(spokenTime(Date.parse('2026-11-04T04:15:00Z'), 'Australia/Sydney')).toBe('Wednesday 4 November at 3:15 pm');
    expect(tzLabel('America/Los_Angeles')).toBe('Los Angeles time');
    expect(pickSlots([], 'UTC', T0).times).toEqual([]);
    expect(sampleSlots(T0, 'Australia/Sydney')).toHaveLength(3);
  });
});

// ───────────── the agents ─────────────

describe('wiring into the agents', () => {
  it('the tools bind lead_token and the conversation id from dynamic variables, never from the model', async () => {
    const cfgs = await toolConfigs(rt);
    expect(cfgs.map((c) => c.name)).toEqual(['check_availability', 'book_strategy_call']);
    for (const c of cfgs) {
      expect(c.type).toBe('webhook');
      expect(c.api_schema.method).toBe('POST');
      expect(c.api_schema.request_headers[TOOL_HEADER]).toBe(await toolSecret(rt));
      expect(c.api_schema.request_body_schema.properties.lead_token).toEqual({ type: 'string', dynamic_variable: 'lead_token' });
      expect(c.api_schema.request_body_schema.properties.conversation_id).toEqual({ type: 'string', dynamic_variable: 'system__conversation_id' });
      expect(JSON.stringify(c.api_schema.request_body_schema)).not.toMatch(/"(email|name|lead_id)"/);
    }
    expect(cfgs[0].api_schema.url).toBe('https://apply.test/hooks/elevenlabs/tools/availability');
    expect(cfgs[1].api_schema.url).toBe('https://apply.test/hooks/elevenlabs/tools/book');
  });

  it('buildAgent / buildInboundAgent carry the tools and the live prompt only when the tools are on', async () => {
    const off = buildAgent(rt.settings) as unknown as { conversation_config: { agent: { prompt: Record<string, unknown> } } };
    expect(off.conversation_config.agent.prompt.tool_ids).toBeUndefined();
    expect(String(off.conversation_config.agent.prompt.prompt)).not.toContain('Booking a time live');
    const on = buildAgent(rt.settings, { ids: ['tool_a', 'tool_b'] }) as unknown as { conversation_config: { agent: { prompt: Record<string, unknown> } } };
    expect(on.conversation_config.agent.prompt.tool_ids).toEqual(['tool_a', 'tool_b']);
    expect(String(on.conversation_config.agent.prompt.prompt)).toContain(LIVE_BOOKING_SECTION);
    const inline = buildInboundAgent(rt.settings, { inline: await toolConfigs(rt) }) as unknown as { conversation_config: { agent: { prompt: Record<string, unknown> } } };
    expect((inline.conversation_config.agent.prompt.tools as unknown[]).length).toBe(2);
    expect(String(inline.conversation_config.agent.prompt.prompt)).toContain('Booking a time live');
  });

  it('variables: live booking and the live objective for consenting leads with an email; the token is signed only when the call starts', () => {
    seedLead();
    const lead = db.prepare("SELECT * FROM leads WHERE id = 'l_dana'").get() as never;
    for (const k of ['confirm', 'speed_to_lead', 'rebook'] as const) {
      const v = variables(rt, lead, k);
      expect(v.live_booking).toBe('yes');
      expect(v.lead_token).toBe('');
      expect(v.next_action).toBe(NEXT_ACTIONS[k].live!.objective);
    }
    const off = variables(makeRt({ CALENDLY_API_TOKEN: '' }), lead, 'confirm');
    expect(off.live_booking).toBe('no');
    expect(off.next_action).toBe(NEXT_ACTIONS.confirm.objective);
  });

  it('callbacks: a known caller gets a signed token; an unknown caller never does', async () => {
    seedLead({ booked: { ref: OLD_EVENT, at: T0 + 86_400_000 } });
    const lead = (await getLead(rt.env, 'l_dana'))!;
    const v = await varsFor(rt, lead);
    expect(v.live_booking).toBe('yes');
    expect(await verifyLeadToken(rt, v.lead_token)).toEqual({ leadId: 'l_dana', scope: 'in' });
    expect(v.next_action).toBe(NEXT_ACTIONS.inbound_booked.live!.objective);
    expect(await varsFor(rt, null)).toBe(UNKNOWN);
    expect(UNKNOWN.lead_token).toBe('');
    expect(UNKNOWN.live_booking).toBe('no');
  });

  it('the live prompts keep every voice rule, never invent times, and fall back to the emailed link', () => {
    for (const p of [outboundSystemPrompt(FAQS, { liveBooking: true }), inboundCallbackPrompt(FAQS, { liveBooking: true })]) {
      expect(p).toContain(LIVE_BOOKING_SECTION);
      expect(p).toMatch(/Never promise results/);
      expect(p).toMatch(/Never promise a specific callback day or time/);
      expect(p).toMatch(/seller rollover/);
      expect(p).toMatch(/never invent, guess or suggest a time it didn't give you/);
      expect(p).toMatch(/calendar invite comes from Calendly by email/);
      expect(p).toMatch(/Never say a time is booked unless book_strategy_call said it is/);
    }
    const out = outboundSystemPrompt(FAQS, { liveBooking: true });
    expect(out).not.toMatch(/Do not book a time yourself/); // with live booking Sam books
    expect(outboundSystemPrompt(FAQS)).toMatch(/Do not book a time yourself/); // without it, unchanged
  });

  it('the live example lines pass the house copy rules', () => {
    for (const a of Object.values(NEXT_ACTIONS)) for (const line of a.live?.examples ?? []) expect(auditCopy(line).map((i) => i.rule), line).toEqual([]);
  });
});
