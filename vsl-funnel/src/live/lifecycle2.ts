/**
 * Round 4 "lifecycle2": three per-event additions to the live-event lifecycle (lifecycle.ts), all OFF by default
 * and switched on per event in Funnel HQ → Live webinars. Pure rules and copy here (the tests drive them
 * directly); lifecycle2-db.ts does the I/O.
 *
 *  1. Bootcamp lead-in: three short parts before the session (a welcome with the "watch this before" video slot,
 *     "your biggest question", the pre-work worksheet). Shown on the confirmation page with the real date each
 *     part lands, and emailed on that date. A part is never emailed once its action is done on the page.
 *  2. Adaptive sequence by sign-up date: someone who registers too late for the whole series gets one essentials
 *     email (why come live, the calendar, the one pre-work item) instead of the leftover parts.
 *  3. Missed live: people who didn't come and haven't bought get a short path keyed to how much of the replay
 *     they watched, only while the real offer window (LIVE_OFFER_HOURS) is open with time to spare. It replaces
 *     the no-show highlights email for that event, so a no-show gets fewer emails, not more.
 *
 * Contact limits on every email here: sending hours in the person's zone (8:00 to 20:00), never within six hours
 * of any other email to the same person, never within two hours of an AI call to them, at most one of these a
 * day, the existing pre-session daily cap (PREWEBINAR_EMAILS_PER_DAY; 0 = none of these go), unsubscribe honoured.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export type Lc2Step = 'welcome' | 'question' | 'prework' | 'essentials' | 'missed1' | 'missed2';
export const LC2_STEPS: Lc2Step[] = ['welcome', 'question', 'prework', 'essentials', 'missed1', 'missed2'];
/** The step inside the registration's block in the `emails` table (sequence lc2:<event id>, step = reg.seq * 10 + this). */
export const LC2_STEP: Record<Lc2Step, number> = { welcome: 1, question: 2, prework: 3, essentials: 4, missed1: 6, missed2: 7 };
/** The ?via= code on each email's link (Funnel HQ counts clicks and returns by it). */
export const LC2_VIA: Record<Lc2Step, string> = { welcome: 'e-lw', question: 'e-lq', prework: 'e-lp', essentials: 'e-le', missed1: 'e-m1', missed2: 'e-m2' };
export const LC2_LABEL: Record<Lc2Step, string> = {
  welcome: 'Lead-in 1: welcome', question: 'Lead-in 2: your biggest question', prework: 'Lead-in 3: the pre-work', essentials: 'Late sign-up: the essentials',
  missed1: 'Missed live: first email', missed2: 'Missed live: after more of the replay',
};

/** The lead-in parts land this long before the start (then moved into the person's sending hours). */
export const PART_BEFORE: Record<'welcome' | 'question' | 'prework', number> = { welcome: 96 * HOUR, question: 72 * HOUR, prework: 48 * HOUR };
/** The prework part must land at least this long before the start (the 24-hour reminder owns the last day). */
export const PREWORK_LAST = 30 * HOUR;
/** Two of these emails to one person are at least this far apart ("one a day"). */
export const LC2_GAP = 20 * HOUR;
/** The essentials email: six hours after sign-up (the confirmation went at sign-up), and only if it lands this long before the start. */
export const ESSENTIALS_AFTER = 6 * HOUR;
export const ESSENTIALS_LAST = 4 * HOUR;
/** A part only counts as "fits" when it lands at least this long after sign-up. */
export const FIT_GAP = 2 * HOUR;
/** Any other email to the same person this close blocks one of these. */
export const EMAIL_GAP = 6 * HOUR;
/** An AI call to the same person this close blocks one of these. */
export const CALL_GAP = 2 * HOUR;
export const SEND_FROM = 8;
export const SEND_TO = 20;

export interface Lc2Toggles { leadin: boolean; adaptive: boolean; missed: boolean }
export const LC2_OFF: Lc2Toggles = { leadin: false, adaptive: false, missed: false };

// ───────────── sending hours ─────────────

export function localHour(t: number, tz: string) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)) % 24; } catch { return new Date(t).getUTCHours(); }
}
export const inSendingHours = (t: number, tz: string) => { const h = localHour(t, tz); return h >= SEND_FROM && h < SEND_TO; };
/** The first moment at or after t inside the person's sending hours (to the hour; zones with half-hour offsets land on :30). */
export function nextSendable(t: number, tz: string) {
  let x = t;
  for (let i = 0; i < 30 && !inSendingHours(x, tz); i++) x = Math.floor(x / (30 * MIN)) * 30 * MIN + 30 * MIN;
  return x;
}

// ───────────── the plan for one registration ─────────────

export interface PlanItem { step: Lc2Step; at: number; until: number }
export type PlanMode = 'off' | 'full' | 'partial' | 'compressed' | 'none';
/**
 * The pre-session plan for one registration (pure): which lead-in steps, and when. Real dates only: `at` is the
 * moment the email is due (already inside their sending hours), `until` the last moment it may still go.
 *  - Lead-in on and every part fits after sign-up: the three parts ('full').
 *  - Some don't fit: the parts that still fit ('partial'), as long as two or more do; with the adaptive switch,
 *    a late sign-up (fewer than two fit) gets one essentials email instead ('compressed').
 *  - Lead-in off, adaptive on: late sign-ups (the full series wouldn't fit) get the essentials email.
 *  - Too late even for that (it would land within four hours of the start): nothing extra; the reminders cover it.
 */
export function leadinPlan(start: number, createdAt: number, t: Pick<Lc2Toggles, 'leadin' | 'adaptive'>, tz: string): { mode: PlanMode; items: PlanItem[] } {
  if (!t.leadin && !t.adaptive) return { mode: 'off', items: [] };
  const parts: PlanItem[] = [];
  const keys = ['welcome', 'question', 'prework'] as const;
  keys.forEach((k, i) => {
    const at = nextSendable(start - PART_BEFORE[k], tz);
    const until = i < keys.length - 1 ? start - PART_BEFORE[keys[i + 1]] : start - PREWORK_LAST;
    parts.push({ step: k, at, until });
  });
  const fits = parts.filter((p) => p.at >= createdAt + FIT_GAP && p.at < p.until);
  if (t.leadin && fits.length === parts.length) return { mode: 'full', items: fits };
  const essentials = (): PlanItem[] => {
    const at = nextSendable(createdAt + ESSENTIALS_AFTER, tz);
    const until = start - ESSENTIALS_LAST;
    return at < until ? [{ step: 'essentials', at, until }] : [];
  };
  if (t.leadin && fits.length >= 2) return { mode: 'partial', items: fits };
  if (t.adaptive && fits.length < 2) { const e = essentials(); return e.length ? { mode: 'compressed', items: e } : { mode: 'none', items: [] }; }
  return t.leadin && fits.length ? { mode: 'partial', items: fits } : { mode: 'none', items: [] };
}

// ───────────── the missed-live path ─────────────

export type WatchBucket = 'none' | 'started' | 'most';
export const BUCKET_RANK: Record<WatchBucket, number> = { none: 0, started: 1, most: 2 };
/** How much of the replay they watched: nothing, some (or started, when only the start is known), half or more. */
export function watchBucket(o: { started: boolean; pct: number | null }): WatchBucket {
  if (o.pct != null && o.pct >= 0.5) return 'most';
  if (o.started || (o.pct != null && o.pct > 0)) return 'started';
  return 'none';
}
/** The share of a room's replay watched, from room_replay_views.minutes ('1' per minute watched). */
export function watchedPct(minutes: string | null | undefined) {
  if (!minutes) return null;
  const n = minutes.length;
  return n ? [...minutes].filter((c) => c === '1').length / n : null;
}
export const MISSED1_AFTER = 18 * HOUR;
export const MISSED2_AFTER = 30 * HOUR;
/** The first missed email needs this much of the offer window left, the second this much (replay_last owns the last six hours). */
export const MISSED1_LEFT = 6 * HOUR;
export const MISSED2_LEFT = 8 * HOUR;

/**
 * What is due on the missed path for one person (pure). Only people who didn't come and haven't bought, only
 * while the offer is really open: the first email 18 hours after the end (keyed to what they watched so far),
 * a second one only when they have since watched more (a higher bucket), 30 hours after the end.
 */
export function dueMissed(o: { now: number; end: number; joined: boolean; bought: boolean; offerOpen: boolean; closesAt: number; bucket: WatchBucket; sent1: WatchBucket | null; sent2: boolean }): { step: 'missed1' | 'missed2'; bucket: WatchBucket } | null {
  if (o.joined || o.bought || !o.offerOpen || o.now < o.end) return null;
  const left = o.closesAt - o.now;
  if (!o.sent1) return o.now >= o.end + MISSED1_AFTER && left > MISSED1_LEFT ? { step: 'missed1', bucket: o.bucket } : null;
  if (o.sent2 || BUCKET_RANK[o.bucket] <= BUCKET_RANK[o.sent1]) return null;
  return o.now >= o.end + MISSED2_AFTER && left > MISSED2_LEFT ? { step: 'missed2', bucket: o.bucket } : null;
}

// ───────────── the contact limits ─────────────

export interface Gate { now: number; tz: string; unsubscribed: boolean; lastEmailAt: number | null; lastLc2At: number | null; callsAt: number[]; sent24h: number; cap: number }
/** Whether one of these emails may go now; the reason when it waits (a wait is retried on the next run inside the step's window). */
export function gate(g: Gate): { ok: true } | { ok: false; why: string; final: boolean } {
  if (g.unsubscribed) return { ok: false, why: 'Unsubscribed', final: true };
  if (g.cap <= 0) return { ok: false, why: 'Pre-session daily cap is 0', final: true };
  if (!inSendingHours(g.now, g.tz)) return { ok: false, why: 'Outside their sending hours', final: false };
  if (g.lastLc2At != null && g.now - g.lastLc2At < LC2_GAP) return { ok: false, why: 'One of these a day at most', final: false };
  if (g.lastEmailAt != null && g.now - g.lastEmailAt < EMAIL_GAP) return { ok: false, why: 'Another email went in the last six hours', final: false };
  if (g.callsAt.some((t) => Math.abs(t - g.now) <= CALL_GAP)) return { ok: false, why: 'An AI call to them is close', final: false };
  if (g.sent24h >= g.cap) return { ok: false, why: 'Daily email cap reached', final: false };
  return { ok: true };
}

// ───────────── copy (every string is checked by auditCopy / auditEmail in the tests) ─────────────

export interface Lc2Ctx {
  name: string; title: string; when: string; room: string; deposit: string;
  /** The real close of the deposit offer and the replay (missed path only). */
  closes?: string | null;
  calendar?: { google: string; outlook: string; apple: string } | null;
  /** Their own unsubscribe link (shown as a line at the end). */
  unsubscribe?: string | null;
  /** A "watch this before" video is set for the event. */
  video?: boolean;
}

export const LC2_PAGE = {
  heading: 'Before the session',
  bodyFull: 'Three short parts, a day apart, so you arrive with your question asked and your numbers ready. Each part is on this page now and in your inbox on its date.',
  bodyCompressed: 'You registered close to the start, so the lead-up is one short email with the essentials. Everything is also on this page.',
  bodyPartial: 'The parts still ahead of the session, on this page now and in your inbox on their dates.',
  part: (i: number) => `Part ${i}`,
  inbox: (date: string) => `In your inbox ${date}`,
  sent: 'Sent',
  done: 'Done',
  open: 'Open',
  titles: { welcome: 'Welcome, and why it runs live', question: 'Your biggest question', prework: 'The pre-work worksheet', essentials: 'The essentials' } as Record<'welcome' | 'question' | 'prework' | 'essentials', string>,
  blurbs: {
    welcome: 'What the session covers, the short welcome video, and why it is worth being there live.',
    welcomeNoVideo: 'What the session covers, and why it is worth being there live.',
    question: 'Send Josh the one question you want answered. He sees them before the session.',
    prework: 'Five answers that start your Deal Plan, so you work on your own numbers in the session.',
    essentials: 'Why come live, your calendar entry, and the one piece of pre-work.',
  } as Record<'welcome' | 'welcomeNoVideo' | 'question' | 'prework' | 'essentials', string>,
};

const why = 'Live, Josh answers questions as they come in and runs the 1.5x test on examples from the room. The replay doesn’t take questions.';
/** The visible unsubscribe line (sent as `after`, so it stays below the calendar row; List-Unsubscribe goes in the headers too). */
const stop = (x: Lc2Ctx) => (x.unsubscribe ? [`To stop emails like this one: ${x.unsubscribe}`] : []);

/** The lead-in and essentials emails (plain paragraphs; links are buttons or the calendar row). */
export function leadinEmail(step: 'welcome' | 'question' | 'prework' | 'essentials', x: Lc2Ctx) {
  const hi = `Hi ${x.name},`;
  switch (step) {
    case 'welcome':
      return {
        subject: `Part 1 of 3 before ${x.title}`, preheader: `A short welcome, and why it runs live on ${x.when}.`, heading: 'Welcome, and why it runs live',
        paras: [hi, `${x.title} is on ${x.when}. Before then you get three short parts, a day apart, and this is the first.`,
          'The session covers how owners buy a competitor with commercial debt, seller finance and seller rollover, and the 1.5x test every deal has to pass.',
          ...(x.video ? ['Your page has a short welcome video from Josh’s team. It takes a few minutes and makes the session easier to follow.'] : []),
          why],
        after: stop(x),
        button: { label: x.video ? 'Watch the welcome' : 'Open my page', href: x.room },
      };
    case 'question':
      return {
        subject: 'Part 2 of 3: the one question you want answered', preheader: 'Josh reads them before the session.', heading: 'Your biggest question',
        paras: [hi, 'Josh reads the questions sent before the session and answers as many as he can live.',
          'The best ones are specific: the industry, the size of the business you would buy, and the part that worries you, such as a seller who wants cash at closing.'],
        after: stop(x),
        button: { label: 'Send my question', href: x.room },
      };
    case 'prework':
      return {
        subject: 'Part 3 of 3: five answers before the session', preheader: 'They start your Deal Plan.', heading: 'The pre-work worksheet',
        paras: [hi, 'Five answers start your Deal Plan: the industry you would buy in, the size of business, where, how many owners you could contact each week, and your first step after the session.',
          'With them saved, you fill in the rest of the plan as Josh teaches, on your own numbers.'],
        after: stop(x),
        button: { label: 'Fill in my worksheet', href: x.room },
      };
    case 'essentials':
      return {
        subject: `Before ${x.title}: the essentials`, preheader: `${x.when}. Three things, two minutes.`, heading: 'The essentials before the session',
        paras: [hi, `You registered for ${x.title} on ${x.when}. Three things make it count.`,
          why, 'Put it in your calendar. The entry carries your personal room link.',
          'Fill in the five-answer worksheet on your page. It starts your Deal Plan, so you work on your own numbers in the session.'],
        after: stop(x),
        button: { label: 'Open my page', href: x.room }, calendar: x.calendar ?? null,
      };
  }
}

/** The missed-live emails, keyed to what they watched. A deadline sentence appears only with a real close. */
export function missedEmail(step: 'missed1' | 'missed2', bucket: WatchBucket, x: Lc2Ctx) {
  const hi = `Hi ${x.name},`;
  const close = x.closes ? [`The ${x.deposit} deposit from the session and the replay both close ${x.closes}.`] : [];
  const btn = { label: bucket === 'none' ? 'Watch the replay' : 'Continue the replay', href: x.room };
  if (bucket === 'most') {
    return {
      subject: step === 'missed1' ? 'You watched most of the replay' : 'Most of the replay done: the three answers', preheader: x.closes ? `The deposit offer closes ${x.closes}.` : 'Your room has the replay.', heading: 'Three answers before you decide',
      paras: [hi, 'You watched most of the replay. Owners at this point ask three things.',
        'Whether their target passes the 1.5x test: your Deal Plan runs it on your own numbers.',
        'What happens without a signed letter of intent in 90 days: the guarantee and its conditions are in your room, in full.',
        'Whether the deposit is lost if they change their mind: it is credited in full against the engagement fee, and the refund terms are next to the button.', ...close],
      after: stop(x),
      button: { label: 'Open my room', href: x.room },
    };
  }
  if (bucket === 'started') {
    return {
      subject: 'The rest of the replay', preheader: x.closes ? `The replay is up until ${x.closes}.` : 'Your room has the replay.', heading: 'The rest of the replay',
      paras: [hi, `You started the replay of ${x.title}. It is still in your room, on the same personal link.`,
        'The part after the teaching covers how the purchase gets funded with commercial debt, seller finance and seller rollover, and the 1.5x test.', ...close],
      after: stop(x),
      button: btn,
    };
  }
  return {
    subject: `You missed ${x.title} live`, preheader: x.closes ? `The replay is up until ${x.closes}.` : 'Your room has the replay.', heading: 'You missed it live',
    paras: [hi, `${x.title} ran without you. The replay is in your room, on the same personal link.`,
      'Start with the first part: where owners find businesses with no successor, and how the purchase gets funded.', ...close],
    after: stop(x),
    button: btn,
  };
}

// ───────────── Funnel HQ: what each step did ─────────────

export interface ImpactIn {
  step: Lc2Step;
  rows: { status: string; opened_at: number | null; sent_at: number | null; why: string | null; clicked: boolean; joined: boolean; replayAfter: boolean; boughtAfter: boolean }[];
}
/** Per step: sent, skipped (with reasons), opened, clicked, and the outcome that step is for (joined live, or replay and deposit after). */
export function impact(x: ImpactIn) {
  const delivered = x.rows.filter((r) => r.status === 'sent' || r.status === 'simulated');
  const skipped = new Map<string, number>();
  for (const r of x.rows) if (r.status === 'skipped') skipped.set(r.why ?? 'Skipped', (skipped.get(r.why ?? 'Skipped') ?? 0) + 1);
  const n = (f: (r: ImpactIn['rows'][number]) => boolean) => delivered.filter(f).length;
  const rate = (k: number) => (delivered.length ? k / delivered.length : null);
  const post = x.step === 'missed1' || x.step === 'missed2';
  const opened = n((r) => Boolean(r.opened_at)), clicked = n((r) => r.clicked);
  const outcome = post ? n((r) => r.replayAfter) : n((r) => r.joined);
  const bought = n((r) => r.boughtAfter);
  return {
    step: x.step, label: LC2_LABEL[x.step], sent: delivered.length, opened, clicked, outcome, bought,
    openRate: rate(opened), clickRate: rate(clicked), outcomeRate: rate(outcome),
    outcomeLabel: post ? 'Watched the replay after it' : 'Joined live',
    skipped: [...skipped.entries()].map(([why, k]) => ({ why, n: k })),
  };
}
