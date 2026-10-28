import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { requireAdmin } from './auth';
import { parseFilters } from './stats';
import { fromMinor, passConfig } from '../webinar/pass';
import { dealSprintBoard, draftEngagement, payPlanOf, updateDealSprint, updateDeliverable } from '../webinar/deal-sprint';

/** Funnel HQ → Sprint board and the ladder report. Mounted at /admin/api/deal-sprint (admin-only). */
export const dealSprintAdmin = new Hono<AppEnv>();
dealSprintAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const out = (c: { json: (v: unknown, s?: number) => Response }, r: { ok: boolean; error?: string }) => c.json(r, r.ok ? 200 : 400);

dealSprintAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const f = parseFilters(c.req.query());
  const [board, ladder] = await Promise.all([dealSprintBoard(rt), ladderReport(rt, { from: f.from, to: f.to })]);
  return c.json({ ...board, ladder });
});
dealSprintAdmin.get('/ladder', async (c) => { const f = parseFilters(c.req.query()); return c.json(await ladderReport(runtimeFrom(c), { from: f.from, to: f.to })); });
dealSprintAdmin.put('/:id', async (c) => out(c, await updateDealSprint(runtimeFrom(c), c.req.param('id'), await body(c))));
dealSprintAdmin.put('/:id/deliverables/:key', async (c) => out(c, await updateDeliverable(runtimeFrom(c), c.req.param('id'), c.req.param('key'), await body(c))));
dealSprintAdmin.post('/:id/agreement', async (c) => out(c, await draftEngagement(runtimeFrom(c), c.req.param('id'))));

/**
 * The value ladder for a date range, each step counted by when it happened:
 * registered → bought a ticket → watched → reached the offer → bought the Sprint → Deal Plan session held → engagement signed.
 * Revenue per registrant and per ticket is the number that says whether the whole ladder pays for the ads.
 */
export async function ladderReport(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const cur = passConfig(rt.settings).currency;
  const safe = <T>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
  type Money = { n: number | null; revenue: number | null };
  const [regs, tickets, watched, unlocked, sprints, sprintRows, plans, engagements] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT lead_id) AS people FROM webinar_registrations WHERE created_at BETWEEN ? AND ?').bind(range.from, range.to).first<{ n: number; people: number }>(),
    db.prepare("SELECT COUNT(*) AS n, SUM(amount - refunded_amount) AS revenue FROM webinar_passes WHERE kind = 'seat' AND status = 'paid' AND paid_at BETWEEN ? AND ?").bind(range.from, range.to).first<Money>(),
    db.prepare('SELECT COUNT(DISTINCT lead_id) AS n FROM webinar_registrations WHERE (joined_at IS NOT NULL OR replay_at IS NOT NULL) AND created_at BETWEEN ? AND ?').bind(range.from, range.to).first<{ n: number }>(),
    // Part 2 logs webinar_offer_unlocked when the offer opens in the room. Null until it exists.
    safe(db.prepare("SELECT COUNT(DISTINCT COALESCE(lead_id, visitor_id)) AS n FROM events WHERE name = 'webinar_offer_unlocked' AND is_bot = 0 AND ts BETWEEN ? AND ?").bind(range.from, range.to).first<{ n: number }>(), null),
    db.prepare("SELECT COUNT(*) AS n, SUM(amount - refunded_amount) AS revenue FROM webinar_passes WHERE kind = 'offer' AND status = 'paid' AND paid_at BETWEEN ? AND ?").bind(range.from, range.to).first<Money>(),
    db.prepare("SELECT * FROM webinar_passes WHERE kind = 'offer' AND status = 'paid' AND paid_at BETWEEN ? AND ? LIMIT 2000").bind(range.from, range.to).all<Record<string, unknown>>(),
    db.prepare('SELECT COUNT(*) AS n FROM deal_sprints WHERE plan_held_at BETWEEN ? AND ?').bind(range.from, range.to).first<{ n: number }>(),
    // Engagements signed by Sprint buyers. Revenue is net of the Sprint credit (the credit was already counted as Sprint revenue).
    db.prepare(
      `SELECT COUNT(*) AS n, SUM(fee) AS gross, SUM(fee - COALESCE(credit_amount, 0)) AS net, SUM(paid_at IS NOT NULL) AS paid,
              SUM(CASE WHEN paid_at IS NOT NULL THEN fee - COALESCE(credit_amount, 0) ELSE 0 END) AS paid_net
         FROM contracts k WHERE status = 'signed' AND COALESCE(is_test, 0) = 0 AND signed_at BETWEEN ? AND ?
          AND EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = k.lead_id AND p.kind = 'offer' AND p.status IN ('paid', 'refunded'))`,
    ).bind(range.from, range.to).first<{ n: number; gross: number | null; net: number | null; paid: number | null; paid_net: number | null }>(),
  ]);
  const money = (minor: number | null | undefined) => fromMinor(minor ?? 0, cur);
  const plansSeen = sprintRows.results.map(payPlanOf);
  const split = plansSeen.some((x) => x !== null) ? { plan: plansSeen.filter((x) => x === 'plan').length, full: plansSeen.filter((x) => x === 'full').length } : null;
  const ticketRev = money(tickets?.revenue), sprintRev = money(sprints?.revenue), engRev = engagements?.net ?? 0;
  const total = ticketRev + sprintRev + engRev;
  const registrants = regs?.people ?? 0, ticketN = tickets?.n ?? 0;
  const steps = [
    { key: 'registered', label: 'Registered', n: registrants, revenue: null as number | null },
    { key: 'tickets', label: 'Bought a ticket', n: ticketN, revenue: ticketRev },
    { key: 'watched', label: 'Watched (live or replay)', n: watched?.n ?? 0, revenue: null },
    { key: 'unlocked', label: 'Reached the offer unlock', n: unlocked ? unlocked.n ?? 0 : null, revenue: null },
    { key: 'sprints', label: 'Bought the First Deal Sprint', n: sprints?.n ?? 0, revenue: sprintRev },
    { key: 'plan_held', label: 'Deal Plan session held', n: plans?.n ?? 0, revenue: null },
    { key: 'engagements', label: 'Engagement signed', n: engagements?.n ?? 0, revenue: engRev },
  ];
  return {
    currency: cur,
    steps,
    sprintSplit: split,
    engagements: { signed: engagements?.n ?? 0, paid: engagements?.paid ?? 0, gross: engagements?.gross ?? 0, net: engRev, paidNet: engagements?.paid_net ?? 0 },
    revenue: { tickets: ticketRev, sprints: sprintRev, engagements: engRev, total },
    perRegistrant: registrants ? total / registrants : null,
    perTicket: ticketN ? total / ticketN : null,
    unlockTracked: Boolean(unlocked),
  };
}
