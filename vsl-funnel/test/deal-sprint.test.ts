import { beforeEach, describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { auditEmail, auditFields } from '../src/content/copy-rules';
import {
  DEAL_SPRINT_COPY, DEAL_SPRINT_DELIVERABLES, INTAKE_FIELDS, cleanIntake, dealSprintBoard, dealSprintConfig, draftEngagement, hasFastBonus, payPlanOf, portalHtml,
  samplePortal, saveIntake, sprintDay, updateDealSprint, updateDeliverable,
} from '../src/webinar/deal-sprint';
import { type SprintEmailKind, dealSprintEmail, dueSprintEmails, processDealSprintEmails } from '../src/webinar/deal-sprint-emails';
import { ladderReport } from '../src/admin/deal-sprint';
import { createContract, getContract, termsHtml } from '../src/sales/contracts';
import { holderCardHtml, passConfig } from '../src/webinar/pass';

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

const SETTINGS = { WEBINAR_PASS: 'upsell', STRIPE_SECRET_KEY: 'sk_test_x', WEBINAR_OFFER_NAME: 'First Deal Sprint', DEAL_SPRINT_KICKOFF_URL: 'https://calendly.com/gl/kickoff', SALES_TIMEZONE: 'Australia/Sydney' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = SETTINGS) =>
  ({ env: { DB: d1(db) }, settings, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const DAY = 86_400_000;
function seed(db: DatabaseSync, paidAt = Date.now()) {
  const now = Date.now();
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status, revenue_band) VALUES ('l1', 'R1', ?, ?, 'Dana', 'Lee', 'dana@example.com', 'partial', '3m-10m')").run(now, now);
  db.prepare("INSERT INTO webinar_sessions (id, starts_at, mode, status, auto, created_at) VALUES ('s1', ?, 'evergreen', 'scheduled', 1, ?)").run(now - DAY, now);
  db.prepare("INSERT INTO webinar_registrations (id, token, session_id, lead_id, created_at, joined_at) VALUES ('r1', 'tokentokentoken12345', 's1', 'l1', ?, ?)").run(now - 2 * DAY, now - DAY);
  db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, credit_amount, paid_at, created_at, updated_at) VALUES ('wp1', 'r1', 'l1', 'offer', 'First Deal Sprint', 'paid', 300000, 'usd', 300000, ?, ?, ?)").run(paidAt, paidAt, paidAt);
}
const emails = (db: DatabaseSync) => db.prepare("SELECT step, template, status FROM emails WHERE sequence = 'deal_sprint' ORDER BY step").all() as { step: number; template: string; status: string }[];

describe('Sprint copy', () => {
  it('every string on the Sprint page passes the house copy rules', () => {
    const strings = { copy: DEAL_SPRINT_COPY, deliverables: DEAL_SPRINT_DELIVERABLES.map((d) => ({ title: d.title, body: d.body })), intake: INTAKE_FIELDS.map((f) => ({ label: f.label, options: f.options })) };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/[!—]/);
    expect(all.toLowerCase()).not.toMatch(/\bfree\b/);
    expect(DEAL_SPRINT_COPY.after).toContain('owner outreach, negotiation, lender introductions and the letter of intent');
  });

  it('every Sprint email passes the email rules, names seller rollover with the funding, and promises no result', () => {
    const kinds: SprintEmailKind[] = ['welcome', 'intake', 'ready', 'prep', 'proposal1', 'proposal2', 'proposal3'];
    for (const links of [true, false]) for (const kind of kinds) {
      const m = dealSprintEmail(kind, {
        name: 'Dana', product: 'First Deal Sprint', portal: 'https://live.test/sprint/tok', kickoffUrl: links ? 'https://calendly.com/k' : null, planUrl: links ? 'https://calendly.com/p' : null,
        planBooked: !links, credit: links ? '$3,000' : null, signLink: links ? 'https://apply.test/sign/abc' : null,
        deliverable: { title: 'Your buy box', notes: 'Commercial HVAC, $2M to $5M revenue, within 60 miles.', link: links ? 'https://docs.example.com/x' : null },
      });
      expect(auditEmail({ subject: m.subject, preheader: m.preheader, body: m.paras }), `${kind} ${links}`).toEqual([]);
      const text = [m.subject, m.preheader, ...m.paras].join(' ');
      expect(text).not.toMatch(/[!—]/);
      expect(text.toLowerCase()).not.toMatch(/\bfree\b/);
      if (/commercial debt/.test(text)) expect(text).toContain('seller rollover');
    }
    expect(dealSprintEmail('proposal2', { name: 'x', product: 'p', portal: 'u', kickoffUrl: null, planUrl: null, planBooked: false, credit: null, signLink: null }).paras.join(' ')).toContain('not a promise of a deal');
  });
});

describe('Sprint page', () => {
  it('shows Day 1 to Day 7, the intake form, the guarantee and the bonus, and escapes what the team typed', () => {
    const rt = makeRt(freshDb());
    const v = samplePortal(rt);
    v.deliverables[0].notes = '<script>alert(1)</script>';
    const html = portalHtml(v);
    for (let d = 1; d <= 7; d++) expect(html).toContain(`>Day ${d}<`);
    expect(html).toContain('method="post"');
    expect(html).toContain('the full fee is refunded');
    expect(html).toContain('Josh reviews your Deal Plan personally');
    expect(html).not.toContain('<script>alert');
    expect(portalHtml({ ...v, fastBonus: false })).not.toContain('Your fast-action bonus');
  });

  it('cleans the intake: https statements link only, known timeline, revenue and industry required', () => {
    const a = cleanIntake({ revenue: ' $4M ', industry: 'HVAC', financials_url: 'javascript:alert(1)', timeline: 'tomorrow', notes: 'x'.repeat(5000) });
    expect(a.complete).toBe(true);
    expect(a.data).toMatchObject({ revenue: '$4M', financials_url: null, timeline: null });
    expect(a.data.notes!.length).toBe(2000);
    expect(cleanIntake({ revenue: '$4M' }).complete).toBe(false);
    expect(cleanIntake({ revenue: '$4M', industry: 'x', financials_url: 'https://drive.google.com/x', timeline: 'Within 6 months' }).data).toMatchObject({ financials_url: 'https://drive.google.com/x', timeline: 'Within 6 months' });
  });

  it('day of 7, the fast-action bonus and the payment plan are read defensively', () => {
    const t = Date.parse('2026-10-01T10:00:00Z');
    expect(sprintDay(t, t)).toBe(1);
    expect(sprintDay(t, t + 6.5 * DAY)).toBe(7);
    expect(sprintDay(t, t - DAY)).toBe(1);
    expect(hasFastBonus({})).toBe(false);
    expect(hasFastBonus({ fast_bonus: 1 })).toBe(true);
    expect(payPlanOf({ id: 'x' })).toBeNull();
    expect(payPlanOf({ payment_plan: 'plan' })).toBe('plan');
    expect(payPlanOf({ payment_plan: null })).toBe('full');
  });

  it('the holder card links to the Sprint page', () => {
    const rt = makeRt(freshDb());
    expect(holderCardHtml(rt, passConfig(SETTINGS), { product: 'First Deal Sprint' }, 'tok123')).toContain('/sprint/tok123');
  });

  it('uses the offer session link for the Deal Plan session when no Sprint link is set', () => {
    expect(dealSprintConfig({ WEBINAR_OFFER_SESSION_URL: 'https://calendly.com/a' }).planUrl).toBe('https://calendly.com/a');
    expect(dealSprintConfig({ WEBINAR_OFFER_SESSION_URL: 'https://calendly.com/a', DEAL_SPRINT_PLAN_URL: 'https://calendly.com/b' }).planUrl).toBe('https://calendly.com/b');
    expect(dealSprintConfig({ DEAL_SPRINT_KICKOFF_URL: 'http://insecure' }).kickoffUrl).toBeNull();
  });
});

describe('Sprint board', () => {
  let db: DatabaseSync;
  let rt: Runtime;
  beforeEach(() => { db = freshDb(); seed(db); rt = makeRt(db); });

  it('lists the buyer with their day, intake and deliverables, and records calls and outcome', async () => {
    await saveIntake(rt, { id: 'wp1', lead_id: 'l1' }, cleanIntake({ revenue: '$4M', industry: 'HVAC' }).data);
    expect(await updateDealSprint(rt, 'wp1', { kickoff_held: true, outcome: 'proposal_sent', engagement_fee: '50000' })).toMatchObject({ ok: true });
    const b = await dealSprintBoard(rt);
    expect(b.sprints).toHaveLength(1);
    const s = b.sprints[0];
    expect(s).toMatchObject({ name: 'Dana Lee', day: 1, fast_bonus: false, outcome: 'proposal_sent', engagement_fee: 50000 });
    expect(s.kickoff_booked_at).toBeTruthy(); // held implies booked
    expect(s.proposal_sent_at).toBeTruthy();
    expect(s.intake).toMatchObject({ revenue: '$4M' });
    expect(s.deliverables.map((d) => d.key)).not.toContain('josh_review');
    expect(await updateDealSprint(rt, 'nope', {})).toMatchObject({ ok: false });
  });

  it('shows the fast-action bonus when the pass has it', async () => {
    db.exec('ALTER TABLE webinar_passes ADD COLUMN fast_bonus INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE webinar_passes SET fast_bonus = 1 WHERE id = 'wp1'");
    const s = (await dealSprintBoard(rt)).sprints[0];
    expect(s.fast_bonus).toBe(true);
    expect(s.deliverables.map((d) => d.key)).toContain('josh_review');
  });

  it('marking a deliverable ready emails the buyer once, and only https links are kept', async () => {
    expect(await updateDeliverable(rt, 'wp1', 'buy_box', { status: 'ready', link: 'javascript:x' })).toMatchObject({ ok: false });
    expect(await updateDeliverable(rt, 'wp1', 'buy_box', { status: 'in_progress', notes: 'Drafting' })).toMatchObject({ ok: true, emailed: false });
    expect(await updateDeliverable(rt, 'wp1', 'buy_box', { status: 'ready', link: 'https://docs.example.com/bb', notes: 'HVAC, $2M to $5M' })).toMatchObject({ ok: true, emailed: true });
    expect(await updateDeliverable(rt, 'wp1', 'buy_box', { status: 'waiting' })).toMatchObject({ ok: true });
    expect(await updateDeliverable(rt, 'wp1', 'buy_box', { status: 'ready' })).toMatchObject({ ok: true, emailed: false });
    expect(emails(db)).toEqual([{ step: 101, template: 'deal_sprint_ready_buy_box', status: 'simulated' }]);
    expect(await updateDeliverable(rt, 'wp1', 'nope', { status: 'ready' })).toMatchObject({ ok: false });
  });

  it('drafts the engagement agreement once, with the auto-quote and the Sprint credit, and signing closes the loop', async () => {
    const a = await draftEngagement(rt, 'wp1');
    expect(a).toMatchObject({ ok: true, created: true });
    const again = await draftEngagement(rt, 'wp1');
    expect(again).toMatchObject({ ok: true, created: false });
    const k = (await getContract(rt, (a as { contractId: string }).contractId))!;
    expect(k).toMatchObject({ fee: 50_000, credit_amount: 3000, credit_label: 'First Deal Sprint credit', credit_pass_id: 'wp1' }); // $3M–$10M band
    const html = termsHtml(rt, k);
    expect(html).toContain('First Deal Sprint credit: <strong>−$3,000 USD</strong>');
    expect(html).toContain('Net amount due: <strong>$47,000 USD</strong>');
    const { dealSprintSigned } = await import('../src/webinar/deal-sprint');
    await dealSprintSigned(rt, k);
    expect((await dealSprintBoard(rt)).sprints[0]).toMatchObject({ outcome: 'signed', engagement_fee: 50_000 });
  });

  it('no credit once refunded or for someone who never bought', async () => {
    db.exec("UPDATE webinar_passes SET status = 'refunded', credit_amount = 0 WHERE id = 'wp1'");
    const lead = db.prepare("SELECT * FROM leads WHERE id = 'l1'").get() as never;
    const k = (await createContract(rt, lead, {}))!;
    expect(k.credit_amount).toBe(0);
    expect(termsHtml(rt, k)).not.toContain('credit');
  });
});

describe('Sprint emails', () => {
  it('schedules welcome, intake reminder, Day 5 prep and the proposal follow-ups at the right times', () => {
    const paid = Date.parse('2026-10-01T00:00:00Z');
    const kinds = (now: number, o: Partial<{ hasIntake: boolean; plan_held_at: number | null; outcome: 'proposal_sent' | 'signed' | null; proposal_sent_at: number | null }> = {}) =>
      dueSprintEmails({ paidAt: paid, now, hasIntake: o.hasIntake ?? false, sprint: { plan_held_at: o.plan_held_at ?? null, outcome: o.outcome ?? null, proposal_sent_at: o.proposal_sent_at ?? null } }).map((d) => d.kind);
    expect(kinds(paid + 60_000)).toEqual(['welcome']);
    expect(kinds(paid + 25 * 3_600_000)).toEqual(['welcome', 'intake']);
    expect(kinds(paid + 25 * 3_600_000, { hasIntake: true })).toEqual(['welcome']);
    expect(kinds(paid + 4.2 * DAY, { hasIntake: true })).toEqual(['prep']);
    expect(kinds(paid + 4.2 * DAY, { hasIntake: true, plan_held_at: paid })).toEqual([]);
    const sent = paid + 7 * DAY;
    expect(kinds(sent + 1.1 * DAY, { hasIntake: true, plan_held_at: paid, outcome: 'proposal_sent', proposal_sent_at: sent })).toEqual(['proposal1']);
    expect(kinds(sent + 3.1 * DAY, { hasIntake: true, plan_held_at: paid, outcome: 'proposal_sent', proposal_sent_at: sent })).toEqual(['proposal1', 'proposal2']);
    expect(kinds(sent + 7.1 * DAY, { hasIntake: true, plan_held_at: paid, outcome: 'proposal_sent', proposal_sent_at: sent })).toEqual(['proposal3']);
    // Signed (or not continuing): the follow-ups stop.
    expect(kinds(sent + 3.1 * DAY, { hasIntake: true, plan_held_at: paid, outcome: 'signed', proposal_sent_at: sent })).toEqual([]);
  });

  it('the cron sends each email once, and follow-ups only after "proposal sent"', async () => {
    const db = freshDb();
    seed(db, Date.now() - 25 * 3_600_000);
    const rt = makeRt(db);
    expect(await processDealSprintEmails(rt)).toEqual({ sent: 2 });
    expect(await processDealSprintEmails(rt)).toEqual({ sent: 0 });
    expect(emails(db).map((e) => e.template)).toEqual(['deal_sprint_welcome', 'deal_sprint_intake']);
    await updateDealSprint(rt, 'wp1', { outcome: 'proposal_sent' });
    db.exec(`UPDATE deal_sprints SET proposal_sent_at = ${Date.now() - 1.5 * DAY}`);
    expect(await processDealSprintEmails(rt)).toEqual({ sent: 1 });
    expect(emails(db).map((e) => e.template)).toContain('deal_sprint_proposal1');
  });
});

describe('ladder report', () => {
  it('counts each step with revenue per registrant and per ticket', async () => {
    const db = freshDb();
    seed(db);
    const rt = makeRt(db);
    const now = Date.now();
    db.prepare("INSERT INTO webinar_passes (id, reg_id, lead_id, kind, product, status, amount, currency, paid_at, created_at, updated_at) VALUES ('wp0', 'r1', 'l1', 'seat', 'Masterclass seat', 'paid', 10000, 'usd', ?, ?, ?)").run(now, now, now);
    db.prepare("INSERT INTO events (id, ts, name, lead_id, source) VALUES ('e1', ?, 'webinar_offer_unlocked', 'l1', 'client')").run(now);
    db.prepare("INSERT INTO contracts (id, token, lead_id, status, title, fee, currency, created_at, signed_at, credit_amount) VALUES ('k1', 't', 'l1', 'signed', 'Advisory Agreement', 50000, 'USD', ?, ?, 3000)").run(now, now);
    await updateDealSprint(rt, 'wp1', { plan_held: true });
    const r = await ladderReport(rt, { from: now - 3 * DAY, to: now + DAY });
    expect(Object.fromEntries(r.steps.map((s) => [s.key, s.n]))).toEqual({ registered: 1, tickets: 1, watched: 1, unlocked: 1, sprints: 1, plan_held: 1, engagements: 1 });
    expect(r.revenue).toEqual({ tickets: 100, sprints: 3000, engagements: 47000, total: 50100 });
    expect(r.perRegistrant).toBe(50100);
    expect(r.perTicket).toBe(50100);
    expect(r.sprintSplit).toBeNull(); // no payment-plan column yet
  });
});
