import type Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';
import { emailStats, live } from '../admin/stats';
import { salesStats } from '../admin/sales';
import { type Lead, getLead, getLeadByRef, parseAnswers } from '../funnel/leads';
import { DEPTS, type Dept, type Risk, handlerKinds, listActions, proposeAction } from './actions';
import { saveDocument } from './documents';
import { type Source, SOURCES, byCampaign, byContent, change, fmt, fmtChange, snapshot } from './metrics';
import { RANGE_KEYS, type Range, dateRange, ownerTz, priorOf, resolveRange } from './range';

/**
 * The Chief of Staff's tools in the Command chat. Read tools return real rows and counts from the app with the
 * Funnel HQ view they come from; the only write tools queue a proposal (proposeAction) or save a document.
 * Nothing here sends to a lead, spends money or changes ads directly.
 */
export interface ToolCtx { threadId: string; now?: number }
export interface ToolOutput { result: unknown; summary: string; sources: Source[] }

const RANGE_PROPS = {
  range: { type: 'string', enum: [...RANGE_KEYS], description: 'Named range in the owner’s time zone. Weeks start Monday. Default 7d.' },
  from: { type: 'string', description: 'Custom start date YYYY-MM-DD (inclusive). Use with to instead of range.' },
  to: { type: 'string', description: 'Custom end date YYYY-MM-DD (inclusive).' },
} as const;

export const TOOLS: Anthropic.Tool[] = [
  { name: 'funnel_stats', description: 'Key numbers for a time range and the same length of time before it: visitors, sign-ups (new leads), applications, masterclass / live webinar / challenge registrations, tickets sold, calls booked, calls held, no-shows, show rate, deals won and revenue, Sprint sales and revenue, engagement deposits, ad spend, cost per lead and cost per booked call. Use this for any question about how the business is doing.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'search_leads', description: 'Find leads by name, email, phone or ref code, and/or filter by tier (A, B, C), status (partial, applied, booked, showed, no_show, won, lost, nurture) and when they signed up. Returns up to 25, newest first.', input_schema: { type: 'object', properties: { query: { type: 'string' }, tier: { type: 'string', enum: ['A', 'B', 'C'] }, status: { type: 'string' }, ...RANGE_PROPS, limit: { type: 'integer', minimum: 1, maximum: 25 } } } },
  { name: 'lead_detail', description: 'One lead in full: contact, source, tier and score, application answers, booking and call outcome, emails sent and opened, recent site activity.', input_schema: { type: 'object', properties: { id: { type: 'string', description: 'Lead id or 6-character ref code' } }, required: ['id'] } },
  { name: 'bookings', description: 'Calls booked in a range (by booking time), or upcoming calls in the next 14 days, with tier, status, closer and source.', input_schema: { type: 'object', properties: { upcoming: { type: 'boolean' }, ...RANGE_PROPS } } },
  { name: 'deals', description: 'Calls, show rate, deals won and lost, revenue, cash collected and commission for a range, by closer, plus the deals closed in that range.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'ad_performance', description: 'Ad spend, visitors, sign-ups, booked calls, cost per lead and cost per booked call per campaign for a range and the period before; optionally sign-ups and bookings per ad (utm_content) inside one campaign.', input_schema: { type: 'object', properties: { campaign: { type: 'string', description: 'Campaign name (as in utm_campaign) to break down by ad' }, ...RANGE_PROPS } } },
  { name: 'event_stats', description: 'The masterclass (registrations, attended live, replays, tickets, Sprint sales), live webinars (each event: registrations, joined, offer clicks, deposits) and challenge cohorts (paid registrations, VIP, deposits) for a range.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'sprint_board', description: 'First Deal Sprint buyers: day of 7, kickoff and Deal Plan session status, outcome, and counts by stage.', input_schema: { type: 'object', properties: {} } },
  { name: 'email_stats', description: 'Emails per sequence for a range: sent, opened, clicked, failed, skipped, and what is queued.', input_schema: { type: 'object', properties: { ...RANGE_PROPS } } },
  { name: 'live_visitors', description: 'Who is on the site right now (last 5 minutes) and the last hour: active visitors, pages, sign-ups, applications, bookings.', input_schema: { type: 'object', properties: {} } },
  { name: 'activity_log', description: 'Actions every department took or proposed (the Command activity log), newest first.', input_schema: { type: 'object', properties: { dept: { type: 'string', enum: [...DEPTS] }, status: { type: 'string', enum: ['done', 'proposed', 'approved', 'rejected', 'failed'] }, limit: { type: 'integer', minimum: 1, maximum: 50 } } } },
  { name: 'propose_action', description: 'Queue an action for the owner to Approve, Edit or Reject in Command → Approvals. Use for anything that changes something: contacting leads or clients, emails or texts in bulk, ad changes, spending money, creating a routine (kind ops.routine_create, payload {name, instruction, cadence: daily|weekdays|weekly, weekday: 0-6 for weekly, time: "HH:MM"}), posting to the team Slack (kind ops.slack_message, payload {text}). Never claim the action is done: say it is waiting for approval.', input_schema: { type: 'object', properties: { dept: { type: 'string', enum: [...DEPTS] }, kind: { type: 'string', description: 'dept.verb, e.g. marketing.pause_ad, sales.follow_up_quiet_leads, ops.routine_create' }, summary: { type: 'string', description: 'One line the owner reads in the queue' }, detail: { type: 'string', description: 'Why, with the numbers and where they come from' }, payload: { type: 'object', description: 'Everything the handler needs to carry it out' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['dept', 'kind', 'summary', 'detail', 'payload', 'risk'] } },
  { name: 'create_document', description: 'Save a document (markdown) the owner can open and download from Command → Documents, e.g. a month-to-date summary. Only put numbers in it that came from the tools in this conversation, each with its source.', input_schema: { type: 'object', properties: { title: { type: 'string' }, markdown: { type: 'string' } }, required: ['title', 'markdown'] } },
];

export function rangeFrom(input: Record<string, unknown>, tz: string, now: number, dflt = '7d'): Range {
  if (typeof input.from === 'string' && typeof input.to === 'string') { const r = dateRange(input.from, input.to, tz); if (r) return r; }
  return resolveRange(typeof input.range === 'string' ? input.range : dflt, tz, now);
}
const iso = (t: number | null | undefined, tz: string) => (t ? new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t).replace(',', '') : null);
const name = (l: Pick<Lead, 'first_name' | 'last_name' | 'ref_code'>) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.ref_code;
const leadSource = (id: string, label = 'Lead'): Source => ({ label, href: `/admin#lead=${encodeURIComponent(id)}` });
const n = (v: unknown) => Number(v) || 0;

export async function runTool(rt: Runtime, toolName: string, input: Record<string, unknown>, ctx: ToolCtx): Promise<ToolOutput> {
  const tz = ownerTz(rt);
  const now = ctx.now ?? Date.now();
  const db = rt.env.DB;
  switch (toolName) {
    case 'funnel_stats': {
      const r = rangeFrom(input, tz, now);
      const p = priorOf(r);
      const [a, b] = await Promise.all([snapshot(rt, r), snapshot(rt, p)]);
      const metrics = Object.values(a).map((m) => ({ key: m.key, label: m.label, value: m.value, shown: fmt(m), before: fmt(b[m.key]), change: fmtChange(change(m.value, b[m.key].value)), source: m.source.href }));
      return { result: { range: { label: r.label, from: iso(r.from, tz), to: iso(r.to, tz) }, before: { from: iso(p.from, tz), to: iso(p.to, tz) }, time_zone: tz, metrics }, summary: `${r.label}: ${fmt(a.leads)} sign-ups, ${fmt(a.bookings)} calls booked, deals won ${fmt(a.deals)}`, sources: uniq(Object.values(a).map((m) => m.source)) };
    }
    case 'search_leads': {
      const where: string[] = ['1 = 1'];
      const args: (string | number)[] = [];
      const q = typeof input.query === 'string' ? input.query.trim().slice(0, 100) : '';
      if (q) { const like = `%${q}%`; where.push('(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.phone LIKE ? OR l.ref_code = ?)'); args.push(like, like, like, like, q.toUpperCase()); }
      if (typeof input.tier === 'string' && /^[ABC]$/.test(input.tier)) { where.push('COALESCE(l.tier_override, l.tier) = ?'); args.push(input.tier); }
      if (typeof input.status === 'string' && /^[a-z_]{2,20}$/.test(input.status)) { where.push('l.status = ?'); args.push(input.status); }
      if (input.range || input.from) { const r = rangeFrom(input, tz, now); where.push('l.created_at BETWEEN ? AND ?'); args.push(r.from, r.to); }
      const limit = Math.max(1, Math.min(25, Number(input.limit) || 15));
      const [rows, total] = await Promise.all([
        db.prepare(`SELECT l.id, l.ref_code, l.first_name, l.last_name, l.email, COALESCE(l.tier_override, l.tier) AS tier, l.score, l.status, l.created_at, l.booked_at, l.call_at, l.revenue_band, l.industry, COALESCE(l.utm_campaign, l.ft_campaign) AS campaign, l.channel
                      FROM leads l WHERE ${where.join(' AND ')} ORDER BY l.created_at DESC LIMIT ?`).bind(...args, limit).all<Record<string, unknown> & Lead>(),
        db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(' AND ')}`).bind(...args).first<{ n: number }>(),
      ]);
      const leads = rows.results.map((l) => ({ id: l.id, name: name(l), email: l.email, tier: l.tier, score: l.score, status: l.status, signed_up: iso(l.created_at, tz), booked: iso(l.booked_at, tz), call: iso(l.call_at, tz), revenue_band: l.revenue_band, industry: l.industry, campaign: l.campaign, channel: l.channel, link: `/admin#lead=${l.id}` }));
      return { result: { total: total?.n ?? 0, shown: leads.length, leads }, summary: `${total?.n ?? 0} leads match`, sources: [SOURCES.leads] };
    }
    case 'lead_detail': {
      const key = String(input.id ?? '').trim();
      const l = (await getLead(rt.env, key)) ?? (/^[A-Za-z0-9]{6}$/.test(key) ? await getLeadByRef(rt.env, key) : null);
      if (!l) return { result: { error: 'No lead with that id or ref code.' }, summary: 'Lead not found', sources: [SOURCES.leads] };
      const [emails, events, payments] = await Promise.all([
        db.prepare("SELECT COUNT(*) AS queued, SUM(status IN ('sent','simulated')) AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked FROM emails WHERE lead_id = ?").bind(l.id).first<Record<string, number>>(),
        db.prepare('SELECT name, path, ts FROM events WHERE lead_id = ? AND is_bot = 0 ORDER BY ts DESC LIMIT 12').bind(l.id).all<{ name: string; path: string; ts: number }>(),
        db.prepare('SELECT amount, method, paid_at FROM payments WHERE lead_id = ? ORDER BY paid_at DESC LIMIT 10').bind(l.id).all<Record<string, unknown>>().catch(() => ({ results: [] })),
      ]);
      const L = l as Lead & Record<string, unknown>;
      return {
        result: {
          id: l.id, ref: l.ref_code, name: name(l), email: l.email, country: l.country, tier: l.tier_override ?? l.tier, score: l.score, status: l.status,
          signed_up: iso(l.created_at, tz), applied: iso(l.app_completed_at, tz), booked: iso(l.booked_at, tz), call: iso(l.call_at, tz), closer: L.closer_id ?? null,
          revenue: L.revenue ?? null, cash_collected: L.cash_collected ?? null, source: { channel: l.channel, campaign: l.utm_campaign ?? L.ft_campaign ?? null, ad: l.utm_content },
          answers: parseAnswers(l), emails: { sent: n(emails?.sent), opened: n(emails?.opened), clicked: n(emails?.clicked), queued: n(emails?.queued) },
          recent_activity: events.results.map((e) => ({ what: e.name, page: e.path, at: iso(e.ts, tz) })), payments: payments.results,
          link: `/admin#lead=${l.id}`,
        },
        summary: `${name(l)}, tier ${l.tier_override ?? l.tier ?? 'none'}, ${l.status}`,
        sources: [leadSource(l.id, name(l))],
      };
    }
    case 'bookings': {
      const upcoming = input.upcoming === true;
      const r = rangeFrom(input, tz, now);
      const sql = upcoming
        ? "SELECT id, first_name, last_name, ref_code, COALESCE(tier_override, tier) AS tier, status, booked_at, call_at, closer_id, COALESCE(utm_campaign, ft_campaign) AS campaign FROM leads WHERE booked_at IS NOT NULL AND booking_cancelled_at IS NULL AND call_at BETWEEN ? AND ? ORDER BY call_at LIMIT 60"
        : 'SELECT id, first_name, last_name, ref_code, COALESCE(tier_override, tier) AS tier, status, booked_at, call_at, closer_id, COALESCE(utm_campaign, ft_campaign) AS campaign, booking_cancelled_at FROM leads WHERE booked_at BETWEEN ? AND ? ORDER BY booked_at DESC LIMIT 60';
      const args = upcoming ? [now, now + 14 * 86_400_000] : [r.from, r.to];
      const { results } = await db.prepare(sql).bind(...args).all<Record<string, unknown> & Lead>();
      const reps = new Map(rt.reps.map((x) => [x.id, x.name]));
      const rows = results.map((l) => ({ name: name(l), tier: l.tier, status: l.status, booked: iso(l.booked_at, tz), call: iso(l.call_at, tz), closer: reps.get(String(l.closer_id)) ?? l.closer_id ?? null, campaign: l.campaign, cancelled: Boolean(l.booking_cancelled_at), link: `/admin#lead=${l.id}` }));
      return { result: { window: upcoming ? 'next 14 days' : r.label, count: rows.length, calls: rows }, summary: `${rows.length} ${upcoming ? 'upcoming calls' : `bookings, ${r.label.toLowerCase()}`}`, sources: [SOURCES.sales] };
    }
    case 'deals': {
      const r = rangeFrom(input, tz, now);
      const s = await salesStats(rt.env, r.from, r.to, tz);
      const won = await db.prepare("SELECT id, first_name, last_name, ref_code, revenue, cash_collected, closed_at, closer_id FROM leads WHERE status = 'won' AND closed_at BETWEEN ? AND ? ORDER BY closed_at DESC LIMIT 30").bind(r.from, r.to).all<Record<string, unknown> & Lead>();
      return {
        result: { range: r.label, totals: s.totals, by_closer: s.leaderboard.map((x: Record<string, unknown>) => ({ closer: x.name ?? x.rep, booked: x.booked, held: x.held, no_shows: x.no_shows, won: x.won, lost: x.lost, revenue: x.revenue, cash: x.cash, commission: x.commission })), closed: won.results.map((l) => ({ name: name(l), revenue: l.revenue, cash: l.cash_collected, closed: iso(l.closed_at as number, tz), link: `/admin#lead=${l.id}` })), lost_reasons: s.lostReasons },
        summary: `${s.totals.won} won, ${s.totals.lost} lost, revenue ${Math.round(s.totals.revenue)}`,
        sources: [SOURCES.sales],
      };
    }
    case 'ad_performance': {
      const r = rangeFrom(input, tz, now);
      const p = priorOf(r);
      const [a, b] = await Promise.all([byCampaign(rt, r), byCampaign(rt, p)]);
      const bmap = new Map(b.map((x) => [x.campaign, x]));
      const campaigns = a.slice(0, 40).map((x) => ({ ...x, before: bmap.get(x.campaign) ?? null }));
      const ads = typeof input.campaign === 'string' && input.campaign.trim() ? await byContent(rt, r, input.campaign.trim()) : undefined;
      const synced = await db.prepare("SELECT value FROM settings WHERE key = '_meta_ads_synced_at'").first<{ value: string }>().catch(() => null);
      return { result: { range: r.label, note: 'Spend is per calendar day (UTC) as synced from Meta or typed in; visitors and leads are matched on utm_campaign.', spend_synced_at: synced ? iso(Number(synced.value), tz) : null, campaigns, ads }, summary: `${a.length} campaigns`, sources: [SOURCES.traffic] };
    }
    case 'event_stats': {
      const r = rangeFrom(input, tz, now);
      const safe = <T,>(p: Promise<T>, d: T) => p.catch((e) => { console.error('ops event_stats', e); return d; });
      const [web, lives, cohorts] = await Promise.all([
        safe(db.prepare("SELECT COUNT(*) AS registrations, SUM(joined_at IS NOT NULL) AS attended_live, SUM(joined_at IS NULL AND replay_at IS NOT NULL) AS replay_only FROM webinar_registrations WHERE created_at BETWEEN ? AND ?").bind(r.from, r.to).first<Record<string, number>>(), null),
        safe(db.prepare(`SELECT w.id, w.title, w.starts_at, w.status, COUNT(g.id) AS registrations, SUM(g.joined_at IS NOT NULL) AS joined, SUM(g.offer_clicked_at IS NOT NULL) AS offer_clicks,
                           (SELECT COUNT(*) FROM webinar_passes p WHERE p.kind = 'deposit' AND p.status IN ('paid', 'refunded') AND p.ref_id = w.id) AS deposits
                      FROM live_webinars w LEFT JOIN live_webinar_regs g ON g.event_id = w.id WHERE w.starts_at BETWEEN ? AND ? GROUP BY w.id ORDER BY w.starts_at`).bind(r.from - 30 * 86_400_000, r.to + 30 * 86_400_000).all<Record<string, unknown>>().then((x) => x.results), []),
        safe(db.prepare(`SELECT c.id, c.name, c.start_date, c.status, SUM(g.status = 'paid') AS paid, SUM(g.vip) AS vip,
                           (SELECT COUNT(*) FROM challenge_deposits d WHERE d.cohort_id = c.id AND d.paid_at IS NOT NULL) AS deposits
                      FROM challenge_cohorts c LEFT JOIN challenge_registrations g ON g.cohort_id = c.id GROUP BY c.id ORDER BY c.start_date DESC LIMIT 6`).all<Record<string, unknown>>().then((x) => x.results), []),
      ]);
      const snap = await snapshot(rt, r);
      return {
        result: { range: r.label, masterclass: { ...(web ?? {}), tickets: snap.tickets.value, sprint_sales: snap.sprint_sales.value, sprint_revenue: fmt(snap.sprint_revenue) }, live_webinars_near_range: lives.map((x) => ({ ...x, starts: iso(Number(x.starts_at), tz), starts_at: undefined })), challenge_cohorts: cohorts, deposits_in_range: snap.deposits.value, deposit_revenue: fmt(snap.deposit_revenue) },
        summary: `${n(web?.registrations)} masterclass registrations, ${lives.length} live webinars, ${cohorts.length} cohorts`,
        sources: [SOURCES.webinar, SOURCES.liveevents, SOURCES.challenge],
      };
    }
    case 'sprint_board': {
      const { results } = await db.prepare(`SELECT d.pass_id, d.lead_id, d.kickoff_booked_at, d.kickoff_held_at, d.plan_booked_at, d.plan_held_at, d.outcome, d.created_at, l.first_name, l.last_name, l.ref_code
                                              FROM deal_sprints d LEFT JOIN leads l ON l.id = d.lead_id ORDER BY d.created_at DESC LIMIT 40`).all<Record<string, unknown> & Lead>().catch(() => ({ results: [] as (Record<string, unknown> & Lead)[] }));
      const rows = results.map((d) => ({ name: name(d), day: Math.min(7, Math.floor((now - Number(d.created_at)) / 86_400_000) + 1), kickoff: d.kickoff_held_at ? 'held' : d.kickoff_booked_at ? 'booked' : 'not booked', deal_plan: d.plan_held_at ? 'held' : d.plan_booked_at ? 'booked' : 'not booked', outcome: d.outcome ?? null, started: iso(Number(d.created_at), tz), link: `/admin#lead=${d.lead_id}` }));
      const counts = { buyers: rows.length, in_progress: rows.filter((x) => !x.outcome && x.day <= 7).length, plan_held: rows.filter((x) => x.deal_plan === 'held').length, signed: rows.filter((x) => x.outcome === 'signed').length, proposal_sent: rows.filter((x) => x.outcome === 'proposal_sent').length };
      return { result: { counts, buyers: rows }, summary: `${counts.buyers} Sprint buyers, ${counts.in_progress} in progress`, sources: [SOURCES.dealsprint] };
    }
    case 'email_stats': {
      const r = rangeFrom(input, tz, now);
      const s = await emailStats(rt.env, { from: r.from, to: r.to, tzOffsetMin: 0 });
      const bySeq = new Map<string, { sent: number; opened: number; clicked: number; failed: number; skipped: number; simulated: number }>();
      for (const t of s.templates as Record<string, unknown>[]) {
        const k = String(t.sequence);
        const x = bySeq.get(k) ?? { sent: 0, opened: 0, clicked: 0, failed: 0, skipped: 0, simulated: 0 };
        x.sent += n(t.sent); x.opened += n(t.opened); x.clicked += n(t.clicked); x.failed += n(t.failed); x.skipped += n(t.skipped); x.simulated += n(t.simulated);
        bySeq.set(k, x);
      }
      const sequences = [...bySeq.entries()].map(([sequence, x]) => ({ sequence, ...x, open_rate: x.sent - x.simulated > 0 ? Math.round((x.opened / (x.sent - x.simulated)) * 100) / 100 : null })).sort((a, b) => b.sent - a.sent);
      return { result: { range: r.label, note: 'simulated = written but not sent (no email key at the time)', sequences, queued: s.queue, recent_failures: (s.failures as unknown[]).length }, summary: `${sequences.reduce((a, x) => a + x.sent, 0)} emails sent`, sources: [SOURCES.emails] };
    }
    case 'live_visitors': {
      const l = await live(rt.env, { window: '1h', limit: 20 });
      return { result: { active_now: l.active, active_pages: l.activePages, last_hour: l.totals, top_pages_last_hour: l.pages }, summary: `${l.active} on the site now`, sources: [SOURCES.live] };
    }
    case 'activity_log': {
      const rows = await listActions(rt, { dept: typeof input.dept === 'string' ? input.dept : undefined, status: typeof input.status === 'string' ? input.status : undefined, limit: Math.min(50, Number(input.limit) || 20) });
      return { result: rows.map((a) => ({ id: a.id, dept: a.dept, kind: a.kind, summary: a.summary, status: a.status, actor: a.actor, result: a.result, at: iso(a.created_at, tz) })), summary: `${rows.length} log entries`, sources: [SOURCES.command] };
    }
    case 'propose_action': {
      const dept = (DEPTS as readonly string[]).includes(String(input.dept)) ? (input.dept as Dept) : 'chief';
      const risk: Risk = ['low', 'medium', 'high'].includes(String(input.risk)) ? (input.risk as Risk) : 'medium';
      const kind = String(input.kind ?? '').trim().slice(0, 80) || `${dept}.task`;
      const id = await proposeAction(rt, { dept, kind, summary: String(input.summary ?? '').slice(0, 300) || kind, detail: String(input.detail ?? '').slice(0, 4000), payload: input.payload ?? {}, risk, source: `chat:${ctx.threadId}` }, now);
      const row = await rt.env.DB.prepare('SELECT status, result FROM ops_actions WHERE id = ?').bind(id).first<{ status: string; result: string | null }>();
      const known = handlerKinds().some((h) => h.kind === kind);
      return { result: { id, status: row?.status, result: row?.result ?? null, carried_out_automatically_on_approval: known, approvals: '/admin#command/approvals' }, summary: row?.status === 'proposed' ? `Waiting for approval: ${String(input.summary ?? kind)}` : `Ran (auto): ${row?.result ?? ''}`, sources: [{ label: 'Approvals', href: '/admin#command/approvals' }] };
    }
    case 'create_document': {
      const id = await saveDocument(rt, { title: String(input.title ?? 'Document'), body: String(input.markdown ?? ''), kind: 'custom', threadId: ctx.threadId }, now);
      return { result: { id, link: `/admin#command/docs`, download: `/admin/api/ops/documents/${id}.md` }, summary: `Saved document "${String(input.title ?? 'Document').slice(0, 60)}"`, sources: [{ label: 'Documents', href: '/admin#command/docs' }] };
    }
    default:
      return { result: { error: `Unknown tool ${toolName}` }, summary: 'Unknown tool', sources: [] };
  }
}

function uniq(s: Source[]) { const seen = new Set<string>(); return s.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true))); }
