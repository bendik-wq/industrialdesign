/**
 * Marketing department: video scripts and hook packs for Josh to record.
 *
 * Five formats, each 30 to 60 seconds spoken:
 *  - talking_head: Josh to camera, one argument, one next step;
 *  - podcast_clip: a podcast-style clip that argues against a common belief. The belief is shown on screen as
 *    "Common advice", never pinned on a named person; Josh is the only speaker, no fake host or guest;
 *  - double_hook: two hooks stacked in the first seconds, then the argument;
 *  - mechanism: mechanism-led (commercial debt, seller finance, seller rollover, the 1.5x test, the order);
 *  - cost_of_waiting: a mini-VSL on what waiting costs, every number labelled illustrative.
 *
 * Hooks are stored apart from the body (ads_scripts.hooks), so any hook (or one from a hook pack) can be swapped
 * in. Every hook and line passes auditCopy + the ad rules + the honest-version rules before it is stored.
 */
import type { Runtime } from '../app';
import { newId } from '../lib/ids';
import { AUDIENCES, PROOF } from '../research/analyze';
import type { Complete } from './angles';
import { AUDIENCE_HOOK, AWARE_HOOK, CONTRARIAN_HOOK, DESIRE_HOOK, type AngleSrc, CONCEPT_SYSTEM, claudeJson, clean, json, loadAngles } from './concepts';
import { type Issue, auditHonest } from './honest';

export const SCRIPT_FORMATS = [
  { id: 'talking_head', label: 'Founder talking head', describe: 'Josh to camera, one argument, one next step.' },
  { id: 'podcast_clip', label: 'Podcast clip against a common belief', describe: 'Argues against a common belief shown on screen, never against a named person.' },
  { id: 'double_hook', label: 'Double hook', describe: 'Two hooks stacked in the first seconds, then the argument.' },
  { id: 'mechanism', label: 'Mechanism-led', describe: 'The structure and the 1.5x test, step by step.' },
  { id: 'cost_of_waiting', label: 'Cost-of-waiting mini-VSL', describe: 'What waiting costs, with every number labelled illustrative.' },
] as const;
export type ScriptFormat = (typeof SCRIPT_FORMATS)[number]['id'];
export const isScriptFormat = (v: unknown): v is ScriptFormat => SCRIPT_FORMATS.some((f) => f.id === v);

export interface Beat { beat: string; say: string; screen?: string }
export interface Script { format: ScriptFormat; title: string; angle: string; hooks: string[]; body: Beat[]; cta: string; notes: string }

const CTA = 'The link below walks through the full structure. If it fits your business, apply there.';
const proofOf = (id: string) => (id === 'none' || id === 'mechanism' ? null : PROOF.find((p) => p.id === id)?.text ?? null);
const belief = (a: AngleSrc) => a.belief.replace(/\.$/, '');

// ───────────── hooks ─────────────

export const HOOK_STYLES = ['callout', 'question', 'contrarian', 'proof', 'mechanism', 'cost', 'double'] as const;
export type HookStyle = (typeof HOOK_STYLES)[number];

/** Hook candidates for an angle by style (template bank; each is checked before use). */
export function hookBank(a: AngleSrc): { style: HookStyle; text: string }[] {
  const callout = AUDIENCE_HOOK[a.audience] ?? AUDIENCE_HOOK[AUDIENCES[1]];
  return [
    { style: 'callout', text: `${callout} ${a.hook}` },
    { style: 'callout', text: 'To the owner doing $1M+ a year who still signs off on everything.' },
    { style: 'question', text: 'Who buys your competitor when its owner retires with no successor?' },
    { style: 'question', text: 'How does an owner buy a competitor when the bank wants a deposit first?' },
    { style: 'question', text: 'What is your business worth as part of a group instead of on its own?' },
    { style: 'contrarian', text: CONTRARIAN_HOOK(a.belief) },
    { style: 'contrarian', text: `Everyone says "${belief(a)}." For an owner at $1M+ revenue, the opposite is true.` },
    { style: 'proof', text: AWARE_HOOK.product },
    { style: 'mechanism', text: 'Banks don\'t reject buyers. They reject structures, and the structure that passes is tested at 1.5x debt service coverage.' },
    { style: 'mechanism', text: AWARE_HOOK.solution },
    { style: 'cost', text: 'Every year you wait, an owner with no successor sells the business you wanted to someone who asked first.' },
    { style: 'cost', text: DESIRE_HOOK.break_ceiling },
    { style: 'double', text: `${AWARE_HOOK.unaware} ${a.hook}` },
    { style: 'double', text: `${DESIRE_HOOK.be_the_buyer} ${AWARE_HOOK.solution}` },
    { style: 'callout', text: a.hook },
  ];
}

export const lineProblems = (text: string, proofIds: string[]): Issue[] => auditHonest(text, proofIds);
const ok = (text: string, a: AngleSrc) => !lineProblems(text, [a.proof_id, 'radiology']).length;

/** A pack of hooks for an angle (one or two per style), all passing the rules. */
export function templateHookPack(a: AngleSrc, n = 10): { style: HookStyle; text: string }[] {
  const seen = new Set<string>();
  const out: { style: HookStyle; text: string }[] = [];
  for (const h of hookBank(a)) {
    const k = h.text.toLowerCase();
    if (seen.has(k) || !ok(h.text, a)) continue;
    seen.add(k); out.push(h);
    if (out.length === n) break;
  }
  return out;
}

// ───────────── scripts (templates) ─────────────

const HOOKS_FOR: Record<ScriptFormat, HookStyle[]> = {
  talking_head: ['callout', 'question', 'proof', 'cost', 'mechanism'],
  podcast_clip: ['contrarian', 'mechanism', 'question', 'proof', 'callout'],
  double_hook: ['double', 'double', 'callout', 'contrarian', 'question'],
  mechanism: ['mechanism', 'proof', 'question', 'contrarian', 'callout'],
  cost_of_waiting: ['cost', 'question', 'callout', 'proof', 'contrarian'],
};

function pickHooks(a: AngleSrc, format: ScriptFormat): string[] {
  const bank = templateHookPack(a, 20);
  const out: string[] = [];
  for (const style of HOOKS_FOR[format]) {
    const h = bank.find((x) => x.style === style && !out.includes(x.text));
    if (h) out.push(h.text);
  }
  for (const h of bank) { if (out.length >= 5) break; if (!out.includes(h.text)) out.push(h.text); }
  return out.slice(0, 5);
}

export function templateScript(a: AngleSrc, format: ScriptFormat): Script {
  const proof = proofOf(a.proof_id);
  const mech: Beat = { beat: 'Mechanism', say: 'Commercial debt is lent against the cash flow of the business you buy. Seller finance and seller rollover close the gap, and the deal has to pass 1.5x debt service coverage.', screen: 'Commercial debt + seller finance + seller rollover' };
  const order: Beat = { beat: 'The order', say: 'Agree the shape with the seller first. Then take it to the lender.', screen: 'Seller first, then the lender' };
  const promise: Beat = { beat: 'Promise', say: a.promise };
  const bodies: Record<ScriptFormat, Beat[]> = {
    talking_head: [
      { beat: 'Problem', say: `Most owners at $1M+ revenue believe this: "${belief(a)}."`, screen: belief(a) },
      { beat: 'Why it matters', say: 'That belief keeps them growing one hire at a time, while owners with no successor sell to whoever asks first.' },
      mech, ...(proof ? [{ beat: 'Proof', say: proof }] : []), promise,
    ],
    podcast_clip: [
      { beat: 'The common belief', say: `The common advice is "${belief(a)}."`, screen: `Common advice: "${belief(a)}"` },
      { beat: 'Why it is wrong', say: 'For an owner doing $1M+ a year, that advice is wrong. Lenders lend against the cash flow of the business you buy.' },
      { beat: 'The real problem', say: 'The real problem is the structure, and most owners never see one that works.' },
      mech, promise,
    ],
    double_hook: [
      { beat: 'Turn', say: 'Both of those come down to one decision: grow by hiring, or grow by buying.' },
      mech, order, ...(proof ? [{ beat: 'Proof', say: proof }] : []),
    ],
    mechanism: [
      { beat: 'Step one', say: 'Find an owner with no successor. Most good businesses never reach a broker.', screen: 'Off-market owners with no successor' },
      { beat: 'Step two', say: 'Test the deal at 1.5x debt service coverage before you agree a price. Walk from the ones that fail it.', screen: '1.5x debt service coverage' },
      { beat: 'Step three', say: 'Fund it with commercial debt against the target\'s cash flow, seller finance and seller rollover.', screen: 'Debt + seller finance + seller rollover' },
      order, ...(proof ? [{ beat: 'Proof', say: proof }] : []),
    ],
    cost_of_waiting: [
      { beat: 'The cost', say: 'Illustrative: a competitor making $400K a year in profit is $800K of profit over two years that goes to whoever buys it.', screen: 'Illustrative numbers' },
      { beat: 'Why owners wait', say: `Owners wait because they believe "${belief(a)}."` },
      { beat: 'What waiting does', say: 'Meanwhile the owner with no successor sells to the first buyer who asks, and your ceiling stays where it is.' },
      mech, promise,
    ],
  };
  const notes: Record<ScriptFormat, string> = {
    talking_head: 'Josh to camera, eye level, one take per hook. Record every hook, then the body once: the hooks are swapped in the edit.',
    podcast_clip: 'Film podcast style with Josh as the only speaker (mic in frame). Show the common belief on screen labelled "Common advice", never attributed to a person. No host, guest or audience that isn\'t real.',
    double_hook: 'Say the two hooks back to back in the first five seconds, then cut to the body. Record each hook pair separately.',
    mechanism: 'Josh at a whiteboard or with on-screen text for each step. Keep each step on screen while he says it.',
    cost_of_waiting: 'Mini-VSL with text on screen. Every number stays labelled "illustrative" on screen and in the voice. No real client figures.',
  };
  const title = `${SCRIPT_FORMATS.find((f) => f.id === format)!.label}: ${a.hook.slice(0, 70)}`;
  const body = bodies[format].filter((b) => b.say && ok(b.say, a));
  return { format, title, angle: a.hook, hooks: pickHooks(a, format), body, cta: CTA, notes: notes[format] };
}

export function scriptProblems(s: Script, proofIds: string[]): Issue[] {
  const out: Issue[] = [];
  for (const h of s.hooks) out.push(...lineProblems(h, proofIds));
  for (const b of s.body) { out.push(...lineProblems(b.say, proofIds)); if (b.screen) out.push(...lineProblems(b.screen, proofIds)); }
  out.push(...lineProblems(s.cta, proofIds));
  if (!s.hooks.length || !s.body.length) out.push({ rule: 'a script needs hooks and a body', excerpt: s.title });
  return out;
}

/** Spoken length in seconds at about 2.5 words a second (the first hook plus the body and the CTA). */
export const scriptSeconds = (s: Pick<Script, 'hooks' | 'body' | 'cta'>) =>
  Math.round(([s.hooks[0] ?? '', ...s.body.map((b) => b.say), s.cta].join(' ').split(/\s+/).filter(Boolean).length / 2.5));

/** The full text with one hook, ready to paste into a teleprompter. */
export const scriptText = (s: Pick<Script, 'hooks' | 'body' | 'cta' | 'title'>, hook = 0) =>
  [s.title, '', `HOOK: ${s.hooks[hook] ?? s.hooks[0] ?? ''}`, '', ...s.body.map((b) => `${b.beat.toUpperCase()}: ${b.say}${b.screen ? `\n[On screen: ${b.screen}]` : ''}`), '', `CTA: ${s.cta}`].join('\n');

// ───────────── Claude (optional) ─────────────

const SCRIPT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['hooks', 'body'],
  properties: {
    hooks: { type: 'array', items: { type: 'string' } },
    body: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['beat', 'say', 'screen'], properties: { beat: { type: 'string' }, say: { type: 'string' }, screen: { type: 'string' } } } },
  },
};
const SCRIPT_RULES = 'VIDEO SCRIPT: spoken by Josh himself, 30 to 60 seconds, one or two sentences per beat. Hooks are separate lines (five of them, each a different entry point) and must work in front of the same body. A podcast-clip script argues against a common belief shown on screen as "Common advice"; never name, quote or imply a real person, and never invent a host or guest. Every number not in the approved proof is labelled illustrative in the same line. No AI voice or avatar presented as Josh.';

export async function writeScript(a: AngleSrc, format: ScriptFormat, complete: Complete | null): Promise<{ script: Script; origin: 'ai' | 'template' }> {
  const base = templateScript(a, format);
  if (!complete) return { script: base, origin: 'template' };
  try {
    const out = json<{ hooks?: string[]; body?: Beat[] }>(await complete(`${CONCEPT_SYSTEM}\n\n${SCRIPT_RULES}`, [
      `Format: ${SCRIPT_FORMATS.find((f) => f.id === format)!.label}. ${SCRIPT_FORMATS.find((f) => f.id === format)!.describe}`,
      `Angle: ${a.hook} ${a.promise}`, `Belief it breaks: ${a.belief}`, `Audience: ${a.audience}`,
      `Approved proof: ${proofOf(a.proof_id) ?? 'none'}; also allowed: ${PROOF[0].text}`,
      'Write {"hooks":["..." x5],"body":[{"beat":"...","say":"...","screen":"..."}]}. End the body before the call to action; the CTA is added separately.',
    ].join('\n\n')));
    const proofIds = [a.proof_id, 'radiology'];
    const hooks = (out.hooks ?? []).map((h) => clean(h, 300)).filter((h) => h && !lineProblems(h, proofIds).length);
    const body = (out.body ?? []).map((b) => ({ beat: clean(b.beat, 40), say: clean(b.say, 500), ...(b.screen?.trim() ? { screen: clean(b.screen, 120) } : {}) })).filter((b) => b.say);
    const bodyOk = body.length >= 3 && body.every((b) => !lineProblems(b.say, proofIds).length && (!b.screen || !lineProblems(b.screen, proofIds).length));
    if (!bodyOk) return { script: base, origin: 'template' };
    const merged = [...hooks, ...base.hooks.filter((h) => !hooks.includes(h))].slice(0, 5);
    return { script: { ...base, hooks: merged, body }, origin: 'ai' };
  } catch { return { script: base, origin: 'template' }; }
}

// ───────────── storage ─────────────

export interface ScriptRow { id: string; format: string; title: string; angle: string; angle_id: string | null; angle_key: string | null; hooks: string; body: string; cta: string; notes: string | null; origin: string; status: string; created_at: number; updated_at: number }

async function angleFor(rt: Runtime, ref: string | undefined) {
  const all = await loadAngles(rt);
  return all.find((a) => (a.id && `r:${a.id}` === ref) || (a.key && `k:${a.key}` === ref)) ?? all[0];
}

export async function draftScript(rt: Runtime, input: { format: string; angle_ref?: string }, complete: Complete | null | undefined = undefined, now = Date.now()) {
  if (!isScriptFormat(input.format)) throw new Error('Pick a script format.');
  const a = await angleFor(rt, input.angle_ref);
  const ai = complete === undefined ? claudeJson(rt, SCRIPT_SCHEMA) : complete;
  const { script, origin } = await writeScript(a, input.format, ai);
  const issues = scriptProblems(script, [a.proof_id, 'radiology']);
  if (issues.length) throw new Error(`The script broke a rule: ${issues.slice(0, 3).map((x) => x.rule).join('; ')}`);
  const id = newId('sc_');
  await rt.env.DB.prepare('INSERT INTO ads_scripts (id, format, title, angle, angle_id, angle_key, hooks, body, cta, notes, origin, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, script.format, script.title, script.angle, a.id, a.key, JSON.stringify(script.hooks), JSON.stringify(script.body), script.cta, script.notes, origin, 'draft', now, now).run();
  return { id, ...script, origin, seconds: scriptSeconds(script) };
}

export async function draftHookPack(rt: Runtime, input: { angle_ref?: string }, now = Date.now()) {
  const a = await angleFor(rt, input.angle_ref);
  const pack = templateHookPack(a, 12);
  const packId = newId('hp_');
  await rt.env.DB.batch(pack.map((h) => rt.env.DB.prepare('INSERT INTO ads_hooks (id, pack_id, style, text, angle, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(newId('hk_'), packId, h.style, h.text, a.hook, 'new', now)));
  return { packId, angle: a.hook, hooks: pack };
}

/** Swap a hook into a script (from its own list or a pack), or edit one; audited. */
export async function editScript(rt: Runtime, id: string, b: { hooks?: unknown; status?: unknown }) {
  const row = await rt.env.DB.prepare('SELECT * FROM ads_scripts WHERE id = ?').bind(id).first<ScriptRow>();
  if (!row) throw new Error('Script not found.');
  const sets: string[] = [], vals: unknown[] = [];
  if (Array.isArray(b.hooks)) {
    const hooks = b.hooks.map((h) => clean(h, 300)).filter(Boolean).slice(0, 8);
    const angles = await loadAngles(rt);
    const a = angles.find((x) => (row.angle_id && x.id === row.angle_id) || (row.angle_key && x.key === row.angle_key));
    const issues = hooks.flatMap((h) => lineProblems(h, [a?.proof_id ?? 'none', 'radiology']));
    if (!hooks.length) throw new Error('Keep at least one hook.');
    if (issues.length) throw new Error(issues.slice(0, 3).map((x) => `${x.rule} ("${x.excerpt}")`).join(' · '));
    sets.push('hooks = ?'); vals.push(JSON.stringify(hooks));
  }
  if (typeof b.status === 'string') {
    if (!['draft', 'recorded', 'retired'].includes(b.status)) throw new Error('Unknown status.');
    sets.push('status = ?'); vals.push(b.status);
  }
  if (!sets.length) return;
  await rt.env.DB.prepare(`UPDATE ads_scripts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, Date.now(), id).run();
}

export async function scriptsView(rt: Runtime) {
  const [scripts, hooks] = await Promise.all([
    rt.env.DB.prepare("SELECT * FROM ads_scripts WHERE status != 'retired' ORDER BY created_at DESC LIMIT 40").all<ScriptRow>(),
    rt.env.DB.prepare("SELECT id, pack_id, style, text, angle, status, created_at FROM ads_hooks WHERE status != 'retired' ORDER BY created_at DESC LIMIT 120").all<Record<string, unknown>>(),
  ]);
  const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
  return {
    formats: SCRIPT_FORMATS,
    scripts: scripts.results.map((r) => {
      const s = { hooks: parse<string[]>(r.hooks, []), body: parse<Beat[]>(r.body, []), cta: r.cta, title: r.title };
      return { ...r, ...s, seconds: scriptSeconds(s), text: scriptText(s), bodyText: s.body.map((b) => b.say).join('\n') + `\n${s.cta}` };
    }),
    hooks: hooks.results,
  };
}
