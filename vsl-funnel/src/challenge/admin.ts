import { type Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { REVENUE_LABEL } from '../sales/qualify';
import { fromMinor } from '../webinar/pass';
import { DAY_TITLES, dayContent } from './content';
import { CohortError, challengeConfig, createCohort, getDays, loadCohort, syncLiveEvents, updateCohort, updateDay } from './cohorts';
import { retimeCohort } from './emails';
import { cohortOffer, setOffer } from './offer';
import { teamDayChat } from './room';
import { type DayRow, DAYS_IN_CHALLENGE, dayEnds, dayPhase, eventKey, localParts, offerCloseAt } from './schedule';

/**
 * Funnel HQ → Challenge: cohorts (create, re-time, links per day), registrants with VIP, attendance,
 * worksheets and deposits, the VIP hot seat queue and worksheet reviews, the offer switch for Days 4 and 5,
 * and the report per cohort and per day. Mounted at /admin/api/challenge (admin only).
 */
export const challengeAdmin = new Hono<AppEnv>();

const json = async (c: Context<AppEnv>) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
const err = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof CohortError) return c.json({ ok: false, error: e.message, field: e.field ?? null }, 400);
  console.error('challenge admin', e);
  return c.json({ ok: false, error: e instanceof Error ? e.message : 'Something went wrong' }, 500);
};

interface Stats {
  registered: number; pending: number; refunded: number; vip: number; vipRate: number | null;
  deposits: number; depositsStarted: number; revenue: number; ticketRevenue: number; vipRevenue: number; depositRevenue: number; perRegistrant: number | null;
  days: { day: number; title: string; live: number; replay: number; attended: number; homework: number; liveRate: number | null; homeworkRate: number | null }[];
}

/** The report for one cohort (pure maths over its rows; money in major units of the challenge currency). */
export function cohortStats(o: {
  regs: { id: string; status: string; vip: number }[];
  progress: { reg_id: string; day: number; joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }[];
  orders: { reg_id: string; kind: string; status: string; amount: number; refunded_amount: number; currency: string }[];
  deposits: { reg_id: string; paid_at: number | null; amount: number | null; currency: string | null }[];
}): Stats {
  const paid = o.regs.filter((r) => r.status === 'paid');
  const ids = new Set(paid.map((r) => r.id));
  const major = (minor: number, cur: string) => fromMinor(minor, cur);
  const net = (k: string) => o.orders.filter((x) => x.kind === k && (x.status === 'paid' || x.status === 'refunded')).reduce((a, x) => a + major(x.amount - x.refunded_amount, x.currency), 0);
  const ticketRevenue = net('ticket');
  const vipRevenue = net('vip');
  const depPaid = o.deposits.filter((d) => d.paid_at);
  const depositRevenue = depPaid.reduce((a, d) => a + (d.amount ? major(d.amount, d.currency ?? 'usd') : 0), 0);
  const revenue = ticketRevenue + vipRevenue + depositRevenue;
  const vip = paid.filter((r) => r.vip).length;
  const days = Array.from({ length: DAYS_IN_CHALLENGE }, (_, i) => {
    const rows = o.progress.filter((p) => p.day === i + 1 && ids.has(p.reg_id));
    const live = rows.filter((p) => p.joined_at || p.present_at).length;
    const replay = rows.filter((p) => !(p.joined_at || p.present_at) && p.replay_at).length;
    const homework = rows.filter((p) => p.homework_at).length;
    return { day: i + 1, title: DAY_TITLES[i], live, replay, attended: live + replay, homework, liveRate: paid.length ? live / paid.length : null, homeworkRate: paid.length ? homework / paid.length : null };
  });
  return {
    registered: paid.length, pending: o.regs.filter((r) => r.status === 'pending').length, refunded: o.regs.filter((r) => r.status === 'refunded').length,
    vip, vipRate: paid.length ? vip / paid.length : null,
    deposits: depPaid.length, depositsStarted: o.deposits.length,
    revenue, ticketRevenue, vipRevenue, depositRevenue, perRegistrant: paid.length ? revenue / paid.length : null, days,
  };
}

async function statsFor(rt: Runtime, cohortId: string) {
  const db = rt.env.DB;
  const [regs, progress, orders, deposits] = await db.batch([
    db.prepare('SELECT id, status, vip FROM challenge_registrations WHERE cohort_id = ?').bind(cohortId),
    db.prepare('SELECT p.* FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE r.cohort_id = ?').bind(cohortId),
    db.prepare('SELECT o.reg_id, o.kind, o.status, o.amount, o.refunded_amount, o.currency FROM challenge_orders o JOIN challenge_registrations r ON r.id = o.reg_id WHERE r.cohort_id = ?').bind(cohortId),
    db.prepare('SELECT reg_id, paid_at, amount, currency FROM challenge_deposits WHERE cohort_id = ?').bind(cohortId),
  ]);
  return cohortStats({ regs: regs.results as never, progress: progress.results as never, orders: orders.results as never, deposits: deposits.results as never });
}

const dayOut = (d: DayRow, tz: string, now: number) => ({
  ...d, ...localParts(d.starts_at, tz), ends_at: dayEnds(d), phase: dayPhase(d, now), title: DAY_TITLES[d.day - 1], key: eventKey(d.cohort_id, d.day), host: `/admin/live/${eventKey(d.cohort_id, d.day)}`,
});

/** Setup notes for the tab: what the owner still has to do for the challenge to sell and run. */
function notes(rt: Runtime) {
  const cfg = challengeConfig(rt.settings);
  const out: { level: 'warn' | 'info'; text: string }[] = [];
  if (!cfg.provider && !cfg.free) out.push({ level: 'warn', text: 'Whop isn’t connected, so the ticket can’t be sold. Add the Whop API key under Integrations → Webinar and press Connect Whop.' });
  if (!rt.settings.RESEND_API_KEY) out.push({ level: 'warn', text: 'No email provider: confirmations and reminders are simulated until Resend is connected (Integrations → Email).' });
  out.push({ level: 'info', text: 'The guarantee wording shown with the offer comes from the deposit settings and is marked for legal review there.' });
  return out;
}

challengeAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const now = Date.now();
  const cfg = challengeConfig(rt.settings);
  const { results } = await rt.env.DB.prepare("SELECT * FROM challenge_cohorts ORDER BY start_date DESC LIMIT 40").all<Record<string, unknown> & { id: string; timezone: string }>();
  const cohorts = [];
  for (const co of results) {
    const days = await getDays(rt, co.id);
    const closeAt = offerCloseAt(days, cfg.offerHours);
    cohorts.push({ ...co, days: days.map((d) => dayOut(d, co.timezone, now)), closeAt, offer: await cohortOffer(rt, co.id, now), stats: await statsFor(rt, co.id) });
  }
  return c.json({
    now, cohorts, notes: notes(rt),
    config: { ticket: cfg.ticketLabel, vip: cfg.vipOn ? cfg.vipLabel : null, currency: cfg.currency, offerHours: cfg.offerHours, durationMin: cfg.durationMin, defaultTz: cfg.defaultTz, provider: cfg.provider },
    landing: `${rt.origin}/challenge`,
  });
});

challengeAdmin.post('/cohorts', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const id = await createCohort(rt, await json(c));
    await syncLiveEvents(rt, id);
    return c.json({ ok: true, id });
  } catch (e) { return err(c, e); }
});

challengeAdmin.patch('/cohorts/:id', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const id = c.req.param('id');
    if (await updateCohort(rt, id, await json(c))) { await syncLiveEvents(rt, id); await retimeCohort(rt, id); }
    return c.json({ ok: true });
  } catch (e) { return err(c, e); }
});

challengeAdmin.patch('/cohorts/:id/days/:n', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const id = c.req.param('id');
    const r = await updateDay(rt, id, Number(c.req.param('n')), await json(c));
    if (r.moved) await retimeCohort(rt, id);
    return c.json({ ok: true, ...r });
  } catch (e) { return err(c, e); }
});

/** One cohort in full: registrants with per-day progress, worksheets, hot seat questions. */
challengeAdmin.get('/cohorts/:id', async (c) => {
  const rt = runtimeFrom(c);
  const L = await loadCohort(rt, c.req.param('id'));
  if (!L) return c.json({ error: 'not found' }, 404);
  const db = rt.env.DB;
  const id = L.cohort.id;
  const [regs, progress, hw, hot, deps, orders] = await db.batch([
    db.prepare(`SELECT r.*, l.first_name, l.last_name, l.email, l.phone FROM challenge_registrations r JOIN leads l ON l.id = r.lead_id WHERE r.cohort_id = ? ORDER BY r.created_at DESC LIMIT 1000`).bind(id),
    db.prepare('SELECT p.* FROM challenge_progress p JOIN challenge_registrations r ON r.id = p.reg_id WHERE r.cohort_id = ?').bind(id),
    db.prepare(`SELECT h.*, l.first_name, l.last_name, l.email, r.vip FROM challenge_homework h JOIN challenge_registrations r ON r.id = h.reg_id JOIN leads l ON l.id = r.lead_id WHERE h.cohort_id = ? ORDER BY h.updated_at DESC LIMIT 1000`).bind(id),
    db.prepare(`SELECT s.*, l.first_name, l.last_name, l.email FROM challenge_hot_seats s JOIN challenge_registrations r ON r.id = s.reg_id JOIN leads l ON l.id = r.lead_id WHERE s.cohort_id = ? ORDER BY s.day, s.created_at`).bind(id),
    db.prepare('SELECT * FROM challenge_deposits WHERE cohort_id = ?').bind(id),
    db.prepare(`SELECT o.reg_id, o.kind, o.status, o.amount, o.currency, o.method, o.paid_at FROM challenge_orders o JOIN challenge_registrations r ON r.id = o.reg_id WHERE r.cohort_id = ? AND o.status IN ('paid', 'refunded')`).bind(id),
  ]);
  const name = (r: Record<string, unknown>) => [r.first_name, r.last_name].filter(Boolean).join(' ') || String(r.email ?? 'Someone');
  const prog = progress.results as { reg_id: string; day: number; joined_at: number | null; present_at: number | null; replay_at: number | null; homework_at: number | null }[];
  const dep = deps.results as { reg_id: string; started_at: number; paid_at: number | null }[];
  return c.json({
    cohort: L.cohort, closeAt: L.closeAt, days: L.days.map((d) => dayOut(d, L.cohort.timezone, Date.now())),
    registrants: (regs.results as Record<string, unknown>[]).map((r) => ({
      id: r.id, lead_id: r.lead_id, name: name(r), email: r.email, band: REVENUE_LABEL[String(r.revenue_band)] ?? r.revenue_band, status: r.status, vip: Boolean(r.vip), paid_at: r.paid_at, created_at: r.created_at,
      days: Array.from({ length: 5 }, (_, i) => { const p = prog.find((x) => x.reg_id === r.id && x.day === i + 1); return { live: Boolean(p && (p.joined_at || p.present_at)), replay: Boolean(p?.replay_at), homework: Boolean(p?.homework_at) }; }),
      deposit: (() => { const d = dep.find((x) => x.reg_id === r.id); return d ? (d.paid_at ? 'paid' : 'started') : null; })(),
      orders: (orders.results as { reg_id: string; kind: string; status: string; amount: number; currency: string; method: string }[]).filter((o) => o.reg_id === r.id).map((o) => ({ kind: o.kind, status: o.status, method: o.method, amount: fromMinor(o.amount, o.currency) })),
    })),
    homework: (hw.results as Record<string, unknown>[]).map((h) => {
      let answers: Record<string, string> = {};
      try { answers = JSON.parse(String(h.answers)); } catch { /* empty */ }
      const fields = dayContent(Number(h.day))?.worksheet.fields ?? [];
      return { reg_id: h.reg_id, day: h.day, name: name(h), email: h.email, vip: Boolean(h.vip), answers: fields.filter((f) => answers[f.key]).map((f) => ({ label: f.label, value: answers[f.key] })), review: h.review, reviewed_at: h.reviewed_at, updated_at: h.updated_at };
    }),
    hotSeats: (hot.results as Record<string, unknown>[]).map((s) => ({ id: s.id, day: s.day, name: name(s), email: s.email, question: s.question, done: Boolean(s.done_at), created_at: s.created_at })),
    stats: await statsFor(rt, id),
    offer: await cohortOffer(rt, id),
  });
});

/** Open or close the deposit offer for a challenge day (Days 4 and 5). Also used by the host console. */
challengeAdmin.post('/offer/:key', async (c) => {
  const b = await json(c);
  return c.json(await setOffer(runtimeFrom(c), c.req.param('key'), b.open === true));
});

challengeAdmin.get('/offer/:key', async (c) => {
  const key = c.req.param('key');
  const m = /^challenge:([^:]+):(\d)$/.exec(key);
  if (!m) return c.json({ error: 'not found' }, 404);
  const rt = runtimeFrom(c);
  const [hot, vip] = await Promise.all([
    rt.env.DB.prepare(`SELECT s.id, s.question, s.done_at, l.first_name, l.last_name FROM challenge_hot_seats s JOIN challenge_registrations r ON r.id = s.reg_id JOIN leads l ON l.id = r.lead_id WHERE s.cohort_id = ? AND s.day = ? ORDER BY s.created_at`).bind(m[1], Number(m[2])).all<Record<string, unknown>>(),
    rt.env.DB.prepare("SELECT COUNT(*) AS n FROM challenge_registrations WHERE cohort_id = ? AND status = 'paid' AND vip = 1").bind(m[1]).first<{ n: number }>(),
  ]);
  return c.json({ key, day: Number(m[2]), offer: await cohortOffer(rt, m[1]), canOffer: Number(m[2]) >= 4, vip: vip?.n ?? 0, hotSeats: hot.results.map((s) => ({ id: s.id, name: [s.first_name, s.last_name].filter(Boolean).join(' '), question: s.question, done: Boolean(s.done_at) })) });
});

challengeAdmin.post('/chat/:key', async (c) => c.json(await teamDayChat(runtimeFrom(c), c.req.param('key'), await json(c))));

/** The team's written review of a VIP worksheet (shown on that person's day page). */
challengeAdmin.patch('/homework/:reg/:day', async (c) => {
  const b = await json(c);
  const text = typeof b.review === 'string' ? b.review.replace(/[<>]/g, '').trim().slice(0, 4000) : '';
  const by = typeof b.by === 'string' ? b.by.replace(/[<>]/g, '').trim().slice(0, 60) : 'Josh’s team';
  const r = await runtimeFrom(c).env.DB.prepare('UPDATE challenge_homework SET review = ?, reviewed_by = ?, reviewed_at = ? WHERE reg_id = ? AND day = ?')
    .bind(text || null, text ? by || 'Josh’s team' : null, text ? Date.now() : null, c.req.param('reg'), Number(c.req.param('day'))).run();
  return c.json({ ok: (r.meta.changes ?? 0) > 0 });
});

challengeAdmin.patch('/hot/:id', async (c) => {
  const b = await json(c);
  await runtimeFrom(c).env.DB.prepare('UPDATE challenge_hot_seats SET done_at = ? WHERE id = ?').bind(b.done === false ? null : Date.now(), c.req.param('id')).run();
  return c.json({ ok: true });
});

