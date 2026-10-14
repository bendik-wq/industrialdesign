import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { applicationStats, attribution, dimensionList, emailStats, experiments, live, overview, parseFilters, vslStats } from '../admin/stats';
import { APPLICATION, BRAND, VIDEOS } from '../config';
import { LEAD_STATUSES, type Lead, getLead, parseAnswers } from '../funnel/leads';
import { buildEmail, emailConfigured, precallLimits, precallTimes, sendViaResend, usedFacts, zonedTime } from '../integrations/email';
import { buildProfile } from '../personalize/profile';
import { personalizeMode } from '../personalize/personalize';
import { PRECALL_ARC, PRECALL_STAGES, SEQUENCES, precallPlan } from '../integrations/sequences';
import { newId } from '../lib/ids';
import { webinarReport } from '../admin/webinar';
import { cancelSession, ensureSessions } from '../webinar/webinar';
import { cleanSequences, loadSmsSequences, renderSms, sendSmsNow, smsConfigured, waTemplateParams, waTemplateText } from '../integrations/sms';
import { DEFAULT_SMS_SEQUENCES, SMS_ANCHORS, SMS_CHANNELS, SMS_LINKS, SMS_SKIPS, SMS_TRIGGERS } from '../integrations/sms-defaults';
import { renderEmail, TEMPLATES } from '../integrations/templates';
import { MERGE_TAGS, cleanOverride, clearOverrideCache, defaultEditable, isEditable, loadOverrides } from '../integrations/email-overrides';
import { FOLLOWUP_TEMPLATES } from '../followup/templates';
import { dataReport, visitorJourney } from '../data/data';
import { contentReport, suggestNextVideos, syncContent } from '../content/content';
import { REACTIVATION_SEGMENTS, launchReactivation, reactivationAudience, reactivationReport } from '../sales/reactivation';
import { INDUSTRIES } from '../landers/catalog';
import { cloudApiConfigured, sendWhatsAppTemplate, sendWhatsAppText, whatsappLink } from '../integrations/whatsapp';
import { provisionInbound } from '../integrations/elevenlabs-inbound';
import { calendlyConnected, connectCalendly, importCalendlyHistory, requalifyCalendlyLeads, syncCalendly } from '../integrations/calendly';
import { type OutboundCall, dial, elevenConfigured, listPhoneNumbers, provisionAgent } from '../integrations/elevenlabs';
import { buildAssistant, provisionAssistant, voiceConfigured, webCallsEnabled } from '../integrations/voice';
import { validateEmail } from '../funnel/leads';
import { describeSettings, saveSettings } from '../settings';
import { salesStats } from '../admin/sales';
import { insights } from '../admin/insights';
import { landerReport } from '../admin/landers';
import { behaviour } from '../admin/behaviour';
import { RULES } from '../personalize/triggers';
import { notify, notifyConfigured, type NotifyChannel } from '../integrations/notify';
import { buildDigest } from '../sales/digest';
import { REP_ROLES, type Rep, clearRepCache, slugId } from '../sales/reps';
import { LOST_REASONS, OBJECTIONS, PAYMENT_PLANS, TEMPERATURES, type LeadUpdate, applyLeadUpdate, deletePayment, recordPayment } from '../sales/outcomes';
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
    objections: OBJECTIONS,
    temperatures: TEMPERATURES,
    paymentPlans: PAYMENT_PLANS,
    sequences: Object.values(SEQUENCES).map((s) => ({ id: s.id, description: s.description, steps: s.steps.map((x) => x.template) })),
  }),
);

admin.get('/overview', async (c) => {
  const f = filters(c);
  const out: any = await overview(c.env, f);
  // Read-only extra for the Overview email card: how many of the "sent" emails were only simulated (no Resend key), so a 0% open rate can be explained.
  try {
    const r = await c.env.DB.prepare(`SELECT SUM(status = 'simulated') AS simulated, SUM(status = 'sent') AS real FROM emails WHERE sent_at BETWEEN ? AND ?`).bind(f.from, f.to).first<any>();
    if (out && out.kpis) { out.kpis.emails_simulated = Number(r?.simulated) || 0; out.kpis.emails_real = Number(r?.real) || 0; }
  } catch { /* leave the fields absent */ }
  return c.json(out);
});
// Past calls for quick outcome logging (Sales → Call log).
admin.get('/sales/calls', async (c) => {
  const tier = c.req.query('tier') || '';
  const unlogged = c.req.query('unlogged') === '1';
  const where = ["l.booked_at IS NOT NULL", "l.booking_cancelled_at IS NULL", "l.call_at < ?"];
  const params: (string | number)[] = [Date.now()];
  if (['A', 'B', 'C'].includes(tier)) { where.push('COALESCE(l.tier_override, l.tier) = ?'); params.push(tier); }
  if (unlogged) where.push("l.status = 'booked'");
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.first_name, l.last_name, l.email, l.call_at, COALESCE(l.tier_override, l.tier) AS tier, l.score, l.status, l.revenue, l.cash_collected,
            l.temperature, l.objection, l.revenue_band, l.industry, l.booking_source, l.closer_id
       FROM leads l WHERE ${where.join(' AND ')} ORDER BY COALESCE(l.tier_override, l.tier) IS NULL, COALESCE(l.tier_override, l.tier), l.call_at DESC LIMIT 300`,
  ).bind(...params).all();
  return c.json({ calls: results });
});

admin.get('/landers', async (c) => { const f = filters(c); return c.json(await landerReport(c.env, f.from, f.to)); });
admin.get('/behaviour', async (c) => { const f = filters(c); return c.json(await behaviour(c.env, f.from, f.to, c.req.query('path') || null)); });
admin.get('/triggers', async (c) => {
  const f = filters(c);
  const { results } = await c.env.DB.prepare(
    `SELECT e.template, COUNT(*) AS queued, SUM(e.status IN ('sent', 'simulated')) AS sent, SUM(e.status = 'skipped') AS skipped, SUM(e.status = 'pending') AS pending,
            SUM(e.opened_at IS NOT NULL) AS opened, SUM(e.clicked_at IS NOT NULL) AS clicked,
            SUM(l.booked_at IS NOT NULL AND l.booked_at > COALESCE(e.sent_at, e.send_at)) AS booked_after
       FROM emails e JOIN leads l ON l.id = e.lead_id WHERE e.sequence = 'behaviour' AND e.created_at BETWEEN ? AND ? GROUP BY 1`,
  ).bind(f.from, f.to).all<{ template: string }>();
  const by = new Map(results.map((r) => [r.template, r]));
  return c.json({ rules: RULES.map((r) => ({ queued: 0, sent: 0, skipped: 0, pending: 0, opened: 0, clicked: 0, booked_after: 0, ...(by.get(r.template) ?? {}), template: r.template, label: r.label, delay: r.delay })) });
});

// Funnel map layout (box positions), shared by everyone who logs in.
admin.get('/map-layout', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'map:layout'").first<{ value: string }>();
  return c.json({ layout: row ? JSON.parse(row.value) : null });
});
admin.put('/map-layout', async (c) => {
  const body = await c.req.json<{ layout?: Record<string, { x: number; y: number }> | null }>().catch(() => ({ layout: null }));
  if (!body.layout) { await c.env.DB.prepare("DELETE FROM kv_state WHERE key = 'map:layout'").run(); return c.json({ ok: true }); }
  const clean: Record<string, { x: number; y: number }> = {};
  for (const [k, v] of Object.entries(body.layout).slice(0, 200)) if (/^[\w-]{1,40}$/.test(k) && Number.isFinite(v?.x) && Number.isFinite(v?.y)) clean[k] = { x: Math.round(Math.max(0, Math.min(5000, v.x))), y: Math.round(Math.max(0, Math.min(5000, v.y))) };
  await c.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('map:layout', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(clean)).run();
  return c.json({ ok: true });
});

/** Your own steps and arrows on the funnel map, plus edits and notes on the built-in boxes. */
admin.get('/map-custom', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'map:custom'").first<{ value: string }>();
  return c.json({ custom: row ? JSON.parse(row.value) : null });
});
admin.put('/map-custom', async (c) => {
  const body = await c.req.json<{ custom?: unknown }>().catch(() => ({ custom: null }));
  const raw = (body.custom && typeof body.custom === 'object' ? body.custom : {}) as { nodes?: unknown; edges?: unknown; edits?: unknown };
  const txt = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const KINDS = ['traffic', 'page', 'decision', 'auto', 'people', 'data'];
  const ID = /^[\w-]{1,40}$/;
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
  await c.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('map:custom', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify({ nodes, edges, edits })).run();
  return c.json({ ok: true, nodes: nodes.length, edges: edges.length });
});

// ── Webinar ──
admin.get('/webinar', async (c) => {
  const rt = runtimeFrom(c);
  await ensureSessions(rt).catch(() => 0);
  const f = filters(c);
  return c.json(await webinarReport(rt, { from: f.from, to: f.to }));
});
admin.post('/webinar/sessions', async (c) => {
  const b = await c.req.json<{ starts_at?: number; mode?: string; join_url?: string; title?: string; video_src?: string }>().catch(() => ({} as Record<string, never>));
  const startsAt = Number(b.starts_at);
  if (!Number.isFinite(startsAt) || startsAt < Date.now() - 3_600_000 || startsAt > Date.now() + 365 * 86_400_000) return c.json({ error: 'Pick a date and time in the future' }, 400);
  const mode = ['evergreen', 'stream', 'live'].includes(String(b.mode)) ? String(b.mode) : 'evergreen';
  const https = (v: unknown) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v.trim()) ? v.trim().slice(0, 500) : null);
  const joinUrl = https(b.join_url);
  if (mode === 'live' && !joinUrl) return c.json({ error: 'Live sessions need the https join link (Zoom, YouTube, StreamYard…)' }, 400);
  const title = typeof b.title === 'string' ? b.title.replace(/[<>]/g, '').trim().slice(0, 120) || null : null;
  const id = newId('ws');
  const res = await c.env.DB.prepare("INSERT OR IGNORE INTO webinar_sessions (id, starts_at, title, mode, join_url, video_src, status, auto, created_at) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', 0, ?)")
    .bind(id, startsAt, title, mode, joinUrl, https(b.video_src), Date.now()).run();
  if (!res.meta.changes) return c.json({ error: 'There’s already a session at that exact time' }, 409);
  return c.json({ ok: true, id });
});
admin.delete('/webinar/sessions/:id', async (c) => c.json({ ok: true, ...(await cancelSession(runtimeFrom(c), c.req.param('id'))) }));

admin.get('/insights', async (c) => c.json(await insights(c.env, c.get('settings').SALES_TIMEZONE || 'Australia/Sydney')));
admin.get('/vsl', async (c) => c.json(await vslStats(c.env, filters(c), c.req.query('video') || VIDEOS.main.id)));
admin.get('/attribution', async (c) => c.json(await attribution(c.env, filters(c), c.req.query('dim') || 'channel')));
admin.get('/application', async (c) => c.json(await applicationStats(c.env, filters(c))));
admin.get('/experiments', async (c) => c.json(await experiments(c.env, filters(c))));
admin.get('/emails', async (c) => c.json(await emailStats(c.env, filters(c))));
admin.get('/sms', async (c) => {
  const f = filters(c);
  const db = c.env.DB;
  const [bySeq, recent, consent] = await Promise.all([
    db.prepare(`SELECT sequence, template, SUM(status IN ('sent','simulated')) AS sent, SUM(status = 'pending') AS pending, SUM(status = 'skipped') AS skipped, SUM(status = 'failed') AS failed, SUM(clicked_at IS NOT NULL) AS clicked
                  FROM sms_messages WHERE direction = 'out' AND created_at BETWEEN ? AND ? GROUP BY sequence, template ORDER BY sequence, template`).bind(f.from, f.to).all(),
    db.prepare(`SELECT s.direction, s.template, s.body, s.status, s.error, s.sent_at, s.created_at, s.lead_id, l.first_name, l.last_name FROM sms_messages s LEFT JOIN leads l ON l.id = s.lead_id
                 WHERE s.created_at BETWEEN ? AND ? ORDER BY s.created_at DESC LIMIT 60`).bind(f.from, f.to).all(),
    db.prepare(`SELECT SUM(call_consent_at IS NOT NULL AND phone IS NOT NULL) AS consented, SUM(sms_opt_out_at IS NOT NULL) AS opted_out FROM leads`).first(),
  ]);
  const s = c.get('settings');
  return c.json({ configured: Boolean(s.TWILIO_ACCOUNT_SID && s.TWILIO_AUTH_TOKEN && s.SMS_FROM), enabled: s.SMS_ENABLED.trim().toLowerCase() !== 'false', webhook: `${runtimeFrom(c).origin}/hooks/twilio/sms`, bySeq: bySeq.results, recent: recent.results, consent });
});
// ── SMS sequence builder ──
admin.get('/sms/sequences', async (c) => {
  const rt = runtimeFrom(c);
  const [sequences, stats] = await Promise.all([
    loadSmsSequences(rt),
    c.env.DB.prepare(`SELECT sequence, step, SUM(status IN ('sent','simulated')) AS sent, SUM(clicked_at IS NOT NULL) AS clicked, SUM(status = 'skipped') AS skipped, SUM(status = 'pending') AS pending
                        FROM sms_messages WHERE direction = 'out' GROUP BY sequence, step`).all<{ sequence: string; step: number; sent: number; clicked: number; skipped: number; pending: number }>(),
  ]);
  const confirmed = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM leads WHERE sms_confirmed_at IS NOT NULL').first<{ n: number }>();
  const wa = await c.env.DB.prepare("SELECT SUM(wa_consent_at IS NOT NULL OR whatsapp_connected_at IS NOT NULL) AS reachable, (SELECT COUNT(*) FROM sms_messages WHERE channel = 'whatsapp' AND status = 'sent') AS sent FROM leads WHERE phone IS NOT NULL").first<{ reachable: number; sent: number }>();
  const s = rt.settings;
  return c.json({
    sequences, defaults: DEFAULT_SMS_SEQUENCES, triggers: SMS_TRIGGERS, links: SMS_LINKS, anchors: SMS_ANCHORS, skips: SMS_SKIPS, channels: SMS_CHANNELS, stats: stats.results, confirmed: confirmed?.n ?? 0,
    whatsapp: { configured: cloudApiConfigured(s), webhook: `${rt.origin}/hooks/whatsapp`, signed: Boolean(s.WHATSAPP_APP_SECRET), reachable: wa?.reachable ?? 0, sent: wa?.sent ?? 0, lang: s.WHATSAPP_TEMPLATE_LANG || 'en' },
    templates: Object.fromEntries(sequences.flatMap((q) => q.steps.map((st) => [`${q.id}:${st.n}`, waTemplateText(st, s.SITE_NAME || 'G&L')]))),
  });
});
admin.put('/sms/sequences', async (c) => {
  const body = await c.req.json<{ sequences?: unknown }>().catch(() => ({ sequences: null }));
  let clean;
  try { clean = cleanSequences(body.sequences); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 400); }
  await c.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('sms:sequences', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(JSON.stringify(clean)).run();
  return c.json({ ok: true, sequences: await loadSmsSequences(runtimeFrom(c)) });
});
admin.post('/sms/test-step', async (c) => {
  const rt = runtimeFrom(c);
  const b = await c.req.json<{ to?: string; step?: unknown; channel?: string }>().catch(() => ({} as { to?: string; step?: unknown; channel?: string }));
  const number = String(b.to ?? '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(number)) return c.json({ ok: false, error: 'Enter your number in international format, e.g. +61412345678' }, 400);
  const viaWa = b.channel === 'whatsapp' && cloudApiConfigured(rt.settings);
  if (!viaWa && !smsConfigured(rt)) return c.json({ ok: false, error: 'Connect Twilio first (Integrations → SMS).' }, 400);
  const [seq] = cleanSequences([{ id: 'booked', steps: [{ ...(b.step as object), n: 1 }] }]);
  if (!seq?.steps[0]) return c.json({ ok: false, error: 'That text is empty.' }, 400);
  const sample = { id: 'test', first_name: 'Dana', phone: number, call_at: Date.now() + 86_400_000, webinar_at: Date.now() + 2 * 86_400_000, webinar_token: null, timezone: rt.settings.SALES_TIMEZONE || 'Australia/Sydney', closer_id: null, tier: 'A', tier_override: null, booking_join_url: null, booking_reschedule_url: null } as unknown as Lead;
  const { body, values } = renderSms(rt, sample, seq.steps[0], 'test000000', false);
  try {
    if (viaWa) {
      const who = { phone: number, whatsapp_wa_id: null };
      // A template if this text has one; otherwise free text (only arrives if you've messaged the number in the last 24h).
      if (seq.steps[0].wa) await sendWhatsAppTemplate(rt, who, seq.steps[0].wa, waTemplateParams(seq.steps[0], values));
      else await sendWhatsAppText(rt, who, `[TEST] ${body}`);
      return c.json({ ok: true, channel: 'whatsapp' });
    }
    await sendSmsNow(rt, number, `[TEST] ${body}`); return c.json({ ok: true });
  } catch (e) { return c.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400); }
});

admin.post('/sms/test', async (c) => {
  const rt = runtimeFrom(c);
  const { to } = await c.req.json<{ to?: string }>().catch(() => ({ to: '' }));
  const number = String(to ?? '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(number)) return c.json({ ok: false, error: 'Enter your number in international format, e.g. +61412345678' }, 400);
  if (!smsConfigured(rt)) return c.json({ ok: false, error: 'Add the Twilio Account SID, Auth Token and “Send texts from” first.' }, 400);
  const s = rt.settings;
  const form = new URLSearchParams({ To: number, Body: `Test text from ${s.SITE_NAME || 'Funnel HQ'}: SMS follow-up is connected.` });
  if (/^MG[0-9a-f]{32}$/i.test(s.SMS_FROM)) form.set('MessagingServiceSid', s.SMS_FROM); else form.set('From', s.SMS_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(s.TWILIO_ACCOUNT_SID)}/Messages.json`, { method: 'POST', headers: { authorization: `Basic ${btoa(`${s.TWILIO_ACCOUNT_SID}:${s.TWILIO_AUTH_TOKEN}`)}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const data = (await res.json().catch(() => ({}))) as { message?: string };
  return c.json(res.ok ? { ok: true } : { ok: false, error: `Twilio: ${data.message ?? res.status}` }, res.ok ? 200 : 400);
});
// Funnel HQ → All pages: every page in funnel order, previewed live (previews never count; see identity.ts).
admin.get('/pages', (c) => {
  const ind = INDUSTRIES[0];
  const pages = [
    { group: 'Main funnel', title: 'Main page: VSL + application', desc: 'Where ads land. Headline A/B test, the VSL, and the application under it.', path: '/' },
    { group: 'Main funnel', title: `Industry lander (e.g. ${ind.label})`, desc: '100 versions: 20 industries × 5 headlines, picked by ad or by the bandit.', path: `/for/${ind.id}` },
    { group: 'Main funnel', title: 'Application (own page)', desc: 'The same questions as on the main page, on their own.', path: '/apply' },
    { group: 'Main funnel', title: 'Book a call (qualified)', desc: 'A/B-tier applicants pick a time with their closer.', path: '/book?hq_as=qualified' },
    { group: 'Main funnel', title: 'Part 2 video (applied, not booked)', desc: 'After the application: the second video plus “book your call”.', path: '/breakout?hq_as=qualified' },
    { group: 'Main funnel', title: 'Booked: pre-call video', desc: 'After booking: the call time, what to prepare and the pre-call video.', path: '/breakout?hq_as=booked' },
    { group: 'Main funnel', title: 'Resources (C-tier)', desc: 'Applicants who don’t qualify yet get the free resources instead of a call.', path: '/resources' },
    { group: 'Webinar', title: 'Webinar sign-up', desc: 'The masterclass registration page (live.grosfjeld-li.com).', path: '/webinar' },
    { group: 'Data partner', title: 'Data page', desc: 'The micro1 referral page (data.grosfjeld-li.com). Shows one of the 20 headlines.', path: '/data' },
    { group: 'Other', title: 'Privacy policy', desc: 'Linked from every page and every email.', path: '/privacy' },
  ];
  return c.json({ pages: pages.map((p, i) => ({ ...p, n: i + 1, src: `${p.path}${p.path.includes('?') ? '&' : '?'}hq_preview=1` })) });
});
admin.get('/visitors/:id', async (c) => {
  const j = await visitorJourney(runtimeFrom(c), c.req.param('id').slice(0, 64));
  return j ? c.json(j) : c.json({ error: 'not found' }, 404);
});
admin.get('/data', async (c) => { const f = filters(c); return c.json(await dataReport(runtimeFrom(c), f.from, f.to)); });
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
    db.prepare(`SELECT id, sequence, template, subject, status, send_at, sent_at, opened_at, open_count, clicked_at, click_count, error, personalized, facts_used FROM emails WHERE lead_id = ? ORDER BY send_at`).bind(lead.id).all(),
    db.prepare(`SELECT * FROM whatsapp_messages WHERE lead_id = ? ORDER BY ts DESC LIMIT 100`).bind(lead.id).all(),
    db.prepare(`SELECT * FROM voice_calls WHERE lead_id = ? ORDER BY created_at DESC LIMIT 50`).bind(lead.id).all(),
  ]);
  const calendly = await db.prepare(`SELECT start_at, booked_at, status, rescheduled, event_name, host_email, cancel_reason, answers FROM calendly_bookings WHERE lead_id = ? OR email = ? ORDER BY start_at DESC LIMIT 50`).bind(lead.id, lead.email ?? '').all().catch(() => ({ results: [] }));
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
    calendly: calendly.results,
  });
});

// Payments ledger (cash collected, instalments, refunds).
admin.get('/leads/:id/payments', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM payments WHERE lead_id = ? ORDER BY paid_at DESC').bind(c.req.param('id')).all();
  return c.json({ payments: results });
});
admin.post('/leads/:id/payments', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  try {
    const fresh = await recordPayment(runtimeFrom(c), lead, await c.req.json());
    return c.json({ ok: true, cash_collected: fresh.cash_collected });
  } catch (err) {
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 400);
  }
});
admin.delete('/leads/:id/payments/:pid', async (c) => {
  const fresh = await deletePayment(runtimeFrom(c), c.req.param('id'), c.req.param('pid'));
  return c.json({ ok: true, cash_collected: fresh.cash_collected });
});

// What this lead did, as the facts the email personaliser works from.
admin.get('/leads/:id/profile', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const [profile, used] = await Promise.all([buildProfile(c.env, lead), usedFacts(runtimeFrom(c), lead.id)]);
  const next = await c.env.DB.prepare("SELECT template, sequence, send_at FROM emails WHERE lead_id = ? AND status = 'pending' ORDER BY send_at LIMIT 1").bind(lead.id).first<{ template: string; sequence: string; send_at: number }>();
  return c.json({ facts: profile.facts.map((f) => ({ ...f, used: used.has(f.key) })), data: profile.data, mode: personalizeMode(c.get('settings')), next });
});

// Renders the personalised version of an email for this lead without sending it (calls the model in "ai" mode).
// ── Pre-call flow (Emails → Pre-call flow): what a booked lead gets, for several booking lead times ──
async function precallSampleLead(c: Context<AppEnv>) {
  const id = c.req.query('lead');
  const lead = id
    ? await getLead(c.env, id)
    : await c.env.DB.prepare("SELECT * FROM leads WHERE app_completed_at IS NOT NULL AND email IS NOT NULL AND COALESCE(tier_override, tier) IN ('A', 'B') ORDER BY app_completed_at DESC LIMIT 1").first<Lead>();
  return lead ?? ({ id: 'l_sample', ref_code: 'SAMPLE', first_name: 'Dana', email: 'dana@example.com', status: 'booked', tier: 'A', answers: null } as unknown as Lead);
}
admin.get('/precall-flow', async (c) => {
  const rt = runtimeFrom(c);
  const base = await precallSampleLead(c);
  const { perDay, min, max } = precallLimits(rt);
  const tz = base.timezone || rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  // A realistic booking moment: today 10:00 in their zone (or now, if later).
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(Date.now());
  const g = (k: string) => Number(parts.find((x) => x.type === k)!.value);
  const now = Math.max(zonedTime(g('year'), g('month'), g('day'), 10, tz), Math.ceil(Date.now() / 900_000) * 900_000);
  // Subjects can mention the call time, so they're worked out per scenario.
  const subjects = new Map<string, string>();
  const subjectOf = async (t: string, lead: Lead) => {
    const k = `${t}|${lead.call_at}`;
    if (!subjects.has(k)) { try { subjects.set(k, (await buildEmail(rt, lead, `pv-${t}`, t, 'preview')).subject); } catch { subjects.set(k, t); } }
    return subjects.get(k)!;
  };
  const hoursList = [6, 20, 30, 54, 120];
  const scenarios = [];
  for (const hours of hoursList) {
    const callAt = now + hours * 3_600_000;
    const lead = { ...base, call_at: callAt, booked_at: now, booking_cancelled_at: null, status: 'booked', timezone: tz } as Lead;
    const full = precallPlan(lead);
    const times = perDay > 0 ? precallTimes(now, callAt, tz, perDay, Math.min(max, full.length), min) : [];
    const plan = precallPlan(lead, times.length);
    const emails = [];
    for (let i = 0; i < times.length; i++) {
      const t = plan[i];
      emails.push({ at: times[i], template: t, subject: await subjectOf(t, lead), stage: PRECALL_ARC[t]?.stage ?? 4, priority: PRECALL_ARC[t]?.priority ?? 3, personal: t.startsWith('pp_') });
    }
    const reminders = [];
    for (const st of SEQUENCES.booked.steps) {
      const at = st.anchor === 'call_at' ? callAt + st.offsetMs : now + st.offsetMs;
      if (at >= now) reminders.push({ at, template: st.template, subject: await subjectOf(st.template, lead) });
    }
    scenarios.push({ hours, bookedAt: now, callAt, emails, reminders, available: full.length });
  }
  return c.json({
    lead: { id: base.id, name: [base.first_name, base.last_name].filter(Boolean).join(' ') || 'Sample lead', sample: base.id === 'l_sample' },
    tz, limits: { perDay, min, max }, stages: PRECALL_STAGES, scenarios,
  });
});
admin.get('/precall-flow/email', async (c) => {
  const template = c.req.query('template') || '';
  if (!TEMPLATES[template]) return c.json({ error: 'unknown template' }, 400);
  const lead = { ...(await precallSampleLead(c)), call_at: Date.now() + 2 * 86_400_000, booked_at: Date.now(), status: 'booked' } as Lead;
  const email = await buildEmail(runtimeFrom(c), lead, `preview-${template}`, template, 'preview');
  return c.json({ subject: email.subject, html: email.html });
});

// ── Talk-instead-of-type check: speak a sentence with ElevenLabs, then transcribe it back (admin only). ──
admin.post('/voice-input/test', async (c) => {
  const key = c.get('settings').ELEVENLABS_API_KEY;
  if (!key) return c.json({ ok: false, error: 'No ElevenLabs API key set (Integrations → Voice).' }, 400);
  const said = 'We run three physio clinics in Brisbane with about twenty five staff.';
  const tts = await fetch('https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM?output_format=mp3_44100_64', { method: 'POST', headers: { 'xi-api-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ text: said, model_id: 'eleven_flash_v2_5' }) });
  if (!tts.ok) return c.json({ ok: false, step: 'text-to-speech', status: tts.status, error: (await tts.text()).slice(0, 300) }, 400);
  const form = new FormData();
  form.set('model_id', 'scribe_v1');
  form.set('file', new Blob([await tts.arrayBuffer()], { type: 'audio/mpeg' }), 'test.mp3');
  const stt = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: form });
  const j = (await stt.json().catch(() => ({}))) as { text?: string };
  return c.json(stt.ok ? { ok: true, said, heard: j.text ?? '' } : { ok: false, step: 'speech-to-text', status: stt.status, error: JSON.stringify(j).slice(0, 300) }, stt.ok ? 200 : 400);
});

// ── Content (YouTube / Instagram) ──
admin.get('/content', async (c) => c.json(await contentReport(runtimeFrom(c))));
admin.post('/content/sync', async (c) => c.json({ ok: true, results: await syncContent(runtimeFrom(c)) }));
admin.post('/content/suggest', async (c) => {
  try { return c.json({ ok: true, suggestions: await suggestNextVideos(runtimeFrom(c)) }); } catch (e) { return c.json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) }, 400); }
});

// ── Email editor ──
async function editorSample(c: Context<AppEnv>) {
  const lead = await c.env.DB.prepare("SELECT * FROM leads WHERE email IS NOT NULL AND app_completed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1").first<Lead>();
  return { ...(lead ?? ({ id: 'l_sample', ref_code: 'SAMPLE', first_name: 'Dana', email: 'dana@example.com', status: 'booked', tier: 'A' } as unknown as Lead)), call_at: Date.now() + 2 * 86_400_000, booked_at: Date.now() } as Lead;
}
admin.get('/email-editor', async (c) => {
  const rt = runtimeFrom(c);
  const overrides = await loadOverrides(rt);
  const stats = await c.env.DB.prepare("SELECT template, SUM(status IN ('sent','simulated')) AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked FROM emails GROUP BY template").all<{ template: string; sent: number; opened: number; clicked: number }>();
  const st = new Map(stats.results.map((r) => [r.template, r]));
  const seen = new Set<string>();
  const item = (t: string) => {
    seen.add(t);
    const o = overrides.get(t), d = defaultEditable(t);
    return { template: t, subject: o?.subject ?? d?.subject ?? t, edited: Boolean(o), editable: isEditable(t), personal: t in FOLLOWUP_TEMPLATES, sent: st.get(t)?.sent ?? 0, opened: st.get(t)?.opened ?? 0, clicked: st.get(t)?.clicked ?? 0 };
  };
  const groups = Object.values(SEQUENCES).map((q) => ({ id: q.id, description: q.description, emails: [...new Set(q.steps.map((x) => x.template))].filter((t) => TEMPLATES[t]).map(item) }));
  const rest = Object.keys(TEMPLATES).filter((t) => !seen.has(t));
  if (rest.length) groups.push({ id: 'other', description: 'One-off emails (links sent on request, by the AI assistant…)', emails: rest.map(item) });
  return c.json({ groups, tags: MERGE_TAGS, edited: overrides.size });
});
admin.get('/email-editor/:template', async (c) => {
  const t = c.req.param('template');
  if (!TEMPLATES[t]) return c.json({ error: 'unknown email' }, 404);
  const o = (await loadOverrides(runtimeFrom(c))).get(t) ?? null;
  return c.json({ template: t, editable: isEditable(t), personal: t in FOLLOWUP_TEMPLATES, default: defaultEditable(t), override: o, tags: MERGE_TAGS });
});
admin.put('/email-editor/:template', async (c) => {
  const t = c.req.param('template');
  if (!isEditable(t)) return c.json({ ok: false, error: 'This email is written from each lead’s own answers and can’t be edited here.' }, 400);
  let o;
  try { o = cleanOverride(await c.req.json<Record<string, unknown>>()); } catch (e) { return c.json({ ok: false, error: String(e instanceof Error ? e.message : e) }, 400); }
  await c.env.DB.prepare(`INSERT INTO email_overrides (template, subject, preheader, body, cta_label, cta_href, ps, updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(template) DO UPDATE SET subject = excluded.subject, preheader = excluded.preheader, body = excluded.body, cta_label = excluded.cta_label, cta_href = excluded.cta_href, ps = excluded.ps, updated_at = excluded.updated_at`)
    .bind(t, o.subject, o.preheader, o.body, o.cta_label, o.cta_href, o.ps, Date.now()).run();
  clearOverrideCache();
  return c.json({ ok: true });
});
admin.delete('/email-editor/:template', async (c) => {
  await c.env.DB.prepare('DELETE FROM email_overrides WHERE template = ?').bind(c.req.param('template')).run();
  clearOverrideCache();
  return c.json({ ok: true });
});
admin.post('/email-editor/:template/preview', async (c) => {
  const rt = runtimeFrom(c);
  const t = c.req.param('template');
  if (!TEMPLATES[t]) return c.json({ error: 'unknown email' }, 404);
  const b = await c.req.json<{ fields?: Record<string, unknown> | null }>().catch(() => ({ fields: null }));
  let override: ReturnType<typeof cleanOverride> | null | undefined;
  if (b.fields && isEditable(t)) { try { override = cleanOverride(b.fields); } catch (e) { return c.json({ error: String(e instanceof Error ? e.message : e) }, 400); } }
  const email = await buildEmail(rt, await editorSample(c), `preview-${t}`, t, 'preview', override !== undefined ? { override } : {});
  return c.json({ subject: email.subject, html: email.html });
});

// ── Reactivation ──
admin.get('/reactivation', async (c) => {
  const rt = runtimeFrom(c);
  const [aud, report] = await Promise.all([reactivationAudience(rt), reactivationReport(rt)]);
  const emails = SEQUENCES.reactivation.steps.map((st) => ({ template: st.template, day: Math.floor(st.offsetMs / 86_400_000), subject: '' }));
  const sample = await c.env.DB.prepare('SELECT * FROM leads WHERE email IS NOT NULL ORDER BY created_at DESC LIMIT 1').first<Lead>();
  for (const e of emails) { try { e.subject = (await buildEmail(rt, sample ?? ({ id: 'x', first_name: 'Dana', email: 'd@example.com' } as Lead), 'pv', e.template, 'preview')).subject; } catch { e.subject = e.template; } }
  return c.json({ segments: REACTIVATION_SEGMENTS, counts: aud.counts, audience: aud.rows, report, emails, emailLive: emailConfigured(rt) });
});
admin.post('/reactivation/launch', async (c) => {
  const b = await c.req.json<{ ids?: unknown; perDay?: unknown; confirm?: unknown }>().catch(() => ({} as { ids?: unknown; perDay?: unknown; confirm?: unknown }));
  if (b.confirm !== 'SEND') return c.json({ ok: false, error: 'Type SEND to confirm.' }, 400);
  const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string').slice(0, 5000) : [];
  if (!ids.length) return c.json({ ok: false, error: 'Nobody selected.' }, 400);
  return c.json({ ok: true, ...(await launchReactivation(runtimeFrom(c), ids, Number(b.perDay) || 40)) });
});
admin.post('/reactivation/stop', async (c) => {
  const r = await c.env.DB.prepare("UPDATE emails SET status = 'cancelled' WHERE sequence = 'reactivation' AND status = 'pending'").run();
  return c.json({ ok: true, cancelled: r.meta.changes ?? 0 });
});

admin.get('/leads/:id/preview-email', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const template = c.req.query('template') || '';
  if (!TEMPLATES[template]) return c.json({ error: 'unknown template' }, 400);
  const seq = Object.values(SEQUENCES).find((s) => s.steps.some((x) => x.template === template));
  const email = await buildEmail(runtimeFrom(c), lead, `preview-${Date.now()}`, template, 'preview', { personalize: { purpose: seq?.description ?? template } });
  return c.json({ subject: email.subject, html: email.html, mode: email.personal?.mode ?? 'off', factsUsed: email.personal?.factsUsed ?? [], error: email.personal?.error ?? null });
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
      booking: { label: 'Booking', connected: Boolean(s.BOOKING_URL_A || s.BOOKING_URL_B), detail: [s.BOOKING_URL_A && 'A-tier calendar', s.BOOKING_URL_B && 'B-tier calendar', s.CALENDLY_API_TOKEN && 'Calendly API (exact times, links, hourly sync)', s.CALENDLY_SIGNING_KEY && 'webhook signed'].filter(Boolean).join(' · ') || 'No calendar connected — A-tier leads are sent to the breakout page.' },
      posthog: { label: 'PostHog', connected: Boolean(s.POSTHOG_KEY), detail: s.POSTHOG_KEY ? `Server-side events → ${s.POSTHOG_HOST || 'https://us.i.posthog.com'}` : 'Not connected' },
      meta: { label: 'Meta', connected: Boolean(s.META_PIXEL_ID && s.META_ACCESS_TOKEN), detail: s.META_PIXEL_ID ? `Pixel ${s.META_PIXEL_ID}${s.META_ACCESS_TOKEN ? ' + Conversions API' : ' (browser only — add a CAPI token)'}${s.META_TEST_EVENT_CODE ? ' · TEST MODE' : ''}` : 'Not connected' },
      ga4: { label: 'GA4', connected: Boolean(s.GA4_MEASUREMENT_ID && s.GA4_API_SECRET), detail: s.GA4_MEASUREMENT_ID || 'Not connected' },
      slack: { label: 'Team pings', connected: notifyConfigured(rt), detail: notifyConfigured(rt) ? [(s.SLACK_WEBHOOK_URL || s.SLACK_WINS_WEBHOOK_URL) && 'Slack', (s.DISCORD_WEBHOOK_URL || s.DISCORD_WINS_WEBHOOK_URL) && 'Discord'].filter(Boolean).join(' + ') + ' · leads, bookings, call reminders, wins, daily digest' : 'Add a Slack or Discord webhook to ping the sales team.' },
      crm: { label: 'CRM webhook', connected: Boolean(s.LEAD_WEBHOOK_URL), detail: s.LEAD_WEBHOOK_URL ? 'Lead lifecycle events forwarded' : 'Not connected' },
      voice: { label: 'Voice agent', connected: voiceConfigured(s), detail: voiceConfigured(s) ? [s.VAPI_ASSISTANT_ID ? 'Assistant ready' : 'Assistant answers inline (not saved in Vapi yet)', s.VOICE_PHONE_NUMBER && `Inbound line ${s.VOICE_PHONE_NUMBER}`, webCallsEnabled(s) ? 'Browser calls on' : 'Browser calls off'].filter(Boolean).join(' · ') : 'Inbound only. Add your Vapi keys and a webhook secret to switch it on.' },
      aiCalls: { label: 'AI calls (ElevenLabs)', connected: elevenConfigured(s), detail: elevenConfigured(s) ? `Confirmation calls ${s.AI_CALL_CONFIRM.trim().toLowerCase() === 'false' ? 'off' : 'on'} · speed-to-lead ${s.AI_CALL_SPEED_TO_LEAD.trim().toLowerCase() === 'false' ? 'off' : 'on'} · no-show rebook ${s.AI_CALL_REBOOK.trim().toLowerCase() === 'false' ? 'off' : 'on'} · consenting leads only` : 'Add an ElevenLabs API key, then finish setup on the Voice tab.' },
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
  const dest = typeof body.dest_path === 'string' && /^\/(?!\/)[\w\-/]*$/.test(body.dest_path) ? body.dest_path : '/';
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

// ── ElevenLabs outbound calls ──
admin.get('/voice/elevenlabs', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings;
  let phoneNumbers: { phone_number: string; label: string | null; phone_number_id: string; provider: string }[] = [];
  let phoneError: string | null = null;
  if (s.ELEVENLABS_API_KEY) {
    try {
      phoneNumbers = await listPhoneNumbers(s);
      // One number and none chosen yet → use it.
      if (!s.ELEVENLABS_PHONE_NUMBER_ID && phoneNumbers.length === 1) await saveSettings(c.env, { ELEVENLABS_PHONE_NUMBER_ID: phoneNumbers[0].phone_number_id });
    } catch (e) {
      phoneError = String(e instanceof Error ? e.message : e).slice(0, 300);
    }
  }
  const db = c.env.DB;
  const [queue, stats] = await Promise.all([
    db.prepare(`SELECT o.*, l.first_name, l.last_name, l.phone, COALESCE(l.tier_override, l.tier) AS tier FROM outbound_calls o LEFT JOIN leads l ON l.id = o.lead_id ORDER BY o.created_at DESC LIMIT 60`).all<OutboundCall>(),
    db.prepare(`SELECT COUNT(*) AS consented, (SELECT COUNT(*) FROM leads WHERE phone IS NOT NULL) AS with_phone FROM leads WHERE call_consent_at IS NOT NULL AND do_not_call_at IS NULL`).first(),
  ]);
  return c.json({
    apiKey: Boolean(s.ELEVENLABS_API_KEY),
    agentId: s.ELEVENLABS_AGENT_ID || null,
    inboundAgentId: s.ELEVENLABS_INBOUND_AGENT_ID || null,
    inboundAssigned: Boolean(s.ELEVENLABS_INBOUND_AGENT_ID && phoneNumbers.some((p) => p.phone_number_id === (s.ELEVENLABS_PHONE_NUMBER_ID || phoneNumbers[0]?.phone_number_id) && (p as { assigned_agent?: { agent_id?: string } | null }).assigned_agent?.agent_id === s.ELEVENLABS_INBOUND_AGENT_ID)),
    phoneNumberId: s.ELEVENLABS_PHONE_NUMBER_ID || (phoneNumbers.length === 1 ? phoneNumbers[0].phone_number_id : null),
    phoneNumbers,
    phoneError,
    ready: elevenConfigured(s) || Boolean(s.ELEVENLABS_API_KEY && s.ELEVENLABS_AGENT_ID && phoneNumbers.length === 1),
    confirm: s.AI_CALL_CONFIRM.trim().toLowerCase() !== 'false',
    speedToLead: s.AI_CALL_SPEED_TO_LEAD.trim().toLowerCase() !== 'false',
    rebook: s.AI_CALL_REBOOK.trim().toLowerCase() !== 'false',
    webhook: { url: `${rt.origin}/hooks/elevenlabs`, secret: Boolean(s.ELEVENLABS_WEBHOOK_SECRET) },
    stats,
    queue: queue.results,
  });
});

admin.post('/voice/elevenlabs/provision', async (c) => {
  try {
    const rt = runtimeFrom(c);
    const { id, created } = await provisionAgent(rt);
    await saveSettings(c.env, { ELEVENLABS_AGENT_ID: id });
    const inbound = await provisionInbound(rt);
    await saveSettings(c.env, { ELEVENLABS_INBOUND_AGENT_ID: inbound.id });
    return c.json({ ok: true, id, created, inbound });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 600) }, 400);
  }
});

admin.post('/voice/elevenlabs/phone', async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({ id: '' }));
  await saveSettings(c.env, { ELEVENLABS_PHONE_NUMBER_ID: String(id ?? '').slice(0, 100) });
  return c.json({ ok: true });
});

// Rings YOUR phone with the confirmation script, using a lead's details (or sample ones) — for testing.
admin.post('/voice/elevenlabs/test-call', async (c) => {
  const rt = runtimeFrom(c);
  if (!elevenConfigured(rt.settings)) return c.json({ ok: false, error: 'Connect the API key, create the agent and pick a phone number first.' }, 400);
  const { to, leadId, kind } = await c.req.json<{ to?: string; leadId?: string; kind?: 'confirm' | 'speed_to_lead' }>().catch(() => ({} as { to?: string; leadId?: string; kind?: 'confirm' | 'speed_to_lead' }));
  const number = String(to ?? '').replace(/[^\d+]/g, '');
  if (!/^\+\d{8,15}$/.test(number)) return c.json({ ok: false, error: 'Enter your number in international format, e.g. +61412345678' }, 400);
  const lead = (leadId ? await getLead(c.env, leadId) : null) ?? ({
    id: 'test', ref_code: 'TEST01', first_name: 'there', email: 'you@example.com', phone: number, status: 'booked', tier: 'A', tier_override: null,
    call_at: Date.now() + 2 * 86_400_000, closer_id: rt.reps.find((r) => r.active && r.role !== 'setter')?.id ?? null, answers: JSON.stringify({ business: 'Commercial HVAC, 25 staff' }),
    country: null, timezone: null,
  } as unknown as Lead);
  try {
    const r = await dial(rt, lead, kind === 'speed_to_lead' ? 'speed_to_lead' : 'confirm', undefined, number);
    return c.json({ ok: true, conversationId: r.conversationId });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 600) }, 400);
  }
});

admin.get('/voice/elevenlabs/audio/:id', async (c) => {
  const s = c.get('settings');
  if (!s.ELEVENLABS_API_KEY) return c.text('not configured', 404);
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/conversations/${encodeURIComponent(c.req.param('id'))}/audio`, { headers: { 'xi-api-key': s.ELEVENLABS_API_KEY } });
  if (!res.ok) return c.text('recording not available', res.status === 404 ? 404 : 502);
  return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'private, max-age=3600' } });
});

// ── Calendly API ──
admin.post('/calendly/connect', async (c) => {
  const rt = runtimeFrom(c);
  if (!calendlyConnected(rt.settings)) return c.json({ ok: false, error: 'Add the Calendly personal access token under Integrations → Booking first.' }, 400);
  try {
    const out = await connectCalendly(rt);
    const sync = await syncCalendly(rt, { force: true, daysBack: 60 });
    return c.json({ ok: true, ...out, sync });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 500) }, 400);
  }
});

// Full history import, one page per request; the dashboard keeps calling with the returned cursor.
admin.post('/calendly/import', async (c) => {
  const rt = runtimeFrom(c);
  if (!calendlyConnected(rt.settings)) return c.json({ ok: false, error: 'Calendly isn’t connected.' }, 400);
  const { cursor } = await c.req.json<{ cursor?: string | null }>().catch(() => ({ cursor: null }));
  try {
    return c.json({ ok: true, ...(await importCalendlyHistory(rt, cursor ?? null)) });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 500) }, 400);
  }
});

admin.post('/calendly/requalify', async (c) => c.json({ ok: true, requalified: await requalifyCalendlyLeads(runtimeFrom(c)) }));

admin.post('/calendly/sync', async (c) => {
  try {
    return c.json({ ok: true, sync: await syncCalendly(runtimeFrom(c), { force: true, daysBack: 60 }) });
  } catch (err) {
    return c.json({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 500) }, 400);
  }
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
  // Sandboxed: the preview can contain a lead's own words, and it renders on the dashboard's origin.
  c.header('content-security-policy', 'sandbox; default-src \'none\'; img-src https: data:; style-src \'unsafe-inline\'');
  return c.html(renderEmail(content, { openPixel: null, unsubscribeUrl: '#', signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || '' }).html);
});
