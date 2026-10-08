import { APPLICATION, CLOSERS, HEADLINE_EXPERIMENT, VIDEOS } from '../config';
import type { Env } from '../env';
import { BUCKETS } from '../tracking/vsl';

/** Dashboard filters. Every query excludes bots. */
export interface Filters {
  from: number;
  to: number;
  tzOffsetMin: number; // browser offset, for daily buckets in local time
  channel?: string;
  source?: string;
  campaign?: string;
  content?: string;
  variant?: string;
  device?: string;
  country?: string;
}

export function parseFilters(q: Record<string, string | undefined>): Filters {
  const now = Date.now();
  const to = Number(q.to) || now;
  const from = Number(q.from) || to - 30 * 86400_000;
  const clip = (v?: string) => (v ? v.slice(0, 200) : undefined);
  return {
    from,
    to,
    tzOffsetMin: Math.max(-840, Math.min(840, Number(q.tz) || 0)),
    channel: clip(q.channel),
    source: clip(q.source),
    campaign: clip(q.campaign),
    content: clip(q.content),
    variant: clip(q.variant),
    device: clip(q.device),
    country: clip(q.country),
  };
}

type Bind = (string | number | null)[];

/** Segment filters over a sessions alias. */
function segment(f: Filters, alias = 's'): { sql: string; params: Bind; active: boolean } {
  const parts: string[] = [];
  const params: Bind = [];
  const add = (col: string, v?: string) => {
    if (v) {
      parts.push(`${alias}.${col} = ?`);
      params.push(v);
    }
  };
  add('channel', f.channel);
  add('utm_source', f.source);
  add('utm_campaign', f.campaign);
  add('utm_content', f.content);
  add('variant', f.variant);
  add('device', f.device);
  add('country', f.country);
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params, active: parts.length > 0 };
}

/** Event rows in range + segment: `FROM events e WHERE <this>`. */
function eventScope(f: Filters) {
  const seg = segment(f);
  return {
    sql: `e.ts BETWEEN ? AND ? AND e.is_bot = 0${seg.active ? ` AND e.session_id IN (SELECT s.id FROM sessions s WHERE s.is_bot = 0${seg.sql})` : ''}`,
    params: [f.from, f.to, ...seg.params] as Bind,
  };
}

/** Leads created in range, segmented by the session they applied in. */
function leadScope(f: Filters, dateCol = 'l.created_at') {
  const seg = segment(f, 'ls');
  return {
    join: 'LEFT JOIN sessions ls ON ls.id = l.session_id',
    sql: `${dateCol} BETWEEN ? AND ?${seg.sql}`,
    params: [f.from, f.to, ...seg.params] as Bind,
  };
}

async function one<T = Record<string, number>>(env: Env, sql: string, params: Bind) {
  return (await env.DB.prepare(sql).bind(...params).first<T>())!;
}
async function all<T = Record<string, unknown>>(env: Env, sql: string, params: Bind) {
  return (await env.DB.prepare(sql).bind(...params).all<T>()).results;
}

const rate = (n: number, d: number) => (d ? n / d : 0);

/** Distinct visitors who fired each event in range (one query, pivoted). */
async function visitorsByEvent(env: Env, f: Filters, names: string[]) {
  const scope = eventScope(f);
  const rows = await all<{ name: string; path: string | null; n: number }>(
    env,
    `SELECT e.name, CASE WHEN e.name = 'page_view' THEN e.path END AS path, COUNT(DISTINCT e.visitor_id) AS n
       FROM events e WHERE ${scope.sql} AND e.name IN (${names.map(() => '?').join(',')})
      GROUP BY 1, 2`,
    [...scope.params, ...names],
  );
  const out: Record<string, number> = {};
  for (const r of rows) {
    const key = r.name === 'page_view' ? `page_view:${r.path}` : r.name;
    out[key] = (out[key] ?? 0) + r.n;
  }
  return out;
}

// ───────────────────────────── Overview ─────────────────────────────

export async function overview(env: Env, f: Filters) {
  const seg = segment(f);
  const scope = eventScope(f);
  const lead = leadScope(f);
  const appScope = leadScope(f, 'l.app_completed_at');
  const bookScope = leadScope(f, 'l.booked_at');

  const [traffic, ev, leadsCreated, apps, booked, outcomes, vsl, emails, daily] = await Promise.all([
    one(env, `SELECT COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions, COALESCE(SUM(s.pageviews), 0) AS pageviews,
                     SUM(CASE WHEN s.pageviews <= 1 AND s.event_count <= 1 THEN 1 ELSE 0 END) AS bounces,
                     AVG(s.engaged_ms) AS avg_engaged_ms
                FROM sessions s WHERE s.started_at BETWEEN ? AND ? AND s.is_bot = 0${seg.sql}`, [f.from, f.to, ...seg.params]),
    visitorsByEvent(env, f, ['page_view', 'vsl_play', 'vsl_unmute', 'vsl_25', 'vsl_50', 'vsl_75', 'vsl_complete', 'vsl_cta_reveal', 'vsl_cta_click', 'cta_click', 'app_view_step', 'lead_captured', 'app_submitted', 'booking_scheduled', 'whatsapp_click', 'whatsapp_connected']),
    one(env, `SELECT COUNT(*) AS leads FROM leads l ${lead.join} WHERE ${lead.sql}`, lead.params),
    one(env, `SELECT COUNT(*) AS applications,
                     SUM(CASE WHEN COALESCE(l.tier_override, l.tier) = 'A' THEN 1 ELSE 0 END) AS tier_a,
                     SUM(CASE WHEN COALESCE(l.tier_override, l.tier) = 'B' THEN 1 ELSE 0 END) AS tier_b,
                     SUM(CASE WHEN COALESCE(l.tier_override, l.tier) = 'C' THEN 1 ELSE 0 END) AS tier_c,
                     AVG(l.score) AS avg_score
                FROM leads l ${appScope.join} WHERE ${appScope.sql}`, appScope.params),
    one(env, `SELECT COUNT(*) AS booked, SUM(CASE WHEN l.booking_cancelled_at IS NOT NULL THEN 1 ELSE 0 END) AS cancelled
                FROM leads l ${bookScope.join} WHERE ${bookScope.sql}`, bookScope.params),
    one(env, `SELECT SUM(CASE WHEN l.status IN ('showed','won','lost') THEN 1 ELSE 0 END) AS showed,
                     SUM(CASE WHEN l.status = 'no_show' THEN 1 ELSE 0 END) AS no_show,
                     SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
                     COALESCE(SUM(l.revenue), 0) AS revenue
                FROM leads l ${lead.join} WHERE ${lead.sql}`, lead.params),
    one(env, `SELECT COUNT(*) AS views, AVG(CASE WHEN v.duration > 0 THEN MIN(1.0, v.max_position / v.duration) END) AS avg_pct,
                     AVG(v.watched_seconds) AS avg_seconds
                FROM vsl_views v ${seg.active ? 'JOIN sessions s ON s.id = v.session_id' : ''}
               WHERE v.video_id = ? AND v.started_at BETWEEN ? AND ? AND v.is_bot = 0${seg.sql}`, [VIDEOS.main.id, f.from, f.to, ...seg.params]),
    one(env, `SELECT SUM(CASE WHEN status IN ('sent','simulated') THEN 1 ELSE 0 END) AS sent,
                     SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                     SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
                FROM emails WHERE sent_at BETWEEN ? AND ?`, [f.from, f.to]),
    all<{ day: string; name: string; n: number }>(env,
      `SELECT strftime('%Y-%m-%d', (e.ts + ?) / 1000, 'unixepoch') AS day, e.name, COUNT(DISTINCT e.visitor_id) AS n
         FROM events e WHERE ${scope.sql} AND e.name IN ('page_view','vsl_play','lead_captured','app_submitted','booking_scheduled')
        GROUP BY 1, 2 ORDER BY 1`, [f.tzOffsetMin * 60_000, ...scope.params]),
  ]);

  const landing = ev['page_view:/'] ?? 0;
  const funnel = [
    { key: 'landing', label: 'Landed on VSL page', n: landing },
    { key: 'play', label: 'Played the VSL', n: ev.vsl_play ?? 0 },
    { key: 'vsl_50', label: 'Watched 50%', n: ev.vsl_50 ?? 0 },
    { key: 'pitch', label: 'Reached the pitch (CTA shown)', n: ev.vsl_cta_reveal ?? 0 },
    { key: 'apply_view', label: 'Opened the application', n: ev['page_view:/apply'] ?? 0 },
    { key: 'lead', label: 'Gave contact details', n: ev.lead_captured ?? 0 },
    { key: 'applied', label: 'Submitted application', n: ev.app_submitted ?? 0 },
    { key: 'qualified', label: 'Qualified (A + B)', n: (apps.tier_a ?? 0) + (apps.tier_b ?? 0) },
    { key: 'booked', label: 'Booked a call', n: ev.booking_scheduled ?? 0 },
    { key: 'showed', label: 'Showed up', n: outcomes.showed ?? 0 },
    { key: 'won', label: 'Closed (won)', n: outcomes.won ?? 0 },
  ];

  const days: Record<string, Record<string, number>> = {};
  for (const r of daily) (days[r.day] ??= {})[r.name] = r.n;

  return {
    range: { from: f.from, to: f.to },
    kpis: {
      visitors: traffic.visitors ?? 0,
      sessions: traffic.sessions ?? 0,
      pageviews: traffic.pageviews ?? 0,
      bounce_rate: rate(traffic.bounces ?? 0, traffic.sessions ?? 0),
      avg_engaged_s: Math.round((traffic.avg_engaged_ms ?? 0) / 1000),
      play_rate: rate(ev.vsl_play ?? 0, landing),
      unmute_rate: rate(ev.vsl_unmute ?? 0, ev.vsl_play ?? 0),
      avg_watch_pct: vsl.avg_pct ?? 0,
      avg_watch_s: Math.round(vsl.avg_seconds ?? 0),
      pitch_rate: rate(ev.vsl_cta_reveal ?? 0, ev.vsl_play ?? 0),
      leads: leadsCreated.leads ?? 0,
      opt_in_rate: rate(ev.lead_captured ?? 0, landing),
      applications: apps.applications ?? 0,
      app_completion_rate: rate(ev.app_submitted ?? 0, ev.lead_captured ?? 0),
      avg_score: Math.round(apps.avg_score ?? 0),
      tier_a: apps.tier_a ?? 0,
      tier_b: apps.tier_b ?? 0,
      tier_c: apps.tier_c ?? 0,
      booked: booked.booked ?? 0,
      cancelled: booked.cancelled ?? 0,
      booking_rate: rate(booked.booked ?? 0, (apps.tier_a ?? 0) + (apps.tier_b ?? 0)),
      showed: outcomes.showed ?? 0,
      no_show: outcomes.no_show ?? 0,
      show_rate: rate(outcomes.showed ?? 0, (outcomes.showed ?? 0) + (outcomes.no_show ?? 0)),
      won: outcomes.won ?? 0,
      revenue: outcomes.revenue ?? 0,
      revenue_per_visitor: rate(outcomes.revenue ?? 0, traffic.visitors ?? 0),
      whatsapp_clicks: ev.whatsapp_click ?? 0,
      whatsapp_connected: ev.whatsapp_connected ?? 0,
      emails_sent: emails.sent ?? 0,
      email_open_rate: rate(emails.opened ?? 0, emails.sent ?? 0),
      email_click_rate: rate(emails.clicked ?? 0, emails.sent ?? 0),
    },
    funnel,
    daily: Object.entries(days).map(([day, v]) => ({
      day,
      visitors: v.page_view ?? 0,
      plays: v.vsl_play ?? 0,
      leads: v.lead_captured ?? 0,
      applications: v.app_submitted ?? 0,
      booked: v.booking_scheduled ?? 0,
    })),
  };
}

// ───────────────────────────── VSL analytics ─────────────────────────────

export async function vslStats(env: Env, f: Filters, videoId: string) {
  const seg = segment(f);
  const join = seg.active ? 'JOIN sessions s ON s.id = v.session_id' : '';
  const where = `v.video_id = ? AND v.started_at BETWEEN ? AND ? AND v.is_bot = 0${seg.sql}`;
  const params: Bind = [videoId, f.from, f.to, ...seg.params];

  const [summary, rows, byVariant, byDevice] = await Promise.all([
    one(env, `SELECT COUNT(*) AS views, COUNT(DISTINCT v.visitor_id) AS viewers, AVG(v.unmuted) AS unmute_rate,
                     AVG(CASE WHEN v.duration > 0 THEN MIN(1.0, v.max_position / v.duration) END) AS avg_pct,
                     AVG(v.watched_seconds) AS avg_seconds, AVG(v.completed) AS completion_rate,
                     AVG(v.cta_revealed) AS reveal_rate, AVG(v.cta_clicked) AS cta_rate, MAX(v.duration) AS duration
                FROM vsl_views v ${join} WHERE ${where}`, params),
    all<{ buckets: string }>(env, `SELECT v.buckets FROM vsl_views v ${join} WHERE ${where} ORDER BY v.started_at DESC LIMIT 20000`, params),
    all(env, `SELECT v.variant AS key, COUNT(*) AS views, AVG(CASE WHEN v.duration > 0 THEN MIN(1.0, v.max_position / v.duration) END) AS avg_pct,
                     AVG(v.cta_revealed) AS reveal_rate, AVG(v.cta_clicked) AS cta_rate
                FROM vsl_views v ${join} WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
    all(env, `SELECT ds.device AS key, COUNT(*) AS views, AVG(CASE WHEN v.duration > 0 THEN MIN(1.0, v.max_position / v.duration) END) AS avg_pct,
                     AVG(v.unmuted) AS unmute_rate
                FROM vsl_views v JOIN sessions ds ON ds.id = v.session_id ${seg.active ? 'JOIN sessions s ON s.id = v.session_id' : ''}
               WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, params),
  ]);

  // Retention: share of views that watched each 1% of the video.
  const counts = new Array<number>(BUCKETS).fill(0);
  for (const r of rows) for (let i = 0; i < BUCKETS; i++) if (r.buckets.charCodeAt(i) === 49) counts[i]++;
  const retention = counts.map((n) => rate(n, rows.length));

  // Steepest drop-offs (where people leave), excluding the natural tail.
  const drops = retention
    .slice(0, 95)
    .map((r, i) => ({ pct: i, drop: i === 0 ? 1 - r : retention[i - 1] - r }))
    .sort((a, b) => b.drop - a.drop)
    .slice(0, 5)
    .map((d) => ({ ...d, second: summary.duration ? Math.round((d.pct / 100) * summary.duration) : null }));

  const def = Object.values(VIDEOS).find((v) => v.id === videoId);
  return { video: videoId, ctaRevealAt: def?.ctaRevealAt ?? null, summary, retention, drops, byVariant, byDevice };
}

// ───────────────────────────── Attribution ─────────────────────────────

const DIMENSIONS: Record<string, { session: string; lead: string; label: string }> = {
  channel: { session: 's.channel', lead: "COALESCE(l.channel, 'Direct')", label: 'Channel' },
  source: { session: 's.utm_source', lead: 'l.utm_source', label: 'Source' },
  campaign: { session: 's.utm_campaign', lead: 'l.utm_campaign', label: 'Campaign' },
  content: { session: 's.utm_content', lead: 'l.utm_content', label: 'Ad / content' },
  term: { session: 's.utm_term', lead: 'l.utm_term', label: 'Term / audience' },
  ad_id: { session: 's.ad_id', lead: 'ls.ad_id', label: 'Ad ID' },
  referrer: { session: 's.referrer_host', lead: 'ls.referrer_host', label: 'Referrer' },
  landing: { session: 's.landing_path', lead: 'l.landing_path', label: 'Landing page' },
  country: { session: 's.country', lead: 'l.country', label: 'Country' },
  city: { session: 's.city', lead: 'l.city', label: 'City' },
  device: { session: 's.device', lead: 'l.device', label: 'Device' },
  browser: { session: 's.browser', lead: 'ls.browser', label: 'Browser' },
  os: { session: 's.os', lead: 'ls.os', label: 'OS' },
  variant: { session: 's.variant', lead: 'l.variant', label: 'Headline variant' },
  first_touch: { session: "(SELECT ft_channel FROM visitors WHERE id = s.visitor_id)", lead: "COALESCE(l.ft_channel, 'Direct')", label: 'First-touch channel' },
};

export const dimensionList = () => Object.entries(DIMENSIONS).map(([key, d]) => ({ key, label: d.label }));

export async function attribution(env: Env, f: Filters, dim: string) {
  const d = DIMENSIONS[dim] ?? DIMENSIONS.channel;
  const seg = segment(f);
  const lead = leadScope(f);

  const [traffic, leads] = await Promise.all([
    all<{ key: string | null; visitors: number; sessions: number; bounces: number; engaged: number; scroll: number }>(env,
      `SELECT ${d.session} AS key, COUNT(DISTINCT s.visitor_id) AS visitors, COUNT(*) AS sessions,
              SUM(CASE WHEN s.pageviews <= 1 AND s.event_count <= 1 THEN 1 ELSE 0 END) AS bounces, AVG(s.engaged_ms) AS engaged, AVG(s.max_scroll) AS scroll
         FROM sessions s WHERE s.started_at BETWEEN ? AND ? AND s.is_bot = 0${seg.sql}
        GROUP BY 1 ORDER BY 2 DESC LIMIT 200`, [f.from, f.to, ...seg.params]),
    all<{ key: string | null; leads: number; applications: number; a: number; b: number; booked: number; showed: number; won: number; revenue: number; score: number }>(env,
      `SELECT ${d.lead} AS key, COUNT(*) AS leads,
              SUM(CASE WHEN l.app_completed_at IS NOT NULL THEN 1 ELSE 0 END) AS applications,
              SUM(CASE WHEN COALESCE(l.tier_override, l.tier) = 'A' THEN 1 ELSE 0 END) AS a,
              SUM(CASE WHEN COALESCE(l.tier_override, l.tier) = 'B' THEN 1 ELSE 0 END) AS b,
              SUM(CASE WHEN l.booked_at IS NOT NULL THEN 1 ELSE 0 END) AS booked,
              SUM(CASE WHEN l.status IN ('showed','won','lost') THEN 1 ELSE 0 END) AS showed,
              SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
              COALESCE(SUM(l.revenue), 0) AS revenue, AVG(l.score) AS score
         FROM leads l ${lead.join} WHERE ${lead.sql} GROUP BY 1`, lead.params),
  ]);

  const byKey = new Map(leads.map((r) => [r.key ?? '(none)', r]));
  const rows = traffic.map((t) => {
    const k = t.key ?? '(none)';
    const l = byKey.get(k);
    byKey.delete(k);
    return {
      key: k,
      visitors: t.visitors,
      sessions: t.sessions,
      bounce_rate: rate(t.bounces, t.sessions),
      avg_engaged_s: Math.round((t.engaged ?? 0) / 1000),
      avg_scroll: Math.round(t.scroll ?? 0),
      leads: l?.leads ?? 0,
      applications: l?.applications ?? 0,
      qualified: (l?.a ?? 0) + (l?.b ?? 0),
      tier_a: l?.a ?? 0,
      booked: l?.booked ?? 0,
      showed: l?.showed ?? 0,
      won: l?.won ?? 0,
      revenue: l?.revenue ?? 0,
      avg_score: Math.round(l?.score ?? 0),
      lead_rate: rate(l?.leads ?? 0, t.visitors),
      qualified_rate: rate((l?.a ?? 0) + (l?.b ?? 0), t.visitors),
      revenue_per_visitor: rate(l?.revenue ?? 0, t.visitors),
    };
  });
  // Leads whose attribution value never appeared as a session in range (e.g. older sessions).
  for (const [k, l] of byKey) {
    rows.push({ key: k, visitors: 0, sessions: 0, bounce_rate: 0, avg_engaged_s: 0, avg_scroll: 0, leads: l.leads, applications: l.applications,
      qualified: l.a + l.b, tier_a: l.a, booked: l.booked, showed: l.showed, won: l.won, revenue: l.revenue, avg_score: Math.round(l.score ?? 0),
      lead_rate: 0, qualified_rate: 0, revenue_per_visitor: 0 });
  }
  return { dimension: dim in DIMENSIONS ? dim : 'channel', label: d.label, rows };
}

// ───────────────────────────── Application analytics ─────────────────────────────

export async function applicationStats(env: Env, f: Filters) {
  const lead = leadScope(f);
  const rows = await all<{ step_reached: number; answers: string; score: number | null; tier: string | null; tier_override: string | null; score_breakdown: string | null; app_completed_at: number | null; closer_id: string | null }>(env,
    `SELECT l.step_reached, l.answers, l.score, l.tier, l.tier_override, l.score_breakdown, l.app_completed_at, l.closer_id
       FROM leads l ${lead.join} WHERE ${lead.sql} LIMIT 20000`, lead.params);

  const scope = eventScope(f);
  const views = await one<{ n: number }>(env, `SELECT COUNT(DISTINCT e.visitor_id) AS n FROM events e WHERE ${scope.sql} AND e.name = 'page_view' AND e.path = '/apply'`, scope.params);

  const steps = APPLICATION.map((q, i) => ({
    step: i + 1,
    id: q.id,
    title: q.title,
    reached: rows.filter((r) => r.step_reached >= i + 1).length,
  }));

  const distributions = APPLICATION.filter((q) => q.type === 'single' || q.type === 'multi').map((q) => {
    const opts = 'options' in q ? q.options : [];
    const counts = Object.fromEntries(opts.map((o) => [o.value, 0]));
    let answered = 0;
    for (const r of rows) {
      let a: unknown;
      try { a = JSON.parse(r.answers || '{}')[q.id]; } catch { a = undefined; }
      if (a === undefined) continue;
      answered++;
      for (const v of Array.isArray(a) ? a : [a]) if (typeof v === 'string' && v in counts) counts[v]++;
    }
    return { id: q.id, title: q.title, answered, options: opts.map((o) => ({ value: o.value, label: o.label, points: o.points, n: counts[o.value] })) };
  });

  const histogram = new Array(10).fill(0);
  const caps: Record<string, number> = {};
  const closers: Record<string, number> = {};
  for (const r of rows) {
    if (r.score != null) histogram[Math.min(9, Math.floor(r.score / 10))]++;
    if (r.closer_id) closers[r.closer_id] = (closers[r.closer_id] ?? 0) + 1;
    try {
      for (const c of (JSON.parse(r.score_breakdown ?? '{}').caps ?? []) as string[]) caps[c] = (caps[c] ?? 0) + 1;
    } catch { /* ignore */ }
  }

  return {
    page_views: views.n ?? 0,
    started: rows.length,
    completed: rows.filter((r) => r.app_completed_at).length,
    steps,
    distributions,
    score_histogram: histogram.map((n, i) => ({ range: `${i * 10}–${i * 10 + 9}`, n })),
    caps: Object.entries(caps).map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    closers: CLOSERS.map((c) => ({ id: c.id, name: c.name, leads: closers[c.id] ?? 0 })),
  };
}

// ───────────────────────────── Experiments ─────────────────────────────

/** Two-proportion z-test, two-sided p-value. */
export function zTest(c1: number, n1: number, c2: number, n2: number) {
  if (!n1 || !n2) return { z: 0, p: 1 };
  const p1 = c1 / n1;
  const p2 = c2 / n2;
  const p = (c1 + c2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return { z: 0, p: 1 };
  const z = (p2 - p1) / se;
  return { z, p: 2 * (1 - normalCdf(Math.abs(z))) };
}

function normalCdf(x: number) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * x / Math.SQRT2);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + erf);
}

export async function experiments(env: Env, f: Filters) {
  const scope = eventScope(f);
  const rows = await all<{ variant: string; name: string; n: number }>(env,
    `SELECT e.variant, CASE WHEN e.name = 'page_view' THEN 'landing' ELSE e.name END AS name, COUNT(DISTINCT e.visitor_id) AS n
       FROM events e WHERE ${scope.sql} AND e.variant IS NOT NULL
        AND ((e.name = 'page_view' AND e.path = '/') OR e.name IN ('vsl_play','vsl_50','vsl_cta_reveal','lead_captured','app_submitted','booking_scheduled'))
      GROUP BY 1, 2`, scope.params);
  const lead = leadScope(f, 'l.app_completed_at');
  const quality = await all<{ variant: string; qualified: number }>(env,
    `SELECT l.variant, SUM(CASE WHEN COALESCE(l.tier_override, l.tier) IN ('A','B') THEN 1 ELSE 0 END) AS qualified FROM leads l ${lead.join} WHERE ${lead.sql} GROUP BY 1`, lead.params);

  const m: Record<string, Record<string, number>> = {};
  for (const r of rows) (m[r.variant] ??= {})[r.name] = r.n;
  for (const q of quality) if (q.variant) (m[q.variant] ??= {}).qualified = q.qualified;

  const control = HEADLINE_EXPERIMENT.variants[0].id;
  const c = m[control] ?? {};
  return {
    id: HEADLINE_EXPERIMENT.id,
    primary: 'Applications per landing visitor',
    variants: HEADLINE_EXPERIMENT.variants.map((v) => {
      const x = m[v.id] ?? {};
      const visitors = x.landing ?? 0;
      const test = v.id === control ? null : zTest(c.app_submitted ?? 0, c.landing ?? 0, x.app_submitted ?? 0, visitors);
      return {
        id: v.id,
        weight: v.weight,
        headline: v.headline.replace(/<[^>]+>/g, ''),
        visitors,
        play_rate: rate(x.vsl_play ?? 0, visitors),
        half_rate: rate(x.vsl_50 ?? 0, visitors),
        pitch_rate: rate(x.vsl_cta_reveal ?? 0, visitors),
        lead_rate: rate(x.lead_captured ?? 0, visitors),
        app_rate: rate(x.app_submitted ?? 0, visitors),
        qualified_rate: rate(x.qualified ?? 0, visitors),
        booked_rate: rate(x.booking_scheduled ?? 0, visitors),
        applications: x.app_submitted ?? 0,
        lift: test && rate(c.app_submitted ?? 0, c.landing ?? 0) ? rate(x.app_submitted ?? 0, visitors) / rate(c.app_submitted ?? 0, c.landing ?? 0) - 1 : null,
        p_value: test?.p ?? null,
        significant: test ? test.p < 0.05 : null,
      };
    }),
  };
}

// ───────────────────────────── Emails ─────────────────────────────

export async function emailStats(env: Env, f: Filters) {
  const [templates, queue, failures] = await Promise.all([
    all(env, `SELECT sequence, template, step,
                     SUM(CASE WHEN status IN ('sent','simulated') THEN 1 ELSE 0 END) AS sent,
                     SUM(CASE WHEN status = 'simulated' THEN 1 ELSE 0 END) AS simulated,
                     SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
                     SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                     SUM(CASE WHEN opened_at IS NOT NULL THEN 1 ELSE 0 END) AS opened,
                     SUM(CASE WHEN clicked_at IS NOT NULL THEN 1 ELSE 0 END) AS clicked
                FROM emails WHERE created_at BETWEEN ? AND ? GROUP BY 1, 2, 3 ORDER BY 1, 3`, [f.from, f.to]),
    all(env, `SELECT sequence, COUNT(*) AS pending, MIN(send_at) AS next_at FROM emails WHERE status = 'pending' GROUP BY 1`, []),
    all(env, `SELECT e.id, e.template, e.to_email, e.error, e.send_at, e.lead_id FROM emails e WHERE e.status = 'failed' ORDER BY e.send_at DESC LIMIT 20`, []),
  ]);
  return { templates, queue, failures };
}

// ───────────────────────────── Live ─────────────────────────────

export async function live(env: Env) {
  const since = Date.now() - 5 * 60_000;
  const [active, events] = await Promise.all([
    one(env, `SELECT COUNT(DISTINCT visitor_id) AS n FROM sessions WHERE last_seen_at > ? AND is_bot = 0`, [since]),
    all(env, `SELECT e.id, e.ts, e.name, e.path, e.source, e.props, e.lead_id, e.visitor_id, s.country, s.city, s.device, s.channel, s.utm_campaign,
                     l.first_name, l.last_name, l.tier
                FROM events e LEFT JOIN sessions s ON s.id = e.session_id LEFT JOIN leads l ON l.id = e.lead_id
               WHERE e.is_bot = 0 ORDER BY e.ts DESC LIMIT 60`, []),
  ]);
  const pages = await all(env, `SELECT e.path, COUNT(DISTINCT e.visitor_id) AS n FROM events e WHERE e.ts > ? AND e.name = 'page_view' AND e.is_bot = 0 GROUP BY 1 ORDER BY 2 DESC`, [since]);
  return { active: active.n ?? 0, pages, events };
}
