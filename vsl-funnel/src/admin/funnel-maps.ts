import type { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { SETTINGS } from '../settings';
import { SEQUENCES } from '../integrations/sequences';
import { LONG_FLOWS } from '../longflow';
import { LONG_STEP } from '../longflow/engine';
import { LIVE_STEP } from '../live/events';
import { fromMinor } from '../webinar/pass';
import { overview, parseFilters } from './stats';
import { type Automation, FUNNEL_MAPS, type FunnelMapDef, type Stage, mapById } from './funnel-maps-defs';

/**
 * Funnel HQ → Funnel map: live numbers, settings and layouts for every funnel map (definitions in
 * funnel-maps-defs.ts). Every count comes from our own tables for the selected date range: a stage whose
 * event happened inside the range is counted (the same rule as the Overview tab). A table a fresh install
 * lacks counts as "not counted", never as a made-up number.
 *
 *  GET  /admin/api/maps                   every map with its stage strip and counts (the overview)
 *  GET  /admin/api/maps/:id               one map: stages, counts, conversion, automations, settings
 *  GET  /admin/api/maps/:id/layout|custom saved box positions / your own boxes and notes (shared)
 *  PUT  /admin/api/maps/:id/layout|custom
 * The VSL map keeps the keys the single map used (map:layout, map:custom), so saved layouts still load.
 */

export interface Count { n: number | null; unit: string; revenue?: number; currency?: string }
type Counts = Record<string, Count>;
interface Range { from: number; to: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const PAID = "status IN ('paid', 'refunded')";
const SENT = "status IN ('sent', 'simulated')";

function counter(rt: Runtime, r: Range) {
  const db = rt.env.DB;
  /** One number, or null when the query fails (a table this install doesn't have yet). */
  const one = async (sql: string, args: (string | number)[] = [r.from, r.to]): Promise<number | null> => {
    try { const row = await db.prepare(sql).bind(...args).first<{ n: unknown }>(); return num(row?.n); } catch { return null; }
  };
  const money = async (sql: string, args: (string | number)[] = [r.from, r.to]) => {
    try {
      const { results } = await db.prepare(sql).bind(...args).all<{ n: unknown; amount: unknown; currency: string | null }>();
      if (!results.length) return { n: 0, revenue: 0, currency: undefined as string | undefined };
      let n = 0, revenue = 0, currency: string | undefined;
      for (const x of results) { n += num(x.n); const cur = String(x.currency || 'usd'); revenue += fromMinor(num(x.amount), cur); currency ??= cur.toUpperCase(); }
      return { n, revenue, currency };
    } catch { return null; }
  };
  const c = (n: number | null, unit: string): Count => ({ n, unit });
  const m = (x: Awaited<ReturnType<typeof money>>, unit: string): Count => (x ? { n: x.n, unit, revenue: x.revenue, currency: x.currency } : { n: null, unit });
  return { one, money, c, m };
}

const visitorsWhere = (where: string) => `SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE started_at BETWEEN ? AND ? AND is_bot = 0 AND ${where}`;
const pageVisitors = (path: string) => `SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE ts BETWEEN ? AND ? AND is_bot = 0 AND name = 'page_view' AND path = '${path}'`;
const signedWhere = (leadSql: string) => `SELECT COUNT(*) AS n FROM contracts WHERE signed_at BETWEEN ? AND ? AND COALESCE(is_test, 0) = 0 AND voided_at IS NULL AND lead_id IN (${leadSql})`;

async function vslCounts(rt: Runtime, r: Range, query: Record<string, string>): Promise<Counts> {
  const { one, c } = counter(rt, r);
  let ov: Awaited<ReturnType<typeof overview>> | null = null;
  try { ov = await overview(rt.env, parseFilters({ ...query, from: String(r.from), to: String(r.to) })); } catch { ov = null; }
  const f: Record<string, number> = {};
  for (const x of ov?.funnel ?? []) f[x.key] = x.n;
  const k = ov?.kpis;
  const kn = (v: number | undefined) => (k ? v ?? 0 : null);
  const [meta, video, organic, main, direct, lost] = await Promise.all([
    one(visitorsWhere("channel = 'Paid Social'")),
    one(visitorsWhere("channel IN ('Organic Video', 'Paid Video')")),
    one(visitorsWhere("channel IN ('Direct', 'Organic Search', 'Organic Social', 'Referral', 'AI Search')")),
    one(visitorsWhere("landing_path = '/'")),
    one("SELECT COUNT(*) AS n FROM leads WHERE booked_at BETWEEN ? AND ? AND booking_source = 'calendly-direct'"),
    one("SELECT COUNT(*) AS n FROM leads WHERE status = 'lost' AND COALESCE(closed_at, updated_at) BETWEEN ? AND ?"),
  ]);
  return {
    meta: c(meta, 'visitors'), video: c(video, 'visitors'), organic: c(organic, 'visitors'), main: c(main, 'visitors'), direct_booked: c(direct, 'direct bookings'),
    landing: c(ov ? f.landing ?? 0 : null, 'landed on a VSL page'), play: c(ov ? f.play ?? 0 : null, 'played the video'), lead: c(ov ? f.lead ?? 0 : null, 'gave contact details'),
    applied: c(ov ? f.applied ?? 0 : null, 'submitted'), qualified: c(ov ? f.qualified ?? 0 : null, 'qualified (A + B)'),
    tier_a: c(kn(k?.tier_a), 'A-tier'), tier_b: c(kn(k?.tier_b), 'B-tier'), tier_c: c(kn(k?.tier_c), 'C-tier'),
    booked: c(kn(k?.booked), 'booked'), cancelled: c(kn(k?.cancelled), 'cancelled'), showed: c(kn(k?.showed), 'calls held'), no_show: c(kn(k?.no_show), 'no-shows'),
    won: k ? { n: k.won ?? 0, unit: 'won', revenue: k.revenue ?? 0 } : c(null, 'won'), lost: c(lost, 'lost'),
  };
}

async function autoCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, money, c, m } = counter(rt, r);
  const offerIds = "SELECT id FROM webinar_passes WHERE kind = 'offer'";
  const [landing, reg, ticket, attended, unlocked, sprint, plan, proposal, signed, missed, replay] = await Promise.all([
    one("SELECT COUNT(DISTINCT visitor_id) AS n FROM events WHERE ts BETWEEN ? AND ? AND is_bot = 0 AND name = 'webinar_headline_view'"),
    one('SELECT COUNT(*) AS n FROM webinar_registrations WHERE created_at BETWEEN ? AND ?'),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM webinar_passes WHERE kind = 'seat' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    one('SELECT COUNT(*) AS n FROM webinar_registrations WHERE joined_at BETWEEN ?1 AND ?2 OR replay_at BETWEEN ?1 AND ?2'),
    one('SELECT COUNT(*) AS n FROM webinar_registrations WHERE offer_unlocked_at BETWEEN ? AND ?'),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM webinar_passes WHERE kind = 'offer' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    one('SELECT COUNT(*) AS n FROM deal_sprints WHERE plan_held_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM deal_sprints WHERE proposal_sent_at BETWEEN ? AND ?'),
    one(`SELECT COUNT(*) AS n FROM contracts WHERE signed_at BETWEEN ? AND ? AND COALESCE(is_test, 0) = 0 AND voided_at IS NULL AND credit_pass_id IN (${offerIds})`),
    one('SELECT COUNT(*) AS n FROM webinar_registrations g JOIN webinar_sessions s ON s.id = g.session_id WHERE s.starts_at BETWEEN ? AND ? AND s.starts_at < ? AND g.joined_at IS NULL', [r.from, r.to, Date.now()]),
    one('SELECT COUNT(*) AS n FROM webinar_registrations WHERE replay_at BETWEEN ? AND ?'),
  ]);
  return {
    landing: c(landing, 'saw the registration page'), registered: c(reg, 'registrations'), ticket: m(ticket, 'tickets paid'), attended: c(attended, 'watched live or replay'),
    unlocked: c(unlocked, 'reached the pitch'), sprint: m(sprint, 'Sprints bought'), plan_held: c(plan, 'Deal Plan sessions held'), proposal: c(proposal, 'proposals sent'),
    signed: c(signed, 'signed with Sprint credit'), missed: c(missed, 'didn’t join'), replay: c(replay, 'opened the replay'),
  };
}

async function liveCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, money, c, m } = counter(rt, r);
  const [landing, reg, ticket, joined, seen, deposit, signed, replay] = await Promise.all([
    one(pageVisitors('/live')),
    one('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE created_at BETWEEN ? AND ?'),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM webinar_passes WHERE kind = 'live_ticket' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    one('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE joined_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE offer_seen_at BETWEEN ? AND ?'),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM webinar_passes WHERE kind = 'deposit' AND source = 'live' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    one(signedWhere("SELECT lead_id FROM webinar_passes WHERE kind = 'deposit' AND source = 'live' AND status = 'paid'")),
    one('SELECT COUNT(*) AS n FROM live_webinar_regs WHERE replay_at BETWEEN ? AND ?'),
  ]);
  return {
    landing: c(landing, 'visitors'), registered: c(reg, 'registrations'), ticket: m(ticket, 'tickets paid'), joined: c(joined, 'opened their room'),
    offer_seen: c(seen, 'saw the offer'), deposit: m(deposit, 'deposits paid'), signed: c(signed, 'signed'), replay: c(replay, 'opened the replay'),
  };
}

async function challengeCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, money, c, m } = counter(rt, r);
  const day = (n: number) => one(`SELECT COUNT(*) AS n FROM challenge_progress WHERE day = ${n} AND (present_at BETWEEN ?1 AND ?2 OR replay_at BETWEEN ?1 AND ?2)`);
  const [landing, reg, ticket, vip, d1, d2, d3, d4, d5, homework, hotseat, deposit, signed] = await Promise.all([
    one(pageVisitors('/challenge')),
    one('SELECT COUNT(*) AS n FROM challenge_registrations WHERE created_at BETWEEN ? AND ?'),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM challenge_orders WHERE kind = 'ticket' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    money(`SELECT COUNT(*) AS n, SUM(amount - COALESCE(refunded_amount, 0)) AS amount, currency FROM challenge_orders WHERE kind = 'vip' AND ${PAID} AND paid_at BETWEEN ? AND ? GROUP BY currency`),
    day(1), day(2), day(3), day(4), day(5),
    one('SELECT COUNT(*) AS n FROM challenge_homework WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM challenge_hot_seats WHERE created_at BETWEEN ? AND ?'),
    money('SELECT COUNT(*) AS n, SUM(amount) AS amount, currency FROM challenge_deposits WHERE paid_at BETWEEN ? AND ? GROUP BY currency'),
    one(signedWhere('SELECT lead_id FROM challenge_deposits WHERE paid_at IS NOT NULL')),
  ]);
  return {
    landing: c(landing, 'visitors'), registered: c(reg, 'signed up'), ticket: m(ticket, 'tickets paid'), vip: m(vip, 'VIP upgrades'),
    day1: c(d1, 'attended'), day2: c(d2, 'attended'), day3: c(d3, 'attended'), day4: c(d4, 'attended'), day5: c(d5, 'attended'),
    homework: c(homework, 'worksheets'), hotseat: c(hotseat, 'hot seat questions'), deposit: m(deposit, 'deposits paid'), signed: c(signed, 'signed'),
  };
}

async function dmCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, c } = counter(rt, r);
  const t = (where: string) => one(`SELECT COUNT(*) AS n FROM dm_threads WHERE ${where}`);
  const [comment, story, dm, threads, hot, replied, booked, showed, closed, lost] = await Promise.all([
    t("source = 'comment' AND created_at BETWEEN ? AND ?"), t("source IN ('story_reply', 'story_mention') AND created_at BETWEEN ? AND ?"), t("source = 'dm' AND created_at BETWEEN ? AND ?"),
    t('created_at BETWEEN ? AND ?'), t("band = 'hot' AND created_at BETWEEN ? AND ?"), t('replied_at BETWEEN ? AND ?'), t('booked_at BETWEEN ? AND ?'), t('showed_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM dm_threads WHERE closed_at BETWEEN ? AND ?'),
    t('lost_at BETWEEN ? AND ?'),
  ]);
  const value = await one('SELECT SUM(COALESCE(deal_value, 0)) AS n FROM dm_threads WHERE closed_at BETWEEN ? AND ?');
  return {
    src_comment: c(comment, 'conversations'), src_story: c(story, 'conversations'), src_dm: c(dm, 'conversations'), threads: c(threads, 'new conversations'),
    hot: c(hot, 'Hot'), replied: c(replied, 'replied to'), booked: c(booked, 'booked'), showed: c(showed, 'held'), closed: closed == null ? c(null, 'closed') : { n: closed, unit: 'closed', revenue: value ?? 0 }, lost: c(lost, 'lost'),
  };
}

async function nurtureCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, c } = counter(rt, r);
  const flows = Object.keys(LONG_FLOWS).map((k) => `'${k}'`).join(', ');
  const [short, long, behaviour, launched, back, sms, batch] = await Promise.all([
    one(`SELECT COUNT(*) AS n FROM emails WHERE sequence IN (${flows}) AND step < ${LONG_STEP} AND ${SENT} AND sent_at BETWEEN ? AND ?`),
    one(`SELECT COUNT(*) AS n FROM emails WHERE sequence IN (${flows}) AND step >= ${LONG_STEP} AND ${SENT} AND sent_at BETWEEN ? AND ?`),
    one(`SELECT COUNT(*) AS n FROM emails WHERE sequence = 'behaviour' AND ${SENT} AND sent_at BETWEEN ? AND ?`),
    one('SELECT COUNT(*) AS n FROM lead_reactivation WHERE reactivated_at BETWEEN ? AND ?'),
    one(`SELECT COUNT(*) AS n FROM lead_reactivation x JOIN leads l ON l.id = x.lead_id WHERE x.reactivated_at BETWEEN ? AND ?
           AND ((l.booked_at > x.reactivated_at AND l.booking_cancelled_at IS NULL) OR l.app_completed_at > x.reactivated_at)`),
    one(`SELECT COUNT(*) AS n FROM sms_messages WHERE direction = 'out' AND ${SENT} AND sent_at BETWEEN ? AND ?`),
    one("SELECT COUNT(*) AS n FROM ops_followup_messages WHERE status = 'sent' AND sent_at BETWEEN ? AND ?"),
  ]);
  return {
    short_sent: c(short, 'emails sent'), long_sent: c(long, 'emails sent'), behaviour_sent: c(behaviour, 'emails sent'), rx_launched: c(launched, 'people reactivated'),
    rx_back: c(back, 'came back'), sms_sent: c(sms, 'texts sent'), batch_sent: c(batch, 'messages sent'),
  };
}

async function afterCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, c } = counter(rt, r);
  const [clients, sprints, signed, paid, risk, checkins, support, escalated] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM cs_clients WHERE since_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM deal_sprints WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM contracts WHERE signed_at BETWEEN ? AND ? AND COALESCE(is_test, 0) = 0 AND voided_at IS NULL'),
    one('SELECT COUNT(*) AS n FROM contracts WHERE paid_at BETWEEN ? AND ? AND COALESCE(is_test, 0) = 0'),
    one("SELECT COUNT(*) AS n FROM cs_clients WHERE band = 'at_risk'", []),
    one("SELECT COUNT(*) AS n FROM cs_checkins WHERE status = 'sent' AND sent_at BETWEEN ? AND ?"),
    one('SELECT COUNT(*) AS n FROM support_threads WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM support_threads WHERE escalated = 1 AND created_at BETWEEN ? AND ?'),
  ]);
  return {
    clients: c(clients, 'new clients'), sprints: c(sprints, 'Sprints started'), signed: c(signed, 'agreements signed'), paid: c(paid, 'agreements paid'),
    at_risk: c(risk, 'at risk now'), checkins_sent: c(checkins, 'check-ins sent'), support: c(support, 'questions'), escalated: c(escalated, 'escalated'),
  };
}

async function opsCounts(rt: Runtime, r: Range): Promise<Counts> {
  const { one, c } = counter(rt, r);
  const [items, themes, angles, drafts, autopilot, followups, proposed, executed, hooks] = await Promise.all([
    one('SELECT COUNT(*) AS n FROM research_items WHERE collected_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM research_themes WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM research_angles WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM ads_angle_drafts WHERE created_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM ads_autopilot_log WHERE created_at BETWEEN ? AND ?'),
    one("SELECT COUNT(*) AS n FROM ops_followup_messages WHERE status = 'sent' AND sent_at BETWEEN ? AND ?"),
    one("SELECT COUNT(*) AS n FROM ops_actions WHERE created_at BETWEEN ? AND ? AND (status = 'proposed' OR decided_at IS NOT NULL)"),
    one('SELECT COUNT(*) AS n FROM ops_actions WHERE executed_at BETWEEN ? AND ?'),
    one('SELECT COUNT(*) AS n FROM hook_events WHERE created_at BETWEEN ? AND ?'),
  ]);
  return {
    items: c(items, 'items collected'), themes: c(themes, 'themes'), angles: c(angles, 'angles'), drafts: c(drafts, 'ad drafts'), autopilot: c(autopilot, 'autopilot proposals'),
    followups: c(followups, 'messages sent'), proposed: c(proposed, 'proposals'), executed: c(executed, 'carried out'), hooks: c(hooks, 'events'),
  };
}

export async function mapCounts(rt: Runtime, id: string, r: Range, query: Record<string, string> = {}): Promise<Counts> {
  switch (id) {
    case 'vsl': return vslCounts(rt, r, query);
    case 'auto': return autoCounts(rt, r);
    case 'live': return liveCounts(rt, r);
    case 'challenge': return challengeCounts(rt, r);
    case 'dm': return dmCounts(rt, r);
    case 'nurture': return nurtureCounts(rt, r);
    case 'after': return afterCounts(rt, r);
    case 'ops': return opsCounts(rt, r);
    default: return {};
  }
}

// ───────────── conversion, automations, settings ─────────────

/** Conversion counts that aren't a stage of their own. */
const EXTRA_FROM: Record<string, string> = { qualified: 'Qualified (A + B)' };

export interface Conversion { rate: number | null; from: string; fromTitle: string }

/** Each stage converts from its `from`, else the previous ladder stage. Only a rate of 0 to 100% is shown (counts are per range, so different people can be in each). */
export function conversions(def: FunnelMapDef, counts: Counts): Record<string, Conversion> {
  const out: Record<string, Conversion> = {};
  const byId = new Map(def.stages.map((s) => [s.id, s]));
  for (const s of def.stages) {
    const i = def.ladder.indexOf(s.id);
    const from = s.from ?? (i > 0 ? def.ladder[i - 1] : null);
    if (!from || !s.count) continue;
    const src = byId.get(from);
    const base = src?.count ? counts[src.count] : counts[from];
    const cur = counts[s.count];
    const title = src?.title ?? EXTRA_FROM[from] ?? from;
    const rate = base?.n && cur?.n && cur.n <= base.n ? cur.n / base.n : null;
    out[s.id] = { rate, from, fromTitle: title };
  }
  return out;
}

const DEF_BY_KEY = new Map(SETTINGS.map((d) => [d.key as string, d as { key: string; label: string; secret?: boolean; placeholder?: string }]));
export interface SettingView { key: string; label: string; secret: boolean; set: boolean; value: string | null; placeholder: string | null }
export function settingViews(rt: Pick<Runtime, 'settings'>, keys: string[] = []): SettingView[] {
  return keys.flatMap((key) => {
    const d = DEF_BY_KEY.get(key);
    if (!d) return [];
    const raw = String((rt.settings as Record<string, string | undefined>)[key] ?? '').trim();
    const secret = Boolean(d.secret);
    return [{ key, label: d.label, secret, set: Boolean(raw), value: secret ? null : raw ? raw.slice(0, 160) : null, placeholder: secret ? null : d.placeholder ?? null }];
  });
}

/** The template names a sequence can send, so a filtered automation can say how many emails it has. */
function sequenceTemplates(seq: string): string[] | null {
  const s = (SEQUENCES as Record<string, { steps: { template: string }[] }>)[seq];
  if (s) return s.steps.map((x) => x.template);
  if (seq === 'live') return Object.keys(LIVE_STEP).map((k) => `live_${k}`);
  if (seq === 'deposit') return ['deposit_welcome'];
  return null;
}
const likeRe = (p: string) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')}$`);

export interface AutoView extends Automation { steps?: number; long?: number; sent?: number | null; calls?: number | null }
async function autoViews(rt: Runtime, r: Range, autos: Automation[] = []): Promise<AutoView[]> {
  const db = rt.env.DB;
  return Promise.all(autos.map(async (a) => {
    const v: AutoView = { ...a };
    if (a.seq) {
      const all = sequenceTemplates(a.seq);
      if (all?.length && !['precall', 'prewebinar', 'behaviour'].includes(a.seq)) v.steps = a.tpl ? all.filter((t) => a.tpl!.some((p) => likeRe(p).test(t))).length : all.length;
      const lf = (LONG_FLOWS as Record<string, { emails: unknown[] }>)[a.seq];
      if (lf && !a.tpl) v.long = lf.emails.length;
      const like = a.tpl?.length ? ` AND (${a.tpl.map(() => 'template LIKE ?').join(' OR ')})` : '';
      try {
        const row = await db.prepare(`SELECT COUNT(*) AS n FROM emails WHERE sequence = ? AND ${SENT} AND sent_at BETWEEN ? AND ?${like}`).bind(a.seq, r.from, r.to, ...(a.tpl ?? [])).first<{ n: unknown }>();
        v.sent = num(row?.n);
      } catch { v.sent = null; }
    }
    if (a.call) {
      try {
        const row = await db.prepare('SELECT COUNT(*) AS n FROM outbound_calls WHERE kind = ? AND created_at BETWEEN ? AND ?').bind(a.call, r.from, r.to).first<{ n: unknown }>();
        v.calls = num(row?.n);
      } catch { v.calls = null; }
    }
    return v;
  }));
}

export interface StageView extends Stage { n: Count | null; conv: Conversion | null; settingsView: SettingView[]; autosView: AutoView[] }

/** One map with everything the panel shows. */
export async function buildMap(rt: Runtime, def: FunnelMapDef, r: Range, query: Record<string, string> = {}) {
  const counts = await mapCounts(rt, def.id, r, query);
  const conv = conversions(def, counts);
  const stages: StageView[] = await Promise.all(def.stages.map(async (s) => ({
    ...s,
    n: s.count ? counts[s.count] ?? null : null,
    conv: conv[s.id] ?? null,
    settingsView: settingViews(rt, s.settings),
    autosView: await autoViews(rt, r, s.autos),
  })));
  return { id: def.id, title: def.title, short: def.short, summary: def.summary, attribution: def.attribution ?? null, ladder: def.ladder, stages, edges: def.edges, range: r };
}

/** Every map as a strip of its ladder stages with counts and conversion (the "All funnels" view). */
export async function mapsOverview(rt: Runtime, r: Range, query: Record<string, string> = {}) {
  return Promise.all(FUNNEL_MAPS.map(async (def) => {
    const counts = await mapCounts(rt, def.id, r, query);
    const conv = conversions(def, counts);
    const byId = new Map(def.stages.map((s) => [s.id, s]));
    return {
      id: def.id, title: def.title, short: def.short, summary: def.summary, stages: def.stages.length,
      strip: def.ladder.map((id) => {
        const s = byId.get(id)!;
        return { id, title: s.title, n: s.count ? counts[s.count] ?? null : null, conv: conv[id] ?? null };
      }),
    };
  }));
}

// ───────────── layouts ─────────────

const ID = /^[\w-]{1,40}$/;
const layoutKey = (id: string, part: 'layout' | 'custom') => (id === 'vsl' ? `map:${part}` : `map:${id}:${part}`);

export function cleanLayout(layout: unknown): Record<string, { x: number; y: number }> {
  const clean: Record<string, { x: number; y: number }> = {};
  if (!layout || typeof layout !== 'object') return clean;
  for (const [k, v] of Object.entries(layout as Record<string, { x?: unknown; y?: unknown }>).slice(0, 300)) {
    const x = Number(v?.x), y = Number(v?.y);
    if (ID.test(k) && Number.isFinite(x) && Number.isFinite(y)) clean[k] = { x: Math.round(Math.max(0, Math.min(5000, x))), y: Math.round(Math.max(0, Math.min(5000, y))) };
  }
  return clean;
}

export function cleanCustom(raw0: unknown) {
  const raw = (raw0 && typeof raw0 === 'object' ? raw0 : {}) as { nodes?: unknown; edges?: unknown; edits?: unknown };
  const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const KINDS = ['traffic', 'page', 'decision', 'auto', 'people', 'data'];
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).slice(0, 200).flatMap((n: Record<string, unknown>) =>
    n && typeof n.id === 'string' && /^u_[a-z0-9]{4,20}$/.test(n.id)
      ? [{ id: n.id, kind: KINDS.includes(String(n.kind)) ? String(n.kind) : 'page', title: txt(n.title, 60) || 'New step', sub: txt(n.sub, 90), note: txt(n.note, 2000), tab: txt(n.tab, 30) || null }]
      : []);
  const edges = (Array.isArray(raw.edges) ? raw.edges : []).slice(0, 400).flatMap((e: unknown) =>
    Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && ID.test(e[0]) && ID.test(e[1]) && e[0] !== e[1] ? [[e[0], e[1], txt(e[2], 30)]] : []);
  const edits: Record<string, { title?: string; sub?: string; note?: string }> = {};
  if (raw.edits && typeof raw.edits === 'object') {
    for (const [k, v] of Object.entries(raw.edits as Record<string, Record<string, unknown>>).slice(0, 200)) {
      if (!ID.test(k) || !v || typeof v !== 'object') continue;
      const e: { title?: string; sub?: string; note?: string } = {};
      if (txt(v.title, 60)) e.title = txt(v.title, 60);
      if (typeof v.sub === 'string') e.sub = txt(v.sub, 90);
      if (txt(v.note, 2000)) e.note = txt(v.note, 2000);
      if (Object.keys(e).length) edits[k] = e;
    }
  }
  return { nodes, edges, edits };
}

async function readKv(rt: Runtime, key: string) {
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function writeKv(rt: Runtime, key: string, value: unknown | null) {
  if (value == null) { await rt.env.DB.prepare('DELETE FROM kv_state WHERE key = ?').bind(key).run(); return; }
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(key, JSON.stringify(value)).run();
}

// ───────────── routes ─────────────

export function mountFunnelMaps(admin: Hono<AppEnv>) {
  const range = (q: Record<string, string>) => { const f = parseFilters(q); return { from: f.from, to: f.to }; };
  admin.get('/maps', async (c) => {
    const q = c.req.query();
    return c.json({ maps: await mapsOverview(runtimeFrom(c), range(q), q) });
  });
  admin.get('/maps/:id', async (c) => {
    const def = mapById(c.req.param('id'));
    if (!def) return c.json({ error: 'No such map' }, 404);
    const q = c.req.query();
    return c.json(await buildMap(runtimeFrom(c), def, range(q), q));
  });
  admin.get('/maps/:id/:part{layout|custom}', async (c) => {
    const def = mapById(c.req.param('id'));
    if (!def) return c.json({ error: 'No such map' }, 404);
    const part = c.req.param('part') as 'layout' | 'custom';
    return c.json({ [part]: await readKv(runtimeFrom(c), layoutKey(def.id, part)) });
  });
  admin.put('/maps/:id/:part{layout|custom}', async (c) => {
    const def = mapById(c.req.param('id'));
    if (!def) return c.json({ error: 'No such map' }, 404);
    const part = c.req.param('part') as 'layout' | 'custom';
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
    const rt = runtimeFrom(c);
    if (part === 'layout') {
      if (!body.layout) { await writeKv(rt, layoutKey(def.id, 'layout'), null); return c.json({ ok: true }); }
      await writeKv(rt, layoutKey(def.id, 'layout'), cleanLayout(body.layout));
      return c.json({ ok: true });
    }
    const custom = cleanCustom(body.custom);
    await writeKv(rt, layoutKey(def.id, 'custom'), custom);
    return c.json({ ok: true, nodes: custom.nodes.length, edges: custom.edges.length });
  });
}
