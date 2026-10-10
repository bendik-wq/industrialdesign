// iMessage relay: text from your own number, blue bubbles and all, through BlueBubbles Server running on a Mac that
// is signed in to your Apple ID. Warplan never sees your Apple ID; it talks to your BlueBubbles server over HTTPS
// (usually a Cloudflare or ngrok tunnel) with the server password, stored encrypted like every other key.
//   Threads  read from your Mac's Messages database through BlueBubbles, matched to targets.
//   Send     POST /api/v1/message/text: same daily cap, STOP list and timeline logging as Twilio texts.
//   Incoming BlueBubbles posts new-message events to a secret per-workspace URL. Events aren't signed, so we never
//            trust the payload: each message is fetched back from your server by its GUID before anything is logged.
import { providerKeys, seal, open } from "./keys.js";
import { publicUrl } from "./net.js";
import { sha256, randomToken } from "./auth.js";
import { e164 } from "./dialer.js";
import { findByPhone, guardText, recordText, sendSms, STOP_WORDS } from "./phone.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const aad = (accountId) => `acct:${accountId}:imessage_hook`;

// ------------------------------------------------------------------ talking to the BlueBubbles server
export async function bluebubbles(env, ctx) {
  const k = (await providerKeys(env, ctx, ["bluebubbles"])).bluebubbles;
  if (!k?.meta?.serverUrl) throw err(400, "Connect your iMessage relay first (Settings → Integrations → iMessage)");
  return { url: k.meta.serverUrl, password: k.key };
}

// Every call carries the password as ?password= (that's BlueBubbles' API). Redirects are refused so the password
// can never be forwarded to another host.
export async function bbReq(bb, path, { method = "GET", body, timeout = 15000 } = {}) {
  const base = publicUrl(bb.url, { httpsOnly: true });
  if (!base) throw err(400, "Your BlueBubbles address must be a public https URL");
  const u = new URL(path, base.origin);
  u.searchParams.set("password", bb.password);
  let res;
  try {
    res = await fetch(u.toString(), { method, redirect: "manual", signal: AbortSignal.timeout(timeout), headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw err(502, "Couldn't reach your BlueBubbles server. Is the Mac awake and the tunnel running?");
  }
  if (res.status >= 300 && res.status < 400) throw err(502, "Your BlueBubbles server redirected; paste the final https address");
  const d = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw err(400, "BlueBubbles rejected the password");
  if (!res.ok) throw err(502, `BlueBubbles: ${d.error?.message || d.message || res.status}`);
  return d.data;
}

export async function verifyBlueBubbles(key, meta) {
  await bbReq({ url: meta.serverUrl, password: key }, "/api/v1/ping");
  return true;
}

// ------------------------------------------------------------------ connect: secret webhook URL, registered on the server
async function getCfg(env, accountId) {
  const r = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'imessage'").bind(accountId).first();
  return r ? JSON.parse(r.data) : null;
}
async function putCfg(env, accountId, cfg) {
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'imessage', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(accountId, JSON.stringify(cfg), now()).run();
}

export async function imessageStatus(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  let bb = null;
  try { bb = await bluebubbles(env, ctx); } catch { /* not connected */ }
  return { connected: !!bb, server: bb ? new URL(bb.url).host : null, incoming: !!cfg?.webhook_id || !!cfg?.manual, webhook_registered: !!cfg?.webhook_id, created_at: cfg?.created_at || null, canEdit: ctx.isOwner };
}

// A fresh incoming URL. We register it on the BlueBubbles server ourselves; if that fails (older servers) the URL
// comes back once so the owner can paste it under BlueBubbles → API & Webhooks.
export async function connectIMessage(env, ctx, origin) {
  const bb = await bluebubbles(env, ctx);
  const old = await getCfg(env, ctx.accountId);
  if (old?.webhook_id) await bbReq(bb, `/api/v1/webhook/${encodeURIComponent(old.webhook_id)}`, { method: "DELETE" }).catch(() => {});
  const token = randomToken("bb_");
  const hookUrl = `${origin}/hooks/bluebubbles/${token}`;
  let webhookId = null;
  try { webhookId = (await bbReq(bb, "/api/v1/webhook", { method: "POST", body: { url: hookUrl, events: ["new-message"] } }))?.id ?? null; } catch { /* register by hand */ }
  const sealed = await seal(env, token, aad(ctx.accountId));
  await putCfg(env, ctx.accountId, { hash: await sha256(token), ct: sealed.ciphertext, iv: sealed.iv, webhook_id: webhookId, manual: !webhookId, created_at: now() });
  return { ...(await imessageStatus(env, ctx)), ...(webhookId ? {} : { url: hookUrl }) };
}

export async function disconnectIMessage(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  if (cfg?.webhook_id) { try { await bbReq(await bluebubbles(env, ctx), `/api/v1/webhook/${encodeURIComponent(cfg.webhook_id)}`, { method: "DELETE" }); } catch { /* server gone */ } }
  await env.DB.prepare("DELETE FROM settings WHERE account_id = ?1 AND key = 'imessage'").bind(ctx.accountId).run();
  return { ok: true };
}

// ------------------------------------------------------------------ threads and messages
const DIRECT = /;-;/; // 1:1 chats look like iMessage;-;+15551234567 (group chats use ;+;)
const shapeMsg = (m) => ({ guid: m.guid, inbound: !m.isFromMe, body: m.text || (m.attachments?.length ? "[attachment]" : ""), at: new Date(m.dateCreated || Date.now()).toISOString(), service: m.handle?.service || null, error: m.error ? `Not delivered (${m.error})` : null });
async function targetFor(env, accountId, address) {
  if (/@/.test(address)) return env.DB.prepare("SELECT id, name, owner_name, currency FROM targets WHERE account_id = ?1 AND lower(email) = lower(?2) LIMIT 1").bind(accountId, address).first();
  return findByPhone(env, accountId, address);
}

export async function imessageThreads(env, ctx) {
  const bb = await bluebubbles(env, ctx);
  const chats = (await bbReq(bb, "/api/v1/chat/query", { method: "POST", body: { limit: 40, offset: 0, with: ["lastMessage", "participants"], sort: "lastmessage" } })) || [];
  const out = [];
  for (const c of chats.filter((c) => DIRECT.test(c.guid || "")).slice(0, 30)) {
    const number = c.participants?.[0]?.address || c.chatIdentifier || "";
    const t = await targetFor(env, ctx.accountId, number);
    out.push({ chat: c.guid, number, name: c.displayName || null, target: t ? { id: t.id, name: t.name, owner: t.owner_name } : null, last: c.lastMessage ? shapeMsg(c.lastMessage) : null });
  }
  return { threads: out };
}

export async function imessageMessages(env, ctx, chat) {
  if (!/^(iMessage|SMS|any);-;[^\s;/?#]{3,80}$/.test(chat)) throw err(400, "Unknown conversation");
  const bb = await bluebubbles(env, ctx);
  const msgs = (await bbReq(bb, `/api/v1/chat/${encodeURIComponent(chat)}/message?limit=50&sort=DESC&with=handle`)) || [];
  return { chat, messages: msgs.map(shapeMsg).reverse() };
}

// ------------------------------------------------------------------ send
export async function sendIMessage(env, ctx, b, hooks) {
  const bb = await bluebubbles(env, ctx);
  const { text, to, match } = await guardText(env, ctx, b);
  // "any;-;" lets the Mac pick iMessage or SMS (green bubble) for the number, like the Messages app does.
  const sent = await bbReq(bb, "/api/v1/message/text", { method: "POST", timeout: 30000, body: { chatGuid: `any;-;${to}`, tempGuid: crypto.randomUUID(), message: text, method: "apple-script" } });
  await recordText(env, ctx, { to, text, match, via: "imessage" }, hooks);
  return { guid: sent?.guid || null, to, via: "imessage", target_id: match?.id || null, receipt: `iMessaged ${match?.name || to}` };
}

// ------------------------------------------------------------------ incoming (public)
export async function blueBubblesHook(request, env, url, hooksFor) {
  const token = url.pathname.match(/^\/hooks\/bluebubbles\/(bb_[\w-]{20,})$/)?.[1];
  if (!token || request.method !== "POST") return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT s.account_id FROM settings s JOIN accounts a ON a.id = s.account_id WHERE s.key = 'imessage' AND json_extract(s.data, '$.hash') = ?1 AND a.active = 1").bind(await sha256(token)).first();
  if (!row) return new Response("Not found", { status: 404 });
  const raw = await request.text();
  if (raw.length > 100000) return new Response("Too large", { status: 413 });
  let ev; try { ev = JSON.parse(raw); } catch { return new Response("Send JSON", { status: 400 }); }
  if (ev?.type !== "new-message" || typeof ev.data?.guid !== "string" || !/^[\w:;+.\-/]{6,120}$/.test(ev.data.guid)) return new Response(JSON.stringify({ ok: true, ignored: true }), { headers: { "Content-Type": "application/json" } });
  const ctx = { accountId: row.account_id, user: { id: null, name: "iMessage" }, isOwner: false };
  // Don't trust the event: fetch the message back from the workspace's own server.
  let m;
  try { m = await bbReq(await bluebubbles(env, ctx), `/api/v1/message/${encodeURIComponent(ev.data.guid)}?with=chats,handle`); } catch { return new Response("Unknown message", { status: 404 }); }
  await logIncoming(env, ctx, m, hooksFor(row.account_id));
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
}

export async function logIncoming(env, ctx, m, hooks) {
  const chat = m?.chats?.[0]?.guid || "";
  if (!m || (chat && !DIRECT.test(chat))) return { ignored: "group chat" };
  const address = m.handle?.address || chat.split(";-;")[1] || "";
  if (!address) return { ignored: "no sender" };
  const text = String(m.text || (m.attachments?.length ? "[attachment]" : "")).slice(0, 1600);
  const number = /@/.test(address) ? address : e164(address, "$") || address;
  const t = await targetFor(env, ctx.accountId, number);
  if (m.isFromMe) {
    // Sent from the phone or the Mac directly. Texts sent from Warplan come back here too: log each one once.
    if (t && !(await env.DB.prepare("SELECT 1 FROM target_events WHERE account_id = ?1 AND target_id = ?2 AND kind = 'sms' AND body LIKE ?3 AND created_at >= ?4").bind(ctx.accountId, t.id, `%${text.slice(0, 200).replace(/[%_]/g, "")}%`, new Date(Date.now() - 5 * 60e3).toISOString()).first())) {
      await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'iMessage', 'sms', ?3, ?4)").bind(ctx.accountId, t.id, `iMessage to ${number}: ${text}`, now()).run();
    }
    return { logged: !!t, outgoing: true };
  }
  if (STOP_WORDS.test(text) && !/@/.test(number)) await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, 'Replied STOP to an iMessage', ?3)").bind(ctx.accountId, `tel:${number}`, now()).run();
  if (t) await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'iMessage', 'sms', ?3, ?4)").bind(ctx.accountId, t.id, `iMessage from ${number}: ${text}`, now()).run();
  hooks?.emit("sms.received", { from: number, body: text, target_id: t?.id || null, via: "imessage" });
  return { logged: !!t };
}

// Which channel a text goes out on: asked-for, else Twilio when it's set up, else iMessage.
export async function textChannels(env, ctx) {
  const have = await providerKeys(env, ctx, ["twilio", "bluebubbles"]);
  return { twilio: !!have.twilio, imessage: !!have.bluebubbles?.meta?.serverUrl };
}

// One entry point for texts (the phone widget, the API and the agents' send_sms tool).
export async function sendText(env, ctx, b, hooks) {
  const ch = await textChannels(env, ctx);
  const via = b.via === "imessage" || b.via === "twilio" ? b.via : ch.twilio ? "twilio" : ch.imessage ? "imessage" : null;
  if (!via) throw err(400, "Connect Twilio or the iMessage relay to send texts (Settings → Integrations)");
  if (!ch[via]) throw err(400, via === "imessage" ? "The iMessage relay isn't connected" : "Twilio isn't connected");
  return via === "imessage" ? sendIMessage(env, ctx, b, hooks) : sendSms(env, ctx, b, hooks);
}
