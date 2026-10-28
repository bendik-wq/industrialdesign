import { beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import { processEmailQueue } from '../src/integrations/email';
import { processSmsQueue } from '../src/integrations/sms';
import { SEQUENCES } from '../src/integrations/sequences';
import { TEMPLATES, type TemplateCtx } from '../src/integrations/templates';
import { getLead } from '../src/funnel/leads';
import { conversionValue, metaEventName } from '../src/tracking/forward';
import { GA4_EVENTS } from '../src/tracking/catalog';
import { type Registration, type Session, scheduleEmails } from '../src/webinar/webinar';
import { checkoutForm, handleStripeEvent, passConfig, passCopy, passGate, ticketCopy, ticketFor, ticketUnpaid } from '../src/webinar/pass';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in webinar-pass.test.ts) ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes) } }; },
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

const TICKET = { WEBINAR_PASS: 'required', WEBINAR_SEAT_PRICE: '100', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_test', SALES_TIMEZONE: 'Australia/Sydney', WEBINAR_DURATION_MIN: '60', WEBINAR_REPLAY_HOURS: '48', SMS_ENABLED: '' };
const FREE = { ...TICKET, WEBINAR_SEAT_PRICE: '' };

const makeRt = (db: DatabaseSync, settings: Record<string, string> = TICKET) =>
  ({ env: { DB: d1(db) }, settings, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const START = Date.now() + 3 * 86_400_000;
const session: Session = { id: 's1', starts_at: START, title: null, mode: 'evergreen', join_url: null, video_src: null, status: 'scheduled', auto: 1 };
const reg = (required: number): Registration => ({
  id: 'r1', token: 'tokentokentoken12345', session_id: 's1', lead_id: 'l1', seq: 0, new_lead: 1, created_at: Date.now(),
  joined_at: null, last_seen_at: null, watch_seconds: 0, max_position: 0, cta_at: null, replay_at: null, replay_seconds: 0, pass_required: required,
});

function seed(db: DatabaseSync, required = 1) {
  const now = Date.now();
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, status, revenue_band) VALUES ('l1', 'R1', ?, ?, 'Dana', 'dana@example.com', 'partial', '3m-10m')").run(now, now);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(START, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, pass_required) VALUES ('r1', 'tokentokentoken12345', 's1', 'l1', ?, ?)").run(now, required);
}
const rows = (db: DatabaseSync, sequence: string, status = 'pending') =>
  (db.prepare('SELECT template FROM emails WHERE lead_id = ? AND sequence = ? AND status = ?').all('l1', sequence, status) as { template: string }[]).map((r) => r.template);
const paySeat = (rt: Runtime, db: DatabaseSync) => {
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, stripe_session_id, created_at, updated_at) VALUES ('wp1', 'r1', 'l1', 'seat', 'pending', 10000, 'usd', 'cs_t', ?, ?)").run(Date.now(), Date.now());
  return handleStripeEvent(rt, { type: 'checkout.session.completed', data: { object: { id: 'cs_t', payment_status: 'paid', payment_intent: 'pi_t', amount_total: 10000, currency: 'usd', client_reference_id: 'r1', metadata: { pass_id: 'wp1', reg_id: 'r1', kind: 'seat' } } } });
};

describe('paid ticket: emails and texts wait for payment', () => {
  let db: DatabaseSync;
  beforeEach(() => { db = freshDb(); });

  it('an unpaid ticket gets only the finish-your-ticket emails, no confirmation, reminders or pre-webinar run', async () => {
    seed(db);
    const rt = makeRt(db);
    const lead = (await getLead(rt.env, 'l1'))!;
    expect(await scheduleEmails(rt, lead, session, reg(1))).toBe(false);
    expect(rows(db, 'ticket')).toEqual(['w_ticket_1', 'w_ticket_2', 'w_ticket_3']);
    expect(rows(db, 'webinar')).toEqual([]);
    expect(rows(db, 'prewebinar')).toEqual([]);
    expect(await ticketUnpaid(rt, (await getLead(rt.env, 'l1'))!)).toBe(true);
  });

  it('paying the ticket stops the finish-your-ticket emails and starts the confirmation, reminders and pre-webinar run', async () => {
    seed(db);
    const rt = makeRt(db);
    await scheduleEmails(rt, (await getLead(rt.env, 'l1'))!, session, reg(1));
    const r = await paySeat(rt, db);
    expect(r).toMatchObject({ paid: 'wp1', duplicate: false });
    expect(rows(db, 'ticket')).toEqual([]);
    expect(rows(db, 'ticket', 'cancelled')).toHaveLength(3);
    expect(rows(db, 'webinar')).toContain('w_confirm');
    expect(rows(db, 'webinar')).toContain('w_24h');
    expect(rows(db, 'prewebinar').length).toBeGreaterThan(0);
    // The confirmation goes out from the paid time.
    const confirm = db.prepare("SELECT send_at FROM emails WHERE sequence = 'webinar' AND template = 'w_confirm'").get() as { send_at: number };
    expect(Math.abs(confirm.send_at - Date.now())).toBeLessThan(5_000);
    expect(await passGate(rt, reg(1))).toBe(false);
    // The credit for the First Deal Sprint is read from paid seat rows.
    expect(db.prepare("SELECT amount, status FROM webinar_passes WHERE lead_id = 'l1' AND kind = 'seat'").get()).toEqual({ amount: 10000, status: 'paid' });
  });

  it('at send time: webinar and pre-webinar emails are skipped while unpaid, and finish-your-ticket emails once paid', async () => {
    seed(db);
    const rt = makeRt(db);
    await scheduleEmails(rt, (await getLead(rt.env, 'l1'))!, session, reg(1));
    // A stray pre-webinar email (queued before a race) and a finish-your-ticket email, both due now.
    db.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES ('m_pre', 'l1', 'prewebinar', 0, ?, 'dana@example.com', ?, 'pending', ?)").run(SEQUENCES.prewebinar.steps[0].template, Date.now() - 1000, Date.now());
    await processEmailQueue(rt);
    expect(db.prepare("SELECT status, error FROM emails WHERE id = 'm_pre'").get()).toEqual({ status: 'skipped', error: 'ticket not paid' });

    await paySeat(rt, db);
    db.prepare("UPDATE emails SET status = 'pending', send_at = ? WHERE sequence = 'ticket' AND template = 'w_ticket_1'").run(Date.now() - 1000);
    db.prepare("UPDATE emails SET send_at = ? WHERE sequence != 'ticket'").run(Date.now() + 86_400_000);
    await processEmailQueue(rt);
    expect(db.prepare("SELECT status, error FROM emails WHERE sequence = 'ticket' AND template = 'w_ticket_1'").get()).toEqual({ status: 'skipped', error: 'ticket paid' });
  });

  it('reminder texts: none while unpaid (and skipped at send time), the webinar texts start once paid', async () => {
    seed(db);
    db.prepare("UPDATE leads SET phone = '+61412345678', sms_consent_at = ? WHERE id = 'l1'").run(Date.now());
    const rt = makeRt(db);
    await scheduleEmails(rt, (await getLead(rt.env, 'l1'))!, session, reg(1));
    const texts = (status: string) => (db.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE lead_id = 'l1' AND sequence = 'webinar' AND status = ?").get(status) as { n: number }).n;
    expect(texts('pending')).toBe(0);
    db.prepare("INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, send_at, status, created_at) VALUES ('sm1', 'l1', 'out', 'webinar', 2, 'webinar:2', '+61412345678', ?, 'pending', ?)").run(Date.now() - 1000, Date.now());
    await processSmsQueue(rt);
    expect(db.prepare("SELECT status, error FROM sms_messages WHERE id = 'sm1'").get()).toEqual({ status: 'skipped', error: 'ticket not paid' });
    await paySeat(rt, db);
    expect(texts('pending')).toBeGreaterThan(0);
  });

  it('a full refund closes the room again and stops the session emails', async () => {
    seed(db);
    const rt = makeRt(db);
    await scheduleEmails(rt, (await getLead(rt.env, 'l1'))!, session, reg(1));
    await paySeat(rt, db);
    expect(await passGate(rt, reg(1))).toBe(false);
    await handleStripeEvent(rt, { type: 'charge.refunded', data: { object: { payment_intent: 'pi_t', amount_refunded: 10000, refunded: true, metadata: { pass_id: 'wp1' } } } });
    expect(await passGate(rt, reg(1))).toBe(true);
    expect(rows(db, 'webinar')).toEqual([]);
    expect(rows(db, 'prewebinar')).toEqual([]);
    expect(await ticketUnpaid(rt, (await getLead(rt.env, 'l1'))!)).toBe(true);
  });

  it('free mode (no ticket price) schedules exactly as before', async () => {
    seed(db, 0);
    const rt = makeRt(db, FREE);
    expect(await scheduleEmails(rt, (await getLead(rt.env, 'l1'))!, session, reg(0))).toBe(true);
    expect(rows(db, 'ticket')).toEqual([]);
    expect(rows(db, 'webinar')).toContain('w_confirm');
    expect(rows(db, 'prewebinar').length).toBeGreaterThan(0);
    expect(ticketFor(FREE)).toBeNull();
  });
});

describe('paid ticket: copy, checkout and tracking', () => {
  const t = ticketFor(TICKET)!;

  it('the ticket is $100 in required mode with a seat price, and absent otherwise', () => {
    expect(t.label).toBe('$100');
    expect(t.copy.button).toBe('Get my $100 ticket');
    expect(t.copy.credit).toMatch(/\$100 comes off the First Deal Sprint/);
    expect(t.copy.guarantee).toBe('Watch it. If you don’t think it was worth far more than $100, reply within 7 days for a full refund.');
    expect(ticketFor({ ...TICKET, WEBINAR_PASS: 'upsell' })).toBeNull();
    expect(ticketFor({ ...TICKET, STRIPE_SECRET_KEY: '' })).toBeNull();
  });

  it('every ticket string passes the house copy rules', () => {
    const cfg = passConfig(TICKET);
    const p = passCopy(cfg);
    const strings = { ticket: ticketCopy({ label: '$100', replayHours: 48, durationMin: 60 }), seat: [p.seatEyebrow, p.seatHeading, p.seatBody, p.seatButton, p.seatActive] };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/[!—]/);
    expect(all.toLowerCase()).not.toMatch(/\bfree\b/);
    expect(all).toMatch(/seller rollover/);
    expect(`${JSON.stringify(strings.ticket)} ${strings.seat.join(' ')}`.toLowerCase()).not.toMatch(/\bseats?\b/); // the user-facing word is "ticket"
  });

  it('the finish-your-ticket emails pass the copy rules, name seller rollover and link straight to checkout', () => {
    const link = (p: string) => p;
    const ctx = {
      lead: {}, name: 'Dana', siteName: 'G&L', link, bookingUrl: null, whatsappUrl: null, callTime: null, joinUrl: null, rescheduleUrl: null, ask: 'apply', webinarUrl: 'https://live.test',
      webinar: { title: 'The Acquisition Masterclass', when: 'Tuesday 3 November, 7:00 pm AEDT', room: 'https://live.test/room/x', replay: 'https://live.test/replay/x', ics: null, google: null, replayHours: 48, durationMin: 60, ticket: 'https://live.test/ticket/x', ticketPrice: '$100' },
    } as unknown as TemplateCtx;
    for (const s of SEQUENCES.ticket.steps) {
      const e = TEMPLATES[s.template](ctx);
      expect(auditEmail({ subject: e.subject, preheader: e.preheader, body: e.body, ps: e.ps }), s.template).toEqual([]);
      expect(e.cta?.href, s.template).toBe('https://live.test/ticket/x');
      expect(JSON.stringify(e)).toMatch(/\$100/);
      expect(JSON.stringify(e)).not.toMatch(/[!—]/);
    }
    expect(JSON.stringify(SEQUENCES.ticket.steps.map((s) => TEMPLATES[s.template](ctx)))).toMatch(/seller rollover/);
    expect(SEQUENCES.ticket.steps.map((s) => s.offsetMs)).toEqual([3_600_000, 86_400_000, 3 * 86_400_000]);
  });

  it('the Stripe line item says ticket, with the guarantee and the credit', () => {
    const f = checkoutForm(passConfig(TICKET), { kind: 'seat', passId: 'wp1', reg: { id: 'r1', token: 'tok', lead_id: 'l1' }, email: 'dana@example.com', back: 'https://live.test/registered/tok', expiresAt: 1_800_000_000_000 });
    expect(f['line_items[0][price_data][unit_amount]']).toBe('10000');
    expect(f['line_items[0][price_data][product_data][name]']).toMatch(/^Masterclass ticket: /);
    expect(f['line_items[0][price_data][product_data][description]']).toMatch(/First Deal Sprint.*7 days/);
    expect(f['metadata[kind]']).toBe('seat');
  });

  it('a ticket purchase goes to Meta and GA4 as a Purchase with the ticket price as its value', () => {
    expect(metaEventName('webinar_seat_purchased', { value: 100 })).toBe('Purchase');
    expect(GA4_EVENTS.webinar_seat_purchased).toBe('purchase');
    expect(conversionValue('webinar_seat_purchased', { value: 100, currency: 'USD' }, null)).toBe(100);
    // Revenue-band events keep their own mapping.
    expect(metaEventName('webinar_registered', {})).toBe('CompleteRegistration');
  });
});
