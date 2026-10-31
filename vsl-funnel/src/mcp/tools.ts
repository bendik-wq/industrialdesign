import type { Runtime } from '../app';
import { adsReport } from '../admin/ads';
import { salesStats } from '../admin/sales';
import { overview, parseFilters } from '../admin/stats';
import { webinarReport } from '../admin/webinar';
import { clientsOverview } from '../clients/admin';
import { proposeCheckin } from '../clients/checkins';
import { emailConfigured, sendViaResend } from '../integrations/email';
import { auditEmail } from '../content/copy-rules';
import { proposeAction, registerActionHandler } from '../ops/actions';
import { supportOverview } from '../support/admin';
import { REPLY_KIND, manualDraft } from '../support/inbox';
import { paragraphsHtml } from '../clients/checkins';
import { dealSprintBoard } from '../webinar/deal-sprint';

/**
 * Tools the Claude connector (MCP server at /mcp) exposes. Read tools return numbers straight from the same
 * queries Funnel HQ's views use, each with the view it came from. Write tools never act: they create a
 * proposal in the action queue (proposeAction) that a person approves in Funnel HQ, unless the owner set
 * that action kind to auto.
 */

type Args = Record<string, unknown>;
export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: boolean;
  run: (rt: Runtime, args: Args) => Promise<unknown>;
}

const DAY = 86_400_000;
const int = (v: unknown, d: number, min: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== '' && v != null ? Math.max(min, Math.min(max, n)) : d; };
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const view = (rt: Runtime, tab: string) => `${rt.origin}/admin#${tab}`;

/** {from, to} from days or ISO dates; to defaults to now. */
export function rangeOf(args: Args, dflt = 30, now = Date.now()) {
  const to = str(args.to) && Number.isFinite(Date.parse(str(args.to))) ? Date.parse(str(args.to)) + (str(args.to).length <= 10 ? DAY - 1 : 0) : now;
  const from = str(args.from) && Number.isFinite(Date.parse(str(args.from))) ? Date.parse(str(args.from)) : to - int(args.days, dflt, 1, 3650) * DAY;
  return { from, to, label: `${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}` };
}
const RANGE_PROPS = {
  days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Look back this many days (default 30). Ignored when from is set.' },
  from: { type: 'string', description: 'Start date, YYYY-MM-DD (optional).' },
  to: { type: 'string', description: 'End date, YYYY-MM-DD (optional, default today).' },
};
const LEAD_PROP = { lead: { type: 'string', description: 'Lead id, email address or 6-character ref code.' } };

export async function findLead(rt: Runtime, key: string) {
  const k = key.trim();
  if (!k) return null;
  const db = rt.env.DB;
  return (await db.prepare('SELECT * FROM leads WHERE id = ?').bind(k).first<Record<string, unknown>>())
    ?? (k.includes('@') ? await db.prepare('SELECT * FROM leads WHERE email = ?').bind(k.toLowerCase()).first<Record<string, unknown>>() : null)
    ?? (/^[A-Z0-9]{6}$/i.test(k) ? await db.prepare('SELECT * FROM leads WHERE ref_code = ?').bind(k.toUpperCase()).first<Record<string, unknown>>() : null);
}
const leadSummary = (l: Record<string, unknown>) => ({
  id: l.id, ref: l.ref_code, name: [l.first_name, l.last_name].filter(Boolean).join(' ') || null, email: l.email, phone: l.phone, status: l.status,
  tier: l.tier_override ?? l.tier, score: l.score, revenue_band: l.revenue_band, industry: l.industry, channel: l.channel, utm_campaign: l.utm_campaign,
  created_at: l.created_at ? new Date(Number(l.created_at)).toISOString() : null, call_at: l.call_at ? new Date(Number(l.call_at)).toISOString() : null,
  revenue: l.revenue, cash_collected: l.cash_collected,
});

const tableExists = async (rt: Runtime, name: string) => Boolean(await rt.env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(name).first().catch(() => null));

export const TOOLS: McpTool[] = [
  {
    name: 'funnel_stats', title: 'Funnel stats',
    description: 'Visitors, leads, applications (by tier), booked calls, shows, wins, cash, email engagement and purchases (tickets, Sprints, deposits) for a date range. Same numbers as Funnel HQ → Overview.',
    inputSchema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async (rt, a) => {
      const r = rangeOf(a);
      const ov = await overview(rt.env, parseFilters({ from: String(r.from), to: String(r.to) }));
      const { results: buys } = await rt.env.DB.prepare(
        "SELECT kind, currency, COUNT(*) AS n, SUM(amount - refunded_amount) AS net_minor FROM webinar_passes WHERE status IN ('paid', 'refunded') AND paid_at BETWEEN ? AND ? GROUP BY kind, currency",
      ).bind(r.from, r.to).all<{ kind: string; currency: string; n: number; net_minor: number }>();
      const KIND: Record<string, string> = { seat: 'masterclass_ticket', offer: 'first_deal_sprint', deposit: 'engagement_deposit', live_ticket: 'live_ticket', challenge: 'challenge_ticket' };
      const { daily: _d, ...rest } = ov as Record<string, unknown>;
      return { range: r.label, source: view(rt, 'overview'), ...rest, purchases: buys.map((b) => ({ product: KIND[b.kind] ?? b.kind, count: b.n, net: (b.net_minor ?? 0) / 100, currency: b.currency.toUpperCase() })) };
    },
  },
  {
    name: 'find_leads', title: 'Find leads',
    description: 'Search leads by name, email, phone, ref code or company words in their answers; filter by status or tier. Newest first.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, status: { type: 'string', enum: ['partial', 'applied', 'booked', 'showed', 'no_show', 'won', 'lost', 'nurture', 'disqualified'] }, tier: { type: 'string', enum: ['A', 'B', 'C'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    run: async (rt, a) => {
      const where: string[] = ['1 = 1'];
      const bind: unknown[] = [];
      const q = str(a.query, 100);
      if (q) { where.push("(LOWER(COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) LIKE ? OR email LIKE ? OR phone LIKE ? OR ref_code = ? OR answers LIKE ?)"); const like = `%${q.toLowerCase()}%`; bind.push(like, like, `%${q}%`, q.toUpperCase(), `%${q}%`); }
      if (str(a.status)) { where.push('status = ?'); bind.push(str(a.status)); }
      if (str(a.tier)) { where.push('COALESCE(tier_override, tier) = ?'); bind.push(str(a.tier)); }
      const { results } = await rt.env.DB.prepare(`SELECT * FROM leads WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).bind(...bind, int(a.limit, 20, 1, 50)).all<Record<string, unknown>>();
      return { source: view(rt, 'leads'), count: results.length, leads: results.map(leadSummary) };
    },
  },
  {
    name: 'lead_detail', title: 'Lead detail',
    description: 'Everything about one lead: application answers, status, call, purchases, payments, agreements, recent emails, support threads and client health.',
    inputSchema: { type: 'object', properties: LEAD_PROP, required: ['lead'], additionalProperties: false },
    run: async (rt, a) => {
      const l = await findLead(rt, str(a.lead));
      if (!l) throw new Error('No lead matches that id, email or ref.');
      const db = rt.env.DB;
      const all = (sql: string) => db.prepare(sql).bind(l.id).all<Record<string, unknown>>().then((r) => r.results).catch(() => []);
      const [passes, payments, contracts, emails, threads, client] = await Promise.all([
        all('SELECT kind, product, status, amount, currency, paid_at, refunded_at FROM webinar_passes WHERE lead_id = ? ORDER BY created_at DESC LIMIT 20'),
        all('SELECT amount, paid_at, method, note FROM payments WHERE lead_id = ? ORDER BY paid_at DESC LIMIT 20'),
        all('SELECT title, status, fee, currency, sent_at, signed_at, paid_at FROM contracts WHERE lead_id = ? AND COALESCE(is_test, 0) = 0'),
        all("SELECT sequence, subject, status, sent_at, opened_at, clicked_at FROM emails WHERE lead_id = ? AND status = 'sent' ORDER BY sent_at DESC LIMIT 10"),
        all('SELECT id, channel, subject, status, escalate_reason, updated_at FROM support_threads WHERE lead_id = ? ORDER BY updated_at DESC LIMIT 10'),
        all('SELECT client_type, health, band, reasons, flags, next_checkin_at FROM cs_clients WHERE lead_id = ?'),
      ]);
      let answers: unknown = {};
      try { answers = JSON.parse(String(l.answers ?? '{}')); } catch { /* keep {} */ }
      return { source: view(rt, 'leads'), lead: leadSummary(l), answers, notes: l.notes, objection: l.objection, lost_reason: l.lost_reason, purchases: passes, payments, agreements: contracts, recent_emails: emails, support_threads: threads, client: client[0] ?? null };
    },
  },
  {
    name: 'bookings', title: 'Booked calls',
    description: 'Calls booked in the last N days and calls coming up in the next N days, with the lead, tier and closer.',
    inputSchema: { type: 'object', properties: { days_back: { type: 'integer', minimum: 0, maximum: 365 }, days_ahead: { type: 'integer', minimum: 0, maximum: 90 } }, additionalProperties: false },
    run: async (rt, a) => {
      const now = Date.now();
      const back = int(a.days_back, 7, 0, 365), ahead = int(a.days_ahead, 14, 0, 90);
      const db = rt.env.DB;
      const [recent, upcoming] = await Promise.all([
        db.prepare('SELECT * FROM leads WHERE booked_at BETWEEN ? AND ? ORDER BY booked_at DESC LIMIT 100').bind(now - back * DAY, now).all<Record<string, unknown>>(),
        db.prepare('SELECT * FROM leads WHERE call_at BETWEEN ? AND ? AND booking_cancelled_at IS NULL ORDER BY call_at LIMIT 100').bind(now, now + ahead * DAY).all<Record<string, unknown>>(),
      ]);
      const row = (l: Record<string, unknown>) => ({ ...leadSummary(l), closer_id: l.closer_id, booked_at: l.booked_at ? new Date(Number(l.booked_at)).toISOString() : null });
      return { source: view(rt, 'sales'), booked_recently: recent.results.map(row), upcoming_calls: upcoming.results.map(row) };
    },
  },
  {
    name: 'deals', title: 'Calls and deals',
    description: 'Show rate, close rate, deals won and cash by rep for a date range, plus the deals won. Same numbers as Funnel HQ → Calls & deals.',
    inputSchema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async (rt, a) => {
      const r = rangeOf(a);
      const stats = await salesStats(rt.env, r.from, r.to, rt.settings.SALES_TIMEZONE || 'UTC');
      const { results } = await rt.env.DB.prepare("SELECT * FROM leads WHERE status = 'won' AND closed_at BETWEEN ? AND ? ORDER BY closed_at DESC LIMIT 100").bind(r.from, r.to).all<Record<string, unknown>>();
      return { range: r.label, source: view(rt, 'sales'), stats, won: results.map((l) => ({ ...leadSummary(l), offer: l.offer, closed_at: l.closed_at ? new Date(Number(l.closed_at)).toISOString() : null })) };
    },
  },
  {
    name: 'ad_performance', title: 'Ad performance',
    description: 'Spend, clicks, visitors, leads, booked calls and cost per result by campaign and by funnel for a date range (Meta sync and manual spend). Same numbers as Funnel HQ → Traffic & ads.',
    inputSchema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async (rt, a) => { const r = rangeOf(a); return { range: r.label, source: view(rt, 'traffic'), ...(await adsReport(rt, r.from, r.to)) }; },
  },
  {
    name: 'webinar_stats', title: 'Webinar, live and challenge stats',
    description: 'Auto webinar registrations, attendance and offers; live webinar events with registrations and deposits; challenge cohorts with registrants, VIPs and deposits.',
    inputSchema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async (rt, a) => {
      const r = rangeOf(a);
      const db = rt.env.DB;
      const safe = <T>(p: Promise<{ results: T[] }>) => p.then((x) => x.results).catch(() => [] as T[]);
      const [auto, live, cohorts] = await Promise.all([
        webinarReport(rt, { from: r.from, to: r.to }).catch((e) => ({ error: String(e) })),
        safe(db.prepare(`SELECT w.id, w.title, w.starts_at, w.status, (SELECT COUNT(*) FROM live_webinar_regs g WHERE g.event_id = w.id) AS registrations,
                                (SELECT COUNT(*) FROM live_webinar_regs g WHERE g.event_id = w.id AND g.joined_at IS NOT NULL) AS attended,
                                (SELECT COUNT(*) FROM webinar_passes p WHERE p.kind = 'deposit' AND p.source = 'live' AND p.ref_id = w.id AND p.status = 'paid') AS deposits
                           FROM live_webinars w WHERE w.starts_at BETWEEN ? AND ? ORDER BY w.starts_at DESC LIMIT 50`).bind(r.from, r.to + 60 * DAY).all<Record<string, unknown>>()),
        safe(db.prepare(`SELECT c.id, c.name, c.start_date, (SELECT COUNT(*) FROM challenge_registrations g WHERE g.cohort_id = c.id) AS registrations,
                                (SELECT COUNT(*) FROM challenge_registrations g WHERE g.cohort_id = c.id AND g.status = 'paid') AS paid,
                                (SELECT COUNT(*) FROM challenge_registrations g WHERE g.cohort_id = c.id AND g.vip = 1) AS vip,
                                (SELECT COUNT(*) FROM challenge_deposits d WHERE d.cohort_id = c.id AND d.paid_at IS NOT NULL) AS deposits
                           FROM challenge_cohorts c ORDER BY c.created_at DESC LIMIT 20`).all<Record<string, unknown>>()),
      ]);
      return { range: r.label, sources: { auto: view(rt, 'webinar'), live: view(rt, 'liveevents'), challenge: view(rt, 'challenge') }, auto_webinar: auto, live_webinars: live, challenge_cohorts: cohorts };
    },
  },
  {
    name: 'sprint_board', title: 'Sprint board',
    description: 'Every First Deal Sprint buyer: day of 7, intake, kickoff and Deal Plan session, each deliverable’s status and the outcome.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: async (rt) => { const b = await dealSprintBoard(rt); return { source: view(rt, 'dealsprint'), sprints: b.sprints }; },
  },
  {
    name: 'client_health', title: 'Client health',
    description: 'Every client (Sprint, deposit or engagement) with health score, band, the reasons behind it, flags and next check-in.',
    inputSchema: { type: 'object', properties: { band: { type: 'string', enum: ['healthy', 'watch', 'at_risk', 'churned'] } }, additionalProperties: false },
    run: async (rt, a) => { const o = await clientsOverview(rt); return { source: view(rt, 'clients'), summary: o.summary, clients: o.clients.filter((c) => !str(a.band) || c.band === str(a.band)) }; },
  },
  {
    name: 'support_queue', title: 'Support queue',
    description: 'Support threads (email, room questions, challenge hot seats) with status: open, drafted, escalated, answered.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'drafted', 'escalated', 'answered', 'closed'] } }, additionalProperties: false },
    run: async (rt, a) => { const o = await supportOverview(rt, str(a.status)); return { source: view(rt, 'support'), counts: o.counts, threads: o.threads.slice(0, 50) }; },
  },
  {
    name: 'recent_actions', title: 'Recent actions',
    description: 'The latest entries in the action log: what the AI departments did or proposed, and what is waiting for approval.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['proposed', 'done', 'approved', 'rejected', 'failed'] }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
    run: async (rt, a) => {
      if (!(await tableExists(rt, 'ops_actions'))) return { actions: [], note: 'The action log is empty.' };
      const st = str(a.status);
      const { results } = await rt.env.DB.prepare(`SELECT * FROM ops_actions ${st ? 'WHERE status = ?' : ''} ORDER BY created_at DESC LIMIT ?`).bind(...(st ? [st] : []), int(a.limit, 25, 1, 100)).all<Record<string, unknown>>();
      return { actions: results.map(({ payload: _p, ...r }) => r) };
    },
  },

  // ── Write tools: every one only creates a proposal for a person to approve ──
  {
    name: 'propose_lead_note', title: 'Propose a note on a lead', write: true,
    description: 'Propose adding a note to a lead. Creates an approval in Funnel HQ; nothing changes until a person approves it.',
    inputSchema: { type: 'object', properties: { ...LEAD_PROP, note: { type: 'string', maxLength: 2000 } }, required: ['lead', 'note'], additionalProperties: false },
    run: async (rt, a) => {
      const l = await findLead(rt, str(a.lead));
      if (!l) throw new Error('No lead matches that id, email or ref.');
      const note = str(a.note, 2000);
      if (!note) throw new Error('note is empty');
      const id = await proposeAction(rt, { dept: 'sales', kind: 'lead.note', risk: 'low', summary: `Add a note to ${l.email ?? l.ref_code}`, detail: note, payload: { leadId: l.id, note, via: 'Claude (MCP)' } });
      return { proposed: true, action_id: id, status: 'waiting for approval in Funnel HQ' };
    },
  },
  {
    name: 'propose_email_to_lead', title: 'Propose an email to a lead', write: true,
    description: 'Propose a one-off email to one lead (plain text). It is checked against the house copy rules and waits for a person to approve it before anything is sent.',
    inputSchema: { type: 'object', properties: { ...LEAD_PROP, subject: { type: 'string', maxLength: 140 }, body: { type: 'string', maxLength: 4000, description: 'Plain text; blank lines between paragraphs.' } }, required: ['lead', 'subject', 'body'], additionalProperties: false },
    run: async (rt, a) => {
      const l = await findLead(rt, str(a.lead));
      if (!l?.email) throw new Error('No lead with an email address matches that id, email or ref.');
      const subject = str(a.subject, 140), body = str(a.body, 4000);
      if (!subject || !body) throw new Error('subject and body are both needed');
      const issues = auditEmail({ subject, preheader: '', body: body.split(/\n{2,}/) }).map((i) => i.rule);
      const id = await proposeAction(rt, { dept: 'sales', kind: 'mcp.email', risk: 'medium', summary: `Email ${l.email}: ${subject}`, detail: `${body}${issues.length ? `\n\nCopy check: ${issues.join('; ')}` : ''}`, payload: { leadId: l.id, subject, body } });
      return { proposed: true, action_id: id, copy_issues: issues, status: 'waiting for approval in Funnel HQ' };
    },
  },
  {
    name: 'propose_client_checkin', title: 'Propose a client check-in', write: true,
    description: 'Draft a check-in email for a client in the team’s voice and put it in the approval queue (Funnel HQ → Clients).',
    inputSchema: { type: 'object', properties: LEAD_PROP, required: ['lead'], additionalProperties: false },
    run: async (rt, a) => {
      const l = await findLead(rt, str(a.lead));
      if (!l) throw new Error('No lead matches that id, email or ref.');
      const r = await proposeCheckin(rt, String(l.id), { reason: 'Requested from Claude (MCP)' });
      if (!r.ok) throw new Error(r.error);
      return { proposed: true, action_id: r.actionId, checkin_id: r.id, drafted_by: r.draftedBy, status: 'waiting for approval in Funnel HQ' };
    },
  },
  {
    name: 'propose_support_reply', title: 'Propose a support reply', write: true,
    description: 'Propose a reply on a support thread (ids from support_queue). It waits for a person to approve it before it is sent.',
    inputSchema: { type: 'object', properties: { thread_id: { type: 'string' }, body: { type: 'string', maxLength: 6000 } }, required: ['thread_id', 'body'], additionalProperties: false },
    run: async (rt, a) => {
      const t = await rt.env.DB.prepare('SELECT id, subject, from_email, lead_id FROM support_threads WHERE id = ?').bind(str(a.thread_id, 60)).first<Record<string, unknown>>();
      if (!t) throw new Error('No support thread with that id.');
      const body = str(a.body, 6000);
      if (!body) throw new Error('body is empty');
      const draftId = await manualDraft(rt, String(t.id), body);
      await rt.env.DB.prepare("UPDATE support_drafts SET model = 'claude-mcp', edited = 0 WHERE id = ?").bind(draftId).run();
      const id = await proposeAction(rt, { dept: 'support', kind: REPLY_KIND, risk: 'low', summary: `Reply to ${t.from_email ?? 'a viewer'}: ${String(t.subject ?? '').slice(0, 80)}`, detail: body, payload: { draftId, threadId: t.id, leadId: t.lead_id ?? null } });
      await rt.env.DB.prepare('UPDATE support_drafts SET action_id = ? WHERE id = ?').bind(id, draftId).run();
      return { proposed: true, action_id: id, draft_id: draftId, status: 'waiting for approval in Funnel HQ' };
    },
  },
];

/** Other builders' tools (research angles, the DM inbox) register here at merge; names must be unique. */
export function registerMcpTool(t: McpTool) {
  if (TOOLS.some((x) => x.name === t.name)) throw new Error(`duplicate MCP tool ${t.name}`);
  TOOLS.push(t);
}

// ── Handlers for the write tools' action kinds (run only once a proposal is approved) ──
registerActionHandler('lead.note', async (rt, p) => {
  const lead = await rt.env.DB.prepare('SELECT id, notes FROM leads WHERE id = ?').bind(String(p.leadId ?? '')).first<{ id: string; notes: string | null }>();
  if (!lead) return { ok: false, summary: 'Lead not found.' };
  const line = `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, ${String(p.via ?? 'AI')}] ${String(p.note ?? '').replace(/[<>]/g, '').slice(0, 2000)}`;
  await rt.env.DB.prepare('UPDATE leads SET notes = ?, updated_at = ? WHERE id = ?').bind([lead.notes, line].filter(Boolean).join('\n'), Date.now(), lead.id).run();
  return { ok: true, summary: 'Note added.' };
});
registerActionHandler('mcp.email', async (rt, p) => {
  const lead = await rt.env.DB.prepare('SELECT email, unsubscribed_at FROM leads WHERE id = ?').bind(String(p.leadId ?? '')).first<{ email: string | null; unsubscribed_at: number | null }>();
  if (!lead?.email) return { ok: false, summary: 'Lead has no email address.' };
  if (lead.unsubscribed_at) return { ok: false, summary: 'Lead unsubscribed; not sent.' };
  if (!emailConfigured(rt)) return { ok: false, summary: 'Add the Resend API key and From address to send email.' };
  const body = String(p.body ?? '');
  await sendViaResend(rt, { to: lead.email, subject: String(p.subject ?? '').slice(0, 140), text: body, html: paragraphsHtml(body), tags: { kind: 'mcp_email' } });
  return { ok: true, summary: `Email sent to ${lead.email}.` };
});
