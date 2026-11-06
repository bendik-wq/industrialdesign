import type { Context } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { CONSENT_COPY, CONSENT_LEGEND } from '../integrations/consent-gate';
import { formatCallTime } from '../integrations/email';
import { turnstileSiteKey } from '../infra/turnstile';
import { sessionSlot } from '../audiences/enrich';
import { ARCHETYPES, GAPS, type GapId, QUESTIONS, QUIZ_COPY, RESULT_COPY, type ArchetypeId } from './content';
import { type Answers, type Teaser, money, readinessScore, scoreQuiz, shortMoney, teaser } from './scoring';
import { type QuizRow, getQuiz, markResultViewed, parseAnswersJson, parseGaps, quizTarget } from './quiz';

/**
 * The quiz's two pages, built on the house render() (server page view, attribution, Pixel/PostHog/Clarity, Turnstile):
 *  - /quiz: the intro, one question per screen, then the email gate (all server-rendered; quiz.js moves between them);
 *  - /quiz/r/:token: the result, ending in one action: "Save my seat".
 * Funnel HQ previews: /quiz?hq_preview=1&hq_step=3|gate and /quiz/r/preview?hq_preview=1 (a made-up result).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
export const JOSH_PHOTO = '/assets/media/josh-li.jpg';

const host = () => `<div class="qz-host"><img src="${JOSH_PHOTO}" alt="Josh Li" width="48" height="48" loading="lazy"><p><strong>${esc(QUIZ_COPY.host)}</strong><span>${esc(QUIZ_COPY.hostLine)}</span></p></div>`;

/** Every screen of /quiz, in order: intro, the questions, the gate. */
export function quizScreens(o: { turnstile: boolean }) {
  const intro = `<section class="qz-screen qz-intro" data-screen="intro" aria-labelledby="qz-h-intro">
    <p class="qz-eyebrow">${esc(QUIZ_COPY.eyebrow)}</p>
    <h1 class="qz-display" id="qz-h-intro">${esc(QUIZ_COPY.heading)}</h1>
    <p class="qz-lede">${esc(QUIZ_COPY.lede)}</p>
    <button type="button" class="qz-btn" data-qz-start>${esc(QUIZ_COPY.start)} ${ARROW}</button>
    ${host()}
    <p class="qz-proof">${esc(QUIZ_COPY.proof)}</p>
  </section>`;
  const questions = QUESTIONS.map((q, i) => `<section class="qz-screen qz-q" data-screen="q" data-q="${q.id}" data-i="${i}" aria-labelledby="qz-h-${q.id}" hidden>
    <h2 class="qz-title" id="qz-h-${q.id}" tabindex="-1">${esc(q.title)}</h2>
    ${q.sub ? `<p class="qz-sub">${esc(q.sub)}</p>` : ''}
    <div class="qz-opts" role="radiogroup" aria-labelledby="qz-h-${q.id}">
      ${q.options.map((op, k) => `<button type="button" class="qz-opt" role="radio" aria-checked="false" data-v="${esc(op.value)}"><span class="qz-opt-l">${esc(op.label)}</span><span class="qz-opt-k" aria-hidden="true">${k + 1}</span><span class="qz-dot" aria-hidden="true"></span></button>`).join('')}
    </div>
    <div class="qz-nav"><button type="button" class="qz-back" data-qz-back>${CHEV}${esc(QUIZ_COPY.back)}</button></div>
  </section>`).join('');
  const gate = `<section class="qz-screen qz-gate" data-screen="gate" aria-labelledby="qz-h-gate" hidden>
    <p class="qz-eyebrow">${esc(QUIZ_COPY.gateEyebrow)}</p>
    <h2 class="qz-title" id="qz-h-gate" tabindex="-1">${esc(QUIZ_COPY.gateHeading)}</h2>
    <p class="qz-sub">${esc(QUIZ_COPY.gateLede)}</p>
    <form class="qz-form" data-qz-gate novalidate autocomplete="on">
      <p class="qz-error" role="alert" data-qz-error hidden></p>
      <div class="qz-row">
        <label class="qz-field"><span>${esc(QUIZ_COPY.firstName)}</span><input name="first_name" autocomplete="given-name" required></label>
        <label class="qz-field"><span>${esc(QUIZ_COPY.email)}</span><input name="email" type="email" autocomplete="email" inputmode="email" required></label>
      </div>
      <label class="qz-field"><span>${esc(QUIZ_COPY.phone)} <em>${esc(QUIZ_COPY.optional)}</em></span><input name="phone" type="tel" autocomplete="tel" inputmode="tel"></label>
      <fieldset class="qz-consent"><legend>${esc(CONSENT_LEGEND)}</legend>
        <label class="qz-check"><input type="checkbox" name="call_consent"><span>${esc(CONSENT_COPY.call)}</span></label>
        <label class="qz-check"><input type="checkbox" name="sms_consent"><span>${esc(CONSENT_COPY.sms)}</span></label>
      </fieldset>
      ${o.turnstile ? '<div class="qz-ts" data-turnstile></div>' : ''}
      <button type="submit" class="qz-btn qz-btn-wide">${esc(QUIZ_COPY.gateButton)} ${ARROW}</button>
      <p class="qz-note">${esc(QUIZ_COPY.gateNote)} <a href="/privacy">${esc(QUIZ_COPY.privacy)}</a>.</p>
    </form>
    <div class="qz-nav"><button type="button" class="qz-back" data-qz-back>${CHEV}${esc(QUIZ_COPY.back)}</button></div>
  </section>`;
  return intro + questions + gate;
}

export async function quizPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const preview = v.botReason === 'admin-preview';
  const step = preview ? c.req.query('hq_step') ?? null : null;
  const ts = turnstileSiteKey(rt.settings);
  return render(c, '/quiz.html', {
    title: QUIZ_COPY.title,
    blocks: { quiz: quizScreens({ turnstile: Boolean(ts) }) },
    trackPath: '/quiz',
    config: { quiz: { total: QUESTIONS.length, ids: QUESTIONS.map((q) => q.id), step }, turnstileSiteKey: ts },
    seo: { title: QUIZ_COPY.seoTitle, description: QUIZ_COPY.seoDescription, path: '/quiz', index: false },
  });
}

// ───────────── the result ─────────────

const FACTOR_LABEL: Record<string, string> = {
  revenue: 'Revenue', team: 'A team that runs it', margin: 'Profit margin', deals: 'Deals done', funding: 'How you would fund it', debt: 'Comfort with debt', timeline: 'Timeline', goal: 'What you want next',
};
const pct = (m: number) => `${Math.round(m * 100)}%`;

/** The teaser in words (illustrative, labelled). */
export function teaserLines(t: Teaser) {
  return [
    `Take a target with numbers like yours: about ${money(t.revenue)} in revenue at a ${pct(t.margin)} margin${t.assumedMargin ? ' (an assumed margin)' : ''} is about ${money(t.profit)} profit a year.`,
    `Priced at 3 times profit (${money(t.price)}) and funded 70% commercial debt, 20% seller finance and 10% seller rollover, the debt costs about ${money(t.service)} a year.`,
    `The profit covers that ${t.dscr.toFixed(1)} times, ${t.clears ? 'above' : 'below'} the 1.5x test. At exactly 1.5x, the same profit carries a price of about ${money(t.maxPrice)}.`,
  ];
}

function scoreBlock(score: number, a: Answers) {
  const { factors } = readinessScore(a);
  const rows = factors.map((f) => `<li><span class="qz-f-l">${esc(FACTOR_LABEL[f.id] ?? f.id)}</span><span class="qz-f-bar" aria-hidden="true"><i style="width:${Math.round((f.points / f.max) * 100)}%"></i></span><span class="qz-f-n">${f.points} / ${f.max}</span></li>`).join('');
  return `<div class="qz-score" role="img" aria-label="${esc(`${RESULT_COPY.scoreLabel}: ${score} ${RESULT_COPY.outOf}`)}">
      <p class="qz-score-l">${esc(RESULT_COPY.scoreLabel)}</p>
      <p class="qz-score-n"><span>${score}</span><small>${esc(RESULT_COPY.outOf)}</small></p>
      <div class="qz-meter" aria-hidden="true"><i style="width:${score}%"></i></div>
      <div class="qz-meter-scale" aria-hidden="true"><span>0</span><span>50</span><span>100</span></div>
    </div>
    <details class="qz-how"><summary>${esc(RESULT_COPY.how)}</summary><p>${esc(RESULT_COPY.howText)}</p><ul class="qz-factors">${rows}</ul></details>`;
}

function teaserBlock(t: Teaser | null) {
  if (!t) return '';
  const cap = 3; // the coverage scale runs 0 to 3x
  const at = (x: number) => `${Math.min(100, (x / cap) * 100).toFixed(1)}%`;
  return `<section class="qz-sec qz-teaser" aria-labelledby="qz-h-teaser">
      <div class="qz-sec-h"><h2 id="qz-h-teaser">${esc(RESULT_COPY.teaserHeading)}</h2><span class="qz-tag">${esc(RESULT_COPY.teaserLabel)}</span></div>
      <dl class="qz-stats">
        <div><dt>Profit a year</dt><dd>${esc(shortMoney(t.profit))}</dd></div>
        <div><dt>Debt a year</dt><dd>${esc(shortMoney(t.service))}</dd></div>
        <div><dt>Coverage</dt><dd>${esc(t.dscr.toFixed(1))}x</dd></div>
      </dl>
      <div class="qz-cover" aria-hidden="true"><div class="qz-cover-track"><i style="width:${at(t.dscr)}"></i><b style="left:${at(1.5)}"><span>1.5x test</span></b></div></div>
      ${teaserLines(t).map((l) => `<p>${esc(l)}</p>`).join('')}
      <p class="qz-fine">${esc(RESULT_COPY.teaserNote)}</p>
    </section>`;
}

interface ActionView { target: 'webinar' | 'live'; options: { value: string; label: string; slot: string }[]; liveTitle?: string | null; registeredHref?: string | null; under1m: boolean }

function actionBlock(a: ActionView, title: string) {
  const btn = `<button type="submit" class="qz-gold">${esc(RESULT_COPY.button)} ${ARROW}</button>`;
  if (a.registeredHref) {
    return `<section class="qz-action" id="seat" aria-labelledby="qz-h-act"><h2 id="qz-h-act">${esc(RESULT_COPY.registered)}</h2><p><a class="qz-link" href="${esc(a.registeredHref)}">${esc(RESULT_COPY.openRoom)}</a></p></section>`;
  }
  const opts = a.options.length
    ? (a.target === 'webinar'
      ? `<fieldset class="qz-times"><legend>${esc(RESULT_COPY.pickTime)}</legend>${a.options.map((o, i) => `<label class="qz-time"><input type="radio" name="session_id" value="${esc(o.value)}" data-slot="${esc(o.slot)}"${i === 0 ? ' checked' : ''}><span>${esc(o.label)}</span></label>`).join('')}</fieldset>`
      : `<p class="qz-when"><strong>${esc(a.liveTitle ?? title)}</strong><span>${esc(a.options[0].label)}</span></p><input type="hidden" name="event_id" value="${esc(a.options[0].value)}">`)
    : '';
  return `<section class="qz-action" id="seat" aria-labelledby="qz-h-act">
      <h2 id="qz-h-act">${esc(RESULT_COPY.actionHeading)}</h2>
      <p class="qz-act-lede">${esc(a.target === 'live' ? RESULT_COPY.liveLede : RESULT_COPY.actionLede)}</p>
      ${a.under1m ? `<p class="qz-act-note">${esc(RESULT_COPY.under1m)}</p>` : ''}
      ${a.options.length ? `<form data-qz-seat novalidate><p class="qz-error" role="alert" data-qz-error hidden></p>${opts}${btn}<p class="qz-one">${esc(RESULT_COPY.oneClick)}</p></form>` : `<p class="qz-act-note">${esc(RESULT_COPY.none)}</p>`}
    </section>`;
}

/** The whole result (pure: tested on its own). */
export function resultHtml(o: { firstName: string | null; score: number; archetype: ArchetypeId; gaps: GapId[]; answers: Answers; action: ActionView; title: string }) {
  const a = ARCHETYPES[o.archetype];
  const gaps = o.gaps.map((g, i) => `<li><span class="qz-gap-n">${String(i + 1).padStart(2, '0')}</span><div><h3>${esc(GAPS[g].title)}</h3><p>${esc(GAPS[g].fix)}</p></div></li>`).join('');
  return `<article class="qz-result">
    <header class="qz-r-head">
      <p class="qz-eyebrow">${esc(o.firstName ? `${RESULT_COPY.eyebrow}, ${o.firstName}` : RESULT_COPY.eyebrow)}</p>
      <h1 class="qz-display">${esc(a.name).replace(/(\S+-\S+)/, '<span class="qz-nw">$1</span>')}</h1>
      <p class="qz-lede">${esc(a.line)}</p>
    </header>
    ${scoreBlock(o.score, o.answers)}
    <section class="qz-sec" aria-labelledby="qz-h-means"><h2 id="qz-h-means">${esc(RESULT_COPY.meansHeading)}</h2>${a.means.map((p) => `<p>${esc(p)}</p>`).join('')}</section>
    <section class="qz-sec" aria-labelledby="qz-h-gaps"><h2 id="qz-h-gaps">${esc(RESULT_COPY.gapsHeading)}</h2><ol class="qz-gaps">${gaps}</ol></section>
    ${teaserBlock(teaser(o.answers))}
    ${actionBlock(o.action, o.title)}
    <footer class="qz-r-foot">${host()}<p class="qz-fine">${esc(RESULT_COPY.disclaimer)}</p></footer>
  </article>`;
}

/** A made-up result for Funnel HQ previews (never saved). */
const PREVIEW_ANSWERS: Answers = { revenue: '3_10m', industry: 'healthcare', goal: 'competitor', margin: '10_20', debt: 'open', funding: 'bank', deals: '0', timeline: '6_12', blocker: 'funding', team: 'partly' };

async function actionFor(c: Context<AppEnv>, row: QuizRow | null, band: string | null): Promise<ActionView> {
  const rt = runtimeFrom(c);
  const target = quizTarget(rt.settings);
  const tz = c.get('visitor').geo.timezone ?? rt.settings.SALES_TIMEZONE ?? null;
  const slotTz = rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  const under1m = band === '<1m';
  let registeredHref: string | null = null;
  if (row?.registered_at && row.reg_id) {
    if (row.target === 'live') {
      const r = await rt.env.DB.prepare('SELECT token FROM live_webinar_regs WHERE id = ?').bind(row.reg_id).first<{ token: string }>();
      if (r) registeredHref = (await import('../live/events')).liveRoomUrl(rt, r.token);
    } else {
      const r = await rt.env.DB.prepare('SELECT token FROM webinar_registrations WHERE id = ?').bind(row.reg_id).first<{ token: string }>();
      if (r) registeredHref = `${(await import('../webinar/webinar')).webinarBase(rt)}/registered/${r.token}`;
    }
  }
  if (target === 'live') {
    const ev = await (await import('../live/events')).nextEvent(rt).catch(() => null);
    return { target, under1m, registeredHref, liveTitle: ev?.title ?? null, options: ev ? [{ value: ev.id, label: formatCallTime(ev.starts_at, tz), slot: sessionSlot(ev.starts_at, slotTz) ?? '' }] : [] };
  }
  const w = await import('../webinar/webinar');
  const sessions = (await w.openSessions(rt, 3)).filter((s) => s.starts_at > Date.now() - 10 * 60_000);
  const jt = w.jitSettings(rt);
  const jit = w.nextJitStart(Date.now(), jt.every, tz, jt);
  const options = [
    ...(jit ? [{ value: `jit:${jit}`, label: `${formatCallTime(jit, tz)}, next showing`, slot: sessionSlot(jit, slotTz) ?? '' }] : []),
    ...sessions.map((s) => ({ value: s.id, label: formatCallTime(s.starts_at, tz), slot: sessionSlot(s.starts_at, slotTz) ?? '' })),
  ].slice(0, 3);
  return { target, under1m, registeredHref, options };
}

export async function resultPage(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const v = c.get('visitor');
  const token = c.req.param('token') ?? '';
  const preview = token === 'preview' && v.botReason === 'admin-preview';
  const row = preview ? null : await getQuiz(rt, token);
  if (!preview && (!row || !row.lead_id || !row.archetype)) return c.redirect('/quiz', 302);
  const answers = row ? parseAnswersJson(row) : PREVIEW_ANSWERS;
  const scored = scoreQuiz(answers);
  const score = row?.score ?? scored.score;
  const archetype = (row?.archetype ?? scored.archetype) as ArchetypeId;
  const gaps = row ? parseGaps(row) : scored.gaps;
  if (row) await markResultViewed(rt, v, row);
  const lead = row?.lead_id ? await rt.env.DB.prepare('SELECT first_name FROM leads WHERE id = ?').bind(row.lead_id).first<{ first_name: string | null }>() : null;
  const firstName = (lead?.first_name || row?.first_name || (preview ? 'Dana' : null))?.slice(0, 40) ?? null;
  const w = await import('../webinar/webinar');
  const action = await actionFor(c, row, scored.band);
  return render(c, '/quiz-result.html', {
    title: ARCHETYPES[archetype].name,
    blocks: { result: resultHtml({ firstName, score, archetype, gaps, answers, action, title: w.webinarSettings(rt).title }) },
    trackPath: '/quiz/r',
    trackProps: { archetype, score },
    config: { quizResult: { token: preview ? 'preview' : token, target: action.target, edition: (await import('../webinar/editions')).editionName(rt.settings) } },
  });
}

