import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { CONSENT_COPY, CONSENT_LEGEND, canCall, canText, captureConsent, consentBlock, consentSummary, gateReport, passTo, recordConsent, replyPass, testPass } from '../src/integrations/consent-gate';
import { dial, dialQueuedCall, queueCall, type OutboundCall } from '../src/integrations/elevenlabs';
import { handleReplyWords, sendSmsNow, sendSmsRow, startSms } from '../src/integrations/sms';
import { DEFAULT_SMS_SEQUENCES } from '../src/integrations/sms-defaults';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../src/integrations/whatsapp';
import { type Lead, getLead, updateLead } from '../src/funnel/leads';
import { cleanInput, sandboxConsentRows, simulate } from '../src/admin/sandbox';
import { SETTINGS } from '../src/settings';

// ───────────── A real SQLite database shaped like D1, every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string; statSync(p: string): { isDirectory(): boolean } };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const isRead = /^\s*(SELECT|WITH)\b/i.test(sql);
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => {
        if (isRead) return { results: db.prepare(sql).all(...norm()), meta: { changes: 0 } };
        const r = db.prepare(sql).run(...norm());
        return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const ELEVEN = { ELEVENLABS_API_KEY: 'sk_test', ELEVENLABS_AGENT_ID: 'agent_1', ELEVENLABS_PHONE_NUMBER_ID: 'ph_1', SALES_TIMEZONE: 'Australia/Sydney', AI_CALL_CONFIRM: 'true', AI_CALL_SPEED_TO_LEAD: 'true' };
let db: DatabaseSync;
let rt: Runtime;
const makeRt = (settings: Record<string, string> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-secret' }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...ELEVEN, ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => undefined }) as unknown as Runtime;
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));

// Tuesday 11am in Sydney: inside calling and texting hours.
const T0 = Date.parse('2026-11-03T00:00:00Z');
let n = 0;
function seedLead(o: { phone?: string | null; call?: number | null; sms?: number | null; version?: string | null; source?: string; tier?: string; status?: string } = {}) {
  const id = `l${++n}`;
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, phone, status, tier, call_consent_at, call_consent_text, sms_consent_at, booking_source, booked_at, call_at, app_completed_at, timezone)
     VALUES (?, ?, ?, ?, 'Dana', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Australia/Sydney')`,
  id, `R${n}XYZ`.slice(0, 6), T0 - 3600_000, T0 - 3600_000, `dana${n}@co.com`, o.phone === undefined ? '+61412000001' : o.phone, o.status ?? 'applied', o.tier ?? 'A',
  o.call ?? null, o.version ?? null, o.sms ?? null, o.source ?? 'funnel', null, null, T0 - 60_000);
  return id;
}
const lead = async (id: string) => (await getLead(rt.env, id))!;
const give = (id: string, phone: string, call: boolean, texts: boolean) => recordConsent(rt, id, { phone, call, texts, source: 'apply', page: '/apply', ip: '203.0.113.9', userAgent: 'Mozilla/5.0 test' }, Date.now());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = makeRt();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('the contact gate', () => {
  it('no consent: no call, no text, and the attempt is logged with its reason', async () => {
    const id = seedLead();
    expect(await canCall(rt, await lead(id), 'ai_call:speed_to_lead')).toEqual({ ok: false, reason: 'no consent to call' });
    expect(await canText(rt, await lead(id), 'sms:applied')).toEqual({ ok: false, reason: 'no consent to text' });
    expect(await canText(rt, await lead(id), 'sms:applied', 'whatsapp')).toEqual({ ok: false, reason: 'no consent to WhatsApp' });
    expect(q('SELECT channel, purpose, outcome, reason FROM contact_gate_log ORDER BY channel')).toEqual([
      { channel: 'call', purpose: 'ai_call:speed_to_lead', outcome: 'blocked', reason: 'no consent to call' },
      { channel: 'sms', purpose: 'sms:applied', outcome: 'blocked', reason: 'no consent to text' },
      { channel: 'whatsapp', purpose: 'sms:applied', outcome: 'blocked', reason: 'no consent to WhatsApp' },
    ]);
    // Deduped: the same block within the hour is one row.
    await canCall(rt, await lead(id), 'ai_call:speed_to_lead');
    expect(q("SELECT * FROM contact_gate_log WHERE channel = 'call'")).toHaveLength(1);
  });

  it('consent to calls only: calls yes, texts no; and the other way round', async () => {
    const a = seedLead({ phone: '+61412000010' });
    expect(await give(a, '+61412000010', true, false)).toEqual({ call: true, texts: false });
    expect((await canCall(rt, await lead(a), 'x')).ok).toBe(true);
    expect(await canText(rt, await lead(a), 'x')).toEqual({ ok: false, reason: 'no consent to text' });
    const b = seedLead({ phone: '+61412000011' });
    expect(await give(b, '+61412000011', false, true)).toEqual({ call: false, texts: true });
    expect(await canCall(rt, await lead(b), 'x')).toEqual({ ok: false, reason: 'no consent to call' });
    expect((await canText(rt, await lead(b), 'x')).ok).toBe(true);
    expect((await canText(rt, await lead(b), 'x', 'whatsapp')).ok).toBe(true);
  });

  it('stores proof: time, channel, number, the exact wording and version, the form, the page, hashed IP and user agent', async () => {
    const id = seedLead({ phone: '+61412000020' });
    await give(id, '+61412000020', true, true);
    const rows = q<Record<string, unknown>>('SELECT * FROM consent_events WHERE lead_id = ? ORDER BY channel', id);
    expect(rows.map((r) => r.channel)).toEqual(['call', 'sms', 'whatsapp']);
    expect(rows[0]).toMatchObject({ action: 'granted', phone: '+61412000020', source: 'apply', page_url: '/apply', text_version: CONSENT_COPY.version, text: CONSENT_COPY.call, user_agent: 'Mozilla/5.0 test', created_at: T0 });
    expect(rows[1]).toMatchObject({ text: CONSENT_COPY.sms });
    expect(String(rows[0].ip_hash)).toMatch(/^[0-9a-f]{24}$/);
    expect(JSON.stringify(rows)).not.toContain('203.0.113.9');
    // The lead's timestamps the rest of the app reads stay in step.
    expect(await lead(id)).toMatchObject({ call_consent_at: T0, call_consent_text: CONSENT_COPY.version, sms_consent_at: T0, wa_consent_at: T0 });
  });

  it('consent counts only for the number it was given for: someone else’s number records nothing', async () => {
    const id = seedLead({ phone: '+61412000030' });
    expect(await give(id, '+61499999999', true, true)).toEqual({ call: false, texts: false });
    expect(q('SELECT * FROM consent_events')).toEqual([]);
    // A form adds a number only to a lead with none.
    const none = seedLead({ phone: null });
    expect(await captureConsent(rt, none, { call_consent: 'on' }, { phone: '+61412000031', source: 'webinar', page: '/webinar' })).toEqual({ call: true, texts: false });
    expect((await lead(none)).phone).toBe('+61412000031');
    expect(await captureConsent(rt, id, { call_consent: 'on', sms_consent: true }, { phone: '+61412000099', source: 'webinar', page: '/webinar' })).toEqual({ call: false, texts: false });
    expect((await lead(id)).phone).toBe('+61412000030');
  });

  it('a changed number voids consent on every channel, for any path that changes it (updateLead)', async () => {
    const id = seedLead({ phone: '+61412000040' });
    await give(id, '+61412000040', true, true);
    expect((await canCall(rt, await lead(id), 'x')).ok).toBe(true);
    await updateLead(rt.env, id, { phone: '+61412000041' });
    expect(await canCall(rt, await lead(id), 'x')).toEqual({ ok: false, reason: 'number changed since consent' });
    expect(await canText(rt, await lead(id), 'x')).toEqual({ ok: false, reason: 'number changed since consent' });
    expect(q("SELECT channel, phone, source FROM consent_events WHERE action = 'revoked' ORDER BY channel")).toEqual([
      { channel: 'call', phone: '+61412000040', source: 'phone-changed' }, { channel: 'sms', phone: '+61412000040', source: 'phone-changed' }, { channel: 'whatsapp', phone: '+61412000040', source: 'phone-changed' }]);
    expect(await lead(id)).toMatchObject({ call_consent_at: null, sms_consent_at: null, wa_consent_at: null });
    // Setting the same number again changes nothing; fresh consent for the new number counts.
    await updateLead(rt.env, id, { phone: '+61412000041' });
    expect(q("SELECT * FROM consent_events WHERE action = 'revoked'")).toHaveLength(3);
    await give(id, '+61412000041', true, false);
    expect((await canCall(rt, await lead(id), 'x')).ok).toBe(true);
    // Legacy consent (before proof rows) is voided the same way.
    const old = seedLead({ phone: '+61412000042', call: T0 - 86_400_000, version: 'v2' });
    expect((await canCall(rt, await lead(old), 'x')).ok).toBe(true);
    await updateLead(rt.env, old, { phone: '+61412000043' });
    expect((await canCall(rt, await lead(old), 'x')).ok).toBe(false);
  });

  it('STOP and do-not-call block; START turns texts back on, never calls', async () => {
    const id = seedLead({ phone: '+61412000050' });
    await give(id, '+61412000050', true, true);
    await handleReplyWords(rt, await lead(id), 'STOP', 'sms');
    expect(await canText(rt, await lead(id), 'x')).toEqual({ ok: false, reason: 'replied STOP' });
    expect(await canCall(rt, await lead(id), 'x')).toEqual({ ok: false, reason: 'asked not to be called' });
    expect(q("SELECT channel FROM consent_events WHERE action = 'revoked' AND source = 'stop-reply' ORDER BY channel").map((r) => (r as { channel: string }).channel)).toEqual(['call', 'sms', 'whatsapp']);
    await handleReplyWords(rt, await lead(id), 'START', 'sms');
    expect((await canText(rt, await lead(id), 'x')).ok).toBe(true);
    expect(await canCall(rt, await lead(id), 'x')).toEqual({ ok: false, reason: 'asked not to be called' });
    const d = seedLead({ phone: '+61412000051' });
    await give(d, '+61412000051', true, true);
    x('UPDATE leads SET do_not_call_at = ? WHERE id = ?', T0, d);
    expect(await canCall(rt, await lead(d), 'x')).toEqual({ ok: false, reason: 'asked not to be called' });
    expect((await canText(rt, await lead(d), 'x')).ok).toBe(true);
  });

  it('imported contacts and countries we don’t contact are blocked; legacy consent from the old forms still counts', async () => {
    const imp = seedLead({ phone: '+61412000060', source: 'calendly-direct', call: T0 - 1000, version: 'v2' });
    expect(await canCall(rt, await lead(imp), 'x')).toEqual({ ok: false, reason: 'imported contact without consent' });
    const no = seedLead({ phone: '+4741234567', call: T0 - 1000, version: 'v2' });
    expect(await canCall(rt, await lead(no), 'x')).toEqual({ ok: false, reason: 'number outside the countries we contact' });
    // The old single box said "call or text": it still covers both. The c3 call box covers calls only.
    const legacy = seedLead({ phone: '+61412000061', call: T0 - 1000, version: 'webinar-v1' });
    expect((await canText(rt, await lead(legacy), 'x')).ok).toBe(true);
    const c3 = seedLead({ phone: '+61412000062', call: T0 - 1000, version: CONSENT_COPY.version });
    expect((await canText(rt, await lead(c3), 'x')).ok).toBe(false);
  });

  it('old wording only covers what it named: the application box (v1, v2) never covers offer calls or texts', async () => {
    const v2 = seedLead({ phone: '+61412000065', call: T0 - 1000, version: 'v2' });
    expect((await canCall(rt, await lead(v2), 'ai_call:confirm')).ok).toBe(true);
    expect((await canCall(rt, await lead(v2), 'ai_call:speed_to_lead')).ok).toBe(true);
    expect(await canCall(rt, await lead(v2), 'ai_call:w_post_nobuy')).toEqual({ ok: false, reason: 'old consent wording doesn’t cover offers' });
    expect((await canText(rt, await lead(v2), 'sms:booked')).ok).toBe(true);
    expect((await canText(rt, await lead(v2), 'followup_text:quiet')).ok).toBe(false);
    // The old masterclass box named "Josh's offers": it does.
    const w = seedLead({ phone: '+61412000066', call: T0 - 1000, version: 'webinar-v1' });
    expect((await canCall(rt, await lead(w), 'ai_call:w_post_nobuy')).ok).toBe(true);
    // An old session reminder box: that session's reminders, not offer follow-ups.
    const r = seedLead({ phone: '+61412000067', sms: T0 - 1000 });
    expect((await canText(rt, await lead(r), 'live_text:r1h')).ok).toBe(true);
    expect((await canText(rt, await lead(r), 'followup_text:unpaid')).ok).toBe(false);
    // c3 consent (with proof) names offers.
    const c = seedLead({ phone: '+61412000068' });
    await give(c, '+61412000068', true, true);
    expect((await canCall(rt, await lead(c), 'ai_call:w_post_nobuy')).ok).toBe(true);
    expect((await canText(rt, await lead(c), 'followup_text:quiet')).ok).toBe(true);
  });

  it('the owner’s test send is allowed and logged; a test to a lead’s number without consent is refused', async () => {
    const t = await testPass(rt, 'call', '+61400111222', 'ai_call:confirm');
    expect(t.ok).toBe(true);
    if (t.ok) { expect(t.pass.basis).toBe('test'); expect(passTo(t.pass, 'call')).toBe('+61400111222'); }
    expect(q('SELECT channel, purpose, outcome, phone FROM contact_gate_log')).toEqual([{ channel: 'call', purpose: 'test:ai_call:confirm', outcome: 'test', phone: '+61400111222' }]);
    seedLead({ phone: '+61412000070' });
    const r = await testPass(rt, 'sms', '+61412000070', 'sms_step');
    expect(r.ok).toBe(false);
    expect(q("SELECT reason FROM contact_gate_log WHERE outcome = 'blocked'")[0]).toMatchObject({ reason: "test to a lead's number: no consent to text" });
    const report = await gateReport(rt.env);
    expect(report.tests).toHaveLength(1);
    expect(report.blocked[0]).toMatchObject({ channel: 'sms', n: 1 });
  });
});

describe('every send primitive needs a pass from the gate', () => {
  it('sendSmsNow, the WhatsApp sends and dial throw without a real pass (or with one for another channel)', async () => {
    const fetches: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string) => { fetches.push(String(u)); return new Response('{"sid":"SM1","messages":[{"id":"w1"}],"success":true,"conversation_id":"c1"}'); }));
    const r2 = makeRt({ TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', SMS_FROM: '+61400000000', WHATSAPP_TOKEN: 'w', WHATSAPP_PHONE_NUMBER_ID: 'p' });
    const fake = { channel: 'sms', to: '+61412000080', leadId: null, purpose: 'x', basis: 'consent', at: Date.now() } as never;
    await expect(sendSmsNow(r2, fake, 'hi')).rejects.toThrow(/contact gate/);
    await expect(sendWhatsAppText(r2, fake, 'hi')).rejects.toThrow(/contact gate/);
    await expect(sendWhatsAppTemplate(r2, fake, 't', [])).rejects.toThrow(/contact gate/);
    await expect(dial(r2, {} as Lead, 'confirm', 'twilio', fake)).rejects.toThrow(/contact gate/);
    const smsPass = replyPass('sms', '+61412000080', 'test');
    await expect(sendWhatsAppText(r2, smsPass, 'hi')).rejects.toThrow(/contact gate/); // wrong channel
    expect(fetches).toEqual([]);
    expect(await sendSmsNow(r2, smsPass, 'hi')).toBe('SM1');
    expect(fetches).toHaveLength(1);
    // A pass expires after 10 minutes.
    vi.setSystemTime(T0 + 11 * 60_000);
    await expect(sendSmsNow(r2, smsPass, 'hi')).rejects.toThrow(/contact gate/);
  });

  it('the AI call queue and dialler check the gate: no consent, no call', async () => {
    const id = seedLead({ phone: '+61412000090', tier: 'A' });
    expect(await queueCall(rt, await lead(id), 'speed_to_lead', 0)).toBeNull();
    expect(q('SELECT * FROM outbound_calls')).toEqual([]);
    // A row queued anyway (or before consent was withdrawn) is skipped at dial time with the gate's reason.
    x("INSERT INTO outbound_calls (id, lead_id, kind, status, run_at, attempts, created_at, updated_at) VALUES ('oc1', ?, 'speed_to_lead', 'queued', ?, 0, ?, ?)", id, T0, T0, T0);
    x('UPDATE leads SET call_consent_at = ? WHERE id = ?', T0, id); // passes the older checks, but the proof says otherwise below
    await recordConsent(rt, id, { phone: '+61412000090', call: true, texts: false, source: 'apply' });
    await updateLead(rt.env, id, { phone: '+61412000091' });
    const fetched = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetched);
    const call = q<OutboundCall>("SELECT * FROM outbound_calls WHERE id = 'oc1'")[0];
    expect(await dialQueuedCall(rt, call, async () => 'twilio', T0)).toBe('skipped');
    expect(q<{ status: string; error: string }>("SELECT status, error FROM outbound_calls WHERE id = 'oc1'")[0]).toMatchObject({ status: 'skipped' });
    expect(fetched).not.toHaveBeenCalled();
  });

  it('the text sequences check the gate when queued and when sent', async () => {
    const id = seedLead({ phone: '+61412000100' });
    x("UPDATE leads SET app_completed_at = NULL, status = 'partial' WHERE id = ?", id); // an abandoned application
    expect(await startSms(rt, await lead(id), 'abandoned')).toBe(0);
    await give(id, '+61412000100', false, true);
    const queued = await startSms(rt, await lead(id), 'abandoned');
    expect(queued).toBeGreaterThan(0);
    // The number changes before the text goes: skipped, nothing sent.
    await updateLead(rt.env, id, { phone: '+61412000101' });
    x("UPDATE sms_messages SET to_phone = '+61412000101', send_at = ?", T0);
    const row = q<{ id: string; lead_id: string; sequence: 'abandoned'; step: number; to_phone: string; attempts: number }>("SELECT id, lead_id, sequence, step, to_phone, attempts FROM sms_messages ORDER BY step LIMIT 1")[0];
    const fetched = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetched);
    expect(await sendSmsRow(rt, row, DEFAULT_SMS_SEQUENCES, T0)).toBe('skipped');
    expect(q<{ status: string; error: string }>('SELECT status, error FROM sms_messages WHERE id = ?', row.id)[0]).toEqual({ status: 'skipped', error: 'number changed since consent' });
    expect(fetched).not.toHaveBeenCalled();
  });
});

describe('Funnel HQ and the sandbox', () => {
  it('the lead drawer shows consent per channel with proof and opt-outs', async () => {
    const id = seedLead({ phone: '+61412000110' });
    await give(id, '+61412000110', true, false);
    const s = await consentSummary(rt.env, await lead(id));
    expect(s.channels.find((c) => c.channel === 'call')).toMatchObject({ allowed: true, proof: { action: 'granted', source: 'apply', page: '/apply', version: CONSENT_COPY.version, phone: '+61412000110', text: CONSENT_COPY.call } });
    expect(s.channels.find((c) => c.channel === 'sms')).toMatchObject({ allowed: false, reason: 'no consent to text', proof: null });
    expect(s.opt_outs).toEqual({ sms_stop_at: null, do_not_call_at: null, email_unsubscribed_at: null });
  });

  it('the sandbox runs the same rule: a changed number means no calls and no texts; calls-only means no texts', () => {
    const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => { throw new Error('write'); } };
    const sbRt = { settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), SALES_TIMEZONE: 'Australia/Sydney', SITE_NAME: 'G&L' }, env: { DB: { prepare: () => stmt } }, origin: 'https://apply.test', reps: [], waitUntil: () => undefined } as never;
    const sent = (s: ReturnType<typeof simulate>, ch: string) => s.events.filter((e) => e.status === 'sent' && e.ch === ch);
    for (const journey of ['live', 'strategy'] as const) {
      const ok = simulate(sbRt, cleanInput({ journey, anchor: T0, lead: {} }, T0));
      expect(sent(ok, 'sms').length + sent(ok, 'call').length, journey).toBeGreaterThan(0);
      const changed = simulate(sbRt, cleanInput({ journey, anchor: T0, lead: { numberChanged: true } }, T0));
      expect([...sent(changed, 'sms'), ...sent(changed, 'call')], journey).toEqual([]);
      expect(changed.events.some((e) => /different number/.test(e.reason ?? '')), journey).toBe(true);
    }
    const callsOnly = cleanInput({ journey: 'strategy', anchor: T0, lead: { textOk: false } }, T0);
    expect(sent(simulate(sbRt, callsOnly), 'sms')).toEqual([]);
    // The rows the sandbox feeds the gate match what the forms record.
    const rows = sandboxConsentRows(callsOnly, T0);
    expect(rows.map((r) => r.channel)).toEqual(['call']);
    expect(consentBlock({ phone: '+61412345678', do_not_call_at: null, sms_opt_out_at: null, booking_source: 'funnel', call_consent_at: T0, call_consent_text: CONSENT_COPY.version, sms_consent_at: null, wa_consent_at: null, whatsapp_connected_at: null }, 'sms', rows)).toBe('no consent to text');
  });

  it('the consent wording passes the copy rules and says what the law asks', () => {
    for (const t of [CONSENT_COPY.call, CONSENT_COPY.sms, CONSENT_LEGEND]) expect(auditCopy(t), t).toEqual([]);
    for (const t of [CONSENT_COPY.call, CONSENT_COPY.sms]) {
      expect(t).toMatch(/G&L M&A Advisory \(Josh Li’s team\)/);
      expect(t).toMatch(/Consent isn’t required to register or buy\./);
      expect(t).not.toMatch(/—|!/);
    }
    expect(CONSENT_COPY.call).toMatch(/automated and AI-voice calls/);
    expect(CONSENT_COPY.call).toMatch(/opt out/);
    expect(CONSENT_COPY.sms).toMatch(/Msg & data rates may apply\. Reply STOP to opt out\./);
  });
});

// ───────────── static scan: no way round the gate ─────────────

describe('no code path reaches a provider without the gate', () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir).flatMap((f) => (f.endsWith('.ts') ? [`${dir}/${f}`] : f.includes('.') ? [] : walk(`${dir}/${f}`)));
  const files = walk(`${node.cwd()}/src`).map((f) => ({ f: f.slice(node.cwd().length + 1), s: fs.readFileSync(f, 'utf8') }));
  // Comment lines only (a block-comment regex would also eat code between a '/*' inside a string and the next '*/').
  const strip = (s: string) => s.replace(/^\s*(\/\/|\/\*|\*).*$/gm, '');

  it('the provider endpoints for texts, WhatsApp and outbound calls appear only in the three send primitives', () => {
    const ENDPOINTS: [RegExp, string][] = [
      [/api\.twilio\.com[^\n]*Messages/, 'src/integrations/sms.ts'],
      [/api\.twilio\.com[^\n]*Calls/, '(none)'],
      [/api\.telnyx\.com\/v2\/messages/, 'src/integrations/sms.ts'],
      [/api\.telnyx\.com\/v2\/calls/, '(none)'],
      [/outbound-call/, 'src/integrations/elevenlabs.ts'],
      [/batch-calling/, '(none)'],
      [/graph\.facebook\.com[^\n]*\/messages/, 'src/integrations/whatsapp.ts'],
    ];
    for (const [re, allowed] of ENDPOINTS) {
      const hits = files.filter(({ s }) => re.test(strip(s))).map(({ f }) => f);
      expect(hits.filter((f) => f !== allowed), String(re)).toEqual([]);
    }
  });

  it('each primitive checks its pass first, and the raw senders are private', () => {
    const sms = strip(fs.readFileSync(`${node.cwd()}/src/integrations/sms.ts`, 'utf8'));
    expect(sms).toMatch(/export async function sendSmsNow\(rt: Runtime, pass: ContactPass, body0: string\) \{\n\s*const to = passTo\(pass, 'sms'\);/);
    expect(sms).not.toMatch(/export (async )?function send(Twilio|Telnyx)/);
    expect((sms.match(/\bsend(Twilio|Telnyx)\(/g) ?? []).length).toBe(4); // two definitions, two calls inside sendSmsNow
    const wa = strip(fs.readFileSync(`${node.cwd()}/src/integrations/whatsapp.ts`, 'utf8'));
    expect(wa).not.toMatch(/export (async )?(function|const) waPost/);
    expect(wa).toMatch(/sendWhatsAppText = async \(rt: Runtime, pass: ContactPass, text: string\) =>\n\s*waPost\(rt, \{ to: passTo\(pass, 'whatsapp'\)/);
    expect(wa).toMatch(/sendWhatsAppTemplate = async \(rt: Runtime, pass: ContactPass, name: string, params: string\[\]\) =>\n\s*waPost\(rt, \{\n\s*to: passTo\(pass, 'whatsapp'\)/);
    expect((wa.match(/\bwaPost\(/g) ?? []).length).toBe(3);
    const el = strip(fs.readFileSync(`${node.cwd()}/src/integrations/elevenlabs.ts`, 'utf8'));
    expect(el).toMatch(/export async function dial\([^)]*pass: ContactPass[^)]*\) \{\n\s*const toNumber = passTo\(pass, 'call'\);/);
    expect((el.match(/outbound-call/g) ?? []).length).toBe(2); // only inside dial
  });

  // Every call to a primitive, with the argument that must be a pass from the gate.
  const CALLS = /\b(sendSmsNow|sendWhatsAppText|sendWhatsAppTemplate|dial)\(([^;]*?)\)/g;
  const offenders = (f: string, src: string) => {
    const bad: string[] = [];
    let seen = 0;
    for (const m of strip(src).matchAll(CALLS)) {
      if (/pass: ContactPass/.test(m[2])) continue; // the definitions
      seen++;
      const args = m[2].split(',').map((a) => a.trim());
      const passArg = m[1] === 'dial' ? args[4] : args[1];
      if (!passArg || !/^(gate|g|t|r)\.(wa\.|sms\.)?pass$|^replyPass\(/.test(passArg)) bad.push(`${f}: ${m[0].slice(0, 120)}`);
    }
    return { bad, seen };
  };

  it('every call to a primitive hands it a pass from the gate', () => {
    const bad: string[] = [];
    let seen = 0;
    for (const { f, s } of files) {
      if (f === 'src/admin/sandbox.ts') continue; // the sandbox's own simulated dial(c, t): no network, no primitive
      const r = offenders(f, s);
      bad.push(...r.bad);
      seen += r.seen;
    }
    expect(bad).toEqual([]);
    expect(seen).toBeGreaterThanOrEqual(15); // the scan really finds the call sites
    // And it catches a bypass.
    expect(offenders('x.ts', 'await sendSmsNow(rt, lead.phone!, body);').bad).toHaveLength(1);
    expect(offenders('x.ts', 'await dial(rt, lead, kind, undefined, number);').bad).toHaveLength(1);
    expect(offenders('x.ts', 'await sendWhatsAppText(rt, lead, text);').bad).toHaveLength(1);
  });

  it('only the gate makes passes; test and reply passes only from the test buttons and the inbound webhooks', () => {
    const uses = (re: RegExp) => files.filter(({ s }) => re.test(strip(s))).map(({ f }) => f).sort();
    expect(uses(/\bissue\(\{/)).toEqual(['src/integrations/consent-gate.ts']);
    expect(uses(/\btestPass\(/)).toEqual(['src/admin/webinar-calls.ts', 'src/integrations/consent-gate.ts', 'src/routes/admin.ts']);
    expect(uses(/\breplyPass\(/)).toEqual(['src/integrations/whatsapp.ts', 'src/routes/hooks.ts']);
  });
});
