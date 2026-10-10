// Browser phone: call and text from Warplan itself, on the workspace's Twilio account.
//   Calls   Twilio Voice JS SDK in the browser (WebRTC). The browser asks for a short-lived access token; Twilio
//           asks our TwiML App webhook what to do and we answer <Dial callerId=your number><Number>them</Number>.
//   Inbound Optional: point the Twilio number at Warplan and incoming calls ring every teammate's browser
//           (with the target's name when the number is known); incoming texts land on the target's timeline.
//   Texts   Twilio Messages API, threads read back from Twilio, STOP/UNSUBSCRIBE replies suppress the number.
// Setup is one click: from the Twilio key the workspace already connected we create an API key (for tokens) and
// a TwiML App (for the webhook). Webhook URLs carry a secret per workspace and every request is checked against
// Twilio's signature.
import { twilio, twilioReq, xml, e164, dialGuard, recordAttempt, balancedCallerId, loadsToday, curFor } from "./dialer.js";
import { seal, open } from "./keys.js";
import { sha256, randomToken } from "./auth.js";
import { pickCallerId, callerNumbers, smsNumbers, countryName } from "./numbers.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlStr = (s) => b64url(enc.encode(s));
const SMS_PER_DAY = 300;
export const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|stopp|avmeld)\s*$/i;
const aad = (accountId) => `acct:${accountId}:twilio_phone`;

async function getCfg(env, accountId) {
  const r = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'phone'").bind(accountId).first();
  return r ? JSON.parse(r.data) : null;
}
async function putCfg(env, accountId, cfg) {
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'phone', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(accountId, JSON.stringify(cfg), now()).run();
}
async function twilioDelete(tw, path) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}${path}`, { method: "DELETE", headers: { Authorization: tw.auth } });
  if (!res.ok && res.status !== 404) console.warn("twilio delete", path, res.status);
}
const hookBase = (origin, token) => `${origin}/hooks/twilio/${token}`;

// ------------------------------------------------------------------ status, setup
export async function phoneStatus(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  let tw = null;
  try { tw = await twilio(env, ctx); } catch { /* not connected */ }
  const numbers = tw ? callerNumbers(tw, cfg).map((n) => ({ number: n, country: countryName(n), owned: !!cfg?.numbers?.find((x) => x.number === n && x.owned), sms: !!cfg?.numbers?.find((x) => x.number === n && x.sms) })) : [];
  return { twilio: !!tw, ready: !!(tw && cfg?.app_sid), from: tw?.from || null, numbers, incoming: !!cfg?.incoming, can_receive: !!cfg?.numbers?.some((n) => n.owned && n.voice), canEdit: ctx.isOwner };
}

export async function setupPhone(env, ctx, origin) {
  const tw = await twilio(env, ctx);
  const old = await getCfg(env, ctx.accountId);
  const token = randomToken("tw_");
  const base = hookBase(origin, token);
  // Fresh credentials each time: retire the previous key and app so nothing stale keeps working.
  if (old?.key_sid) await twilioDelete(tw, `/Keys/${old.key_sid}.json`);
  if (old?.app_sid) await twilioDelete(tw, `/Applications/${old.app_sid}.json`);
  const key = await twilioReq(tw, "/Keys.json", { FriendlyName: "Warplan browser phone" });
  const app = await twilioReq(tw, "/Applications.json", { FriendlyName: "Warplan browser phone", VoiceUrl: `${base}/voice`, VoiceMethod: "POST" });
  const numbers = await discoverNumbers(tw);
  const sealedKey = await seal(env, key.secret, aad(ctx.accountId));
  const sealedTok = await seal(env, token, aad(ctx.accountId));
  const cfg = {
    hook_hash: await sha256(token), hook_ct: sealedTok.ciphertext, hook_iv: sealedTok.iv, origin,
    key_sid: key.sid, key_ct: sealedKey.ciphertext, key_iv: sealedKey.iv, app_sid: app.sid,
    numbers, incoming: false, prev: old?.prev || {}, created_at: now(),
  };
  await putCfg(env, ctx.accountId, cfg);
  if (old?.incoming && numbers.some((n) => n.owned && n.voice)) await setIncoming(env, ctx, true, origin);
  return phoneStatus(env, ctx);
}

// Every number on the Twilio account: bought numbers (can call, text and receive) and verified caller IDs (your own
// numbers, call-out only). Local presence picks from these by the owner's country.
async function discoverNumbers(tw) {
  const [owned, verified] = await Promise.all([
    twilioReq(tw, "/IncomingPhoneNumbers.json?PageSize=100").catch(() => ({})),
    twilioReq(tw, "/OutgoingCallerIds.json?PageSize=100").catch(() => ({})),
  ]);
  const out = (owned.incoming_phone_numbers || []).map((n) => ({ number: n.phone_number, sid: n.sid, owned: true, voice: n.capabilities?.voice !== false, sms: !!n.capabilities?.sms }));
  for (const v of verified.outgoing_caller_ids || []) if (!out.some((n) => n.number === v.phone_number)) out.push({ number: v.phone_number, owned: false, voice: true, sms: false });
  return out.slice(0, 100);
}
export async function refreshNumbers(env, ctx) {
  const tw = await twilio(env, ctx);
  const cfg = await getCfg(env, ctx.accountId);
  if (!cfg?.app_sid) throw err(400, "Set up the browser phone first");
  cfg.numbers = await discoverNumbers(tw);
  await putCfg(env, ctx.accountId, cfg);
  if (cfg.incoming) await setIncoming(env, ctx, true);
  return phoneStatus(env, ctx);
}

// Point the Twilio number at Warplan (calls ring the browser, texts land on the timeline), or put it back.
export async function setIncoming(env, ctx, on, origin) {
  const tw = await twilio(env, ctx);
  const cfg = await getCfg(env, ctx.accountId);
  if (!cfg?.app_sid) throw err(400, "Set up the browser phone first");
  const owned = (cfg.numbers || []).filter((n) => n.owned && n.voice && n.sid);
  if (!owned.length) throw err(400, "None of your numbers can receive calls: verified caller IDs only call out. Buy a number in Twilio, then refresh your numbers here.");
  cfg.prev ||= {};
  const base = hookBase(cfg.origin || origin, await open(env, { ciphertext: cfg.hook_ct, iv: cfg.hook_iv }, aad(ctx.accountId)));
  for (const n of owned) {
    if (on) {
      const cur = await twilioReq(tw, `/IncomingPhoneNumbers/${n.sid}.json`);
      // Remember what the number did before, so turning this off puts it back exactly.
      if (!String(cur.voice_url || "").includes("/hooks/twilio/")) cfg.prev[n.sid] = { voice: cur.voice_url || "", sms: cur.sms_url || "" };
      await twilioReq(tw, `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: `${base}/incoming`, VoiceMethod: "POST", SmsUrl: `${base}/sms`, SmsMethod: "POST" });
    } else {
      await twilioReq(tw, `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: cfg.prev[n.sid]?.voice || "", SmsUrl: cfg.prev[n.sid]?.sms || "" });
    }
  }
  cfg.incoming = !!on;
  await putCfg(env, ctx.accountId, cfg);
  return phoneStatus(env, ctx);
}

export async function removePhone(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  if (!cfg) return { ok: true };
  const tw = await twilio(env, ctx);
  if (cfg.incoming) await setIncoming(env, ctx, false).catch(() => {});
  if (cfg.key_sid) await twilioDelete(tw, `/Keys/${cfg.key_sid}.json`);
  if (cfg.app_sid) await twilioDelete(tw, `/Applications/${cfg.app_sid}.json`);
  await env.DB.prepare("DELETE FROM settings WHERE account_id = ?1 AND key = 'phone'").bind(ctx.accountId).run();
  return { ok: true };
}

// ------------------------------------------------------------------ access token (Twilio JWT, HS256)
export async function phoneToken(env, ctx) {
  if (!ctx.user.id) throw err(400, "The browser phone belongs to a signed-in user");
  const tw = await twilio(env, ctx);
  const cfg = await getCfg(env, ctx.accountId);
  if (!cfg?.app_sid) throw err(400, "Set up the browser phone first (Phone → Set up)");
  const secret = await open(env, { ciphertext: cfg.key_ct, iv: cfg.key_iv }, aad(ctx.accountId));
  const identity = `u${ctx.user.id}`;
  const token = await twilioJwt({ keySid: cfg.key_sid, secret, accountSid: tw.sid, appSid: cfg.app_sid, identity });
  return { token, identity, from: tw.from, expires_in: 3600, incoming: !!cfg.incoming };
}
// Which of your numbers an owner will see when you call or text them.
export async function callerFor(env, ctx, to) {
  const tw = await twilio(env, ctx);
  const cfg = await getCfg(env, ctx.accountId);
  return { call: balancedCallerId(callerNumbers(tw, cfg), to, tw.from, await loadsToday(env, ctx.accountId)), sms: pickCallerId(smsNumbers(tw, cfg), to, tw.from) };
}

// A Twilio access token: HS256 JWT signed with the API key secret, granting voice in and out as `identity`.
export async function twilioJwt({ keySid, secret, accountSid, appSid, identity, iat = Math.floor(Date.now() / 1000), ttl = 3600 }) {
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = { jti: `${keySid}-${iat}`, iss: keySid, sub: accountSid, iat, exp: iat + ttl, grants: { identity, voice: { incoming: { allow: true }, outgoing: { application_sid: appSid } } } };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return `${unsigned}.${b64url(await crypto.subtle.sign("HMAC", key, enc.encode(unsigned)))}`;
}

// ------------------------------------------------------------------ who is this number?
const tail = (s) => String(s || "").replace(/\D/g, "").slice(-8);
const DIGITS_SQL = (col) => `replace(replace(replace(replace(replace(replace(${col}, ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', '')`;
export async function findByPhone(env, accountId, number) {
  const t8 = tail(number);
  if (t8.length < 7) return null;
  return env.DB.prepare(`SELECT id, name, owner_name, currency, location FROM targets WHERE account_id = ?1 AND (${DIGITS_SQL("phone")} LIKE ?2
    OR id IN (SELECT target_id FROM contacts WHERE account_id = ?1 AND kind = 'phone' AND ${DIGITS_SQL("value")} LIKE ?2)) ORDER BY updated_at DESC LIMIT 1`).bind(accountId, `%${t8}`).first();
}
export async function lookup(env, ctx, number) {
  const t = await findByPhone(env, ctx.accountId, number);
  const norm = e164(number, t ? curFor(t) : "$");
  const via = norm ? await callerFor(env, ctx, norm).catch(() => null) : null;
  return { number, e164: norm, country: countryName(norm), caller_id: via?.call || null, target: t ? { id: t.id, name: t.name, owner: t.owner_name } : null };
}

// ------------------------------------------------------------------ texts
// Checks every text passes, whatever it goes out on (Twilio or iMessage): a message, a valid number, the daily cap,
// and nobody who replied STOP.
export async function guardText(env, ctx, b) {
  const text = String(b.body || "").trim().slice(0, 1600);
  if (!text) throw err(400, "Write the message first");
  const match = b.target_id ? await env.DB.prepare("SELECT id, name, currency, location FROM targets WHERE id = ?1 AND account_id = ?2").bind(+b.target_id, ctx.accountId).first() : await findByPhone(env, ctx.accountId, b.to);
  const to = e164(b.to, match ? curFor(match) : "$");
  if (!to) throw err(400, "Use the number in +country format, e.g. +4791234567");
  const sentToday = (await env.DB.prepare("SELECT COUNT(*) AS n FROM usage WHERE account_id = ?1 AND feature = 'sms' AND created_at >= ?2").bind(ctx.accountId, now().slice(0, 10)).first()).n;
  if (sentToday >= SMS_PER_DAY) throw err(429, `This workspace has sent ${SMS_PER_DAY} texts today, the daily limit`);
  if (await env.DB.prepare("SELECT 1 FROM suppressions WHERE account_id = ?1 AND email = ?2").bind(ctx.accountId, `tel:${to}`).first()) throw err(400, `${to} replied STOP: texting them again isn't allowed`);
  return { text, to, match };
}
export async function recordText(env, ctx, { to, text, match, via }, hooks) {
  await env.DB.prepare("INSERT INTO usage (account_id, user_id, feature, model, input_tokens, output_tokens, cached_tokens, own_key, created_at) VALUES (?1, ?2, 'sms', ?3, 0, 0, 0, 1, ?4)").bind(ctx.accountId, ctx.user.id || null, via, now()).run();
  if (match) {
    await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'sms', ?5, ?6)")
      .bind(ctx.accountId, match.id, ctx.user.id || null, ctx.user.name || ctx.user.email || "Agent", `${via === "imessage" ? "iMessage" : "Text"} to ${to}: ${text}`, now()).run();
  }
  hooks?.emit("sms.sent", { to, target_id: match?.id || null, via });
}

export async function sendSms(env, ctx, b, hooks) {
  const tw = await twilio(env, ctx);
  const { text, to, match } = await guardText(env, ctx, b);
  const from = pickCallerId(smsNumbers(tw, await getCfg(env, ctx.accountId)), to, tw.from);
  const m = await twilioReq(tw, "/Messages.json", { From: from, To: to, Body: text });
  await recordText(env, ctx, { to, text, match, via: "twilio" }, hooks);
  return { sid: m.sid, status: m.status, to, from, via: "twilio", target_id: match?.id || null, receipt: `Texted ${match?.name || to}` };
}

// Conversations, newest first, read straight from Twilio (so texts sent from elsewhere show up too).
export async function threads(env, ctx) {
  const tw = await twilio(env, ctx);
  const d = await twilioReq(tw, "/Messages.json?PageSize=200");
  const ours = new Set(callerNumbers(tw, await getCfg(env, ctx.accountId)));
  const by = new Map();
  for (const m of d.messages || []) {
    const inbound = m.direction === "inbound";
    const other = inbound ? m.from : m.to;
    if (!other || other.startsWith("client:") || ours.has(other)) continue;
    if (!by.has(other)) by.set(other, []);
    by.get(other).push({ sid: m.sid, inbound, body: m.body, status: m.status, at: new Date(m.date_sent || m.date_created).toISOString(), error: m.error_message || null });
  }
  const list = [...by.entries()].slice(0, 40);
  const out = [];
  for (const [number, msgs] of list) {
    const t = await findByPhone(env, ctx.accountId, number);
    out.push({ number, target: t ? { id: t.id, name: t.name, owner: t.owner_name } : null, messages: msgs.reverse(), last: msgs[msgs.length - 1] });
  }
  return { from: tw.from, threads: out };
}

export async function recentCalls(env, ctx) {
  const tw = await twilio(env, ctx);
  const d = await twilioReq(tw, "/Calls.json?PageSize=60");
  const rows = (d.calls || []).filter((c) => {
    const other = c.direction === "inbound" ? c.from : c.to;
    return other && !other.startsWith("client:") && other !== tw.agentPhone && !(c.direction === "inbound" && c.to?.startsWith("client:"));
  }).slice(0, 30);
  const out = [];
  for (const c of rows) {
    const number = c.direction === "inbound" ? c.from : c.to;
    const t = await findByPhone(env, ctx.accountId, number);
    out.push({ sid: c.sid, number, inbound: c.direction === "inbound", status: c.status, duration: c.duration != null ? +c.duration : null, at: new Date(c.start_time || c.date_created).toISOString(), target: t ? { id: t.id, name: t.name } : null });
  }
  return { calls: out };
}

// ------------------------------------------------------------------ Twilio webhooks (public, signed)
export async function validSignature(authToken, url, params, signature) {
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)))));
  if (sig.length !== String(signature || "").length) return false;
  let diff = 0; for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
const twiml = (inner) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, { headers: { "Content-Type": "text/xml" } });

export async function twilioHook(request, env, url, hooksFor) {
  const m = url.pathname.match(/^\/hooks\/twilio\/(tw_[\w-]{20,})\/(voice|incoming|after|sms)$/);
  if (!m || request.method !== "POST") return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT s.account_id FROM settings s JOIN accounts a ON a.id = s.account_id WHERE s.key = 'phone' AND json_extract(s.data, '$.hook_hash') = ?1 AND a.active = 1").bind(await sha256(m[1])).first();
  if (!row) return new Response("Not found", { status: 404 });
  const ctx = { accountId: row.account_id, user: { id: null, name: "Phone" }, isOwner: false };
  const hooks = hooksFor(row.account_id);
  const tw = await twilio(env, ctx).catch(() => null);
  if (!tw) return twiml("<Say>This line isn't configured.</Say>");
  const params = new URLSearchParams(await request.text());
  if (params.get("AccountSid") !== tw.sid || !(await validSignature(tw.token, url.toString(), params, request.headers.get("X-Twilio-Signature")))) return new Response("Bad signature", { status: 403 });
  const kind = m[2];

  if (kind === "voice") {
    // An outgoing call from a teammate's browser.
    const uid = (params.get("From") || params.get("Caller") || "").match(/^client:u(\d+)$/)?.[1];
    const user = uid ? await env.DB.prepare("SELECT id FROM users WHERE id = ?1 AND account_id = ?2").bind(+uid, row.account_id).first() : null;
    if (!user) return twiml("<Say>Not allowed.</Say><Hangup/>");
    const to = String(params.get("To") || "").replace(/[\s()-]/g, "");
    if (!/^\+\d{7,15}$/.test(to)) return twiml("<Say>That number isn't in international format.</Say><Hangup/>");
    // Same rules as every other dial: the owner's calling hours, 3 tries a day, the do-not-call list.
    const t = await findByPhone(env, row.account_id, to);
    const full = t ? await env.DB.prepare("SELECT location, currency FROM targets WHERE id = ?1").bind(t.id).first() : null;
    let g;
    try { g = await dialGuard(env, row.account_id, { to, location: full?.location, currency: full?.currency, retry: params.get("retry") === "1" }); }
    catch (e) { return twiml(`<Say>${xml(e.status ? e.message.replace(/\+/g, " plus ") : "This call isn't allowed.")}</Say><Hangup/>`); }
    const callerId = balancedCallerId(callerNumbers(tw, await getCfg(env, row.account_id)), to, tw.from, await loadsToday(env, row.account_id));
    await recordAttempt(env, { accountId: row.account_id, userId: user.id, targetId: t?.id, to, callerId, via: "browser", info: g.info });
    return twiml(`<Dial callerId="${xml(callerId)}" answerOnBridge="true" timeLimit="3600"><Number>${xml(to)}</Number></Dial>`);
  }
  if (kind === "incoming") {
    // Someone called the Twilio number: ring every teammate's browser, with the target's name if we know them.
    const from = params.get("From") || "";
    const t = await findByPhone(env, row.account_id, from);
    const { results } = await env.DB.prepare("SELECT id FROM users WHERE account_id = ?1 ORDER BY id LIMIT 10").bind(row.account_id).all();
    const base = url.toString().replace(/\/incoming$/, "");
    const clients = results.map((u) => `<Client><Identity>u${u.id}</Identity>${t ? `<Parameter name="target_id" value="${t.id}"/><Parameter name="target_name" value="${xml(t.name.slice(0, 80))}"/>` : ""}</Client>`).join("");
    return twiml(`<Dial timeout="25" answerOnBridge="true" action="${xml(base)}/after">${clients}</Dial>`);
  }
  if (kind === "after") {
    const st = params.get("DialCallStatus");
    if (st === "completed" || st === "answered") return twiml("<Hangup/>");
    const from = params.get("From") || "";
    const t = await findByPhone(env, row.account_id, from);
    if (t) await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'Phone', 'call', ?3, ?4)").bind(row.account_id, t.id, `Missed call from ${from}. Call them back.`, now()).run();
    hooks?.emit("call.missed", { from, target_id: t?.id || null });
    return twiml("<Say>Sorry, no one can take your call right now. We'll call you back shortly.</Say><Hangup/>");
  }
  // kind === "sms": an incoming text.
  const from = params.get("From") || "", text = String(params.get("Body") || "").slice(0, 1600);
  const t = await findByPhone(env, row.account_id, from);
  if (STOP_WORDS.test(text)) await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, 'Replied STOP to a text', ?3)").bind(row.account_id, `tel:${from}`, now()).run();
  if (t) await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'Phone', 'sms', ?3, ?4)").bind(row.account_id, t.id, `Text from ${from}: ${text}`, now()).run();
  hooks?.emit("sms.received", { from, body: text, target_id: t?.id || null });
  return twiml("");
}
