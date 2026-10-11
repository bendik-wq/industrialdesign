import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { applicationStats, attribution, dimensionList, emailStats, experiments, live, overview, parseFilters, vslStats } from '../admin/stats';
import { APPLICATION, BRAND, VIDEOS } from '../config';
import { LEAD_STATUSES, type Lead, getLead, parseAnswers } from '../funnel/leads';
import { emailConfigured, sendViaResend } from '../integrations/email';
import { SEQUENCES } from '../integrations/sequences';
import { renderEmail, TEMPLATES } from '../integrations/templates';
import { cloudApiConfigured, whatsappLink } from '../integrations/whatsapp';
import { buildAssistant, provisionAssistant, voiceConfigured, webCallsEnabled } from '../integrations/voice';
import { validateEmail } from '../funnel/leads';
import { describeSettings, saveSettings } from '../settings';
import { salesStats } from '../admin/sales';
import { notify, notifyConfigured, type NotifyChannel } from '../integrations/notify';
import { buildDigest } from '../sales/digest';
import { REP_ROLES, type Rep, clearRepCache, slugId } from '../sales/reps';
import { LOST_REASONS, type LeadUpdate, applyLeadUpdate } from '../sales/outcomes';
import { META_API_VERSION, metaUserData } from '../tracking/forward';
import { geoFromRequest } from '../lib/geo';
import { PLACEMENTS, type TrackedLink, linkFunnels, newLinkCode, slug, youtubeId, youtubeMeta } from '../funnel/tracked-links';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);

const filters = (c: { req: { query: () => Record<string, string> } }) => parseFilters(c.req.query());

admin.get('/meta', (c) =>
  c.json({
    dimensions: dimensionList(),
    videos: Object.values(VIDEOS).map((v) => ({ id: v.id, ctaRevealAt: v.ctaRevealAt })),
    statuses: LEAD_STATUSES,
    closers: c.get('reps').filter((r) => r.active).map(({ id, name, role, tiers }) => ({ id, name, role, tiers: tiers.split(',') })),
    lostReasons: LOST_REASONS,
    sequences: Object.values(SEQUENCES).map((s) => ({ id: s.id, description: s.description, steps: s.steps.map((x) => x.template) })),
  }),
);

admin.get('/overview', async (c) => c.json(await overview(c.env, filters(c))));
admin.get('/vsl', async (c) => c.json(await vslStats(c.env, filters(c), c.req.query('video') || VIDEOS.main.id)));
admin.get('/attribution', async (c) => c.json(await attribution(c.env, filters(c), c.req.query('dim') || 'channel')));
admin.get('/application', async (c) => c.json(await applicationStats(c.env, filters(c))));
admin.get('/experiments', async (c) => c.json(await experiments(c.env, filters(c))));
admin.get('/emails', async (c) => c.json(await emailStats(c.env, filters(c))));
admin.get('/live', async (c) => c.json(await live(c.env)));

// ── Leads ───────────────────────────────────────────────────────────

function leadQuery(q: Record<string, string>) {
  const where: string[] = ['1 = 1'];
  const params: (string | number)[] = [];
  if (q.q) {
    where.push('(l.email LIKE ? OR l.first_name LIKE ? OR l.last_name LIKE ? OR l.phone LIKE ? OR l.ref_code = ?)');
    const like = `%${q.q.slice(0, 100)}%`;
    params.push(like, like, like, like, q.q.toUpperCase());
  }
  if (q.tier) { where.push('COALESCE(l.tier_override, l.tier) = ?'); params.push(q.tier); }
  if (q.status) { where.push('l.status = ?'); params.push(q.status); }
  if (q.channel) { where.push('l.channel = ?'); params.push(q.channel); }
  if (q.from) { where.push('l.created_at >= ?'); params.push(Number(q.from)); }
  if (q.to) { where.push('l.created_at <= ?'); params.push(Number(q.to)); }
  return { sql: where.join(' AND '), params };
}

admin.get('/leads', async (c) => {
  const q = c.req.query();
  const { sql, params } = leadQuery(q);
  const page = Math.max(0, Number(q.page) || 0);
  const sortable: Record<string, string> = { created: 'l.created_at', score: 'l.score', updated: 'l.updated_at', call: 'l.call_at' };
  const order = sortable[q.sort ?? 'created'] ?? 'l.created_at';
  const [rows, total] = await Promise.all([
    c.env.DB.prepare(
      `SELECT l.id, l.ref_code, l.created_at, l.first_name, l.last_name, l.email, l.phone, l.score, COALESCE(l.tier_override, l.tier) AS tier, l.status,
              l.step_reached, l.app_completed_at, l.booked_at, l.call_at, l.channel, l.utm_source, l.utm_campaign, l.utm_content, l.country, l.device,
              l.closer_id, l.revenue, l.whatsapp_clicked_at, l.whatsapp_connected_at, l.unsubscribed_at,
              (SELECT MAX(max_position / NULLIF(duration, 0)) FROM vsl_views v WHERE v.lead_id = l.id AND v.video_id = '${VIDEOS.main.id}') AS vsl_pct
         FROM leads l WHERE ${sql} ORDER BY ${order} ${q.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST LIMIT 50 OFFSET ?`,
    ).bind(...params, page * 50).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${sql}`).bind(...params).first<{ n: number }>(),
  ]);
  return c.json({ rows: rows.results, total: total?.n ?? 0, page, pageSize: 50 });
});

admin.get('/leads/:id', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const db = c.env.DB;
  const vid = lead.visitor_id ?? '';
  const [sessions, events, views, emails, whatsapp, voice] = await Promise.all([
    db.prepare(`SELECT * FROM sessions WHERE visitor_id IN (SELECT id FROM visitors WHERE lead_id = ? UNION SELECT ?) ORDER BY started_at DESC LIMIT 100`).bind(lead.id, vid).all(),
    db.prepare(`SELECT id, ts, name, path, source, props, session_id FROM events WHERE lead_id = ? OR visitor_id IN (SELECT id FROM visitors WHERE lead_id = ?) ORDER BY ts DESC LIMIT 1000`).bind(lead.id, lead.id).all(),
    db.prepare(`SELECT id, video_id, started_at, duration, max_position, watched_seconds, buckets, unmuted, completed, cta_revealed, cta_clicked FROM vsl_views WHERE lead_id = ? OR visitor_id = ? ORDER BY started_at DESC`).bind(lead.id, vid).all(),
    db.prepare(`SELECT id, sequence, template, subject, status, send_at, sent_at, opened_at, open_count, clicked_at, click_count, error FROM emails WHERE lead_id = ? ORDER BY send_at`).bind(lead.id).all(),
    db.prepare(`SELECT * FROM whatsapp_messages WHERE lead_id = ? ORDER BY ts DESC LIMIT 100`).bind(lead.id).all(),
    db.prepare(`SELECT * FROM voice_calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50`).bind(lead.id).all(),
  ]);
  const answers = parseAnswers(lead);
  const labelled = APPLICATION.filter((q) => q.type !== 'contact').map((q) => {
    const a = answers[q.id];
    const label = 'options' in q ? (Array.isArray(a) ? a : a ? [a] : []).map((v) => q.options.find((o) => o.value === v)?.label ?? v).join(', ') : (a as string | undefined) ?? '';
    return { id: q.id, question: q.title, answer: label };
  });
  return c.json({
    lead,
    answers: labelled,
    scoring: lead.score_breakdown ? JSON.parse(lead.score_breakdown) : null,
    whatsappUrl: whatsappLink(c.get('settings'), lead, lead.booked_at ? 'booked' : 'question'),
    sessions: sessions.results,
    events: events.results,
    vsl: views.results,
    emails: emails.results,
    whatsapp: whatsapp.results,
    voice: voice.results,
  });
});

admin.patch('/leads/:id', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<LeadUpdate>().catch(() => ({} as LeadUpdate));
  const fresh = await applyLeadUpdate(runtimeFrom(c), lead, body);
  return c.json({ ok: true, lead: fresh });
});

// ── Sales team ────────────────────────────────────────────────────────────
admin.get('/sales', async (c) => {
  const f = filters(c);
  const tz = c.get('settings').SALES_TIMEZONE || 'Australia/Sydney';
  return c.json({ ...(await salesStats(c.env, f.from, f.to, tz)), tz, notify: notifyConfigured(runtimeFrom(c)) });
});

type RepInput = Partial<Omit<Rep, 'active'>> & { active?: boolean | number };
const optStr = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : undefined;
};

/** Validates rep fields; returns column → value for those present. */
function repFields(b: RepInput): { fields: Record<string, string | number | null>; error?: string } {
  const f: Record<string, string | number | null> = {};
  if ('name' in b) { const n = optStr(b.name, 80); if (!n) return { fields: f, error: 'name is required' }; f.name = n; }
  if ('email' in b) { const e = optStr(b.email, 200); if (e && !validateEmail(e)) return { fields: f, error: 'invalid email' }; f.email = e; }
  if ('role' in b) { if (!REP_ROLES.includes(b.role as Rep['role'])) return { fields: f, error: 'invalid role' }; f.role = b.role!; }
  if ('tiers' in b) {
    const raw = Array.isArray(b.tiers) ? b.tiers : String(b.tiers ?? '').split(',');
    f.tiers = [...new Set(raw.map((t) => String(t).trim().toUpperCase()).filter((t) => ['A', 'B', 'C'].includes(t)))].join(',');
  }
  if ('weight' in b) f.weight = num(b.weight, 0, 100) ?? 1;
  if ('calendar_url' in b) {
    const u = optStr(b.calendar_url, 500);
    if (u && !/^https:\/\//i.test(u)) return { fields: f, error: 'calendar URL must start with https://' };
    f.calendar_url = u;
  }
  if ('commission_pct' in b) f.commission_pct = num(b.commission_pct, 0, 100) ?? 0;
  if ('monthly_target' in b) f.monthly_target = num(b.monthly_target, 0, 1e9) ?? 0;
  if ('slack_user_id' in b) { const v = optStr(b.slack_user_id, 40); if (v && !/^[UW][A-Z0-9]+$/.test(v)) return { fields: f, error: 'Slack member ID looks like U0123ABCD' }; f.slack_user_id = v; }
  if ('discord_user_id' in b) { const v = optStr(b.discord_user_id, 30); if (v && !/^\d{15,22}$/.test(v)) return { fields: f, error: 'Discord user ID is a long number' }; f.discord_user_id = v; }
  if ('active' in b) f.active = b.active ? 1 : 0;
  return { fields: f };
}

admin.get('/reps', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM reps ORDER BY active DESC, created_at, name').all<Rep>();
  const settings = c.get('settings');
  return c.json({ reps: results.map((r) => ({ ...r, legacy_calendar: r.booking_setting ? settings[r.booking_setting as keyof typeof settings] || null : null })), roles: REP_ROLES });
});

admin.post('/reps', async (c) => {
  const body = await c.req.json<RepInput>().catch(() => ({} as RepInput));
  const { fields, error } = repFields({ role: 'closer', tiers: 'A,B', ...body });
  if (error) return c.json({ error }, 400);
  if (!fields.name) return c.json({ error: 'name is required' }, 400);
  let id = slugId(String(fields.name));
  const taken = await c.env.DB.prepare('SELECT id FROM reps WHERE id = ? OR id LIKE ?').bind(id, `${id}-%`).all<{ id: string }>();
  if (taken.results.length) id = `${id}-${taken.results.length + 1}`;
  const cols = ['id', 'created_at', ...Object.keys(fields)];
  await c.env.DB.prepare(`INSERT INTO reps (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .bind(id, Date.now(), ...Object.values(fields)).run();
  clearRepCache();
  return c.json({ ok: true, id });
});

admin.patch('/reps/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<RepInput>().catch(() => ({} as RepInput));
  const { fields, error } = repFields(body);
  if (error) return c.json({ error }, 400);
  const keys = Object.keys(fields);
  if (!keys.length) return c.json({ error: 'nothing to update' }, 400);
  const res = await c.env.DB.prepare(`UPDATE reps SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).bind(...Object.values(fields), id).run();
  if (!res.meta.changes) return c.json({ error: 'not found' }, 404);
  clearRepCache();
  return c.json({ ok: true });
});

admin.post('/notify/test', async (c) => {
  const rt = runtimeFrom(c);
  const body = await c.req.json<{ channel?: NotifyChannel; rep?: string; digest?: boolean }>().catch(() => ({} as { channel?: NotifyChannel; rep?: string; digest?: boolean }));
  if (!notifyConfigured(rt)) return c.json({ error: 'Add a Slack or Discord webhook URL under Integrations → Alerts first.' }, 400);
  const channel: NotifyChannel = body.channel === 'wins' ? 'wins' : 'alerts';
  if (body.digest) {
    const d = await buildDigest(rt);
    return c.json({ ok: true, ...(await notify(rt, { kind: 'digest', ...d }, channel)) });
  }
  const rep = rt.reps.find((r) => r.id === body.rep) ?? null;
  const sent = await notify(rt, {
    kind: 'test',
    title: channel === 'wins' ? '🎉 Test — wins channel' : '🔔 Test — team alerts',
    lines: [rep ? `This should @mention ${rep.name}.` : 'Funnel HQ is connected.', 'Deal closes, hot leads, bookings, no-shows and call reminders post here.'],
    rep,
  }, channel);
  return c.json({ ok: sent.slack || sent.discord, ...sent });
});

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formula injection from user-entered fields.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

admin.get('/export/leads.csv', async (c) => {
  const { sql, params } = leadQuery(c.req.query());
  const { results } = await c.env.DB.prepare(`SELECT * FROM leads l WHERE ${sql} ORDER BY l.created_at DESC LIMIT 50000`).bind(...params).all<Lead>();
  const questionIds = APPLICATION.filter((q) => q.type !== 'contact').map((q) => q.id);
  const cols = ['id', 'ref_code', 'created_at', 'first_name', 'last_name', 'email', 'phone', 'status', 'tier', 'tier_override', 'score', 'closer_id',
    'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ft_channel', 'ft_source', 'country', 'city', 'device', 'variant',
    'app_completed_at', 'booked_at', 'call_at', 'whatsapp_clicked_at', 'whatsapp_connected_at', 'revenue', 'cash_collected', 'closed_at', 'lost_reason', 'setter_id', 'notes'] as const;
  const iso = (v: unknown) => (typeof v === 'number' && v > 1e12 ? new Date(v).toISOString() : v);
  const lines = [[...cols, ...questionIds].join(',')];
  for (const l of results) {
    const answers = parseAnswers(l);
    lines.push([...cols.map((k) => csvCell(iso(l[k]))), ...questionIds.map((q) => csvCell(Array.isArray(answers[q]) ? (answers[q] as string[]).join('; ') : answers[q]))].join(','));
  }
  return c.body(lines.join('\n'), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"` });
});

// ── Integrations ────────────────────────────────────────────────────

admin.get('/integrations', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings;
  return c.json({
    settings: await describeSettings(c.env),
    status: {
      email: { label: 'Email', connected: emailConfigured(rt), detail: emailConfigured(rt) ? `Sending as ${s.EMAIL_FROM}` : 'Emails are simulated (logged, not sent) until a Resend key and From address are connected.' },
      whatsapp: { label: 'WhatsApp', connected: Boolean(s.JOSH_WHATSAPP), detail: s.JOSH_WHATSAPP ? `Click-to-chat → +${s.JOSH_WHATSAPP.replace(/\D/g, '')}${cloudApiConfigured(s) ? ' · Cloud API connected' : ''}` : 'Add Josh’s number to turn on the WhatsApp buttons.' },
      booking: { label: 'Booking', connected: Boolean(s.BOOKING_URL_A || s.BOOKING_URL_B), detail: [s.BOOKING_URL_A && 'A-tier calendar', s.BOOKING_URL_B && 'B-tier calendar', s.CALENDLY_SIGNING_KEY && 'Calendly webhook verified'].filter(Boolean).join(' · ') || 'No calendar connected — A-tier leads are sent to the breakout page.' },
      posthog: { label: 'PostHog', connected: Boolean(s.POSTHOG_KEY), detail: s.POSTHOG_KEY ? `Server-side events → ${s.POSTHOG_HOST || 'https://us.i.posthog.com'}` : 'Not connected' },
      meta: { label: 'Meta', connected: Boolean(s.META_PIXEL_ID && s.META_ACCESS_TOKEN), detail: s.META_PIXEL_ID ? `Pixel ${s.META_PIXEL_ID}${s.META_ACCESS_TOKEN ? ' + Conversions API' : ' (browser only — add a CAPI token)'}${s.META_TEST_EVENT_CODE ? ' · TEST MODE' : ''}` : 'Not connected' },
      ga4: { label: 'GA4', connected: Boolean(s.GA4_MEASUREMENT_ID && s.GA4_API_SECRET), detail: s.GA4_MEASUREMENT_ID || 'Not connected' },
      slack: { label: 'Team pings', connected: notifyConfigured(rt), detail: notifyConfigured(rt) ? [(s.SLACK_WEBHOOK_URL || s.SLACK_WINS_WEBHOOK_URL) && 'Slack', (s.DISCORD_WEBHOOK_URL || s.DISCORD_WINS_WEBHOOK_URL) && 'Discord'].filter(Boolean).join(' + ') + ' · leads, bookings, call reminders, wins, daily digest' : 'Add a Slack or Discord webhook to ping the sales team.' },
      crm: { label: 'CRM webhook', connected: Boolean(s.LEAD_WEBHOOK_URL), detail: s.LEAD_WEBHOOK_URL ? 'Lead lifecycle events forwarded' : 'Not connected' },
      voice: { label: 'Voice agent', connected: voiceConfigured(s), detail: voiceConfigured(s) ? [s.VAPI_ASSISTANT_ID ? 'Assistant ready' : 'Assistant answers inline (not saved in Vapi yet)', s.VOICE_PHONE_NUMBER && `Inbound line ${s.VOICE_PHONE_NUMBER}`, webCallsEnabled(s) ? 'Browser calls on' : 'Browser calls off'].filter(Boolean).join(' · ') : 'Inbound only. Add your Vapi keys and a webhook secret to switch it on.' },
      video: { label: 'Video', connected: Boolean(s.VSL_MAIN_SRC), detail: s.VSL_MAIN_SRC ? 'Main VSL connected' : 'No VSL video yet — the page shows a placeholder.' },
    },
    webhooks: {
      calendly: `${rt.origin}/hooks/calendly`,
      booking: `${rt.origin}/hooks/booking?secret=<BOOKING_WEBHOOK_SECRET>`,
      whatsapp: `${rt.origin}/hooks/whatsapp`,
      voice: `${rt.origin}/hooks/voice`,
    },
  });
});

// ── Tracked links / YouTube videos ──────────────────────────────────
admin.get('/links', async (c) => {
  const f = filters(c);
  const model = c.req.query('model') === 'last' ? 'last' : 'first';
  const rt = runtimeFrom(c);
  const [{ results: rows }, funnels] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM tracked_links WHERE archived = 0 ORDER BY created_at DESC').all<TrackedLink>(),
    linkFunnels(c.env, f.from, f.to, model),
  ]);
  return c.json({
    model,
    placements: PLACEMENTS,
    links: rows.map((l) => ({ ...l, short_url: `${rt.origin}/l/${l.code}`, ...(funnels.get(l.code) ?? {}), clicks_total: l.clicks })),
  });
});

admin.post('/links', async (c) => {
  const body = await c.req.json<{ url?: string; label?: string; placement?: string; dest_path?: string; utm_source?: string; utm_medium?: string; utm_campaign?: string }>().catch(() => ({} as Record<string, string>));
  const placement = PLACEMENTS.includes(body.placement as (typeof PLACEMENTS)[number]) ? body.placement! : null;
  const dest = typeof body.dest_path === 'string' && /^\/[\w\-/]*$/.test(body.dest_path) ? body.dest_path : '/';
  const videoId = body.url ? youtubeId(body.url) : null;
  let link: Omit<TrackedLink, 'clicks' | 'last_click_at' | 'archived'>;
  if (videoId) {
    const meta = await youtubeMeta(videoId);
    const title = meta.title ?? videoId;
    link = {
      code: newLinkCode(), kind: 'youtube', video_id: videoId, video_title: title, thumbnail: meta.thumbnail, placement, dest_path: dest,
      label: (body.label || title).slice(0, 120), utm_source: 'youtube', utm_medium: 'video', utm_campaign: `yt-${slug(title, 50)}-${videoId}`, created_at: Date.now(),
    };
  } else {
    if (!body.label || !body.utm_source) return c.json({ ok: false, error: 'Paste a YouTube video URL, or give the link a name and a source.' }, 400);
    link = {
      code: newLinkCode(), kind: 'custom', video_id: null, video_title: null, thumbnail: null, placement, dest_path: dest, label: body.label.slice(0, 120),
      utm_source: slug(body.utm_source, 40), utm_medium: slug(body.utm_medium || 'referral', 40), utm_campaign: slug(body.utm_campaign || body.label, 60), created_at: Date.now(),
    };
  }
  await c.env.DB.prepare(
    `INSERT INTO tracked_links (code, label, kind, video_id, video_title, thumbnail, placement, dest_path, utm_source, utm_medium, utm_campaign, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(link.code, link.label, link.kind, link.video_id, link.video_title, link.thumbnail, link.placement, link.dest_path, link.utm_source, link.utm_medium, link.utm_campaign, link.created_at).run();
  return c.json({ ok: true, link: { ...link, short_url: `${runtimeFrom(c).origin}/l/${link.code}` } });
});

admin.delete('/links/:code', async (c) => {
  await c.env.DB.prepare('UPDATE tracked_links SET archived = 1 WHERE code = ?').bind(c.req.param('code')).run();
  return c.json({ ok: true });
});

// ── Server-side tracking health ─────────────────────────────────────
admin.get('/tracking', async (c) => {
  const f = filters(c);
  const db = c.env.DB;
  const s = c.get('settings');
  const [byDest, byEvent, meta, failures] = await Promise.all([
    db.prepare(`SELECT dest, status, COUNT(*) AS n FROM forward_log WHERE ts BETWEEN ? AND ? GROUP BY 1, 2`).bind(f.from, f.to).all(),
    db.prepare(`SELECT dest, event_name, COUNT(*) AS n, SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'retrying') AS retrying, MAX(ts) AS last_at
                  FROM forward_log WHERE ts BETWEEN ? AND ? AND dest IN ('meta', 'ga4') GROUP BY 1, 2 ORDER BY 3 DESC`).bind(f.from, f.to).all(),
    db.prepare(`SELECT match_keys FROM forward_log WHERE dest = 'meta' AND status = 'sent' AND ts BETWEEN ? AND ? ORDER BY ts DESC LIMIT 2000`).bind(f.from, f.to).all<{ match_keys: string | null }>(),
    db.prepare(`SELECT event_id, dest, event_name, ts, status, attempts, http_status, error, next_try_at FROM forward_log WHERE status != 'sent' ORDER BY updated_at DESC LIMIT 30`).all(),
  ]);
  const KEYS = ['em', 'ph', 'fn', 'ln', 'external_id', 'client_ip_address', 'client_user_agent', 'fbp', 'fbc', 'ct', 'st', 'zp', 'country'];
  const total = meta.results.length;
  const coverage = KEYS.map((k) => ({ key: k, pct: total ? meta.results.filter((r) => (r.match_keys ?? '').split(',').includes(k)).length / total : 0 }));
  return c.json({
    configured: { meta: Boolean(s.META_PIXEL_ID && s.META_ACCESS_TOKEN), pixel: Boolean(s.META_PIXEL_ID), testMode: Boolean(s.META_TEST_EVENT_CODE), ga4: Boolean(s.GA4_MEASUREMENT_ID && s.GA4_API_SECRET), posthog: Boolean(s.POSTHOG_KEY) },
    byDest: byDest.results,
    byEvent: byEvent.results,
    metaSample: total,
    coverage,
    failures: failures.results,
  });
});

// Sends one test event to Meta (shows up under Events Manager → Test events).
admin.post('/tracking/test-meta', async (c) => {
  const s = c.get('settings');
  if (!s.META_PIXEL_ID || !s.META_ACCESS_TOKEN) return c.json({ ok: false, error: 'Add the Meta Pixel ID and Conversions API token first' }, 400);
  const body = await c.req.json<{ code?: string }>().catch(() => ({} as { code?: string }));
  const code = (body.code || s.META_TEST_EVENT_CODE || '').trim();
  if (!code) return c.json({ ok: false, error: 'Paste the test event code from Events Manager → Test events' }, 400);
  const rt = runtimeFrom(c);
  const g = geoFromRequest(c.req.raw);
  const geo = { country: g.country, region: g.region, regionCode: g.regionCode, city: g.city, postalCode: g.postalCode };
  const user_data = await metaUserData({ visitorId: 'test-' + crypto.randomUUID(), sessionId: null, leadId: null, ip: c.req.header('cf-connecting-ip') ?? null, userAgent: c.req.header('user-agent') ?? null, geo }, null);
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${s.META_PIXEL_ID}/events?access_token=${encodeURIComponent(s.META_ACCESS_TOKEN)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ test_event_code: code, data: [{ event_name: 'PageView', event_time: Math.floor(Date.now() / 1000), event_id: 'test-' + Date.now(), action_source: 'website', event_source_url: rt.origin, user_data }] }),
  });
  const j = (await res.json().catch(() => ({}))) as { events_received?: number; fbtrace_id?: string; error?: { message?: string } };
  return c.json(res.ok ? { ok: true, events_received: j.events_received, fbtrace_id: j.fbtrace_id } : { ok: false, error: j.error?.message ?? `HTTP ${res.status}` }, res.ok ? 200 : 400);
});

admin.post('/voice/provision', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const { id, created } = await provisionAssistant(rt);
    await saveSettings(c.env, { VAPI_ASSISTANT_ID: id });
    return c.json({ ok: true, id, created });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 400);
  }
});

// The assistant definition, for pasting into Vapi by hand if you prefer.
admin.get('/voice/assistant.json', (c) => c.json(buildAssistant(runtimeFrom(c))));

admin.get('/voice', async (c) => {
  const f = filters(c);
  const db = c.env.DB;
  const [totals, calls] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS calls, SUM(kind = 'web') AS web, SUM(kind = 'phone') AS phone, ROUND(AVG(duration_s)) AS avg_s, ROUND(SUM(cost), 2) AS cost,
                       SUM(json_extract(structured, '$.wants_strategy_call') = 1) AS wants_call, SUM(json_extract(structured, '$.wants_human_callback') = 1) AS callbacks,
                       SUM(json_extract(structured, '$.do_not_contact') = 1) AS opt_outs
                  FROM voice_calls WHERE created_at BETWEEN ? AND ?`).bind(f.from, f.to).first(),
    db.prepare(`SELECT v.id, v.lead_id, v.kind, v.from_number, v.status, v.created_at, v.duration_s, v.ended_reason, v.cost, v.summary, v.recording_url, v.structured, v.success,
                       l.first_name, l.last_name, COALESCE(l.tier_override, l.tier) AS tier
                  FROM voice_calls v LEFT JOIN leads l ON l.id = v.lead_id WHERE v.created_at BETWEEN ? AND ? ORDER BY v.created_at DESC LIMIT 200`).bind(f.from, f.to).all(),
  ]);
  return c.json({ totals, calls: calls.results });
});

admin.put('/integrations', async (c) => {
  const body = await c.req.json<Record<string, string>>();
  await saveSettings(c.env, Object.fromEntries(Object.entries(body).filter(([, v]) => typeof v === 'string')));
  return c.json({ ok: true });
});

admin.post('/integrations/test-email', async (c) => {
  const rt = runtimeFrom(c);
  const body = await c.req.json<{ to?: string }>();
  const to = validateEmail(body.to);
  if (!to) return c.json({ ok: false, error: 'Enter a valid email address' }, 400);
  if (!emailConfigured(rt)) return c.json({ ok: false, error: 'Connect a Resend API key and From address first' }, 400);
  const content = TEMPLATES.test({ lead: {} as Lead, name: 'there', siteName: rt.settings.SITE_NAME || BRAND.name, link: (p) => p, bookingUrl: null, whatsappUrl: null, callTime: null });
  const { html, text } = renderEmail(content, { openPixel: null, unsubscribeUrl: rt.origin, signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || '' });
  try {
    const id = await sendViaResend(rt, { to: to.email, subject: content.subject, html, text, unsubscribeUrl: rt.origin, tags: { template: 'test' } });
    return c.json({ ok: true, id });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err) }, 502);
  }
});

// Preview any email template rendered for a lead (or a sample lead).
admin.get('/email-preview/:template', async (c) => {
  const tpl = TEMPLATES[c.req.param('template')];
  if (!tpl) return c.text('unknown template', 404);
  const rt = runtimeFrom(c);
  const lead = (c.req.query('lead') ? await getLead(c.env, c.req.query('lead')!) : null) ?? ({ first_name: 'Sam', ref_code: 'AB12CD' } as Lead);
  const content = tpl({
    lead,
    name: lead.first_name || 'there',
    siteName: rt.settings.SITE_NAME || BRAND.name,
    link: (p) => (/^https?:/.test(p) ? p : `${rt.origin}${p}`),
    bookingUrl: rt.settings.BOOKING_URL_A || null,
    whatsappUrl: whatsappLink(rt.settings, lead, 'question'),
    callTime: 'Thursday 12 March, 10:00 am AEDT',
  });
  return c.html(renderEmail(content, { openPixel: null, unsubscribeUrl: '#', signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || '' }).html);
});
