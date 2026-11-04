import type Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { auditFields } from '../content/copy-rules';
import { listSprints, type Topic } from '../content/ideas';
import { getPack, loadSprintTopic } from '../content/video-pack';
import { anthropicClient, runWorkersAi } from '../infra/ai-gateway';
import { DEFAULT_EMAIL_MODEL } from '../personalize/personalize';
import {
  type BrainInput, FORMATS, FORMAT_IDS, FRAMEWORKS, FRAMEWORK_IDS, type FormatId, type FrameworkChoice, type FrameworkId, ICPS, ICP_IDS, type IcpId, LAYOUTS, type Layout,
  ctaFor, pickFramework, scriptSystemPrompt, scriptUserPrompt,
} from './copy-brain';

/**
 * Studio → Scripts (builder C): one click, one face-cam shooting script.
 *
 * The owner picks a topic (free text, or a YouTube idea from a sprint, with its written pack when there is one),
 * a format, an ICP and a framework (or auto). The copy brain (copy-brain.ts) becomes the system prompt; Claude
 * writes it when ANTHROPIC_API_KEY is set, Workers AI otherwise. Every script is checked with auditCopy (plus the
 * Studio rules below); a failing draft is sent back once with the failures listed, and whatever is still flagged
 * is stored and shown. Beats are validated: unknown layouts are clamped to a sensible one, lengths are capped.
 * "Record this" in the browser hands the beats to the recorder (studio:use-script).
 */

export const WORKERS_AI_TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
export type Brain = 'claude' | 'workers-ai';
export const brainOf = (rt: Runtime): Brain | null => (rt.settings.ANTHROPIC_API_KEY ? 'claude' : rt.env.AI ? 'workers-ai' : null);

export interface ScriptBeat { layout: Layout; text: string; cue: string; on_screen: string; screen: string }
export interface StudioScript {
  hooks: string[]; hook_index: number; hook: string;
  beats: ScriptBeat[];
  titles: string[]; thumbnail: string; description: string; cta: string;
  words: number; est_seconds: number;
}
export interface ScriptFlag { path: string; rule: string; excerpt: string }
export interface ScriptRow {
  id: string; created_at: string; updated_at: string | null; topic: string; source: string; source_ref: string | null;
  format: FormatId; icp: IcpId; framework: FrameworkId; brain: Brain; title: string | null; est_seconds: number | null;
  script: StudioScript; flags: ScriptFlag[]; attempts: number;
}

// ───────────── the output schema ─────────────

const str = { type: 'string' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const SCRIPT_SCHEMA = obj({
  hooks: { type: 'array', items: str, description: 'exactly 3 hook options' },
  hook_index: { type: 'integer', description: 'the chosen hook: 0, 1 or 2' },
  beats: { type: 'array', items: obj({ layout: { type: 'string', enum: [...LAYOUTS] }, text: str, cue: str, on_screen: str, screen: str }) },
  titles: { type: 'array', items: str, description: 'exactly 3 options' },
  thumbnail: str,
  description: str,
  cta: str,
});

// ───────────── validation: the model's JSON becomes a safe script ─────────────

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r/g, '').trim().slice(0, n);
export const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** The layout a beat gets when the model gave none or an unknown one. */
export function fallbackLayout(format: FormatId, index: number): Layout {
  if (format === 'short') return 'vertical';
  if (index === 0 && format === 'long') return 'cinema';
  return 'spotlight';
}

/** Validate and clamp whatever the model returned. Unknown layouts are clamped, Shorts are all vertical. */
export function cleanScript(raw: unknown, format: FormatId, cta: string): StudioScript {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const beatsIn = Array.isArray(r.beats) ? r.beats : [];
  const beats: ScriptBeat[] = beatsIn.slice(0, 40).map((b, i) => {
    const x = (b && typeof b === 'object' ? b : { text: b }) as Record<string, unknown>;
    const want = clip(x.layout, 20).toLowerCase() as Layout;
    let layout: Layout = (LAYOUTS as readonly string[]).includes(want) ? want : fallbackLayout(format, i);
    if (format === 'short') layout = 'vertical';
    else if (layout === 'vertical') layout = fallbackLayout(format, i);
    return { layout, text: clip(x.text, 2400), cue: clip(x.cue, 300), on_screen: clip(x.on_screen, 120), screen: clip(x.screen, 400) };
  }).filter((b) => b.text);
  const hooks = (Array.isArray(r.hooks) ? r.hooks : []).map((h) => clip(h, 220)).filter(Boolean).slice(0, 3);
  if (!hooks.length && beats[0]) hooks.push(beats[0].text.split('\n')[0].slice(0, 220));
  const hi = Number.isInteger(r.hook_index) && (r.hook_index as number) >= 0 && (r.hook_index as number) < hooks.length ? (r.hook_index as number) : 0;
  const words = beats.reduce((n, b) => n + wordCount(b.text), 0);
  return {
    hooks, hook_index: hi, hook: hooks[hi] ?? '',
    beats,
    titles: (Array.isArray(r.titles) ? r.titles : []).map((t) => clip(t, 100)).filter(Boolean).slice(0, 3),
    thumbnail: clip(r.thumbnail, 60),
    description: clip(r.description, 5000),
    cta: clip(r.cta, 300) || cta,
    words,
    // Spoken at about 150 words a minute.
    est_seconds: Math.round((words / 150) * 60),
  };
}

// ───────────── the copy gate ─────────────

const FAKE_PROOF: [RegExp, string][] = [
  [/\bour (students?|clients?|members?)\b/i, 'house rule: no proof we don\'t have ("our students/clients")'],
  [/\[(name|fill|x|business|timeframe)[^\]]*\]/i, 'unfilled template placeholder'],
  [/\bI own \d+/i, 'house rule: no invented biography'],
];
const MONEY_OR_MULTIPLE = /\$\s?\d[\d,.]*\s?(k|m|million|billion)?|\b\d+(\.\d+)?\s?-\s?\d+(\.\d+)?x\b|\b\d+(\.\d+)?x\b/gi;
// Numbers that are true facts or the method's rule; anything else must be labelled illustrative.
const TRUE_NUMBERS = /^(\$\s?5\.5\s?(m|million)|\$\s?5\s?(m|million)|\$\s?1\s?(m|million)|1\.5x|\$1m\+?)$/i;

/** auditCopy over every spoken and on-screen field, plus the Studio rules (em dashes, fake proof, labels, rollover). */
export function scriptIssues(s: StudioScript): ScriptFlag[] {
  const copy = { hooks: s.hooks, beats: s.beats.map((b) => ({ text: b.text, on_screen: b.on_screen })), titles: s.titles, thumbnail: s.thumbnail, description: s.description, cta: s.cta };
  const out: ScriptFlag[] = auditFields(copy, { kind: 'video' }).map((i) => ({ path: i.path, rule: i.rule, excerpt: i.excerpt }));
  const fields: [string, string][] = [
    ...s.hooks.map((h, i): [string, string] => [`hooks[${i}]`, h]),
    ...s.beats.flatMap((b, i): [string, string][] => [[`beats[${i}].text`, b.text], [`beats[${i}].on_screen`, b.on_screen]]),
    ...s.titles.map((t, i): [string, string] => [`titles[${i}]`, t]),
    ['thumbnail', s.thumbnail], ['description', s.description], ['cta', s.cta],
  ];
  const all = fields.map(([, v]) => v).join('\n');
  const illustrative = /illustrative/i.test(all);
  for (const [path, v] of fields) {
    if (!v) continue;
    if (/[—–]/.test(v)) out.push({ path, rule: 'em dash', excerpt: v.slice(0, 160) });
    for (const [re, rule] of FAKE_PROOF) if (re.test(v)) out.push({ path, rule, excerpt: v.slice(0, 160) });
    if (!illustrative && path !== 'description') {
      const nums = (v.match(MONEY_OR_MULTIPLE) ?? []).map((n) => n.trim()).filter((n) => !TRUE_NUMBERS.test(n));
      if (nums.length) out.push({ path, rule: 'label example numbers "illustrative"', excerpt: v.slice(0, 160) });
    }
  }
  if (/\b(seller|vendor)[ -]financ|\bcommercial debt\b|\bbank (loan|debt)\b/i.test(all) && !/\brollover\b/i.test(all)) {
    out.push({ path: 'script', rule: 'house rule: name seller rollover when funding is described', excerpt: 'funding is described without seller rollover' });
  }
  return out;
}

// ───────────── the brains ─────────────

export type Ask = (system: string, messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;

/** Pull the JSON object out of a model reply (plain JSON, fenced, or with words around it). */
export function parseJsonReply(text: unknown): unknown {
  if (text && typeof text === 'object') return text;
  const s = String(text ?? '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  throw new Error('The writer returned something that was not a script. Try again.');
}

function claudeAsk(rt: Runtime): Ask {
  const client = anthropicClient(rt.settings, 'studio-script', { apiKey: rt.settings.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 240_000 });
  return async (system, messages) => {
    const stream = client.beta.messages.stream({
      model: rt.settings.EMAIL_AI_MODEL || DEFAULT_EMAIL_MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCRIPT_SCHEMA } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    } as unknown as Anthropic.Beta.MessageCreateParamsStreaming);
    const res = await stream.finalMessage();
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
    if (res.stop_reason === 'max_tokens') throw new Error('The script came out too long. Try again.');
    return res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '{}';
  };
}

function workersAsk(rt: Runtime): Ask {
  return async (system, messages) => {
    const out = await runWorkersAi<{ response?: unknown }>(rt.env.AI as never, rt.settings, 'studio-script', WORKERS_AI_TEXT_MODEL, {
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 6000,
      temperature: 0.6,
      response_format: { type: 'json_schema', json_schema: SCRIPT_SCHEMA },
    });
    const r = out?.response;
    return typeof r === 'string' ? r : JSON.stringify(r ?? {});
  };
}

export function askFor(rt: Runtime, brain: Brain): Ask { return brain === 'claude' ? claudeAsk(rt) : workersAsk(rt); }

export interface Written { script: StudioScript; flags: ScriptFlag[]; attempts: number }

/**
 * Write one script: draft, audit, and when the draft trips the copy rules, one rewrite with every failure listed.
 * Keeps whichever version has fewer flags; the flags that remain are returned for the owner to see.
 */
export async function writeScript(ask: Ask, input: BrainInput): Promise<Written> {
  const system = scriptSystemPrompt(input);
  const first = { role: 'user' as const, content: scriptUserPrompt(input) };
  const text = await ask(system, [first]);
  const draft = cleanScript(parseJsonReply(text), input.format, input.cta);
  if (!draft.beats.length) throw new Error('The writer returned a script with no beats. Try again.');
  const issues = scriptIssues(draft);
  if (!issues.length) return { script: draft, flags: [], attempts: 1 };
  const list = issues.slice(0, 40).map((i) => `- ${i.path}: ${i.rule}: "${i.excerpt}"`).join('\n');
  try {
    const again = await ask(system, [first, { role: 'assistant', content: typeof text === 'string' ? text : JSON.stringify(text) }, {
      role: 'user',
      content: `Your draft breaks the copy rules in these places:\n${list}\n\nReturn the whole script again as JSON with only those lines rewritten (escalate, don't echo; state, don't hedge; keep every fact true; label example numbers illustrative; name seller rollover when funding is described; no em dashes). Everything else stays word for word.`,
    }]);
    const revised = cleanScript(parseJsonReply(again), input.format, input.cta);
    const left = scriptIssues(revised);
    if (revised.beats.length && left.length <= issues.length) return { script: revised, flags: left, attempts: 2 };
  } catch (e) {
    console.error('studio script rewrite failed', e instanceof Error ? e.message : e);
  }
  return { script: draft, flags: issues, attempts: 2 };
}

// ───────────── sources: YouTube ideas and their packs ─────────────

export async function ideaOptions(rt: Runtime) {
  const sprints = await listSprints(rt).catch(() => []);
  const { results: packs } = await rt.env.DB.prepare('SELECT sprint_id, topic_id FROM yt_packs').all<{ sprint_id: string; topic_id: string }>().catch(() => ({ results: [] as { sprint_id: string; topic_id: string }[] }));
  const has = new Set(packs.map((p) => `${p.sprint_id}:${p.topic_id}`));
  const out: { ref: string; title: string; topic: string; sprint: string; pack: boolean }[] = [];
  for (const s of sprints.slice(0, 6)) {
    for (const t of s.sprint.topics ?? []) {
      out.push({ ref: `${s.id}:${t.id}`, title: t.titles?.[0] || t.topic, topic: t.topic, sprint: new Date(s.created_at).toISOString().slice(0, 10), pack: has.has(`${s.id}:${t.id}`) });
      if (out.length >= 60) return out;
    }
  }
  return out;
}

/** The topic and context for an idea: the sprint's topic plan, and its written pack's spine when there is one. */
export async function ideaContext(rt: Runtime, ref: string): Promise<{ topic: string; context: string } | null> {
  const [sid, tid] = ref.split(':');
  if (!sid || !tid) return null;
  const ctx = await loadSprintTopic(rt, sid, tid);
  if (!ctx) return null;
  const t: Topic = ctx.topic;
  const lines = [
    `Working titles: ${t.titles.slice(0, 3).join(' | ')}`,
    t.hook ? `Planned hook: ${t.hook}` : '',
    t.outline?.logic_ladder?.length ? `Logic ladder: ${t.outline.logic_ladder.join(' → ')}` : '',
    t.outline?.intro_callouts ? `Call-in / call-out: ${t.outline.intro_callouts}` : '',
    t.demand_phrase ? `What owners search: ${t.demand_phrase}` : '',
  ];
  const pack = await getPack(rt, sid, tid).catch(() => null);
  if (pack) {
    lines.push(`Big idea (from the written pack): ${pack.pack.big_idea}`);
    lines.push(`Pack beats: ${pack.pack.beats.map((b) => b.headline).join(' → ')}`);
  }
  return { topic: t.topic, context: lines.filter(Boolean).join('\n').slice(0, 3000) };
}

// ───────────── storage ─────────────

const parse = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };
interface DbRow { id: string; created_at: string; updated_at: string | null; topic: string; source: string; source_ref: string | null; format: string; icp: string; framework: string; brain: string; title: string | null; est_seconds: number | null; data: string; flags: string | null; attempts: number }
const EMPTY: StudioScript = { hooks: [], hook_index: 0, hook: '', beats: [], titles: [], thumbnail: '', description: '', cta: '', words: 0, est_seconds: 0 };
const toRow = (r: DbRow): ScriptRow => ({
  id: r.id, created_at: r.created_at, updated_at: r.updated_at, topic: r.topic, source: r.source, source_ref: r.source_ref,
  format: r.format as FormatId, icp: r.icp as IcpId, framework: r.framework as FrameworkId, brain: r.brain as Brain,
  title: r.title, est_seconds: r.est_seconds, script: { ...EMPTY, ...parse<Partial<StudioScript>>(r.data, {}) }, flags: parse<ScriptFlag[]>(r.flags, []), attempts: r.attempts,
});

export async function saveScript(rt: Runtime, x: { topic: string; source: string; source_ref: string | null; format: FormatId; icp: IcpId; framework: FrameworkId; brain: Brain } & Written): Promise<ScriptRow> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // The writer leaves {APPLY_LINK} where the link goes; fill in the real one.
  const link = (rt.settings.PUBLIC_URL || rt.origin || '').replace(/\/+$/, '');
  if (link) x = { ...x, script: { ...x.script, description: x.script.description.replaceAll('{APPLY_LINK}', link) } };
  await rt.env.DB.prepare('INSERT INTO studio_scripts (id, created_at, updated_at, topic, source, source_ref, format, icp, framework, brain, title, est_seconds, data, flags, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, now, now, x.topic, x.source, x.source_ref, x.format, x.icp, x.framework, x.brain, x.script.titles[0] ?? x.topic.slice(0, 100), x.script.est_seconds, JSON.stringify(x.script), JSON.stringify(x.flags), x.attempts).run();
  return { id, created_at: now, updated_at: now, topic: x.topic, source: x.source, source_ref: x.source_ref, format: x.format, icp: x.icp, framework: x.framework, brain: x.brain, title: x.script.titles[0] ?? x.topic.slice(0, 100), est_seconds: x.script.est_seconds, script: x.script, flags: x.flags, attempts: x.attempts };
}

export async function listScripts(rt: Runtime) {
  const { results } = await rt.env.DB.prepare('SELECT id, created_at, topic, source, format, icp, framework, brain, title, est_seconds, flags, data FROM studio_scripts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 100').all<DbRow>();
  return results.map((r) => {
    const s = parse<Partial<StudioScript>>(r.data, {});
    return { id: r.id, created_at: r.created_at, topic: r.topic, source: r.source, format: r.format, icp: r.icp, framework: r.framework, brain: r.brain, title: r.title, est_seconds: r.est_seconds, beats: Array.isArray(s.beats) ? s.beats.length : 0, flags: parse<unknown[]>(r.flags, []).length };
  });
}

export async function getScript(rt: Runtime, id: string): Promise<ScriptRow | null> {
  const r = await rt.env.DB.prepare('SELECT * FROM studio_scripts WHERE id = ? AND deleted_at IS NULL').bind(id).first<DbRow>();
  return r ? toRow(r) : null;
}

// ───────────── routes: /admin/api/studio/scripts* ─────────────

export const STUDIO_SCRIPT_COPY = {
  noBrain: 'No writer is available here. Add the Anthropic key in Integrations, or run where Workers AI is available.',
  noTopic: 'Write a topic, or pick a YouTube idea.',
  notFound: 'That script is not there any more.',
  failed: 'The script could not be written this time. Try again in a minute.',
};

const pick = <T extends string>(v: unknown, ids: readonly T[], d: T): T => (typeof v === 'string' && (ids as readonly string[]).includes(v) ? (v as T) : d);

export const studioScriptsAdmin = new Hono<AppEnv>();
studioScriptsAdmin.use('*', requireAdmin);

studioScriptsAdmin.get('/options', async (c) => {
  const rt = runtimeFrom(c);
  return c.json({
    brain: brainOf(rt),
    formats: FORMAT_IDS.map((id) => ({ id, label: FORMATS[id].label, sub: FORMATS[id].sub })),
    icps: ICP_IDS.map((id) => ({ id, label: ICPS[id].label, sub: ICPS[id].sub })),
    frameworks: [{ id: 'auto', label: 'Auto', sub: 'Picked from the format and the viewer' }, ...FRAMEWORK_IDS.map((id) => ({ id, label: FRAMEWORKS[id].label, sub: FRAMEWORKS[id].sub }))],
    auto: Object.fromEntries(FORMAT_IDS.map((f) => [f, Object.fromEntries(ICP_IDS.map((i) => [i, pickFramework(f, i)]))])),
    ideas: await ideaOptions(rt),
  });
});

studioScriptsAdmin.get('/', async (c) => c.json({ scripts: await listScripts(runtimeFrom(c)), brain: brainOf(runtimeFrom(c)) }));

studioScriptsAdmin.get('/:id', async (c) => {
  const row = await getScript(runtimeFrom(c), c.req.param('id'));
  return row ? c.json({ script: row }) : c.json({ ok: false, error: STUDIO_SCRIPT_COPY.notFound }, 404);
});

studioScriptsAdmin.post('/', async (c) => {
  const rt = runtimeFrom(c);
  const b = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  const brain = brainOf(rt);
  if (!brain) return c.json({ ok: false, error: STUDIO_SCRIPT_COPY.noBrain }, 400);
  const format = pick(b.format, FORMAT_IDS, 'long');
  const icp = pick(b.icp, ICP_IDS, 'trapped');
  const choice = pick<FrameworkChoice>(b.framework, ['auto', ...FRAMEWORK_IDS], 'auto');
  const framework = pickFramework(format, icp, choice);
  let topic = clip(b.topic, 600);
  let context = '';
  let source = 'topic';
  let sourceRef: string | null = null;
  if (typeof b.idea === 'string' && b.idea) {
    const idea = await ideaContext(rt, b.idea);
    if (!idea) return c.json({ ok: false, error: 'That YouTube idea is not there any more.' }, 404);
    topic = topic || idea.topic;
    context = idea.context;
    source = 'idea';
    sourceRef = b.idea;
  }
  if (!topic) return c.json({ ok: false, error: STUDIO_SCRIPT_COPY.noTopic }, 400);
  const input: BrainInput = { topic, context, format, icp, framework, cta: ctaFor(format, rt.settings.STUDIO_SCRIPT_CTA), notes: rt.settings.STUDIO_SCRIPT_NOTES || undefined };
  try {
    const written = await writeScript(askFor(rt, brain), input);
    const row = await saveScript(rt, { topic, source, source_ref: sourceRef, format, icp, framework, brain, ...written });
    return c.json({ ok: true, script: row });
  } catch (e) {
    console.error('studio script failed', e instanceof Error ? e.message : e);
    const msg = e instanceof Error && /declined|too long|not a script|no beats/.test(e.message) ? e.message : STUDIO_SCRIPT_COPY.failed;
    return c.json({ ok: false, error: msg }, 502);
  }
});

studioScriptsAdmin.delete('/:id', async (c) => {
  const rt = runtimeFrom(c);
  const r = await rt.env.DB.prepare('UPDATE studio_scripts SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').bind(new Date().toISOString(), c.req.param('id')).run();
  return (r.meta?.changes ?? 0) ? c.json({ ok: true }) : c.json({ ok: false, error: STUDIO_SCRIPT_COPY.notFound }, 404);
});
