import type { Runtime } from '../app';
import { copyBrief } from '../content/copy-rules';
import { type FormatId, ICP_IDS, type IcpId, ctaFor, pickFramework } from '../studio/copy-brain';
import { type Ask, type Brain as ModelBrain, type ScriptFlag, type StudioScript, type Written, parseJsonReply, saveScript, scriptIssues, writeScript } from '../studio/scripts';
import type { BrainInput } from '../studio/copy-brain';
import { type Brain, type BrainHit, type LegendCard, cardText } from './brain-provider';
import { type Extraction, type FormatRow, ROLES, type Role } from './formats';

/**
 * Radar v2 (builder C): how the script changes for our niche.
 *
 * For a viral format (or one item on demand): (a) the original's beat skeleton, (b) the G&L version beat by beat,
 * side by side, with what changes and why (audience: employees and aspiring buyers become $1M+ owners buying
 * competitors; proof: only Josh's real facts; mechanism: 3C, the 1.5x test, seller rollover; the CTA), (c) a full
 * Studio script (src/studio/scripts.ts writeScript + saveScript, the format as context), (d) 5 hook variants in our
 * voice, (e) the copy legends applied, named per beat with a note.
 * Every adaptation passes auditCopy + scriptIssues (one rewrite, then the flags are shown). A blind judge (it sees only
 * our version, the copy rules and the legend rubric) scores hook, specificity, mechanism, proof honesty and CTA from
 * 1 to 10; under 7 on any of them sends it back with the judge's notes, at most twice.
 */

const S = { type: 'string' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const ADAPT_SCHEMA = obj({
  topic: S,
  angle: S,
  icp: { type: 'string', enum: [...ICP_IDS] },
  original_skeleton: { type: 'array', items: obj({ role: { type: 'string', enum: [...ROLES] }, summary: S }) },
  beats: { type: 'array', items: obj({ role: { type: 'string', enum: [...ROLES] }, original: S, ours: S, why: S, legend: S, legend_note: S }) },
  hooks: { type: 'array', items: S, description: 'exactly 5' },
});
export const JUDGE_KEYS = ['hook', 'specificity', 'mechanism', 'proof_honesty', 'cta'] as const;
export type JudgeKey = (typeof JUDGE_KEYS)[number];
export const JUDGE_SCHEMA = obj({
  scores: obj(Object.fromEntries(JUDGE_KEYS.map((k) => [k, { type: 'integer' }]))),
  notes: { type: 'array', items: S },
  verdict: S,
});
export const JUDGE_PASS = 7;
export const MAX_JUDGE_ROUNDS = 2;

export interface AdaptBeat { role: Role; original: string; ours: string; why: string; legend: string; legend_note: string }
export interface Adaptation {
  topic: string; angle: string; icp: IcpId; studio_format: FormatId;
  original_skeleton: { role: Role; summary: string }[];
  beats: AdaptBeat[];
  hooks: string[];
  legends: string[];
}
export interface Judgement { scores: Record<JudgeKey, number>; notes: string[]; verdict: string; min: number; pass: boolean }

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r/g, '').trim().slice(0, n);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);
const role = (v: unknown): Role => { const k = clip(v, 20).toLowerCase(); return (ROLES as readonly string[]).includes(k) ? (k as Role) : 'other'; };

/** The Studio format the script is written in, from the format's length. */
export function studioFormatFor(length: string | null | undefined): FormatId {
  return length === 'long' || length === 'xl' || length === 'article' ? 'long' : 'short';
}

/** Validate and clamp. Legends must be one of the cards we gave; unknown ones are blanked. */
export function cleanAdaptation(raw: unknown, o: { legends: string[]; studio_format: FormatId }): Adaptation {
  const r = isObj(raw) ? raw : {};
  const known = new Map(o.legends.map((l) => [l.toLowerCase(), l]));
  const legendOf = (v: unknown) => { const k = clip(v, 60).toLowerCase(); return known.get(k) ?? [...known.entries()].find(([n]) => k && (n.includes(k) || k.includes(n.split(' ').pop() ?? '~')))?.[1] ?? ''; };
  const icp = clip(r.icp, 20) as IcpId;
  const out: Adaptation = {
    topic: clip(r.topic, 300), angle: clip(r.angle, 400),
    icp: (ICP_IDS as readonly string[]).includes(icp) ? icp : 'ceiling',
    studio_format: o.studio_format,
    original_skeleton: arr(r.original_skeleton).filter(isObj).slice(0, 14).map((b) => ({ role: role(b.role), summary: clip(b.summary, 300) })).filter((b) => b.summary),
    beats: arr(r.beats).filter(isObj).slice(0, 14).map((b) => ({ role: role(b.role), original: clip(b.original, 400), ours: clip(b.ours, 900), why: clip(b.why, 400), legend: legendOf(b.legend), legend_note: clip(b.legend_note, 300) })).filter((b) => b.ours),
    hooks: arr(r.hooks).map((h) => clip(h, 220)).filter(Boolean).slice(0, 5),
    legends: [],
  };
  out.legends = [...new Set(out.beats.map((b) => b.legend).filter(Boolean))];
  if (!out.beats.length || !out.hooks.length) throw new Error('The adaptation came back without beats or hooks.');
  return out;
}

/** auditCopy + the Studio rules over every line that is ours (the original is quoted, not ours). */
export function adaptIssues(a: Adaptation): ScriptFlag[] {
  const shape: StudioScript = {
    hooks: a.hooks, hook_index: 0, hook: a.hooks[0] ?? '',
    beats: [...a.beats.map((b) => ({ layout: 'spotlight' as const, text: b.ours, cue: '', on_screen: '', screen: '' })), ...(a.angle ? [{ layout: 'spotlight' as const, text: a.angle, cue: '', on_screen: '', screen: '' }] : [])],
    titles: [], thumbnail: '', description: '', cta: '', words: 0, est_seconds: 0,
  };
  return scriptIssues(shape).map((f) => ({ ...f, path: f.path.replace(/^beats\[(\d+)\]\.(text|on_screen)/, (_, i) => (Number(i) < a.beats.length ? `beats[${i}].ours` : 'angle')) }));
}

// ───────────── prompts ─────────────

export interface AdaptSource {
  kind: 'format' | 'item';
  id: string;
  name: string;
  definition: string;
  stats_line: string;
  length_bucket: string | null;
  examples: { platform: string; title: string | null; extraction: Extraction }[];
}

export function adaptSourceForFormat(f: FormatRow, examples: { platform: string; title: string | null; extraction: Extraction }[]): AdaptSource {
  const s = f.stats;
  const aud = Object.entries(s.audience ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');
  return {
    kind: 'format', id: f.id, name: f.name, definition: f.definition ?? '', length_bucket: f.length_bucket,
    stats_line: `${s.count} items on ${Object.keys(s.platforms ?? {}).join(', ')}; median outlier score ${s.median_score}; in our niche ${s.in_niche}, adjacent ${s.adjacent}; audience ${aud || 'unknown'}${f.white_space ? '; white space for us' : ''}.`,
    examples,
  };
}
export function adaptSourceForItem(item: { id: string; platform: string; title: string | null; score: number }, e: Extraction): AdaptSource {
  return { kind: 'item', id: item.id, name: e.format_name, definition: e.why_viral, length_bucket: e.length_bucket, stats_line: `One ${item.platform} item, outlier score ${Math.round(item.score)}.`, examples: [{ platform: item.platform, title: item.title, extraction: e }] };
}

export function adaptSystemPrompt(x: { cards: LegendCard[]; facts: string; hits: BrainHit[]; studio_format: FormatId }): string {
  return `You adapt viral content formats for Josh Li of G&L M&A Advisory. You keep the FORMAT (the beat structure, the hook shape, the devices) and change everything else for our viewer.

OUR VIEWER: owners of businesses doing $1M+ revenue who grow by buying competitors (roll-up acquisitions), funded mostly by the target's own cash flow: commercial debt + seller finance + seller rollover, passing the 1.5x debt service coverage test, buying through a holding company, off-market owners with no successor. Most viral originals speak to employees, aspiring first-time buyers or a general audience: shift every beat to the owner who already runs a $1M+ business.

WHAT CHANGES, BEAT BY BEAT:
- audience: from employees or aspiring buyers to $1M+ owners buying competitors.
- proof: swap the original's proof for Josh's real facts below and nothing else. No invented results, clients, students or numbers. Any example number is labelled "illustrative".
- mechanism: the 3C model (capabilities, capital, closing), the 1.5x test, seller finance with seller rollover. Whenever funding is described, name seller rollover.
- CTA: apply; if it is a fit the team books a strategy call (never "free").

${x.facts}

THE COPY LEGENDS TO APPLY (name the one you use on each beat in legend, exactly as written here, and say how in legend_note):
${x.cards.map(cardText).join('\n')}
${x.hits.length ? `\nFROM THE BRAIN (reference):\n${x.hits.slice(0, 4).map((h) => `- ${h.title}: ${h.snippet.slice(0, 400)}`).join('\n')}` : ''}

RETURN JSON:
- topic: the topic of our video, one line.
- angle: our angle in one or two sentences.
- icp: one of ${ICP_IDS.join(', ')} (ceiling fits most owners buying competitors).
- original_skeleton: the original's beats in order: role and a one-line summary.
- beats: our version, one per original beat, same order: role, original (the original beat in a few words), ours (what Josh says, word for word, ${x.studio_format === 'short' ? 'one or two short lines' : 'two to four sentences'}), why (what changed and why: audience, proof, mechanism or CTA), legend, legend_note.
- hooks: exactly 5 hook variants in Josh's voice, 15 words max each, different shapes.

${copyBrief('video')}
No em dashes, no exclamation marks, no emojis. Return JSON only.`;
}

export function adaptUserPrompt(src: AdaptSource): string {
  const ex = src.examples.slice(0, 3).map((e, i) => {
    const x = e.extraction;
    return `Example ${i + 1} (${e.platform}${e.title ? `: ${e.title.slice(0, 140)}` : ''})
Hook (${x.hook?.type}): "${x.hook?.text}". Why it works: ${x.hook?.why_it_works}
Beats: ${(x.beats ?? []).map((b) => `[${b.at}] ${b.role}: ${b.summary}`).join(' | ')}
Devices: ${(x.devices ?? []).join(', ')}. Audience: ${(x.audience ?? []).join(', ')}. Driver: ${x.emotional_driver}. CTA: ${x.cta || 'none'}.
Why it went viral: ${x.why_viral}`;
  }).join('\n\n');
  return `Adapt this ${src.kind === 'format' ? 'viral format' : 'top performer'} for G&L.\nFormat: ${src.name}\n${src.definition ? `Definition: ${src.definition}\n` : ''}Numbers: ${src.stats_line}\n\n${ex}`;
}

export function judgeSystemPrompt(cards: LegendCard[]): string {
  return `You are a blind judge of short-form video scripts for G&L M&A Advisory (viewers: owners of $1M+ businesses buying competitors). You see only the script, the copy rules and the rubric. Score each from 1 to 10:
- hook: stops a $1M+ owner in the first line; specific; a clear shape.
- specificity: concrete nouns, numbers and steps instead of adjectives; every number true or labelled illustrative.
- mechanism: the method is named and makes sense (commercial debt + seller finance + seller rollover, the 1.5x test, 3C), not hand-waved.
- proof_honesty: proof is only true facts (Josh's two acquisitions, both 100% seller financed; the 90 booking-form owners; the $5.5M radiology deal); nothing invented; nothing promised.
- cta: one clear next step (apply; the team books a strategy call if it is a fit), never "free", no fake urgency.
notes: the specific fixes that would raise every score under 7, each pointing at the line to change. verdict: one line.

THE RUBRIC (the copy legends):
${cards.map(cardText).join('\n')}

THE COPY RULES:
${copyBrief('video')}
Return JSON only.`;
}

export function judgeUserPrompt(a: Adaptation, script: StudioScript | null): string {
  return `Hooks:\n${a.hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}\n\nBeats:\n${a.beats.map((b, i) => `${i + 1}. (${b.role}) ${b.ours}`).join('\n')}${script ? `\n\nThe full script:\n${script.beats.map((b) => b.text).join('\n')}\nCTA: ${script.cta}` : ''}`;
}

export function cleanJudge(raw: unknown): Judgement {
  const r = isObj(raw) ? raw : {};
  const s = isObj(r.scores) ? r.scores : {};
  const scores = Object.fromEntries(JUDGE_KEYS.map((k) => { const v = Math.round(Number(s[k])); return [k, isFinite(v) ? Math.max(1, Math.min(10, v)) : 1]; })) as Record<JudgeKey, number>;
  const min = Math.min(...JUDGE_KEYS.map((k) => scores[k]));
  return { scores, notes: arr(r.notes).map((n) => clip(n, 300)).filter(Boolean).slice(0, 8), verdict: clip(r.verdict, 300), min, pass: min >= JUDGE_PASS };
}

// ───────────── the steps ─────────────

export interface Gated { adaptation: Adaptation; flags: ScriptFlag[]; attempts: number }

/** Draft, gate with the copy rules, and one rewrite listing every failure. Keeps the version with fewer flags. */
export async function adaptAndGate(ask: Ask, ctx: { system: string; user: string; legends: string[]; studio_format: FormatId; prior?: { text: string; notes: string[] } }): Promise<Gated> {
  const first = { role: 'user' as const, content: ctx.user };
  const msgs: { role: 'user' | 'assistant'; content: string }[] = ctx.prior
    ? [first, { role: 'assistant', content: ctx.prior.text }, { role: 'user', content: `A reviewer scored this under 7. Rewrite the whole JSON and fix these:\n${ctx.prior.notes.map((n) => `- ${n}`).join('\n')}\nKeep every fact true.` }]
    : [first];
  const text = await ask(ctx.system, msgs);
  const draft = cleanAdaptation(parseJsonReply(text), ctx);
  const issues = adaptIssues(draft);
  if (!issues.length) return { adaptation: draft, flags: [], attempts: 1 };
  const list = issues.slice(0, 30).map((i) => `- ${i.path}: ${i.rule}: "${i.excerpt}"`).join('\n');
  try {
    const again = await ask(ctx.system, [...msgs, { role: 'assistant', content: text }, { role: 'user', content: `These lines break the copy rules:\n${list}\n\nReturn the whole JSON again with only those lines rewritten (state, don't hedge; keep every fact true; label example numbers illustrative; name seller rollover when funding is described; no em dashes). Everything else stays word for word.` }]);
    const revised = cleanAdaptation(parseJsonReply(again), ctx);
    const left = adaptIssues(revised);
    if (left.length <= issues.length) return { adaptation: revised, flags: left, attempts: 2 };
  } catch (e) {
    console.error('radar adaptation rewrite failed', e instanceof Error ? e.message : e);
  }
  return { adaptation: draft, flags: issues, attempts: 2 };
}

/** The context a Studio script gets from an adaptation. */
export function adaptScriptContext(src: AdaptSource, a: Adaptation): string {
  return [
    `Modelled on the viral format "${src.name}"${src.definition ? ` (${src.definition.replace(/\n/g, ' ')})` : ''}. Keep its structure, never its claims or words.`,
    `Our angle: ${a.angle}`,
    `Beat plan (follow it in order): ${a.beats.map((b) => `${b.role}: ${b.ours}`).join(' | ')}`,
    `Use one of these as a hook: ${a.hooks.slice(0, 3).map((h) => `"${h}"`).join('; ')}`,
    a.legends.length ? `Copy legends applied: ${a.beats.filter((b) => b.legend).map((b) => `${b.role}: ${b.legend} (${b.legend_note})`).join('; ')}` : '',
  ].filter(Boolean).join('\n').slice(0, 3000);
}

export interface AdaptDeps {
  ask: Ask; scriptAsk: Ask; judgeAsk: Ask; brain: Brain; model: ModelBrain;
  /** The Studio writer with the brain (writeStudioScript); without it, writeScript with scriptAsk (tests). */
  write?: (rt: Runtime, input: BrainInput) => Promise<Written>;
}

async function promptsFor(deps: AdaptDeps, src: AdaptSource) {
  const task = `${src.name} ${src.definition} hook mechanism proof cta structure`;
  const [cards, facts, hits] = await Promise.all([deps.brain.legendCards(task, 5), deps.brain.glFacts(), deps.brain.brainSearch(`${src.name} ${src.definition}`, { k: 4, scope: 'copy' }).catch(() => [] as BrainHit[])]);
  const studio_format = studioFormatFor(src.length_bucket);
  return { cards, studio_format, system: adaptSystemPrompt({ cards, facts, hits, studio_format }), user: adaptUserPrompt(src), legends: cards.map((c) => c.legend) };
}

/** Write (or re-write) the Studio script for an adaptation and save it in Studio → Scripts. */
async function scriptFor(rt: Runtime, deps: AdaptDeps, src: AdaptSource, a: Adaptation, notes: string[] = []) {
  const format = a.studio_format;
  const framework = pickFramework(format, a.icp);
  const extra = [rt.settings.STUDIO_SCRIPT_NOTES, notes.length ? `A reviewer asked for: ${notes.join('; ')}` : ''].filter(Boolean).join('\n');
  const input: BrainInput = { topic: a.topic || src.name, context: adaptScriptContext(src, a), format, icp: a.icp, framework, cta: ctaFor(format, rt.settings.STUDIO_SCRIPT_CTA), notes: extra || undefined };
  const written = deps.write ? await deps.write(rt, input) : await writeScript(deps.scriptAsk, input);
  const row = await saveScript(rt, { topic: (a.topic || src.name).slice(0, 600), source: 'radar', source_ref: src.kind === 'format' ? `format:${src.id}` : src.id, format, icp: a.icp, framework, brain: deps.model, ...written });
  return row;
}

export interface AdaptRow {
  id: string; format_id: string | null; item_id: string | null; members_hash: string | null; run_id: string | null;
  data: Adaptation; script_id: string | null; flags: ScriptFlag[]; judge: { rounds: Judgement[] } | null; judge_score: number | null; rounds: number; status: string; brain: string | null; created_at: string; updated_at: string;
}
const parse = <T>(s: string | null | undefined, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
type DbAdapt = Omit<AdaptRow, 'data' | 'flags' | 'judge'> & { data_json: string; flags_json: string; judge_json: string | null };
const toAdapt = (r: DbAdapt): AdaptRow => ({ ...r, data: parse(r.data_json, {} as AdaptRow['data']), flags: parse(r.flags_json, []), judge: parse(r.judge_json, null) } as AdaptRow);

export async function getAdaptation(rt: Runtime, id: string) { const r = await rt.env.DB.prepare('SELECT * FROM radar_adaptations WHERE id = ?').bind(id).first<DbAdapt>(); return r ? toAdapt(r) : null; }
export async function latestAdaptation(rt: Runtime, o: { format_id?: string; item_id?: string }) {
  const r = o.format_id
    ? await rt.env.DB.prepare("SELECT * FROM radar_adaptations WHERE format_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1").bind(o.format_id).first<DbAdapt>()
    : await rt.env.DB.prepare("SELECT * FROM radar_adaptations WHERE item_id = ? AND status != 'failed' ORDER BY created_at DESC LIMIT 1").bind(o.item_id ?? '').first<DbAdapt>();
  return r ? toAdapt(r) : null;
}

/**
 * adapt (node): the adaptation, gated, with its Studio script. Idempotent: a format whose members have not changed
 * since its last adaptation keeps it (unless `force`).
 */
export async function adaptStep(rt: Runtime, deps: AdaptDeps, src: AdaptSource, o: { membersHash?: string | null; runId?: string | null; force?: boolean; now?: number } = {}): Promise<{ id: string; reused: boolean }> {
  if (!o.force) {
    const prev = await latestAdaptation(rt, src.kind === 'format' ? { format_id: src.id } : { item_id: src.id });
    if (prev && (src.kind === 'item' || prev.members_hash === (o.membersHash ?? null))) return { id: prev.id, reused: true };
  }
  const p = await promptsFor(deps, src);
  const g = await adaptAndGate(deps.ask, p);
  const row = await scriptFor(rt, deps, src, g.adaptation);
  const ts = new Date(o.now ?? Date.now()).toISOString();
  const id = crypto.randomUUID();
  await rt.env.DB.prepare('INSERT INTO radar_adaptations (id, format_id, item_id, members_hash, run_id, data_json, script_id, flags_json, brain, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, src.kind === 'format' ? src.id : null, src.kind === 'item' ? src.id : null, o.membersHash ?? null, o.runId ?? null, JSON.stringify(g.adaptation), row.id, JSON.stringify([...g.flags, ...row.flags]), deps.model, 'draft', ts, ts).run();
  return { id, reused: false };
}

/** judge (node): the blind judge on the current version. Idempotent per round: a judged round is not judged again. */
export async function judgeStep(rt: Runtime, deps: AdaptDeps, id: string, now = Date.now()): Promise<Judgement | null> {
  const a = await getAdaptation(rt, id);
  if (!a) return null;
  const rounds = a.judge?.rounds ?? [];
  if (rounds.length > a.rounds) return rounds[rounds.length - 1];
  const script = a.script_id ? await rt.env.DB.prepare('SELECT data FROM studio_scripts WHERE id = ?').bind(a.script_id).first<{ data: string }>() : null;
  const cards = await deps.brain.legendCards('hook specificity mechanism proof cta', 5);
  const j = cleanJudge(parseJsonReply(await deps.judgeAsk(judgeSystemPrompt(cards), [{ role: 'user', content: judgeUserPrompt(a.data, parse<StudioScript | null>(script?.data, null)) }])));
  await rt.env.DB.prepare('UPDATE radar_adaptations SET judge_json = ?, judge_score = ?, status = ?, updated_at = ? WHERE id = ?')
    .bind(JSON.stringify({ rounds: [...rounds, j] }), j.min, 'judged', new Date(now).toISOString(), id).run();
  return j;
}

/** rewrite (node): back to the writer with the judge's notes (gated again), and a new script. */
export async function rewriteStep(rt: Runtime, deps: AdaptDeps, id: string, src: AdaptSource, now = Date.now()): Promise<boolean> {
  const a = await getAdaptation(rt, id);
  if (!a || a.rounds >= MAX_JUDGE_ROUNDS) return false;
  const last = a.judge?.rounds?.[a.judge.rounds.length - 1];
  if (!last || last.pass || (a.judge?.rounds.length ?? 0) <= a.rounds) return false;
  const p = await promptsFor(deps, src);
  const g = await adaptAndGate(deps.ask, { ...p, prior: { text: JSON.stringify(a.data), notes: last.notes.length ? last.notes : [last.verdict || 'raise every score under 7'] } });
  const row = await scriptFor(rt, deps, src, g.adaptation, last.notes);
  await rt.env.DB.prepare('UPDATE radar_adaptations SET data_json = ?, script_id = ?, flags_json = ?, rounds = rounds + 1, status = ?, updated_at = ? WHERE id = ? AND rounds = ?')
    .bind(JSON.stringify(g.adaptation), row.id, JSON.stringify([...g.flags, ...row.flags]), 'draft', new Date(now).toISOString(), id, a.rounds).run();
  return true;
}

/** store (node): mark it final. */
export async function storeStep(rt: Runtime, id: string, now = Date.now()) {
  await rt.env.DB.prepare("UPDATE radar_adaptations SET status = 'stored', updated_at = ? WHERE id = ? AND status != 'stored'").bind(new Date(now).toISOString(), id).run();
}

/** The whole adapt → judge → rewrite (max 2) → store loop for one source (the on-demand button uses this). */
export async function adaptFull(rt: Runtime, deps: AdaptDeps, src: AdaptSource, o: { membersHash?: string | null; runId?: string | null; force?: boolean } = {}) {
  const { id } = await adaptStep(rt, deps, src, o);
  for (let round = 0; round <= MAX_JUDGE_ROUNDS; round++) {
    const j = await judgeStep(rt, deps, id);
    if (!j || j.pass || round === MAX_JUDGE_ROUNDS) break;
    if (!(await rewriteStep(rt, deps, id, src))) break;
  }
  await storeStep(rt, id);
  return getAdaptation(rt, id);
}
