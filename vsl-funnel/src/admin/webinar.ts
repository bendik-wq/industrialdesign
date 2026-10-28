import type { Runtime } from '../app';
import { platformOf } from '../lib/attribution';
import { isMillionPlus, REVENUE_LABEL } from '../sales/qualify';
import { WEBINAR_HEADLINES, webinarHeadlineOdds, webinarHeadlineStats } from '../webinar/headlines';
import { DEFAULT_POLLS, THANK_YOU } from '../webinar/content';
import { webinarBase, webinarSettings } from '../webinar/webinar';
import { liveSummary } from '../webinar/live';

/** Funnel HQ → Webinar: sessions, registrants and how registrants move through the funnel. */
export async function webinarReport(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const w = webinarSettings(rt);
  const [kpis, upcoming, past, recent] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS registrations, COUNT(DISTINCT r.lead_id) AS people,
              SUM(r.joined_at IS NOT NULL) AS attended, SUM(r.replay_at IS NOT NULL) AS replays, SUM(r.cta_at IS NOT NULL) AS cta,
              AVG(CASE WHEN r.joined_at IS NOT NULL THEN r.watch_seconds END) AS avg_watch_s,
              SUM(l.app_completed_at IS NOT NULL AND l.app_completed_at > r.created_at) AS applied,
              SUM(l.booked_at IS NOT NULL AND l.booked_at > r.created_at AND l.booking_cancelled_at IS NULL) AS booked,
              SUM(l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at) AS won,
              SUM(CASE WHEN l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at THEN l.revenue ELSE 0 END) AS revenue
         FROM webinar_registrations r JOIN leads l ON l.id = r.lead_id WHERE r.created_at BETWEEN ? AND ?`,
    ).bind(range.from, range.to).first<Record<string, number | null>>(),
    db.prepare(
      `SELECT s.*, COUNT(r.id) AS registrations FROM webinar_sessions s LEFT JOIN webinar_registrations r ON r.session_id = s.id
        WHERE s.starts_at > ? AND s.auto != 2 GROUP BY s.id ORDER BY s.starts_at LIMIT 12`,
    ).bind(Date.now() - w.durationMin * 60_000).all(),
    db.prepare(
      `SELECT s.*, COUNT(r.id) AS registrations, SUM(r.joined_at IS NOT NULL) AS attended, SUM(r.replay_at IS NOT NULL) AS replays,
              SUM(r.cta_at IS NOT NULL) AS cta, AVG(CASE WHEN r.joined_at IS NOT NULL THEN r.max_position END) AS avg_pos,
              SUM(l.app_completed_at IS NOT NULL AND l.app_completed_at > r.created_at) AS applied,
              SUM(l.booked_at IS NOT NULL AND l.booked_at > r.created_at AND l.booking_cancelled_at IS NULL) AS booked
         FROM webinar_sessions s LEFT JOIN webinar_registrations r ON r.session_id = s.id LEFT JOIN leads l ON l.id = r.lead_id
        WHERE s.starts_at <= ? AND s.starts_at > ? GROUP BY s.id ORDER BY s.starts_at DESC LIMIT 20`,
    ).bind(Date.now() - w.durationMin * 60_000, range.from).all(),
    db.prepare(
      `SELECT r.created_at, r.joined_at, r.watch_seconds, r.max_position, r.cta_at, r.replay_at, s.starts_at, s.mode, r.token,
              EXISTS (SELECT 1 FROM webinar_blueprints b WHERE b.reg_id = r.id) AS has_blueprint,
              l.id AS lead_id, l.first_name, l.last_name, l.email, l.channel, l.utm_campaign, l.app_completed_at, l.booked_at, l.status, COALESCE(l.tier_override, l.tier) AS tier
         FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id JOIN leads l ON l.id = r.lead_id
        WHERE r.created_at BETWEEN ? AND ? ORDER BY r.created_at DESC LIMIT 100`,
    ).bind(range.from, range.to).all(),
  ]);
  return {
    settings: {
      title: w.title, schedule: w.schedule, tz: w.tz, durationMin: w.durationMin, pitchAtMin: w.pitchAtMin, replayHours: w.replayHours,
      placeholderVideo: w.placeholderVideo, streamConfigured: Boolean(w.streamHls), url: webinarBase(rt),
    },
    kpis: kpis ?? {},
    upcoming: upcoming.results,
    past: past.results,
    registrants: recent.results,
  };
}

// ───────────── Deeper webinar insight: watch curve, slots, sources, groups, pre-webinar emails ─────────────

const DAY = 86400_000;

/** Minutes someone had on screen: the recorded minutes, or (older rows) everything from when they joined to how far they got. */
export function minutesWatched(marked: string | null, fallbackFrom: number, fallbackTo: number, len: number): boolean[] {
  const out = new Array<boolean>(len).fill(false);
  if (marked) { for (let i = 0; i < len && i < marked.length; i++) out[i] = marked[i] === '1'; return out; }
  for (let i = Math.max(0, fallbackFrom); i <= Math.min(len - 1, fallbackTo); i++) out[i] = true;
  return out;
}

export async function webinarInsights(rt: Runtime, range: { from: number; to: number }) {
  const db = rt.env.DB;
  const w = webinarSettings(rt);
  const len = Math.max(1, Math.round(w.durationMin));
  const [regs, emails, spend] = await Promise.all([
    db.prepare(
      `SELECT r.lead_id, r.revenue_band AS reg_band, l.revenue_band AS lead_band, r.created_at, r.joined_at, r.replay_at, r.cta_at, r.max_position, r.live_minutes, r.replay_minutes, s.starts_at, s.mode, s.auto,
              l.channel, l.utm_source, l.utm_medium, l.utm_campaign, l.ft_campaign,
              (l.app_completed_at IS NOT NULL AND l.app_completed_at > r.created_at) AS applied,
              (l.booked_at IS NOT NULL AND l.booked_at > r.created_at AND l.booking_cancelled_at IS NULL) AS booked,
              (l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at) AS won,
              CASE WHEN l.status = 'won' AND COALESCE(l.closed_at, 0) > r.created_at THEN COALESCE(l.revenue, 0) ELSE 0 END AS revenue,
              (l.unsubscribed_at IS NOT NULL AND l.unsubscribed_at > r.created_at) AS unsubscribed
         FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id JOIN leads l ON l.id = r.lead_id
        WHERE r.created_at BETWEEN ? AND ? AND s.status != 'cancelled'`,
    ).bind(range.from, range.to).all<{
      lead_id: string; reg_band: string | null; lead_band: string | null; created_at: number; joined_at: number | null; replay_at: number | null; cta_at: number | null; max_position: number; live_minutes: string | null; replay_minutes: string | null;
      starts_at: number; mode: string; auto: number; channel: string | null; utm_source: string | null; utm_medium: string | null; utm_campaign: string | null; ft_campaign: string | null;
      applied: number; booked: number; won: number; revenue: number; unsubscribed: number;
    }>(),
    db.prepare(
      `SELECT e.lead_id, e.send_at, e.sent_at, e.opened_at, e.clicked_at, e.status, l.webinar_at
         FROM emails e JOIN leads l ON l.id = e.lead_id
        WHERE e.sequence = 'prewebinar' AND e.status IN ('sent', 'simulated') AND e.sent_at BETWEEN ? AND ?`,
    ).bind(range.from, range.to).all<{ lead_id: string; send_at: number; sent_at: number; opened_at: number | null; clicked_at: number | null; status: string; webinar_at: number | null }>()
      .catch(() => ({ results: [] as { lead_id: string; send_at: number; sent_at: number; opened_at: number | null; clicked_at: number | null; status: string; webinar_at: number | null }[] })),
    db.prepare(`SELECT s.platform, s.campaign_id, MAX(s.campaign_name) AS name, SUM(s.spend) AS spend, c.funnel
                  FROM ad_spend s LEFT JOIN ad_campaigns c ON c.platform = s.platform AND c.campaign_id = s.campaign_id
                 WHERE s.day BETWEEN ? AND ? GROUP BY 1, 2`).bind(new Date(range.from).toISOString().slice(0, 10), new Date(range.to).toISOString().slice(0, 10))
      .all<{ platform: string; campaign_id: string; name: string | null; spend: number; funnel: string | null }>().catch(() => ({ results: [] })),
  ]);
  const rows = regs.results;

  // 1. Minute-by-minute: share of live attendees (and of replay watchers) with each minute on screen.
  const live = rows.filter((r) => r.joined_at);
  const replay = rows.filter((r) => r.replay_at && !r.joined_at);
  const curve = (list: typeof rows, kind: 'live' | 'replay') => {
    const counts = new Array<number>(len).fill(0);
    for (const r of list) {
      const from = kind === 'live' && r.joined_at ? Math.floor(Math.max(0, r.joined_at - r.starts_at) / 60_000) : 0;
      const mins = minutesWatched(kind === 'live' ? r.live_minutes : r.replay_minutes, from, Math.floor(r.max_position / 60), len);
      mins.forEach((on, i) => { if (on) counts[i]++; });
    }
    return counts.map((c) => (list.length ? c / list.length : 0));
  };
  const offerClicks = new Array<number>(len).fill(0);
  for (const r of live) if (r.cta_at) { const m = Math.floor((r.cta_at - r.starts_at) / 60_000); if (m >= 0 && m < len) offerClicks[m]++; }
  const liveCurve = curve(live, 'live');
  const atPitch = liveCurve[Math.min(len - 1, Math.max(0, Math.round(w.pitchAtMin)))] ?? 0;
  // Biggest drops: the minutes where the most of the audience left.
  const drops = liveCurve.slice(1).map((v, i) => ({ minute: i + 1, lost: Math.max(0, liveCurve[i] - v) })).sort((a, b) => b.lost - a.lost).filter((d) => d.lost > 0).slice(0, 5);

  // 2. Session slots, in the sales time zone.
  const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: w.tz, weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
  type Agg = { regs: number; qualified: number; attended: number; replays: number; cta: number; applied: number; booked: number; won: number; revenue: number; sessions: Set<number> };
  const blank = (): Agg => ({ regs: 0, qualified: 0, attended: 0, replays: 0, cta: 0, applied: 0, booked: 0, won: 0, revenue: 0, sessions: new Set() });
  const add = (a: Agg, r: (typeof rows)[number]) => {
    a.regs++; a.sessions.add(r.starts_at);
    if (isMillionPlus(r.reg_band ?? r.lead_band)) a.qualified++;
    if (r.joined_at) a.attended++; else if (r.replay_at) a.replays++;
    if (r.cta_at) a.cta++;
    a.applied += r.applied ? 1 : 0; a.booked += r.booked ? 1 : 0; a.won += r.won ? 1 : 0; a.revenue += r.revenue || 0;
  };
  const out = (key: string, a: Agg, extra: Record<string, unknown> = {}) => ({ key, sessions: a.sessions.size, regs: a.regs, qualified: a.qualified, qualifiedRate: a.regs ? a.qualified / a.regs : null, attended: a.attended, replays: a.replays, cta: a.cta, applied: a.applied, booked: a.booked, won: a.won, revenue: a.revenue,
    showRate: a.regs ? (a.attended + a.replays) / a.regs : null, liveRate: a.regs ? a.attended / a.regs : null, bookRate: a.regs ? a.booked / a.regs : null, ...extra });
  const slots = new Map<string, Agg>();
  for (const r of rows) { const k = r.auto === 2 ? 'Just-in-time showings' : fmt.format(r.starts_at).replace(',', ''); if (!slots.has(k)) slots.set(k, blank()); add(slots.get(k)!, r); }

  // 3. Sources: where registrants came from, with webinar ad spend where the campaign matches.
  const webSpend = spend.results.filter((s) => (s.funnel ?? (/webinar|masterclass|master class|workshop|training|live\b/i.test(s.name ?? '') ? 'webinar' : 'vsl')) === 'webinar');
  const spendFor = (campaign: string) => webSpend.filter((s) => (s.name ?? '').toLowerCase() === campaign || s.campaign_id.toLowerCase() === campaign).reduce((a, s) => a + (s.spend || 0), 0);
  // One row per campaign (so its spend is counted once), else per platform for untagged traffic.
  const sources = new Map<string, Agg & { campaign: string | null; platforms: Set<string> }>();
  for (const r of rows) {
    const campaign = (r.utm_campaign || r.ft_campaign || '').toLowerCase() || null;
    const platform = platformOf(r.utm_source, null, r.utm_medium) || 'Direct';
    const k = campaign ?? platform;
    if (!sources.has(k)) sources.set(k, { ...blank(), campaign, platforms: new Set() });
    sources.get(k)!.platforms.add(platform);
    add(sources.get(k)!, r);
  }

  // 4. What each group did next.
  const groups = [
    { key: 'Watched live', list: live },
    { key: 'Replay only', list: replay },
    { key: 'Didn’t watch', list: rows.filter((r) => !r.joined_at && !r.replay_at) },
  ].map((g) => { const a = blank(); g.list.forEach((r) => add(a, r)); return out(g.key, a); });

  // 5. Pre-webinar emails: engagement by days before the session, and whether engaged registrants show up more.
  const byDay = new Map<number, { sent: number; opened: number; clicked: number }>();
  const engaged = new Set<string>();
  for (const e of emails.results) {
    const d = e.webinar_at ? Math.max(0, Math.floor((e.webinar_at - e.sent_at) / DAY)) : -1;
    if (d < 0) continue;
    const b = byDay.get(d) ?? { sent: 0, opened: 0, clicked: 0 };
    b.sent++; if (e.opened_at) b.opened++; if (e.clicked_at) { b.clicked++; engaged.add(e.lead_id); }
    byDay.set(d, b);
  }
  const showOf = (list: typeof rows) => (list.length ? list.filter((r) => r.joined_at || r.replay_at).length / list.length : null);
  const gotEmails = new Set(emails.results.map((e) => e.lead_id));
  const withEmails = rows.filter((r) => gotEmails.has(r.lead_id));

  // Revenue mix of the room, and the headline test (judged on $1M+ sign-ups).
  const bands = new Map<string, number>();
  for (const r of rows) { const b = r.reg_band ?? r.lead_band ?? 'unknown'; bands.set(b, (bands.get(b) ?? 0) + 1); }
  const hstats = await webinarHeadlineStats(rt);
  const mode = (rt.settings.WEBINAR_HEADLINE_TEST || 'auto').trim().toLowerCase();
  const odds = webinarHeadlineOdds(hstats, mode, 1000);
  const totalSpend = webSpend.reduce((a, s) => a + (s.spend || 0), 0);
  const qualifiedRegs = rows.filter((r) => isMillionPlus(r.reg_band ?? r.lead_band)).length;
  // In-room engagement: polls, questions, calculator, worksheet, offer choices, thank-you answers.
  const inter = await db.prepare(
    `SELECT i.id, i.kind, i.key, i.value, i.answer, i.at_sec, i.handled, i.created_at, i.lead_id, l.first_name, l.last_name, l.email, l.revenue_band
       FROM webinar_interactions i LEFT JOIN leads l ON l.id = i.lead_id WHERE i.created_at BETWEEN ? AND ? ORDER BY i.created_at DESC LIMIT 2000`,
  ).bind(range.from, range.to).all<{ id: string; kind: string; key: string | null; value: string | null; answer: string | null; at_sec: number | null; handled: number; created_at: number; lead_id: string; first_name: string | null; last_name: string | null; email: string | null; revenue_band: string | null }>()
    .catch(() => ({ results: [] as never[] }));
  const I = inter.results;
  const blueprintsBuilt = await db.prepare("SELECT COUNT(*) AS n, SUM(source = 'ai') AS ai FROM webinar_blueprints WHERE created_at BETWEEN ? AND ?").bind(range.from, range.to).first<{ n: number; ai: number | null }>().catch(() => null);
  const count = (kind: string, key?: string) => I.filter((i) => i.kind === kind && (key == null || i.key === key)).length;
  const pollStats = DEFAULT_POLLS.map((p) => {
    const ans = I.filter((i) => i.kind === 'poll' && i.key === p.id);
    return { id: p.id, question: p.question, purpose: p.purpose, at: p.at, total: ans.length, options: p.options.map((o) => ({ label: o.label, n: ans.filter((a) => a.value === o.value).length })) };
  });
  const commits = I.filter((i) => i.kind === 'commit');
  const calcs = I.filter((i) => i.kind === 'calc').map((i) => { try { return JSON.parse(i.value ?? '{}') as { profit?: number; price?: number }; } catch { return {}; } }).filter((x) => x.profit && x.price);
  const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  // Stage funnel for $1M+ registrants (or everyone who wasn't asked).
  const q1 = rows.filter((r) => { const b = r.reg_band ?? r.lead_band; return !b || isMillionPlus(b); });
  const pitchFrac = w.pitchAtMin / len;
  const stage = [
    { key: 'Registered ($1M+)', n: q1.length },
    { key: 'Watched (live or replay)', n: q1.filter((r) => r.joined_at || r.replay_at).length },
    { key: 'Reached the offer', n: q1.filter((r) => r.max_position >= pitchFrac * len * 60 - 30).length },
    { key: 'Clicked the offer', n: q1.filter((r) => r.cta_at).length },
    { key: 'Applied', n: q1.filter((r) => r.applied).length },
    { key: 'Booked a call', n: q1.filter((r) => r.booked).length },
    { key: 'Won', n: q1.filter((r) => r.won).length },
  ];
  return {
    durationMin: len, pitchAtMin: w.pitchAtMin, tz: w.tz,
    live: await liveSummary(rt, range),
    stage,
    engagement: {
      polls: pollStats,
      questions: I.filter((i) => i.kind === 'question').slice(0, 100).map((i) => ({ id: i.id, question: i.value, answer: i.answer, at: i.at_sec, handled: Boolean(i.handled), created_at: i.created_at, lead_id: i.lead_id, name: [i.first_name, i.last_name].filter(Boolean).join(' ') || i.email || 'Someone', email: i.email, band: i.revenue_band })),
      calc: { runs: calcs.length, medianProfit: median(calcs.map((c) => c.profit!)), medianPrice: median(calcs.map((c) => c.price!)) },
      worksheets: count('bonus'),
      blueprints: { opened: count('blueprint'), built: blueprintsBuilt?.n ?? 0, polished: blueprintsBuilt?.ai ?? 0 },
      offers: { call: count('offer', 'call'), selfServe: count('offer', 'self_serve'), under: count('offer', 'under'), agreements: count('agreement') },
      targets: THANK_YOU.options.map((o) => ({ label: o.label, n: commits.filter((c) => c.value === o.value).length })),
    },
    qualified: { regs: rows.length, qualified: qualifiedRegs, rate: rows.length ? qualifiedRegs / rows.length : null, spend: totalSpend || null, perQualified: totalSpend && qualifiedRegs ? totalSpend / qualifiedRegs : null },
    bands: [...bands.entries()].map(([b, n]) => ({ band: b, label: REVENUE_LABEL[b] ?? 'Not asked (older sign-ups)', n, qualified: isMillionPlus(b === 'unknown' ? null : b) })).sort((a, b) => b.n - a.n),
    headlines: {
      mode,
      rows: WEBINAR_HEADLINES.map((h) => { const s = hstats.get(h.id)!; return { id: h.id, angle: h.angle, h1: h.h1.replace(/<[^>]+>/g, ''), ...s, rate: s.views ? s.qualified / s.views : null, share: odds.get(h.id) ?? 0 }; }),
    },
    watch: { liveViewers: live.length, replayViewers: replay.length, live: liveCurve, replay: curve(replay, 'replay'), offerClicks, atPitch, drops },
    slots: [...slots.entries()].map(([k, a]) => out(k, a)).sort((a, b) => b.regs - a.regs),
    sources: [...sources.entries()].map(([k, a]) => {
      const sp = a.campaign ? spendFor(a.campaign) : 0;
      return out(k, a, { campaign: a.campaign, platforms: [...a.platforms].join(', '), spend: sp || null, perReg: sp && a.regs ? sp / a.regs : null, perAttendee: sp && a.attended + a.replays ? sp / (a.attended + a.replays) : null, perBooked: sp && a.booked ? sp / a.booked : null, perQualified: sp && a.qualified ? sp / a.qualified : null });
    }).sort((a, b) => b.regs - a.regs).slice(0, 40),
    groups,
    emails: {
      sent: emails.results.length,
      openRate: emails.results.length ? emails.results.filter((e) => e.opened_at).length / emails.results.length : null,
      clickRate: emails.results.length ? emails.results.filter((e) => e.clicked_at).length / emails.results.length : null,
      unsubscribed: rows.filter((r) => r.unsubscribed && gotEmails.has(r.lead_id)).length,
      registrants: withEmails.length,
      byDay: [...byDay.entries()].sort((a, b) => b[0] - a[0]).map(([d, b]) => ({ daysBefore: d, ...b, openRate: b.sent ? b.opened / b.sent : null, clickRate: b.sent ? b.clicked / b.sent : null })),
      showIfClicked: showOf(withEmails.filter((r) => engaged.has(r.lead_id))),
      showIfNot: showOf(withEmails.filter((r) => !engaged.has(r.lead_id))),
      clickedPeople: withEmails.filter((r) => engaged.has(r.lead_id)).length,
    },
  };
}
