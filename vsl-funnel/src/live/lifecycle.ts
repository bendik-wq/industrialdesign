/**
 * Builder E "lifecycle": registration to replay for live events (Zoom or our own room, general admission joiners
 * included). Pure rules here (the tests drive them directly); lifecycle-db.ts does the I/O, lifecycle-pages.ts
 * draws the pages, src/rooms/lifecycle.ts runs the waiting room.
 *
 *  - Show-up cadence: confirmation, 24 hours, 3 hours, 1 hour, 10 minutes, "we're live now" and "you're missing
 *    it" five minutes in for anyone not in the room yet. Email by default; texts only with consent and inside
 *    texting hours. The 24 and 3 hour emails wait out the person's own quiet hours (their zone: the zone their
 *    browser reported on the confirmation page, else the zone of their connection, else the event's).
 *  - One person, one moment, at most two channels: a text is held back when an AI call to the same person is
 *    queued within 15 minutes of it (and the call side skips or moves a call that would land on a sent text).
 *  - After the event, three paths with real deadlines only: buyers get onboarding, people who came and didn't
 *    buy get the questions owners ask before deciding, people who missed it get the highlights and the replay.
 *  - Referrals: a personal link per registrant; a referral counts only when it is someone else (not the same
 *    person, browser or connection), for the same event, up to a cap; it earns points and an unlock when the
 *    person they brought actually attends.
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** The waiting room opens this long before the start. */
export const WAITING_ROOM_MIN = 15;
/** "You're missing it" goes this long after the start to anyone not in the room. */
export const MISSING_AFTER_MIN = 5;
/** A text is held back when an AI call to the same person is this close to it. */
export const CHANNEL_GAP_MIN = 15;
export const REFERRAL_CAP_DEFAULT = 10;

// ───────────── quiet hours and per-person time ─────────────

export interface Quiet { from: number; to: number }
/** "22-7" → 22:00 to 07:00 local (blank = that default; "off" = none). */
export function parseQuiet(raw: string | null | undefined): Quiet | null {
  const v = String(raw ?? '').trim();
  if (/^(off|none)$/i.test(v)) return null;
  const m = /^(\d{1,2})\s*[-–to ]+\s*(\d{1,2})$/.exec(v);
  if (!m) return { from: 22, to: 7 };
  const from = Number(m[1]), to = Number(m[2]);
  return from >= 0 && from < 24 && to >= 0 && to < 24 && from !== to ? { from, to } : { from: 22, to: 7 };
}
export function localHour(t: number, tz: string) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)) % 24; } catch { return new Date(t).getUTCHours(); }
}
export function inQuiet(t: number, tz: string, q: Quiet | null) {
  if (!q) return false;
  const h = localHour(t, tz);
  return q.from > q.to ? h >= q.from || h < q.to : h >= q.from && h < q.to;
}
/** The person's zone: what their browser told us, else their connection's, else the event's. */
export const personTz = (o: { browser?: string | null; lead?: string | null; event: string }) => o.browser || o.lead || o.event;

// ───────────── the cadence ─────────────

export type ReminderKind = 'confirm' | 'r24h' | 'r3h' | 'r1h' | 'r10m' | 'live' | 'missing';
export const REMINDER_KINDS: ReminderKind[] = ['confirm', 'r24h', 'r3h', 'r1h', 'r10m', 'live', 'missing'];
export interface Cadence { email: Record<ReminderKind, boolean>; sms: Record<ReminderKind, boolean> }
export const DEFAULT_CADENCE: Cadence = {
  email: { confirm: true, r24h: true, r3h: true, r1h: true, r10m: true, live: true, missing: true },
  // Texts: the confirmation, an hour before, ten minutes before, and "you're missing it" (the 3-texts-a-day cap still applies).
  sms: { confirm: true, r24h: false, r3h: false, r1h: true, r10m: true, live: false, missing: true },
};
export function parseCadence(raw: string | null | undefined): Cadence {
  const out: Cadence = JSON.parse(JSON.stringify(DEFAULT_CADENCE));
  let o: { email?: Record<string, unknown>; sms?: Record<string, unknown> } = {};
  try { o = JSON.parse(raw ?? '{}') ?? {}; } catch { o = {}; }
  for (const ch of ['email', 'sms'] as const) for (const k of REMINDER_KINDS) if (typeof o[ch]?.[k] === 'boolean') out[ch][k] = o[ch]![k] as boolean;
  out.email.confirm = true; // the confirmation carries the room link: always sent
  return out;
}
/** When each reminder is meant to go (the cron sends it on the first run inside its window). */
export function reminderTimes(start: number) {
  return { r24h: start - DAY, r3h: start - 3 * HOUR, r1h: start - HOUR, r10m: start - 10 * MIN, live: start, missing: start + MISSING_AFTER_MIN * MIN };
}

/**
 * Which of the timed reminders are due now for one person (pure). The confirmation, the ticket nudge and the
 * replay emails stay in events.ts; this decides the timed ones.
 *  - Only reminders whose moment came after they registered.
 *  - 24h and 3h wait out the person's quiet hours, as long as they still land before the next reminder.
 *  - "We're live" until ten minutes in; "you're missing it" from five minutes in, for anyone not in the room. When
 *    both are due on the same run, only "you're missing it" goes.
 */
export function dueReminders(start: number, reg: { created_at: number; joined_at: number | null }, o: { now: number; tz: string; quiet: Quiet | null; cadence?: Cadence }) {
  const { now } = o;
  const T = reminderTimes(start);
  const at = (from: number, to: number) => now >= from && now < to;
  const before = (t: number) => reg.created_at < t;
  const quiet = inQuiet(now, o.tz, o.quiet);
  const out: ReminderKind[] = [];
  if (at(T.r24h, T.r3h) && before(T.r24h) && !quiet) out.push('r24h');
  if (at(T.r3h, T.r1h) && before(T.r3h) && !quiet) out.push('r3h');
  if (at(T.r1h, start - 15 * MIN) && before(T.r1h)) out.push('r1h');
  if (at(T.r10m, start + 5 * MIN) && before(T.r10m)) out.push('r10m');
  const missing = at(T.missing, start + 25 * MIN) && !reg.joined_at;
  if (at(start, start + 10 * MIN) && !reg.joined_at && !missing) out.push('live');
  if (missing) out.push('missing');
  return o.cadence ? out.filter((k) => o.cadence!.email[k] || o.cadence!.sms[k]) : out;
}

// ───────────── one person, one moment, two channels at most ─────────────

export interface CallRow { run_at: number; status: string; kind: string; wc_dialed_at?: number | null }
const LIVE_CALL = new Set(['queued', 'dialing', 'done', 'no_answer']);
/**
 * Whether a text may go at `at`: never when an AI call to the same person is queued, dialling or done within
 * CHANNEL_GAP_MIN of it (the email still goes: email plus a call, or email plus a text, never all three).
 */
export function textAllowed(at: number, calls: CallRow[], gapMin = CHANNEL_GAP_MIN) {
  const clash = calls.find((c) => c.kind !== 'test' && LIVE_CALL.has(c.status) && Math.abs((c.wc_dialed_at ?? c.run_at) - at) <= gapMin * MIN);
  return clash ? { ok: false as const, why: `AI call ${clash.kind} at the same time` } : { ok: true as const, why: null };
}
/** The call side: a call that would land within the gap of a text already sent (exact-time calls are skipped, others move after it). */
export function callSlot(runAt: number, textsAt: number[], exactTime: boolean, gapMin = CHANNEL_GAP_MIN) {
  const near = textsAt.filter((t) => Math.abs(t - runAt) <= gapMin * MIN);
  if (!near.length) return { runAt, skip: false };
  if (exactTime) return { runAt, skip: true };
  return { runAt: Math.max(...near) + (gapMin + 1) * MIN, skip: false };
}

// ───────────── subject line A/B (the experiments pattern: sticky hash assignment, z-test in the report) ─────────────

/** The B subject for the reminders under test (A is the subject the email already has). */
export const SUBJECT_B: Partial<Record<ReminderKind, (x: { title: string; when: string }) => string>> = {
  r24h: (x) => `Your seat for tomorrow, ${x.when}`,
  r3h: () => 'Three hours to go, and your room link',
  r1h: () => 'Starting in an hour: your link inside',
  missing: () => 'Josh started five minutes ago',
};
export const AB_KINDS = Object.keys(SUBJECT_B) as ReminderKind[];
/** The variant from a stable hash in [0, 1). */
export const variantOf = (unit: number): 'a' | 'b' => (unit < 0.5 ? 'a' : 'b');

// ───────────── referrals ─────────────

export interface RefSide { lead_id: string; event_id: string; ip_hash: string | null; visitor_id: string | null; email?: string | null }
export type RefVerdict = { status: 'counted' } | { status: 'rejected'; reason: 'self' | 'same_ip' | 'same_browser' | 'over_cap' | 'other_event' };
/** Whether a referred registration counts for the referrer (fraud limits: self, same browser, same connection, other event, cap). */
export function referralVerdict(referrer: RefSide, referred: RefSide, countedSoFar: number, cap = REFERRAL_CAP_DEFAULT): RefVerdict {
  if (referrer.lead_id === referred.lead_id) return { status: 'rejected', reason: 'self' };
  if (referrer.email && referred.email && referrer.email.toLowerCase() === referred.email.toLowerCase()) return { status: 'rejected', reason: 'self' };
  if (referrer.visitor_id && referrer.visitor_id === referred.visitor_id) return { status: 'rejected', reason: 'same_browser' };
  if (referrer.ip_hash && referrer.ip_hash === referred.ip_hash) return { status: 'rejected', reason: 'same_ip' };
  if (referrer.event_id !== referred.event_id) return { status: 'rejected', reason: 'other_event' };
  if (countedSoFar >= cap) return { status: 'rejected', reason: 'over_cap' };
  return { status: 'counted' };
}
export const REFERRAL_REASONS: Record<string, string> = {
  self: 'The same person', same_ip: 'The same connection as the referrer', same_browser: 'The same browser as the referrer', over_cap: 'Over the cap for one person', other_event: 'Registered for a different session',
};
/** A short personal code (no look-alike characters). */
export function refCode(bytes: Uint8Array) {
  const A = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(bytes.slice(0, 8), (b) => A[b % A.length]).join('');
}

// ───────────── after the event ─────────────

/** Buyers already get the deposit welcome (onboarding call first) the moment they pay (sales/deposit.ts); this adds the documents email. */
export type PostKind = 'buyer_docs' | 'nobuy_questions' | 'noshow_highlights';
export type PostPath = 'buyer' | 'attended_nobuy' | 'noshow';
export const postPath = (o: { attended: boolean; bought: boolean }): PostPath => (o.bought ? 'buyer' : o.attended ? 'attended_nobuy' : 'noshow');
/**
 * What is due after the event for one person (pure). Deadlines are the real offer window (closesAt), and an email
 * that would talk about the deadline goes only while more than six hours of it are left.
 */
export function duePost(o: { now: number; end: number; attended: boolean; boughtAt: number | null; offerOpened: boolean; offerOpen: boolean; closesAt: number; replayClosesAt: number }) {
  const { now, end } = o;
  const out: PostKind[] = [];
  if (now < end) return out;
  const path = postPath({ attended: o.attended, bought: Boolean(o.boughtAt) });
  if (path === 'buyer') {
    if (now >= o.boughtAt! + 2 * DAY && now < o.boughtAt! + 9 * DAY) out.push('buyer_docs');
    return out;
  }
  const left = (o.offerOpen ? o.closesAt : o.replayClosesAt) - now;
  if (path === 'attended_nobuy' && o.offerOpen && now >= end + 20 * HOUR && left > 6 * HOUR) out.push('nobuy_questions');
  if (path === 'noshow' && now >= end + 18 * HOUR && now < o.replayClosesAt - 6 * HOUR) out.push('noshow_highlights');
  return out;
}

// ───────────── the show-up funnel and who came back from which reminder ─────────────

export const VIA_LABEL: Record<string, string> = {
  cal: 'Calendar entry', 'e-confirm': 'Email: confirmation', 'e-r24h': 'Email: 24 hours', 'e-r3h': 'Email: 3 hours', 'e-r1h': 'Email: 1 hour', 'e-r10m': 'Email: 10 minutes', 'e-live': 'Email: we’re live',
  'e-missing': 'Email: you’re missing it', 's-confirm': 'Text: confirmation', 's-r1h': 'Text: 1 hour', 's-r10m': 'Text: 10 minutes', 's-live': 'Text: we’re live', 's-missing': 'Text: you’re missing it',
  'e-r3h~b': 'Email: 3 hours (B)', pre: 'Confirmation page', direct: 'No tracked click',
  // Round 4 lifecycle2
  'e-lw': 'Email: lead-in 1 (welcome)', 'e-lq': 'Email: lead-in 2 (question)', 'e-lp': 'Email: lead-in 3 (pre-work)', 'e-le': 'Email: late sign-up essentials', 'e-m1': 'Email: missed live', 'e-m2': 'Email: missed live (second)',
};
export const cleanVia = (v: unknown) => (typeof v === 'string' && /^[a-z0-9~_-]{2,24}$/i.test(v) ? v.toLowerCase() : null);
/** The reminder that brought someone back: their last tracked click in the six hours before they joined. */
export function cameBackVia(joinedAt: number | null, touches: { via: string; at: number }[]) {
  if (!joinedAt) return null;
  const t = touches.filter((x) => x.at <= joinedAt + MIN && x.at >= joinedAt - 6 * HOUR).sort((a, b) => b.at - a.at)[0];
  return t ? t.via.replace(/~[ab]$/, '') : 'direct';
}
export interface FunnelRow { registered: true; cal: boolean; reminded: boolean; joined: boolean; stayed: boolean; bought: boolean }
export function showUpFunnel(rows: FunnelRow[]) {
  const n = (k: keyof FunnelRow) => rows.filter((r) => r[k]).length;
  const steps = [
    { key: 'registered', label: 'Registered', n: rows.length },
    { key: 'cal', label: 'Added it to a calendar', n: n('cal') },
    { key: 'reminded', label: 'Reminded (email or text delivered)', n: n('reminded') },
    { key: 'joined', label: 'Joined live', n: n('joined') },
    { key: 'stayed', label: 'Stayed half the session or more', n: n('stayed') },
    { key: 'bought', label: 'Bought', n: n('bought') },
  ];
  return steps.map((s, i) => ({ ...s, ofRegistered: rows.length ? s.n / rows.length : null, ofPrev: i && steps[i - 1].n ? s.n / steps[i - 1].n : null }));
}

// ───────────── copy (every string is checked by auditCopy in the tests) ─────────────

export const LC_COPY = {
  eyebrow: 'You’re registered',
  heading: (name: string) => `You’re in${name ? `, ${name}` : ''}.`,
  lede: 'Three small steps now make the session count: put it in your calendar, send Josh your question, and fill in the worksheet.',
  opensIn: 'The waiting room opens in',
  opensAt: 'The waiting room opens 15 minutes before the start, on this same link.',
  calHeading: 'Put it in your calendar',
  calBody: 'The entry carries your personal room link, so the calendar reminder takes you straight in.',
  calGoogle: 'Google',
  calOutlook: 'Outlook',
  calApple: 'Apple',
  calOther: 'Any other calendar (.ics file)',
  calDone: 'Added. If the time changes, the reminder email carries an updated entry.',
  smsHeading: 'Remind me by text',
  smsBody: 'One text an hour before, one ten minutes before, and one if you’re not in the room five minutes after the start.',
  smsConsent: 'Tick the box to agree to texts first. It’s optional.',
  smsOnFile: 'Texts go to your number ending in',
  smsButton: 'Text me the reminders',
  smsPhone: 'Mobile number',
  smsOn: 'Text reminders are on for this session.',
  smsStopped: 'You replied STOP to our texts earlier, so we don’t text this number. Email reminders still come.',
  videoHeading: 'Watch this before',
  videoBody: 'A few minutes that make the session easier to follow.',
  questionHeading: 'What’s your biggest question?',
  questionBody: 'Josh sees these before the session and answers as many as he can live.',
  questionPlaceholder: 'For example: how does seller finance work when the seller wants cash at closing?',
  questionButton: 'Send my question',
  questionSaved: 'Josh has it. You can change it until the session starts.',
  worksheetHeading: 'Your pre-session worksheet',
  worksheetBody: 'Five answers that start your Deal Plan. In the session you complete it as Josh teaches.',
  wsIndustry: 'The industry you’d buy in',
  wsSize: 'The size of business (revenue or profit)',
  wsGeography: 'Where',
  wsOwners: 'Owners you could contact each week',
  wsAction: 'The first thing you’ll do after the session',
  worksheetButton: 'Save my worksheet',
  worksheetSaved: 'Saved. It is waiting in your Deal Plan when you join.',
  referralHeading: 'Bring a business owner',
  referralBody: 'Your personal link registers another owner for this session. When someone you bring attends, you earn Deal momentum points and unlock the owner outreach scripts.',
  referralZoomBody: 'Your personal link registers another owner for this session.',
  referralCopy: 'Copy my link',
  referralCopied: 'Link copied',
  referralShare: 'Share',
  referralCount: (reg: number, came: number) => `${reg} registered through your link${came ? `, ${came} attended` : ''}.`,
  referralNone: 'Nobody has registered through your link yet.',
  shareText: (title: string) => `I’m going to a live session for business owners on buying a competitor with commercial debt, seller finance and seller rollover: ${title}. Register here:`,
  saveFailed: 'That didn’t save. Please try again.',
  enterRoom: 'Open the waiting room',
};

/** Strings in the waiting room (room-lifecycle.js). */
export const LC_ROOM_COPY = {
  notYet: 'The waiting room opens 15 minutes before the start. You can wait here.',
  earlyNote: (n: number) => `You’re early. Being here before the start earns ${n} Deal momentum points.`,
  fromHeading: 'Say where you’re from',
  fromPlaceholder: 'City, country',
  fromButton: 'Add',
  placeError: 'Type a city or a country.',
  placeWait: 'Saved. You can change it again in a few seconds.',
  fromEmpty: 'Nobody has said yet. Be the first.',
  fromCount: (n: number) => (n === 1 ? '1 owner in the room has said where they’re from.' : `${n} owners in the room have said where they’re from.`),
  soundHeading: 'Check your sound',
  soundBody: 'Play a short tone. If you hear it, you’ll hear Josh.',
  soundButton: 'Play a test tone',
  soundAsk: 'Did you hear it?',
  soundYes: 'Yes',
  soundNo: 'No',
  soundOk: 'Your sound works.',
  soundTips: 'Turn your volume up, switch off silent mode on an iPhone, and check the output device if you use Bluetooth headphones. Then play the tone again.',
  preshowHeading: 'Before we start',
  preshowNext: 'Next',
  preqHeading: 'Questions sent before the session',
  preqAdd: 'Add to Q&A',
  preqAdded: 'Added to the Q&A',
  preqNone: 'No questions came in before the session.',
  preqOpen: (n: number) => `Questions from before (${n})`,
  close: 'Close',
};

/** The waiting room loop when the event has no slides of its own. */
export const DEFAULT_SLIDES: { title: string; body: string }[] = [
  { title: 'This session', body: 'How owners buy a competitor with commercial debt, seller finance and seller rollover, and the 1.5x test every deal has to pass.' },
  { title: 'Have these ready', body: 'Last year’s profit for your business, and one competitor you would buy if the money were sorted.' },
  { title: 'Your questions', body: 'Type them in the Q&A tab at any time. Josh answers live after the teaching.' },
  { title: 'Your Deal Plan', body: 'Fill it in as Josh teaches. It saves as you go and arrives in your inbox after the session.' },
];
export function parseSlides(raw: string | null | undefined) {
  try {
    const v = JSON.parse(raw ?? '') as unknown;
    if (Array.isArray(v)) {
      const out = v.map((s) => ({ title: String((s as { title?: unknown })?.title ?? '').replace(/[<>]/g, '').slice(0, 80).trim(), body: String((s as { body?: unknown })?.body ?? '').replace(/[<>]/g, '').slice(0, 280).trim() })).filter((s) => s.title || s.body).slice(0, 12);
      if (out.length) return out;
    }
  } catch { /* defaults */ }
  return DEFAULT_SLIDES.map((s) => ({ ...s }));
}

/** The post-event emails (plain text paragraphs; links are buttons). Real deadlines only: `closes` is null when no offer is open. */
export interface PostCtx {
  name: string; title: string; room: string; closes: string | null; deposit: string; onboarding: string | null; highlights: string[]; replayCloses: string | null;
  /** The person's signed payment link (sales/paylinks.ts), only while the deposit offer is open. */
  pay?: string | null;
}
export function postEmail(kind: PostKind, x: PostCtx) {
  const hi = `Hi ${x.name},`;
  const room = { label: 'Open my room', href: x.room };
  switch (kind) {
    case 'buyer_docs':
      return {
        subject: 'Before your kickoff: the documents to gather', preheader: 'Two years of financials, and your buy box.', heading: 'What to gather before kickoff',
        paras: [hi, 'Your kickoff goes faster with these ready: the last two years of financial statements and tax returns for your business, a current debt schedule, and your answers to the buy box questions from your Deal Plan.', 'Reply to this email with any question. Josh’s team answers within one business day.'],
        button: x.onboarding ? { label: 'Book my onboarding call', href: x.onboarding } : room,
      };
    case 'nobuy_questions':
      return {
        subject: `Before ${x.title} closes: the three questions owners ask`, preheader: x.closes ? `The deposit offer closes ${x.closes}.` : 'Your room has the replay.', heading: 'The three questions owners ask before deciding',
        paras: [hi, 'Owners who came to the session ask three things before they decide.', 'Whether the business they want passes the 1.5x test: your Deal Plan runs it on your own numbers.', 'What happens if they don’t sign a letter of intent in 90 days: the guarantee and its conditions are in your room, in full.', 'Whether the deposit is lost if they change their mind: it is credited in full against the engagement fee, and the refund terms are next to the button.',
          ...(x.closes ? [`The ${x.deposit} deposit from the session closes ${x.closes}. The replay comes down at the same time.`] : [])],
        button: x.closes && x.pay ? { label: 'Secure my place', href: x.pay } : room,
      };
    case 'noshow_highlights':
      return {
        subject: `What you missed: ${x.title}`, preheader: x.replayCloses ? `The replay is up until ${x.replayCloses}.` : 'The replay is in your room.', heading: 'The highlights, and the replay',
        paras: [hi, `You registered for ${x.title} and couldn’t make it. Here is what the session covered, from its agenda.`, ...x.highlights.slice(0, 6).map((h) => `${h}.`),
          ...(x.closes ? [`The ${x.deposit} deposit Josh opened in the session closes ${x.closes}, and the replay comes down at the same time.`] : x.replayCloses ? [`The replay is up until ${x.replayCloses}.`] : [])],
        button: { label: 'Watch the replay', href: x.room },
      };
  }
}

/** The extra reminder emails (3 hours, "you're missing it"); the rest live in events.ts liveEmail. */
export const REMINDER_COPY = {
  r3h: (x: { name: string; title: string; when: string }) => ({ subject: `In three hours: ${x.title}`, preheader: 'Your room link and one thing to have ready.', heading: 'Three hours to go', paras: [`Hi ${x.name},`, `${x.title} starts on ${x.when}.`, 'Have last year’s profit for your business to hand. Josh runs the 1.5x test on a real-sized example, and you can run it on yours in your Deal Plan.'] }),
  missing: (x: { name: string; title: string }) => ({ subject: 'You’re missing it: Josh is live', preheader: 'Five minutes in. Your seat is still there.', heading: 'Josh started five minutes ago', paras: [`Hi ${x.name},`, `${x.title} is live now and your seat is still there. The first part covers where the businesses are and how the purchase gets funded.`] }),
  r3hText: (x: { site: string; title: string }) => `${x.site}: ${x.title} starts in 3 hours. Your room:`,
  missingText: (x: { site: string }) => `${x.site}: Josh went live 5 minutes ago and your seat is still there. Your room:`,
  calendarLine: 'Add it to your calendar:',
  newTimeHeading: 'The session has a new time',
  newTime: (x: { title: string; when: string }) => `${x.title} has moved to ${x.when}. Your room link stays the same. The calendar buttons below update the entry you already have.`,
  cancelledSubject: (title: string) => `Cancelled: ${title}`,
  cancelled: (x: { title: string }) => `${x.title} is cancelled. The calendar link below removes it from your calendar. Josh’s team emails you the new date.`,
};
