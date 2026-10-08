import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { applicationStats, attribution, dimensionList, emailStats, experiments, live, overview, parseFilters, vslStats } from '../admin/stats';
import { APPLICATION, BRAND, CLOSERS, VIDEOS } from '../config';
import { LEAD_STATUSES, type Lead, getLead, parseAnswers, updateLead } from '../funnel/leads';
import { emailConfigured, sendViaResend } from '../integrations/email';
import { SEQUENCES } from '../integrations/sequences';
import { renderEmail, TEMPLATES } from '../integrations/templates';
import { cloudApiConfigured, whatsappLink } from '../integrations/whatsapp';
import { validateEmail } from '../funnel/leads';
import { describeSettings, saveSettings } from '../settings';
import { identityFromLead, track } from '../tracking/track';

export const admin = new Hono<AppEnv>();
admin.use('*', requireAdmin);

const filters = (c: { req: { query: () => Record<string, string> } }) => parseFilters(c.req.query());

admin.get('/meta', (c) =>
  c.json({
    dimensions: dimensionList(),
    videos: Object.values(VIDEOS).map((v) => ({ id: v.id, ctaRevealAt: v.ctaRevealAt })),
    statuses: LEAD_STATUSES,
    closers: CLOSERS.map(({ id, name, tiers }) => ({ id, name, tiers })),
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
  const [sessions, events, views, emails, whatsapp] = await Promise.all([
    db.prepare(`SELECT * FROM sessions WHERE visitor_id IN (SELECT id FROM visitors WHERE lead_id = ? UNION SELECT ?) ORDER BY started_at DESC LIMIT 100`).bind(lead.id, vid).all(),
    db.prepare(`SELECT id, ts, name, path, source, props, session_id FROM events WHERE lead_id = ? OR visitor_id IN (SELECT id FROM visitors WHERE lead_id = ?) ORDER BY ts DESC LIMIT 1000`).bind(lead.id, lead.id).all(),
    db.prepare(`SELECT id, video_id, started_at, duration, max_position, watched_seconds, buckets, unmuted, completed, cta_revealed, cta_clicked FROM vsl_views WHERE lead_id = ? OR visitor_id = ? ORDER BY started_at DESC`).bind(lead.id, vid).all(),
    db.prepare(`SELECT id, sequence, template, subject, status, send_at, sent_at, opened_at, open_count, clicked_at, click_count, error FROM emails WHERE lead_id = ? ORDER BY send_at`).bind(lead.id).all(),
    db.prepare(`SELECT * FROM whatsapp_messages WHERE lead_id = ? ORDER BY ts DESC LIMIT 100`).bind(lead.id).all(),
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
  });
});

admin.patch('/leads/:id', async (c) => {
  const lead = await getLead(c.env, c.req.param('id'));
  if (!lead) return c.json({ error: 'not found' }, 404);
  const body = await c.req.json<Partial<Pick<Lead, 'status' | 'revenue' | 'notes' | 'tier_override' | 'closer_id'>>>();
  const fields: Partial<Record<keyof Lead, string | number | null>> = {};
  if (body.status && (LEAD_STATUSES as readonly string[]).includes(body.status)) fields.status = body.status;
  if (body.revenue !== undefined && Number.isFinite(Number(body.revenue))) fields.revenue = Math.max(0, Number(body.revenue));
  if (body.notes !== undefined) fields.notes = String(body.notes ?? '').slice(0, 5000);
  if (body.tier_override !== undefined) fields.tier_override = ['A', 'B', 'C'].includes(String(body.tier_override)) ? body.tier_override : null;
  if (body.closer_id !== undefined) fields.closer_id = CLOSERS.some((x) => x.id === body.closer_id) ? body.closer_id : null;
  await updateLead(c.env, lead.id, fields);
  if (fields.status && fields.status !== lead.status) {
    const rt = runtimeFrom(c);
    await track(rt, await identityFromLead(c.env, lead.id), { name: 'lead_status_changed', source: 'admin', props: { from: lead.status, to: fields.status, revenue: fields.revenue ?? lead.revenue } });
  }
  return c.json({ ok: true, lead: await getLead(c.env, lead.id) });
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
    'app_completed_at', 'booked_at', 'call_at', 'whatsapp_clicked_at', 'whatsapp_connected_at', 'revenue', 'notes'] as const;
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
      slack: { label: 'Slack', connected: Boolean(s.SLACK_WEBHOOK_URL), detail: s.SLACK_WEBHOOK_URL ? 'Hot-lead + booking alerts on' : 'Not connected' },
      crm: { label: 'CRM webhook', connected: Boolean(s.LEAD_WEBHOOK_URL), detail: s.LEAD_WEBHOOK_URL ? 'Lead lifecycle events forwarded' : 'Not connected' },
      video: { label: 'Video', connected: Boolean(s.VSL_MAIN_SRC), detail: s.VSL_MAIN_SRC ? 'Main VSL connected' : 'No VSL video yet — the page shows a placeholder.' },
    },
    webhooks: {
      calendly: `${rt.origin}/hooks/calendly`,
      booking: `${rt.origin}/hooks/booking?secret=<BOOKING_WEBHOOK_SECRET>`,
      whatsapp: `${rt.origin}/hooks/whatsapp`,
    },
  });
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
