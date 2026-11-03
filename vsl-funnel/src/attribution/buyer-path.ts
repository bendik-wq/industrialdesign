import type { Runtime } from '../app';
import { classifyObjection } from '../rooms/qa';
import { fromMinor } from '../webinar/pass';
import type { FunnelSel, Range } from './report';

/**
 * "Where did this buyer come from" (overnight loop round 4, research item 37).
 *
 * For every deposit, First Deal Sprint and signed engagement: the first ad (with its concept and hook when the ad
 * came from the concept rounds), the landing pages, the registrations, the events and rooms attended with their
 * minutes, the room cards seen and opened, the questions asked (by objection type), the emails, texts and AI calls
 * that reached them, the checkout attempts, and the time from the first touch to the purchase.
 *
 *  - buyerJourney(): one person's whole timeline, built live from the funnels' own rows (the lead drawer).
 *  - syncBuyerPaths(): stores each buyer conversion's path (attr_buyer_paths), so the aggregate never re-reads
 *    every timeline. Paths are cut at the purchase, so later activity never changes them; a path is refreshed once
 *    when it was computed within 6 hours of the purchase (late webhooks and the attribution sync land after it).
 *  - commonPaths(): the most frequent step sequences to a purchase, with real counts, plus how often each step
 *    appears, the first ads, concepts and hooks behind buyers, the question types they asked and the time to buy.
 *
 * Every number is a count of real rows. Nothing is sampled, modelled or estimated.
 */

export const BUYER_KINDS = ['deposit_paid', 'sprint_paid', 'engagement_signed'] as const;
export type BuyerKind = (typeof BUYER_KINDS)[number];
export const BUYER_LABEL: Record<BuyerKind, string> = { deposit_paid: 'Paid the deposit', sprint_paid: 'Bought the First Deal Sprint', engagement_signed: 'Signed the engagement' };
const FUNNEL_LABEL: Record<string, string> = { auto: 'the masterclass', live: 'the live webinar', challenge: 'the challenge' };
const PASS_LABEL: Record<string, string> = { seat: 'Masterclass ticket', live_ticket: 'Live webinar ticket', offer: 'First Deal Sprint', deposit: 'Engagement deposit', addon: 'Ticket add-on', deposit_addon: 'Deposit add-on' };
const PUSH_LABEL: Record<string, string> = { application: 'application', sprint: 'Sprint offer', deposit: 'deposit offer', vip: 'VIP offer', resource: 'resource' };
const PUSH_RANK: Record<string, number> = { dismissed: 0, shown: 1, opened: 2, started: 3, submitted: 4, paid: 5 };
const HOUR = 3_600_000;
const REFRESH_WINDOW = 6 * HOUR;

export type StepType = 'visit' | 'registered' | 'attended' | 'watched' | 'offer' | 'push' | 'question' | 'email' | 'sms' | 'call' | 'checkout' | 'purchase' | 'other';
export interface JourneyEvent { ts: number; type: StepType; label: string; detail?: string | null; minutes?: number | null; qtype?: string | null; token?: string | null }

export interface FirstAd { ts: number | null; platform: string | null; channel: string | null; campaign: string | null; adId: string | null; adName: string | null; concept: string | null; hook: string | null; landing: string | null; content: string | null }
export interface PathSummary {
  convId: string; kind: BuyerKind; funnel: string | null; at: number; amount: number | null; currency: string | null;
  first: FirstAd; landers: string[]; attended: { label: string; minutes: number | null }[]; minutes: number;
  pushes: { seen: number; opened: number }; questions: Record<string, number>;
  emails: { sent: number; opened: number; clicked: number }; sms: { sent: number; clicked: number }; calls: { made: number; connected: number };
  checkouts: { attempts: number; unpaid: number }; hoursToBuy: number | null; steps: string[];
}

type Row = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const all = async <T = Row>(p: Promise<{ results: T[] }>) => (await p.catch(() => ({ results: [] as T[] }))).results;

/** The minutes bucket a step token carries (coarse, so paths group). */
export function minutesBucket(m: number | null | undefined) {
  if (m == null || !(m > 0)) return '';
  if (m < 15) return ' (under 15 min)';
  if (m < 45) return ' (15 to 44 min)';
  if (m < 90) return ' (45 to 89 min)';
  return ' (90+ min)';
}

/** The first-touch token: the paid platform for an ad, else the channel. */
export function sourceToken(t: { platform?: string | null; channel?: string | null; adId?: string | null; medium?: string | null } | null) {
  if (!t || (!t.platform && !t.channel)) return 'Source not tracked';
  const paid = Boolean(t.adId) || /^paid/i.test(t.channel ?? '') || /^(paid|cpc|paid_social|paidsocial|ppc)$/i.test(t.medium ?? '');
  const p = t.platform && t.platform !== 'Direct' ? t.platform : t.channel ?? 'Direct';
  if (p === 'Direct' || t.channel === 'Direct') return 'Came direct';
  return paid ? `Ad on ${p}` : `From ${p}`;
}

/** Collapses a timeline (sorted) into the step sequence up to and including `at`: first occurrence of each token only. */
export function pathSteps(events: JourneyEvent[], at: number, last: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.ts > at) break;
    if (e.token && !out.includes(e.token)) out.push(e.token);
  }
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

async function adInfo(rt: Pick<Runtime, 'env'>, adId: string | null, content: string | null) {
  const db = rt.env.DB;
  const ent = adId ? await db.prepare('SELECT name FROM ad_entities WHERE id = ?').bind(adId).first<{ name: string | null }>().catch(() => null) : null;
  let ca: { hook: string | null; angle: string | null; headline: string | null } | null = null;
  if (adId || content) {
    ca = await db.prepare(
      `SELECT a.hook, a.headline, c.angle FROM ads_concept_ads a LEFT JOIN ads_concepts c ON c.id = a.concept_id
        WHERE (?1 IS NOT NULL AND a.meta_ad_id = ?1) OR (?2 IS NOT NULL AND a.utm_content = ?2) ORDER BY a.updated_at DESC LIMIT 1`,
    ).bind(adId, content).first<{ hook: string | null; angle: string | null; headline: string | null }>().catch(() => null);
  }
  return { adName: ent?.name ?? null, concept: ca?.angle ?? null, hook: ca?.hook ?? null };
}

/** Every row we hold about one person, as one sorted timeline. */
export async function leadTimeline(rt: Pick<Runtime, 'env'>, leadId: string): Promise<JourneyEvent[]> {
  const db = rt.env.DB;
  const ev: JourneyEvent[] = [];
  const [touches, stages, rooms, pushes, objections, autoQs, hotSeats, emails, sms, calls, inbound, passes, convs] = await Promise.all([
    all(db.prepare('SELECT ts, platform, channel, source, medium, campaign, content, ad_id, landing, link_code FROM attr_touches WHERE lead_id = ? ORDER BY ts LIMIT 300').bind(leadId).all()),
    all(db.prepare("SELECT funnel, stage, ts, value, detail FROM attr_stages WHERE lead_id = ? AND stage IN ('registered', 'attended', 'attended_day', 'zoom_joined', 'replay_watched', 'watched_50', 'watched_100', 'offer_seen', 'offer_clicked', 'checkout_abandoned', 'room_stayed_end', 'room_application') ORDER BY ts LIMIT 400").bind(leadId).all()),
    all(db.prepare("SELECT a.room_id, a.first_at, a.minutes, r.title, r.ref_type, r.mode FROM room_attendance a JOIN rooms r ON r.id = a.room_id WHERE a.lead_id = ? AND a.role NOT IN ('host', 'cohost') ORDER BY a.first_at LIMIT 100").bind(leadId).all()),
    all(db.prepare('SELECT e.room_id, e.push_id, e.event, e.at, p.kind FROM room_push_events e LEFT JOIN room_pushes p ON p.room_id = e.room_id AND p.id = e.push_id WHERE e.lead_id = ? ORDER BY e.at LIMIT 400').bind(leadId).all()),
    all(db.prepare('SELECT qtype, source, text, at FROM room_objections WHERE lead_id = ? ORDER BY at LIMIT 200').bind(leadId).all()),
    all(db.prepare("SELECT value, created_at FROM webinar_interactions WHERE lead_id = ? AND kind = 'question' ORDER BY created_at LIMIT 100").bind(leadId).all()),
    all(db.prepare('SELECT h.question, h.day, h.created_at FROM challenge_hot_seats h JOIN challenge_registrations r ON r.id = h.reg_id WHERE r.lead_id = ? ORDER BY h.created_at LIMIT 100').bind(leadId).all()),
    all(db.prepare("SELECT template, sequence, subject, sent_at, opened_at, clicked_at FROM emails WHERE lead_id = ? AND status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at LIMIT 400").bind(leadId).all()),
    all(db.prepare("SELECT template, sequence, sent_at, clicked_at, channel FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status = 'sent' AND sent_at IS NOT NULL ORDER BY sent_at LIMIT 200").bind(leadId).all()),
    all(db.prepare("SELECT kind, status, run_at, updated_at, wc_dialed_at FROM outbound_calls WHERE lead_id = ? AND status IN ('done', 'no_answer') ORDER BY run_at LIMIT 100").bind(leadId).all()),
    all(db.prepare("SELECT started_at, created_at, duration_s FROM voice_calls WHERE lead_id = ? AND kind = 'phone' ORDER BY created_at LIMIT 50").bind(leadId).all()),
    all(db.prepare('SELECT id, kind, product, status, created_at, paid_at, one_click FROM webinar_passes WHERE lead_id = ? ORDER BY created_at LIMIT 200').bind(leadId).all()),
    all(db.prepare(`SELECT id, kind, funnel, occurred_at FROM attr_conversions WHERE lead_id = ? AND kind IN ('registered', ${BUYER_KINDS.map((k) => `'${k}'`).join(', ')}) ORDER BY occurred_at`).bind(leadId).all()),
  ]);

  touches.forEach((t, i) => {
    const adId = str(t.ad_id);
    const where = [str(t.platform) ?? str(t.channel) ?? 'Direct', str(t.campaign), adId ? `ad ${adId}` : null, str(t.link_code) ? `link ${t.link_code}` : null].filter(Boolean).join(' · ');
    ev.push({ ts: num(t.ts)!, type: 'visit', label: i === 0 ? `First visit: ${where}` : `Visit: ${where}`, detail: str(t.landing), token: i === 0 ? sourceToken({ platform: str(t.platform), channel: str(t.channel), adId, medium: str(t.medium) }) : null });
  });
  for (const s of stages) {
    const f = String(s.funnel), stage = String(s.stage), ts = num(s.ts);
    if (ts == null) continue;
    const fl = FUNNEL_LABEL[f] ?? f;
    if (stage === 'registered') ev.push({ ts, type: 'registered', label: `Registered for ${fl}`, token: `Registered for ${fl}` });
    else if (stage === 'attended') {
      const m = num(s.value);
      ev.push({ ts, type: 'attended', label: `Attended ${fl}${f === 'challenge' ? '' : m ? `: ${m} min` : ''}`, minutes: f === 'challenge' ? null : m, detail: str(s.detail), token: `Attended ${fl}${f === 'challenge' ? '' : minutesBucket(m)}` });
    } else if (stage === 'attended_day') ev.push({ ts, type: 'attended', label: `Challenge ${str(s.detail) ?? 'day'} attended`, token: null });
    else if (stage === 'replay_watched') ev.push({ ts, type: 'watched', label: `Watched the replay of ${fl}${num(s.value) && f === 'auto' ? `: ${num(s.value)} min` : ''}`, token: 'Watched a replay' });
    else if (stage === 'watched_50' || stage === 'watched_100') ev.push({ ts, type: 'watched', label: `Watched ${stage === 'watched_50' ? 'half' : 'to the end'} of ${fl}`, token: null });
    else if (stage === 'offer_seen') ev.push({ ts, type: 'offer', label: `Saw the offer in ${fl}`, token: 'Saw the offer' });
    else if (stage === 'offer_clicked') ev.push({ ts, type: 'offer', label: `Clicked the offer in ${fl}`, token: 'Clicked the offer' });
    else if (stage === 'checkout_abandoned') ev.push({ ts, type: 'checkout', label: `Left the ${str(s.detail) ?? ''} checkout unpaid`.replace(/\s+/g, ' '), token: 'Left a checkout unpaid' });
    else if (stage === 'room_stayed_end') ev.push({ ts, type: 'attended', label: 'Stayed to the end of the room', token: null });
    else if (stage === 'room_application') ev.push({ ts, type: 'other', label: 'Applied inside the room', token: 'Applied in the room' });
    else if (stage === 'zoom_joined') ev.push({ ts, type: 'attended', label: 'Pressed Join (Zoom)', token: null });
  }
  for (const r of rooms) {
    const m = num(r.minutes) ?? 0, ref = String(r.ref_type);
    const fl = ref === 'live' ? 'the live webinar' : ref === 'challenge' ? 'the challenge' : null;
    ev.push({ ts: num(r.first_at)!, type: 'attended', label: `In the room "${String(r.title ?? '')}": ${m} min`, minutes: m, token: fl ? null : r.mode === 'meeting' ? 'Meeting room' : 'Attended a live room' });
  }
  // Pushes: one line per card, at its furthest step.
  const byPush = new Map<string, { at: number; kind: string; rank: number; event: string }>();
  for (const p of pushes) {
    const k = `${p.room_id}:${p.push_id}`, rank = PUSH_RANK[String(p.event)] ?? 0;
    const cur = byPush.get(k);
    if (!cur) byPush.set(k, { at: num(p.at)!, kind: String(p.kind ?? 'offer'), rank, event: String(p.event) });
    else if (rank > cur.rank) { cur.rank = rank; cur.event = String(p.event); }
  }
  for (const p of byPush.values()) {
    const what = PUSH_LABEL[p.kind] ?? p.kind;
    ev.push({ ts: p.at, type: 'push', label: `Room card (${what}): ${p.event}`, detail: p.event, token: p.rank >= 2 ? `Opened the ${what} card` : p.rank === 1 ? `Saw the ${what} card` : null });
  }
  for (const o of objections) ev.push({ ts: num(o.at)!, type: 'question', label: `Asked (${String(o.qtype)})`, detail: str(o.text)?.slice(0, 160) ?? null, qtype: String(o.qtype), token: `Asked about ${String(o.qtype)}` });
  for (const q of autoQs) { const t = classifyObjection(String(q.value ?? '')).type; ev.push({ ts: num(q.created_at)!, type: 'question', label: `Asked in the masterclass (${t})`, detail: str(q.value)?.slice(0, 160) ?? null, qtype: t, token: `Asked about ${t}` }); }
  for (const h of hotSeats) { const t = classifyObjection(String(h.question ?? '')).type; ev.push({ ts: num(h.created_at)!, type: 'question', label: `Hot seat question, day ${num(h.day) ?? ''} (${t})`, detail: str(h.question)?.slice(0, 160) ?? null, qtype: t, token: `Asked about ${t}` }); }
  for (const e of emails) {
    const sent = num(e.sent_at)!;
    ev.push({ ts: sent, type: 'email', label: `Email: ${str(e.subject) ?? str(e.template) ?? 'email'}`, detail: [str(e.sequence), e.opened_at ? 'opened' : null, e.clicked_at ? 'clicked' : null].filter(Boolean).join(' · '), token: null });
    if (num(e.clicked_at)) ev.push({ ts: num(e.clicked_at)!, type: 'email', label: `Clicked the email "${str(e.subject) ?? str(e.template) ?? ''}"`, token: 'Clicked an email' });
  }
  for (const m of sms) {
    ev.push({ ts: num(m.sent_at)!, type: 'sms', label: `${m.channel === 'whatsapp' ? 'WhatsApp' : 'Text'}: ${str(m.template) ?? str(m.sequence) ?? 'message'}`, detail: m.clicked_at ? 'clicked' : null, token: null });
    if (num(m.clicked_at)) ev.push({ ts: num(m.clicked_at)!, type: 'sms', label: 'Clicked a text', token: 'Clicked a text' });
  }
  for (const c of calls) {
    const at = num(c.wc_dialed_at) ?? num(c.run_at)!;
    ev.push({ ts: at, type: 'call', label: `AI call (${String(c.kind).replace(/_/g, ' ')}): ${c.status === 'done' ? 'connected' : 'no answer'}`, token: c.status === 'done' ? 'Spoke to the AI caller' : null });
  }
  for (const v of inbound) ev.push({ ts: num(v.started_at) ?? num(v.created_at)!, type: 'call', label: `Called in (AI assistant)${num(v.duration_s) ? `: ${Math.round(num(v.duration_s)! / 60)} min` : ''}`, token: 'Called in' });
  for (const p of passes) {
    const k = String(p.kind), what = str(p.product) ?? PASS_LABEL[k] ?? k;
    const unpaid = p.status === 'expired' || p.status === 'pending';
    ev.push({ ts: num(p.created_at)!, type: 'checkout', label: `Checkout: ${what}${p.one_click ? ' (one click)' : ''}`, detail: String(p.status), token: unpaid && !/addon/.test(k) ? 'Left a checkout unpaid' : null });
  }
  for (const c of convs) {
    const k = String(c.kind) as BuyerKind | 'registered';
    if (k === 'registered') continue; // the registered stage already says it
    ev.push({ ts: num(c.occurred_at)!, type: 'purchase', label: `${BUYER_LABEL[k]} (${FUNNEL_LABEL[String(c.funnel)] ?? c.funnel})`, detail: String(c.id), token: BUYER_LABEL[k] });
  }
  return ev.filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts || (a.type === 'purchase' ? 1 : 0) - (b.type === 'purchase' ? 1 : 0));
}

/** Minutes on screen: the masterclass, plus the live rooms or the live webinar's own minutes (the same minutes, so the larger). */
export function minutesBefore(before: JourneyEvent[]) {
  const sum = (xs: JourneyEvent[]) => xs.reduce((a, e) => a + (e.minutes ?? 0), 0);
  const att = before.filter((e) => e.type === 'attended' && e.minutes != null);
  const auto = sum(att.filter((e) => e.token?.startsWith('Attended the masterclass')));
  const live = sum(att.filter((e) => e.token?.startsWith('Attended the live webinar')));
  const rooms = sum(att.filter((e) => e.label.startsWith('In the room')));
  return auto + Math.max(live, rooms);
}

/** One buyer conversion's summary from the person's timeline (everything up to the purchase). */
export async function summarize(rt: Pick<Runtime, 'env'>, conv: Row, events: JourneyEvent[], leadCreated: number | null): Promise<PathSummary> {
  const db = rt.env.DB;
  const at = num(conv.occurred_at)!;
  const kind = String(conv.kind) as BuyerKind;
  const before = events.filter((e) => e.ts <= at);
  // First touch: what the conversion recorded at the time (it may come from the checkout's metadata), else the first visit.
  const t0 = await db.prepare('SELECT ts, platform, channel, medium, campaign, content, ad_id, landing FROM attr_touches WHERE lead_id = ? AND ts <= ? ORDER BY ts LIMIT 1').bind(String(conv.lead_id), at + 5000).first<Row>().catch(() => null);
  const adId = str(conv.ft_ad_id) ?? str(t0?.ad_id), content = str(conv.ft_content) ?? str(t0?.content);
  const ad = await adInfo(rt, adId, content);
  const firstTs = num(conv.ft_ts) ?? num(t0?.ts);
  const first: FirstAd = {
    ts: firstTs, platform: str(conv.ft_platform) ?? str(t0?.platform), channel: str(conv.ft_channel) ?? str(t0?.channel), campaign: str(conv.ft_campaign) ?? str(t0?.campaign),
    adId, adName: ad.adName, concept: ad.concept, hook: ad.hook, landing: str(conv.ft_landing) ?? str(t0?.landing), content,
  };
  const landers = await all(db.prepare('SELECT landing, MIN(ts) AS ts FROM attr_touches WHERE lead_id = ? AND ts <= ? AND landing IS NOT NULL GROUP BY landing ORDER BY ts LIMIT 12').bind(String(conv.lead_id), at + 5000).all<{ landing: string }>());
  const emails = await db.prepare(
    `SELECT COUNT(*) AS sent, SUM(CASE WHEN opened_at IS NOT NULL AND opened_at <= ?2 THEN 1 ELSE 0 END) AS opened, SUM(CASE WHEN clicked_at IS NOT NULL AND clicked_at <= ?2 THEN 1 ELSE 0 END) AS clicked
       FROM emails WHERE lead_id = ?1 AND status = 'sent' AND sent_at <= ?2`,
  ).bind(String(conv.lead_id), at).first<{ sent: number; opened: number | null; clicked: number | null }>().catch(() => null);
  const questions: Record<string, number> = {};
  for (const e of before) if (e.type === 'question' && e.qtype) questions[e.qtype] = (questions[e.qtype] ?? 0) + 1;
  const attended = before.filter((e) => e.type === 'attended' && (e.minutes != null || /^Attended /.test(e.label))).map((e) => ({ label: e.label, minutes: e.minutes ?? null }));
  const pushes = before.filter((e) => e.type === 'push');
  const checkouts = before.filter((e) => e.type === 'checkout' && /^Checkout: /.test(e.label));
  const passKind = kind === 'deposit_paid' ? /deposit/i : kind === 'sprint_paid' ? /sprint|offer/i : null;
  const relevant = passKind ? checkouts.filter((e) => passKind.test(e.label) && !/add-on/i.test(e.label)) : [];
  const start = firstTs ?? leadCreated;
  const steps = pathSteps(events, at, BUYER_LABEL[kind]);
  return {
    convId: String(conv.id), kind, funnel: str(conv.funnel), at,
    amount: num(conv.amount) != null && str(conv.currency) ? fromMinor(num(conv.amount)! - (num(conv.refunded) ?? 0), String(conv.currency)) : null, currency: str(conv.currency)?.toUpperCase() ?? null,
    first, landers: landers.map((l) => l.landing), attended,
    minutes: minutesBefore(before),
    pushes: { seen: pushes.length, opened: pushes.filter((e) => e.detail && (PUSH_RANK[e.detail] ?? 0) >= 2).length },
    questions,
    emails: { sent: emails?.sent ?? 0, opened: emails?.opened ?? 0, clicked: emails?.clicked ?? 0 },
    sms: { sent: before.filter((e) => e.type === 'sms' && !/^Clicked/.test(e.label)).length, clicked: before.filter((e) => e.type === 'sms' && /^Clicked/.test(e.label)).length },
    calls: { made: before.filter((e) => e.type === 'call').length, connected: before.filter((e) => e.type === 'call' && !/no answer/.test(e.label)).length },
    checkouts: { attempts: relevant.length, unpaid: relevant.filter((e) => e.detail !== 'paid').length },
    hoursToBuy: start != null && at >= start ? Math.round(((at - start) / HOUR) * 10) / 10 : null,
    steps,
  };
}

/** GET /admin/api/attribution/buyer/:lead: the person's timeline and one summary per purchase. */
export async function buyerJourney(rt: Pick<Runtime, 'env'>, leadId: string) {
  const db = rt.env.DB;
  const lead = await db.prepare('SELECT id, first_name, last_name, email, created_at FROM leads WHERE id = ?').bind(leadId).first<Row>();
  if (!lead) return null;
  const events = await leadTimeline(rt, leadId);
  const convs = await all(db.prepare(`SELECT * FROM attr_conversions WHERE lead_id = ? AND kind IN (${BUYER_KINDS.map(() => '?').join(', ')}) ORDER BY occurred_at`).bind(leadId, ...BUYER_KINDS).all());
  const buys: PathSummary[] = [];
  for (const c of convs) buys.push(await summarize(rt, c, events, num(lead.created_at)));
  return {
    lead: { id: leadId, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || String(lead.email ?? ''), created_at: num(lead.created_at) },
    buyer: buys.length > 0, buys, events: events.slice(-400),
  };
}

// ───────────── stored paths and the aggregate ─────────────

/** Computes (or refreshes) the stored path of buyer conversions that have none yet. Idempotent; bounded per run. */
export async function syncBuyerPaths(rt: Pick<Runtime, 'env'>, o: { limit?: number; now?: number } = {}) {
  const db = rt.env.DB;
  const now = o.now ?? Date.now();
  const todo = await all(db.prepare(
    `SELECT c.* FROM attr_conversions c LEFT JOIN attr_buyer_paths p ON p.conv_id = c.id
      WHERE c.kind IN (${BUYER_KINDS.map(() => '?').join(', ')})
        AND (p.conv_id IS NULL OR (p.computed_at < c.occurred_at + ? AND p.computed_at < ? - 1800000))
      ORDER BY p.conv_id IS NOT NULL, c.occurred_at DESC LIMIT ?`,
  ).bind(...BUYER_KINDS, REFRESH_WINDOW, now, o.limit ?? 40).all());
  const timelines = new Map<string, JourneyEvent[]>();
  let n = 0;
  for (const c of todo) {
    const leadId = String(c.lead_id);
    if (!timelines.has(leadId)) timelines.set(leadId, await leadTimeline(rt, leadId));
    const created = await db.prepare('SELECT created_at FROM leads WHERE id = ?').bind(leadId).first<{ created_at: number }>().catch(() => null);
    const s = await summarize(rt, c, timelines.get(leadId)!, created?.created_at ?? null);
    await db.prepare(
      `INSERT INTO attr_buyer_paths (conv_id, lead_id, kind, funnel, occurred_at, hours_to_buy, path, summary, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conv_id) DO UPDATE SET hours_to_buy = excluded.hours_to_buy, path = excluded.path, summary = excluded.summary, funnel = excluded.funnel, computed_at = excluded.computed_at`,
    ).bind(s.convId, leadId, s.kind, s.funnel, s.at, s.hoursToBuy, s.steps.join(' > '), JSON.stringify(s), now).run();
    n++;
  }
  return n;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
};
const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([label, count]) => ({ label, count }));

/**
 * Funnel HQ → Webinar attribution → "Common paths to a purchase". kind = deposit_paid (default), sprint_paid,
 * engagement_signed or 'all'. Every count is buyers (one per conversion) in the date range.
 */
export async function commonPaths(rt: Pick<Runtime, 'env'>, f: FunnelSel, r: Range, kind: BuyerKind | 'all' = 'deposit_paid') {
  const db = rt.env.DB;
  const kinds = kind === 'all' ? [...BUYER_KINDS] : [kind];
  const rows = await all(db.prepare(
    `SELECT conv_id, lead_id, kind, funnel, occurred_at, hours_to_buy, path, summary FROM attr_buyer_paths
      WHERE occurred_at BETWEEN ? AND ? AND kind IN (${kinds.map(() => '?').join(', ')}) ${f === 'all' ? '' : 'AND funnel = ?'} ORDER BY occurred_at DESC LIMIT 5000`,
  ).bind(r.from, r.to, ...kinds, ...(f === 'all' ? [] : [f])).all<{ conv_id: string; lead_id: string; kind: BuyerKind; funnel: string; occurred_at: number; hours_to_buy: number | null; path: string; summary: string }>());
  const buyers = rows.length;
  const seqs = new Map<string, { count: number; hours: number[]; leads: string[] }>();
  const stepCount = new Map<string, number>(), firstSrc = new Map<string, number>(), ads = new Map<string, number>(), concepts = new Map<string, number>(), hooks = new Map<string, number>(), qtypes = new Map<string, number>(), landers = new Map<string, number>();
  const hours: number[] = [], minutes: number[] = [];
  let emailClicked = 0, called = 0, abandonedFirst = 0, askedAny = 0, openedCard = 0;
  for (const row of rows) {
    const s = (() => { try { return JSON.parse(row.summary) as PathSummary; } catch { return null; } })();
    const q = seqs.get(row.path) ?? { count: 0, hours: [], leads: [] };
    q.count++; if (row.hours_to_buy != null) q.hours.push(row.hours_to_buy); if (q.leads.length < 5) q.leads.push(row.lead_id);
    seqs.set(row.path, q);
    for (const st of new Set(row.path.split(' > '))) stepCount.set(st, (stepCount.get(st) ?? 0) + 1);
    if (row.hours_to_buy != null) hours.push(row.hours_to_buy);
    if (!s) continue;
    firstSrc.set(sourceToken({ platform: s.first.platform, channel: s.first.channel, adId: s.first.adId }), (firstSrc.get(sourceToken({ platform: s.first.platform, channel: s.first.channel, adId: s.first.adId })) ?? 0) + 1);
    if (s.first.adId) ads.set(s.first.adName ? `${s.first.adName} (${s.first.adId})` : s.first.adId, (ads.get(s.first.adName ? `${s.first.adName} (${s.first.adId})` : s.first.adId) ?? 0) + 1);
    if (s.first.concept) concepts.set(s.first.concept, (concepts.get(s.first.concept) ?? 0) + 1);
    if (s.first.hook) hooks.set(s.first.hook, (hooks.get(s.first.hook) ?? 0) + 1);
    for (const l of new Set(s.landers)) landers.set(l, (landers.get(l) ?? 0) + 1);
    const qs = Object.keys(s.questions);
    if (qs.length) askedAny++;
    for (const t of qs) qtypes.set(t, (qtypes.get(t) ?? 0) + 1);
    if (s.minutes > 0) minutes.push(s.minutes);
    if (s.emails.clicked > 0) emailClicked++;
    if (s.calls.connected > 0) called++;
    if (s.checkouts.unpaid > 0) abandonedFirst++;
    if (s.pushes.opened > 0) openedCard++;
  }
  const sequences = [...seqs.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([path, v]) => ({ steps: path.split(' > '), count: v.count, share: buyers ? v.count / buyers : 0, medianHours: median(v.hours), leads: v.leads }));
  return {
    kind, funnel: f, range: r, buyers,
    distinctPaths: seqs.size,
    sequences,
    steps: top(stepCount, 30).map((x) => ({ ...x, share: buyers ? x.count / buyers : 0 })),
    firstTouch: top(firstSrc, 10), ads: top(ads, 10), concepts: top(concepts, 10), hooks: top(hooks, 10), landers: top(landers, 10),
    questions: top(qtypes, 8), askedAny,
    medianHoursToBuy: median(hours), medianMinutes: median(minutes),
    touched: { emailClicked, aiCallConnected: called, leftCheckoutFirst: abandonedFirst, openedRoomCard: openedCard },
  };
}

export const parseBuyerKind = (v: unknown): BuyerKind | 'all' => (v === 'all' || (BUYER_KINDS as readonly string[]).includes(String(v)) ? (v as BuyerKind | 'all') : 'deposit_paid');
