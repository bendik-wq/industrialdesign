import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { RECOMMENDATIONS, SIGNAL_PLAN, buildPlan, conversionRule, websiteRule } from '../src/audiences/catalog';
import { segmentIds } from '../src/audiences/segments';
import { audiencesReport } from '../src/audiences/sync';
import { META_EVENTS } from '../src/tracking/catalog';
import { conversionValue, metaEventName } from '../src/tracking/forward';
import { MODEL_WEBINAR, SIGNALS, modelValues, sendSignals, signalCandidates, signalEventId, signalKey, signalValues, signalsReport, watchedMinutes } from '../src/tracking/signals';
import { isPaidSale } from '../src/lib/paid-sales';
import { eventReport, listEvents } from '../src/live/events';
import { SETTINGS } from '../src/settings';

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

const META = { META_PIXEL_ID: '366312909220995', META_ACCESS_TOKEN: 'capi' };
function makeRt(db: DatabaseSync, s: Record<string, string> = {}) {
  const pending: Promise<unknown>[] = [];
  const rt = { env: { DB: d1(db) }, settings: { SALES_TIMEZONE: 'Australia/Sydney', ...META, ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p); } } as unknown as Runtime;
  return { rt, settle: async () => { while (pending.length) await pending.shift(); } };
}

/** Captures Conversions API posts; answers like Meta. */
function stubMeta() {
  const events: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { body?: string }) => {
    if (String(url).includes('graph.facebook.com') && init?.body) for (const e of (JSON.parse(init.body) as { data: Record<string, unknown>[] }).data) events.push(e);
    return new Response(JSON.stringify({ events_received: 1, fbtrace_id: 't' }), { status: 200 });
  }));
  return events;
}
afterEach(() => { vi.unstubAllGlobals(); });

const NOW = Date.now();
const MIN = 60_000, DAY = 86_400_000;
function lead(db: DatabaseSync, id: string, o: { eu?: boolean } = {}) {
  db.prepare(`INSERT INTO leads (id, ref_code, created_at, updated_at, visitor_id, first_name, last_name, email, status, country)
    VALUES (?, ?, ?, ?, ?, 'Dana', 'Owner', ?, 'applied', 'AU')`).run(id, `R${id}`, NOW, NOW, `v_${id}`, `${id}@owner.co`);
  db.prepare('INSERT INTO sessions (id, visitor_id, started_at, last_seen_at, is_eu) VALUES (?, ?, ?, ?, ?)').run(`s_${id}`, `v_${id}`, NOW, NOW, o.eu ? 1 : 0);
}
function liveEvent(db: DatabaseSync, id: string, startsAt = NOW - 2 * 3600_000) {
  db.prepare("INSERT INTO live_webinars (id, title, starts_at, tz, duration_min, created_at, updated_at) VALUES (?, 'Live', ?, 'Australia/Sydney', 120, ?, ?)").run(id, startsAt, NOW, NOW);
}
function liveReg(db: DatabaseSync, id: string, eventId: string, leadId: string) {
  db.prepare('INSERT INTO live_webinar_regs (id, token, event_id, lead_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, `t_${id}`, eventId, leadId, NOW - DAY);
}
function minutes(db: DatabaseSync, funnel: string, ref: string, regId: string, leadId: string, n: number) {
  for (let m = 0; m < n; m++) db.prepare('INSERT INTO attr_watch (funnel, event_ref, reg_id, lead_id, minute) VALUES (?, ?, ?, ?, ?)').run(funnel, ref, regId, leadId, m);
}
function stage(db: DatabaseSync, funnel: string, stageId: string, regId: string, leadId: string, cohort: string, detail: string | null = null, key = '') {
  db.prepare("INSERT INTO attr_stages (id, funnel, stage, lead_id, reg_id, cohort_ref, ts, detail, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'room')").run(`${funnel}:${regId}:${stageId}${key}`, funnel, stageId, leadId, regId, cohort, NOW - MIN, detail);
}
const sentNames = (events: Record<string, unknown>[]) => events.map((e) => e.event_name);

// ───────────── 1. definitions ─────────────

describe('signal definitions', () => {
  it('each signal is a custom Meta event, mapped through the existing catalog', () => {
    for (const s of SIGNALS) {
      expect(META_EVENTS[s.event]).toBe(s.meta);
      expect(metaEventName(s.event, {})).toBe(s.meta);
    }
    expect(new Set(SIGNALS.map((s) => s.meta)).size).toBe(6);
  });
  it('the audiences catalog names the same events as the sender', () => {
    expect(SIGNAL_PLAN.map((g) => [g.id, g.meta])).toEqual(SIGNALS.map((s) => [s.id, s.meta]));
  });
  it('a value is forwarded only when one was attached', () => {
    expect(conversionValue('signal_watched_30m', {}, null)).toBeUndefined();
    expect(conversionValue('signal_watched_30m', { value: 1368 }, null)).toBe(1368);
    expect(conversionValue('signal_contract_signed', { value: 50000 }, null)).toBe(50000);
  });
  it('keys are per signal, funnel, session and person; event ids are deterministic and short', async () => {
    const k = signalKey({ signal: 'watched_30m', funnel: 'live', session: 'ev1', leadId: 'l1' });
    expect(k).toBe('watched_30m:live:ev1:l1');
    const a = await signalEventId(k), b = await signalEventId(k);
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).toMatch(/^[\w-]{8,64}$/);
  });
  it('auto-webinar minutes count live or replay, once each', () => {
    expect(watchedMinutes('1100', '0011')).toBe(4);
    expect(watchedMinutes('1111', '1111')).toBe(4);
    expect(watchedMinutes(null, null)).toBe(0);
  });
  it('settings are documented, default off for values, and pass the copy rules', () => {
    const keys = SETTINGS.map((s) => s.key);
    expect(keys).toContain('META_SIGNALS');
    expect(keys).toContain('META_SIGNAL_VALUES');
    for (const s of (SETTINGS as readonly { key: string; label: string; help?: string }[]).filter((x) => x.key.startsWith("META_SIGNAL"))) expect(auditCopy(`${s.label}. ${s.help ?? ""}`)).toEqual([]);
  });
});

// ───────────── 2. values (finance model, own data) ─────────────

describe('signal values', () => {
  it('model defaults: attendee value from the Sprint ladder, application value through a call', () => {
    const m = modelValues(null);
    const attendee = MODEL_WEBINAR.sprintRate * (MODEL_WEBINAR.sprintPrice + MODEL_WEBINAR.sprintToEng * (MODEL_WEBINAR.engFee - MODEL_WEBINAR.sprintPrice));
    expect(m.values.watched_30m).toBe(Math.round(attendee));
    expect(m.values.stayed_for_pitch).toBe(Math.round(attendee));
    expect(m.values.application_submitted).toBe(Math.round(0.35 * 0.7 * 0.75 * 0.2 * 22500));
    expect(m.values.offer_opened).toBeUndefined();
    expect(m.values.checkout_started).toBeUndefined();
    expect(m.currency).toBe('USD');
  });
  it('a saved model without the ladder uses applications from attendees', () => {
    const m = modelValues({ shared: { fee: 40000, currency: 'AUD' }, webinar: { applyAtt: 0.2, qualified: 0.5, book: 1, show: 1, close: 0.5 } });
    expect(m.currency).toBe('AUD');
    expect(m.values.application_submitted).toBe(10000);
    expect(m.values.watched_30m).toBe(2000);
  });
  it('switches to our own outcomes once 50 people and 3 buyers exist', async () => {
    const db = freshDb();
    const { rt } = makeRt(db);
    const old = NOW - 40 * DAY;
    for (let i = 0; i < 60; i++) db.prepare("INSERT INTO meta_signals (key, signal, funnel, session_ref, lead_id, event_id, status, sent_at) VALUES (?, 'stayed_for_pitch', 'live', 'ev', ?, ?, 'sent', ?)").run(`k${i}`, `p${i}`, `e${i}`, old);
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, created_at, updated_at) VALUES (?, 'deposit_paid', 'live', ?, ?, ?, 500000, 0, 'usd', ?, ?)").run(`c${i}`, `r${i}`, `p${i}`, old + 3600_000, old, old);
    const v = (await signalValues(rt)).find((x) => x.signal === 'stayed_for_pitch')!;
    expect(v.value).toBe(Math.round((3 * 5000) / 60));
    expect(v.basis).toMatch(/our own outcomes/);
    const w = (await signalValues(rt)).find((x) => x.signal === 'watched_30m')!;
    expect(w.basis).toMatch(/financial model/);
    const o = (await signalValues(rt)).find((x) => x.signal === 'offer_opened')!;
    expect(o.value).toBeNull();
  });
});

// ───────────── 3. sending ─────────────

describe('sending signals', () => {
  it('watched 30+ minutes in a live room: one custom event, no value by default, never twice', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1'); lead(db, 'l2');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1'); liveReg(db, 'r2', 'ev1', 'l2');
    minutes(db, 'live', 'ev1', 'r1', 'l1', 31);
    minutes(db, 'live', 'ev1', 'r2', 'l2', 12); // under 30: nothing
    const r = await sendSignals(rt);
    await settle();
    expect(r.sent).toBe(1);
    expect(sentNames(events)).toEqual(['Watched30Min']);
    const e = events[0] as { event_id: string; action_source: string; custom_data: Record<string, unknown> };
    expect(e.action_source).toBe('website');
    expect(e.custom_data.value).toBeUndefined();
    expect(e.custom_data.funnel).toBe('live');
    expect(e.custom_data.signal).toBe('watched_30m');
    expect(e.event_id).toBe(await signalEventId('watched_30m:live:ev1:l1'));
    // Next cron run: nothing new.
    expect((await sendSignals(rt)).sent).toBe(0);
    await settle();
    expect(events.length).toBe(1);
    // Logged first-party and in the delivery log.
    expect((db.prepare("SELECT COUNT(*) AS n FROM events WHERE name = 'signal_watched_30m'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT status FROM forward_log WHERE dest = 'meta'").get() as { status: string }).status).toBe('sent');
  });

  it('each session counts once per person: a challenge day is its own session', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1');
    db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co1', 'C', '2026-11-01', '18:00', 'UTC', ?, ?)").run(NOW, NOW);
    for (const day of [1, 2]) db.prepare('INSERT INTO challenge_days (cohort_id, day, starts_at, duration_min, updated_at) VALUES (?, ?, ?, 90, ?)').run('co1', day, NOW - (3 - day) * DAY, NOW);
    db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, created_at) VALUES ('cr1', 'tk', 'co1', 'l1', ?)").run(NOW - 3 * DAY);
    minutes(db, 'challenge', 'challenge:co1:1', 'cr1', 'l1', 45);
    minutes(db, 'challenge', 'challenge:co1:2', 'cr1', 'l1', 30);
    await sendSignals(rt);
    await settle();
    expect(sentNames(events)).toEqual(['Watched30Min', 'Watched30Min']);
    expect(events.map((e) => (e.custom_data as { day?: number }).day).sort()).toEqual([1, 2]);
  });

  it('automated webinar: live and replay minutes together reach 30', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1'); lead(db, 'l2');
    const reg = (id: string, l: string, live: string, replay: string) => db.prepare('INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, joined_at, replay_at, last_seen_at, live_minutes, replay_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, `t_${id}`, 'ws1', l, NOW - DAY, NOW - 3600_000, NOW - 1800_000, NOW - MIN, live, replay);
    reg('w1', 'l1', '1'.repeat(20) + '0'.repeat(20), '0'.repeat(20) + '1'.repeat(10));
    reg('w2', 'l2', '1'.repeat(29), '1'.repeat(29));
    await sendSignals(rt);
    await settle();
    expect(sentNames(events)).toEqual(['Watched30Min']);
    expect((db.prepare('SELECT lead_id, funnel, session_ref FROM meta_signals').get() as Record<string, string>)).toEqual({ lead_id: 'l1', funnel: 'auto', session_ref: 'ws1' });
  });

  it('stage signals: stayed for the pitch, opened a card, started checkout, applied in the room, VIP checkout', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1'); lead(db, 'l2');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    stage(db, 'live', 'offer_seen', 'r1', 'l1', 'ev1');
    stage(db, 'live', 'room_push', 'r1', 'l1', 'ev1', 'deposit:opened', ':room1:7:opened');
    stage(db, 'live', 'offer_clicked', 'r1', 'l1', 'ev1'); // same session and signal as the card open: one event
    stage(db, 'live', 'room_push', 'r1', 'l1', 'ev1', 'deposit:started', ':room1:7:started');
    stage(db, 'live', 'room_application', 'r1', 'l1', 'ev1');
    db.prepare("INSERT INTO challenge_cohorts (id, name, start_date, start_time, timezone, created_at, updated_at) VALUES ('co1', 'C', '2026-11-01', '18:00', 'UTC', ?, ?)").run(NOW, NOW);
    db.prepare("INSERT INTO challenge_registrations (id, token, cohort_id, lead_id, created_at) VALUES ('cr2', 'tk2', 'co1', 'l2', ?)").run(NOW - DAY);
    db.prepare("INSERT INTO challenge_orders (id, reg_id, lead_id, kind, status, amount, currency, created_at, updated_at) VALUES ('o1', 'cr2', 'l2', 'vip', 'pending', 30000, 'usd', ?, ?)").run(NOW - MIN, NOW - MIN);
    await sendSignals(rt);
    await settle();
    expect(sentNames(events).sort()).toEqual(['OfferCardOpened', 'OfferCheckoutStarted', 'OfferCheckoutStarted', 'RoomApplicationSubmitted', 'StayedForPitch']);
    const offers = events.filter((e) => e.event_name !== 'StayedForPitch' && e.event_name !== 'RoomApplicationSubmitted').map((e) => (e.custom_data as { offer?: string }).offer).sort();
    expect(offers).toEqual(['deposit', 'deposit', 'vip']);
    expect((await signalCandidates(rt)).length).toBe(0);
  });

  it('values are sent only when META_SIGNAL_VALUES is on, and flagged as estimates', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db, { META_SIGNAL_VALUES: 'on' });
    lead(db, 'l1');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    stage(db, 'live', 'offer_seen', 'r1', 'l1', 'ev1');
    stage(db, 'live', 'offer_clicked', 'r1', 'l1', 'ev1');
    await sendSignals(rt);
    await settle();
    const pitch = events.find((e) => e.event_name === 'StayedForPitch')!.custom_data as Record<string, unknown>;
    expect(pitch.value).toBe(modelValues(null).values.stayed_for_pitch);
    expect(pitch.currency).toBe('USD');
    expect(pitch.predicted_value).toBe(true);
    // No model rate for opening a card and no own data yet: no value even with the setting on.
    const opened = events.find((e) => e.event_name === 'OfferCardOpened')!.custom_data as Record<string, unknown>;
    expect(opened.value).toBeUndefined();
    const row = db.prepare("SELECT estimate, basis FROM meta_signals WHERE signal = 'stayed_for_pitch'").get() as { estimate: number; basis: string };
    expect(row.estimate).toBe(1);
    expect(row.basis).toMatch(/financial model/);
  });

  it('a signed engagement is an offline conversion carrying the contract fee', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1'); lead(db, 'l9');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    db.prepare("INSERT INTO contracts (id, token, lead_id, status, title, fee, currency, created_at, signed_at) VALUES ('k1', 'tok1', 'l1', 'signed', 'Engagement', 50000, 'AUD', ?, ?)").run(NOW - DAY, NOW - 3600_000);
    // Not from a webinar funnel: no signal.
    db.prepare("INSERT INTO contracts (id, token, lead_id, status, title, fee, currency, created_at, signed_at) VALUES ('k9', 'tok9', 'l9', 'signed', 'Engagement', 40000, 'AUD', ?, ?)").run(NOW - DAY, NOW - 3600_000);
    await sendSignals(rt);
    await settle();
    expect(sentNames(events)).toEqual(['EngagementSigned']);
    const e = events[0] as { action_source: string; event_source_url?: string; custom_data: Record<string, unknown> };
    expect(e.action_source).toBe('system_generated');
    expect(e.event_source_url).toBeUndefined();
    expect(e.custom_data).toMatchObject({ value: 50000, currency: 'AUD', funnel: 'live' });
    expect(e.custom_data.predicted_value).toBeUndefined();
    await sendSignals(rt);
    await settle();
    expect(events.length).toBe(1);
  });

  it('consent: an EU visitor without consent is recorded but never reaches Meta', async () => {
    const db = freshDb();
    const events = stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1', { eu: true });
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    minutes(db, 'live', 'ev1', 'r1', 'l1', 40);
    const r = await sendSignals(rt);
    await settle();
    expect(r).toMatchObject({ sent: 0, noConsent: 1 });
    expect(events.length).toBe(0);
    expect((db.prepare('SELECT status FROM meta_signals').get() as { status: string }).status).toBe('no_consent');
  });

  it('nothing is sent when switched off, without the Pixel, or for signals older than Meta accepts', async () => {
    const db = freshDb();
    const events = stubMeta();
    lead(db, 'l1');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    minutes(db, 'live', 'ev1', 'r1', 'l1', 40);
    expect((await sendSignals(makeRt(db, { META_SIGNALS: 'off' }).rt)).skipped).toBe(true);
    expect((await sendSignals(makeRt(db, { META_PIXEL_ID: '' }).rt)).skipped).toBe(true);
    liveEvent(db, 'ev_old', NOW - 9 * DAY);
    liveReg(db, 'r_old', 'ev_old', 'l1');
    minutes(db, 'live', 'ev_old', 'r_old', 'l1', 60);
    const { rt, settle } = makeRt(db);
    await sendSignals(rt);
    await settle();
    expect(events.length).toBe(1);
    expect((db.prepare('SELECT session_ref FROM meta_signals').get() as { session_ref: string }).session_ref).toBe('ev1');
  });

  it('report for Funnel HQ: counts, values and labels pass the copy rules', async () => {
    const db = freshDb();
    stubMeta();
    const { rt, settle } = makeRt(db);
    lead(db, 'l1');
    liveEvent(db, 'ev1');
    liveReg(db, 'r1', 'ev1', 'l1');
    minutes(db, 'live', 'ev1', 'r1', 'l1', 40);
    await sendSignals(rt);
    await settle();
    const rep = await signalsReport(rt);
    expect(rep.on).toBe(true);
    expect(rep.valuesOn).toBe(false);
    expect(rep.signals.find((s) => s.id === 'watched_30m')).toMatchObject({ sent: 1, byFunnel: { live: 1, auto: 0, challenge: 0 } });
    for (const s of rep.signals) expect(auditCopy(`${s.label}. ${s.description} ${s.value?.basis ?? ''}`)).toEqual([]);
  });
});

// ───────────── 4. audiences catalog ─────────────

describe('Meta audiences catalog: signals', () => {
  it('one custom conversion per signal, plus warm website and list audiences that exclude buyers', () => {
    const plan = buildPlan();
    for (const g of SIGNAL_PLAN) {
      const c = plan.find((i) => i.key === `conv_signal_${g.id}`)!;
      expect(c).toMatchObject({ kind: 'conversion', customEventType: 'OTHER', event: g.meta });
      expect(conversionRule(c)).toEqual({ and: [{ event: { eq: g.meta } }] });
    }
    const web = plan.find((i) => i.key === 'web_sig_stayed_for_pitch_nobuy')!;
    const rule = websiteRule(web, '1', 30) as { inclusions: { rules: { filter: { filters: { value: string }[] } }[] }; exclusions: { rules: { filter: { filters: { value: string }[] } }[] } };
    expect(rule.inclusions.rules[0].filter.filters[0].value).toBe('StayedForPitch');
    expect(rule.exclusions.rules[0].filter.filters[0].value).toBe('Purchase');
    expect(plan.find((i) => i.key === 'list_sig_signed')).toMatchObject({ exclusion: true });
    expect(plan.filter((i) => i.kind === 'conversion').length).toBeLessThanOrEqual(100);
    for (const i of plan.filter((x) => x.key.includes('sig'))) expect(auditCopy(`${i.name}. ${i.description}`)).toEqual([]);
    for (const r of RECOMMENDATIONS) expect(auditCopy(`${r.campaign}. ${r.optimise}. ${r.then}`)).toEqual([]);
  });

  it('list segments read who was sent each signal, minus buyers', async () => {
    const db = freshDb();
    const { rt } = makeRt(db);
    lead(db, 'a'); lead(db, 'b');
    for (const id of ['a', 'b']) db.prepare("INSERT INTO meta_signals (key, signal, funnel, session_ref, lead_id, event_id, status, sent_at) VALUES (?, 'checkout_started', 'live', 'ev', ?, ?, 'sent', ?)").run(`k${id}`, id, `e${id}`, NOW);
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, created_at, updated_at) VALUES ('p1', 'wr', 'b', 'deposit', 'paid', 500000, 'usd', ?, ?, ?)").run(NOW, NOW, NOW);
    expect([...(await segmentIds(rt, { type: 'signal', signal: 'checkout_started', noPurchase: true })).ids]).toEqual(['a']);
    expect((await segmentIds(rt, { type: 'signal', signal: 'checkout_started' })).ids.size).toBe(2);
  });

  it('the Meta audiences report carries the signals (nothing is created without approval)', async () => {
    const db = freshDb();
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);
    const { rt } = makeRt(db, { META_AD_ACCOUNT_ID: '1' });
    const rep = await audiencesReport(rt) as unknown as { signals: { signals: unknown[] }; items: { key: string; status: string }[] };
    expect(rep.signals.signals.length).toBe(6);
    expect(rep.items.filter((i) => i.key.includes('sig')).every((i) => i.status === 'not_created')).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ───────────── 5. Live webinars list: the shared paid-sales definition ─────────────

describe('Live webinars list counts sales like revenue does', () => {
  it('a refunded deposit is still a sale; the refund shows in revenue', async () => {
    expect(isPaidSale('paid')).toBe(true);
    expect(isPaidSale('refunded')).toBe(true);
    expect(isPaidSale('pending')).toBe(false);
    const db = freshDb();
    const { rt } = makeRt(db);
    lead(db, 'l1'); lead(db, 'l2'); lead(db, 'l3');
    liveEvent(db, 'ev1');
    for (const l of ['l1', 'l2', 'l3']) liveReg(db, `r_${l}`, 'ev1', l);
    const dep = (id: string, l: string, status: string, refunded = 0) => db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, refunded_amount, currency, source, ref_id, paid_at, created_at, updated_at) VALUES (?, ?, ?, 'deposit', ?, 500000, ?, 'usd', 'live', 'ev1', ?, ?, ?)")
      .run(id, `r_${l}`, l, status, refunded, status === 'pending' ? null : NOW, NOW, NOW);
    dep('p1', 'l1', 'paid');
    dep('p2', 'l2', 'refunded', 500000);
    dep('p3', 'l3', 'pending');
    const list = await listEvents(rt);
    const e = list.find((x) => x.id === 'ev1') as unknown as { deposits: number; revenue: number };
    expect(e.deposits).toBe(2);
    expect(e.revenue).toBe(500000);
    const rep = await eventReport(rt, 'ev1');
    expect(rep!.report.deposits).toBe(2);
    expect(rep!.report.revenueMinor).toBe(500000);
    expect(rep!.buyers.map((b) => b.refunded).sort()).toEqual([false, true]);
  });
});
