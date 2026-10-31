import type { Runtime } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import type { Settings } from '../settings';

/**
 * Meta's official Instagram API, with the owner's own connected professional account. Nothing here reads
 * Instagram any other way (the owner's standing rule: never scrape Instagram).
 *
 *  - Instagram Login (token starts with "IG"): graph.instagram.com, permissions instagram_business_basic,
 *    instagram_business_manage_messages, instagram_business_manage_comments.
 *  - Facebook Login (Page or system user token): graph.facebook.com, permissions instagram_basic,
 *    instagram_manage_messages, instagram_manage_comments, pages_show_list, pages_read_engagement.
 */
export const IG_API_VERSION = 'v24.0';

export const igConfigured = (s: Settings) => Boolean(s.IG_ACCESS_TOKEN);
export const igHost = (token: string) => (/^IG/.test(token) ? 'https://graph.instagram.com' : 'https://graph.facebook.com');

export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code?: number, readonly subcode?: number) { super(message); }
}

type Json = Record<string, unknown>;

export async function graph<T = Json>(s: Settings, path: string, o: { method?: 'GET' | 'POST'; query?: Record<string, string>; body?: Json; absolute?: string } = {}): Promise<T> {
  const token = s.IG_ACCESS_TOKEN;
  if (!token) throw new GraphError('Add the Instagram access token under Integrations → Instagram DMs', 400);
  const url = new URL(o.absolute ?? `${igHost(token)}/${IG_API_VERSION}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    method: o.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(o.body ? { 'content-type': 'application/json' } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as Json & { error?: { message?: string; code?: number; error_subcode?: number } };
  if (!res.ok || j.error) throw new GraphError(`Instagram API: ${j.error?.message ?? `HTTP ${res.status}`}`.slice(0, 300), res.status, j.error?.code, j.error?.error_subcode);
  return j as T;
}

/** The account id messages go out from: the saved setting, else "me". */
const acct = (s: Settings) => s.IG_ACCOUNT_ID || 'me';

/** Verifies Meta's X-Hub-Signature-256 header: HMAC-SHA256 of the raw body with the app secret. */
export async function verifyIgSignature(appSecret: string, rawBody: string, header: string | null) {
  if (!appSecret || !header?.startsWith('sha256=')) return false;
  return safeEqual(await hmacHex(appSecret, rawBody), header.slice(7).toLowerCase());
}

/** Webhook verification handshake: echo hub.challenge when the verify token matches. */
export function verifyChallenge(s: Settings, q: { mode?: string; token?: string; challenge?: string }): string | null {
  if (q.mode !== 'subscribe' || !s.IG_WEBHOOK_VERIFY_TOKEN || !safeEqual(q.token ?? '', s.IG_WEBHOOK_VERIFY_TOKEN)) return null;
  return q.challenge ?? '';
}

export interface SendResult { recipient_id?: string; message_id?: string }

/** A DM to someone who messaged us. `humanAgent` adds Meta's HUMAN_AGENT tag (7-day window, human-written replies only). */
export function sendText(rt: Runtime, igsid: string, text: string, o: { humanAgent?: boolean } = {}) {
  return graph<SendResult>(rt.settings, `${acct(rt.settings)}/messages`, {
    method: 'POST',
    body: { recipient: { id: igsid }, message: { text: text.slice(0, 1000) }, ...(o.humanAgent ? { messaging_type: 'MESSAGE_TAG', tag: 'HUMAN_AGENT' } : {}) },
  });
}

/** The one private reply Meta allows per comment (within 7 days): a DM addressed by comment id. */
export function sendPrivateReply(rt: Runtime, commentId: string, text: string) {
  return graph<SendResult>(rt.settings, `${acct(rt.settings)}/messages`, { method: 'POST', body: { recipient: { comment_id: commentId }, message: { text: text.slice(0, 1000) } } });
}

/** A public reply under a (top-level) comment. */
export function replyToComment(rt: Runtime, commentId: string, text: string) {
  return graph<{ id: string }>(rt.settings, `${commentId}/replies`, { method: 'POST', query: { message: text.slice(0, 300) } });
}

/** Name and username of someone who messaged us (User Profile API; only for people who messaged the account). */
export async function userProfile(rt: Runtime, igsid: string): Promise<{ name?: string; username?: string } | null> {
  try { return await graph(rt.settings, igsid, { query: { fields: 'name,username' } }); } catch { return null; }
}

export interface Conversation { id: string; updated_time: string }
export interface GraphMessage { id: string; created_time: string; from?: { id: string; username?: string }; to?: { data?: { id: string; username?: string }[] }; message?: string }

/** One page of conversations (newest first). */
export function listConversations(rt: Runtime, after?: string | null) {
  return graph<{ data: Conversation[]; paging?: { cursors?: { after?: string }; next?: string } }>(rt.settings, `${acct(rt.settings)}/conversations`, {
    query: { platform: 'instagram', fields: 'id,updated_time', limit: '10', ...(after ? { after } : {}) },
  });
}

/** Message ids in a conversation (newest first); Meta only returns details for the 20 most recent. */
export async function conversationMessages(rt: Runtime, conversationId: string): Promise<GraphMessage[]> {
  const c = await graph<{ messages?: { data?: { id: string; created_time: string }[] } }>(rt.settings, conversationId, { query: { fields: 'messages' } });
  const ids = (c.messages?.data ?? []).slice(0, 20);
  const out: GraphMessage[] = [];
  for (const m of ids) {
    try { out.push(await graph<GraphMessage>(rt.settings, m.id, { query: { fields: 'id,created_time,from,to,message' } })); } catch { /* older than the 20 Meta serves */ }
  }
  return out;
}

/** Check: who the token belongs to, and the account id to save. */
export async function whoAmI(rt: Runtime): Promise<{ id: string; username?: string; name?: string }> {
  const s = rt.settings;
  if (/^IG/.test(s.IG_ACCESS_TOKEN)) {
    const me = await graph<{ user_id?: string; id: string; username?: string; name?: string }>(s, 'me', { query: { fields: 'user_id,username,name' } });
    return { id: me.user_id || me.id, username: me.username, name: me.name };
  }
  if (s.IG_ACCOUNT_ID) {
    const a = await graph<{ id: string; username?: string; name?: string }>(s, s.IG_ACCOUNT_ID, { query: { fields: 'id,username,name' } });
    return a;
  }
  // Facebook Login: find the Instagram account connected to the token's Page(s).
  const pages = await graph<{ data?: { id: string; name: string; instagram_business_account?: { id: string; username?: string } }[] }>(s, 'me/accounts', { query: { fields: 'id,name,instagram_business_account{id,username}' } });
  const page = (pages.data ?? []).find((p) => p.instagram_business_account);
  if (!page?.instagram_business_account) throw new GraphError('No Instagram professional account is connected to this token’s Facebook Page', 400);
  return { id: page.instagram_business_account.id, username: page.instagram_business_account.username, name: page.name };
}

/** Turns on webhooks for the account (Instagram Login: POST /me/subscribed_apps). */
export function subscribeWebhooks(rt: Runtime) {
  return graph<{ success?: boolean }>(rt.settings, `${/^IG/.test(rt.settings.IG_ACCESS_TOKEN) ? 'me' : acct(rt.settings)}/subscribed_apps`, {
    method: 'POST',
    query: { subscribed_fields: 'messages,messaging_postbacks,messaging_referral,comments' },
  });
}

/** Instagram User tokens last 60 days; refreshing one older than 24 hours gives a fresh 60 days. */
export async function refreshIgToken(rt: Runtime): Promise<string | null> {
  const t = rt.settings.IG_ACCESS_TOKEN;
  if (!/^IG/.test(t)) return null;
  const r = await graph<{ access_token?: string }>(rt.settings, '', { absolute: 'https://graph.instagram.com/refresh_access_token', query: { grant_type: 'ig_refresh_token', access_token: t } });
  return r.access_token ?? null;
}
