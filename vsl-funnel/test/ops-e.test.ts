import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy, auditEmail, auditFields } from '../src/content/copy-rules';
import { type ClientSignals, CHECKLISTS, FLAG_LABELS, cadenceDays, checklistFor, listClientIds, nextCheckinAt, rebuildClients, replyLatencyHours, scoreClient } from '../src/clients/health';
import { CHECKIN_KIND, checkinIssues, proposeCheckin, proposeDueCheckins, sendCheckin, templateCheckin } from '../src/clients/checkins';
import { decideAction } from '../src/ops/actions';
import { setClaudeTransport } from '../src/ops/claude';
import { escalationTopics, draftForThread, htmlToText, importRoomQuestions, ingestEmail, newestPart, sendDraft } from '../src/support/inbox';
import { chunkMarkdown, retrieve, staticPassages } from '../src/support/kb';
import { handleMcp, decodeHeaderValue } from '../src/mcp/server';
import { TOOLS, rangeOf } from '../src/mcp/tools';
import { HOOK_EVENTS, MAX_ATTEMPTS, RETRY_DELAYS_MS, deliverDue, recordEvent, scanEvents, signPayload, validHookUrl, verifyPayload } from '../src/integrations/webhooks-out';
import { zapierAddNote, zapierCreateLead } from '../src/integrations/hooks-in';
import { SETTINGS } from '../src/settings';
import { localClock, maybeDailyClients } from '../src/ops/e-cron';

// ───────────── A real SQLite database shaped like D1, with every migration applied (as in deal-sprint.test.ts) ─────────────
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
const BASE = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'Team <team@mail.test>', SITE_NAME: 'G&L M&A Advisory', SALES_TIMEZONE: 'UTC' };
const makeRt = (db: DatabaseSync, settings: Record<string, string> = BASE) => ({ env: { DB: d1(db) }, settings, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
function lead(db: DatabaseSync, id: string, email: string, extra: Record<string, unknown> = {}) {
  db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, last_name, email, status) VALUES (?, ?, ?, ?, ?, 'Lee', ?, 'won')").run(id, `R${id.toUpperCase().slice(-5).padStart(5, 'X')}`, NOW - 40 * DAY, NOW, 'Dana', email);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE leads SET ${k} = ? WHERE id = ?`).run(v as number, id);
}
function pass(db: DatabaseSync, id: string, leadId: string, kind: string, paidAt: number, status = 'paid') {
  db.prepare('INSERT INTO webinar_passes (id, reg_id, lead_id, kind, status, amount, currency, paid_at, refunded_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, `reg_${id}`, leadId, kind, status, kind === 'offer' ? 300000 : 500000, 'usd', paidAt, status === 'refunded' ? paidAt + DAY : null, paidAt, paidAt);
}
const sig = (o: Partial<ClientSignals> = {}): ClientSignals => ({
  type: 'engagement', sinceAt: NOW - 10 * DAY, refundedAt: null, sprint: null, deposit: null, engagement: { signedAt: NOW - 10 * DAY, paidAt: NOW - 9 * DAY },
  agreementSentAt: NOW - 12 * DAY, nextPaymentAt: null, loiSignedAt: null, checklist: { kickoff_held: NOW - 8 * DAY, financials: NOW - 6 * DAY },
  touchpoints: [{ kind: 'session_attended', at: NOW - 3 * DAY }], inboundAts: [NOW - 2 * DAY], outboundAts: [NOW - 2.5 * DAY], openEscalations: [], ...o,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'resend_1' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); setClaudeTransport(null); });

// ───────────── Client health ─────────────
describe('client health scoring', () => {
  it('a client doing everything is healthy, with positive reasons and no flags', () => {
    const h = scoreClient(sig(), NOW);
    expect(h.band).toBe('healthy');
    expect(h.score).toBe(100);
    expect(h.flags).toEqual([]);
    expect(h.reasons.map((r) => r.label)).toContain('Attended a weekly session in the last 14 days');
  });

  it('a Sprint with no intake, no kickoff and late deliverables is at risk, every deduction explained with its source', () => {
    const h = scoreClient(sig({
      type: 'sprint', engagement: null, checklist: {}, touchpoints: [], inboundAts: [], outboundAts: [], sinceAt: NOW - 5.5 * DAY,
      sprint: { paidAt: NOW - 5.5 * DAY, intakeAt: null, financialsUrl: null, kickoffBookedAt: null, kickoffHeldAt: null, planHeldAt: null, proposalSentAt: null, deliverables: [{ key: 'capacity', status: 'ready', readyAt: NOW - 4 * DAY }] },
    }), NOW);
    expect(h.flags).toEqual(expect.arrayContaining(['intake_missing', 'deliverable_late']));
    const labels = h.reasons.map((r) => r.label).join(' | ');
    expect(labels).toContain('Sprint intake not received (day 6 of 7)');
    expect(labels).toContain('3 deliverables past their day: Your buy box, A first shortlist, Deal-structure memo');
    expect(h.reasons.every((r) => ['dealsprint', 'clients', 'support', 'contracts', 'sales'].includes(r.source))).toBe(true);
    expect(h.score).toBe(100 - 15 - 10 - 24);
    expect(h.band).toBe('watch');
  });

  it('refunded Sprint buyers are churned; signed but unpaid engagements, missed sessions and slow replies are flagged', () => {
    expect(scoreClient(sig({ type: 'sprint', engagement: null, refundedAt: NOW - DAY }), NOW)).toMatchObject({ band: 'churned', score: 0, flags: ['refunded'] });
    const h = scoreClient(sig({
      engagement: { signedAt: NOW - 20 * DAY, paidAt: null }, checklist: {},
      touchpoints: [{ kind: 'session_missed', at: NOW - 3 * DAY }, { kind: 'session_missed', at: NOW - 10 * DAY }, { kind: 'session_missed', at: NOW - 17 * DAY }],
      outboundAts: [NOW - 20 * DAY, NOW - 9 * DAY], inboundAts: [NOW - 15 * DAY],
    }), NOW);
    expect(h.flags).toEqual(expect.arrayContaining(['payment_overdue', 'guarantee_conditions', 'sessions_missed', 'slow_replies', 'awaiting_reply', 'churn_risk']));
    expect(h.band).toBe('at_risk');
    expect(h.reasons.some((r) => r.label === 'Missed 3 weekly sessions in total (the guarantee allows two)')).toBe(true);
  });

  it('reply latency is the median gap between a team message and the next reply', () => {
    expect(replyLatencyHours([0, 100 * 3_600_000], [10 * 3_600_000, 120 * 3_600_000])).toBe(15);
    expect(replyLatencyHours([], [1])).toBeNull();
    expect(replyLatencyHours([5], [1])).toBeNull();
  });

  it('cadence tightens with risk; the first check-in is a day after joining', () => {
    expect(cadenceDays('engagement', 'healthy')).toBe(14);
    expect(cadenceDays('engagement', 'at_risk')).toBe(3);
    expect(cadenceDays('sprint', 'healthy')).toBe(3);
    expect(cadenceDays('sprint', 'churned')).toBeNull();
    expect(nextCheckinAt('deposit', 'healthy', NOW, null)).toBe(NOW + DAY);
    expect(nextCheckinAt('deposit', 'healthy', NOW, NOW + 2 * DAY)).toBe(NOW + 9 * DAY);
  });

  it('checklists mix derived items (from the data) and hand-ticked ones', () => {
    const c = checklistFor(sig());
    expect(c.find((i) => i.key === 'agreement_signed')).toMatchObject({ auto: true });
    expect(c.find((i) => i.key === 'kickoff_held')).toMatchObject({ manual: true, done_at: NOW - 8 * DAY });
    expect(c.find((i) => i.key === 'buy_box')?.done_at).toBeNull();
    expect(Object.keys(CHECKLISTS)).toEqual(['sprint', 'deposit', 'engagement']);
  });

  it('finds clients from Sprints, deposits and signed agreements, keeping the furthest step, and rebuilds their rows', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    lead(db, 'l1', 'sprint@example.com'); pass(db, 'p1', 'l1', 'offer', NOW - 4 * DAY);
    lead(db, 'l2', 'deposit@example.com'); pass(db, 'p2', 'l2', 'deposit', NOW - 20 * DAY);
    lead(db, 'l3', 'eng@example.com'); pass(db, 'p3', 'l3', 'offer', NOW - 30 * DAY);
    db.prepare("INSERT INTO contracts (id, token, lead_id, status, title, fee, created_at, signed_at, sent_at) VALUES ('k3', 'tok3', 'l3', 'signed', 'Engagement', 50000, ?, ?, ?)").run(NOW - 22 * DAY, NOW - 21 * DAY, NOW - 22 * DAY);
    db.prepare("INSERT INTO contracts (id, token, lead_id, status, title, fee, created_at, signed_at, is_test) VALUES ('kt', 'tokt', 'l4', 'signed', 'Test', 1, ?, ?, 1)").run(NOW, NOW);
    lead(db, 'l5', 'refund@example.com'); pass(db, 'p5', 'l5', 'offer', NOW - 10 * DAY, 'refunded');
    const ids = await listClientIds(rt);
    expect(Object.fromEntries(ids.map((i) => [i.lead_id, i.type]))).toEqual({ l1: 'sprint', l2: 'deposit', l3: 'engagement', l5: 'sprint' });
    await rebuildClients(rt, NOW);
    const rows = db.prepare('SELECT lead_id, client_type, band, flags, next_checkin_at FROM cs_clients ORDER BY lead_id').all() as { lead_id: string; client_type: string; band: string; flags: string; next_checkin_at: number | null }[];
    expect(rows.map((r) => [r.lead_id, r.client_type, r.band])).toEqual([['l1', 'sprint', 'watch'], ['l2', 'deposit', 'watch'], ['l3', 'engagement', 'at_risk'], ['l5', 'sprint', 'churned']]);
    expect(JSON.parse(rows[2].flags)).toContain('payment_overdue');
    expect(rows[3].next_checkin_at).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM cs_health_history').get() as { n: number }).n).toBe(4);
  });
});

// ───────────── Check-ins ─────────────
describe('check-in proposals', () => {
  it('the built-in templates pass the house copy rules', () => {
    for (const type of ['sprint', 'deposit', 'engagement'] as const) for (const item of ['Kickoff call held', null]) {
      const t = templateCheckin({ name: 'Dana', type, openItem: item, signOff: 'G&L M&A Advisory team' });
      expect(auditEmail({ subject: t.subject, preheader: '', body: t.paragraphs }), `${type} ${item}`).toEqual([]);
      expect(checkinIssues(t)).toEqual([]);
    }
  });

  it('without an API key the template is proposed through the action layer (cs.checkin) and nothing is sent', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    lead(db, 'l1', 'sprint@example.com'); pass(db, 'p1', 'l1', 'offer', NOW - 4 * DAY);
    const r = await proposeCheckin(rt, 'l1', { now: NOW });
    expect(r).toMatchObject({ ok: true, draftedBy: 'template' });
    const act = db.prepare('SELECT kind, status, dept, payload FROM ops_actions').get() as { kind: string; status: string; dept: string; payload: string };
    expect(act).toMatchObject({ kind: CHECKIN_KIND, status: 'proposed', dept: 'client_success' });
    expect(JSON.parse(act.payload).checkinId).toBe((r as { id: string }).id);
    expect(fetchMock).not.toHaveBeenCalled();
    // A second proposal waits for the first.
    expect(await proposeCheckin(rt, 'l1', { now: NOW })).toMatchObject({ ok: false });
  });

  it('uses Claude’s draft when it passes the rules, the template when it does not; approval sends exactly once', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, ANTHROPIC_API_KEY: 'sk-test' });
    lead(db, 'l1', 'sprint@example.com'); pass(db, 'p1', 'l1', 'offer', NOW - 4 * DAY);
    lead(db, 'l2', 'two@example.com'); pass(db, 'p2', 'l2', 'offer', NOW - 4 * DAY);
    const seen: string[] = [];
    setClaudeTransport(async (_rt, ask) => { seen.push(ask.user); return JSON.stringify({ subject: 'Your intake form', paragraphs: ['Hi Dana,', 'We have your kickoff in the diary and need the intake form before it so the capacity review is ready on day 2.', 'Can you send it by Friday?', 'G&L M&A Advisory team'] }); });
    const a = await proposeCheckin(rt, 'l1', { now: NOW });
    expect(a).toMatchObject({ ok: true, draftedBy: 'claude' });
    expect(seen[0]).toContain('Client first name: Dana');
    setClaudeTransport(async () => JSON.stringify({ subject: 'Amazing news!', paragraphs: ['Hi Dana,', 'We guarantee you a deal!', 'Team'] }));
    const b = await proposeCheckin(rt, 'l2', { now: NOW });
    expect(b).toMatchObject({ ok: true, draftedBy: 'template' });
    expect((b as { note: string }).note).toContain('broke the copy rules');
    const actionId = (a as { actionId: string }).actionId;
    expect((await decideAction(rt, actionId, true)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(String(init.body))).toMatchObject({ to: ['sprint@example.com'], subject: 'Your intake form' });
    expect(await sendCheckin(rt, (a as { id: string }).id)).toMatchObject({ ok: true, summary: 'Check-in already sent.' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the daily run proposes for every client that is due (at the configured hour, once a day)', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, CS_DAILY_HOUR: '7' });
    lead(db, 'l1', 'a@example.com'); pass(db, 'p1', 'l1', 'offer', NOW - 4 * DAY);
    lead(db, 'l2', 'b@example.com'); pass(db, 'p2', 'l2', 'deposit', NOW - 3 * DAY);
    expect(await maybeDailyClients(rt, Date.parse('2026-10-31T05:00:00Z'))).toBeNull();
    const r = await maybeDailyClients(rt, NOW);
    expect(r).toMatchObject({ clients: 2, due: 2, proposed: 2 });
    expect(await maybeDailyClients(rt, NOW + 3_600_000)).toBeNull();
    expect(await proposeDueCheckins(rt, NOW)).toMatchObject({ due: 0 });
    expect(localClock(NOW, 'Australia/Sydney')).toEqual({ date: '2026-10-31', hour: 23 });
  });
});

// ───────────── Support ─────────────
describe('support inbox', () => {
  it('escalation rules catch money, refunds and legal', () => {
    expect(escalationTopics('Can I get a refund?')).toEqual(['refund']);
    expect(escalationTopics('How much is the deposit and can I pay by card')).toContain('money');
    expect(escalationTopics('My lawyer has a question about the agreement')).toContain('legal');
    expect(escalationTopics('How does seller rollover work?')).toEqual([]);
  });

  it('keeps only the new part of a reply and reads HTML (including Resend data URIs)', () => {
    expect(newestPart('Thanks, see below.\n\nOn Tue, Oct 1, 2026 at 9:00 AM Team <t@x.com> wrote:\n> old text')).toBe('Thanks, see below.');
    expect(htmlToText('<p>Hello<br>there</p><style>x{}</style>')).toBe('Hello\nthere');
    expect(htmlToText(`data:text/html;base64,${btoa('<b>Hi</b> team')}`)).toBe('Hi team');
  });

  it('threads replies, dedupes Message-IDs, matches the lead, and ignores our own address', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    lead(db, 'l1', 'dana@example.com');
    const a = await ingestEmail(rt, { from: 'Dana Lee <Dana@Example.com>', subject: 'Question about rollover', text: 'How does rollover work?', messageId: '<m1@x>' }, NOW);
    expect(a).toMatchObject({ ok: true, leadId: 'l1' });
    expect(await ingestEmail(rt, { from: 'dana@example.com', subject: 'x', text: 'dup', messageId: '<m1@x>' }, NOW)).toMatchObject({ duplicate: true });
    const b = await ingestEmail(rt, { from: 'dana@example.com', subject: 'Re: Question about rollover', text: 'One more thing', messageId: '<m2@x>' }, NOW + 1000);
    expect((b as { threadId: string }).threadId).toBe((a as { threadId: string }).threadId);
    expect(await ingestEmail(rt, { from: 'team@mail.test', subject: 'loop', text: 'x' })).toMatchObject({ ok: false });
    const t = db.prepare('SELECT from_name, lead_id FROM support_threads').get();
    expect(t).toEqual({ from_name: 'Dana Lee', lead_id: 'l1' });
  });

  it('drafts from the knowledge base with citations and proposes support.reply when confident', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, ANTHROPIC_API_KEY: 'sk-test' });
    const r = await ingestEmail(rt, { from: 'owner@example.com', subject: 'Guarantee', text: 'What exactly does the 90 day LOI guarantee cover?', messageId: '<g1@x>' }, NOW);
    let user = '';
    setClaudeTransport(async (_rt, ask) => { user = ask.user; return JSON.stringify({ answer: 'Hi,\n\nIf you don’t have a signed letter of intent within 90 days, the team keeps working with you at no extra cost, provided the conditions are met. The full conditions are on the guarantee page.\n\nG&L M&A Advisory team', citations: ['S1'], confidence: 0.9, needs_human: false, reason: '' }); });
    const o = await draftForThread(rt, (r as { threadId: string }).threadId, NOW);
    expect(o).toMatchObject({ escalated: false });
    expect(user).toMatch(/\[S1\] The guarantee/);
    const d = db.prepare('SELECT citations, confidence, status FROM support_drafts').get() as { citations: string; confidence: number; status: string };
    expect(JSON.parse(d.citations)[0]).toMatchObject({ id: 'guarantee', url: 'https://apply.test/guarantee' });
    expect(db.prepare('SELECT kind, status FROM ops_actions').get()).toEqual({ kind: 'support.reply', status: 'proposed' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM support_threads').get()).toEqual({ status: 'drafted' });
  });

  it('refund questions escalate even when Claude is confident; low confidence escalates; neither is proposed or sent', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, ANTHROPIC_API_KEY: 'sk-test', OPS_AUTO_KINDS: 'support.reply' });
    setClaudeTransport(async () => JSON.stringify({ answer: 'Hi,\n\nThe right person on the team will answer this.\n\nG&L M&A Advisory team', citations: ['S1'], confidence: 0.95, needs_human: false }));
    const a = await ingestEmail(rt, { from: 'x@example.com', subject: 'Refund', text: 'I want a refund of my Sprint.' }, NOW);
    expect(await draftForThread(rt, (a as { threadId: string }).threadId, NOW)).toMatchObject({ escalated: true, proposed: null });
    setClaudeTransport(async () => JSON.stringify({ answer: 'Hi,\n\nWe can help with that on a call with the team.\n\nG&L M&A Advisory team', citations: ['S1'], confidence: 0.3, needs_human: false }));
    const b = await ingestEmail(rt, { from: 'y@example.com', subject: 'Odd question', text: 'Can you help me choose a boat?' }, NOW);
    const ob = await draftForThread(rt, (b as { threadId: string }).threadId, NOW);
    expect(ob.escalated).toBe(true);
    expect(ob.reason).toContain('confidence 0.30');
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE kind = 'support.reply'").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE kind = 'support.escalate'").get()).toEqual({ n: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    // An escalated draft is never sent by the queue, only by a person.
    const draft = db.prepare('SELECT id FROM support_drafts WHERE escalate = 1 LIMIT 1').get() as { id: string };
    expect(await sendDraft(rt, draft.id, 'auto')).toMatchObject({ ok: false });
    expect(await sendDraft(rt, draft.id, 'you')).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('with support.reply on auto a confident draft is sent straight away; without a key nothing is drafted', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, ANTHROPIC_API_KEY: 'sk-test', OPS_AUTO_KINDS: 'support.reply' });
    setClaudeTransport(async () => JSON.stringify({ answer: 'Hi,\n\nDebt service coverage is the cash a business has for its loan payments divided by those payments. We structure deals at around 1.5x.\n\nG&L M&A Advisory team', citations: ['S1'], confidence: 0.9, needs_human: false }));
    const a = await ingestEmail(rt, { from: 'q@example.com', subject: 'DSCR', text: 'What is debt service coverage?' , messageId: '<d1@x>' }, NOW);
    await draftForThread(rt, (a as { threadId: string }).threadId, NOW);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)).headers).toEqual({ 'In-Reply-To': '<d1@x>', References: '<d1@x>' });
    expect(db.prepare('SELECT status FROM support_threads').get()).toEqual({ status: 'answered' });
    setClaudeTransport(null);
    const rt2 = makeRt(db, BASE);
    const b = await ingestEmail(rt2, { from: 'z@example.com', subject: 'Hi', text: 'What is a buy box?' }, NOW);
    expect(await draftForThread(rt2, (b as { threadId: string }).threadId, NOW)).toMatchObject({ draftId: null, note: 'no API key' });
  });

  it('imports room questions once and posts the approved answer back into the room', async () => {
    const db = freshDb();
    const rt = makeRt(db, { ...BASE, ANTHROPIC_API_KEY: 'sk-test' });
    lead(db, 'l1', 'viewer@example.com');
    db.prepare("INSERT INTO webinar_interactions (id, reg_id, lead_id, session_id, kind, value, created_at) VALUES ('q1', 'r1', 'l1', 's1', 'question', 'How big a deal can I do with $400k profit?', ?)").run(NOW - DAY);
    expect(await importRoomQuestions(rt, NOW)).toEqual({ added: 1 });
    expect(await importRoomQuestions(rt, NOW)).toEqual({ added: 0 });
    setClaudeTransport(async () => JSON.stringify({ answer: 'At about 1.5x debt service coverage, the profit sets how much debt the deal can carry. The team can look at your numbers.', citations: ['S1'], confidence: 0.85, needs_human: false }));
    const t = db.prepare('SELECT id, channel FROM support_threads').get() as { id: string; channel: string };
    expect(t.channel).toBe('room');
    const o = await draftForThread(rt, t.id, NOW);
    expect(await sendDraft(rt, o.draftId!, 'you')).toMatchObject({ ok: true });
    expect(db.prepare("SELECT team_answer IS NOT NULL AS answered, handled FROM webinar_interactions WHERE id = 'q1'").get()).toEqual({ answered: 1, handled: 1 });
  });

  it('the knowledge base retrieves our own content for a question', () => {
    const kb = staticPassages({ settings: {} as Runtime['settings'], origin: 'https://apply.test' });
    expect(retrieve(kb, 'what does the 90 day LOI guarantee cover')[0].id).toBe('guarantee');
    expect(retrieve(kb, 'debt service coverage ratio explained').some((p) => p.id.startsWith('guide-dscr-explained'))).toBe(true);
    expect(retrieve(kb, '')).toEqual([]);
    expect(chunkMarkdown('# A\nalpha text long enough to keep in the knowledge base\n## B\nbeta text long enough to keep in the knowledge base').map((c) => c.heading)).toEqual(['A', 'B']);
  });
});

// ───────────── MCP ─────────────
const TOKEN = 'mcp_test_token_0123456789abcdef';
function mcpReq(body: unknown, o: { token?: string | null; headers?: Record<string, string>; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(o.headers ?? {}) };
  if (o.token !== null) headers.authorization = `Bearer ${o.token ?? TOKEN}`;
  return new Request('https://apply.test/mcp', { method: o.method ?? 'POST', headers, body: o.method && o.method !== 'POST' ? undefined : JSON.stringify(body) });
}
const modern = (method: string, params: Record<string, unknown> = {}, extra: Record<string, string> = {}) =>
  mcpReq({ jsonrpc: '2.0', id: 7, method, params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } } }, { headers: { 'mcp-protocol-version': '2026-07-28', 'mcp-method': method, ...extra } });

describe('MCP server', () => {
  const setup = () => { const db = freshDb(); return { db, rt: makeRt(db, { ...BASE, MCP_TOKEN: TOKEN }) }; };

  it('is off without a token, and rejects wrong tokens, foreign origins, GET and batches', async () => {
    const db = freshDb();
    expect((await handleMcp(makeRt(db), mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(503);
    const { rt } = setup();
    const bad = await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: 'mcp_test_token_0123456789abcdeX' }));
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('Bearer');
    expect((await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null }))).status).toBe(401);
    expect((await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { origin: 'https://evil.example' } }))).status).toBe(403);
    expect((await handleMcp(rt, mcpReq(null, { method: 'GET' }))).status).toBe(405);
    expect((await handleMcp(rt, mcpReq([{ jsonrpc: '2.0', id: 1, method: 'ping' }]))).status).toBe(400);
    // The secret connector URL works in place of the header.
    expect((await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { token: null }), TOKEN)).status).toBe(200);
  });

  it('legacy handshake: initialize, initialized (202), tools/list, tools/call', async () => {
    const { rt, db } = setup();
    const init = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }))).json() as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
    expect(init.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'funnel-hq' } });
    const odd = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-01-01' } }))).json() as { result: { protocolVersion: string } };
    expect(odd.result.protocolVersion).toBe('2025-11-25');
    const note = await handleMcp(rt, mcpReq({ jsonrpc: '2.0', method: 'notifications/initialized' }, { headers: { 'mcp-protocol-version': '2025-06-18' } }));
    expect(note.status).toBe(202);
    expect(note.headers.get('mcp-session-id')).toBeNull();
    const list = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { headers: { 'mcp-protocol-version': '2025-06-18' } }))).json() as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[]; resultType?: string } };
    expect(list.result.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['funnel_stats', 'find_leads', 'lead_detail', 'bookings', 'deals', 'ad_performance', 'webinar_stats', 'sprint_board', 'client_health', 'support_queue', 'propose_lead_note', 'propose_email_to_lead']));
    expect(list.result.tools.find((t) => t.name === 'propose_lead_note')!.annotations.readOnlyHint).toBe(false);
    expect(list.result.resultType).toBeUndefined();
    lead(db, 'l1', 'dana@example.com');
    const call = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'find_leads', arguments: { query: 'dana' } } }))).json() as { result: { content: { text: string }[]; isError: boolean } };
    expect(call.result.isError).toBe(false);
    expect(JSON.parse(call.result.content[0].text)).toMatchObject({ count: 1, leads: [{ email: 'dana@example.com' }] });
    const unknown = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }))).json() as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });

  it('modern requests: per-request version, header checks, server/discover, resultType', async () => {
    const { rt } = setup();
    const disc = await (await handleMcp(rt, modern('server/discover'))).json() as { result: Record<string, unknown> };
    expect(disc.result).toMatchObject({ resultType: 'complete', supportedVersions: expect.arrayContaining(['2026-07-28', '2025-06-18']), capabilities: { tools: {} } });
    expect((disc.result._meta as Record<string, { name: string }>)['io.modelcontextprotocol/serverInfo'].name).toBe('funnel-hq');
    const list = await (await handleMcp(rt, modern('tools/list'))).json() as { result: { ttlMs: number; cacheScope: string; tools: unknown[] } };
    expect(list.result).toMatchObject({ ttlMs: 300000, cacheScope: 'private' });
    const mism = await handleMcp(rt, modern('tools/list', {}, { 'mcp-method': 'tools/call' }));
    expect(mism.status).toBe(400);
    expect(((await mism.json()) as { error: { code: number } }).error.code).toBe(-32020);
    const noName = await handleMcp(rt, modern('tools/call', { name: 'sprint_board', arguments: {} }));
    expect(noName.status).toBe(400);
    const ok = await (await handleMcp(rt, modern('tools/call', { name: 'sprint_board', arguments: {} }, { 'mcp-name': `=?base64?${btoa('sprint_board')}?=` }))).json() as { result: { resultType: string; isError: boolean } };
    expect(ok.result).toMatchObject({ resultType: 'complete', isError: false });
    const unsup = await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { headers: { 'mcp-protocol-version': '1900-01-01' } }));
    expect(unsup.status).toBe(400);
    expect(((await unsup.json()) as { error: { code: number; data: { supported: string[] } } }).error).toMatchObject({ code: -32022 });
    const missing = await handleMcp(rt, modern('resources/templates/list'));
    expect(missing.status).toBe(404);
    expect(decodeHeaderValue('plain')).toBe('plain');
  });

  it('every read tool runs on an empty database, and write tools only create proposals', async () => {
    const { rt, db } = setup();
    lead(db, 'l1', 'dana@example.com');
    for (const t of TOOLS.filter((x) => !x.write)) {
      const res = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: t.name, arguments: t.name === 'lead_detail' ? { lead: 'dana@example.com' } : {} } }))).json() as { result: { isError: boolean; content: { text: string }[] } };
      expect(res.result.isError, `${t.name}: ${res.result.content[0].text}`).toBe(false);
    }
    const note = await (await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'propose_lead_note', arguments: { lead: 'dana@example.com', note: 'Prefers calls after 5pm' } } }))).json() as { result: { content: { text: string }[] } };
    expect(JSON.parse(note.result.content[0].text)).toMatchObject({ proposed: true });
    await handleMcp(rt, mcpReq({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'propose_email_to_lead', arguments: { lead: 'dana@example.com', subject: 'Your call', body: 'Hi Dana,\n\nWe have moved your call to Thursday.' } } }));
    expect(db.prepare("SELECT notes FROM leads WHERE id = 'l1'").get()).toEqual({ notes: null });
    expect(fetchMock).not.toHaveBeenCalled();
    const acts = db.prepare('SELECT kind, status FROM ops_actions ORDER BY created_at').all();
    expect(acts).toEqual([{ kind: 'lead.note', status: 'proposed' }, { kind: 'mcp.email', status: 'proposed' }]);
    // Once approved, the note lands.
    const id = (db.prepare("SELECT id FROM ops_actions WHERE kind = 'lead.note'").get() as { id: string }).id;
    await decideAction(rt, id, true);
    expect(String((db.prepare("SELECT notes FROM leads WHERE id = 'l1'").get() as { notes: string }).notes)).toContain('Prefers calls after 5pm');
  });

  it('date ranges read days or ISO dates', () => {
    const r = rangeOf({ from: '2026-10-01', to: '2026-10-07' });
    expect(r.label).toBe('2026-10-01 to 2026-10-07');
    expect(rangeOf({ days: 7 }, 30, NOW).from).toBe(NOW - 7 * DAY);
  });
});

// ───────────── Webhooks ─────────────
describe('outbound webhooks', () => {
  it('signs and verifies payloads, rejecting stale or altered ones', async () => {
    const h = await signPayload('sec', '{"a":1}', 1_700_000_000);
    expect(await verifyPayload('sec', '{"a":1}', h, 1_700_000_000_000)).toBe(true);
    expect(await verifyPayload('sec', '{"a":2}', h, 1_700_000_000_000)).toBe(false);
    expect(await verifyPayload('sec', '{"a":1}', h, 1_700_000_000_000 + 600_000)).toBe(false);
    expect(validHookUrl('https://hooks.zapier.com/hooks/catch/1/abc')).toBeTruthy();
    for (const u of ['http://hooks.zapier.com/x', 'https://localhost/x', 'https://10.0.0.1/x', 'https://user:pw@x.com/', 'nope']) expect(validHookUrl(u)).toBeNull();
  });

  it('detects events from the tables once (no backfill on the first run) and queues deliveries for subscribers', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    db.prepare("INSERT INTO hook_subscriptions (id, url, events, secret, active, created_at) VALUES ('s1', 'https://hooks.example.com/a', '[\"lead.created\",\"sprint.paid\"]', 'sec', 1, 0)").run();
    db.prepare("INSERT INTO hook_subscriptions (id, url, events, secret, active, created_at) VALUES ('s2', 'https://hooks.example.com/b', '[\"*\"]', 'sec2', 1, 0)").run();
    lead(db, 'old', 'old@example.com');
    expect(await scanEvents(rt, NOW)).toMatchObject({ first: true });
    db.prepare("INSERT INTO leads (id, ref_code, created_at, updated_at, email, status) VALUES ('l9', 'NEW999', ?, ?, 'new@example.com', 'partial')").run(NOW + 60_000, NOW + 60_000);
    pass(db, 'p9', 'l9', 'offer', NOW + 90_000);
    pass(db, 'p8', 'l9', 'seat', NOW + 95_000);
    const r = await scanEvents(rt, NOW + 120_000);
    expect(r.found).toBe(3);
    expect((await scanEvents(rt, NOW + 180_000)).found).toBe(0);
    const ev = db.prepare('SELECT event, ref_id FROM hook_events ORDER BY event').all();
    expect(ev).toEqual([{ event: 'lead.created', ref_id: 'l9' }, { event: 'sprint.paid', ref_id: 'p9' }, { event: 'ticket.paid', ref_id: 'p8' }]);
    expect(db.prepare('SELECT sub_id, COUNT(*) AS n FROM hook_deliveries GROUP BY sub_id ORDER BY sub_id').all()).toEqual([{ sub_id: 's1', n: 2 }, { sub_id: 's2', n: 3 }]);
    expect(Object.keys(HOOK_EVENTS)).toHaveLength(7);
  });

  it('delivers signed JSON, retries with back-off, gives up after the last attempt, and stops on 410', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    db.prepare("INSERT INTO hook_subscriptions (id, url, events, secret, active, created_at) VALUES ('s1', 'https://hooks.example.com/a', '[\"*\"]', 'sec', 1, 0)").run();
    await recordEvent(rt, 'deal.won', 'l1:2026-10-31', { lead: { id: 'l1' } }, NOW);
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 500;
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('', { status }); }) as unknown as typeof fetch;
    expect(await deliverDue(rt, NOW, 10, f)).toEqual({ delivered: 0, retry: 1, failed: 0 });
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-funnel-event']).toBe('deal.won');
    expect(await verifyPayload('sec', String(calls[0].init.body), h['x-funnel-signature'], NOW)).toBe(true);
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ event: 'deal.won', data: { lead: { id: 'l1' } } });
    const d = db.prepare('SELECT attempts, next_at, status FROM hook_deliveries').get() as { attempts: number; next_at: number; status: string };
    expect(d).toEqual({ attempts: 1, next_at: NOW + RETRY_DELAYS_MS[0], status: 'pending' });
    expect(await deliverDue(rt, NOW + 1000, 10, f)).toEqual({ delivered: 0, retry: 0, failed: 0 }); // not due yet
    let t = NOW;
    for (let i = 1; i < MAX_ATTEMPTS; i++) { t += RETRY_DELAYS_MS[i - 1]; await deliverDue(rt, t, 10, f); }
    expect(db.prepare('SELECT attempts, status FROM hook_deliveries').get()).toEqual({ attempts: MAX_ATTEMPTS, status: 'failed' });
    await recordEvent(rt, 'refund.created', 'pass:x', {}, NOW);
    status = 410;
    await deliverDue(rt, t + 1, 10, f);
    expect(db.prepare("SELECT active FROM hook_subscriptions WHERE id = 's1'").get()).toEqual({ active: 0 });
    status = 200;
    db.prepare("UPDATE hook_subscriptions SET active = 1").run();
    await recordEvent(rt, 'lead.created', 'l2', {}, NOW);
    expect((await deliverDue(rt, t + 2, 10, f)).delivered).toBe(1);
  });
});

// ───────────── Zapier inbound ─────────────
describe('Zapier actions', () => {
  it('creates a lead once and adds notes by email or ref, logging each action', async () => {
    const db = freshDb();
    const rt = makeRt(db);
    const [a, sa] = await zapierCreateLead(rt, { email: 'New@Example.com', first_name: 'Sam', note: 'From a Facebook lead form', source: 'fb-leads' });
    expect(sa).toBe(200);
    expect(a).toMatchObject({ ok: true, existing: false });
    const [b] = await zapierCreateLead(rt, { email: 'new@example.com' });
    expect(b).toMatchObject({ existing: true, lead_id: a.lead_id });
    expect((await zapierCreateLead(rt, { email: 'not-an-email' }))[1]).toBe(400);
    const [c] = await zapierAddNote(rt, { ref: String(a.ref), note: 'Asked about Australia' });
    expect(c).toMatchObject({ ok: true });
    const l = db.prepare('SELECT notes, utm_source, status FROM leads WHERE id = ?').get(a.lead_id) as { notes: string; utm_source: string; status: string };
    expect(l.notes).toContain('From a Facebook lead form');
    expect(l.notes).toContain('Asked about Australia');
    expect(l.utm_source).toBe('fb-leads');
    expect((await zapierAddNote(rt, { email: 'nobody@example.com', note: 'x' }))[1]).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM ops_actions WHERE actor = 'auto'").get()).toEqual({ n: 3 });
  });
});

// ───────────── Routes: admin auth and secrets (through the real app) ─────────────
describe('routes', () => {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  const envFor = (db: DatabaseSync, extra: Record<string, string> = {}) => ({ DB: d1(db), ASSETS: { fetch: async () => new Response('', { status: 404 }) }, ADMIN_PASSWORD: 'devpass', SESSION_SECRET: 'x'.repeat(32), ...extra });
  it('admin APIs need the admin session; hooks need their secrets; /mcp routes to the server', async () => {
    const app = (await import('../src/index')).default;
    const db = freshDb();
    const env = envFor(db, { MCP_TOKEN: TOKEN, ZAPIER_INBOUND_SECRET: 'zsecret', SUPPORT_INBOUND_SECRET: 'ssecret' });
    for (const p of ['/admin/api/clients', '/admin/api/support', '/admin/api/automations']) expect((await app.fetch(new Request(`https://apply.test${p}`), env as never, ctx as never)).status, p).toBe(401);
    const z = (secret: string) => app.fetch(new Request('https://apply.test/hooks/zapier/create-lead', { method: 'POST', headers: { 'content-type': 'application/json', 'x-zapier-secret': secret }, body: JSON.stringify({ email: 'z@example.com' }) }), env as never, ctx as never);
    expect((await z('wrong')).status).toBe(401);
    expect((await z('zsecret')).status).toBe(200);
    const s = (secret: string) => app.fetch(new Request('https://apply.test/hooks/support-email', { method: 'POST', headers: { 'content-type': 'application/json', 'x-support-secret': secret }, body: JSON.stringify({ from: 'a@example.com', subject: 'Hi', text: 'What is seller rollover?' }) }), env as never, ctx as never);
    expect((await s('nope')).status).toBe(401);
    expect((await s('ssecret')).status).toBe(200);
    expect((await app.fetch(new Request('https://apply.test/hooks/resend-inbound', { method: 'POST', body: '{}' }), env as never, ctx as never)).status).toBe(501);
    const m = await app.fetch(new Request(`https://apply.test/mcp/k/${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }), env as never, ctx as never);
    expect(m.status).toBe(200);
    expect((await app.fetch(new Request('https://apply.test/mcp', { method: 'POST', body: '{}' }), env as never, ctx as never)).status).toBe(401);
  });
});

// ───────────── Copy ─────────────
describe('copy rules', () => {
  it('every user-facing string builder E added passes auditCopy', () => {
    const admin = fs.readFileSync(`${node.cwd()}/public/assets/admin.js`, 'utf8');
    const tabs = ['clients', 'support'].map((k) => { const m = new RegExp(`\\n    ${k}: \\{[^\\n]*sub: '([^']*)', more: '([^']*)'`).exec(admin); return m ? [m[1], m[2]] : ['missing']; });
    expect(tabs.flat()).not.toContain('missing');
    const settingHelp = SETTINGS.filter((s) => s.group === 'Clients & support').map((s) => ('help' in s ? s.help : '') ?? '');
    const strings = { tabs, settingHelp, events: HOOK_EVENTS, flags: FLAG_LABELS, checklists: CHECKLISTS, tools: TOOLS.map((t) => t.description) };
    expect(auditFields(strings)).toEqual([]);
    const all = JSON.stringify(strings);
    expect(all).not.toMatch(/[!—]/);
    const ui = fs.readFileSync(`${node.cwd()}/public/assets/ops-e.js`, 'utf8');
    expect(ui).not.toMatch(/—|!['"]/);
    expect(auditCopy('Ask Claude about leads, calls, deals, ads, webinars, the Sprint board, client health and support, in Claude’s own apps.')).toEqual([]);
  });
});
