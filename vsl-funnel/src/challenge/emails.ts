import type { Runtime } from '../app';
import type { Lead } from '../funnel/leads';
import type { EmailContent, TemplateCtx } from '../integrations/templates';
import { newId } from '../lib/ids';
import { DAYS, dayContent } from './content';
import { type DayRow, HOUR, MIN, dayEnds, formatWhen, localParts, offerCloseAt, offerHours, replayAccess, wallTime } from './schedule';

/**
 * Challenge emails and texts, on the funnel's existing machinery: rows in `emails` (sequence 'challenge', one
 * block of CH_CYCLE steps per registration, sent by the email cron with personal links) and the SMS queue
 * ('challenge' trigger, anchored to each day's start). Times are absolute, computed from the cohort's days.
 *  - On the ticket: confirmation now; per day the morning-of email, 1 hour before, live now, then the replay and
 *    worksheet nudge, plus a VIP note for VIP members; after Day 5 the offer emails until the real deadline.
 *  - Every email links to the person's own day page or hub, never the bare Zoom link.
 *  - Re-timed when a session moves in Funnel HQ; stopped by a refund; offer emails stop at a deposit.
 */

export const CH_CYCLE = 40;
const PHASES = ['morning', 'hour', 'live', 'after', 'vip'] as const;
type Phase = (typeof PHASES)[number];
/** Step order is the dedupe key inside a block: append only. */
export const CH_STEPS: string[] = [
  'ch_confirm',
  ...DAYS.flatMap((d) => PHASES.map((p) => `ch_d${d.n}_${p}`)),
  'ch_offer_1', 'ch_offer_2', 'ch_offer_3', 'ch_offer_4',
  'ch_vip_welcome',
];

/** The send time of every step for a cohort (null = not sent). Pure, for the tests. */
export function planChallengeEmails(o: { days: Pick<DayRow, 'day' | 'starts_at' | 'duration_min'>[]; tz: string; hours: number; now: number }) {
  const plan = new Map<string, number | null>();
  plan.set('ch_confirm', o.now);
  for (const d of o.days) {
    const start = d.starts_at;
    const local = localParts(start, o.tz);
    const [y, m, dd] = local.date.split('-').map(Number);
    const [hh, mm] = local.time.split(':').map(Number);
    // Morning of: 7:30 local; a session that starts before 10:30 gets it at 7:00 pm the evening before.
    let morning = wallTime(y, m, dd, 7, 30, o.tz);
    if (hh * 60 + mm < 10 * 60 + 30) { const prev = new Date(Date.UTC(y, m - 1, dd - 1)); morning = wallTime(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate(), 19, 0, o.tz); }
    const at: Record<Phase, number | null> = {
      morning: morning <= start - 90 * MIN ? morning : null,
      hour: start - HOUR,
      live: start,
      after: dayEnds(d) + 90 * MIN,
      vip: start - 2 * HOUR,
    };
    for (const p of PHASES) plan.set(`ch_d${d.day}_${p}`, at[p]);
  }
  const close = offerCloseAt(o.days, o.hours);
  const d5 = o.days.find((d) => d.day === 5);
  if (close != null && d5) {
    const first = dayEnds(d5) + 20 * MIN;
    plan.set('ch_offer_1', first);
    const mid = close - 24 * HOUR;
    plan.set('ch_offer_2', mid > first + 2 * HOUR ? mid : null);
    const late = close - 6 * HOUR;
    plan.set('ch_offer_3', late > first + 2 * HOUR ? late : null);
    plan.set('ch_offer_4', close - HOUR > first ? close - HOUR : null);
  }
  // Anything whose moment has passed (a late joiner) is not sent; the confirmation always is.
  for (const [k, t] of plan) if (k !== 'ch_confirm' && t != null && t < o.now - 5 * MIN) plan.set(k, null);
  return plan;
}

interface RegRow { id: string; token: string; cohort_id: string; lead_id: string; seq: number; status: string; vip: number }

async function loadFor(rt: Runtime, regId: string) {
  const reg = await rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE id = ?').bind(regId).first<RegRow>();
  if (!reg) return null;
  const cohort = await rt.env.DB.prepare('SELECT * FROM challenge_cohorts WHERE id = ?').bind(reg.cohort_id).first<{ timezone: string; status: string }>();
  const days = (await rt.env.DB.prepare('SELECT * FROM challenge_days WHERE cohort_id = ? ORDER BY day').bind(reg.cohort_id).all<DayRow>()).results;
  const lead = await rt.env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(reg.lead_id).first<Lead>();
  return cohort && lead ? { reg, cohort, days, lead } : null;
}

/** Schedules (or re-times) the registration's challenge emails and texts. */
export async function startChallengeMessages(rt: Runtime, regId: string, now = Date.now()) {
  const L = await loadFor(rt, regId);
  if (!L || L.reg.status !== 'paid' || L.cohort.status !== 'scheduled') return 0;
  const { lead, reg } = L;
  if (!lead.email || lead.unsubscribed_at) return 0;
  // Another cohort's unsent emails are replaced by this one's.
  await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = 'challenge' AND status = 'pending' AND (step < ? OR step >= ?)")
    .bind(lead.id, reg.seq * CH_CYCLE, (reg.seq + 1) * CH_CYCLE).run();
  const plan = planChallengeEmails({ days: L.days, tz: L.cohort.timezone, hours: offerHours(rt.settings), now });
  const db = rt.env.DB;
  const stmts = CH_STEPS.flatMap((template, j) => {
    const at = plan.get(template);
    const step = reg.seq * CH_CYCLE + j;
    if (template === 'ch_vip_welcome') return [];
    if (at == null) return [db.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = 'challenge' AND step = ? AND status = 'pending'").bind(lead.id, step)];
    // The confirmation goes once: re-timing never sends it again.
    const conflict = template === 'ch_confirm' ? 'DO NOTHING' : "DO UPDATE SET send_at = excluded.send_at, status = 'pending', to_email = excluded.to_email, attempts = 0 WHERE emails.status IN ('pending', 'cancelled', 'skipped')";
    return [db.prepare(`INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES (?, ?, 'challenge', ?, ?, ?, ?, 'pending', ?) ON CONFLICT(lead_id, sequence, step) ${conflict}`)
      .bind(newId('m'), lead.id, step, template, lead.email, at, now)];
  });
  if (stmts.length) await db.batch(stmts);
  const { startSms } = await import('../integrations/sms');
  const { isMillionPlus } = await import('../sales/qualify');
  if (!lead.revenue_band || isMillionPlus(lead.revenue_band)) {
    await startSms(rt, lead, 'challenge', Object.fromEntries(L.days.map((d) => [`day${d.day}`, d.starts_at]))).catch((e) => console.error('challenge sms', e));
  }
  return stmts.length;
}

/** The VIP welcome email, right after the upgrade. */
export async function vipWelcome(rt: Runtime, regId: string, now = Date.now()) {
  const L = await loadFor(rt, regId);
  if (!L?.lead.email || L.lead.unsubscribed_at) return;
  const step = L.reg.seq * CH_CYCLE + CH_STEPS.indexOf('ch_vip_welcome');
  await rt.env.DB.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, send_at, status, created_at) VALUES (?, ?, 'challenge', ?, 'ch_vip_welcome', ?, ?, 'pending', ?) ON CONFLICT(lead_id, sequence, step) DO NOTHING")
    .bind(newId('m'), L.lead.id, step, L.lead.email, now + 2 * MIN, now).run();
}

/** Re-times everyone in a cohort after a session moved (Funnel HQ). */
export async function retimeCohort(rt: Runtime, cohortId: string) {
  const { results } = await rt.env.DB.prepare("SELECT id, lead_id, status FROM challenge_registrations WHERE cohort_id = ? AND status = 'paid'").bind(cohortId).all<{ id: string; lead_id: string }>();
  const cohort = await rt.env.DB.prepare('SELECT status FROM challenge_cohorts WHERE id = ?').bind(cohortId).first<{ status: string }>();
  for (const r of results) {
    if (cohort?.status === 'cancelled') await stopChallengeMessages(rt, r.lead_id);
    else await startChallengeMessages(rt, r.id);
  }
  return results.length;
}

export async function stopChallengeMessages(rt: Runtime, leadId: string) {
  await rt.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE lead_id = ? AND sequence = 'challenge' AND status = 'pending'").bind(leadId).run();
  const { stopSms } = await import('../integrations/sms');
  await stopSms(rt, leadId, ['challenge']);
}

// ───────────── send-time rules (SEQUENCES.challenge) ─────────────

async function currentReg(rt: Runtime, lead: Pick<Lead, 'challenge_token'>) {
  if (!lead.challenge_token) return null;
  return rt.env.DB.prepare('SELECT * FROM challenge_registrations WHERE token = ?').bind(lead.challenge_token).first<RegRow>();
}
/** The whole run stops when the registration isn't paid any more (refund) or the cohort was cancelled. */
export async function challengeStop(rt: Runtime, lead: Lead) {
  const reg = await currentReg(rt, lead);
  if (!reg || reg.status !== 'paid') return true;
  const c = await rt.env.DB.prepare('SELECT status FROM challenge_cohorts WHERE id = ?').bind(reg.cohort_id).first<{ status: string }>();
  return c?.status !== 'scheduled';
}
/** Per step: VIP notes only to VIP; the replay nudge skips people who came and did the worksheet; offer emails need an opened, unpaid offer. */
export function challengeSkip(template: string) {
  return async (rt: Runtime, lead: Lead) => {
    const reg = await currentReg(rt, lead);
    if (!reg) return true;
    const m = /^ch_d(\d)_(\w+)$/.exec(template);
    if (m && m[2] === 'vip') return !reg.vip;
    if (m && m[2] === 'after') {
      const p = await rt.env.DB.prepare('SELECT joined_at, present_at, replay_at, homework_at FROM challenge_progress WHERE reg_id = ? AND day = ?').bind(reg.id, Number(m[1])).first<{ joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }>();
      return Boolean(p && (p.joined_at || p.present_at || p.replay_at) && p.homework_at);
    }
    if (template.startsWith('ch_offer_')) {
      const paid = await rt.env.DB.prepare('SELECT 1 FROM challenge_deposits WHERE reg_id = ? AND paid_at IS NOT NULL').bind(reg.id).first();
      if (paid) return true;
      const opened = await rt.env.DB.prepare('SELECT 1 FROM challenge_offer_state WHERE event_key IN (?, ?) AND open_at IS NOT NULL').bind(`challenge:${reg.cohort_id}:4`, `challenge:${reg.cohort_id}:5`).first();
      return !opened;
    }
    return false;
  };
}

// ───────────── template context ─────────────

export interface ChallengeEmailCtx {
  hub: string; ics: string; vip: boolean; closes: string | null; deposit: string; credit: string | null;
  days: { n: number; title: string; line: string; when: string; page: string; replay: string | null; attended: boolean; homework: boolean }[];
}

/** The lead's challenge, with tracked personal links, for ch_ emails (built at send time). */
export async function challengeEmailContext(rt: Runtime, lead: Lead, link: (path: string) => string): Promise<ChallengeEmailCtx | null> {
  const reg = await currentReg(rt, lead);
  if (!reg) return null;
  const L = await loadFor(rt, reg.id);
  if (!L) return null;
  const tz = lead.timezone || L.cohort.timezone;
  const close = offerCloseAt(L.days, offerHours(rt.settings));
  const now = Date.now();
  const prog = (await rt.env.DB.prepare('SELECT * FROM challenge_progress WHERE reg_id = ?').bind(reg.id).all<{ day: number; joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }>()).results;
  const base = `${rt.origin}/challenge`;
  const { depositConfig } = await import('../sales/deposit');
  const { challengeTicketCredit } = await import('./payments');
  const { money } = await import('./cohorts');
  const credit = await challengeTicketCredit(rt, lead.id);
  return {
    hub: link(`${base}/hub/${reg.token}`),
    ics: link(`${base}/ics/${reg.token}`),
    vip: Boolean(reg.vip),
    closes: close ? formatWhen(close, tz) : null,
    deposit: depositConfig(rt).label,
    credit: credit ? money(credit.amount, credit.currency) : null,
    days: L.days.map((d) => {
      const c = dayContent(d.day)!;
      const p = prog.find((x) => x.day === d.day);
      return {
        n: d.day, title: c.title, line: c.line, when: formatWhen(d.starts_at, tz),
        page: link(`${base}/day/${reg.token}/${d.day}`),
        replay: replayAccess({ vip: Boolean(reg.vip), replayUrl: d.replay_url, closeAt: close, now }) === 'open' ? link(`${base}/replay/${reg.token}/${d.day}`) : null,
        attended: Boolean(p && (p.joined_at || p.present_at || p.replay_at)), homework: Boolean(p?.homework_at),
      };
    }),
  };
}

// ───────────── templates ─────────────

type T = (c: TemplateCtx) => EmailContent;
const ch = (c: TemplateCtx): ChallengeEmailCtx => (c as TemplateCtx & { challenge?: ChallengeEmailCtx | null }).challenge ?? {
  hub: c.link('/challenge'), ics: c.link('/challenge'), vip: false, closes: '48 hours after Day 5', deposit: '$5,000', credit: '$100',
  days: DAYS.map((d) => ({ n: d.n, title: d.title, line: d.line, when: `Day ${d.n}`, page: c.link('/challenge'), replay: null, attended: false, homework: false })),
};
const day = (c: TemplateCtx, n: number) => ch(c).days.find((d) => d.n === n) ?? ch(c).days[0];
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const PREP: Record<number, string> = {
  1: 'Have last year’s revenue and profit to hand. Rough numbers are fine.',
  2: 'Think of two or three businesses near you that you would buy if the money were sorted.',
  3: 'Bring the names of owners you already know in your industry, even loosely.',
  4: 'Bring your target’s rough profit, or use the illustrative numbers on the page.',
  5: 'Have your four worksheets open. Today they become one page.',
};

function dayTemplates(n: number): Record<string, T> {
  return {
    [`ch_d${n}_morning`]: (c) => ({
      subject: `today, Day ${n}: ${lower(day(c, n).title)}`,
      preheader: `${day(c, n).when}. Your page has the Zoom link.`,
      body: [
        `Morning ${c.name},`,
        `Day ${n} of the First Deal Challenge is today at ${day(c, n).when}. ${day(c, n).line}`,
        PREP[n],
        'Open your day page a few minutes early. The Zoom link, the worksheet and the cohort chat are all on it.',
      ],
      cta: { label: `Open Day ${n} →`, href: day(c, n).page },
    }),
    [`ch_d${n}_hour`]: (c) => ({
      subject: `Day ${n} starts in an hour`,
      preheader: day(c, n).title,
      body: [`${c.name}, Day ${n} starts in an hour: ${lower(day(c, n).title)}.`, 'Your day page has the Join on Zoom button. Keep the page open next to Zoom for the worksheet and the chat.'],
      cta: { label: `Open Day ${n} →`, href: day(c, n).page },
    }),
    [`ch_d${n}_live`]: (c) => ({
      subject: `we’re live: Day ${n}`,
      preheader: 'Join on Zoom from your day page.',
      body: [`${c.name}, Day ${n} has started.`, 'Press Join on Zoom on your day page and you are in.'],
      cta: { label: 'Join now →', href: day(c, n).page },
    }),
    [`ch_d${n}_after`]: (c) => {
      const d = day(c, n);
      return {
        subject: d.attended ? `your Day ${n} worksheet` : `the Day ${n} replay`,
        preheader: d.attended ? 'Ten minutes, and tomorrow builds on it.' : 'Catch up before the next session.',
        body: [
          `${c.name},`,
          d.attended ? `Thanks for being on Day ${n}. The worksheet takes about ten minutes, and the next session builds on it.` : `You missed Day ${n} live: ${lower(d.title)}. ${d.replay ? 'The replay is on your day page.' : 'The replay goes up on your day page shortly.'}`,
          d.homework ? 'Your worksheet is in. Nice work.' : 'Finish the worksheet on the same page. It is the piece of your deal plan this day adds.',
          ...(ch(c).vip ? ['VIP: the team reads every worksheet you submit and writes back on your page.'] : []),
        ],
        cta: { label: d.attended ? 'Finish my worksheet →' : 'Watch and catch up →', href: d.page },
      };
    },
    [`ch_d${n}_vip`]: (c) => ({
      subject: `VIP: today’s hot seat`,
      preheader: 'Straight after the session.',
      body: [
        `${c.name},`,
        `Straight after Day ${n}, Josh takes VIP questions live on the hot seat. The link is in the VIP box on your day page.`,
        'Send your question from the same box before the session, with your numbers, and Josh sees it first.',
      ],
      cta: { label: 'Send my question →', href: day(c, n).page },
    }),
  };
}

export const CHALLENGE_TEMPLATES: Record<string, T> = {
  ch_confirm: (c) => ({
    subject: 'you’re in: the First Deal Challenge',
    preheader: `Day 1 is ${day(c, 1).when}.`,
    body: [
      `Hey ${c.name},`,
      'Your ticket for the First Deal Challenge is confirmed.',
      ch(c).days.map((d) => `<strong>Day ${d.n}</strong>, ${d.when}: ${d.title}`).join('<br>'),
      'Every session runs on Zoom. Your challenge page has the Zoom link for each day, the worksheets, the cohort chat and your progress.',
      `Add all five days to your calendar: <a href="${ch(c).ics}">Apple or Outlook</a>.`,
    ],
    cta: { label: 'Open my challenge page →', href: ch(c).hub },
    ps: 'The link above is your personal key to the challenge. Keep this email.',
  }),
  ch_vip_welcome: (c) => ({
    subject: 'VIP is on',
    preheader: 'Your hot seat, recordings and worksheet feedback.',
    body: [
      `${c.name},`,
      'Thanks for upgrading. VIP adds three things to your five days.',
      'After each session Josh takes VIP questions live on the hot seat. You keep the recordings after the challenge ends. And the team reads each worksheet you submit and writes back on your page.',
      'The hot seat link and the question box are in the VIP section of each day page.',
    ],
    cta: { label: 'Open my challenge page →', href: ch(c).hub },
  }),
  ch_offer_1: (c) => ({
    subject: 'what Josh offered at the end of Day 5',
    preheader: `Open until ${ch(c).closes ?? 'the deadline'}.`,
    body: [
      `${c.name},`,
      'At the end of Day 5 Josh opened places in this intake of the advisory engagement: 90 days with his team on the 3C model, from your buy box to a signed letter of intent.',
      `You reserve a place with a ${ch(c).deposit} deposit, credited in full against the engagement fee.${ch(c).credit ? ` Your ${ch(c).credit} ticket is credited too.` : ''} The balance is due when you sign the agreement after a short onboarding call.`,
      `The offer closes ${ch(c).closes ?? 'soon'}. The full details and the guarantee with its conditions are on your Day 5 page.`,
    ],
    cta: { label: 'See the offer →', href: day(c, 5).page },
  }),
  ch_offer_2: (c) => ({
    subject: 'the cost of waiting on your first deal',
    preheader: `The offer closes ${ch(c).closes ?? 'soon'}.`,
    body: [
      `${c.name},`,
      'Every month the plan from Day 5 sits in a drawer, the owner you wanted to call gets older and the competitor down the road gets a month closer to buying them first.',
      'The engagement exists so the plan turns into owner conversations this week, with a team checking the structure and the 1.5x test as you go.',
      `Places for this intake close ${ch(c).closes ?? 'soon'}.`,
    ],
    cta: { label: 'Reserve my place →', href: day(c, 5).page },
  }),
  ch_offer_3: (c) => ({
    subject: 'six hours left',
    preheader: 'Then this intake’s places close.',
    body: [
      `${c.name}, the offer from Day 5 closes ${ch(c).closes ?? 'tonight'}.`,
      'If the challenge showed you a deal you can do, the deposit reserves the team to do it with you. If it didn’t, you can let this one go.',
      'The guarantee and its conditions are on the page, in full.',
    ],
    cta: { label: 'Decide on my Day 5 page →', href: day(c, 5).page },
  }),
  ch_offer_4: (c) => ({
    subject: 'closing in an hour',
    preheader: 'Last note about the offer.',
    body: [`${c.name}, one hour left on the offer from Day 5.`, 'After that this intake is planned from the places reserved, and the replays close for non-VIP members.'],
    cta: { label: 'Open my Day 5 page →', href: day(c, 5).page },
  }),
  ...Object.assign({}, ...DAYS.map((d) => dayTemplates(d.n))),
};
