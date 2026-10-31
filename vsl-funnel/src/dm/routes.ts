import type { Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { getLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { flag, saveSettings } from '../settings';
import { logAction } from '../ops/actions';
import { NO_KEY_NOTE, draftReply, precallSummary } from './ai';
import { GraphError, igConfigured, refreshIgToken, subscribeWebhooks, verifyChallenge, verifyIgSignature, whoAmI } from './graph';
import { DmError, type DmMessage, type DmThread, type IgWebhook, addNote, getThread, importRecent, ingestWebhook, parseTags, sendReply, syncWithLeads, updateThread } from './inbox';
import { DAY, DM_STATUSES, awaitingReply, keywordList, priority, windowLabel, windowState } from './rules';
import { managerDashboard, maybeSendSetterDigests, processDmAlerts, scriptReport, sortByPriority } from './team';

/**
 * Routes for the DM inbox, mounted on the existing routers so they inherit their guards:
 *  - mountDmHooks(hooks): GET/POST /hooks/instagram (Meta's verify handshake; X-Hub-Signature-256 checked);
 *  - mountDmAdmin(admin): /admin/api/dm/* (admin session + same-origin writes, via requireAdmin).
 */

const body = async (c: Context<AppEnv>) => {
  const t = await c.req.text().catch(() => '');
  if (!t || t.length > 64_000) return {} as Record<string, unknown>;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
};
const fail = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof DmError) return c.json({ ok: false, error: e.message }, e.status);
  if (e instanceof GraphError) return c.json({ ok: false, error: e.message }, 502);
  console.error('dm api', e);
  return c.json({ ok: false, error: 'Something went wrong. Try again.' }, 500);
};
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function mountDmHooks(hooks: Hono<AppEnv>) {
  hooks.get('/instagram', (c) => {
    const challenge = verifyChallenge(c.get('settings'), { mode: c.req.query('hub.mode'), token: c.req.query('hub.verify_token'), challenge: c.req.query('hub.challenge') });
    return challenge === null ? c.text('forbidden', 403) : c.text(challenge);
  });
  hooks.post('/instagram', async (c) => {
    const rt = runtimeFrom(c);
    const raw = await c.req.text();
    if (!rt.settings.IG_APP_SECRET) return c.json({ error: 'IG_APP_SECRET not configured' }, 501);
    if (!(await verifyIgSignature(rt.settings.IG_APP_SECRET, raw, c.req.header('x-hub-signature-256') ?? null))) return c.text('bad signature', 401);
    let payload: IgWebhook;
    try { payload = JSON.parse(raw); } catch { return c.text('bad json', 400); }
    // Acknowledge fast (Meta retries slow or failed deliveries); duplicates are deduped by message / comment id.
    rt.waitUntil(ingestWebhook(rt, payload));
    return c.text('ok');
  });
}

/** Thread as the inbox list shows it. */
export function listRow(t: DmThread, now: number, humanAgent: boolean) {
  const w = windowState(t, now, { humanAgent });
  return {
    id: t.id, username: t.username, name: t.name, status: t.status, assignee_id: t.assignee_id, tags: parseTags(t), band: t.band, score: t.score, score_reason: t.score_reason,
    revenue_band: t.revenue_band, ai_flag: t.ai_flag, ai_reason: t.ai_reason, source: t.source, last_preview: t.last_preview, last_message_at: t.last_message_at, last_in_at: t.last_in_at,
    unread: t.unread, follow_up_at: t.follow_up_at, lead_id: t.lead_id, waiting: awaitingReply(t), waiting_min: awaitingReply(t) ? Math.round((now - (t.last_in_at ?? now)) / 60_000) : 0,
    window: { mode: w.mode, label: windowLabel(w), ms_left: w.msLeft }, priority: priority(t, now), deal_value: t.deal_value,
  };
}

const SCRIPT_CATEGORIES = ['opener', 'followup', 'faq', 'objection', 'booking'];

export function mountDmAdmin(admin: Hono<AppEnv>) {
  admin.get('/dm/status', async (c) => {
    const rt = runtimeFrom(c);
    const s = rt.settings;
    const counts = await rt.env.DB.prepare("SELECT COUNT(*) AS threads, SUM(CASE WHEN last_in_at > COALESCE(last_out_at, 0) AND status NOT IN ('closed','lost') THEN 1 ELSE 0 END) AS waiting FROM dm_threads").first<{ threads: number; waiting: number }>();
    return c.json({
      configured: igConfigured(s), account: s.IG_ACCOUNT_ID || null, appSecret: Boolean(s.IG_APP_SECRET), verifyToken: Boolean(s.IG_WEBHOOK_VERIFY_TOKEN), appId: s.IG_APP_ID || null,
      ai: Boolean(s.ANTHROPIC_API_KEY), autoReply: flag(s.DM_AUTO_REPLY), humanAgent: flag(s.DM_HUMAN_AGENT), webhook: `${rt.origin}/hooks/instagram`, counts,
      reps: rt.reps.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name, role: r.role })), statuses: DM_STATUSES, aiNote: s.ANTHROPIC_API_KEY ? null : NO_KEY_NOTE,
    });
  });

  // Check: token works, account id saved, Instagram User token refreshed (60 days), webhooks subscribed for the account.
  admin.post('/dm/check', async (c) => {
    const rt = runtimeFrom(c);
    const s = rt.settings;
    const steps: string[] = [];
    if (!s.IG_ACCESS_TOKEN) return c.json({ ok: false, error: 'Add the Instagram access token first (Keys & settings → Instagram DMs).', steps: setupSteps(rt) });
    try {
      const me = await whoAmI(rt);
      if (me.id && me.id !== s.IG_ACCOUNT_ID) { await saveSettings(rt.env, { IG_ACCOUNT_ID: me.id }); s.IG_ACCOUNT_ID = me.id; steps.push(`Saved account ID ${me.id}.`); }
      const last = await rt.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'dm:token_refreshed'").first<{ value: string }>();
      if (/^IG/.test(s.IG_ACCESS_TOKEN) && Date.now() - Number(last?.value ?? 0) > DAY) {
        try {
          const fresh = await refreshIgToken(rt);
          if (fresh) {
            await saveSettings(rt.env, { IG_ACCESS_TOKEN: fresh });
            await rt.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('dm:token_refreshed', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
            steps.push('Token renewed for another 60 days.');
          }
        } catch (e) { steps.push(`Token not renewed: ${(e as Error).message}`); }
      }
      let webhooks = false;
      try { webhooks = Boolean((await subscribeWebhooks(rt)).success); steps.push(webhooks ? 'Webhooks on for messages, postbacks, referrals and comments.' : 'Webhook subscription not confirmed.'); } catch (e) { steps.push(`Webhooks not subscribed: ${(e as Error).message}`); }
      if (!s.IG_APP_SECRET) steps.push('Add the Meta app secret so webhooks can be verified.');
      if (!s.IG_WEBHOOK_VERIFY_TOKEN) steps.push('Add a webhook verify token and paste it in the Meta app with the callback URL.');
      await logAction(rt, { dept: 'dm', kind: 'dm.check', summary: `Instagram connection checked for @${me.username ?? me.id}`, actor: 'you', status: 'done' });
      return c.json({ ok: true, account: me, webhooks, steps });
    } catch (e) {
      return c.json({ ok: false, error: e instanceof Error ? e.message : 'Check failed', steps: setupSteps(rt) });
    }
  });

  admin.post('/dm/import', async (c) => {
    try {
      const rt = runtimeFrom(c);
      if (!rt.settings.IG_ACCOUNT_ID) {
        const me = await whoAmI(rt);
        await saveSettings(rt.env, { IG_ACCOUNT_ID: me.id });
        rt.settings.IG_ACCOUNT_ID = me.id;
      }
      const b = await body(c);
      return c.json({ ok: true, ...(await importRecent(rt, str(b.cursor, 500) || null)) });
    } catch (e) { return fail(c, e); }
  });

  admin.get('/dm/threads', async (c) => {
    const rt = runtimeFrom(c);
    const q = c.req.query();
    const where: string[] = [];
    const args: (string | number)[] = [];
    const view = q.view || 'open';
    if (view === 'open') where.push("status NOT IN ('closed', 'lost') AND COALESCE(ai_flag, '') != 'junk'");
    if (view === 'waiting') where.push("last_in_at > COALESCE(last_out_at, 0) AND status NOT IN ('closed', 'lost') AND COALESCE(ai_flag, '') != 'junk'");
    if (view === 'junk') where.push("ai_flag = 'junk'");
    if (view === 'done') where.push("status IN ('closed', 'lost')");
    if (q.status && (DM_STATUSES as readonly string[]).includes(q.status)) { where.push('status = ?'); args.push(q.status); }
    if (q.band && ['hot', 'warm', 'cold'].includes(q.band)) { where.push('band = ?'); args.push(q.band); }
    if (q.assignee === 'none') where.push('assignee_id IS NULL');
    else if (q.assignee) { where.push('assignee_id = ?'); args.push(q.assignee); }
    if (q.tag) { where.push('tags LIKE ?'); args.push(`%"${q.tag.replace(/["%_]/g, '')}"%`); }
    if (q.q) { where.push('(username LIKE ? OR name LIKE ? OR last_preview LIKE ?)'); const like = `%${q.q.slice(0, 60)}%`; args.push(like, like, like); }
    const rows = (await rt.env.DB.prepare(`SELECT * FROM dm_threads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY last_message_at DESC LIMIT 500`).bind(...args).all<DmThread>()).results;
    const now = Date.now();
    const ha = flag(rt.settings.DM_HUMAN_AGENT);
    const tags = [...new Set(rows.flatMap((t) => parseTags(t)))].sort();
    return c.json({ threads: sortByPriority(rows, now).map(({ t }) => listRow(t, now, ha)), tags });
  });

  admin.get('/dm/threads/:id', async (c) => {
    const rt = runtimeFrom(c);
    const t = await getThread(rt, c.req.param('id'));
    if (!t) return c.json({ error: 'not found' }, 404);
    const [messages, notes, comments, lead] = await Promise.all([
      rt.env.DB.prepare('SELECT * FROM dm_messages WHERE thread_id = ? ORDER BY ts LIMIT 500').bind(t.id).all<DmMessage>(),
      rt.env.DB.prepare('SELECT * FROM dm_notes WHERE thread_id = ? ORDER BY ts LIMIT 300').bind(t.id).all(),
      rt.env.DB.prepare('SELECT id, media_id, body, ts, private_reply_at, public_reply_id, error FROM dm_comments WHERE ig_user_id = ? ORDER BY ts DESC LIMIT 20').bind(t.ig_user_id).all(),
      t.lead_id ? getLead(rt.env, t.lead_id) : Promise.resolve(null),
    ]);
    const link = t.link_code ? await rt.env.DB.prepare('SELECT code, label, clicks FROM tracked_links WHERE code = ?').bind(t.link_code).first() : null;
    const visits = t.link_sent_at ? await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE landing_query LIKE ?").bind(`%dm=${t.id}%`).first<{ n: number }>() : null;
    return c.json({
      thread: { ...listRow(t, Date.now(), flag(rt.settings.DM_HUMAN_AGENT)), ig_user_id: t.ig_user_id, source_detail: t.source_detail, created_at: t.created_at, booked_at: t.booked_at, showed_at: t.showed_at, closed_at: t.closed_at, summary_at: t.summary_at, lead_match: t.lead_match, link_code: t.link_code },
      messages: messages.results, notes: notes.results, comments: comments.results, link, linkVisits: visits?.n ?? 0,
      lead: lead && { id: lead.id, name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), email: lead.email, phone: lead.phone, status: lead.status, tier: lead.tier_override ?? lead.tier, revenue_band: lead.revenue_band, industry: lead.industry, call_at: lead.call_at, revenue: lead.revenue, cash: lead.cash_collected, setter_id: lead.setter_id, closer_id: lead.closer_id, source: [lead.channel, lead.utm_source, lead.utm_campaign, lead.utm_content].filter(Boolean).join(' / '), ref: lead.ref_code },
    });
  });

  admin.patch('/dm/threads/:id', async (c) => {
    try {
      const rt = runtimeFrom(c);
      const b = await body(c);
      const t = await updateThread(rt, c.req.param('id'), {
        status: b.status === undefined ? undefined : String(b.status), assignee_id: b.assignee_id === undefined ? undefined : (b.assignee_id as string | null),
        tags: Array.isArray(b.tags) ? b.tags.map(String) : undefined, follow_up_at: b.follow_up_at as never, deal_value: b.deal_value as never,
        lead_id: b.lead_id === undefined ? undefined : (b.lead_id as string | null), unread: b.unread === undefined ? undefined : Number(b.unread),
      }, str(b.actor, 60) || null);
      return c.json({ ok: true, thread: listRow(t, Date.now(), flag(rt.settings.DM_HUMAN_AGENT)) });
    } catch (e) { return fail(c, e); }
  });

  admin.post('/dm/threads/:id/send', async (c) => {
    try {
      const rt = runtimeFrom(c);
      const b = await body(c);
      return c.json(await sendReply(rt, c.req.param('id'), { text: str(b.text, 2000), by: str(b.by, 60) || null, script_id: str(b.script_id, 60) || null, ai_drafted: Boolean(b.ai_drafted) }));
    } catch (e) { return fail(c, e); }
  });

  admin.post('/dm/threads/:id/draft', async (c) => {
    try {
      const rt = runtimeFrom(c);
      const b = await body(c);
      return c.json({ ok: true, ...(await draftReply(rt, c.req.param('id'), str(b.by, 60) || null)) });
    } catch (e) { return fail(c, e); }
  });

  admin.post('/dm/threads/:id/notes', async (c) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const text = str(b.body, 4000);
    if (!text) return c.json({ ok: false, error: 'Write a note first' }, 400);
    if (!(await getThread(rt, c.req.param('id')))) return c.json({ error: 'not found' }, 404);
    const author = rt.reps.find((r) => r.id === str(b.author, 60))?.name ?? 'Team';
    return c.json({ ok: true, id: await addNote(rt, c.req.param('id'), 'note', author, text) });
  });

  admin.post('/dm/threads/:id/summary', async (c) => {
    try {
      const rt = runtimeFrom(c);
      await rt.env.DB.prepare('UPDATE dm_threads SET summary_at = NULL WHERE id = ?').bind(c.req.param('id')).run();
      const s = await precallSummary(rt, c.req.param('id'));
      return c.json({ ok: Boolean(s), summary: s, note: rt.settings.ANTHROPIC_API_KEY ? null : NO_KEY_NOTE });
    } catch (e) { return fail(c, e); }
  });

  // Control center: bulk reassign / status / tag. Never bulk messaging.
  admin.post('/dm/bulk', async (c) => {
    try {
      const rt = runtimeFrom(c);
      const b = await body(c);
      const ids = Array.isArray(b.ids) ? b.ids.map(String).slice(0, 200) : [];
      if (!ids.length) return c.json({ ok: false, error: 'Select conversations first' }, 400);
      let n = 0;
      for (const id of ids) {
        const t = await getThread(rt, id);
        if (!t) continue;
        const tag = str(b.tag, 30);
        await updateThread(rt, id, {
          ...(b.assignee_id !== undefined ? { assignee_id: (b.assignee_id as string | null) || null } : {}),
          ...(b.status ? { status: String(b.status) } : {}),
          ...(tag ? { tags: [...parseTags(t), tag] } : {}),
        }, str(b.actor, 60) || null);
        n++;
      }
      await logAction(rt, { dept: 'dm', kind: 'dm.bulk', summary: `Bulk update on ${n} conversation${n === 1 ? '' : 's'}`, actor: 'you', status: 'done', payload: { ids, assignee_id: b.assignee_id ?? null, status: b.status ?? null, tag: b.tag ?? null } });
      return c.json({ ok: true, updated: n });
    } catch (e) { return fail(c, e); }
  });

  // ── Scripts / quick replies ──
  admin.get('/dm/scripts', async (c) => {
    const rt = runtimeFrom(c);
    const rows = (await rt.env.DB.prepare('SELECT * FROM dm_scripts ORDER BY category, title').all()).results;
    return c.json({ scripts: rows, categories: SCRIPT_CATEGORIES, report: await scriptReport(rt) });
  });
  admin.post('/dm/scripts', async (c) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const title = str(b.title, 80), text = str(b.body, 1000);
    if (!title || !text) return c.json({ ok: false, error: 'A script needs a title and a message' }, 400);
    const id = str(b.id, 40);
    const now = Date.now();
    const cat = SCRIPT_CATEGORIES.includes(String(b.category)) ? String(b.category) : 'opener';
    if (id && (await rt.env.DB.prepare('SELECT 1 FROM dm_scripts WHERE id = ?').bind(id).first())) {
      await rt.env.DB.prepare('UPDATE dm_scripts SET title = ?, body = ?, category = ?, shortcut = ?, active = ?, updated_at = ? WHERE id = ?').bind(title, text, cat, str(b.shortcut, 20) || null, b.active === false ? 0 : 1, now, id).run();
      return c.json({ ok: true, id });
    }
    const nid = newId('scr');
    await rt.env.DB.prepare('INSERT INTO dm_scripts (id, title, body, category, shortcut, active, created_at, updated_at) VALUES (?,?,?,?,?,1,?,?)').bind(nid, title, text, cat, str(b.shortcut, 20) || null, now, now).run();
    return c.json({ ok: true, id: nid });
  });
  admin.delete('/dm/scripts/:id', async (c) => {
    // Archived, not deleted: past messages keep pointing at it for the analytics.
    await c.env.DB.prepare('UPDATE dm_scripts SET active = 0, updated_at = ? WHERE id = ?').bind(Date.now(), c.req.param('id')).run();
    return c.json({ ok: true });
  });

  // ── Keyword triggers ──
  admin.get('/dm/triggers', async (c) => {
    const [triggers, links, scripts] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM dm_triggers ORDER BY created_at').all(),
      c.env.DB.prepare('SELECT code, label FROM tracked_links WHERE archived = 0 ORDER BY created_at DESC LIMIT 200').all(),
      c.env.DB.prepare('SELECT id, title FROM dm_scripts WHERE active = 1 ORDER BY title').all(),
    ]);
    return c.json({ triggers: triggers.results, links: links.results, scripts: scripts.results });
  });
  admin.post('/dm/triggers', async (c) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const name = str(b.name, 80), keywords = keywordList(str(b.keywords, 600)).join(', ');
    if (!name || !keywords) return c.json({ ok: false, error: 'A trigger needs a name and at least one keyword' }, 400);
    const sources = (Array.isArray(b.sources) ? b.sources.map(String) : ['comment', 'story_reply', 'dm']).filter((s) => ['comment', 'story_reply', 'dm'].includes(s));
    if (!sources.length) return c.json({ ok: false, error: 'Pick at least one place to listen: comments, Story replies or DMs' }, 400);
    const mode = ['word', 'contains', 'exact'].includes(String(b.match_mode)) ? String(b.match_mode) : 'word';
    const assign = rt.reps.some((r) => r.id === b.assign_to) ? String(b.assign_to) : null;
    const link = str(b.link_code, 40) ? (await rt.env.DB.prepare('SELECT code FROM tracked_links WHERE code = ?').bind(str(b.link_code, 40).toLowerCase()).first<{ code: string }>())?.code ?? null : null;
    const script = str(b.script_id, 40) ? (await rt.env.DB.prepare('SELECT id FROM dm_scripts WHERE id = ?').bind(str(b.script_id, 40)).first<{ id: string }>())?.id ?? null : null;
    const vals = [name, keywords, mode, JSON.stringify(sources), str(b.tag, 30) || null, assign, str(b.first_message, 1000) || null, script, link, str(b.public_reply, 300) || null, b.active === false ? 0 : 1];
    const now = Date.now();
    const id = str(b.id, 40);
    if (id && (await rt.env.DB.prepare('SELECT 1 FROM dm_triggers WHERE id = ?').bind(id).first())) {
      await rt.env.DB.prepare('UPDATE dm_triggers SET name = ?, keywords = ?, match_mode = ?, sources = ?, tag = ?, assign_to = ?, first_message = ?, script_id = ?, link_code = ?, public_reply = ?, active = ?, updated_at = ? WHERE id = ?').bind(...vals, now, id).run();
      return c.json({ ok: true, id });
    }
    const nid = newId('trg');
    await rt.env.DB.prepare('INSERT INTO dm_triggers (name, keywords, match_mode, sources, tag, assign_to, first_message, script_id, link_code, public_reply, active, created_at, updated_at, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(...vals, now, now, nid).run();
    await logAction(rt, { dept: 'dm', kind: 'dm.trigger_saved', summary: `Keyword trigger "${name}" created`, actor: 'you', status: 'done', payload: { id: nid, keywords } });
    return c.json({ ok: true, id: nid });
  });
  admin.delete('/dm/triggers/:id', async (c) => {
    await c.env.DB.prepare('DELETE FROM dm_triggers WHERE id = ?').bind(c.req.param('id')).run();
    return c.json({ ok: true });
  });

  admin.get('/dm/dashboard', async (c) => c.json(await managerDashboard(runtimeFrom(c))));

  admin.get('/dm/leads', async (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 80);
    if (q.length < 2) return c.json({ leads: [] });
    const like = `%${q}%`;
    const rows = await c.env.DB.prepare("SELECT id, first_name, last_name, email, ref_code, status FROM leads WHERE email LIKE ? OR first_name || ' ' || COALESCE(last_name, '') LIKE ? OR ref_code = ? ORDER BY created_at DESC LIMIT 10").bind(like, like, q.toUpperCase()).all();
    return c.json({ leads: rows.results });
  });
}

/** What the owner does in Meta's app dashboard (also shown by Check when something is missing). */
export function setupSteps(rt: Runtime) {
  return [
    'In developers.facebook.com create a Business app and add the Instagram product (Instagram API with Instagram Login), or use Facebook Login with the Instagram account connected to your Facebook Page.',
    'Request instagram_business_basic, instagram_business_manage_messages and instagram_business_manage_comments (Facebook Login: instagram_basic, instagram_manage_messages, instagram_manage_comments, pages_show_list, pages_read_engagement). Advanced Access needs App Review and business verification; your own account works in Standard Access while you test.',
    `Webhooks: callback URL ${rt.origin}/hooks/instagram, the verify token from this page, fields messages, messaging_postbacks, messaging_referral and comments.`,
    'Generate a long-lived token for the account, paste it with the app ID and secret here, then press Check.',
    'Optional: request the Human Agent feature in App Review if setters need to reply up to 7 days after a message, then switch on the human agent setting.',
  ];
}

/** Cron (every 5 minutes): outcomes from leads, DM-link attribution, hot-lead and follow-up alerts, setter digests. */
export async function processDm(rt: Runtime) {
  const has = await rt.env.DB.prepare('SELECT 1 FROM dm_threads LIMIT 1').first().catch(() => null);
  if (!has) return null;
  const [sync, alerts, digests] = await Promise.all([syncWithLeads(rt), processDmAlerts(rt), maybeSendSetterDigests(rt)]);
  return { ...sync, ...alerts, digests };
}
