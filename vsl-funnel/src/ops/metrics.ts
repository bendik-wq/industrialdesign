import type { Runtime } from '../app';
import { ECONOMICS } from '../config';
import { fromMinor } from '../webinar/pass';

/**
 * Key business numbers for any time range, each with the Funnel HQ view it comes from.
 * The brief, the alerts, documents and the chat's funnel_stats tool all read these and nothing else,
 * so every number they show is a count or sum over our own tables (no estimates, no made-up figures).
 */
export type MetricKind = 'count' | 'money' | 'rate' | 'cost';
export interface Source { label: string; href: string }
export interface Metric { key: MetricKey; label: string; value: number | null; kind: MetricKind; source: Source; currency?: string; num?: number; den?: number }

export const SOURCES = {
  overview: { label: 'Overview', href: '/admin#overview' },
  leads: { label: 'Leads', href: '/admin#leads' },
  application: { label: 'Application', href: '/admin#application' },
  webinar: { label: 'Webinar', href: '/admin#webinar' },
  liveevents: { label: 'Live webinars', href: '/admin#liveevents' },
  challenge: { label: 'Challenge', href: '/admin#challenge' },
  sales: { label: 'Calls & deals', href: '/admin#sales' },
  dealsprint: { label: 'Sprint board', href: '/admin#dealsprint' },
  traffic: { label: 'Traffic & ads', href: '/admin#traffic' },
  emails: { label: 'Emails', href: '/admin#emails' },
  live: { label: 'Live', href: '/admin#live' },
  command: { label: 'Command', href: '/admin#command' },
} satisfies Record<string, Source>;

export const METRIC_KEYS = [
  'visitors', 'leads', 'applications', 'webinar_regs', 'live_regs', 'challenge_regs', 'tickets', 'bookings', 'calls_held', 'no_shows', 'show_rate',
  'deals', 'revenue', 'sprint_sales', 'sprint_revenue', 'deposits', 'deposit_revenue', 'ad_spend', 'cpl', 'cpa',
] as const;
export type MetricKey = (typeof METRIC_KEYS)[number];
export type Snapshot = Record<MetricKey, Metric>;

/** Raw counts and sums for a range: what the queries return, before labels and ratios. */
export interface RawCounts {
  visitors: number; leads: number; applications: number; webinar_regs: number; live_regs: number; challenge_regs: number; tickets: number;
  bookings: number; calls_held: number; no_shows: number; deals: number; revenue: number; sprint_sales: number; sprint_revenue: number;
  deposits: number; deposit_revenue: number; ad_spend: number; pass_currency: string; ad_currency: string | null;
}

const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
/**
 * Ad spend is stored per calendar day (UTC). A range takes the days whose midday falls inside it, so back-to-back
 * ranges never count the same day twice (a 24-hour window gets one day, 7 days get seven).
 */
export function spendDays(from: number, to: number): [string, string] {
  const D = 86_400_000;
  let first = Date.parse(`${ymd(from)}T12:00:00Z`);
  if (first < from) first += D;
  let last = Date.parse(`${ymd(to)}T12:00:00Z`);
  if (last >= to) last -= D;
  return last < first ? ['9999-12-31', '0000-01-01'] : [ymd(first), ymd(last)];
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/** Every count for one range (one query per table; tables a fresh install lacks count as 0). */
export async function rawCounts(rt: Runtime, r: { from: number; to: number }): Promise<RawCounts> {
  const db = rt.env.DB;
  const one = async (sql: string, args: (string | number)[]) => {
    try { return (await db.prepare(sql).bind(...args).first<Record<string, unknown>>()) ?? {}; } catch (e) { console.error('ops metric', e); return {}; }
  };
  const many = async (sql: string, args: (string | number)[]) => {
    try { return (await db.prepare(sql).bind(...args).all<Record<string, unknown>>()).results; } catch (e) { console.error('ops metric', e); return []; }
  };
  const F = r.from, T = r.to;
  const [vis, leads, apps, wreg, lreg, creg, seat, cticket, book, calls, deals, passes, spend] = await Promise.all([
    one('SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE started_at BETWEEN ? AND ? AND is_bot = 0', [F, T]),
    one('SELECT COUNT(*) AS n FROM leads WHERE created_at BETWEEN ? AND ?', [F, T]),
    one('SELECT COUNT(*) AS n FROM leads WHERE app_completed_at BETWEEN ? AND ?', [F, T]),
    one('SELECT COUNT(*) AS n FROM webinar_registrations WHERE created_at BETWEEN ? AND ?', [F, T]),
    one('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE created_at BETWEEN ? AND ?', [F, T]),
    one("SELECT COUNT(*) AS n FROM challenge_registrations WHERE paid_at BETWEEN ? AND ? AND status IN ('paid', 'refunded')", [F, T]),
    one("SELECT COUNT(*) AS n FROM webinar_passes WHERE kind IN ('seat', 'live_ticket') AND status IN ('paid', 'refunded') AND paid_at BETWEEN ? AND ?", [F, T]),
    one("SELECT COUNT(*) AS n FROM challenge_orders WHERE kind = 'ticket' AND status IN ('paid', 'refunded') AND paid_at BETWEEN ? AND ?", [F, T]),
    one('SELECT COUNT(*) AS n FROM leads WHERE booked_at BETWEEN ? AND ? AND booking_cancelled_at IS NULL', [F, T]),
    one("SELECT SUM(status IN ('showed', 'won', 'lost')) AS held, SUM(status = 'no_show') AS no_show FROM leads WHERE booked_at IS NOT NULL AND booking_cancelled_at IS NULL AND call_at BETWEEN ? AND ?", [F, T]),
    one("SELECT COUNT(*) AS n, COALESCE(SUM(revenue), 0) AS revenue FROM leads WHERE status = 'won' AND closed_at BETWEEN ? AND ?", [F, T]),
    many("SELECT kind, currency, COUNT(*) AS n, COALESCE(SUM(amount - refunded_amount), 0) AS amount FROM webinar_passes WHERE kind IN ('offer', 'deposit') AND status IN ('paid', 'refunded') AND paid_at BETWEEN ? AND ? GROUP BY 1, 2", [F, T]),
    one('SELECT COALESCE(SUM(spend), 0) AS spend, MAX(currency) AS currency FROM ad_spend WHERE day BETWEEN ? AND ?', spendDays(F, T)),
  ]);
  const sumKind = (k: string) => passes.filter((p) => p.kind === k).reduce<{ n: number; amount: number }>((a, p) => ({ n: a.n + num(p.n), amount: a.amount + fromMinor(num(p.amount), String(p.currency || 'usd')) }), { n: 0, amount: 0 });
  const offer = sumKind('offer'), dep = sumKind('deposit');
  const cur = String(passes.find((p) => p.currency)?.currency ?? 'usd').toUpperCase();
  return {
    visitors: num(vis.n), leads: num(leads.n), applications: num(apps.n), webinar_regs: num(wreg.n), live_regs: num(lreg.n), challenge_regs: num(creg.n),
    tickets: num(seat.n) + num(cticket.n), bookings: num(book.n), calls_held: num(calls.held), no_shows: num(calls.no_show), deals: num(deals.n), revenue: num(deals.revenue),
    sprint_sales: offer.n, sprint_revenue: offer.amount, deposits: dep.n, deposit_revenue: dep.amount, ad_spend: num(spend.spend),
    pass_currency: cur, ad_currency: spend.currency ? String(spend.currency).toUpperCase() : null,
  };
}

/** Labels, sources and ratios over the raw counts (pure, so tests can trace every number). */
export function toSnapshot(c: RawCounts): Snapshot {
  const S = SOURCES;
  const deal = ECONOMICS.currency;
  const ad = c.ad_currency ?? deal;
  const ratio = (a: number, b: number) => (b > 0 ? a / b : null);
  const m = (key: MetricKey, label: string, value: number | null, kind: MetricKind, source: Source, extra: Partial<Metric> = {}): Metric => ({ key, label, value, kind, source, ...extra });
  return {
    visitors: m('visitors', 'Visitors', c.visitors, 'count', S.overview),
    leads: m('leads', 'Sign-ups (new leads)', c.leads, 'count', S.leads),
    applications: m('applications', 'Applications', c.applications, 'count', S.application),
    webinar_regs: m('webinar_regs', 'Masterclass registrations', c.webinar_regs, 'count', S.webinar),
    live_regs: m('live_regs', 'Live webinar registrations', c.live_regs, 'count', S.liveevents),
    challenge_regs: m('challenge_regs', 'Challenge registrations (paid)', c.challenge_regs, 'count', S.challenge),
    tickets: m('tickets', 'Tickets sold', c.tickets, 'count', S.webinar),
    bookings: m('bookings', 'Calls booked', c.bookings, 'count', S.sales),
    calls_held: m('calls_held', 'Calls held', c.calls_held, 'count', S.sales),
    no_shows: m('no_shows', 'No-shows', c.no_shows, 'count', S.sales),
    show_rate: m('show_rate', 'Show rate', ratio(c.calls_held, c.calls_held + c.no_shows), 'rate', S.sales, { num: c.calls_held, den: c.calls_held + c.no_shows }),
    deals: m('deals', 'Deals won', c.deals, 'count', S.sales),
    revenue: m('revenue', 'Deal revenue', c.revenue, 'money', S.sales, { currency: deal }),
    sprint_sales: m('sprint_sales', 'Sprint sales', c.sprint_sales, 'count', S.dealsprint),
    sprint_revenue: m('sprint_revenue', 'Sprint revenue (net of refunds)', c.sprint_revenue, 'money', S.dealsprint, { currency: c.pass_currency }),
    deposits: m('deposits', 'Engagement deposits', c.deposits, 'count', S.liveevents),
    deposit_revenue: m('deposit_revenue', 'Deposit revenue (net of refunds)', c.deposit_revenue, 'money', S.liveevents, { currency: c.pass_currency }),
    ad_spend: m('ad_spend', 'Ad spend', c.ad_spend, 'money', S.traffic, { currency: ad }),
    cpl: m('cpl', 'Cost per lead', c.ad_spend > 0 ? ratio(c.ad_spend, c.leads) : null, 'cost', S.traffic, { currency: ad, num: c.ad_spend, den: c.leads }),
    cpa: m('cpa', 'Cost per booked call', c.ad_spend > 0 ? ratio(c.ad_spend, c.bookings) : null, 'cost', S.traffic, { currency: ad, num: c.ad_spend, den: c.bookings }),
  };
}

export async function snapshot(rt: Runtime, r: { from: number; to: number }) {
  return toSnapshot(await rawCounts(rt, r));
}

/** One number the way every surface prints it. */
export function fmt(m: Pick<Metric, 'value' | 'kind' | 'currency'>): string {
  if (m.value == null || !Number.isFinite(m.value)) return 'n/a';
  if (m.kind === 'rate') return `${Math.round(m.value * 100)}%`;
  if (m.kind === 'money' || m.kind === 'cost') {
    const cur = m.currency || 'USD';
    const digits = m.kind === 'cost' && Math.abs(m.value) < 100 ? 2 : 0;
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: digits, minimumFractionDigits: digits }).format(m.value); } catch { return `${cur} ${m.value.toFixed(digits)}`; }
  }
  return new Intl.NumberFormat('en-US').format(Math.round(m.value));
}

/** Relative change, or null when there is no base to compare with. */
export const change = (cur: number | null, prior: number | null) => (cur == null || prior == null || prior === 0 ? null : (cur - prior) / prior);
export const fmtChange = (c: number | null) => (c == null ? 'new' : `${c >= 0 ? '+' : ''}${Math.round(c * 100)}%`);

// ───────────── per campaign and per ad (utm_content) ─────────────

export interface CampaignRow { campaign: string; visitors: number; leads: number; bookings: number; spend: number; cpl: number | null; cpa: number | null; currency: string | null }

/** Traffic, sign-ups, bookings and spend per campaign (matched on utm_campaign = campaign name or id, as Traffic & ads does). */
export async function byCampaign(rt: Runtime, r: { from: number; to: number }): Promise<CampaignRow[]> {
  const db = rt.env.DB;
  const safe = async <T,>(p: Promise<{ results: T[] }>) => { try { return (await p).results; } catch (e) { console.error('ops campaign', e); return [] as T[]; } };
  const [vis, leads, books, spend] = await Promise.all([
    safe(db.prepare('SELECT lower(utm_campaign) AS c, COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE utm_campaign IS NOT NULL AND is_bot = 0 AND started_at BETWEEN ? AND ? GROUP BY 1').bind(r.from, r.to).all<{ c: string; n: number }>()),
    safe(db.prepare('SELECT lower(COALESCE(utm_campaign, ft_campaign)) AS c, COUNT(*) AS n FROM leads WHERE COALESCE(utm_campaign, ft_campaign) IS NOT NULL AND created_at BETWEEN ? AND ? GROUP BY 1').bind(r.from, r.to).all<{ c: string; n: number }>()),
    safe(db.prepare('SELECT lower(COALESCE(utm_campaign, ft_campaign)) AS c, COUNT(*) AS n FROM leads WHERE COALESCE(utm_campaign, ft_campaign) IS NOT NULL AND booked_at BETWEEN ? AND ? AND booking_cancelled_at IS NULL GROUP BY 1').bind(r.from, r.to).all<{ c: string; n: number }>()),
    safe(db.prepare('SELECT campaign_id, MAX(campaign_name) AS name, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_spend WHERE day BETWEEN ? AND ? GROUP BY 1').bind(...spendDays(r.from, r.to)).all<{ campaign_id: string; name: string | null; spend: number; currency: string | null }>()),
  ]);
  const rows = new Map<string, CampaignRow>();
  const get = (c: string) => { let x = rows.get(c); if (!x) { x = { campaign: c, visitors: 0, leads: 0, bookings: 0, spend: 0, cpl: null, cpa: null, currency: null }; rows.set(c, x); } return x; };
  for (const v of vis) get(v.c).visitors = num(v.n);
  for (const l of leads) get(l.c).leads = num(l.n);
  for (const b of books) get(b.c).bookings = num(b.n);
  for (const s of spend) {
    const name = (s.name ?? '').trim().toLowerCase(), id = s.campaign_id.trim().toLowerCase();
    const key = rows.has(name) ? name : rows.has(id) ? id : name || id;
    const x = get(key);
    x.spend += num(s.spend);
    x.currency = s.currency ? s.currency.toUpperCase() : x.currency;
  }
  for (const x of rows.values()) { x.cpl = x.spend > 0 && x.leads > 0 ? x.spend / x.leads : null; x.cpa = x.spend > 0 && x.bookings > 0 ? x.spend / x.bookings : null; }
  return [...rows.values()].sort((a, b) => b.spend - a.spend || b.leads - a.leads);
}

/** Sign-ups and bookings per ad / angle (utm_content), optionally inside one campaign. */
export async function byContent(rt: Runtime, r: { from: number; to: number }, campaign?: string) {
  const where = campaign ? ' AND lower(COALESCE(utm_campaign, ft_campaign)) = ?' : '';
  const args: (string | number)[] = campaign ? [r.from, r.to, campaign.toLowerCase()] : [r.from, r.to];
  try {
    const { results } = await rt.env.DB.prepare(
      `SELECT lower(utm_content) AS content, COUNT(*) AS leads, SUM(booked_at IS NOT NULL AND booking_cancelled_at IS NULL) AS bookings
         FROM leads WHERE utm_content IS NOT NULL AND created_at BETWEEN ? AND ?${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 50`,
    ).bind(...args).all<{ content: string; leads: number; bookings: number }>();
    return results.map((x) => ({ content: x.content, leads: num(x.leads), bookings: num(x.bookings) }));
  } catch { return []; }
}
