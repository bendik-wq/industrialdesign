import type Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';
import { copyBrief } from '../content/copy-rules';
import { anthropicClient, runWorkersAi } from '../infra/ai-gateway';
import { DEFAULT_EMAIL_MODEL } from '../personalize/personalize';
import { FACTS, LAYOUTS, LAYOUT_GUIDE, type Layout } from '../studio/copy-brain';
import { type Ask, type Brain, type ScriptFlag, type StudioScript, WORKERS_AI_TEXT_MODEL, parseJsonReply, scriptIssues } from '../studio/scripts';

/**
 * Radar: the analysis of one top performer, as STRICT JSON. For a video: the hook (exact opening words, why it
 * works, its type), the structure as beats with timestamps, likely drop-off points (estimates from structure and
 * engagement: no service gives another creator's retention curve), the CTA, the pattern that made it perform, and
 * "For G&L": how to apply it to $1M+ owners doing roll-up acquisitions, a rewritten hook in our voice, 3 angles and
 * a Studio layout per beat. For a Meta ad: hook, offer, format, angle, CTA, landing-page promise and how we'd run
 * the same angle. The G&L part goes through the copy gate (auditCopy plus the Studio rules) with one rewrite.
 */

export const HOOK_TYPES = ['question', 'contrarian', 'result', 'story', 'curiosity', 'pattern_interrupt', 'list', 'authority', 'problem', 'other'] as const;
export type HookType = (typeof HOOK_TYPES)[number];

const S = { type: 'string' } as const;
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const HOOK = obj({ text: S, why: S, type: { type: 'string', enum: [...HOOK_TYPES] } });
const LAYOUT_PICKS = { type: 'array', items: obj({ beat: S, layout: { type: 'string', enum: [...LAYOUTS] } }) };

export const VIDEO_SCHEMA = obj({
  summary: S,
  hook: HOOK,
  beats: { type: 'array', items: obj({ t: S, label: S, what: S }) },
  drop_offs: { type: 'array', items: obj({ t: S, why: S }) },
  cta: S,
  pattern: S,
  format: S,
  topic: S,
  for_gl: obj({ apply: S, hook: S, angles: { type: 'array', items: S }, layouts: LAYOUT_PICKS }),
});
export const AD_SCHEMA = obj({
  summary: S,
  hook: HOOK,
  offer: S,
  format: S,
  angle: S,
  cta: S,
  landing_promise: S,
  pattern: S,
  topic: S,
  for_gl: obj({ how_we_run: S, hook: S, angles: { type: 'array', items: S }, layouts: LAYOUT_PICKS }),
});

export interface Analysis {
  kind: 'video' | 'ad';
  summary: string;
  hook: { text: string; why: string; type: HookType };
  beats: { t: string; label: string; what: string }[];
  drop_offs: { t: string; why: string }[];
  cta: string; pattern: string; format: string; topic: string;
  offer: string; angle: string; landing_promise: string;
  for_gl: { apply: string; hook: string; angles: string[]; layouts: { beat: string; layout: Layout }[]; how_we_run: string };
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\r/g, '').trim().slice(0, n);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const arr = (v: unknown) => (Array.isArray(v) ? v : []);

/** Validate and clamp a model's reply. Throws when the reply has no hook or no G&L part (nothing to show). */
export function cleanAnalysis(raw: unknown, kind: 'video' | 'ad'): Analysis {
  const r = isObj(raw) ? raw : {};
  const h = isObj(r.hook) ? r.hook : {};
  const g = isObj(r.for_gl) ? r.for_gl : {};
  const type = (HOOK_TYPES as readonly string[]).includes(String(h.type)) ? (h.type as HookType) : 'other';
  const out: Analysis = {
    kind,
    summary: clip(r.summary, 400),
    hook: { text: clip(h.text, 400), why: clip(h.why, 800), type },
    beats: kind === 'video' ? arr(r.beats).filter(isObj).slice(0, 20).map((b) => ({ t: clip(b.t, 12), label: clip(b.label, 80), what: clip(b.what, 400) })).filter((b) => b.label || b.what) : [],
    drop_offs: kind === 'video' ? arr(r.drop_offs).filter(isObj).slice(0, 6).map((d) => ({ t: clip(d.t, 12), why: clip(d.why, 400) })).filter((d) => d.why) : [],
    cta: clip(r.cta, 300), pattern: clip(r.pattern, 800), format: clip(r.format, 120), topic: clip(r.topic, 160),
    offer: clip(r.offer, 400), angle: clip(r.angle, 400), landing_promise: clip(r.landing_promise, 400),
    for_gl: {
      apply: clip(g.apply, 1600),
      how_we_run: clip(g.how_we_run, 1600),
      hook: clip(g.hook, 240),
      angles: arr(g.angles).map((a) => clip(a, 300)).filter(Boolean).slice(0, 3),
      layouts: arr(g.layouts).filter(isObj).slice(0, 20).map((l) => ({ beat: clip(l.beat, 80), layout: ((LAYOUTS as readonly string[]).includes(String(l.layout)) ? l.layout : 'spotlight') as Layout })).filter((l) => l.beat),
    },
  };
  if (!out.hook.text || !out.for_gl.hook) throw new Error('The analysis came back without a hook. Try again.');
  return out;
}

/** The copy gate over the G&L part only (the original creator's words are quoted, not ours). */
export function glIssues(a: Analysis): ScriptFlag[] {
  const g = a.for_gl;
  const texts = [g.apply, g.how_we_run, ...g.angles].filter(Boolean);
  const shape: StudioScript = { hooks: [g.hook], hook_index: 0, hook: g.hook, beats: texts.map((text) => ({ layout: 'spotlight', text, cue: '', on_screen: '', screen: '' })), titles: [], thumbnail: '', description: '', cta: '', words: 0, est_seconds: 0 };
  const names = [g.apply ? 'for_gl.apply' : null, g.how_we_run ? 'for_gl.how_we_run' : null, ...g.angles.map((_, i) => `for_gl.angles[${i}]`)].filter(Boolean) as string[];
  return scriptIssues(shape).map((f) => ({ ...f, path: f.path.replace(/^hooks\[0\]/, 'for_gl.hook').replace(/^beats\[(\d+)\]\.(text|on_screen)/, (_, i) => names[Number(i)] ?? 'for_gl') }));
}

export interface AnalyseInput {
  platform: string; title: string | null; caption: string | null; author: string | null; url: string | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; followers: number | null;
  published_at: string | null; duration_s: number | null; score: number; score_json: string | null;
  transcript: string | null; transcript_source: string | null;
  ad_active_days: number | null; ad_variants: number | null; ad_cta: string | null; ad_link: string | null; media_kind: string | null;
}

export function analysisSystemPrompt(kind: 'video' | 'ad'): string {
  const layouts = LAYOUTS.map((l) => `- ${l}: ${LAYOUT_GUIDE[l]}`).join('\n');
  return `You are G&L M&A Advisory's content strategist. You study top performing ${kind === 'ad' ? 'Meta ads' : 'short and long-form videos'}, inside and outside our niche, and show Josh Li exactly what made each one work and how to use the same pattern for G&L.

G&L's viewer: owners of businesses doing $1M+ revenue who want to grow by buying competitors (roll-up acquisitions), funded mostly by the target's own cash flow (commercial debt + seller finance + seller rollover), with little or none of their own money, building toward a group worth nine figures.

${kind === 'ad' ? `FOR AN AD, return: summary (one line), hook (text: the ad's opening words exactly as written; why it stops the scroll; type), offer (what the ad gives or sells), format (single image, video, carousel, and the style), angle (the belief or desire it leans on), cta, landing_promise (what the click promises), pattern (why it keeps running: longevity and variants are the performance proxy, Meta shows no spend for commercial ads), topic, and for_gl: how_we_run (how G&L runs the same angle for $1M+ owners, concretely: the creative, the copy direction and what the landing page promises), hook (our rewritten opening line), angles (exactly 3), layouts (if we film it face-cam: a Studio layout per beat).`
    : `FOR A VIDEO, return: summary (one line), hook (text: the exact opening words from the transcript, word for word; if there is no transcript, use the title and caption and say in why that the words are inferred; why it works; type), beats (the structure in order, each with t as m:ss from the transcript marks or an estimate, a short label and what happens), drop_offs (likely drop-off points: ESTIMATES from the structure and the engagement numbers, never presented as measured retention; say what in the structure causes each), cta, pattern (what made it perform, in terms we can reuse), format (talking head, screen walkthrough, street interview, and so on), topic, and for_gl: apply (how to apply this exact pattern to $1M+ owners doing roll-up acquisitions with seller finance and seller rollover; concrete), hook (our rewritten opening line in Josh's voice, 15 words max), angles (exactly 3 video ideas using this pattern), layouts (a Studio face-cam layout per beat of our version).`}

STUDIO LAYOUTS (for_gl.layouts):
${layouts}

${FACTS}

RULES FOR THE G&L PART (for_gl): use only the true facts above as proof; never invent results, clients, students or numbers; any example number is labelled "illustrative"; whenever funding is described, name seller rollover alongside commercial debt and seller finance; never call a strategy call "free"; no em dashes, no emojis, no exclamation marks, no hedges.
The analysis of the original quotes the creator; the G&L part is ours.

${copyBrief('ideas')}

Return JSON only.`;
}

export function analysisUserPrompt(i: AnalyseInput): string {
  const kind = i.platform === 'meta_ads' ? 'ad' : 'video';
  const n = (v: number | null) => (v == null ? 'unknown' : v.toLocaleString('en-US'));
  const lines = [
    `Platform: ${i.platform}`, `By: ${i.author ?? 'unknown'}`, i.url ? `Link: ${i.url}` : '',
    i.title ? `Title: ${i.title}` : '', i.caption ? `Caption or ad text:\n${i.caption.slice(0, 3000)}` : '',
    kind === 'ad'
      ? `Days active: ${n(i.ad_active_days)}. Variants Meta groups with it: ${n(i.ad_variants)}. CTA button: ${i.ad_cta ?? 'unknown'}. Links to: ${i.ad_link ?? 'unknown'}. Creative: ${i.media_kind ?? 'unknown'}.`
      : `Views ${n(i.views)}, likes ${n(i.likes)}, comments ${n(i.comments)}, shares ${n(i.shares)}, author followers ${n(i.followers)}, published ${i.published_at ?? 'unknown'}, length ${i.duration_s ? Math.round(i.duration_s) + ' s' : 'unknown'}. Outlier score ${i.score} of 100 (${i.score_json ?? ''}).`,
    kind === 'video' ? (i.transcript ? `Transcript (${i.transcript_source ?? 'captions'}):\n${i.transcript.slice(0, 14000)}` : 'Transcript: missing. Work from the title, the caption and the numbers, and say so where it matters.') : '',
  ];
  return `Analyse this ${kind}.\n\n${lines.filter(Boolean).join('\n')}`;
}

// ───────────── the brains ─────────────

export function askJson(rt: Runtime, brain: Brain, schema: object, feature = 'radar-analysis'): Ask {
  if (brain === 'claude') {
    const client = anthropicClient(rt.settings, feature, { apiKey: rt.settings.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 180_000 });
    return async (system, messages) => {
      const stream = client.beta.messages.stream({
        model: rt.settings.EMAIL_AI_MODEL || DEFAULT_EMAIL_MODEL,
        max_tokens: 12000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages,
      } as unknown as Anthropic.Beta.MessageCreateParamsStreaming);
      const res = await stream.finalMessage();
      if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
      if (res.stop_reason === 'max_tokens') throw new Error('The analysis came out too long. Try again.');
      return res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '{}';
    };
  }
  return async (system, messages) => {
    const out = await runWorkersAi<{ response?: unknown }>(rt.env.AI as never, rt.settings, feature, WORKERS_AI_TEXT_MODEL, {
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 4000,
      temperature: 0.4,
      response_format: { type: 'json_schema', json_schema: schema },
    });
    const r = out?.response;
    return typeof r === 'string' ? r : JSON.stringify(r ?? {});
  };
}

export interface Analysed { analysis: Analysis; flags: ScriptFlag[]; attempts: number }

/** Analyse, gate the G&L part, and when it trips the copy rules, one rewrite with every failure listed. */
export async function analyse(ask: Ask, input: AnalyseInput): Promise<Analysed> {
  const kind = input.platform === 'meta_ads' ? 'ad' : 'video';
  const system = analysisSystemPrompt(kind);
  const first = { role: 'user' as const, content: analysisUserPrompt(input) };
  const text = await ask(system, [first]);
  const draft = cleanAnalysis(parseJsonReply(text), kind);
  const issues = glIssues(draft);
  if (!issues.length) return { analysis: draft, flags: [], attempts: 1 };
  const list = issues.slice(0, 30).map((i) => `- ${i.path}: ${i.rule}: "${i.excerpt}"`).join('\n');
  try {
    const again = await ask(system, [first, { role: 'assistant', content: text }, {
      role: 'user',
      content: `The G&L part breaks the copy rules here:\n${list}\n\nReturn the whole JSON again with only those for_gl lines rewritten (state, don't hedge; keep every fact true; label example numbers illustrative; name seller rollover when funding is described; no em dashes). Everything else stays word for word.`,
    }]);
    const revised = cleanAnalysis(parseJsonReply(again), kind);
    const left = glIssues(revised);
    if (left.length <= issues.length) return { analysis: revised, flags: left, attempts: 2 };
  } catch (e) {
    console.error('radar analysis rewrite failed', e instanceof Error ? e.message : e);
  }
  return { analysis: draft, flags: issues, attempts: 2 };
}

/** The context a Studio script gets from an analysis ("Make it a script"). */
export function scriptContext(a: Analysis, i: { platform: string; title: string | null; author: string | null; views: number | null; ad_active_days: number | null }): string {
  const src = i.platform === 'meta_ads' ? `a Meta ad by ${i.author ?? 'an advertiser'} that has run ${i.ad_active_days ?? '?'} days` : `a ${i.platform} video by ${i.author ?? 'a creator'}${i.views ? ` with ${i.views.toLocaleString('en-US')} views` : ''}`;
  return [
    `Modelled on ${src}${i.title ? `: "${i.title}"` : ''}. Use its pattern, never its claims or its words beyond the hook shape.`,
    `Its hook (${a.hook.type}): "${a.hook.text}". Why it works: ${a.hook.why}`,
    a.beats.length ? `Its structure: ${a.beats.map((b) => `${b.t} ${b.label}`).join(' → ')}` : '',
    a.pattern ? `What made it perform: ${a.pattern}` : '',
    a.drop_offs.length ? `Where viewers likely leave (estimate), so avoid it: ${a.drop_offs.map((d) => `${d.t} ${d.why}`).join('; ')}` : '',
    a.for_gl.apply || a.for_gl.how_we_run ? `How G&L applies it: ${a.for_gl.apply || a.for_gl.how_we_run}` : '',
    `Use this as one of the 3 hooks: "${a.for_gl.hook}"`,
    a.for_gl.angles.length ? `Angles: ${a.for_gl.angles.join(' | ')}` : '',
    a.for_gl.layouts.length ? `Suggested layouts: ${a.for_gl.layouts.map((l) => `${l.beat}: ${l.layout}`).join('; ')}` : '',
  ].filter(Boolean).join('\n').slice(0, 3000);
}
