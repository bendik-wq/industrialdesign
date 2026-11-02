import type { Runtime } from '../app';
import { ECONOMICS } from '../config';
import { flag } from '../settings';
import { editionName } from '../webinar/editions';

/**
 * Event enrichment for Meta optimisation ("training") and audiences.
 *
 * Every Schedule, CompleteRegistration and Purchase (plus the webinar stage events) carries the same custom_data
 * shape, so each variant can be told apart in Meta: a custom conversion or a website audience is a rule on the
 * event name plus one of these params (src/audiences/catalog.ts). The browser Pixel sends the same params for the
 * events it fires (public/assets/f.js), with the same event id, so deduplication keeps working.
 *
 *   content_name, content_category, content_ids  standard Meta params
 *   product_id                                   the one product id as a plain string (rules match on it)
 *   funnel        vsl | auto | live | challenge | dm | winback
 *   tier          A | B | C (booked calls and won deals)
 *   revenue_band  e.g. 1m_5m, under_1m (slug of the lead's revenue band)
 *   session_slot  weekday + local hour of the chosen webinar / live / challenge session, e.g. tue_19
 *   edition       recorded | ai (automated webinar)
 *   source_platform  facebook | instagram | google | youtube | email | direct | ...
 */

export type Funnel = 'vsl' | 'auto' | 'live' | 'challenge' | 'dm' | 'winback';
export const FUNNELS: Funnel[] = ['vsl', 'auto', 'live', 'challenge', 'dm', 'winback'];
export const FUNNEL_LABEL: Record<Funnel, string> = { vsl: 'VSL and application', auto: 'Automated webinar', live: 'Live webinar', challenge: 'Challenge', dm: 'Instagram DMs', winback: 'Win-back' };

export interface Variant { content_name: string; content_category: string; product_id: string; funnel?: Funnel }

/** What each server event is, for Meta. Product ids never change once audiences and conversions point at them. */
export const PRODUCTS = {
  strategy_call: { content_name: 'Strategy call', content_category: 'strategy_call' },
  masterclass: { content_name: 'Masterclass registration', content_category: 'masterclass', funnel: 'auto' },
  live_webinar: { content_name: 'Live webinar registration', content_category: 'live_webinar', funnel: 'live' },
  challenge: { content_name: 'First Deal Challenge registration', content_category: 'challenge', funnel: 'challenge' },
  masterclass_ticket: { content_name: 'Masterclass ticket', content_category: 'ticket', funnel: 'auto' },
  live_ticket: { content_name: 'Live webinar ticket', content_category: 'ticket', funnel: 'live' },
  challenge_ticket: { content_name: 'First Deal Challenge ticket', content_category: 'ticket', funnel: 'challenge' },
  challenge_vip: { content_name: 'First Deal Challenge VIP', content_category: 'vip', funnel: 'challenge' },
  first_deal_sprint: { content_name: 'First Deal Sprint', content_category: 'sprint', funnel: 'auto' },
  engagement_deposit: { content_name: 'Engagement deposit', content_category: 'deposit' },
  advisory_engagement: { content_name: 'Advisory engagement', content_category: 'engagement' },
} as const satisfies Record<string, { content_name: string; content_category: string; funnel?: Funnel }>;
export type ProductId = keyof typeof PRODUCTS;
/** Products bought with a Purchase event (each has its own buyer audience and custom conversion). */
export const PURCHASE_PRODUCTS: ProductId[] = ['masterclass_ticket', 'live_ticket', 'challenge_ticket', 'challenge_vip', 'first_deal_sprint', 'engagement_deposit', 'advisory_engagement'];

const v = (id: ProductId, funnel?: Funnel): Variant => {
  const p = PRODUCTS[id] as { content_name: string; content_category: string; funnel?: Funnel };
  return { content_name: p.content_name, content_category: p.content_category, product_id: id, ...(funnel ?? p.funnel ? { funnel: funnel ?? p.funnel } : {}) };
};

/** The variant a server event stands for (undefined = not one of the high-value events). Pure. */
export function variantFor(name: string, props: Record<string, unknown>): Variant | undefined {
  switch (name) {
    case 'booking_scheduled': return v('strategy_call');
    case 'webinar_registered': return v('masterclass');
    case 'live_registered': return v('live_webinar');
    case 'challenge_registered': return v('challenge');
    case 'webinar_seat_purchased': return v('masterclass_ticket');
    case 'live_ticket_purchased': return v('live_ticket');
    case 'challenge_ticket_paid': return v('challenge_ticket');
    case 'challenge_vip_paid': return v('challenge_vip');
    case 'webinar_offer_purchased': return v('first_deal_sprint');
    case 'engagement_deposit_purchased': return v('engagement_deposit', props.source === 'live' || props.source === 'challenge' ? props.source : undefined);
    case 'lead_status_changed': return props.to === 'won' ? v('advisory_engagement') : undefined;
    default: return undefined;
  }
}

/** Webinar stage events (src/attribution) carry the funnel they happened in. */
const STAGE_NAMES = new Set(['attr_lead', 'attr_attended', 'attr_offer_seen', 'attr_watched_50', 'attr_checkout_started',
  // Deep-funnel signals (src/tracking/signals.ts)
  'signal_watched_30m', 'signal_stayed_for_pitch', 'signal_offer_opened', 'signal_checkout_started', 'signal_application_submitted', 'signal_contract_signed']);
const ATTR_FUNNEL: Record<string, Funnel> = { auto: 'auto', live: 'live', challenge: 'challenge' };

// ───────────── small pure helpers (shared with tests and the Pixel side) ─────────────

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
/** Weekday + local hour of a session start, e.g. tue_19. */
export function sessionSlot(ts: number | null | undefined, tz: string | null | undefined): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ts));
    const wd = parts.find((p) => p.type === 'weekday')?.value.slice(0, 3).toLowerCase();
    const hr = Number(parts.find((p) => p.type === 'hour')?.value);
    return wd && Number.isFinite(hr) ? `${wd}_${String(hr % 24).padStart(2, '0')}` : null;
  } catch {
    return sessionSlot(ts, 'UTC');
  }
}
/** A challenge cohort's slot from its local start date (YYYY-MM-DD) and time (HH:MM). */
export function cohortSlot(date: string | null | undefined, time: string | null | undefined): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const t = /^(\d{1,2}):\d{2}/.exec(String(time ?? ''));
  if (!d || !t) return null;
  const wd = DAYS[new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), 12)).getUTCDay()];
  return `${wd}_${String(Number(t[1]) % 24).padStart(2, '0')}`;
}
/** Human label for a slot: tue_19 → Tue 19:00. */
export const slotLabel = (slot: string) => { const [d, h] = slot.split('_'); return `${d.charAt(0).toUpperCase()}${d.slice(1)} ${h}:00`; };

/** Revenue band as a rule-safe slug: <1m → under_1m, 10m+ → 10m_plus, 1m-5m → 1m_5m. */
export function bandSlug(band: unknown): string | null {
  const s = String(band ?? '').trim().toLowerCase();
  if (!s) return null;
  return s.replace(/^</, 'under_').replace(/\+$/, '_plus').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || null;
}

/** Where the person first came from, as one short platform word. */
export function sourcePlatform(lead: { utm_source?: string | null; channel?: string | null; click_type?: string | null } | null): string | null {
  if (!lead) return null;
  const s = `${lead.utm_source ?? ''} ${lead.channel ?? ''} ${lead.click_type ?? ''}`.toLowerCase();
  if (!s.trim()) return null;
  if (/instagram|\big\b|ig_/.test(s)) return 'instagram';
  if (/facebook|\bfb\b|fbclid|meta/.test(s)) return 'facebook';
  if (/youtube|\byt\b/.test(s)) return 'youtube';
  if (/google|gclid|adwords/.test(s)) return 'google';
  if (/linkedin/.test(s)) return 'linkedin';
  if (/tiktok/.test(s)) return 'tiktok';
  if (/email|newsletter|resend/.test(s)) return 'email';
  if (/chatgpt|perplexity|claude|gemini|ai_search|ai search/.test(s)) return 'ai_search';
  if (/organic|seo|search/.test(s)) return 'search';
  if (/direct|none/.test(s)) return 'direct';
  return (lead.utm_source || lead.channel || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24) || null;
}

export interface EnrichLead {
  id: string; tier: string | null; revenue_band?: string | null; utm_source: string | null; channel: string | null; click_type?: string | null;
}
export interface EnrichContext { funnel?: Funnel | null; slot?: string | null; edition?: string | null; tier?: string | null }

/** The custom_data params for one event, from the event, the lead and the resolved context. Pure. */
export function buildParams(name: string, props: Record<string, unknown>, lead: EnrichLead | null, ctx: EnrichContext = {}): Record<string, unknown> {
  const variant = variantFor(name, props);
  const out: Record<string, unknown> = {};
  if (variant) {
    out.content_name = variant.content_name;
    out.content_category = variant.content_category;
    out.content_ids = [variant.product_id];
    out.content_type = 'product';
    out.product_id = variant.product_id;
  }
  const funnel = variant?.funnel ?? (STAGE_NAMES.has(name) ? ATTR_FUNNEL[String(props.funnel)] : undefined) ?? ctx.funnel ?? null;
  if (!variant && !STAGE_NAMES.has(name)) return out;
  if (funnel) out.funnel = funnel;
  const tier = String(ctx.tier ?? lead?.tier ?? '').toUpperCase();
  if ((name === 'booking_scheduled' || variant?.product_id === 'advisory_engagement') && /^[ABC]$/.test(tier)) out.tier = tier;
  const band = bandSlug(props.band ?? lead?.revenue_band);
  if (band) out.revenue_band = band;
  if (ctx.slot) out.session_slot = ctx.slot;
  if (funnel === 'auto' && ctx.edition) out.edition = ctx.edition;
  const platform = sourcePlatform(lead);
  if (platform) out.source_platform = platform;
  return out;
}

// ───────────── context from the database (funnel for calls and deals, session slot, edition) ─────────────

type DB = Runtime['env']['DB'];
const first = async <T>(db: DB, sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).first<T>().catch(() => null)) ?? null;

/** Which funnel a booked call or won deal came from: win-back, DMs, the latest webinar registration, else the VSL. */
export async function leadFunnel(db: DB, leadId: string, before = Date.now()): Promise<Funnel> {
  if (await first(db, "SELECT 1 AS x FROM winback_enrollments WHERE lead_id = ? AND enrolled_at <= ? LIMIT 1", leadId, before)) return 'winback';
  if (await first(db, 'SELECT 1 AS x FROM dm_threads WHERE lead_id = ? LIMIT 1', leadId)) return 'dm';
  const r = await first<{ funnel: Funnel }>(db,
    `SELECT funnel FROM (SELECT 'auto' AS funnel, created_at AS at FROM webinar_registrations WHERE lead_id = ?1 AND created_at <= ?2
       UNION ALL SELECT 'live', created_at FROM live_webinar_regs WHERE lead_id = ?1 AND created_at <= ?2
       UNION ALL SELECT 'challenge', created_at FROM challenge_registrations WHERE lead_id = ?1 AND created_at <= ?2) ORDER BY at DESC LIMIT 1`, leadId, before);
  return r?.funnel ?? 'vsl';
}

/** Slot of a session in one funnel: webinar session id, live webinar id, challenge cohort id. */
export async function slotOf(rt: Pick<Runtime, 'env' | 'settings'>, funnel: Funnel, ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const db = rt.env.DB;
  if (funnel === 'auto') {
    const s = await first<{ starts_at: number }>(db, 'SELECT starts_at FROM webinar_sessions WHERE id = ?', ref);
    return sessionSlot(s?.starts_at, rt.settings.SALES_TIMEZONE || 'Australia/Sydney');
  }
  if (funnel === 'live') {
    const s = await first<{ starts_at: number; tz: string }>(db, 'SELECT starts_at, tz FROM live_webinars WHERE id = ?', ref);
    return sessionSlot(s?.starts_at, s?.tz);
  }
  if (funnel === 'challenge') {
    const s = await first<{ start_date: string; start_time: string }>(db, 'SELECT start_date, start_time FROM challenge_cohorts WHERE id = ?', ref);
    return cohortSlot(s?.start_date, s?.start_time);
  }
  return null;
}

/** The session a purchase belongs to: the person's latest registration in that funnel. */
async function latestCohort(db: DB, funnel: Funnel, leadId: string): Promise<string | null> {
  const sql = funnel === 'auto' ? 'SELECT session_id AS ref FROM webinar_registrations WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1'
    : funnel === 'live' ? 'SELECT event_id AS ref FROM live_webinar_regs WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1'
      : funnel === 'challenge' ? 'SELECT cohort_id AS ref FROM challenge_registrations WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1' : null;
  if (!sql) return null;
  return (await first<{ ref: string }>(db, sql, leadId))?.ref ?? null;
}

/** custom_data params for a forwarded event (empty object for events that aren't enriched). Never throws. */
export async function enrichEvent(rt: Pick<Runtime, 'env' | 'settings'>, name: string, props: Record<string, unknown>, lead: EnrichLead | null): Promise<Record<string, unknown>> {
  const variant = variantFor(name, props);
  if (!variant && !STAGE_NAMES.has(name)) return {};
  try {
    const ctx: EnrichContext = {};
    let funnel: Funnel | null = variant?.funnel ?? (STAGE_NAMES.has(name) ? ATTR_FUNNEL[String(props.funnel)] ?? null : null);
    if (!funnel && lead) funnel = await leadFunnel(rt.env.DB, lead.id);
    ctx.funnel = funnel;
    if (funnel === 'auto' || funnel === 'live' || funnel === 'challenge') {
      const ref = name === 'webinar_registered' ? String(props.session_id ?? '')
        : name === 'live_registered' ? String(props.event_id ?? '')
          : typeof props.cohort_id === 'string' ? props.cohort_id
            : lead ? await latestCohort(rt.env.DB, funnel, lead.id) : null;
      ctx.slot = name === 'webinar_registered' && typeof props.starts_at === 'number'
        ? sessionSlot(props.starts_at, rt.settings.SALES_TIMEZONE || 'Australia/Sydney')
        : await slotOf(rt, funnel, ref);
    }
    if (funnel === 'auto') ctx.edition = editionName(rt.settings);
    return buildParams(name, props, lead, ctx);
  } catch (e) {
    console.error('meta enrich', String(e).slice(0, 200));
    return buildParams(name, props, lead, {});
  }
}

// ───────────── predicted value of a booked call (Schedule), only when the owner switches it on ─────────────

export const scheduleValueOn = (rt: Pick<Runtime, 'settings'>) => flag((rt.settings as Partial<Record<string, string>>).META_SCHEDULE_VALUE, false);

/** Finance model defaults (public/assets/finance-model.js, VSL funnel) used until enough of our own outcomes exist. */
export const MODEL_DEFAULTS = { fee: 22500, show: 0.7, close: 0.15, currency: 'USD' };
const MIN_OUTCOMES = 10;

export interface TierValue { tier: 'A' | 'B' | 'C'; fee: number; show: number; close: number; value: number; currency: string; basis: string; n: number }

/**
 * Expected value of a booked call per tier = fee × show rate × close rate. Rates come from this tier's own logged
 * outcomes when there are at least 10, else all tiers' outcomes, else the saved financial model, else its defaults.
 * It is an estimate and is labelled as one everywhere it is shown.
 */
export async function bookingValues(rt: Pick<Runtime, 'env'>): Promise<TierValue[]> {
  const db = rt.env.DB;
  const model = await first<{ data: string }>(db, 'SELECT data FROM fin_models ORDER BY updated_at DESC LIMIT 1');
  let m = { ...MODEL_DEFAULTS }, modelBasis = 'financial model defaults';
  try {
    const d = model ? (JSON.parse(model.data) as { shared?: { fee?: number; currency?: string }; vsl?: { show?: number; close?: number } }) : null;
    if (d) {
      m = { fee: Number(d.shared?.fee) || m.fee, show: Number(d.vsl?.show) || m.show, close: Number(d.vsl?.close) || m.close, currency: String(d.shared?.currency || m.currency) };
      modelBasis = 'your saved financial model';
    }
  } catch { /* defaults */ }
  const { results } = await db.prepare(
    `SELECT COALESCE(tier_override, tier) AS tier, SUM(status IN ('showed', 'won', 'lost')) AS held, SUM(status = 'no_show') AS no_show,
            SUM(status = 'won') AS won, SUM(status = 'lost') AS lost, AVG(CASE WHEN status = 'won' AND revenue > 0 THEN revenue END) AS fee
       FROM leads WHERE booked_at IS NOT NULL GROUP BY 1`,
  ).all<{ tier: string | null; held: number; no_show: number; won: number; lost: number; fee: number | null }>().catch(() => ({ results: [] as never[] }));
  const all = results.reduce((a, r) => ({ held: a.held + (r.held ?? 0), no_show: a.no_show + (r.no_show ?? 0), won: a.won + (r.won ?? 0), lost: a.lost + (r.lost ?? 0) }), { held: 0, no_show: 0, won: 0, lost: 0 });
  const wonFees = results.filter((r) => r.fee && r.won).reduce((a, r) => ({ sum: a.sum + (r.fee ?? 0) * r.won, n: a.n + r.won }), { sum: 0, n: 0 });
  const fee = wonFees.n >= 3 ? Math.round(wonFees.sum / wonFees.n) : m.fee;
  const feeBasis = wonFees.n >= 3 ? `average won deal (${wonFees.n})` : `fee from ${modelBasis}`;
  return (['A', 'B', 'C'] as const).map((tier) => {
    const r = results.find((x) => String(x.tier).toUpperCase() === tier);
    const own = r && (r.held + r.no_show) >= MIN_OUTCOMES && (r.won + r.lost) >= MIN_OUTCOMES;
    const pooled = (all.held + all.no_show) >= MIN_OUTCOMES && (all.won + all.lost) >= MIN_OUTCOMES;
    const src = own ? r! : pooled ? all : null;
    const show = src ? src.held / Math.max(1, src.held + src.no_show) : m.show;
    const close = src ? src.won / Math.max(1, src.won + src.lost) : m.close;
    const basis = own ? `tier ${tier} outcomes (${r!.held + r!.no_show} calls); ${feeBasis}` : pooled ? `all tiers’ outcomes (${all.held + all.no_show} calls); ${feeBasis}` : `${modelBasis}; ${feeBasis}`;
    return { tier, fee, show, close, value: Math.round(fee * show * close), currency: wonFees.n >= 3 ? ECONOMICS.currency : m.currency, basis, n: src ? src.held + src.no_show : 0 };
  });
}
