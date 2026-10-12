import { APPLICATION, VIDEOS } from '../config';
import type { Env } from '../env';
import { type Lead, effectiveTier, parseAnswers } from '../funnel/leads';

/**
 * Everything a lead has done, boiled down to short facts a follow-up email can
 * reference ("you stopped the video right as it got to how the deal is funded").
 * Facts are keyed so each email can use ones the previous emails haven't.
 */
export interface Fact {
  key: string;
  /** One plain sentence, written about the lead in the third person. */
  text: string;
  /** Higher = more worth mentioning. */
  weight: number;
  /** Pain point / topic this fact speaks to, used to pick the right fact for each email. */
  topics: string[];
  /** A natural line to the lead ("You got about halfway through the video…"). Only facts that read well said to their face get one. */
  you?: string;
}

export interface Profile {
  name: string;
  tier: string | null;
  facts: Fact[];
  /** Compact JSON for the model and the dashboard. */
  data: Record<string, unknown>;
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const ago = (ms: number, now: number) => {
  const h = (now - ms) / 3_600_000;
  if (h < 1) return 'within the last hour';
  if (h < 24) return `${Math.round(h)} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};

/** Real video lengths seen in this profile, so chapter names are only used when the video matches the chapter map. */
const durations = new Map<string, number>();

function chapterAt(videoId: string, sec: number) {
  const v = Object.values(VIDEOS).find((x) => x.id === videoId);
  const ch = (v && 'chapters' in v ? v.chapters : undefined) ?? [];
  // The map is for a specific cut: if the video playing is shorter than the map, the names would be wrong.
  const dur = durations.get(videoId) ?? 0;
  if (!ch.length || (dur && dur < ch[ch.length - 1].at)) return null;
  let hit: { at: number; title: string } | null = null;
  for (const c of ch) if (c.at <= sec) hit = c;
  return hit?.title ?? null;
}

/** Topics each email template speaks to, so the personaliser can match facts to emails. */
export const TEMPLATE_TOPICS: Record<string, string[]> = {
  pc_ceiling: ['growth', 'plateau'], pc_own_cash: ['funding', 'cash'], pc_bank: ['funding', 'bank'], pc_no_time: ['time'], pc_partner: ['partner', 'call'],
  pc_seller: ['seller', 'funding'], pc_josh: ['credibility'], pc_brokers: ['deal_flow'], pc_dscr: ['debt', 'risk'], pc_consolidate: ['competition'],
  pc_guarantee: ['risk', 'guarantee'], pc_agenda: ['call'], pc_multiple: ['valuation', 'exit'], pc_in_not_on: ['time', 'team'], pc_cash_trap: ['cash', 'growth'],
  pc_fell_over: ['experience', 'risk'], pc_done_with: ['control'], pc_questions: ['call', 'questions'], pc_lemon: ['risk', 'due_diligence'], pc_hiring: ['team'],
  pc_two_paths: ['experience'], pc_next_year: ['timing'], pc_if_you_could: ['experience'], pc_cost: ['timing'],
};

/** Words in answers / FAQ / copied text → topics. */
const TOPIC_WORDS: [RegExp, string][] = [
  [/money down|deposit|cash|capital|fund|financ|bank|lend|loan/i, 'funding'],
  [/debt|dscr|repay|risk|lose|safe/i, 'risk'],
  [/time|busy|hours|run (it|both)/i, 'time'],
  [/seller|vendor|owner.*retir/i, 'seller'],
  [/guarantee|refund/i, 'guarantee'],
  [/find|deal flow|off.?market|broker|listing/i, 'deal_flow'],
  [/staff|team|hire|people|manager/i, 'team'],
  [/compet|consolidat|private equity|roll.?up/i, 'competition'],
  [/exit|valuation|multiple|sell/i, 'valuation'],
  [/partner|spouse|wife|husband/i, 'partner'],
  [/cost|price|fee|invest/i, 'price'],
];
const topicsOf = (text: string) => [...new Set(TOPIC_WORDS.filter(([re]) => re.test(text)).map(([, t]) => t))];

function answerLabel(qid: string, value: unknown): string | null {
  const q = APPLICATION.find((x) => x.id === qid);
  if (!q || value == null) return null;
  if (q.type === 'text') return String(value).slice(0, 300);
  if (q.type === 'single') return q.options.find((o) => o.value === value)?.label ?? String(value);
  if (q.type === 'multi' && Array.isArray(value)) return value.map((v) => q.options.find((o) => o.value === v)?.label ?? v).join(', ');
  return null;
}

interface EventRow { name: string; ts: number; path: string | null; props: string | null; session_id: string | null }

export async function buildProfile(env: Env, lead: Lead, now = Date.now()): Promise<Profile> {
  const db = env.DB;
  const [events, views, sessions, emails, calls, link] = await Promise.all([
    db.prepare(`SELECT name, ts, path, props, session_id FROM events WHERE lead_id = ? AND is_bot = 0 AND name NOT IN ('email_sent', 'app_step_saved') ORDER BY ts LIMIT 2000`).bind(lead.id).all<EventRow>(),
    db.prepare(`SELECT video_id, started_at, duration, max_position, watched_seconds, buckets, completed, cta_clicked, unmuted FROM vsl_views WHERE lead_id = ? AND is_bot = 0 ORDER BY started_at`).bind(lead.id).all<{ video_id: string; started_at: number; duration: number | null; max_position: number; watched_seconds: number; buckets: string; completed: number; cta_clicked: number; unmuted: number }>(),
    db.prepare(`SELECT started_at, last_seen_at, device, city, country, channel, utm_campaign, utm_content, referrer_host, engaged_ms, max_scroll FROM sessions WHERE visitor_id IN (SELECT id FROM visitors WHERE lead_id = ?) ORDER BY started_at LIMIT 100`).bind(lead.id).all<{ started_at: number; last_seen_at: number; device: string | null; city: string | null; country: string | null; channel: string | null; utm_campaign: string | null; utm_content: string | null; referrer_host: string | null; engaged_ms: number; max_scroll: number }>(),
    db.prepare(`SELECT template, subject, sent_at, opened_at, clicked_at FROM emails WHERE lead_id = ? AND status IN ('sent', 'simulated') ORDER BY sent_at`).bind(lead.id).all<{ template: string; subject: string | null; sent_at: number; opened_at: number | null; clicked_at: number | null }>(),
    db.prepare(`SELECT kind, summary, structured, created_at FROM voice_calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 3`).bind(lead.id).all<{ kind: string; summary: string | null; structured: string | null; created_at: number }>().catch(() => ({ results: [] })),
    lead.utm_content ? db.prepare('SELECT label, video_title, placement FROM tracked_links WHERE code = ?').bind(lead.ft_content ?? lead.utm_content).first<{ label: string; video_title: string | null; placement: string | null }>().catch(() => null) : Promise.resolve(null),
  ]);

  const facts: Fact[] = [];
  const add = (key: string, text: string, weight: number, topics: string[] = [], you?: string) => facts.push({ key, text, weight, topics, you });
  const lc = (x: string) => x.charAt(0).toLowerCase() + x.slice(1);
  const ev = events.results;
  const props = (e: EventRow) => { try { return JSON.parse(e.props || '{}') as Record<string, unknown>; } catch { return {}; } };
  const answers = parseAnswers(lead);
  const data: Record<string, unknown> = {};

  // ── Where they came from ──
  if (link?.video_title) add('src_video', `Found us through the YouTube video “${link.video_title}”${link.placement ? ` (${link.placement.replace(/_/g, ' ')})` : ''}.`, 5, ['credibility'], `You found us through my video “${link.video_title}”.`);
  else if (lead.ft_channel && lead.ft_channel !== 'Direct') add('src', `First came from ${lead.ft_channel}${lead.ft_campaign ? ` (campaign “${lead.ft_campaign}”)` : ''}.`, 2);
  data.source = { first: [lead.ft_channel, lead.ft_campaign, lead.ft_content].filter(Boolean).join(' / '), last: [lead.channel, lead.utm_campaign, lead.utm_content].filter(Boolean).join(' / '), video: link?.video_title ?? null };

  // ── Visits ──
  const ss = sessions.results;
  if (ss.length) {
    const days = new Set(ss.map((s) => new Date(s.started_at).toISOString().slice(0, 10))).size;
    const devices = [...new Set(ss.map((s) => s.device).filter(Boolean))];
    const engagedMin = Math.round(ss.reduce((t, s) => t + (s.engaged_ms || 0), 0) / 60_000);
    data.visits = { sessions: ss.length, days, devices, engaged_minutes: engagedMin, first: ss[0].started_at, last: ss[ss.length - 1].last_seen_at };
    if (ss.length >= 3) add('visits', `Has come back to the site ${ss.length} times over ${days} day${days === 1 ? '' : 's'}.`, 6, ['timing'], `You’ve been back to the page ${ss.length} times now.`);
    if (devices.length > 1) add('devices', `Has looked at it on ${devices.join(' and ')}.`, 2);
    if (engagedMin >= 8) add('engaged', `Has spent about ${engagedMin} minutes on the site in total.`, 4);
    const lastVisit = ss[ss.length - 1].last_seen_at;
    if (now - lastVisit < 6 * 3_600_000 && ss.length > 1) add('recent_visit', `Was back on the site ${ago(lastVisit, now)}.`, 5, ['timing'], `You were back on the page ${ago(lastVisit, now)}.`);
  }

  // ── Videos ──
  for (const v of views.results) if (v.duration) durations.set(v.video_id, Math.max(durations.get(v.video_id) ?? 0, v.duration));
  const vByVideo = new Map<string, typeof views.results>();
  for (const v of views.results) vByVideo.set(v.video_id, [...(vByVideo.get(v.video_id) ?? []), v]);
  const vData: Record<string, unknown> = {};
  for (const [vid, vs] of vByVideo) {
    const dur = Math.max(...vs.map((v) => v.duration ?? 0));
    const maxPos = Math.max(...vs.map((v) => v.max_position));
    const watched = Math.round(vs.reduce((t, v) => t + v.watched_seconds, 0));
    const pct = dur ? Math.min(1, maxPos / dur) : 0;
    const completed = vs.some((v) => v.completed);
    const label = vid === VIDEOS.main.id ? 'the main video' : vid === VIDEOS.breakout.id ? 'the part-2 breakout video' : 'the pre-call video';
    vData[vid] = { views: vs.length, pct: Math.round(pct * 100), watched_s: watched, stopped_at: Math.round(maxPos), completed, cta_clicked: vs.some((v) => v.cta_clicked) };
    if (completed) add(`v_${vid}_done`, `Watched ${label} all the way to the end${vs.length > 1 ? `, and came back to it ${vs.length - 1} more time${vs.length > 2 ? 's' : ''}` : ''}.`, 6, [], `You watched the whole video${vs.length > 1 ? ', more than once' : ''}.`);
    else if (pct > 0.05) {
      const ch = chapterAt(vid, maxPos);
      add(`v_${vid}_stop`, `Watched ${Math.round(pct * 100)}% of ${label} and stopped at ${fmtTime(maxPos)}${ch ? `, right around ${ch}` : ''}.`, 8, ch && /fund|financ/.test(ch) ? ['funding'] : ch && /offer|LOI/.test(ch) ? ['call'] : [], vid === VIDEOS.main.id ? `You got about ${Math.round(pct * 10) * 10}% of the way through the video${ch ? `, right up to ${ch}` : ''}.` : undefined);
      // What they missed: the next chapter after where they stopped.
      const v = Object.values(VIDEOS).find((x) => x.id === vid);
      const next = chapterAt(vid, maxPos) ? (v && 'chapters' in v ? v.chapters ?? [] : []).find((c) => c.at > maxPos) : undefined;
      if (next) add(`v_${vid}_missed`, `Hasn't seen the part of ${label} about ${next.title} yet.`, 6, /fund|financ/.test(next.title) ? ['funding'] : [], `You haven’t got to the part of the video about ${next.title} yet.`);
    } else if (vs.length) add(`v_${vid}_barely`, `Opened ${label} but barely watched it.`, 3);
    if (vs.length >= 3 && !completed) add(`v_${vid}_returns`, `Has started ${label} ${vs.length} separate times.`, 4);
  }
  data.videos = vData;
  // Rewatches / pauses / skips → chapters.
  const rewAll = ev.filter((e) => e.name === 'vsl_rewatch').map((e) => { const p = props(e); return { video: String(p.video ?? VIDEOS.main.id), from: Number(p.from ?? 0), to: Number(p.to ?? 0) }; });
  const restarts = rewAll.filter((r) => r.to <= 3);
  const rew = rewAll.filter((r) => r.to > 3);
  const rewCh = [...new Set(rew.map((r) => chapterAt(r.video, r.to)).filter(Boolean))] as string[];
  if (rewCh.length) add('rewatch', `Went back and rewatched the part about ${rewCh.slice(0, 2).join(' and ')}.`, 9, topicsOf(rewCh.join(' ')), `You went back and rewatched the part about ${rewCh[0]}.`);
  else if (rew.length) add('rewatch', `Went back and rewatched part of the video (around ${fmtTime(rew[rew.length - 1].to)}).`, 6);
  if (restarts.length && !rew.length) add('restart', 'Watched the video again from the start.', 5, [], 'You watched the video a second time.');
  const skips = ev.filter((e) => e.name === 'vsl_skip').map((e) => { const p = props(e); return chapterAt(String(p.video ?? VIDEOS.main.id), Number(p.from ?? 0)); }).filter(Boolean) as string[];
  if (skips.length) add('skip', `Skipped ahead past ${[...new Set(skips)].slice(0, 2).join(' and ')}.`, 4, topicsOf(skips.join(' ')));
  const pauses = ev.filter((e) => e.name === 'vsl_pause').map((e) => { const p = props(e); return chapterAt(String(p.video ?? VIDEOS.main.id), Number(p.at ?? 0)); }).filter(Boolean) as string[];
  const pauseTop = Object.entries(pauses.reduce<Record<string, number>>((m, c) => ((m[c] = (m[c] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0];
  if (pauseTop && pauseTop[1] >= 2) add('pause', `Paused the video more than once during ${pauseTop[0]}.`, 5, topicsOf(pauseTop[0]));
  if (ev.some((e) => e.name === 'vsl_speed')) add('speed', 'Sped the video up.', 2, ['time']);

  // ── What they read ──
  const faqs = [...new Set(ev.filter((e) => e.name === 'faq_open').map((e) => String(props(e).q ?? '')).filter(Boolean))];
  if (faqs.length) add('faq', `Opened these questions in the FAQ: ${faqs.slice(0, 4).map((q) => `“${q}”`).join(', ')}.`, 9, topicsOf(faqs.join(' ')), `You were wondering: “${faqs[faqs.length - 1]}”`);
  data.faq_opened = faqs;
  const dwell: Record<string, number> = {};
  for (const e of ev.filter((x) => x.name === 'section_dwell')) for (const [k, v] of Object.entries(props(e))) if (typeof v === 'number') dwell[k] = (dwell[k] ?? 0) + v;
  data.section_seconds = dwell;
  if ((dwell.guarantee ?? 0) >= 8) add('read_guarantee', 'Spent a while reading the 7-day money-back guarantee.', 6, ['guarantee', 'risk'], 'You took a good look at the 7-day guarantee.');
  if ((dwell.faq ?? 0) >= 45) add('read_faq', `Spent about ${Math.round(dwell.faq / 60) || 1} minute${dwell.faq >= 90 ? 's' : ''} reading the FAQ.`, 4);
  if ((dwell.testimonials ?? 0) >= 15) add('read_proof', 'Read through the testimonials.', 4, ['credibility'], 'You read through what other owners said.');
  const copied = ev.filter((e) => e.name === 'text_copy').map((e) => String(props(e).text ?? '')).filter(Boolean);
  if (copied.length) add('copied', `Copied this text from the page: “${copied[copied.length - 1].slice(0, 120)}”.`, 7, topicsOf(copied.join(' ')));
  if (ev.some((e) => e.name === 'exit_intent') && !lead.app_completed_at) add('exit', 'Nearly left the page before applying.', 2);
  const pages = [...new Set(ev.filter((e) => e.name === 'page_view').map((e) => e.path).filter(Boolean))] as string[];
  data.pages = pages;
  if (pages.includes('/resources')) add('resources', 'Looked at the free resources page.', 2);

  // ── The application ──
  const labels: Record<string, string> = {};
  for (const q of APPLICATION) if (q.type !== 'contact') { const l = answerLabel(q.id, answers[q.id]); if (l) labels[q.id] = l; }
  data.answers = labels;
  if (labels.business) add('a_business', `Their business: ${labels.business}.`, 7);
  if (labels.revenue) add('a_revenue', `Annual revenue: ${labels.revenue}.`, 4, ['growth']);
  if (labels.goal) add('a_goal', `Main goal for the next 2–3 years: ${labels.goal}.`, 8, topicsOf(labels.goal), `You said your main goal is to ${lc(labels.goal)}.`);
  if (labels.timeline) add('a_timeline', `Wants to close their first acquisition: ${labels.timeline}.`, 6, ['timing'], `You want your first acquisition closed ${lc(labels.timeline)}.`);
  if (labels.blockers) add('a_blockers', `Said what's held them back: ${labels.blockers}.`, 9, topicsOf(labels.blockers), `You said what’s held you back is ${lc(labels.blockers)}.`);
  if (labels.why_now) add('a_why_now', `In their own words, why now: “${labels.why_now.slice(0, 220)}”.`, 10, topicsOf(labels.why_now), labels.why_now.length <= 160 ? `You told me why now: “${labels.why_now.trim().replace(/[.!]+$/, '')}.”` : undefined);
  if (labels.readiness) add('a_readiness', `Readiness: ${labels.readiness}.`, 3);
  // Hesitation: steps they went back on, slowest question.
  const backs = ev.filter((e) => e.name === 'app_back').map((e) => Number(props(e).step ?? 0));
  const stepViews = ev.filter((e) => e.name === 'app_view_step').map((e) => ({ ts: e.ts, q: String(props(e).question ?? '') }));
  let slow: { q: string; s: number } | null = null;
  for (let i = 0; i < stepViews.length - 1; i++) {
    const s = (stepViews[i + 1].ts - stepViews[i].ts) / 1000;
    if (s < 600 && (!slow || s > slow.s)) slow = { q: stepViews[i].q, s };
  }
  if (slow && slow.s >= 25 && slow.q !== 'contact') {
    const q = APPLICATION.find((x) => x.id === slow!.q);
    if (q) add('a_slowest', `Took the longest on the question “${q.title}” (about ${Math.round(slow.s)} seconds).`, 5, topicsOf(q.title));
  }
  if (backs.length >= 2) add('a_backs', 'Went back and changed answers on the application.', 2);
  if (lead.app_started_at && !lead.app_completed_at) add('a_unfinished', `Started the application ${ago(lead.app_started_at, now)} but hasn't finished it.`, 9, [], `You started your application ${ago(lead.app_started_at, now)} but didn’t get to the end.`);

  // ── Booking ──
  const dates = ev.filter((e) => e.name === 'booking_date_selected').length;
  if (dates && !lead.booked_at) add('b_picked', 'Opened the calendar and picked a date but didn’t confirm a time.', 9, ['call'], 'You picked a day on the calendar but didn’t lock in a time.');
  if (lead.booked_at && !lead.booking_cancelled_at) add('b_booked', `Booked their strategy call ${ago(lead.booked_at, now)}.`, 3, ['call']);
  if (lead.booking_cancelled_at) add('b_cancelled', `Cancelled their strategy call ${ago(lead.booking_cancelled_at, now)}.`, 8, ['call'], 'You had to cancel your call, which happens.');

  // ── Email + WhatsApp + calls ──
  const em = emails.results;
  const opened = em.filter((e) => e.opened_at);
  const clicked = em.filter((e) => e.clicked_at);
  data.emails = { sent: em.length, opened: opened.length, clicked: clicked.map((e) => e.template) };
  if (clicked.length) {
    const last = clicked[clicked.length - 1];
    add('e_clicked', `Clicked through on the email “${last.subject ?? last.template}”.`, 6, TEMPLATE_TOPICS[last.template] ?? [], last.subject ? `You clicked through on my email “${last.subject}”.` : undefined);
  }
  if (em.length >= 4 && !opened.length) add('e_silent', 'Hasn’t opened any of our emails yet.', 3);
  if (lead.whatsapp_clicked_at) add('wa', 'Tapped the WhatsApp button.', 3);
  const call = calls.results[0];
  if (call?.summary) add('ai_call', `On the phone with our assistant ${ago(call.created_at, now)}: ${call.summary.slice(0, 220)}`, 8);

  facts.sort((a, b) => b.weight - a.weight);
  return {
    name: lead.first_name || 'there',
    tier: effectiveTier(lead),
    facts,
    data: { ...data, status: lead.status, tier: effectiveTier(lead), score: lead.score, country: lead.country, city: lead.city },
  };
}
