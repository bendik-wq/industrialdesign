import Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';
import { DEFAULT_EMAIL_MODEL } from '../personalize/personalize';
import type { Sprint, Topic } from './ideas';
import { BELIEF, INK, MUTED, PAGE_BREAK, PAPER, ROW, STAGE, YELLOW, e, label, ordered, p, table, td, unquote } from './sprint-export';

/**
 * Video packs: everything Josh needs to film and present ONE video from a sprint.
 *
 * A pack is the word-for-word script (hook, intro, each beat of the logic ladder, close) written as direct
 * response copy, plus the slide for every beat, director's notes, proof, CTAs, the YouTube packaging
 * (titles, thumbnails, description, chapters, pinned comment, tags) and three Shorts cut from it.
 * It renders as a long-form Google Doc and as a presentation board on Miro (one frame per slide).
 */

export interface Beat { headline: string; script: string; slide: string[]; visual: string; transition: string }
export interface VideoPack {
  video_id: string; big_idea: string; promise: string; viewer: string; not_for: string;
  titles: string[]; thumbnails: { text: string; visual: string; emotion: string }[];
  hook: { line: string; script: string; on_screen: string };
  intro: { script: string };
  beats: Beat[];
  proof: { show: string; label: string };
  callback: string; mid_cta: string;
  close: { script: string };
  end_screen: string; description: string;
  chapters: { time: string; label: string }[];
  pinned_comment: string; tags: string[];
  shorts: { title: string; hook: string; script: string }[];
  filming: string[]; compliance: string[];
}
export interface PackRow { id: string; sprint_id: string; topic_id: string; created_at: number; source: string; pack: VideoPack; miro_url: string | null; doc_url: string | null }

const str = { type: 'string' } as const;
const arr = (items: object, description?: string) => ({ type: 'array', items, ...(description ? { description } : {}) });
const obj = (properties: Record<string, object>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const PACK_SCHEMA = obj({
  video_id: str,
  big_idea: { type: 'string', description: 'one sentence the whole video proves' },
  promise: { type: 'string', description: 'what the viewer walks away able to do' },
  viewer: { type: 'string', description: 'call-in: who it is for' },
  not_for: { type: 'string', description: 'call-out: who it is not for' },
  titles: arr(str, 'exactly 3 options, under 70 characters, title case'),
  thumbnails: arr(obj({ text: { type: 'string', description: '2–4 words that supplement the title' }, visual: str, emotion: str }), 'exactly 2'),
  hook: obj({ line: { type: 'string', description: 'first spoken sentence, 15 words max' }, script: { type: 'string', description: 'first 30–45 seconds, word for word' }, on_screen: str }),
  intro: obj({ script: { type: 'string', description: '45–60 seconds word for word: title match, call-in, call-out, why Josh (true facts only), roadmap' } }),
  beats: arr(obj({ headline: { type: 'string', description: 'slide headline, 7 words max' }, script: { type: 'string', description: 'word for word, 160–260 words' }, slide: arr(str, 'exactly 3 short on-screen lines'), visual: { type: 'string', description: 'director’s note' }, transition: { type: 'string', description: 'open loop into the next beat' } }), '5–8 beats following the logic ladder'),
  proof: obj({ show: str, label: { type: 'string', description: 'exact on-screen label, e.g. Illustrative example' } }),
  callback: str,
  mid_cta: { type: 'string', description: 'soft CTA and where it goes, e.g. "After beat 3: …"' },
  close: obj({ script: { type: 'string', description: '60–90 seconds word for word: callback, desire stack, cost of inaction, hard CTA to apply' } }),
  end_screen: str,
  description: { type: 'string', description: 'YouTube description; use {APPLY_LINK} where the application link goes' },
  chapters: arr(obj({ time: str, label: str })),
  pinned_comment: str,
  tags: arr(str),
  shorts: arr(obj({ title: str, hook: str, script: { type: 'string', description: '30–45 seconds word for word' } }), 'exactly 3'),
  filming: arr(str, '6–10 practical checklist items'),
  compliance: arr(str, 'on-screen labels and disclaimers this video needs'),
});

export const PACK_SYSTEM = `You write the complete presentation pack for ONE YouTube video for Josh Li, co-founder of G&L M&A Advisory. His viewers own profitable businesses doing $1M+ in the US and Australia and want to buy companies using commercial debt, seller finance and seller rollover. YouTube is a sales channel: the goal is qualified applications that become strategy calls, not views.

Structure (the format Josh follows):
- Packaging first. Title = mystery or "what" + specific benefit + audience filter. Thumbnail text is 2–4 words that supplement the title, never repeat it.
- Hook, first 30–45 seconds: deliver on the title at once, open a loop, no "hey guys, welcome back".
- Intro: call-in (who it is for), call-out (who it is not for), why listen to Josh (true facts only), the roadmap.
- Body: a logic ladder. Each beat is one small, obvious step and ends on an open loop into the next.
- Callback to the hook's promise. Proof on screen. A soft CTA mid-video, a hard CTA at the end (apply through the first link in the description; if it's a fit, the team books a strategy call). The end screen sends them to the next video in the binge path.
- Install the belief the topic is assigned (possible, can_solve, trust, better, now, like).

Voice: Alen Sultanic-style direct response, spoken. A sharp operator who has done it, telling a friend exactly what to do; confident, direct, slightly impatient with excuses, never preachy or hypey. Short lines. Specificity and contrast ("while most owners do X… the owners building groups do Y"). Use the two-paths or third-way frame where it fits. In the close, stack desire from surface to identity (the deal → the cash flow → the time back → becoming an owner of companies, not a job), then the cost of doing nothing.

Hard rules:
- Never invent testimonials, client names, results, deal sizes or biography. True facts you may use: Josh co-founded G&L M&A Advisory; he runs his own healthcare holding group; his best-performing video is a seller-finance masterclass. Any numbers in an example are illustrative and must be labelled "illustrative" on screen and in the script.
- Whenever you describe how a deal is funded, name seller rollover alongside debt and seller finance.
- Never call the strategy call "free".
- Where structure or tax comes up, say once, briefly, that it is not legal, tax or financial advice.
- Do not assume one country's lenders unless the topic is country-specific.
Use {APPLY_LINK} in the description where the application link goes.`;

// ───────────── storage ─────────────

const packId = (sprintId: string, topicId: string) => `${sprintId}:${topicId}`;
const parse = <T>(s: string | null, d: T): T => { try { return s ? (JSON.parse(s) as T) : d; } catch { return d; } };

export async function loadSprintTopic(rt: Runtime, sprintId: string, topicId: string) {
  const row = await rt.env.DB.prepare('SELECT data, created_at FROM yt_sprints WHERE id = ?').bind(sprintId).first<{ data: string; created_at: number }>();
  if (!row) return null;
  const sprint = parse<Sprint>(row.data, { summary: '', binge_path: [], topics: [], new_angles: [], checks: { controversial_share: '', beliefs_covered: [], gaps: [] } });
  const topic = sprint.topics.find((t) => t.id === topicId);
  if (!topic) return null;
  const index = ordered(sprint).findIndex((t) => t.id === topicId);
  const next = ordered(sprint)[index + 1] ?? null;
  return { sprint, topic, index, next, created: row.created_at };
}

export async function getPack(rt: Runtime, sprintId: string, topicId: string): Promise<PackRow | null> {
  const r = await rt.env.DB.prepare('SELECT * FROM yt_packs WHERE id = ?').bind(packId(sprintId, topicId)).first<{ id: string; sprint_id: string; topic_id: string; created_at: number; source: string; data: string; miro_url: string | null; doc_url: string | null }>();
  return r ? { ...r, pack: parse<VideoPack>(r.data, rulesPack(placeholderTopic(topicId), null)) } : null;
}

export async function listPacks(rt: Runtime, sprintId: string) {
  const { results } = await rt.env.DB.prepare('SELECT topic_id, source, miro_url, doc_url FROM yt_packs WHERE sprint_id = ?').bind(sprintId).all<{ topic_id: string; source: string; miro_url: string | null; doc_url: string | null }>();
  return results;
}

export async function savePackLinks(rt: Runtime, sprintId: string, topicId: string, links: { miro_url?: string; doc_url?: string }) {
  if (links.miro_url) await rt.env.DB.prepare('UPDATE yt_packs SET miro_url = ? WHERE id = ?').bind(links.miro_url, packId(sprintId, topicId)).run();
  if (links.doc_url) await rt.env.DB.prepare('UPDATE yt_packs SET doc_url = ? WHERE id = ?').bind(links.doc_url, packId(sprintId, topicId)).run();
}

/** The pack for a video: stored if it exists, else written now (Claude with the key, rules without) and stored. */
export async function ensurePack(rt: Runtime, sprintId: string, topicId: string, opts: { fresh?: boolean } = {}): Promise<PackRow | null> {
  if (!opts.fresh) {
    const have = await getPack(rt, sprintId, topicId);
    if (have) return have;
  }
  const ctx = await loadSprintTopic(rt, sprintId, topicId);
  if (!ctx) return null;
  let pack: VideoPack;
  let source: 'ai' | 'rules';
  if (rt.settings.ANTHROPIC_API_KEY) {
    pack = await aiPack(rt, ctx.topic, ctx.next);
    source = 'ai';
  } else {
    pack = rulesPack(ctx.topic, ctx.next);
    source = 'rules';
  }
  pack.video_id = topicId;
  const now = Date.now();
  await rt.env.DB.prepare('INSERT INTO yt_packs (id, sprint_id, topic_id, created_at, source, data) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, source = excluded.source, data = excluded.data, miro_url = NULL, doc_url = NULL')
    .bind(packId(sprintId, topicId), sprintId, topicId, now, source, JSON.stringify(pack)).run();
  return { id: packId(sprintId, topicId), sprint_id: sprintId, topic_id: topicId, created_at: now, source, pack, miro_url: null, doc_url: null };
}

async function aiPack(rt: Runtime, topic: Topic, next: Topic | null): Promise<VideoPack> {
  const client = new Anthropic({ apiKey: rt.settings.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 280_000 });
  const stream = client.beta.messages.stream({
    model: rt.settings.EMAIL_AI_MODEL || DEFAULT_EMAIL_MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: PACK_SCHEMA } },
    system: [{ type: 'text', text: PACK_SYSTEM + (rt.settings.YT_BRAND_STORY ? `\n\nMore true facts about Josh (use only these):\n${rt.settings.YT_BRAND_STORY}` : '') + (rt.settings.YT_PROOF ? `\n\nReal proof you may show:\n${rt.settings.YT_PROOF}` : '') + (rt.settings.YT_NOTES ? `\n\nStanding rules:\n${rt.settings.YT_NOTES}` : ''), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Write the pack for this video. The topic plan:\n${JSON.stringify(topic, null, 1)}\n\nThe next video in the binge path: ${next ? `${next.titles[0]} (${next.id})` : 'the VSL / application'}.` }],
  } as unknown as Anthropic.Beta.MessageCreateParamsStreaming);
  const res = await stream.finalMessage();
  if (res.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (res.stop_reason === 'max_tokens') throw new Error('The script came out too long. Try again.');
  const text = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as VideoPack;
}

const placeholderTopic = (id: string): Topic => ({ id, topic: '', evidence: '', demand_phrase: '', demand: 'direct', awareness: 'problem_aware', belief: 'possible', stage: 'MOFU', angle: 'agreeable', format: '', length_min: 12, titles: [''], thumbnails: [], hook: '', outline: { intro_callouts: '', logic_ladder: [], callbacks: '', proof: '' }, cta: { type: 'soft', line: '' }, next_video: '' });

/** No AI key: a complete, honest pack assembled from the topic plan. Josh fills the spoken detail in his own words. */
export function rulesPack(t: Topic, next: Topic | null): VideoPack {
  const ladder = t.outline.logic_ladder.length ? t.outline.logic_ladder : ['The problem', 'Why the usual way fails', 'The better way', 'How it works', 'What to do next'];
  const nextName = next ? next.titles[0] : 'the application';
  const beats: Beat[] = ladder.map((step, i) => ({
    headline: step.split(/[:,(]/)[0].trim().slice(0, 48),
    script: `${step}.\n\nHere's what most owners get wrong about this. They treat it as a detail. It isn't. It's the step that decides whether the deal works or dies on the bank's desk.\n\n[Josh: explain this in your own words, with one example from a deal you've looked at. Keep any numbers illustrative and say so.]\n\nSo the takeaway is simple: ${step.toLowerCase()}. Get this right and the next step gets easy.`,
    slide: [step, i === 0 ? 'Where most owners start' : 'The step most people skip', 'Illustrative, not advice'],
    visual: i % 2 ? 'Whiteboard: draw the step as one box with an arrow to the next.' : 'Talking head, tight frame; on-screen text of the slide headline.',
    transition: i < ladder.length - 1 ? `And once that's in place, there's one thing that decides the next part: ${ladder[i + 1].toLowerCase()}.` : 'Now let me tie this back to what I promised you at the start.',
  }));
  const minutes = t.length_min || 12;
  const at = (f: number) => { const s = Math.round(minutes * 60 * f); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  return {
    video_id: t.id, big_idea: t.topic, promise: `By the end you'll know ${t.topic.charAt(0).toLowerCase() + t.topic.slice(1)}, step by step.`,
    viewer: t.outline.intro_callouts.split('.')[0] + '.', not_for: 'If you’re pre-revenue or under $1M, start with the video on whether you’re big enough to buy.',
    titles: [...t.titles.slice(0, 2), `${t.topic} (Step by Step)`].slice(0, 3), thumbnails: t.thumbnails.slice(0, 2),
    hook: { line: unquote(t.hook).split(/(?<=[.?!])\s/)[0], script: unquote(t.hook) + '\n\nStick with me to the end, because the last step is the one nobody talks about.', on_screen: t.thumbnails[0]?.visual ?? 'Josh, tight frame' },
    intro: { script: `${t.outline.intro_callouts}\n\nI'm Josh Li. I co-founded G&L M&A Advisory, and I run my own healthcare holding group, so this is how I actually do it, not theory.\n\nHere's the plan: ${ladder.slice(0, 3).map((x) => x.toLowerCase()).join(', ')}, and then the part that ties it together.` },
    beats,
    proof: { show: t.outline.proof, label: 'Illustrative example' },
    callback: t.outline.callbacks,
    mid_cta: `After beat ${Math.min(3, beats.length)}: if you want this mapped to your own business, the application is the first link in the description.`,
    close: { script: `${t.outline.callbacks}\n\nAnd here's what this is really about. It isn't one deal. It's the cash flow that comes with it, the time you get back, and becoming the kind of owner who buys companies instead of building every one from scratch.\n\nThe cost of waiting is simple: every month you wait, someone else is calling the same sellers.\n\n${t.cta.line} Apply through the first link in the description. If it's a fit, we'll book a strategy call and look at your numbers.` },
    end_screen: `Next, watch “${nextName}”.`,
    description: `${t.titles[0]}\n${t.topic}.\n\nApply to work with us: {APPLY_LINK}\n\nInside:\n${ladder.map((x) => `• ${x}`).join('\n')}\n\nNot legal, tax or financial advice. Numbers shown are illustrative.`,
    chapters: [{ time: '0:00', label: 'The short answer' }, { time: at(0.07), label: 'Who this is for' }, ...ladder.map((x, i) => ({ time: at(0.12 + (i * 0.8) / ladder.length), label: x.split(/[:,(]/)[0].trim().slice(0, 40) })), { time: at(0.93), label: 'What to do next' }],
    pinned_comment: 'What does your business do, and what would you buy first if funding wasn’t the problem? I read every reply.',
    tags: [t.demand_phrase, 'buy a business', 'business acquisition', 'seller finance', 'seller rollover', 'no money down', 'M&A for owners', 'G&L M&A Advisory'].filter(Boolean),
    shorts: [
      { title: t.thumbnails[0]?.text ?? t.titles[0], hook: unquote(t.hook).split(/(?<=[.?!])\s/)[0], script: unquote(t.hook) },
      { title: ladder[0], hook: `Most owners get this wrong: ${ladder[0].toLowerCase()}.`, script: beats[0]?.script.split('\n\n').slice(0, 2).join(' ') ?? '' },
      { title: 'The step nobody talks about', hook: `The step nobody talks about: ${ladder[ladder.length - 1].toLowerCase()}.`, script: beats[beats.length - 1]?.script.split('\n\n').slice(0, 2).join(' ') ?? '' },
    ],
    filming: [`Format: ${t.format}`, `Target length: ${minutes} minutes`, 'Whiteboard with the logic ladder drawn before you roll', 'Both thumbnail shots taken on set', 'Lower-third: Josh Li · Co-Founder, G&L M&A Advisory', 'Label every number “Illustrative”', 'End screen pointing to the next video'],
    compliance: ['“Illustrative example” on any numbers', 'Not legal, tax or financial advice', 'No client results or testimonials unless approved and real'],
  };
}

// ───────────── Google Doc ─────────────

const paras = (s: string, o: Parameters<typeof p>[1] = {}) => s.split(/\n{2,}|\n/).filter((x) => x.trim()).map((x) => p(e(x), { size: 12, mb: 8, ...o })).join('');
const h1 = (t: string) => `<h1 style="font-size:24pt;color:${INK};margin:0 0 6pt 0;">${t}</h1>`;
const h2 = (t: string, color: string) => `<h2 style="font-size:17pt;color:${color};margin:18pt 0 6pt 0;">${t}</h2>`;
const kicker = (t: string, color: string) => p(e(t.toUpperCase()), { size: 9, color, bold: true, mt: 0, mb: 2 });

/** The long-form script and presentation brief for one video, as Google-Docs-safe HTML. */
export function packDocHtml(pack: VideoPack, topic: Topic, o: { index: number; nextTitle?: string | null; brand?: string; miroUrl?: string | null }) {
  const st = STAGE[topic.stage] ?? STAGE.MOFU;
  const n = String(o.index + 1).padStart(2, '0');
  const out: string[] = [];
  // Cover
  out.push(table(`<tr>${td(
    p(`${e((o.brand || 'G&L M&A Advisory').toUpperCase())}  ·  VIDEO ${n}  ·  ${e(topic.stage)}  ·  ${e(topic.length_min)} MIN`, { size: 9, color: YELLOW, bold: true, mb: 20 }) +
    p(e(pack.titles[0] ?? topic.titles[0]), { size: 28, color: '#FFFFFF', bold: true, mb: 10 }) +
    p(e(pack.promise), { size: 14, color: '#D6DBE6', mb: 20 }) +
    p(`Script, slides and packaging for Josh Li${o.miroUrl ? `  ·  <a href="${e(o.miroUrl)}" style="color:${YELLOW};">Presentation board in Miro</a>` : ''}`, { size: 10, color: '#D6DBE6' }),
    { bg: INK, pad: 40 })}</tr>`));
  out.push(table(`<tr>${td('', { bg: st.dark, pad: 3 })}</tr>`));
  out.push(p('', { mb: 8 }));
  // At a glance
  const glance: [string, string][] = [['The big idea', pack.big_idea], ['Who it’s for', pack.viewer], ['Who it’s not for', pack.not_for], ['Belief it installs', BELIEF[topic.belief] ?? topic.belief], ['Format', topic.format], ['Next video', o.nextTitle || pack.end_screen]];
  out.push(table(glance.map(([k, v], i) => `<tr>${td(p(e(k), { size: 9, color: st.dark, bold: true }), { bg: i % 2 ? '#FFFFFF' : ROW, pad: 9, w: 24 })}${td(p(e(v), { size: 11 }), { bg: i % 2 ? '#FFFFFF' : ROW, pad: 9, w: 76 })}</tr>`).join(''), [24, 76]));

  // Packaging
  out.push(h2('1 · Packaging', INK));
  out.push(label('Titles to test', st.dark));
  out.push(table(pack.titles.slice(0, 3).map((ti, k) => `<tr>${td(p('ABC'[k], { size: 12, color: st.dark, bold: true, center: true }), { bg: PAPER, pad: 10, w: 7 })}${td(p(e(ti), { size: 13, bold: true }), { bg: PAPER, pad: 10, w: 93 })}</tr>`).join(''), [7, 93]));
  out.push(label('Thumbnails', st.dark));
  const th = pack.thumbnails.slice(0, 2);
  out.push(table(`<tr>${th.map((x) => td(p(e(unquote(x.text)), { size: 22, color: YELLOW, bold: true, center: true, mt: 22, mb: 22 }), { bg: INK, pad: 10, w: 50, border: 6 })).join('')}</tr><tr>${th.map((x) => td(p(`${e(x.visual)} · <i>${e(x.emotion)}</i>`, { size: 9, color: MUTED }), { pad: 6, w: 50 })).join('')}</tr>`, [50, 50]));

  // The script
  out.push(PAGE_BREAK);
  out.push(kicker('2 · The script', st.dark));
  out.push(h1('Word for word'));
  out.push(p('Read it aloud once before you film. Bold lines are the ones that must land exactly as written.', { size: 10, color: MUTED, mb: 12 }));
  out.push(label('The hook · first 30–45 seconds', st.dark));
  out.push(table(`<tr>${td(p(`“${e(unquote(pack.hook.line))}”`, { size: 18, bold: true, mt: 0, mb: 10 }) + paras(pack.hook.script, { size: 12 }) + p(`On screen: ${e(pack.hook.on_screen)}`, { size: 9, color: MUTED, italic: true, mt: 6, mb: 0 }), { bg: st.faint, pad: 18, extra: `border-left:5px solid ${st.dark};` })}</tr>`));
  out.push(label('The intro', st.dark));
  out.push(paras(pack.intro.script));

  pack.beats.forEach((b, i) => {
    out.push(label(`Beat ${i + 1} of ${pack.beats.length}`, st.dark));
    out.push(p(e(b.headline), { size: 16, bold: true, mt: 0, mb: 8 }));
    // The slide, drawn as a 16:9 card
    out.push(table(`<tr>${td(p(`${String(i + 1).padStart(2, '0')}`, { size: 9, color: YELLOW, bold: true, mt: 0, mb: 8 }) + p(e(b.headline), { size: 20, color: '#FFFFFF', bold: true, mb: 12 }) + b.slide.slice(0, 3).map((x) => p(`—  ${e(x)}`, { size: 12, color: '#D6DBE6', mt: 0, mb: 4 })).join(''), { bg: INK, pad: 26 })}</tr>`));
    out.push(p('', { mb: 4 }));
    out.push(paras(b.script));
    out.push(table(`<tr>${td(p(`<b>Director:</b> ${e(b.visual)}`, { size: 10, color: MUTED, mt: 0, mb: 3 }) + p(`<b>Into the next beat:</b> <i>${e(b.transition)}</i>`, { size: 10, color: MUTED, mt: 0, mb: 0 }), { bg: PAPER, pad: 10 })}</tr>`));
  });

  out.push(label('Proof on screen', st.dark));
  out.push(p(`${e(pack.proof.show)}  <b>Label:</b> “${e(pack.proof.label)}”`, { size: 11 }));
  out.push(label('Mid-video CTA', st.dark));
  out.push(p(e(pack.mid_cta), { size: 11 }));
  out.push(label('The close · 60–90 seconds', st.dark));
  out.push(table(`<tr>${td(p(`<b>Callback:</b> ${e(pack.callback)}`, { size: 12, color: '#FFFFFF', mt: 0, mb: 10 }) + paras(pack.close.script, { size: 12, color: '#FFFFFF' }) + p(`<b>End screen:</b> ${e(pack.end_screen)}`, { size: 11, color: YELLOW, mt: 6, mb: 0 }), { bg: INK, pad: 22 })}</tr>`));

  // YouTube packaging
  out.push(PAGE_BREAK);
  out.push(kicker('3 · Publishing', st.dark));
  out.push(h1('Everything for the upload'));
  out.push(label('Description', st.dark));
  out.push(table(`<tr>${td(paras(pack.description, { size: 11, mb: 4 }), { bg: ROW, pad: 14 })}</tr>`));
  out.push(label('Chapters', st.dark));
  out.push(table(pack.chapters.map((c, i) => `<tr>${td(p(e(c.time), { size: 11, bold: true, color: st.dark }), { bg: i % 2 ? '#FFFFFF' : ROW, pad: 6, w: 14 })}${td(p(e(c.label), { size: 11 }), { bg: i % 2 ? '#FFFFFF' : ROW, pad: 6, w: 86 })}</tr>`).join(''), [14, 86]));
  out.push(label('Pinned comment', st.dark));
  out.push(p(e(pack.pinned_comment), { size: 11 }));
  out.push(label('Tags', st.dark));
  out.push(p(e(pack.tags.join(', ')), { size: 10, color: MUTED }));

  out.push(label('Three Shorts to cut from it', st.dark));
  out.push(table(`<tr>${pack.shorts.slice(0, 3).map((s) => td(p(e(s.title), { size: 12, bold: true, mb: 4 }) + p(`“${e(s.hook)}”`, { size: 10, italic: true, color: st.dark, mb: 6 }) + paras(s.script, { size: 10 }), { bg: st.faint, pad: 14, w: 33, border: 5 })).join('')}</tr>`, [33, 34, 33]));

  out.push(label('Filming checklist', st.dark));
  out.push(table(pack.filming.map((f) => `<tr>${td(p('☐', { size: 12, color: st.dark, center: true }), { pad: 5, w: 6 })}${td(p(e(f), { size: 11 }), { pad: 5, w: 94 })}</tr>`).join(''), [6, 94]));
  out.push(label('On-screen labels & disclaimers', st.dark));
  out.push(table(`<tr>${td(pack.compliance.map((c) => p(`•  ${e(c)}`, { size: 10, mt: 0, mb: 3 })).join(''), { bg: STAGE.MOFU.faint, pad: 12 })}</tr>`));
  return out.join('\n');
}

// ───────────── Miro: the presentation board ─────────────

type Pos = { x: number; y: number };
type Item = { type: 'shape' | 'text' | 'sticky_note'; data: Record<string, unknown>; style?: Record<string, unknown>; position: Pos & { origin?: 'center' }; geometry?: { width?: number; height?: number }; frame: number };
interface Frame { title: string; x: number; y: number; w: number; h: number; fill: string }

const SW = 1920, SH = 1080, GAP = 200;

/** Pure layout: frames (slides) and the items inside each, positioned relative to the frame's top-left. */
export function packMiroLayout(pack: VideoPack, topic: Topic, index: number) {
  const st = STAGE[topic.stage] ?? STAGE.MOFU;
  const n = String(index + 1).padStart(2, '0');
  const frames: Frame[] = [];
  const items: Item[] = [];
  const frame = (title: string, col: number, row: number, fill = '#FFFFFF', h = SH) => frames.push({ title, x: col * (SW + GAP), y: row * (SH + GAP + 520), w: SW, h, fill }) - 1;
  const text = (f: number, x: number, y: number, w: number, html: string, size: number, color = INK) =>
    items.push({ type: 'text', frame: f, data: { content: html }, style: { fontSize: String(size), color, fontFamily: 'open_sans', textAlign: 'left' }, position: { x: x + w / 2, y }, geometry: { width: w } });
  const box = (f: number, x: number, y: number, w: number, h: number, html: string, s: Record<string, unknown>) =>
    items.push({ type: 'shape', frame: f, data: { shape: 'round_rectangle', content: html }, style: { borderOpacity: '0', fontFamily: 'open_sans', textAlign: 'left', textAlignVertical: 'top', ...s }, position: { x: x + w / 2, y: y + h / 2 }, geometry: { width: w, height: h } });
  const eyebrow = (f: number, t: string, color = st.dark) => text(f, 120, 130, 1400, `<p><strong>${e(t)}</strong></p>`, 22, color);
  const P = (s: string) => s.split(/\n+/).filter(Boolean).map((x) => `<p>${e(x)}</p>`).join('');

  // Row 0: cover · packaging · hook · intro
  const cover = frame(`${n} · Cover`, 0, 0, INK);
  text(cover, 120, 150, 1600, `<p><strong>VIDEO ${n}  ·  ${e(topic.stage)}  ·  ${e(topic.length_min)} MIN</strong></p>`, 24, YELLOW);
  text(cover, 120, 330, 1650, `<p><strong>${e(pack.titles[0] ?? topic.titles[0])}</strong></p>`, 84, '#FFFFFF');
  text(cover, 120, 640, 1500, `<p>${e(pack.promise)}</p>`, 34, '#C9D1E3');
  box(cover, 120, 820, 1680, 150, `<p><strong>The big idea</strong></p><p>${e(pack.big_idea)}</p>`, { fillColor: '#2A3757', color: '#FFFFFF', fontSize: '24', textAlignVertical: 'middle' });

  const pk = frame(`${n} · Packaging`, 1, 0);
  eyebrow(pk, 'PACKAGING · TITLES TO TEST');
  pack.titles.slice(0, 3).forEach((ti, k) => box(pk, 120, 200 + k * 120, 820, 100, `<p><strong>${'ABC'[k]}</strong>   ${e(ti)}</p>`, { fillColor: PAPER, color: INK, fontSize: '26', textAlignVertical: 'middle' }));
  text(pk, 1020, 130, 760, '<p><strong>THUMBNAILS</strong></p>', 22, st.dark);
  pack.thumbnails.slice(0, 2).forEach((x, k) => {
    box(pk, 1020, 200 + k * 420, 680, 340, `<p><strong>${e(unquote(x.text))}</strong></p>`, { fillColor: INK, color: YELLOW, fontSize: '64', textAlign: 'center', textAlignVertical: 'middle' });
    text(pk, 1020, 200 + k * 420 + 370, 680, `<p>${e(x.visual)} · <em>${e(x.emotion)}</em></p>`, 18, MUTED);
  });
  box(pk, 120, 600, 820, 380, `<p><strong>Who it’s for</strong></p><p>${e(pack.viewer)}</p><p></p><p><strong>Not for</strong></p><p>${e(pack.not_for)}</p>`, { fillColor: st.faint, color: INK, fontSize: '24' });

  const hk = frame(`${n} · The hook`, 2, 0, st.faint);
  eyebrow(hk, 'THE HOOK · FIRST 30–45 SECONDS');
  text(hk, 120, 330, 1680, `<p><strong>“${e(unquote(pack.hook.line))}”</strong></p>`, 72, INK);
  text(hk, 120, 700, 1680, P(pack.hook.script), 26, INK);
  text(hk, 120, 1010, 1680, `<p><em>On screen: ${e(pack.hook.on_screen)}</em></p>`, 18, MUTED);

  const it = frame(`${n} · The intro`, 3, 0);
  eyebrow(it, 'THE INTRO');
  text(it, 120, 520, 1680, P(pack.intro.script), 30, INK);

  // Row 1: one slide per beat, script underneath
  pack.beats.forEach((b, i) => {
    const f = frame(`${n} · Beat ${i + 1}: ${b.headline}`.slice(0, 120), i, 1, i % 2 ? '#FFFFFF' : PAPER);
    text(f, 120, 140, 1200, `<p><strong>${String(i + 1).padStart(2, '0')}  /  ${String(pack.beats.length).padStart(2, '0')}</strong></p>`, 24, st.dark);
    text(f, 120, 330, 1680, `<p><strong>${e(b.headline)}</strong></p>`, 96, INK);
    b.slide.slice(0, 3).forEach((x, k) => box(f, 120 + k * 570, 560, 540, 380, `<p><strong>${k + 1}</strong></p><p>${e(x)}</p>`, { fillColor: k === 0 ? st.dark : '#FFFFFF', color: k === 0 ? '#FFFFFF' : INK, fontSize: '34', borderOpacity: k === 0 ? '0' : '1', borderColor: '#E3E1D8', borderWidth: '2' }));
    text(f, 120, 1010, 1680, `<p><em>Director: ${e(b.visual)}</em></p>`, 18, MUTED);
  });

  // Row 2: proof · close · publishing · shorts
  const pr = frame(`${n} · Proof & mid-video CTA`, 0, 2);
  eyebrow(pr, 'PROOF ON SCREEN');
  text(pr, 120, 330, 1680, `<p><strong>${e(pack.proof.show)}</strong></p>`, 48, INK);
  box(pr, 120, 600, 700, 90, `<p><strong>Label: “${e(pack.proof.label)}”</strong></p>`, { fillColor: STAGE.MOFU.faint, color: STAGE.MOFU.dark, fontSize: '24', textAlignVertical: 'middle' });
  box(pr, 120, 760, 1680, 220, `<p><strong>Mid-video CTA</strong></p><p>${e(pack.mid_cta)}</p>`, { fillColor: st.faint, color: INK, fontSize: '26' });

  const cl = frame(`${n} · The close`, 1, 2, INK);
  eyebrow(cl, 'THE CLOSE · 60–90 SECONDS', YELLOW);
  text(cl, 120, 300, 1680, `<p><strong>${e(pack.callback)}</strong></p>`, 52, '#FFFFFF');
  text(cl, 120, 680, 1680, P(pack.close.script), 24, '#C9D1E3');
  text(cl, 120, 1010, 1680, `<p><strong>End screen → ${e(pack.end_screen)}</strong></p>`, 22, YELLOW);

  const pub = frame(`${n} · Publishing`, 2, 2);
  eyebrow(pub, 'PUBLISHING');
  box(pub, 120, 200, 1000, 800, `<p><strong>Description</strong></p>${P(pack.description)}`, { fillColor: ROW, color: INK, fontSize: '18' });
  box(pub, 1180, 200, 620, 520, `<p><strong>Chapters</strong></p>${pack.chapters.map((c) => `<p>${e(c.time)}  ${e(c.label)}</p>`).join('')}`, { fillColor: st.faint, color: INK, fontSize: '18' });
  box(pub, 1180, 760, 620, 240, `<p><strong>Pinned comment</strong></p><p>${e(pack.pinned_comment)}</p>`, { fillColor: PAPER, color: INK, fontSize: '18' });

  const sh = frame(`${n} · Shorts & filming`, 3, 2);
  eyebrow(sh, 'THREE SHORTS · FILMING CHECKLIST');
  pack.shorts.slice(0, 3).forEach((s, k) => items.push({ type: 'sticky_note', frame: sh, data: { content: `<p><strong>${e(s.title)}</strong></p><p><em>“${e(s.hook)}”</em></p><p>${e(s.script)}</p>`, shape: 'rectangle' }, style: { fillColor: 'light_yellow', textAlign: 'left', textAlignVertical: 'top' }, position: { x: 120 + k * 380 + 175, y: 420 }, geometry: { width: 350 } }));
  box(sh, 1300, 200, 500, 800, `<p><strong>Filming checklist</strong></p>${pack.filming.map((f) => `<p>☐ ${e(f)}</p>`).join('')}<p></p><p><strong>Labels</strong></p>${pack.compliance.map((c) => `<p>• ${e(c)}</p>`).join('')}`, { fillColor: PAPER, color: INK, fontSize: '18' });

  return { frames, items };
}

/** Lay one video out on a new Miro board. ~frames + items/20 + 1 requests. */
export async function buildPackBoard(token: string, pack: VideoPack, topic: Topic, index: number, name: string, fetcher: typeof fetch = fetch) {
  const api = async (path: string, body: unknown) => {
    const r = await fetcher(`https://api.miro.com/v2${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`Miro ${r.status}: ${String(j.message ?? j.code ?? 'request failed')}`);
    return j;
  };
  const board = await api('/boards', { name: name.slice(0, 60), description: `Video ${index + 1}: script, slides and packaging, from Funnel HQ` });
  const id = encodeURIComponent(String(board.id));
  const { frames, items } = packMiroLayout(pack, topic, index);
  const frameIds: string[] = [];
  for (const f of frames) {
    const r = await api(`/boards/${id}/frames`, { data: { title: f.title, format: 'custom', type: 'freeform', showContent: true }, style: { fillColor: f.fill }, position: { x: f.x + f.w / 2, y: f.y + f.h / 2 }, geometry: { width: f.w, height: f.h } });
    frameIds.push(String(r.id));
  }
  const payload = items.map(({ frame, ...it }) => ({ ...it, parent: { id: frameIds[frame] } }));
  for (let i = 0; i < payload.length; i += 20) await api(`/boards/${id}/items/bulk`, payload.slice(i, i + 20));
  return String(board.viewLink ?? `https://miro.com/app/board/${String(board.id)}/`);
}

// ───────────── Google Drive (OAuth, drive.file scope) ─────────────

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const googleRedirect = (origin: string) => `${origin}/oauth/google/callback`;

export function googleAuthUrl(clientId: string, origin: string, state: string) {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: googleRedirect(origin), response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export async function googleExchange(clientId: string, secret: string, origin: string, code: string, fetcher: typeof fetch = fetch) {
  const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: secret, redirect_uri: googleRedirect(origin), grant_type: 'authorization_code' }) });
  const j = (await r.json()) as { refresh_token?: string; error_description?: string; error?: string };
  if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'Google did not return a refresh token');
  return j.refresh_token;
}

async function googleAccess(rt: Runtime, fetcher: typeof fetch) {
  const s = rt.settings;
  const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: s.GOOGLE_CLIENT_ID, client_secret: s.GOOGLE_CLIENT_SECRET, refresh_token: s.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' }) });
  const j = (await r.json()) as { access_token?: string; error_description?: string; error?: string };
  if (!r.ok || !j.access_token) throw new Error(`Google: ${j.error_description || j.error || 'could not refresh access'}. Reconnect Google under Integrations.`);
  return j.access_token;
}

export const googleReady = (rt: Runtime) => Boolean(rt.settings.GOOGLE_CLIENT_ID && rt.settings.GOOGLE_CLIENT_SECRET && rt.settings.GOOGLE_REFRESH_TOKEN);

/** Upload HTML as a new Google Doc (Drive converts it, keeping tables, colours and sizes). Returns the doc link. */
export async function createGoogleDoc(rt: Runtime, name: string, bodyHtml: string, fetcher: typeof fetch = fetch) {
  const token = await googleAccess(rt, fetcher);
  const boundary = `fhq${crypto.randomUUID().replace(/-/g, '')}`;
  const meta: Record<string, unknown> = { name, mimeType: 'application/vnd.google-apps.document' };
  if (rt.settings.GOOGLE_DRIVE_FOLDER_ID) meta.parents = [rt.settings.GOOGLE_DRIVE_FOLDER_ID];
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n<html><head><meta charset="utf-8"></head><body>${bodyHtml}</body></html>\r\n--${boundary}--`;
  const r = await fetcher('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
  const j = (await r.json()) as { id?: string; webViewLink?: string; error?: { message?: string } };
  if (!r.ok || !j.id) throw new Error(`Google Drive: ${j.error?.message ?? r.status}`);
  return j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit`;
}
