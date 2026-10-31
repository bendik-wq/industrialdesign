/**
 * Pure rules for the Instagram DM inbox: Meta's messaging windows, private-reply limits, Hot / Warm / Cold
 * scoring, priority, keyword trigger matching and script analytics. No I/O here, so it is all unit-tested.
 */

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const DM_STATUSES = ['new', 'replied', 'qualified', 'booked', 'showed', 'closed', 'lost'] as const;
export type DmStatus = (typeof DM_STATUSES)[number];
export const STATUS_RANK: Record<DmStatus, number> = { new: 0, replied: 1, qualified: 2, booked: 3, showed: 4, closed: 5, lost: 5 };

export type Band = 'hot' | 'warm' | 'cold';

// ───────────────────────────── Messaging windows ─────────────────────────────

export interface WindowThread {
  last_in_at: number | null;
  window_hours?: number | null;
}

export type SendMode = 'standard' | 'human_agent' | 'closed';

export interface WindowState {
  /** What a message sent now would be: inside the standard window, a human agent reply (7 days, tagged), or not allowed. */
  mode: SendMode;
  /** When the standard window ends (null when they've never messaged). */
  standardEndsAt: number | null;
  /** When the human agent window ends. */
  humanEndsAt: number | null;
  /** Milliseconds left in the window that applies to `mode`. */
  msLeft: number;
}

/**
 * Meta's rules: a business can message someone only after they have messaged it, inside the standard window
 * (24 hours from their last message; up to 7 days after a click-to-Direct ad). A human agent can reply for
 * 7 days from their last message with the HUMAN_AGENT tag (needs Meta's approval, so it is a setting).
 * Automated messages (triggers, the assistant) only ever use the standard window.
 */
export function windowState(t: WindowThread, now: number, o: { humanAgent?: boolean; automated?: boolean } = {}): WindowState {
  if (!t.last_in_at) return { mode: 'closed', standardEndsAt: null, humanEndsAt: null, msLeft: 0 };
  const hours = Math.min(168, Math.max(24, Number(t.window_hours) || 24));
  const standardEndsAt = t.last_in_at + hours * HOUR;
  const humanEndsAt = t.last_in_at + 7 * DAY;
  if (now < standardEndsAt) return { mode: 'standard', standardEndsAt, humanEndsAt, msLeft: standardEndsAt - now };
  if (o.humanAgent && !o.automated && now < humanEndsAt) return { mode: 'human_agent', standardEndsAt, humanEndsAt, msLeft: humanEndsAt - now };
  return { mode: 'closed', standardEndsAt, humanEndsAt, msLeft: 0 };
}

/** "18h left", "40m left", "closed". */
export function windowLabel(w: WindowState) {
  if (w.mode === 'closed') return w.standardEndsAt ? 'Window closed' : 'They have not messaged yet';
  const h = Math.floor(w.msLeft / HOUR);
  const left = h >= 1 ? `${h}h left` : `${Math.max(1, Math.round(w.msLeft / 60_000))}m left`;
  return w.mode === 'human_agent' ? `Human agent reply, ${left}` : left;
}

// ───────────────────────────── Private replies to comments ─────────────────────────────

export interface CommentForReply { ts: number; private_reply_at: number | null; parent_id?: string | null }

/** One private reply per comment, within 7 days of the comment. */
export function privateReplyBlock(c: CommentForReply, now: number): string | null {
  if (c.private_reply_at) return 'This comment already had its private reply';
  if (now - c.ts > 7 * DAY) return 'Private replies are only allowed within 7 days of the comment';
  return null;
}

/** Public replies go on top-level comments only (Meta adds replies-to-replies to the top-level comment). */
export const publicReplyTarget = (c: { id: string; parent_id?: string | null }) => c.parent_id || c.id;

// ───────────────────────────── Scoring ─────────────────────────────

export interface ScoreInput {
  /** Their messages (and comments), oldest first. */
  texts: string[];
  /** Messages we sent. */
  outbound?: number;
  storyReplies?: number;
  /** Revenue band already known from an application (e.g. "1-3M"). */
  knownBand?: string | null;
}

export interface ScoreResult { score: number; band: Band; revenueBand: string | null; reason: string }

const MONEY_RE = /(?:\$|usd|aud|us\$|a\$)?\s?(\d+(?:[.,]\d+)?)\s?(k|m|mm|mil|million|thousand|b|bn|billion)\b/gi;

/** Revenue they state, in dollars per year (the largest figure near a revenue word, or any "7 / 8 figures"). */
export function statedRevenue(text: string): number | null {
  const t = text.toLowerCase();
  let best: number | null = null;
  const fig = t.match(/\b(6|7|8|9|six|seven|eight|nine)[ -]?figures?\b/);
  if (fig) {
    const n = { '6': 6, six: 6, '7': 7, seven: 7, '8': 8, eight: 8, '9': 9, nine: 9 }[fig[1] as '6'];
    best = 10 ** (n - 1);
  }
  const revenueContext = /(revenue|turnover|sales|doing|make|making|generat|bring in|top ?line|a year|per year|annual|p\.?a\.?|\/yr|business|company|clinic|practice|firm)/;
  for (const m of t.matchAll(MONEY_RE)) {
    const around = t.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length + 40);
    if (!revenueContext.test(around)) continue;
    const unit = m[2].toLowerCase();
    const mult = unit.startsWith('k') || unit === 'thousand' ? 1e3 : unit.startsWith('b') ? 1e9 : 1e6;
    const v = Number(m[1].replace(',', '.')) * mult;
    if (v >= 10_000 && (best === null || v > best)) best = v;
  }
  return best;
}

export function revenueBandOf(v: number | null): string | null {
  if (v === null) return null;
  if (v >= 10e6) return '10M+';
  if (v >= 3e6) return '3-10M';
  if (v >= 1e6) return '1-3M';
  return '<1M';
}

const SIZE_RE = /\b(\d+\s+(employees|staff|locations|clinics|stores|sites|branches|trucks|offices|practices)|team of \d+|i own|we own|my (company|business|practice|clinic|firm|agency)|owner|founder|ceo|managing director|multiple locations)\b/gi;
const INTENT_RE = /\b(buy|buying|acquire|acquisition|acquiring|competitor|how do i (start|begin|get started)|how much|price|pricing|cost|fee|book(ed)?|call|ready|next step|interested|sign up|apply|seller financ\w*|loi|deal)\b/gi;
const NEGATIVE_RE = /\b(student|no money|broke|unemployed|just curious|giveaway|free (course|money)|looking for (a )?job|hiring\?|need a job|crypto|forex|bitcoin|promote your (page|account)|collab|shoutout|followers)\b/gi;
const SPAM_RE = /(https?:\/\/|www\.)\S+|\b(dm me for|check my bio|earn \$?\d+ (a|per) day|investment opportunity|sugar (daddy|mommy))\b/i;

const uniq = (a: string[]) => [...new Set(a.map((s) => s.toLowerCase().trim()))];

/** Hot / Warm / Cold by revenue potential, with a short reason built from the signals found. */
export function scoreConversation(i: ScoreInput): ScoreResult {
  const text = i.texts.join('\n');
  const reasons: string[] = [];
  let score = 0;
  const stated = statedRevenue(text);
  const revenueBand = revenueBandOf(stated) ?? (i.knownBand || null);
  const bandPts: Record<string, number> = { '10M+': 45, '3-10M': 40, '1-3M': 30, '<1M': 5 };
  if (revenueBand) {
    score += bandPts[revenueBand] ?? (/^(1-3M|3-10M|10M\+|10-25M|25-50M|50M\+)$/.test(revenueBand) ? 35 : 5);
    reasons.push(stated !== null ? `States ${revenueBand} revenue` : `${revenueBand} revenue on file`);
  }
  const size = uniq(text.match(SIZE_RE) ?? []);
  if (size.length) { score += Math.min(20, size.length * 10); reasons.push(`Business size: ${size.slice(0, 2).join(', ')}`); }
  const intent = uniq(text.match(INTENT_RE) ?? []);
  if (intent.length) { score += Math.min(25, intent.length * 10); reasons.push(`Intent: ${intent.slice(0, 3).join(', ')}`); }
  const engagement = Math.min(15, Math.max(0, i.texts.length - 1) * 3 + (i.storyReplies ?? 0) * 3 + (i.outbound && i.texts.length > 1 ? 3 : 0));
  if (engagement >= 6) reasons.push(`${i.texts.length} messages from them`);
  score += engagement;
  const neg = uniq(text.match(NEGATIVE_RE) ?? []);
  if (neg.length) { score -= 20 * Math.min(2, neg.length); reasons.push(`Low fit: ${neg.slice(0, 2).join(', ')}`); }
  if (SPAM_RE.test(text)) { score -= 25; reasons.push('Looks like spam'); }
  score = Math.max(0, Math.min(100, score));
  const band: Band = score >= 55 ? 'hot' : score >= 20 ? 'warm' : 'cold';
  return { score, band, revenueBand, reason: reasons.join(' · ') || 'No revenue or intent signals yet' };
}

// ───────────────────────────── Priority ─────────────────────────────

export interface PriorityThread extends WindowThread {
  band: string | null;
  last_out_at: number | null;
  ai_flag?: string | null;
  status?: string;
}

/** Waiting for us: their last message is newer than ours. */
export const awaitingReply = (t: Pick<PriorityThread, 'last_in_at' | 'last_out_at'>) => Boolean(t.last_in_at && (!t.last_out_at || t.last_in_at > t.last_out_at));

/** Higher first: band, then how long they have waited, a bonus when the window is about to close; junk and finished threads sink. */
export function priority(t: PriorityThread, now: number) {
  if (t.ai_flag === 'junk') return -1000;
  let p = t.band === 'hot' ? 100 : t.band === 'warm' ? 50 : 10;
  if (t.ai_flag === 'closing') p += 40;
  if (awaitingReply(t)) {
    const waited = Math.min(DAY, now - (t.last_in_at ?? now));
    p += 30 + (waited / DAY) * 60;
    const w = windowState(t, now);
    if (w.mode === 'standard' && w.msLeft < 3 * HOUR) p += 25;
  }
  if (t.status === 'closed' || t.status === 'lost') p -= 200;
  return Math.round(p * 10) / 10;
}

// ───────────────────────────── Keyword triggers ─────────────────────────────

export type TriggerSource = 'comment' | 'story_reply' | 'dm';
export interface TriggerRule { id: string; keywords: string; match_mode: string; sources: string; active: number }

export const keywordList = (s: string) => s.split(/[,\n]/).map((k) => k.trim().toLowerCase()).filter(Boolean).slice(0, 30);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Does this text fire this trigger? word = whole word / phrase; contains = anywhere; exact = the whole message. */
export function matchesTrigger(rule: TriggerRule, source: TriggerSource, text: string): string | null {
  if (!rule.active) return null;
  let sources: string[] = [];
  try { sources = JSON.parse(rule.sources || '[]'); } catch { sources = []; }
  if (!sources.includes(source)) return null;
  const t = text.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  for (const k of keywordList(rule.keywords)) {
    if (rule.match_mode === 'exact' ? t.replace(/[^\p{L}\p{N} ]/gu, '').trim() === k : rule.match_mode === 'contains' ? t.includes(k) : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(k)}($|[^\\p{L}\\p{N}])`, 'u').test(t)) return k;
  }
  return null;
}

/** The first active trigger that matches, in the order given (oldest first). */
export function firstMatch<T extends TriggerRule>(rules: T[], source: TriggerSource, text: string): { rule: T; keyword: string } | null {
  for (const rule of rules) {
    const keyword = matchesTrigger(rule, source, text);
    if (keyword) return { rule, keyword };
  }
  return null;
}

/** Fills {first_name} / {name} / {username} / {link} in a script or trigger message. */
export function fillTemplate(body: string, v: { first_name?: string | null; username?: string | null; link?: string | null }) {
  const first = (v.first_name || '').split(/\s+/)[0] || '';
  let out = body
    .replace(/\{first_name\}|\{name\}/g, first || 'there')
    .replace(/\{username\}/g, v.username ? `@${v.username}` : '')
    .replace(/\{link\}/g, v.link || '');
  if (v.link && !body.includes('{link}')) out = `${out.trim()}\n${v.link}`;
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

// ───────────────────────────── Script analytics ─────────────────────────────

export interface ScriptUse { script_id: string; thread_id: string; ts: number }

export interface ScriptStat {
  script_id: string;
  uses: number;
  threads: number;
  replied: number;
  booked: number;
  closed: number;
  reply_rate: number | null;
  book_rate: number | null;
  close_rate: number | null;
  share: number;
}

/**
 * Per script: how many conversations it was used in, and how many of those got a reply after it,
 * reached a booked call (booked / showed / closed) and closed. Rates are per conversation.
 */
export function scriptStats(uses: ScriptUse[], inbound: Map<string, number[]>, status: Map<string, string>): ScriptStat[] {
  const by = new Map<string, { uses: number; threads: Map<string, number> }>();
  for (const u of uses) {
    let s = by.get(u.script_id);
    if (!s) by.set(u.script_id, (s = { uses: 0, threads: new Map() }));
    s.uses++;
    const first = s.threads.get(u.thread_id);
    if (first === undefined || u.ts < first) s.threads.set(u.thread_id, u.ts);
  }
  const total = uses.length || 1;
  const rate = (a: number, b: number) => (b ? a / b : null);
  return [...by.entries()].map(([script_id, s]) => {
    let replied = 0, booked = 0, closed = 0;
    for (const [tid, ts] of s.threads) {
      if ((inbound.get(tid) ?? []).some((t) => t > ts)) replied++;
      const st = (status.get(tid) ?? 'new') as DmStatus;
      if (STATUS_RANK[st] >= 3 && st !== 'lost') booked++;
      if (st === 'closed') closed++;
    }
    const n = s.threads.size;
    return { script_id, uses: s.uses, threads: n, replied, booked, closed, reply_rate: rate(replied, n), book_rate: rate(booked, n), close_rate: rate(closed, n), share: s.uses / total };
  }).sort((a, b) => b.uses - a.uses);
}

/** Best and worst by reply rate, among scripts used in at least `minThreads` conversations (so one lucky send can't win). */
export function bestAndWorst(stats: ScriptStat[], minThreads = 5) {
  const ranked = stats.filter((s) => s.threads >= minThreads && s.reply_rate !== null).sort((a, b) => (b.reply_rate! - a.reply_rate!) || (b.book_rate ?? 0) - (a.book_rate ?? 0));
  if (ranked.length < 2) return { best: ranked[0] ?? null, worst: null, minThreads };
  return { best: ranked[0], worst: ranked[ranked.length - 1], minThreads };
}

// ───────────────────────────── Lead matching helpers ─────────────────────────────

export const EMAIL_IN_TEXT = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
/** An email or phone number someone typed in a DM, for linking the conversation to an existing lead. */
export function contactsIn(text: string): { email: string | null; phone: string | null } {
  const email = text.match(EMAIL_IN_TEXT)?.[0]?.toLowerCase() ?? null;
  const phoneRaw = text.match(/\+?\d[\d\s().-]{7,}\d/)?.[0] ?? null;
  const digits = phoneRaw?.replace(/\D/g, '') ?? '';
  return { email, phone: digits.length >= 9 && digits.length <= 15 ? digits : null };
}
