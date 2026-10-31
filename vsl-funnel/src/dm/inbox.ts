import type { Runtime } from '../app';
import { type Lead, getLead } from '../funnel/leads';
import { newId } from '../lib/ids';
import { flag } from '../settings';
import { applyLeadUpdate } from '../sales/outcomes';
import { logAction } from '../ops/actions';
import { type GraphMessage, conversationMessages, listConversations, replyToComment, sendPrivateReply, sendText, userProfile } from './graph';
import {
  DAY, DM_STATUSES, type DmStatus, STATUS_RANK, type TriggerSource, contactsIn, fillTemplate, firstMatch, privateReplyBlock, publicReplyTarget, scoreConversation, windowState,
} from './rules';

/**
 * The DM inbox store: threads, messages and comments from Meta's webhooks and the conversations API,
 * keyword triggers, the send path (inside Meta's windows only), and syncing outcomes with the lead record.
 */
export interface DmThread {
  id: string;
  ig_user_id: string;
  username: string | null;
  name: string | null;
  lead_id: string | null;
  lead_match: string | null;
  status: DmStatus;
  assignee_id: string | null;
  tags: string;
  band: string | null;
  score: number | null;
  score_reason: string | null;
  revenue_band: string | null;
  ai_flag: string | null;
  ai_reason: string | null;
  ai_checked_at: number | null;
  source: string | null;
  source_detail: string | null;
  link_code: string | null;
  link_sent_at: number | null;
  opener_script_id: string | null;
  last_in_at: number | null;
  last_out_at: number | null;
  last_message_at: number | null;
  last_preview: string | null;
  window_hours: number;
  unread: number;
  follow_up_at: number | null;
  deal_value: number;
  replied_at: number | null;
  booked_at: number | null;
  showed_at: number | null;
  closed_at: number | null;
  lost_at: number | null;
  summary_at: number | null;
  hot_alerted_at: number | null;
  followup_alerted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface DmMessage {
  id: string;
  thread_id: string;
  mid: string | null;
  direction: 'in' | 'out';
  kind: string;
  body: string | null;
  media_url: string | null;
  sent_by: string | null;
  script_id: string | null;
  ai_drafted: number;
  tag: string | null;
  status: string;
  error: string | null;
  ts: number;
}

export interface DmTrigger {
  id: string; name: string; keywords: string; match_mode: string; sources: string; tag: string | null; assign_to: string | null;
  first_message: string | null; script_id: string | null; link_code: string | null; public_reply: string | null; active: number; hits: number; created_at: number; updated_at: number;
}

export class DmError extends Error { constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) { super(message); } }

export const getThread = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM dm_threads WHERE id = ?').bind(id).first<DmThread>();
const threadByUser = (rt: Runtime, igsid: string) => rt.env.DB.prepare('SELECT * FROM dm_threads WHERE ig_user_id = ?').bind(igsid).first<DmThread>();
export const parseTags = (t: Pick<DmThread, 'tags'>): string[] => { try { const v = JSON.parse(t.tags || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; } };
const cleanTag = (s: string) => s.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30);

/** The thread for this person, created on first contact. */
export async function ensureThread(rt: Runtime, igsid: string, o: { username?: string | null; source?: string; detail?: string | null; ts?: number } = {}): Promise<DmThread> {
  const now = Date.now();
  const existing = await threadByUser(rt, igsid);
  if (existing) {
    if (o.username && !existing.username) await rt.env.DB.prepare('UPDATE dm_threads SET username = ? WHERE id = ?').bind(o.username, existing.id).run();
    return existing;
  }
  const id = newId('dm');
  await rt.env.DB.prepare('INSERT OR IGNORE INTO dm_threads (id, ig_user_id, username, source, source_detail, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
    .bind(id, igsid, o.username ?? null, o.source ?? 'dm', o.detail ?? null, o.ts ?? now, now).run();
  const t = (await threadByUser(rt, igsid))!;
  if (!t.name) rt.waitUntil(userProfile(rt, igsid).then((p) => p && rt.env.DB.prepare('UPDATE dm_threads SET name = COALESCE(name, ?), username = COALESCE(username, ?) WHERE id = ?').bind(p.name ?? null, p.username ?? null, t.id).run()));
  return t;
}

export interface NewMessage {
  mid: string | null;
  direction: 'in' | 'out';
  kind?: string;
  body?: string | null;
  media_url?: string | null;
  sent_by?: string | null;
  script_id?: string | null;
  ai_drafted?: boolean;
  tag?: string | null;
  status?: string;
  error?: string | null;
  ts: number;
}

/** Stores one message (deduped by Meta's message id) and moves the thread's clock, preview and status. */
export async function addMessage(rt: Runtime, thread: DmThread, m: NewMessage): Promise<boolean> {
  const id = newId('dmm');
  const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO dm_messages (id, thread_id, mid, direction, kind, body, media_url, sent_by, script_id, ai_drafted, tag, status, error, ts) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .bind(id, thread.id, m.mid, m.direction, m.kind ?? 'text', m.body?.slice(0, 4000) ?? null, m.media_url ?? null, m.sent_by ?? null, m.script_id ?? null, m.ai_drafted ? 1 : 0, m.tag ?? null, m.status ?? (m.direction === 'in' ? 'received' : 'sent'), m.error ?? null, m.ts)
    .run();
  if (!r.meta.changes) return false;
  if (m.status === 'failed') return true;
  const preview = (m.body || `[${m.kind ?? 'message'}]`).replace(/\s+/g, ' ').slice(0, 140);
  if (m.direction === 'in') {
    await rt.env.DB.prepare('UPDATE dm_threads SET last_in_at = MAX(COALESCE(last_in_at, 0), ?1), last_message_at = MAX(COALESCE(last_message_at, 0), ?1), last_preview = CASE WHEN ?1 >= COALESCE(last_message_at, 0) THEN ?2 ELSE last_preview END, unread = unread + 1, updated_at = ?3 WHERE id = ?4')
      .bind(m.ts, preview, Date.now(), thread.id).run();
  } else {
    const human = m.sent_by && !['trigger', 'assistant'].includes(m.sent_by);
    await rt.env.DB.prepare(`UPDATE dm_threads SET last_out_at = MAX(COALESCE(last_out_at, 0), ?1), last_message_at = MAX(COALESCE(last_message_at, 0), ?1),
        last_preview = CASE WHEN ?1 >= COALESCE(last_message_at, 0) THEN ?2 ELSE last_preview END, unread = 0,
        status = CASE WHEN status = 'new' AND ?3 THEN 'replied' ELSE status END, replied_at = COALESCE(replied_at, CASE WHEN ?3 THEN ?1 END),
        opener_script_id = COALESCE(opener_script_id, ?4), updated_at = ?5 WHERE id = ?6`)
      .bind(m.ts, preview, human ? 1 : 0, m.script_id ?? null, Date.now(), thread.id).run();
  }
  return true;
}

/** Re-scores the thread from everything they've written (rules), and links it to a lead when they share an email or phone. */
export async function rescore(rt: Runtime, threadId: string) {
  const t = await getThread(rt, threadId);
  if (!t) return null;
  const [msgs, comments] = await Promise.all([
    rt.env.DB.prepare('SELECT direction, kind, body FROM dm_messages WHERE thread_id = ? ORDER BY ts').bind(t.id).all<{ direction: string; kind: string; body: string | null }>(),
    rt.env.DB.prepare('SELECT body FROM dm_comments WHERE ig_user_id = ? ORDER BY ts').bind(t.ig_user_id).all<{ body: string | null }>(),
  ]);
  const ins = msgs.results.filter((m) => m.direction === 'in');
  const texts = [...comments.results.map((c) => c.body ?? ''), ...ins.map((m) => m.body ?? '')].filter(Boolean);
  const lead = t.lead_id ? await getLead(rt.env, t.lead_id) : null;
  const s = scoreConversation({ texts, outbound: msgs.results.length - ins.length, storyReplies: ins.filter((m) => m.kind === 'story_reply').length, knownBand: lead?.revenue_band ?? null });
  await rt.env.DB.prepare('UPDATE dm_threads SET band = ?, score = ?, score_reason = ?, revenue_band = COALESCE(?, revenue_band) WHERE id = ?').bind(s.band, s.score, s.reason, s.revenueBand, t.id).run();
  if (!t.lead_id) await matchLead(rt, t, texts.join('\n'));
  return s;
}

/** Links the conversation to an existing lead by an email or phone they typed, or the Instagram handle on their application. */
export async function matchLead(rt: Runtime, t: DmThread, text: string): Promise<Lead | null> {
  const { email, phone } = contactsIn(text);
  let lead: Lead | null = null, how: string | null = null;
  if (email) { lead = await rt.env.DB.prepare('SELECT * FROM leads WHERE email = ? LIMIT 1').bind(email).first<Lead>(); how = 'email'; }
  if (!lead && phone) { lead = await rt.env.DB.prepare("SELECT * FROM leads WHERE replace(replace(phone, '+', ''), ' ', '') = ? LIMIT 1").bind(phone).first<Lead>(); how = 'phone'; }
  if (!lead && t.username && /^[\w.]{2,30}$/.test(t.username)) {
    lead = await rt.env.DB.prepare('SELECT * FROM leads WHERE answers LIKE ? OR answers LIKE ? LIMIT 1').bind(`%"@${t.username}"%`, `%instagram.com/${t.username}"%`).first<Lead>();
    how = 'handle';
  }
  if (!lead) return null;
  await linkLead(rt, t, lead, how!);
  return lead;
}

/** Ties a thread to a lead and credits the assigned setter on the lead (unless another setter already is). */
export async function linkLead(rt: Runtime, t: DmThread, lead: Lead, how: string) {
  await rt.env.DB.prepare('UPDATE dm_threads SET lead_id = ?, lead_match = ?, updated_at = ? WHERE id = ?').bind(lead.id, how, Date.now(), t.id).run();
  if (t.assignee_id && !lead.setter_id) await applyLeadUpdate(rt, lead, { setter_id: t.assignee_id });
  await addNote(rt, t.id, 'system', null, `Linked to lead ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.ref_code} (matched by ${how}).`);
}

export async function addNote(rt: Runtime, threadId: string, kind: 'note' | 'summary' | 'system', author: string | null, body: string) {
  const id = newId('dmn');
  await rt.env.DB.prepare('INSERT INTO dm_notes (id, thread_id, kind, author, body, ts) VALUES (?,?,?,?,?,?)').bind(id, threadId, kind, author, body.slice(0, 6000), Date.now()).run();
  return id;
}

// ───────────────────────────── Webhooks ─────────────────────────────

interface IgMessaging {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number | string;
  message?: {
    mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean;
    attachments?: { type?: string; payload?: { url?: string } }[];
    reply_to?: { story?: { url?: string; id?: string }; mid?: string };
    referral?: { source?: string; type?: string; ref?: string; ad_id?: string };
  };
  postback?: { mid?: string; title?: string; payload?: string };
  referral?: { ref?: string; source?: string; type?: string; ad_id?: string };
}
interface IgChange { field?: string; value?: { id?: string; comment_id?: string; text?: string; parent_id?: string; from?: { id?: string; username?: string }; media?: { id?: string }; media_id?: string } }
export interface IgWebhook { object?: string; entry?: { id?: string; time?: number; messaging?: IgMessaging[]; changes?: IgChange[] }[] }

const tsOf = (v: unknown) => { const n = Number(v); return !n ? Date.now() : n < 1e12 ? n * 1000 : n; };

/** One normalised inbound event, from a webhook entry. */
export interface DmEvent {
  igsid: string;
  direction: 'in' | 'out';
  kind: 'text' | 'story_reply' | 'story_mention' | 'postback' | 'referral' | 'attachment';
  mid: string | null;
  text: string;
  media_url: string | null;
  ts: number;
  fromAd: boolean;
  detail: string | null;
  username?: string | null;
}

/** Turns Meta's messaging payload into events. Echoes (messages the account sent, also from the Instagram app) become outbound. */
export function parseMessaging(accountId: string, m: IgMessaging): DmEvent | null {
  const sender = m.sender?.id, recipient = m.recipient?.id;
  if (!sender || !recipient) return null;
  const echo = Boolean(m.message?.is_echo) || sender === accountId;
  const igsid = echo ? recipient : sender;
  const ts = tsOf(m.timestamp);
  if (m.message) {
    if (m.message.is_deleted) return null;
    const att = m.message.attachments?.[0];
    const story = m.message.reply_to?.story;
    const kind = att?.type === 'story_mention' ? 'story_mention' : story ? 'story_reply' : m.message.text ? 'text' : 'attachment';
    const ad = m.message.referral?.source === 'ADS' || Boolean(m.message.referral?.ad_id);
    return { igsid, direction: echo ? 'out' : 'in', kind, mid: m.message.mid ?? null, text: m.message.text ?? '', media_url: story?.url ?? att?.payload?.url ?? null, ts, fromAd: ad, detail: story?.id ? `story ${story.id}` : ad ? `ad ${m.message.referral?.ad_id ?? ''}`.trim() : null };
  }
  if (m.postback) return { igsid, direction: 'in', kind: 'postback', mid: m.postback.mid ?? null, text: m.postback.title ?? m.postback.payload ?? '', media_url: null, ts, fromAd: false, detail: m.postback.payload ?? null };
  if (m.referral) {
    const ad = m.referral.source === 'ADS' || Boolean(m.referral.ad_id);
    return { igsid, direction: 'in', kind: 'referral', mid: null, text: '', media_url: null, ts, fromAd: ad, detail: [m.referral.source, m.referral.ref].filter(Boolean).join(' ') || null };
  }
  return null;
}

const SOURCE_OF: Record<DmEvent['kind'], string> = { text: 'dm', attachment: 'dm', postback: 'dm', story_reply: 'story_reply', story_mention: 'story_mention', referral: 'dm' };

export async function ingestWebhook(rt: Runtime, payload: IgWebhook) {
  const out = { messages: 0, comments: 0, triggers: 0 };
  for (const entry of payload.entry ?? []) {
    const accountId = entry.id || rt.settings.IG_ACCOUNT_ID;
    for (const m of entry.messaging ?? []) {
      const e = parseMessaging(accountId ?? '', m);
      if (!e) continue;
      if (await ingestEvent(rt, e)) out.messages++;
    }
    for (const ch of entry.changes ?? []) {
      if (ch.field !== 'comments' && ch.field !== 'live_comments') continue;
      const v = ch.value ?? {};
      const id = v.id ?? v.comment_id;
      if (!id || !v.from?.id || v.from.id === accountId) continue; // the account's own replies
      const r = await ingestComment(rt, { id, text: v.text ?? '', igsid: v.from.id, username: v.from.username ?? null, media_id: v.media?.id ?? v.media_id ?? null, parent_id: v.parent_id ?? null, ts: tsOf(entry.time) });
      if (r.stored) out.comments++;
      if (r.triggered) out.triggers++;
    }
  }
  return out;
}

/** Stores a message event, re-scores, links the lead and runs keyword triggers for new inbound text. */
export async function ingestEvent(rt: Runtime, e: DmEvent, o: { imported?: boolean } = {}): Promise<boolean> {
  const t = await ensureThread(rt, e.igsid, { username: e.username ?? null, source: o.imported ? 'import' : e.fromAd ? 'ad' : SOURCE_OF[e.kind], detail: e.detail, ts: e.ts });
  if (e.kind === 'referral' && !e.mid) {
    // A click-to-Direct ad opens a longer window; Meta sends the referral before / with the first message.
    if (e.fromAd) await rt.env.DB.prepare('UPDATE dm_threads SET window_hours = 168, source = COALESCE(source, ?), source_detail = COALESCE(source_detail, ?) WHERE id = ?').bind('ad', e.detail, t.id).run();
    return false;
  }
  if (e.fromAd && e.direction === 'in') await rt.env.DB.prepare('UPDATE dm_threads SET window_hours = 168 WHERE id = ?').bind(t.id).run();
  const added = await addMessage(rt, t, { mid: e.mid, direction: e.direction, kind: e.kind, body: e.text, media_url: e.media_url, ts: e.ts, sent_by: e.direction === 'out' ? 'instagram' : null });
  if (!added || e.direction === 'out') return added;
  await rescore(rt, t.id);
  if (!o.imported) {
    const src: TriggerSource | null = e.kind === 'story_reply' ? 'story_reply' : e.kind === 'text' || e.kind === 'postback' ? 'dm' : null;
    if (src && e.text) await runTriggers(rt, (await getThread(rt, t.id))!, src, e.text);
    rt.waitUntil(import('./ai').then((ai) => ai.afterInbound(rt, t.id)));
  }
  return true;
}

export async function ingestComment(rt: Runtime, c: { id: string; text: string; igsid: string; username: string | null; media_id: string | null; parent_id: string | null; ts: number }) {
  const r = await rt.env.DB.prepare('INSERT OR IGNORE INTO dm_comments (id, media_id, ig_user_id, username, body, parent_id, ts) VALUES (?,?,?,?,?,?,?)')
    .bind(c.id, c.media_id, c.igsid, c.username, c.text.slice(0, 2000), c.parent_id, c.ts).run();
  if (!r.meta.changes) return { stored: false, triggered: false };
  const triggers = await activeTriggers(rt);
  const hit = firstMatch(triggers, 'comment', c.text);
  if (!hit) return { stored: true, triggered: false };
  // A thread for the commenter, so the private reply and anything after it live in the inbox.
  const t = await ensureThread(rt, c.igsid, { username: c.username, source: 'comment', detail: c.media_id ? `media ${c.media_id}` : null, ts: c.ts });
  await rt.env.DB.prepare('UPDATE dm_comments SET thread_id = ?, trigger_id = ? WHERE id = ?').bind(t.id, hit.rule.id, c.id).run();
  await applyTrigger(rt, t, hit.rule, hit.keyword, 'comment', { id: c.id, ts: c.ts, parent_id: c.parent_id, private_reply_at: null });
  await rescore(rt, t.id);
  return { stored: true, triggered: true };
}

export const activeTriggers = async (rt: Runtime) =>
  (await rt.env.DB.prepare('SELECT * FROM dm_triggers WHERE active = 1 ORDER BY created_at').all<DmTrigger>()).results;

export async function runTriggers(rt: Runtime, t: DmThread, source: TriggerSource, text: string) {
  const hit = firstMatch(await activeTriggers(rt), source, text);
  if (!hit) return false;
  await applyTrigger(rt, t, hit.rule, hit.keyword, source);
  return true;
}

/** The tracked DM link for a thread: /l/<code>?dm=<thread>, so a visit and application tie back to the conversation. */
export const dmLink = (rt: Runtime, code: string, threadId: string) => `${rt.origin}/l/${encodeURIComponent(code)}?dm=${encodeURIComponent(threadId)}`;

/**
 * Tag, assign and send the configured first message, within Meta's rules:
 *  - a comment gets its one private reply (within 7 days) and, optionally, a public reply;
 *  - a Story reply or DM gets the message inside the 24-hour window (they just wrote, so it is open);
 *  - a trigger's first message goes once per conversation.
 */
export async function applyTrigger(rt: Runtime, t: DmThread, rule: DmTrigger, keyword: string, source: TriggerSource, comment?: { id: string; ts: number; parent_id: string | null; private_reply_at: number | null }) {
  const now = Date.now();
  const tags = new Set(parseTags(t));
  if (rule.tag) tags.add(cleanTag(rule.tag));
  const assignee = !t.assignee_id && rule.assign_to && rt.reps.some((r) => r.id === rule.assign_to && r.active) ? rule.assign_to : t.assignee_id;
  await rt.env.DB.prepare('UPDATE dm_threads SET tags = ?, assignee_id = ?, updated_at = ? WHERE id = ?').bind(JSON.stringify([...tags]), assignee, now, t.id).run();
  await rt.env.DB.prepare('UPDATE dm_triggers SET hits = hits + 1 WHERE id = ?').bind(rule.id).run();
  const results: string[] = [`Keyword "${keyword}" on a ${source.replace('_', ' ')}`];

  let body = rule.first_message || '';
  if (!body && rule.script_id) body = (await rt.env.DB.prepare('SELECT body FROM dm_scripts WHERE id = ?').bind(rule.script_id).first<{ body: string }>())?.body ?? '';
  const link = rule.link_code ? dmLink(rt, rule.link_code, t.id) : null;
  const text = body ? fillTemplate(body, { first_name: t.name, username: t.username, link }) : '';
  const already = await rt.env.DB.prepare("SELECT 1 FROM dm_notes WHERE thread_id = ? AND kind = 'system' AND body LIKE ? LIMIT 1").bind(t.id, `Trigger ${rule.id}:%`).first();

  if (source === 'comment' && comment) {
    if (rule.public_reply) {
      try {
        const r = await replyToComment(rt, publicReplyTarget(comment), fillTemplate(rule.public_reply, { first_name: t.name, username: t.username }));
        await rt.env.DB.prepare('UPDATE dm_comments SET public_reply_id = ? WHERE id = ?').bind(r.id, comment.id).run();
        results.push('public reply posted');
      } catch (e) { results.push(`public reply failed: ${(e as Error).message}`); }
    }
    const block = privateReplyBlock(comment, now);
    if (text && !block && !already) {
      try {
        const r = await sendPrivateReply(rt, comment.id, text);
        await rt.env.DB.prepare('UPDATE dm_comments SET private_reply_at = ? WHERE id = ?').bind(now, comment.id).run();
        await addMessage(rt, t, { mid: r.message_id ?? null, direction: 'out', kind: 'private_reply', body: text, sent_by: 'trigger', script_id: rule.script_id, ts: now });
        results.push('private reply sent');
      } catch (e) {
        await rt.env.DB.prepare('UPDATE dm_comments SET error = ? WHERE id = ?').bind((e as Error).message.slice(0, 300), comment.id).run();
        results.push(`private reply failed: ${(e as Error).message}`);
      }
    } else if (text) results.push(block ?? 'first message already sent in this conversation');
  } else if (text && !already) {
    const fresh = (await getThread(rt, t.id))!;
    if (windowState(fresh, now, { automated: true }).mode === 'standard') {
      try {
        const r = await sendText(rt, fresh.ig_user_id, text);
        await addMessage(rt, fresh, { mid: r.message_id ?? null, direction: 'out', body: text, sent_by: 'trigger', script_id: rule.script_id, ts: now });
        results.push('first message sent');
      } catch (e) { results.push(`first message failed: ${(e as Error).message}`); }
    } else results.push('outside the 24-hour window, message not sent');
  }
  if (link) await rt.env.DB.prepare('UPDATE dm_threads SET link_code = ?, link_sent_at = COALESCE(link_sent_at, ?) WHERE id = ?').bind(rule.link_code, now, t.id).run();
  await addNote(rt, t.id, 'system', null, `Trigger ${rule.id}: ${rule.name}. ${results.join('; ')}.`);
  await logAction(rt, { dept: 'dm', kind: 'dm.trigger', summary: `Trigger "${rule.name}" fired for ${t.username ? `@${t.username}` : 'a conversation'}`, detail: results.join('; '), leadId: t.lead_id, actor: 'auto', status: results.some((r) => r.includes('failed')) ? 'failed' : 'done', payload: { thread: t.id, trigger: rule.id, source } });
}

// ───────────────────────────── Sending ─────────────────────────────

export interface SendInput { text: string; by: string | null; script_id?: string | null; ai_drafted?: boolean }

/** A setter's reply: only inside the standard window, or the 7-day human agent window when that is switched on. */
export async function sendReply(rt: Runtime, threadId: string, input: SendInput) {
  const t = await getThread(rt, threadId);
  if (!t) throw new DmError('Conversation not found', 404);
  const text = String(input.text ?? '').trim();
  if (!text) throw new DmError('Write a message first');
  if (new TextEncoder().encode(text).length > 1000) throw new DmError('Instagram messages are limited to 1,000 bytes. Shorten it.');
  const now = Date.now();
  const w = windowState(t, now, { humanAgent: flag(rt.settings.DM_HUMAN_AGENT) });
  if (w.mode === 'closed') throw new DmError(t.last_in_at ? 'The messaging window has closed. Meta lets you reply again once they send a new message.' : 'They have not messaged this account yet, so Meta does not allow a message.', 409);
  const script = input.script_id ? await rt.env.DB.prepare('SELECT id FROM dm_scripts WHERE id = ?').bind(input.script_id).first<{ id: string }>() : null;
  const by = input.by && rt.reps.some((r) => r.id === input.by) ? input.by : null;
  try {
    const r = await sendText(rt, t.ig_user_id, text, { humanAgent: w.mode === 'human_agent' });
    await addMessage(rt, t, { mid: r.message_id ?? null, direction: 'out', body: text, sent_by: by ?? 'team', script_id: script?.id ?? null, ai_drafted: input.ai_drafted, tag: w.mode === 'human_agent' ? 'HUMAN_AGENT' : null, ts: now });
    await logAction(rt, { dept: 'dm', kind: 'dm.reply', summary: `Reply sent to ${t.username ? `@${t.username}` : 'a conversation'}${input.ai_drafted ? ' (AI draft, sent by a setter)' : ''}`, leadId: t.lead_id, actor: 'you', status: 'done', payload: { thread: t.id, by, script: script?.id ?? null, tag: w.mode === 'human_agent' ? 'HUMAN_AGENT' : null } });
    return { ok: true, mode: w.mode, message_id: r.message_id ?? null };
  } catch (e) {
    await addMessage(rt, t, { mid: null, direction: 'out', body: text, sent_by: by ?? 'team', script_id: script?.id ?? null, status: 'failed', error: (e as Error).message.slice(0, 300), ts: now });
    await logAction(rt, { dept: 'dm', kind: 'dm.reply', summary: 'Reply failed to send', detail: (e as Error).message, leadId: t.lead_id, actor: 'you', status: 'failed', payload: { thread: t.id } });
    throw new DmError((e as Error).message, 502);
  }
}

// ───────────────────────────── Updates and outcomes ─────────────────────────────

export interface ThreadPatch { status?: string; assignee_id?: string | null; tags?: string[]; follow_up_at?: number | string | null; deal_value?: number | string; lead_id?: string | null; unread?: number }

/** Changes from the team. Outcomes flow to the lead (showed → showed, closed → won with the deal value, lost → lost), crediting the setter. */
export async function updateThread(rt: Runtime, id: string, p: ThreadPatch, actor: string | null = null) {
  const t = await getThread(rt, id);
  if (!t) throw new DmError('Conversation not found', 404);
  const now = Date.now();
  const f: Record<string, string | number | null> = {};
  const status = p.status && (DM_STATUSES as readonly string[]).includes(p.status) ? (p.status as DmStatus) : undefined;
  if (status && status !== t.status) {
    f.status = status;
    const stamp: Partial<Record<DmStatus, keyof DmThread>> = { replied: 'replied_at', booked: 'booked_at', showed: 'showed_at', closed: 'closed_at', lost: 'lost_at' };
    if (stamp[status] && !t[stamp[status]!]) f[stamp[status]!] = now;
    if (STATUS_RANK[status] >= 3 && status !== 'lost' && !t.booked_at) f.booked_at = now;
  }
  if (p.assignee_id !== undefined) f.assignee_id = p.assignee_id && rt.reps.some((r) => r.id === p.assignee_id) ? p.assignee_id : null;
  if (p.tags) f.tags = JSON.stringify([...new Set(p.tags.map(cleanTag).filter(Boolean))].slice(0, 12));
  if (p.follow_up_at !== undefined) {
    const v = p.follow_up_at === null || p.follow_up_at === '' ? null : typeof p.follow_up_at === 'number' ? p.follow_up_at : Date.parse(String(p.follow_up_at));
    f.follow_up_at = v && Number.isFinite(v) ? v : null;
    f.followup_alerted_at = null;
  }
  if (p.deal_value !== undefined && Number.isFinite(Number(p.deal_value))) f.deal_value = Math.max(0, Number(p.deal_value));
  if (p.unread !== undefined) f.unread = p.unread ? 1 : 0;
  if (p.lead_id !== undefined) {
    if (p.lead_id) {
      const lead = await getLead(rt.env, p.lead_id);
      if (!lead) throw new DmError('Lead not found', 404);
      await linkLead(rt, { ...t, assignee_id: (f.assignee_id as string | null | undefined) ?? t.assignee_id }, lead, 'manual');
    } else { f.lead_id = null; f.lead_match = null; }
  }
  const keys = Object.keys(f);
  if (keys.length) await rt.env.DB.prepare(`UPDATE dm_threads SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => f[k]), now, id).run();
  const fresh = (await getThread(rt, id))!;
  if (status && status !== t.status) {
    await addNote(rt, id, 'system', actor, `Status: ${t.status} → ${status}.`);
    await logAction(rt, { dept: 'dm', kind: 'dm.status', summary: `${fresh.username ? `@${fresh.username}` : 'Conversation'} moved to ${status}`, leadId: fresh.lead_id, actor: 'you', status: 'done', payload: { thread: id, from: t.status, to: status } });
    await pushOutcomeToLead(rt, fresh, status);
    if (status === 'booked' && !fresh.summary_at) rt.waitUntil(import('./ai').then((ai) => ai.precallSummary(rt, id)));
  }
  if (p.assignee_id !== undefined && f.assignee_id !== t.assignee_id) {
    await addNote(rt, id, 'system', actor, `Assigned to ${rt.reps.find((r) => r.id === f.assignee_id)?.name ?? 'nobody'}.`);
    if (fresh.lead_id && f.assignee_id) {
      const lead = await getLead(rt.env, fresh.lead_id);
      if (lead && !lead.setter_id) await applyLeadUpdate(rt, lead, { setter_id: f.assignee_id as string });
    }
  }
  return fresh;
}

async function pushOutcomeToLead(rt: Runtime, t: DmThread, status: DmStatus) {
  if (!t.lead_id) return;
  const lead = await getLead(rt.env, t.lead_id);
  if (!lead) return;
  const map: Partial<Record<DmStatus, string>> = { showed: 'showed', closed: 'won', lost: 'lost' };
  const to = map[status];
  if (!to || lead.status === to) return;
  await applyLeadUpdate(rt, lead, {
    status: to,
    ...(to === 'won' && t.deal_value && !lead.revenue ? { revenue: t.deal_value } : {}),
    ...(t.assignee_id && !lead.setter_id ? { setter_id: t.assignee_id } : {}),
  });
}

/**
 * Cron: pull outcomes back from the lead record (a Calendly booking, a call logged in Calls & deals) and link
 * conversations whose tracked DM link led to an application.
 */
export async function syncWithLeads(rt: Runtime) {
  const db = rt.env.DB;
  let linked = 0, moved = 0;
  // Visits that came through a DM link (?dm=<thread>) by someone who became a lead.
  const viaLink = await db.prepare(
    `SELECT t.id AS thread_id, v.lead_id FROM dm_threads t
       JOIN sessions s ON s.landing_query LIKE '%dm=' || t.id || '%'
       JOIN visitors v ON v.id = s.visitor_id
     WHERE t.lead_id IS NULL AND t.link_sent_at IS NOT NULL AND v.lead_id IS NOT NULL LIMIT 20`,
  ).all<{ thread_id: string; lead_id: string }>().catch(() => ({ results: [] as { thread_id: string; lead_id: string }[] }));
  for (const r of viaLink.results) {
    const [t, lead] = await Promise.all([getThread(rt, r.thread_id), getLead(rt.env, r.lead_id)]);
    if (t && lead && !t.lead_id) { await linkLead(rt, t, lead, 'link'); linked++; }
  }
  const rows = await db.prepare(
    `SELECT t.id, t.status, l.status AS lead_status, l.booked_at AS lead_booked, l.booking_cancelled_at, l.revenue FROM dm_threads t JOIN leads l ON l.id = t.lead_id
     WHERE t.status NOT IN ('closed', 'lost') AND (l.booked_at IS NOT NULL OR l.status IN ('showed', 'won', 'lost')) LIMIT 100`,
  ).all<{ id: string; status: DmStatus; lead_status: string; lead_booked: number | null; booking_cancelled_at: number | null; revenue: number }>();
  for (const r of rows.results) {
    const target: DmStatus | null = r.lead_status === 'won' ? 'closed' : r.lead_status === 'lost' ? 'lost' : r.lead_status === 'showed' ? 'showed' : r.lead_booked && !r.booking_cancelled_at ? 'booked' : null;
    if (!target || STATUS_RANK[target] <= STATUS_RANK[r.status]) continue;
    const now = Date.now();
    await db.prepare(`UPDATE dm_threads SET status = ?, booked_at = COALESCE(booked_at, ?), showed_at = CASE WHEN ? IN ('showed','closed') THEN COALESCE(showed_at, ?) ELSE showed_at END,
        closed_at = CASE WHEN ? = 'closed' THEN COALESCE(closed_at, ?) ELSE closed_at END, lost_at = CASE WHEN ? = 'lost' THEN COALESCE(lost_at, ?) ELSE lost_at END,
        deal_value = CASE WHEN ? = 'closed' AND deal_value = 0 THEN ? ELSE deal_value END, updated_at = ? WHERE id = ?`)
      .bind(target, target === 'lost' ? null : now, target, now, target, now, target, now, target, r.revenue ?? 0, now, r.id).run();
    await addNote(rt, r.id, 'system', null, `Status: ${r.status} → ${target} (from the lead record).`);
    moved++;
    if (target === 'booked') rt.waitUntil(import('./ai').then((ai) => ai.precallSummary(rt, r.id)));
  }
  return { linked, moved };
}

// ───────────────────────────── 30-day import ─────────────────────────────

/**
 * Imports conversations updated in the last 30 days through the conversations API, a few per call
 * (the dashboard keeps calling with the returned cursor). Meta returns details for the 20 most recent
 * messages per conversation. No triggers or auto messages fire on imported history.
 */
export async function importRecent(rt: Runtime, cursor: string | null) {
  const since = Date.now() - 30 * DAY;
  const page = await listConversations(rt, cursor);
  const me = rt.settings.IG_ACCOUNT_ID;
  let conversations = 0, messages = 0, done = false;
  for (const c of page.data ?? []) {
    if (Date.parse(c.updated_time) < since) { done = true; break; }
    conversations++;
    const msgs = await conversationMessages(rt, c.id);
    for (const m of msgs.reverse()) {
      const e = importedEvent(me, m);
      if (e && e.ts >= since && (await ingestEvent(rt, e, { imported: true }))) messages++;
    }
  }
  const next = !done && page.paging?.next ? page.paging.cursors?.after ?? null : null;
  if (!next) await logAction(rt, { dept: 'dm', kind: 'dm.import', summary: 'Imported the last 30 days of Instagram DMs', actor: 'you', status: 'done' });
  return { conversations, messages, next };
}

export function importedEvent(accountId: string, m: GraphMessage): DmEvent | null {
  const from = m.from?.id;
  if (!from) return null;
  const outbound = from === accountId;
  const other = outbound ? m.to?.data?.[0]?.id : from;
  if (!other) return null;
  return { igsid: other, direction: outbound ? 'out' : 'in', kind: m.message ? 'text' : 'attachment', mid: m.id, text: m.message ?? '', media_url: null, ts: Date.parse(m.created_time) || Date.now(), fromAd: false, detail: null, username: (outbound ? m.to?.data?.[0]?.username : m.from?.username) ?? null };
}
