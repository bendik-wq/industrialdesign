import type { Runtime } from '../app';
import { copyBrief } from '../content/copy-rules';
import { type Ask, type Brain, parseJsonReply } from '../studio/scripts';
import { askJson } from './analyse';
import { relevantTo } from './engine';

/**
 * Radar v2 (builder C): viral formats.
 *
 * 1. Extraction: one STRICT JSON per top performer (video transcript or text body): a short reusable format name,
 *    the hook (text, type from a fixed taxonomy, why it works), the beats, the devices, the length bucket, retention
 *    risks (estimates, labelled), the CTA, the audience, the emotional driver and why it went viral (grounded in the
 *    numbers). Validated and clamped here: unknown taxonomy values become 'other'.
 * 2. Clustering (deterministic): name tokens + hook family + main devices + length bucket make a signature; signatures
 *    whose names overlap (token Jaccard >= 0.5) within the same hook family merge. One model call per cluster names it.
 * 3. Ranking: median outlier score x breadth (platforms) x recency (x a small support factor for one-off items), and
 *    "white space": formats that win in adjacent niches but are absent or weak in ours, above all when owners watch.
 */

// ───────────── the taxonomy ─────────────

export const HOOK_TYPES = ['result_first', 'contrarian', 'curiosity_gap', 'number', 'question', 'story_cold_open', 'call_out', 'proof_screenshot', 'other'] as const;
export type HookType = (typeof HOOK_TYPES)[number];
/** Hook families: two signatures merge only within one family. */
export const HOOK_FAMILY: Record<HookType, string> = {
  result_first: 'result', number: 'result', proof_screenshot: 'result',
  contrarian: 'tension', curiosity_gap: 'tension', question: 'tension',
  story_cold_open: 'story', call_out: 'callout', other: 'other',
};
export const ROLES = ['hook', 'stakes', 'setup', 'turn', 'proof', 'payoff', 'cta', 'other'] as const;
export type Role = (typeof ROLES)[number];
export const DEVICES = ['on_screen_numbers', 'scorecard', 'split_screen', 'street_interview', 'screen_recording', 'text_overlay', 'list', 'thread', 'chart', 'talking_head', 'b_roll', 'whiteboard', 'document', 'carousel', 'meme', 'other'] as const;
export type Device = (typeof DEVICES)[number];
export const LENGTHS = ['micro', 'short', 'mid', 'long', 'xl', 'post', 'thread', 'article'] as const;
export type LengthBucket = (typeof LENGTHS)[number];
export const AUDIENCES = ['employee', 'aspiring_buyer', 'owner_1m', 'investor', 'general'] as const;
export type Audience = (typeof AUDIENCES)[number];
export const EMOTIONS = ['greed', 'fear', 'curiosity', 'status', 'envy', 'anger', 'relief', 'hope', 'belonging', 'other'] as const;
export type Emotion = (typeof EMOTIONS)[number];
export const TEXT_PLATFORMS = ['x', 'linkedin', 'reddit', 'substack'] as const;
export const isTextPlatform = (p: string) => (TEXT_PLATFORMS as readonly string[]).includes(p);

export interface Beat { at: string; role: Role; summary: string }
export interface Extraction {
  format_name: string;
  hook: { text: string; type: HookType; why_it_works: string };
  beats: Beat[];
  devices: Device[];
  length_bucket: LengthBucket;
  retention_risks: { at: string; why: string; estimate: true }[];
  cta: string;
  audience: Audience[];
  emotional_driver: Emotion;
  why_viral: string;
}

const S = { type: 'string' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const en = (xs: readonly string[]) => ({ type: 'string', enum: [...xs] });
export const EXTRACT_SCHEMA = obj({
  format_name: S,
  hook: obj({ text: S, type: en(HOOK_TYPES), why_it_works: S }),
  beats: { type: 'array', items: obj({ at: S, role: en(ROLES), summary: S }) },
  devices: { type: 'array', items: en(DEVICES) },
  length_bucket: en(LENGTHS),
  retention_risks: { type: 'array', items: obj({ at: S, why: S }) },
  cta: S,
  audience: { type: 'array', items: en(AUDIENCES) },
  emotional_driver: en(EMOTIONS),
  why_viral: S,
});
export const NAME_SCHEMA = obj({ name: S, definition: S });

// ───────────── validation ─────────────

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const norm = (v: unknown) => clip(v, 40).toLowerCase().replace(/[\s-]+/g, '_');
function pick<T extends string>(list: readonly T[], v: unknown, d: T): T { const k = norm(v); return (list as readonly string[]).includes(k) ? (k as T) : d; }
const uniq = <T>(xs: T[]) => [...new Set(xs)];

/** The length bucket from the numbers we hold (the model's guess only when we hold none). */
export function lengthBucket(i: { platform: string; duration_s?: number | null; words?: number; text_words?: number; media_kind?: string | null }, model?: unknown): LengthBucket {
  if (isTextPlatform(i.platform) || (i.platform === 'meta_ads' && i.media_kind !== 'video')) {
    const w = i.text_words ?? 0;
    if (i.platform === 'substack') return 'article';
    if (i.platform === 'x') return w > 80 ? 'thread' : 'post';
    return w > 350 ? 'article' : 'post';
  }
  const s = i.duration_s && i.duration_s > 0 ? i.duration_s : i.words ? (i.words / 150) * 60 : 0;
  if (s > 0) return s < 20 ? 'micro' : s < 60 ? 'short' : s < 180 ? 'mid' : s < 900 ? 'long' : 'xl';
  return pick(LENGTHS, model, 'short');
}

/** Validate and clamp an extraction. Throws when there is no format name or hook (nothing to cluster). */
export function cleanExtraction(raw: unknown, item: { platform: string; duration_s?: number | null; words?: number; text_words?: number; media_kind?: string | null }): Extraction {
  const r = isObj(raw) ? raw : {};
  const h = isObj(r.hook) ? r.hook : {};
  const out: Extraction = {
    format_name: clip(r.format_name, 80).replace(/[.!]+$/, ''),
    hook: { text: clip(h.text, 400), type: pick(HOOK_TYPES, h.type, 'other'), why_it_works: clip(h.why_it_works ?? h.why, 600) },
    beats: arr(r.beats).filter(isObj).slice(0, 16).map((b) => ({ at: clip(b.at ?? b.t ?? b.position, 16), role: pick(ROLES, b.role, 'other'), summary: clip(b.summary ?? b.what, 300) })).filter((b) => b.summary),
    devices: uniq(arr(r.devices).map((d) => pick(DEVICES, d, 'other'))).slice(0, 6),
    length_bucket: lengthBucket(item, r.length_bucket),
    retention_risks: arr(r.retention_risks).filter(isObj).slice(0, 5).map((x) => ({ at: clip(x.at ?? x.t, 16), why: clip(x.why, 300), estimate: true as const })).filter((x) => x.why),
    cta: clip(r.cta, 240),
    audience: uniq(arr(r.audience).map((a) => pick(AUDIENCES, a, 'general'))).slice(0, 4),
    emotional_driver: pick(EMOTIONS, r.emotional_driver, 'other'),
    why_viral: clip(r.why_viral, 700),
  };
  if (!out.audience.length) out.audience = ['general'];
  if (out.devices.length > 1) out.devices = out.devices.filter((d) => d !== 'other');
  if (!out.format_name || !out.hook.text) throw new Error('The extraction came back without a format name or a hook.');
  return out;
}

// ───────────── prompts ─────────────

export function extractSystemPrompt(): string {
  return `You are a content analyst who reverse-engineers why posts and videos go viral, so a team can reuse the FORMAT (not the words) in another niche.

Return STRICT JSON with:
- format_name: a short, reusable name for the format, 3 to 7 words, that would fit many creators (examples: "Deal teardown with live scorecard", "Street wealth interview", "I bought X, here's what it made", "Contrarian PE explainer", "Listicle thread", "Founder failure autopsy"). Never the creator's name or the topic alone.
- hook: text (the exact opening words; from the transcript or the post's first lines, word for word), type (one of ${HOOK_TYPES.join(', ')}), why_it_works (one or two sentences).
- beats: the structure in order. at: m:ss for video (from the transcript marks, or an estimate) or a position like "line 1", "para 3", "tweet 4" for text. role: one of ${ROLES.join(', ')}. summary: what happens, one sentence.
- devices: the production or writing devices used, from: ${DEVICES.join(', ')}.
- length_bucket: one of ${LENGTHS.join(', ')}.
- retention_risks: where attention likely drops and why. These are ESTIMATES from the structure and the numbers; never present them as measured.
- cta: the call to action, or "" when there is none.
- audience: who it speaks to, from: ${AUDIENCES.join(', ')} (owner_1m = owners of businesses doing $1M+ revenue).
- emotional_driver: one of ${EMOTIONS.join(', ')}.
- why_viral: why it outperformed, grounded in the numbers given (outlier ratio against the creator or the platform, engagement rate, shares or reposts against views). Say which number shows it.

Quote the creator only in hook.text. Plain words, no em dashes, no exclamation marks, no emojis. Return JSON only.`;
}

export interface ExtractInput {
  id: string; platform: string; title: string | null; caption: string | null; author: string | null; url: string | null;
  body_text?: string | null; transcript: string | null; duration_s: number | null; media_kind?: string | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; followers: number | null;
  reposts?: number | null; bookmarks?: number | null; saves?: number | null;
  score: number; score_json: string | null; published_at: string | null; niche: string | null;
}

const num = (v: number | null | undefined) => (v == null ? 'unknown' : Number(v).toLocaleString('en-US'));
const wordsIn = (s: string | null | undefined) => (s ? s.split(/\s+/).filter(Boolean).length : 0);

export function extractUserPrompt(i: ExtractInput): string {
  const parts = (() => { try { return i.score_json ? (JSON.parse(i.score_json) as Record<string, number | string>) : {}; } catch { return {}; } })();
  const text = isTextPlatform(i.platform) ? i.body_text || i.caption || '' : '';
  const lines = [
    `Platform: ${i.platform}${isTextPlatform(i.platform) ? ' (a text post)' : ''}`, `By: ${i.author ?? 'unknown'}`,
    i.title ? `Title: ${i.title}` : '',
    !isTextPlatform(i.platform) && i.caption ? `Caption: ${i.caption.slice(0, 1500)}` : '',
    `Numbers: views ${num(i.views)}, likes ${num(i.likes)}, comments ${num(i.comments)}, shares ${num(i.shares)}, reposts ${num(i.reposts)}, bookmarks ${num(i.bookmarks)}, saves ${num(i.saves)}, author followers ${num(i.followers)}, published ${i.published_at ?? 'unknown'}${i.duration_s ? `, length ${Math.round(i.duration_s)} s` : ''}.`,
    `Outlier score ${Math.round(i.score)} of 100${parts.ratio != null ? `; ${Number(parts.ratio).toFixed(1)}x against ${parts.ratio_basis === 'followers' ? 'followers' : parts.ratio_basis === 'author' ? 'the creator\'s typical views' : 'the platform\'s typical views'}` : ''}${parts.engagement != null ? `; engagement ${(Number(parts.engagement) * 100).toFixed(1)}%` : ''}.`,
    text ? `Full text:\n${text.slice(0, 12000)}` : i.transcript ? `Transcript:\n${i.transcript.slice(0, 12000)}` : 'Transcript: missing. Work from the title, the caption and the numbers, and say in why_it_works that the hook is inferred.',
  ];
  return `Extract the format.\n\n${lines.filter(Boolean).join('\n')}`;
}

/** Extract one item's format. */
export async function extractOne(ask: Ask, i: ExtractInput): Promise<Extraction> {
  const text = await ask(extractSystemPrompt(), [{ role: 'user', content: extractUserPrompt(i) }]);
  return cleanExtraction(parseJsonReply(text), { platform: i.platform, duration_s: i.duration_s, words: wordsIn(i.transcript), text_words: wordsIn(i.body_text || i.caption), media_kind: i.media_kind });
}

// ───────────── signatures and clustering ─────────────

const NAME_STOP = new Set(['the', 'a', 'an', 'with', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'i', 'x', 'here', 'heres', 'it', 'its', 'my', 'your', 'how', 'what', 'made', 'format', 'style', 'video', 'post', 'by', 'from', 'about', 'that', 'this']);
const CANON: Record<string, string> = { breakdown: 'teardown', analysis: 'teardown', dissection: 'teardown', autopsy: 'postmortem', postmortem: 'postmortem', listicle: 'list', threads: 'thread', storytime: 'story', reaction: 'react', reacting: 'react', interviews: 'interview', mistakes: 'mistake', lessons: 'lesson', explained: 'explainer', explaining: 'explainer', bought: 'buy', buying: 'buy', buys: 'buy' };

/** Normalised name tokens: lower case, no punctuation, stop words out, light plural folding, a few synonyms. */
export function nameTokens(name: string): string[] {
  const out = name.toLowerCase().normalize('NFKD').replace(/['’]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w && !NAME_STOP.has(w))
    .map((w) => CANON[w] ?? (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .map((w) => CANON[w] ?? w);
  return [...new Set(out)].sort();
}
export const mainDevices = (d: Device[]) => [...d].filter((x) => x !== 'other').sort().slice(0, 2);
export function signatureOf(e: Pick<Extraction, 'format_name' | 'hook' | 'devices' | 'length_bucket'>): string {
  return `${nameTokens(e.format_name).join('-')}|${HOOK_FAMILY[e.hook.type]}|${mainDevices(e.devices).join('+')}|${e.length_bucket}`;
}
export function jaccard(a: string[], b: string[]): number {
  if (!a.length && !b.length) return 1;
  const A = new Set(a), B = new Set(b);
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
/** FNV-1a, base 36: short stable ids. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export interface Member {
  item_id: string; platform: string; score: number; niche: string | null; published_at: string | null; first_seen: string;
  title: string | null; author: string | null; thumbnail_url: string | null; snippet: string | null;
  format_name: string; tokens: string[]; hook_type: HookType; devices: Device[]; length_bucket: LengthBucket; audience: Audience[];
  signature: string; prev_format_id: string | null;
}
export interface Cluster { seed: string; signatures: string[]; members: Member[] }

/** Group by exact signature, then merge signatures with name Jaccard >= 0.5 in the same hook family (union-find). */
export function clusterMembers(members: Member[], threshold = 0.5): Cluster[] {
  const bySig = new Map<string, Member[]>();
  for (const m of [...members].sort((a, b) => b.score - a.score || a.item_id.localeCompare(b.item_id))) bySig.set(m.signature, [...(bySig.get(m.signature) ?? []), m]);
  const sigs = [...bySig.keys()].sort();
  const parent = sigs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const info = sigs.map((s) => { const [tok, fam] = s.split('|'); return { tokens: tok ? tok.split('-') : [], fam }; });
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      if (info[i].fam !== info[j].fam) continue;
      if (jaccard(info[i].tokens, info[j].tokens) >= threshold) { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); }
    }
  }
  const groups = new Map<number, string[]>();
  sigs.forEach((s, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), s]));
  return [...groups.values()].map((ss) => {
    const ms = ss.flatMap((s) => bySig.get(s)!).sort((a, b) => b.score - a.score || a.item_id.localeCompare(b.item_id));
    const seed = [...ss].sort((a, b) => bySig.get(b)!.length - bySig.get(a)!.length || Math.max(...bySig.get(b)!.map((m) => m.score)) - Math.max(...bySig.get(a)!.map((m) => m.score)) || a.localeCompare(b))[0];
    return { seed, signatures: ss, members: ms };
  }).sort((a, b) => b.members.length - a.members.length || a.seed.localeCompare(b.seed));
}

/** Stable ids: a cluster keeps the id most of its members already had (unless a bigger cluster claimed it). */
export function assignIds(clusters: Cluster[]): (Cluster & { id: string })[] {
  const claimed = new Set<string>();
  return clusters.map((c) => {
    const votes = new Map<string, number>();
    for (const m of c.members) if (m.prev_format_id) votes.set(m.prev_format_id, (votes.get(m.prev_format_id) ?? 0) + 1);
    const prev = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).find(([id]) => !claimed.has(id))?.[0];
    let id = prev ?? `fmt_${hash(c.seed)}`;
    while (claimed.has(id)) id = `fmt_${hash(id + c.seed)}`;
    claimed.add(id);
    return { ...c, id };
  });
}

// ───────────── stats, ranking, white space ─────────────

export const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mode = <T extends string>(xs: T[], d: T): T => { const m = new Map<T, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? d; };
const at = (m: Member) => m.published_at || m.first_seen;

export interface FormatStats {
  count: number; platforms: Record<string, number>; platform_count: number;
  median_score: number; sparkline: number[];
  in_niche: number; adjacent: number; in_share: number; in_median: number; adj_median: number;
  audience: Record<string, number>; first_seen: string | null; last_seen: string | null;
  trend: { prev: number | null; delta: number | null; label: 'new' | 'up' | 'down' | 'flat' };
  examples: { id: string; platform: string; title: string | null; author: string | null; thumbnail_url: string | null; snippet: string | null; score: number }[];
}

export function statsFor(members: Member[], prevCount: number | null): FormatStats {
  const platforms: Record<string, number> = {};
  const audience: Record<string, number> = {};
  for (const m of members) { platforms[m.platform] = (platforms[m.platform] ?? 0) + 1; for (const a of m.audience) audience[a] = (audience[a] ?? 0) + 1; }
  const inN = members.filter((m) => m.niche === 'in' || m.niche === 'both');
  const adj = members.filter((m) => m.niche === 'out' || m.niche === 'both');
  const times = members.map(at).filter(Boolean).sort();
  const delta = prevCount == null ? null : members.length - prevCount;
  return {
    count: members.length, platforms, platform_count: Object.keys(platforms).length,
    median_score: Math.round(median(members.map((m) => m.score)) * 10) / 10,
    sparkline: [...members].sort((a, b) => at(a).localeCompare(at(b))).slice(-16).map((m) => Math.round(m.score)),
    in_niche: inN.length, adjacent: adj.length, in_share: members.length ? Math.round((inN.length / members.length) * 100) / 100 : 0,
    in_median: Math.round(median(inN.map((m) => m.score))), adj_median: Math.round(median(adj.map((m) => m.score))),
    audience, first_seen: times[0] ?? null, last_seen: times[times.length - 1] ?? null,
    trend: { prev: prevCount, delta, label: delta == null ? 'new' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' },
    examples: members.slice(0, 3).map((m) => ({ id: m.item_id, platform: m.platform, title: m.title, author: m.author, thumbnail_url: m.thumbnail_url, snippet: m.snippet, score: Math.round(m.score) })),
  };
}

/** Rank: median outlier x breadth (platforms) x recency, times a support factor so a one-off item does not lead. */
export function rankOf(s: FormatStats, now = Date.now()): number {
  const breadth = 1 + 0.35 * Math.max(0, s.platform_count - 1);
  const days = s.last_seen ? Math.max(0, (now - Date.parse(s.last_seen)) / 86400_000) : 365;
  const recency = Math.max(0.25, Math.min(1, Math.pow(0.5, days / 45)));
  const support = Math.min(1, 0.4 + 0.2 * s.count);
  return Math.round((s.median_score / 100) * breadth * recency * support * 1000) / 10;
}

/** White space: wins in adjacent niches (2+ items, median 30+) while absent or weak in ours. 2 = owners watch it too. */
export function whiteSpace(s: FormatStats): { level: 0 | 1 | 2; why: string | null } {
  const wins = s.adjacent >= 2 && s.adj_median >= 30;
  const weak = s.in_niche === 0 || s.in_median < 0.6 * s.adj_median;
  if (!wins || !weak) return { level: 0, why: null };
  const owners = (s.audience.owner_1m ?? 0) > 0;
  const ours = s.in_niche === 0 ? 'nobody in our niche uses it yet' : `in our niche it scores a median ${s.in_median} from ${s.in_niche} item${s.in_niche === 1 ? '' : 's'}`;
  return { level: owners ? 2 : 1, why: `Wins outside our niche (${s.adjacent} items, median score ${s.adj_median}) and ${ours}${owners ? '. Its audience includes $1M+ owners' : ''}.` };
}

// ───────────── naming ─────────────

export function ruleName(c: Cluster): { name: string; definition: string } {
  const names = c.members.map((m) => m.format_name);
  const counts = new Map<string, number>(); for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const name = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  const hook = mode(c.members.map((m) => m.hook_type), 'other').replace(/_/g, ' ');
  const dev = mainDevices(c.members.flatMap((m) => m.devices)).map((d) => d.replace(/_/g, ' ')).join(' and ');
  return { name: name.charAt(0).toUpperCase() + name.slice(1), definition: `Opens with a ${hook} hook${dev ? ` and leans on ${dev}` : ''}.\nSeen ${c.members.length} time${c.members.length === 1 ? '' : 's'} across ${new Set(c.members.map((m) => m.platform)).size} platform${new Set(c.members.map((m) => m.platform)).size === 1 ? '' : 's'}.` };
}

/** Clean a model-named format: short name, two lines at most, house punctuation. */
export function cleanName(raw: unknown, fallback: { name: string; definition: string }): { name: string; definition: string } {
  const r = isObj(raw) ? raw : {};
  const tidy = (s: string) => s.replace(/[—–]/g, ',').replace(/!/g, '.').replace(/\s+,/g, ',');
  const name = tidy(clip(r.name, 60)).replace(/[.]+$/, '');
  const def = tidy(String(r.definition ?? '').replace(/\r/g, '')).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n').slice(0, 320);
  return { name: name || fallback.name, definition: def || fallback.definition };
}

export async function nameCluster(ask: Ask, c: Cluster): Promise<{ name: string; definition: string }> {
  const fb = ruleName(c);
  const ex = c.members.slice(0, 8).map((m) => `- ${m.platform}, score ${Math.round(m.score)}: "${m.format_name}" (hook ${m.hook_type}; devices ${m.devices.join(', ') || 'none'}; ${m.length_bucket})${m.title ? `: ${m.title.slice(0, 120)}` : ''}`).join('\n');
  const text = await ask(`You name content formats. Given several posts or videos that share a format, return JSON {name, definition}. name: 3 to 6 words, reusable across niches, Title case, no creator names. definition: exactly two short lines separated by a newline: line 1 what the format is, line 2 why it works. ${copyBrief('ideas')}\nNo em dashes, no exclamation marks. Return JSON only.`,
    [{ role: 'user', content: `These share one format:\n${ex}` }]);
  return cleanName(parseJsonReply(text), fb);
}

// ───────────── the steps (both used by the pipeline and the routes) ─────────────

export const radarFormatConfig = (rt: Runtime) => {
  const n = Number(rt.settings.RADAR_EXTRACT_PER_SWEEP);
  const a = Number(rt.settings.RADAR_ADAPT_TOP);
  return {
    perSweep: rt.settings.RADAR_EXTRACT_PER_SWEEP === '' || !isFinite(n) ? 60 : Math.max(0, Math.min(400, Math.round(n))),
    adaptTop: rt.settings.RADAR_ADAPT_TOP === '' || !isFinite(a) ? 5 : Math.max(0, Math.min(12, Math.round(a))),
  };
};

const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

/** The items still to extract, best first: on-topic, something to read, no format yet (failed ones retried after a day). */
export async function itemsToExtract(rt: Runtime, limit: number, now = Date.now()): Promise<ExtractInput[]> {
  if (limit <= 0) return [];
  const retry = new Date(now - 86400_000).toISOString();
  const { results } = await rt.env.DB.prepare(
    `SELECT i.* FROM radar_items i LEFT JOIN radar_item_formats f ON f.item_id = i.id
      WHERE (f.item_id IS NULL OR (f.error IS NOT NULL AND f.extracted_at < ?))
      ORDER BY i.score DESC LIMIT ?`,
  ).bind(retry, Math.min(2000, limit * 4)).all<ExtractInput & { radar_ids: string; body_text?: string | null }>();
  const { results: wl } = await rt.env.DB.prepare('SELECT id, keywords_json FROM radar_watchlists').all<{ id: string; keywords_json: string }>();
  const kwOf = new Map(wl.map((w) => [w.id, parse<string[]>(w.keywords_json, [])]));
  return results
    .filter((r) => r.transcript || r.body_text || r.caption || r.title)
    .filter((r) => relevantTo(`${r.title ?? ''} ${r.caption ?? ''} ${r.body_text ?? ''} ${r.author ?? ''}`.slice(0, 4000), parse<string[]>(r.radar_ids, []).flatMap((id) => kwOf.get(id) ?? [])))
    .slice(0, limit);
}

export async function saveExtraction(rt: Runtime, itemId: string, e: Extraction | null, brain: Brain | null, error: string | null, now = Date.now()) {
  const ts = new Date(now).toISOString();
  if (!e) {
    await rt.env.DB.prepare(`INSERT INTO radar_item_formats (item_id, format_name, name_tokens, hook_type, length_bucket, signature, data_json, brain, extracted_at, error)
      VALUES (?, '', '', 'other', 'short', '', '{}', ?, ?, ?) ON CONFLICT(item_id) DO UPDATE SET extracted_at = excluded.extracted_at, error = excluded.error WHERE radar_item_formats.format_name = ''`)
      .bind(itemId, brain, ts, (error ?? 'failed').slice(0, 300)).run();
    return;
  }
  await rt.env.DB.prepare(`INSERT INTO radar_item_formats (item_id, format_name, name_tokens, hook_type, devices_json, length_bucket, audience_json, signature, data_json, brain, extracted_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(item_id) DO UPDATE SET format_name = excluded.format_name, name_tokens = excluded.name_tokens, hook_type = excluded.hook_type, devices_json = excluded.devices_json,
      length_bucket = excluded.length_bucket, audience_json = excluded.audience_json, signature = excluded.signature, data_json = excluded.data_json, brain = excluded.brain,
      extracted_at = excluded.extracted_at, error = NULL`)
    .bind(itemId, e.format_name, nameTokens(e.format_name).join(' '), e.hook.type, JSON.stringify(e.devices), e.length_bucket, JSON.stringify(e.audience), signatureOf(e), JSON.stringify(e), brain, ts).run();
}

export function askerFor(rt: Runtime, brain: Brain, schema: object, feature: string): Ask { return askJson(rt, brain, schema, feature); }

/** Extract a batch (concurrency 4). Returns what happened; never throws for one bad item. */
export async function extractBatch(rt: Runtime, ask: Ask, brain: Brain | null, items: ExtractInput[], now = Date.now()) {
  const out = { done: 0, failed: 0, ids: [] as string[] };
  for (let i = 0; i < items.length; i += 4) {
    await Promise.all(items.slice(i, i + 4).map(async (it) => {
      try { const e = await extractOne(ask, it); await saveExtraction(rt, it.id, e, brain, null, now); out.done++; out.ids.push(it.id); }
      catch (err) { await saveExtraction(rt, it.id, null, brain, err instanceof Error ? err.message : String(err), now); out.failed++; }
    }));
  }
  return out;
}

interface FmtRow { item_id: string; format_name: string; name_tokens: string; hook_type: string; devices_json: string; length_bucket: string; audience_json: string; signature: string; format_id: string | null; platform: string; score: number; niche: string | null; published_at: string | null; first_seen: string; title: string | null; author: string | null; thumbnail_url: string | null; snippet: string | null }

export async function loadMembers(rt: Runtime): Promise<Member[]> {
  const { results } = await rt.env.DB.prepare(
    `SELECT f.item_id, f.format_name, f.name_tokens, f.hook_type, f.devices_json, f.length_bucket, f.audience_json, f.signature, f.format_id,
            i.platform, i.score, i.niche, i.published_at, i.first_seen, i.title, i.author, i.thumbnail_url, substr(COALESCE(i.caption, ''), 1, 280) AS snippet
       FROM radar_item_formats f JOIN radar_items i ON i.id = f.item_id
      WHERE f.error IS NULL AND f.format_name != '' ORDER BY i.score DESC LIMIT 3000`,
  ).all<FmtRow>();
  return results.map((r) => ({
    item_id: r.item_id, platform: r.platform, score: Number(r.score) || 0, niche: r.niche, published_at: r.published_at, first_seen: r.first_seen,
    title: r.title, author: r.author, thumbnail_url: r.thumbnail_url, snippet: r.snippet || null,
    format_name: r.format_name, tokens: r.name_tokens ? r.name_tokens.split(' ') : [], hook_type: pick(HOOK_TYPES, r.hook_type, 'other'),
    devices: parse<Device[]>(r.devices_json, []), length_bucket: pick(LENGTHS, r.length_bucket, 'short'), audience: parse<Audience[]>(r.audience_json, []),
    signature: r.signature, prev_format_id: r.format_id,
  }));
}

/**
 * Cluster everything extracted so far and store the formats (idempotent: the same members give the same rows).
 * A cluster is named by the model only when its members changed (up to `nameBudget` calls); the rest keep their
 * name or get the rule name.
 */
export async function clusterAndStore(rt: Runtime, o: { ask?: Ask | null; brain?: Brain | null; runId?: string | null; now?: number; nameBudget?: number } = {}) {
  const now = o.now ?? Date.now();
  const ts = new Date(now).toISOString();
  const clusters = assignIds(clusterMembers(await loadMembers(rt)));
  const { results: old } = await rt.env.DB.prepare('SELECT id, name, definition, named_by, members_hash, stats_json, prev_count, run_id FROM radar_formats').all<{ id: string; name: string; definition: string | null; named_by: string | null; members_hash: string | null; stats_json: string; prev_count: number | null; run_id: string | null }>();
  const before = new Map(old.map((r) => [r.id, r]));
  const scored = clusters.map((c) => {
    const prev = before.get(c.id);
    // The trend compares with the count at the previous run; re-running the same run keeps the same baseline.
    const prevCount = prev ? (prev.run_id === (o.runId ?? null) ? prev.prev_count : parse<{ count?: number }>(prev.stats_json, {}).count ?? null) : null;
    const stats = statsFor(c.members, prevCount);
    return { c, prev, stats, rank: rankOf(stats, now), ws: whiteSpace(stats), membersHash: hash(c.members.map((m) => m.item_id).sort().join(',')) };
  }).sort((a, b) => b.rank - a.rank);
  let budget = o.nameBudget ?? 30;
  let named = 0;
  const stmts = [] as ReturnType<Runtime['env']['DB']['prepare']>[];
  for (const s of scored) {
    let nm = s.prev && s.prev.members_hash === s.membersHash ? { name: s.prev.name, definition: s.prev.definition ?? '', by: s.prev.named_by } : null;
    if (!nm && o.ask && budget > 0 && (s.c.members.length >= 2 || named < 10)) {
      budget--;
      try { const r = await nameCluster(o.ask, s.c); nm = { ...r, by: o.brain ?? 'model' }; named++; } catch (e) { console.error('radar: naming failed', e instanceof Error ? e.message : e); }
    }
    if (!nm) nm = s.prev && s.prev.named_by !== 'rule' ? { name: s.prev.name, definition: s.prev.definition ?? '', by: s.prev.named_by } : { ...ruleName(s.c), by: 'rule' };
    const devices = mainDevices(s.c.members.flatMap((m) => m.devices));
    const hookType = mode(s.c.members.map((m) => m.hook_type), 'other');
    const len = mode(s.c.members.map((m) => m.length_bucket), 'short');
    // A rule name stays re-computable: its hash is left empty so the next run with a model can name it.
    const mh = nm.by === 'rule' ? null : s.membersHash;
    stmts.push(rt.env.DB.prepare(
      `INSERT INTO radar_formats (id, name, definition, named_by, members_hash, signature, hook_type, devices_json, length_bucket, member_ids, stats_json, rank, white_space, white_space_why, prev_count, run_id, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, definition = excluded.definition, named_by = excluded.named_by, members_hash = excluded.members_hash, signature = excluded.signature,
         hook_type = excluded.hook_type, devices_json = excluded.devices_json, length_bucket = excluded.length_bucket, member_ids = excluded.member_ids, stats_json = excluded.stats_json,
         rank = excluded.rank, white_space = excluded.white_space, white_space_why = excluded.white_space_why, prev_count = excluded.prev_count, run_id = excluded.run_id, active = 1, updated_at = excluded.updated_at`,
    ).bind(s.c.id, nm.name, nm.definition, nm.by, mh, s.c.seed, hookType, JSON.stringify(devices), len, JSON.stringify(s.c.members.map((m) => m.item_id)), JSON.stringify(s.stats), s.rank, s.ws.level, s.ws.why, s.stats.trend.prev, o.runId ?? null, ts, ts));
    for (const m of s.c.members) if (m.prev_format_id !== s.c.id) stmts.push(rt.env.DB.prepare('UPDATE radar_item_formats SET format_id = ? WHERE item_id = ?').bind(s.c.id, m.item_id));
  }
  const live = new Set(scored.map((s) => s.c.id));
  for (const r of old) if (!live.has(r.id)) stmts.push(rt.env.DB.prepare('UPDATE radar_formats SET active = 0, updated_at = ? WHERE id = ?').bind(ts, r.id));
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  return { formats: scored.length, named, white_space: scored.filter((s) => s.ws.level > 0).length, top: scored.slice(0, 10).map((s) => s.c.id) };
}

// ───────────── reading ─────────────

export interface FormatRow {
  id: string; name: string; definition: string | null; named_by: string | null; members_hash: string | null; signature: string; hook_type: HookType;
  devices: Device[]; length_bucket: string | null; member_ids: string[]; stats: FormatStats; rank: number; white_space: number; white_space_why: string | null; updated_at: string;
}
type DbFormat = Omit<FormatRow, 'devices' | 'member_ids' | 'stats'> & { devices_json: string; member_ids: string; stats_json: string };
const toFormat = (r: DbFormat): FormatRow => ({
  id: r.id, name: r.name, definition: r.definition, named_by: r.named_by, members_hash: r.members_hash, signature: r.signature, hook_type: r.hook_type,
  devices: parse<Device[]>(r.devices_json, []), length_bucket: r.length_bucket, member_ids: parse<string[]>(r.member_ids, []), stats: parse<FormatStats>(r.stats_json, {} as FormatStats),
  rank: r.rank, white_space: r.white_space, white_space_why: r.white_space_why, updated_at: r.updated_at,
});

export async function listFormats(rt: Runtime, o: { whiteSpace?: boolean; limit?: number } = {}) {
  const { results } = await rt.env.DB.prepare(`SELECT * FROM radar_formats WHERE active = 1 ${o.whiteSpace ? 'AND white_space > 0' : ''} ORDER BY rank DESC LIMIT ?`).bind(Math.min(200, o.limit ?? 60)).all<DbFormat>();
  return results.map(toFormat);
}
export async function getFormat(rt: Runtime, id: string): Promise<FormatRow | null> {
  const r = await rt.env.DB.prepare('SELECT * FROM radar_formats WHERE id = ?').bind(id).first<DbFormat>();
  return r ? toFormat(r) : null;
}
export async function getExtraction(rt: Runtime, itemId: string): Promise<(Extraction & { format_id: string | null; brain: string | null; extracted_at: string }) | null> {
  const r = await rt.env.DB.prepare('SELECT data_json, format_id, brain, extracted_at, error FROM radar_item_formats WHERE item_id = ?').bind(itemId).first<{ data_json: string; format_id: string | null; brain: string | null; extracted_at: string; error: string | null }>();
  if (!r || r.error) return null;
  return { ...parse<Extraction>(r.data_json, {} as Extraction), format_id: r.format_id, brain: r.brain, extracted_at: r.extracted_at };
}
