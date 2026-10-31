import type { Runtime } from '../app';
import { fromMinor } from '../webinar/pass';
import { edition, type EditionName } from '../webinar/editions';
import { type Funnel, FUNNELS, PAID_KINDS, type TouchRow } from './capture';
import { STAGES } from './stages';

/**
 * Funnel HQ → Webinar attribution. Every number comes from attr_conversions / attr_stages / attr_touches (and
 * the funnels' own tables for the rooms), ad spend from the existing Meta spend syncs. Nothing is estimated:
 * a row with no data says so, and spend-based ratios are null when either side is missing.
 */

export type FunnelSel = Funnel | 'all';
export type Model = 'first' | 'last' | 'linear';
export type Dim = 'platform' | 'channel' | 'source' | 'campaign' | 'adset' | 'ad' | 'link' | 'landing' | 'edition';
export const DIMS: Dim[] = ['platform', 'channel', 'source', 'campaign', 'adset', 'ad', 'link', 'landing', 'edition'];
export const MODELS: Model[] = ['first', 'last', 'linear'];

export interface Range { from: number; to: number }
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export const parseFunnel = (v: unknown): FunnelSel => (v === 'auto' || v === 'live' || v === 'challenge' ? v : 'all');
export const parseModel = (v: unknown): Model => (v === 'first' || v === 'linear' ? v : 'last');
export const parseDim = (v: unknown): Dim => (DIMS.includes(v as Dim) ? (v as Dim) : 'campaign');
const funnels = (f: FunnelSel): Funnel[] => (f === 'all' ? FUNNELS : [f]);
const fIn = (f: FunnelSel) => funnels(f).map((x) => `'${x}'`).join(', ');

// ───────────── stage funnel (also the Funnel map contract) ─────────────

/**
 * Stage counts for people who registered in the range (a cohort funnel: each later stage counts the same people).
 * visit = distinct visitors to the funnel's registration page in the range. revenue = net of refunds, for money stages.
 */
export async function stageCounts(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range) {
  const db = rt.env.DB;
  const [visits, counts, money] = await Promise.all([
    db.prepare(`SELECT COUNT(DISTINCT funnel||visitor_id) AS n FROM attr_visits WHERE funnel IN (${fIn(f)}) AND ts BETWEEN ? AND ?`).bind(r.from, r.to).first<{ n: number }>(),
    db.prepare(
      `SELECT s.stage, COUNT(DISTINCT s.reg_id) AS n FROM attr_stages s
        WHERE s.funnel IN (${fIn(f)}) AND s.reg_id IN (SELECT reg_id FROM attr_stages WHERE stage = 'registered' AND funnel IN (${fIn(f)}) AND ts BETWEEN ? AND ?)
        GROUP BY s.stage`,
    ).bind(r.from, r.to).all<{ stage: string; n: number }>(),
    db.prepare(
      `SELECT c.kind, c.currency, SUM(c.amount - c.refunded) AS net, SUM(c.refunded) AS refunded FROM attr_conversions c
        WHERE c.funnel IN (${fIn(f)}) AND c.kind != 'registered'
          AND c.reg_id IN (SELECT reg_id FROM attr_stages WHERE stage = 'registered' AND funnel IN (${fIn(f)}) AND ts BETWEEN ? AND ?)
        GROUP BY c.kind, c.currency`,
    ).bind(r.from, r.to).all<{ kind: string; currency: string | null; net: number; refunded: number }>(),
  ]);
  const by = new Map(counts.results.map((x) => [x.stage, x.n]));
  by.set('visit', visits?.n ?? 0);
  const rev = new Map<string, number>();
  const main = primaryCurrency(money.results.map((m) => ({ currency: m.currency, net: m.net })));
  for (const m of money.results) if ((m.currency ?? main) === main) rev.set(m.kind, (rev.get(m.kind) ?? 0) + fromMinor(m.net, main ?? 'USD'));
  const refunded = money.results.filter((m) => (m.currency ?? main) === main).reduce((a, m) => a + fromMinor(m.refunded, main ?? 'USD'), 0);
  const fs = funnels(f);
  const registered = by.get('registered') ?? 0;
  const stages = STAGES.filter((s) => s.id !== 'refund').map((s) => {
    const applies = s.funnels.some((x) => fs.includes(x));
    const count = by.get(s.id) ?? 0;
    return {
      id: s.id, label: s.label, count, applies,
      ...(s.money ? { revenue: rev.get(s.id) ?? 0 } : {}),
      rate: s.id === 'visit' || s.id === 'registered' || !registered ? null : count / registered,
    };
  });
  return { stages, currency: main, refunded, registered };
}

/** GET /admin/api/attribution/stages: exactly { stages: [{ id, label, count, revenue? }] } with the contract's ids. */
export async function stagesContract(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range) {
  const { stages } = await stageCounts(rt, f, r);
  return { stages: stages.filter((s) => STAGES.find((d) => d.id === s.id)?.contract).map((s) => ({ id: s.id, label: s.label, count: s.count, ...('revenue' in s ? { revenue: s.revenue } : {}) })) };
}

// ───────────── revenue attribution ─────────────

interface ConvRow extends Record<string, unknown> {
  id: string; kind: string; funnel: Funnel; reg_id: string | null; lead_id: string; occurred_at: number; amount: number; refunded: number; currency: string | null; edition: string | null; cohort_ref: string | null;
}
type TouchLike = Partial<TouchRow>;

export function primaryCurrency(rows: { currency: string | null; net: number }[]) {
  const tot = new Map<string, number>();
  for (const r of rows) if (r.currency) tot.set(r.currency, (tot.get(r.currency) ?? 0) + Math.abs(r.net));
  return [...tot.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

const NOT_TRACKED = 'Not tracked';
const NONE = '(none)';
export function dimValue(t: TouchLike | null, dim: Dim, editionOf?: string | null): string {
  if (dim === 'edition') return editionOf ?? 'Not recorded';
  if (!t) return NOT_TRACKED;
  const v = dim === 'platform' ? t.platform : dim === 'channel' ? t.channel : dim === 'source' ? t.source : dim === 'campaign' ? (t.campaign_id ?? t.campaign)
    : dim === 'adset' ? t.adset_id : dim === 'ad' ? t.ad_id : dim === 'link' ? t.link_code : t.landing;
  return v ? String(v) : NONE;
}
const touchOf = (c: Record<string, unknown>, p: 'ft' | 'lt'): TouchLike | null => {
  if (c[`${p}_ts`] == null && c[`${p}_source`] == null && c[`${p}_campaign`] == null && c[`${p}_ad_id`] == null) return null;
  const o: Record<string, unknown> = {};
  for (const k of ['ts', 'channel', 'platform', 'source', 'medium', 'campaign', 'content', 'term', 'link_code', 'ad_id', 'adset_id', 'campaign_id', 'click_type', 'landing', 'referrer_host', 'device', 'country']) o[k] = c[`${p}_${k}`];
  return o as TouchLike;
};

/** Splits one conversion's value across dimension values under a model. The shares always add up to 1. */
export function credit(c: Record<string, unknown>, model: Model, dim: Dim, path: TouchLike[], editionOf?: string | null): Map<string, number> {
  const out = new Map<string, number>();
  if (dim === 'edition') { out.set(dimValue(null, dim, editionOf), 1); return out; }
  if (model === 'linear') {
    if (!path.length) { out.set(dimValue(touchOf(c, 'lt') ?? touchOf(c, 'ft'), dim), 1); return out; }
    for (const t of path) { const k = dimValue(t, dim); out.set(k, (out.get(k) ?? 0) + 1 / path.length); }
    return out;
  }
  out.set(dimValue(touchOf(c, model === 'first' ? 'ft' : 'lt'), dim), 1);
  return out;
}

async function spendMaps(rt: Pick<Runtime, 'env'>, r: Range) {
  const db = rt.env.DB;
  const d0 = new Date(r.from).toISOString().slice(0, 10), d1 = new Date(r.to).toISOString().slice(0, 10);
  const [camp, ad, adset, names] = await Promise.all([
    db.prepare('SELECT campaign_id, MAX(campaign_name) AS name, SUM(spend) AS spend, MAX(currency) AS currency FROM ad_spend WHERE day BETWEEN ? AND ? GROUP BY campaign_id').bind(d0, d1).all<{ campaign_id: string; name: string | null; spend: number; currency: string | null }>().catch(() => ({ results: [] })),
    db.prepare('SELECT ad_id AS id, MAX(ad_name) AS name, SUM(spend) AS spend FROM ad_insights WHERE day BETWEEN ? AND ? GROUP BY ad_id').bind(d0, d1).all<{ id: string; name: string | null; spend: number }>().catch(() => ({ results: [] })),
    db.prepare('SELECT adset_id AS id, SUM(spend) AS spend FROM ad_insights WHERE day BETWEEN ? AND ? AND adset_id IS NOT NULL GROUP BY adset_id').bind(d0, d1).all<{ id: string; spend: number }>().catch(() => ({ results: [] })),
    db.prepare('SELECT id, level, name FROM ad_entities').all<{ id: string; level: string; name: string | null }>().catch(() => ({ results: [] })),
  ]);
  const name = new Map<string, string>();
  for (const e of names.results) if (e.name) name.set(e.id, e.name);
  for (const a of ad.results) if (a.name && !name.has(a.id)) name.set(a.id, a.name);
  for (const c of camp.results) if (c.name && !name.has(c.campaign_id)) name.set(c.campaign_id, c.name);
  const campaign = new Map<string, number>();
  for (const c of camp.results) {
    campaign.set(c.campaign_id, (campaign.get(c.campaign_id) ?? 0) + (c.spend || 0));
    // utm_campaign={{campaign.name}} lands as the name: match spend by name too.
    if (c.name) campaign.set(`name:${c.name.toLowerCase()}`, (campaign.get(`name:${c.name.toLowerCase()}`) ?? 0) + (c.spend || 0));
  }
  return {
    name,
    currency: camp.results.find((c) => c.currency)?.currency ?? null,
    spendFor(dim: Dim, key: string): number | null {
      if (dim === 'ad') return ad.results.find((a) => a.id === key)?.spend ?? null;
      if (dim === 'adset') return adset.results.find((a) => a.id === key)?.spend ?? null;
      if (dim === 'campaign') return campaign.get(key) ?? campaign.get(`name:${key.toLowerCase()}`) ?? null;
      return null;
    },
    total: camp.results.reduce((a, c) => a + (c.spend || 0), 0),
  };
}

/** Revenue (net of refunds) by a dimension under a model, with registrants, attendees, buyers, cost and ROAS. */
export async function revenueBy(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range, model: Model, dim: Dim) {
  const db = rt.env.DB;
  const conv = await db.prepare(
    `SELECT c.*, (SELECT e.edition FROM attr_conversions e WHERE e.kind = 'registered' AND e.ref_id = c.reg_id) AS reg_edition,
            EXISTS (SELECT 1 FROM attr_stages s WHERE s.reg_id = c.reg_id AND s.stage = 'attended') AS attended
       FROM attr_conversions c WHERE c.funnel IN (${fIn(f)}) AND c.occurred_at BETWEEN ? AND ? ORDER BY c.occurred_at`,
  ).bind(r.from, r.to).all<ConvRow & { reg_edition: string | null; attended: number }>();
  const rows = conv.results;
  const leads = [...new Set(rows.map((c) => c.lead_id))];
  const paths = new Map<string, TouchLike[]>();
  if (model === 'linear' && leads.length) {
    for (let i = 0; i < leads.length; i += 80) {
      const part = leads.slice(i, i + 80);
      const t = await db.prepare(`SELECT * FROM attr_touches WHERE lead_id IN (${part.map(() => '?').join(',')}) ORDER BY ts`).bind(...part).all<TouchRow>();
      for (const x of t.results) { const l = paths.get(x.lead_id) ?? []; l.push(x); paths.set(x.lead_id, l); }
    }
  }
  const currency = primaryCurrency(rows.filter((c) => c.kind !== 'registered').map((c) => ({ currency: c.currency, net: c.amount - c.refunded }))) ?? 'USD';
  const sp = await spendMaps(rt, r);
  type Agg = { key: string; revenue: number; refunded: number; registrants: number; attendees: number; buyers: number; buyerLeads: Set<string>; orders: number };
  const agg = new Map<string, Agg>();
  const get = (k: string) => { let a = agg.get(k); if (!a) agg.set(k, (a = { key: k, revenue: 0, refunded: 0, registrants: 0, attendees: 0, buyers: 0, buyerLeads: new Set(), orders: 0 })); return a; };
  let total = 0, refundedTotal = 0;
  const other = new Map<string, number>();
  for (const c of rows) {
    const path = model === 'linear' ? (paths.get(c.lead_id) ?? []).filter((t) => (t.ts ?? 0) <= c.occurred_at + 5000) : [];
    const shares = credit(c, model, dim, path, c.edition ?? c.reg_edition);
    if (c.kind === 'registered') {
      for (const [k, s] of shares) { const a = get(k); a.registrants += s; if (c.attended) a.attendees += s; }
      continue;
    }
    if ((c.currency ?? currency) !== currency) { other.set(c.currency!, (other.get(c.currency!) ?? 0) + fromMinor(c.amount - c.refunded, c.currency!)); continue; }
    const net = fromMinor(c.amount - c.refunded, currency);
    const ref = fromMinor(c.refunded, currency);
    total += net; refundedTotal += ref;
    for (const [k, s] of shares) {
      const a = get(k);
      a.revenue += net * s; a.refunded += ref * s; a.orders += s;
      if (c.amount - c.refunded > 0 && !a.buyerLeads.has(c.lead_id)) { a.buyerLeads.add(c.lead_id); a.buyers += s; }
    }
  }
  const out = [...agg.values()].map((a) => {
    const spend = a.key === NOT_TRACKED || a.key === NONE ? null : sp.spendFor(dim, a.key);
    const round = (x: number) => Math.round(x * 100) / 100;
    return {
      key: a.key, label: sp.name.get(a.key) ?? a.key,
      revenue: round(a.revenue), refunded: round(a.refunded), orders: round(a.orders), registrants: round(a.registrants), attendees: round(a.attendees), buyers: round(a.buyers),
      perRegistrant: a.registrants ? round(a.revenue / a.registrants) : null,
      spend: spend ?? null,
      costPerRegistrant: spend != null && a.registrants ? round(spend / a.registrants) : null,
      costPerAttendee: spend != null && a.attendees ? round(spend / a.attendees) : null,
      costPerBuyer: spend != null && a.buyers ? round(spend / a.buyers) : null,
      roas: spend ? round(a.revenue / spend) : null,
    };
  }).sort((a, b) => b.revenue - a.revenue || b.registrants - a.registrants);
  return {
    model, dim, currency, total: Math.round(total * 100) / 100, refunded: Math.round(refundedTotal * 100) / 100, rows: out,
    otherCurrencies: [...other.entries()].map(([cur, amount]) => ({ currency: cur, amount })),
    spendCurrency: sp.currency, spendTotal: sp.total || null,
  };
}

// ───────────── time to purchase and cohorts ─────────────

export async function timeToPurchase(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range) {
  const rows = await rt.env.DB.prepare(
    `SELECT c.kind, c.occurred_at - g.occurred_at AS gap FROM attr_conversions c JOIN attr_conversions g ON g.kind = 'registered' AND g.ref_id = c.reg_id
      WHERE c.funnel IN (${fIn(f)}) AND c.kind IN (${PAID_KINDS.map((k) => `'${k}'`).join(', ')}) AND c.occurred_at BETWEEN ? AND ? AND c.amount > c.refunded`,
  ).bind(r.from, r.to).all<{ kind: string; gap: number }>();
  const buckets = [
    { label: 'Within an hour', max: HOUR }, { label: 'Same day', max: DAY }, { label: '1 to 3 days', max: 3 * DAY }, { label: '4 to 7 days', max: 7 * DAY },
    { label: '8 to 30 days', max: 30 * DAY }, { label: 'Over 30 days', max: Infinity },
  ].map((b) => ({ ...b, n: 0 }));
  const byKind = new Map<string, number[]>();
  for (const x of rows.results) {
    const g = Math.max(0, x.gap);
    buckets.find((b) => g < b.max)!.n++;
    const l = byKind.get(x.kind) ?? []; l.push(g); byKind.set(x.kind, l);
  }
  const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {
    n: rows.results.length,
    buckets: buckets.map((b) => ({ label: b.label, n: b.n })),
    medians: [...byKind.entries()].map(([kind, xs]) => ({ kind, n: xs.length, medianHours: Math.round((median(xs)! / HOUR) * 10) / 10 })),
  };
}

const weekStart = (t: number) => { const d = new Date(t); const day = (d.getUTCDay() + 6) % 7; d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10); };

/** Cohorts by registration week, and by session / live event / challenge cohort. Revenue is net, any time after registering. */
export async function cohorts(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range) {
  const db = rt.env.DB;
  const regs = await db.prepare(
    `SELECT s.reg_id, s.funnel, s.cohort_ref, s.ts,
            EXISTS (SELECT 1 FROM attr_stages a WHERE a.reg_id = s.reg_id AND a.stage = 'attended') AS attended,
            EXISTS (SELECT 1 FROM attr_stages a WHERE a.reg_id = s.reg_id AND a.stage = 'ticket_paid') AS ticket,
            EXISTS (SELECT 1 FROM attr_stages a WHERE a.reg_id = s.reg_id AND a.stage IN ('sprint_paid', 'deposit_paid')) AS offer
       FROM attr_stages s WHERE s.stage = 'registered' AND s.funnel IN (${fIn(f)}) AND s.ts BETWEEN ? AND ?`,
  ).bind(r.from, r.to).all<{ reg_id: string; funnel: Funnel; cohort_ref: string | null; ts: number; attended: number; ticket: number; offer: number }>();
  const money = await db.prepare(
    `SELECT c.reg_id, c.currency, SUM(c.amount - c.refunded) AS net FROM attr_conversions c
      WHERE c.kind != 'registered' AND c.reg_id IN (SELECT reg_id FROM attr_stages WHERE stage = 'registered' AND funnel IN (${fIn(f)}) AND ts BETWEEN ? AND ?) GROUP BY c.reg_id, c.currency`,
  ).bind(r.from, r.to).all<{ reg_id: string; currency: string | null; net: number }>();
  const currency = primaryCurrency(money.results) ?? 'USD';
  const rev = new Map<string, number>();
  for (const m of money.results) if ((m.currency ?? currency) === currency) rev.set(m.reg_id, (rev.get(m.reg_id) ?? 0) + fromMinor(m.net, currency));
  const labels = await cohortLabels(rt, [...new Set(regs.results.map((x) => `${x.funnel}|${x.cohort_ref}`))]);
  type A = { key: string; label: string; funnel?: string; registrants: number; attended: number; tickets: number; offers: number; revenue: number; at: number };
  const roll = (keyOf: (x: (typeof regs.results)[number]) => { key: string; label: string; funnel?: string; at: number }) => {
    const m = new Map<string, A>();
    for (const x of regs.results) {
      const k = keyOf(x);
      const a = m.get(k.key) ?? { ...k, registrants: 0, attended: 0, tickets: 0, offers: 0, revenue: 0 };
      a.registrants++; a.attended += x.attended; a.tickets += x.ticket; a.offers += x.offer; a.revenue += rev.get(x.reg_id) ?? 0; a.at = Math.min(a.at, k.at);
      m.set(k.key, a);
    }
    return [...m.values()].sort((a, b) => b.at - a.at).map((a) => ({ ...a, revenue: Math.round(a.revenue * 100) / 100, perRegistrant: a.registrants ? Math.round((a.revenue / a.registrants) * 100) / 100 : null, attendRate: a.registrants ? a.attended / a.registrants : null, buyRate: a.registrants ? a.offers / a.registrants : null }));
  };
  return {
    currency,
    byWeek: roll((x) => ({ key: weekStart(x.ts), label: `Week of ${weekStart(x.ts)}`, at: x.ts })),
    byEvent: roll((x) => { const l = labels.get(`${x.funnel}|${x.cohort_ref}`); return { key: `${x.funnel}|${x.cohort_ref}`, label: l?.label ?? 'Unknown session', funnel: x.funnel, at: l?.at ?? x.ts }; }),
  };
}

async function cohortLabels(rt: Pick<Runtime, 'env'>, keys: string[]) {
  const db = rt.env.DB;
  const out = new Map<string, { label: string; at: number }>();
  for (const k of keys.slice(0, 300)) {
    const [funnel, ref] = k.split('|');
    if (!ref || ref === 'null') continue;
    if (funnel === 'auto') {
      const s = await db.prepare('SELECT starts_at, auto FROM webinar_sessions WHERE id = ?').bind(ref).first<{ starts_at: number; auto: number }>();
      if (s) out.set(k, { label: `Masterclass ${new Date(s.starts_at).toISOString().slice(0, 16).replace('T', ' ')} UTC${s.auto === 2 ? ' (just in time)' : ''}`, at: s.starts_at });
    } else if (funnel === 'live') {
      const e = await db.prepare('SELECT title, starts_at FROM live_webinars WHERE id = ?').bind(ref).first<{ title: string; starts_at: number }>();
      if (e) out.set(k, { label: `${e.title} (${new Date(e.starts_at).toISOString().slice(0, 10)})`, at: e.starts_at });
    } else {
      const c = await db.prepare('SELECT name, start_date FROM challenge_cohorts WHERE id = ?').bind(ref).first<{ name: string; start_date: string }>();
      if (c) out.set(k, { label: `${c.name} (Day 1 ${c.start_date})`, at: Date.parse(c.start_date) || 0 });
    }
  }
  return out;
}

// ───────────── room analytics ─────────────

const share = (n: number, d: number) => (d ? n / d : null);

/** Retention per minute, drop-off around the offer unlock, buy rate by minutes watched, and what predicts buying. */
export async function roomAnalytics(rt: Runtime, f: FunnelSel, r: Range) {
  const out: Record<string, unknown> = {};
  if (f === 'auto' || f === 'all') out.auto = await autoRoom(rt, r);
  if (f === 'live' || f === 'all') out.live = await liveRoom(rt, r);
  if (f === 'challenge' || f === 'all') out.challenge = await challengeRoom(rt, r);
  out.predictors = await predictors(rt, f, r);
  return out;
}

async function autoRoom(rt: Runtime, r: Range) {
  const rows = await rt.env.DB.prepare(
    `SELECT r.id, r.live_minutes, r.replay_minutes, r.joined_at, r.replay_at, (SELECT edition FROM attr_conversions c WHERE c.kind = 'registered' AND c.ref_id = r.id) AS edition,
            EXISTS (SELECT 1 FROM webinar_passes p WHERE p.reg_id = r.id AND p.kind = 'offer' AND p.paid_at IS NOT NULL AND p.amount > p.refunded_amount) AS bought
       FROM webinar_registrations r WHERE r.created_at BETWEEN ? AND ? AND (r.joined_at IS NOT NULL OR r.replay_at IS NOT NULL)`,
  ).bind(r.from, r.to).all<{ id: string; live_minutes: string | null; replay_minutes: string | null; joined_at: number | null; replay_at: number | null; edition: string | null; bought: number }>();
  const pitchSet = Number(rt.settings.WEBINAR_PITCH_AT);
  const editions = new Map<string, typeof rows.results>();
  for (const x of rows.results) { const k = x.edition ?? 'not recorded'; editions.set(k, [...(editions.get(k) ?? []), x]); }
  const curves = [...editions.entries()].map(([name, list]) => {
    const ed = name === 'ai' || name === 'recorded' ? edition({ WEBINAR_EDITION: name as EditionName } as never) : null;
    const len = Math.max(1, Math.round(Number(rt.settings.WEBINAR_DURATION_MIN) || ed?.durationMin || 66));
    // Unknown edition (registered before capture began): the unlock minute the room uses today.
    const unlock = Number.isFinite(pitchSet) && pitchSet > 0 ? pitchSet : ed?.pitchAtMin ?? edition(rt.settings).pitchAtMin;
    const counts = new Array<number>(len).fill(0);
    const mins: { watched: number; bought: number }[] = [];
    for (const x of list) {
      const s = mergeMinutes(x.live_minutes, x.replay_minutes, len);
      s.forEach((on, i) => { if (on) counts[i]++; });
      mins.push({ watched: s.filter(Boolean).length, bought: x.bought });
    }
    const curve = counts.map((c) => (list.length ? c / list.length : 0));
    const at = (m: number) => (m >= 0 && m < len ? curve[m] : null);
    return {
      edition: name, viewers: list.length, len, unlockAt: unlock, curve,
      aroundUnlock: unlock == null ? null : [-5, 0, 5, 15].map((d) => ({ minute: unlock + d, share: at(unlock + d) })),
      buyByMinutes: buyBuckets(mins),
    };
  });
  return { editions: curves, viewers: rows.results.length };
}

function mergeMinutes(a: string | null, b: string | null, len: number) {
  const out = new Array<boolean>(len).fill(false);
  for (const s of [a, b]) if (s) for (let i = 0; i < len && i < s.length; i++) if (s[i] === '1') out[i] = true;
  return out;
}

function buyBuckets(list: { watched: number; bought: number }[]) {
  const b = [{ label: 'Under 15 min', lo: 0, hi: 15 }, { label: '15 to 29 min', lo: 15, hi: 30 }, { label: '30 to 44 min', lo: 30, hi: 45 }, { label: '45 to 59 min', lo: 45, hi: 60 }, { label: '60 min or more', lo: 60, hi: Infinity }]
    .map((x) => ({ ...x, viewers: 0, buyers: 0 }));
  for (const x of list) { const k = b.find((y) => x.watched >= y.lo && x.watched < y.hi)!; k.viewers++; if (x.bought) k.buyers++; }
  return b.map((x) => ({ label: x.label, viewers: x.viewers, buyers: x.buyers, rate: share(x.buyers, x.viewers) }));
}

async function liveRoom(rt: Runtime, r: Range) {
  const db = rt.env.DB;
  const evs = await db.prepare('SELECT id, title, starts_at, duration_min, offer_opened_at FROM live_webinars WHERE starts_at BETWEEN ? AND ? ORDER BY starts_at DESC LIMIT 12').bind(r.from, r.to)
    .all<{ id: string; title: string; starts_at: number; duration_min: number; offer_opened_at: number | null }>();
  const events = [];
  for (const e of evs.results) {
    const w = await db.prepare("SELECT reg_id, minute FROM attr_watch WHERE funnel = 'live' AND event_ref = ?").bind(e.id).all<{ reg_id: string; minute: number }>();
    const len = Math.max(1, e.duration_min);
    const viewers = new Set(w.results.map((x) => x.reg_id));
    const counts = new Array<number>(len).fill(0);
    const per = new Map<string, number>();
    for (const x of w.results) { if (x.minute < len) counts[x.minute]++; per.set(x.reg_id, (per.get(x.reg_id) ?? 0) + 1); }
    const buyers = await db.prepare("SELECT r.id FROM live_webinar_regs r JOIN webinar_passes p ON p.ref_id = r.event_id AND p.lead_id = r.lead_id WHERE r.event_id = ? AND p.kind = 'deposit' AND p.source = 'live' AND p.paid_at IS NOT NULL AND p.amount > p.refunded_amount").bind(e.id).all<{ id: string }>();
    const bought = new Set(buyers.results.map((b) => b.id));
    const unlock = e.offer_opened_at ? Math.floor((e.offer_opened_at - e.starts_at) / MIN) : null;
    const curve = counts.map((c) => (viewers.size ? c / viewers.size : 0));
    const regs = await db.prepare('SELECT COUNT(*) AS n, SUM(joined_at IS NOT NULL OR zoom_clicked_at IS NOT NULL) AS attended FROM live_webinar_regs WHERE event_id = ?').bind(e.id).first<{ n: number; attended: number | null }>();
    events.push({
      id: e.id, title: e.title, startsAt: e.starts_at, len, viewers: viewers.size, registrants: regs?.n ?? 0, attended: regs?.attended ?? 0, unlockAt: unlock, curve,
      aroundUnlock: unlock == null ? null : [-5, 0, 5, 15].map((d) => ({ minute: unlock + d, share: unlock + d >= 0 && unlock + d < len ? curve[unlock + d] : null })),
      buyByMinutes: buyBuckets([...viewers].map((id) => ({ watched: per.get(id) ?? 0, bought: bought.has(id) ? 1 : 0 }))),
      zoomNote: 'Minutes come from the companion room. People who only watch inside the Zoom app count as attended (they pressed Join), without minutes, unless Zoom attendance is imported.',
    });
  }
  return { events };
}

async function challengeRoom(rt: Runtime, r: Range) {
  const rows = await rt.env.DB.prepare(
    `SELECT s.stage, s.value, COUNT(DISTINCT s.reg_id) AS n FROM attr_stages s
      WHERE s.funnel = 'challenge' AND (s.stage = 'attended_day' OR s.stage LIKE 'homework_day%')
        AND s.reg_id IN (SELECT reg_id FROM attr_stages WHERE funnel = 'challenge' AND stage = 'registered' AND ts BETWEEN ? AND ?)
      GROUP BY s.stage, s.value`,
  ).bind(r.from, r.to).all<{ stage: string; value: number; n: number }>();
  const days = [1, 2, 3, 4, 5].map((d) => ({
    day: d,
    attended: rows.results.find((x) => x.stage === 'attended_day' && Number(x.value) === d)?.n ?? 0,
    homework: rows.results.find((x) => x.stage === `homework_day${d}`)?.n ?? 0,
  }));
  return { days };
}

/** For each chapter reached and poll answer: how many people, how many bought, and the buy rate against everyone in the room. */
export async function predictors(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range) {
  const db = rt.env.DB;
  const base = `SELECT reg_id FROM attr_stages WHERE funnel IN (${fIn(f)}) AND stage = 'attended' AND reg_id IN (SELECT reg_id FROM attr_stages WHERE stage = 'registered' AND ts BETWEEN ?1 AND ?2)`;
  const buyers = `SELECT reg_id FROM attr_stages WHERE stage IN ('sprint_paid', 'deposit_paid')`;
  const room = await db.prepare(`SELECT COUNT(*) AS n, SUM(reg_id IN (${buyers})) AS b FROM (${base})`).bind(r.from, r.to).first<{ n: number; b: number | null }>();
  const rows = await db.prepare(
    `SELECT s.funnel, s.stage, s.detail, COUNT(DISTINCT s.reg_id) AS n, COUNT(DISTINCT CASE WHEN s.reg_id IN (${buyers}) THEN s.reg_id END) AS b
       FROM attr_stages s WHERE s.stage IN ('chapter', 'poll') AND s.funnel IN (${fIn(f)}) AND s.reg_id IN (${base})
      GROUP BY s.funnel, s.stage, s.detail ORDER BY s.stage, MIN(s.value)`,
  ).bind(r.from, r.to).all<{ funnel: string; stage: string; detail: string | null; n: number; b: number }>();
  const baseRate = share(room?.b ?? 0, room?.n ?? 0);
  return {
    viewers: room?.n ?? 0, buyers: room?.b ?? 0, baseRate,
    rows: rows.results.map((x) => {
      const rate = share(x.b, x.n);
      return { funnel: x.funnel, kind: x.stage, label: x.detail ?? '', people: x.n, buyers: x.b, rate, lift: rate != null && baseRate ? rate / baseRate : null };
    }),
    note: 'Lift = buy rate of people with this chapter or answer, divided by the buy rate of everyone who attended. Small groups swing a lot: read lift together with the number of people.',
  };
}

// ───────────── people and journeys ─────────────

export async function people(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range, limit = 100) {
  const rows = await rt.env.DB.prepare(
    `SELECT g.lead_id, g.reg_id, g.funnel, g.occurred_at, g.ft_platform, g.ft_campaign, g.lt_platform, g.lt_campaign, g.lt_ad_id, g.touches, g.edition,
            l.first_name, l.last_name, l.email,
            (SELECT GROUP_CONCAT(DISTINCT s.stage) FROM attr_stages s WHERE s.reg_id = g.reg_id) AS stages,
            (SELECT COALESCE(SUM(c.amount - c.refunded), 0) FROM attr_conversions c WHERE c.reg_id = g.reg_id AND c.kind != 'registered') AS net,
            (SELECT MAX(c.currency) FROM attr_conversions c WHERE c.reg_id = g.reg_id AND c.kind != 'registered') AS currency
       FROM attr_conversions g LEFT JOIN leads l ON l.id = g.lead_id
      WHERE g.kind = 'registered' AND g.funnel IN (${fIn(f)}) AND g.occurred_at BETWEEN ? AND ? ORDER BY g.occurred_at DESC LIMIT ?`,
  ).bind(r.from, r.to, limit).all<Record<string, unknown> & { net: number; currency: string | null; stages: string | null }>();
  return rows.results.map((x) => ({
    ...x, revenue: x.currency ? fromMinor(x.net, x.currency) : 0,
    stages: (x.stages ?? '').split(',').filter(Boolean),
    name: [x.first_name, x.last_name].filter(Boolean).join(' ') || (x.email as string | null) || 'Someone',
  }));
}

/** One person: every touch, conversion and stage, in time order. */
export async function journey(rt: Pick<Runtime, 'env'>, leadId: string) {
  const db = rt.env.DB;
  const [lead, touches, convs, stages] = await Promise.all([
    db.prepare('SELECT id, first_name, last_name, email, revenue_band, status FROM leads WHERE id = ?').bind(leadId).first<Record<string, unknown>>(),
    db.prepare('SELECT * FROM attr_touches WHERE lead_id = ? ORDER BY ts').bind(leadId).all<TouchRow>(),
    db.prepare('SELECT id, kind, funnel, ref_id, reg_id, occurred_at, amount, refunded, currency, edition, touches, via, ft_platform, ft_campaign, ft_ad_id, lt_platform, lt_campaign, lt_ad_id, lt_link_code FROM attr_conversions WHERE lead_id = ? ORDER BY occurred_at').bind(leadId).all<Record<string, unknown> & { amount: number; refunded: number; currency: string | null }>(),
    db.prepare('SELECT funnel, stage, reg_id, ts, value, detail, source FROM attr_stages WHERE lead_id = ? ORDER BY ts').bind(leadId).all(),
  ]);
  if (!lead) return null;
  return {
    lead: { ...lead, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email, url: `/admin#lead=${leadId}` },
    touches: touches.results,
    conversions: convs.results.map((c) => ({ ...c, net: c.currency ? fromMinor(c.amount - c.refunded, c.currency) : 0 })),
    stages: stages.results,
  };
}

// ───────────── setup checks (what the owner must turn on) ─────────────

export async function setupChecks(rt: Runtime) {
  const db = rt.env.DB;
  const s = rt.settings;
  const since = Date.now() - 30 * DAY;
  const [paid, withAd, spend, adLevel, conv, xd] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM attr_touches WHERE ts > ? AND (source IN ('facebook', 'fb', 'instagram', 'ig', 'meta') AND medium IN ('paid', 'cpc', 'paid_social', 'paidsocial'))").bind(since).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM attr_touches WHERE ts > ? AND ad_id IS NOT NULL').bind(since).first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM ad_spend WHERE updated_at > ?').bind(since).first<{ n: number }>().catch(() => null),
    db.prepare('SELECT COUNT(*) AS n FROM ad_insights WHERE updated_at > ?').bind(since).first<{ n: number }>().catch(() => null),
    db.prepare('SELECT COUNT(*) AS n FROM attr_conversions').first<{ n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM attr_xdomain').first<{ n: number }>(),
  ]);
  const items = [
    { id: 'ad_id', ok: (paid?.n ?? 0) === 0 || (withAd?.n ?? 0) > 0, text: 'On every Meta ad, set URL parameters to utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.id}}&utm_term={{adset.id}} (Ads Manager → ad → Tracking → URL parameters). utm_content={{ad.id}} is what ties each buyer to the exact ad.', detail: `${withAd?.n ?? 0} visits in the last 30 days carried a Meta ad id; ${paid?.n ?? 0} came from paid Meta traffic.` },
    { id: 'spend', ok: (spend?.n ?? 0) > 0, text: 'Connect the Meta ad account (Traffic & ads → Connect ad account) so spend syncs every hour. Cost per registrant, attendee and buyer and ROAS need it.', detail: spend?.n ? 'Campaign spend is syncing.' : 'No ad spend synced in the last 30 days.' },
    { id: 'ad_level', ok: (adLevel?.n ?? 0) > 0, text: 'Ad-level spend (for cost and ROAS per ad and ad set) comes from the ads autopilot sync, which runs once the Meta ads token and ad account are set.', detail: adLevel?.n ? 'Ad-level insights are syncing.' : 'No ad-level insights yet.' },
    { id: 'capi', ok: Boolean(s.META_PIXEL_ID && s.META_ACCESS_TOKEN), text: 'Meta Pixel ID and Conversions API token (Integrations → Ads) send registrations, purchases, attendance and offer views to Meta.', detail: s.META_PIXEL_ID && s.META_ACCESS_TOKEN ? 'Connected.' : 'Not connected: nothing is sent to Meta.' },
    { id: 'domains', ok: Boolean(s.PUBLIC_URL && s.WEBINAR_URL), text: 'Set both Public URL and Webinar address so links between apply. and live. carry the visitor across domains.', detail: `${xd?.n ?? 0} cross-domain visits joined so far.` },
    { id: 'zoom', ok: Boolean(s.ZOOM_ACCOUNT_ID && s.ZOOM_CLIENT_ID && s.ZOOM_CLIENT_SECRET), text: 'Zoom attendance minutes: add the report:read:admin scope to the Zoom Server-to-Server app and press Import Zoom attendance after each live event.', detail: s.ZOOM_ACCOUNT_ID ? 'Zoom app connected.' : 'Zoom app not connected: live attendance comes from the room and the Join button only.' },
  ];
  return { items, conversions: conv?.n ?? 0 };
}
