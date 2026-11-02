import { FUNNEL_LABEL, type Funnel, PRODUCTS, PURCHASE_PRODUCTS, type ProductId, slotLabel } from './enrich';

/**
 * The plan: every custom conversion, website (Pixel rule) audience, customer-list audience and lookalike that
 * Funnel HQ manages in Meta. Keys are ours and never change; names are what appears in Ads Manager.
 *
 * Rule formats (checked against developers.facebook.com, Marketing API "Audience Rules" and "Custom Conversions"):
 *  - website audience `rule`: { inclusions: { operator, rules: [{ event_sources: [{ type: 'pixel', id }], retention_seconds,
 *    filter: { operator: 'and', filters: [{ field: 'event', operator: '=', value: 'Purchase' }, { field: <custom_data key>, operator, value }] } }] },
 *    exclusions: same shape }. Event filters must use '='. At most 10 rules per audience. Website retention is 1 to 180 days.
 *  - custom conversion `rule`: { and: [{ event: { eq: 'Purchase' } }, { product_id: { eq: 'first_deal_sprint' } }] } with
 *    event_source_id = the Pixel and custom_event_type. At most 100 custom conversions per ad account.
 */

export type Kind = 'conversion' | 'website' | 'list' | 'lookalike';
export type Segment =
  | { type: 'registered'; funnel: Funnel; slot?: string }
  | { type: 'attended'; funnel: Funnel }
  | { type: 'watched_50'; funnel: Funnel }
  | { type: 'offer_seen_no_purchase'; funnel: Funnel }
  | { type: 'checkout_no_purchase' }
  | { type: 'buyer'; product: ProductId }
  | { type: 'booked'; tier: 'A' | 'B' | 'C' }
  | { type: 'no_show' }
  | { type: 'all_buyers' }
  | { type: 'clients' }
  | { type: 'buyers_value' };

export interface Filter { field: string; operator: string; value: string | number | string[] }
export interface PlanItem {
  key: string; kind: Kind; name: string; group: string; description: string;
  segment?: Segment;
  /** website audience / custom conversion: the event plus param filters */
  event?: string; filters?: Filter[]; exclude?: { event: string; filters?: Filter[] };
  /** custom conversion */
  customEventType?: string;
  /** list audience */
  valueBased?: boolean;
  /** lookalike */
  source?: string; ratio?: number; country?: string;
  /** used for exclusions rather than targeting */
  exclusion?: boolean;
}

const eq = (field: string, value: string): Filter => ({ field, operator: '=', value });
const PREFIX = 'G&L';
const WEB_FUNNELS: Funnel[] = ['auto', 'live', 'challenge'];
const TIERS = ['A', 'B', 'C'] as const;
const FUNNEL_SHORT: Record<Funnel, string> = { vsl: 'VSL', auto: 'Masterclass', live: 'Live webinar', challenge: 'Challenge', dm: 'DMs', winback: 'Win-back' };

// ───────────── custom conversions: what campaigns optimise on ─────────────

function conversions(): PlanItem[] {
  const out: PlanItem[] = [];
  for (const t of TIERS) out.push({ key: `conv_booked_tier_${t.toLowerCase()}`, kind: 'conversion', group: 'Booked calls', name: `${PREFIX} Booked call, tier ${t}`, description: `Schedule with tier = ${t}.`, event: 'Schedule', filters: [eq('tier', t)], customEventType: 'SCHEDULE' });
  for (const f of WEB_FUNNELS) out.push({ key: `conv_reg_${f}`, kind: 'conversion', group: 'Registrations', name: `${PREFIX} Registration, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `CompleteRegistration with funnel = ${f}.`, event: 'CompleteRegistration', filters: [eq('funnel', f)], customEventType: 'COMPLETE_REGISTRATION' });
  for (const p of PURCHASE_PRODUCTS) out.push({ key: `conv_buy_${p}`, kind: 'conversion', group: 'Purchases', name: `${PREFIX} ${PRODUCTS[p].content_name}`, description: `Purchase with product_id = ${p}.`, event: 'Purchase', filters: [eq('product_id', p)], customEventType: 'PURCHASE' });
  for (const f of ['live', 'challenge'] as const) out.push({ key: `conv_buy_deposit_${f}`, kind: 'conversion', group: 'Purchases', name: `${PREFIX} Engagement deposit, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `Purchase with product_id = engagement_deposit and funnel = ${f}.`, event: 'Purchase', filters: [eq('product_id', 'engagement_deposit'), eq('funnel', f)], customEventType: 'PURCHASE' });
  return out;
}

// ───────────── audiences: one website (Pixel) and one customer-list audience per segment ─────────────

interface Seg { id: string; group: string; label: string; description: string; segment: Segment; event?: string; filters?: Filter[]; exclude?: { event: string; filters?: Filter[] }; exclusion?: boolean; listOnly?: boolean }

function segments(slots: { funnel: Funnel; slot: string }[]): Seg[] {
  const s: Seg[] = [];
  for (const f of WEB_FUNNELS) s.push({ id: `reg_${f}`, group: 'Registrations', label: `Registered, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `Everyone who registered for the ${FUNNEL_LABEL[f].toLowerCase()}.`, segment: { type: 'registered', funnel: f }, event: 'CompleteRegistration', filters: [eq('funnel', f)] });
  for (const { funnel, slot } of slots) s.push({ id: `reg_${funnel}_${slot}`, group: 'Registrations by session time', label: `Registered, ${FUNNEL_SHORT[funnel].toLowerCase()}, ${slotLabel(slot)}`, description: `Registered for a ${FUNNEL_LABEL[funnel].toLowerCase()} session on ${slotLabel(slot)} (session local time).`, segment: { type: 'registered', funnel, slot }, event: 'CompleteRegistration', filters: [eq('funnel', funnel), eq('session_slot', slot)] });
  for (const f of WEB_FUNNELS) s.push({ id: `attended_${f}`, group: 'Attended', label: `Attended, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `Came into the ${FUNNEL_LABEL[f].toLowerCase()} room (or Zoom).`, segment: { type: 'attended', funnel: f }, event: 'WebinarAttended', filters: [eq('funnel', f)] });
  for (const f of ['auto', 'live'] as const) s.push({ id: `watched50_${f}`, group: 'Attended', label: `Watched 50%+, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `Watched at least half of the ${FUNNEL_LABEL[f].toLowerCase()}.`, segment: { type: 'watched_50', funnel: f }, event: 'WebinarWatched50', filters: [eq('funnel', f)] });
  for (const f of WEB_FUNNELS) s.push({ id: `offer_nobuy_${f}`, group: 'Warm, not bought', label: `Saw the offer, didn’t buy, ${FUNNEL_SHORT[f].toLowerCase()}`, description: `Saw the ${FUNNEL_LABEL[f].toLowerCase()} offer and bought nothing since.`, segment: { type: 'offer_seen_no_purchase', funnel: f }, event: 'WebinarOfferSeen', filters: [eq('funnel', f)], exclude: { event: 'Purchase' } });
  s.push({ id: 'checkout_nobuy', group: 'Warm, not bought', label: 'Started checkout, didn’t buy', description: 'Opened a checkout (ticket, Sprint, deposit or VIP) and bought nothing since.', segment: { type: 'checkout_no_purchase' }, event: 'InitiateCheckout', exclude: { event: 'Purchase' } });
  for (const p of PURCHASE_PRODUCTS) s.push({ id: `buyer_${p}`, group: 'Buyers', label: `Bought: ${PRODUCTS[p].content_name}`, description: `Paid for the ${PRODUCTS[p].content_name.toLowerCase()} (refunds left out of the list).`, segment: { type: 'buyer', product: p }, event: 'Purchase', filters: [eq('product_id', p)] });
  for (const t of TIERS) s.push({ id: `booked_tier_${t.toLowerCase()}`, group: 'Booked calls', label: `Booked a call, tier ${t}`, description: `Booked a strategy call with an application scored ${t}.`, segment: { type: 'booked', tier: t }, event: 'Schedule', filters: [eq('tier', t)] });
  s.push({ id: 'no_show', group: 'Booked calls', label: 'Missed their call', description: 'Marked no-show on a booked call.', segment: { type: 'no_show' }, event: 'CallNoShow' });
  s.push({ id: 'all_buyers', group: 'Exclusions', label: 'All buyers', description: 'Anyone who bought anything. Exclude from cold and registration campaigns.', segment: { type: 'all_buyers' }, event: 'Purchase', exclusion: true });
  s.push({ id: 'clients', group: 'Exclusions', label: 'Clients', description: 'First Deal Sprint, engagement deposit or signed engagement. Exclude from every acquisition campaign.', segment: { type: 'clients' }, event: 'Purchase', filters: [{ field: 'content_category', operator: 'is_any', value: ['sprint', 'deposit', 'engagement'] }], exclusion: true });
  s.push({ id: 'buyers_value', group: 'Lookalike seeds', label: 'Buyers by value (LTV)', description: 'Every buyer with what they have paid in all, so value-based lookalikes favour the biggest buyers.', segment: { type: 'buyers_value' }, listOnly: true });
  return s;
}

export const LOOKALIKE_SOURCES = ['list_buyers_value', 'list_all_buyers', 'list_clients'];
export const LOOKALIKE_RATIOS = [0.01, 0.03];

/** The whole plan for the given session slots (from our own sessions) and lookalike countries. */
export function buildPlan(o: { slots?: { funnel: Funnel; slot: string }[]; countries?: string[] } = {}): PlanItem[] {
  const items: PlanItem[] = [...conversions()];
  for (const s of segments(o.slots ?? [])) {
    if (!s.listOnly && s.event) items.push({ key: `web_${s.id}`, kind: 'website', group: s.group, name: `${PREFIX} Web: ${s.label}`, description: `${s.description} From the Pixel and Conversions API.`, segment: s.segment, event: s.event, filters: s.filters, exclude: s.exclude, exclusion: s.exclusion });
    items.push({ key: `list_${s.id}`, kind: 'list', group: s.group, name: `${PREFIX} List: ${s.label}`, description: `${s.description} From our database, synced daily.`, segment: s.segment, valueBased: s.segment.type === 'buyers_value', exclusion: s.exclusion });
  }
  for (const source of LOOKALIKE_SOURCES) {
    const src = items.find((i) => i.key === source);
    for (const country of o.countries ?? ['AU']) for (const ratio of LOOKALIKE_RATIOS) {
      items.push({ key: `lal_${source.replace(/^list_/, '')}_${Math.round(ratio * 100)}_${country.toLowerCase()}`, kind: 'lookalike', group: 'Lookalikes', name: `${PREFIX} Lookalike ${Math.round(ratio * 100)}% ${country}: ${src?.name.replace(`${PREFIX} List: `, '') ?? source}`, description: `The ${Math.round(ratio * 100)}% of people in ${country} most like this list.`, source, ratio, country });
    }
  }
  return items;
}

/** Website audience `rule` JSON (Meta audience rules format). */
export function websiteRule(item: PlanItem, pixelId: string, retentionDays: number) {
  const retention_seconds = Math.max(1, Math.min(180, Math.round(retentionDays))) * 86_400;
  const event_sources = [{ type: 'pixel', id: pixelId }];
  const one = (event: string, filters: Filter[] = []) => ({ event_sources, retention_seconds, filter: { operator: 'and', filters: [{ field: 'event', operator: '=', value: event }, ...filters] } });
  const rule: Record<string, unknown> = { inclusions: { operator: 'or', rules: [one(item.event!, item.filters)] } };
  if (item.exclude) rule.exclusions = { operator: 'or', rules: [one(item.exclude.event, item.exclude.filters)] };
  return rule;
}

/** Custom conversion `rule` JSON. */
export function conversionRule(item: PlanItem) {
  return { and: [{ event: { eq: item.event } }, ...(item.filters ?? []).map((f) => ({ [f.field]: f.operator === 'is_any' ? { is_any: f.value } : { eq: f.value } }))] };
}

/** Lookalike spec (ratio 0.01 to 0.20, one country). */
export const lookalikeSpec = (item: PlanItem) => ({ type: 'similarity', ratio: item.ratio, country: item.country });

/** Which custom conversion to point each campaign at, and when (honest about Meta's learning thresholds). */
export const RECOMMENDATIONS = [
  { campaign: 'Masterclass registration campaigns', optimise: 'Registration, masterclass', then: 'Masterclass ticket once it reaches about 50 a week' },
  { campaign: 'Live webinar registration campaigns', optimise: 'Registration, live webinar', then: 'Engagement deposit, live webinar once it reaches about 50 a week (rare at this price, so stay on registrations)' },
  { campaign: 'Challenge ticket campaigns', optimise: 'First Deal Challenge ticket', then: 'Keep it; Challenge VIP has too few purchases to optimise on alone' },
  { campaign: 'VSL and application campaigns', optimise: 'Booked call, tier A (or Schedule if tier A is under 50 a week)', then: 'Value optimisation on Schedule once the predicted booking value is switched on and there are enough bookings' },
  { campaign: 'Retargeting', optimise: 'The purchase that follows: Sprint for masterclass attendees, deposit for live and challenge attendees', then: 'Target the warm audiences (offer seen, checkout started) and exclude All buyers and Clients' },
];
export const LEARNING_NOTE = 'Meta’s delivery leaves the learning phase after about 50 optimisation events per ad set in a week. Below that, optimise on the higher-volume event (registration, Schedule or a ticket) and use the specific custom conversions for reporting and retargeting until volume allows. Lookalikes need at least 100 matched people from one country in the source audience; value-based lookalikes work best from a few hundred buyers.';
