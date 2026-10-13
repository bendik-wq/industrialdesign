// "Connect Gmail": the user signs in with Google (OAuth), the way Cowork connects Gmail, and Warplan sends from their
// real address through the Gmail API and reads replies back. No app password and no third-party inbox.
// Scopes: gmail.send (send as them) and gmail.readonly (find replies to triage). Only the refresh token is stored,
// sealed with AES-GCM like every other credential. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a Google Cloud
// OAuth client, type "Web application", redirect URI <origin>/api/google/callback).
import { seal, open } from "./keys.js";
import { hmac, safeEqual } from "./auth.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const aad = (userId) => `mailbox:${userId}`;
const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/gmail.readonly"];
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export const gmailConfigured = (env) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
const redirectUri = (origin) => `${origin}/api/google/callback`;

// Step 1: send the browser to Google. The state is signed and names the user, so the callback can't be replayed
// into someone else's account.
export async function gmailAuthUrl(env, ctx, origin) {
  if (!gmailConfigured(env)) throw err(503, "Gmail sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)");
  if (!ctx.user.id || ctx.viaToken) throw err(403, "Connect Gmail while signed in to the app");
  const exp = Date.now() + 10 * 60000, body = `${ctx.user.id}.${exp}`;
  const state = `${body}.${await hmac(env, `gmail-oauth:${body}`)}`;
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: redirectUri(origin), response_type: "code", scope: ["openid", "email", ...SCOPES].join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

// Step 2: Google sends them back with a code. Swap it for tokens, keep the refresh token, make Gmail their mailbox.
export async function gmailCallback(env, ctx, url) {
  const back = (msg) => Response.redirect(`${url.origin}/#/settings/email?gmail=${encodeURIComponent(msg)}`, 302);
  if (url.searchParams.get("error")) return back(url.searchParams.get("error") === "access_denied" ? "You cancelled the Google sign-in" : "Google said no: " + url.searchParams.get("error"));
  const [uid, exp, sig] = String(url.searchParams.get("state") || "").split(".");
  if (!uid || !sig || +exp < Date.now() || !safeEqual(sig, await hmac(env, `gmail-oauth:${uid}.${exp}`)) || +uid !== ctx.user.id) return back("That sign-in link expired. Try Connect Gmail again");
  const tok = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: url.searchParams.get("code") || "", client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri: redirectUri(url.origin), grant_type: "authorization_code" }) }).then((r) => r.json());
  if (!tok.refresh_token) return back(tok.error_description || "Google didn't return offline access. Try again");
  const granted = String(tok.scope || "");
  if (!SCOPES.every((s) => granted.includes(s))) return back("Tick both Gmail boxes on Google's screen (send, and read for replies)");
  const profile = await fetch(`${API}/profile`, { headers: { Authorization: `Bearer ${tok.access_token}` } }).then((r) => r.json());
  if (!profile.emailAddress) return back("Couldn't read your Gmail address");
  const sealed = await seal(env, tok.refresh_token, aad(ctx.user.id));
  const stamp = now();
  await env.DB.prepare(`INSERT INTO mailboxes (user_id, account_id, email, from_name, host, port, username, ciphertext, iv, signature, postal_address, daily_limit, verified_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, 'gmail', 0, ?3, ?5, ?6, '', '', 40, ?7, ?7)
    ON CONFLICT (user_id) DO UPDATE SET email = ?3, host = 'gmail', port = 0, username = ?3, ciphertext = ?5, iv = ?6, verified_at = ?7, updated_at = ?7`)
    .bind(ctx.user.id, ctx.accountId, profile.emailAddress.toLowerCase(), ctx.user.name || "", sealed.ciphertext, sealed.iv, stamp).run();
  // Start reading replies from now, not the whole history.
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (account_id, key) DO UPDATE SET data = ?3, updated_at = ?4").bind(ctx.accountId, `gmail:${ctx.user.id}`, JSON.stringify({ after: Math.floor(Date.now() / 1000) }), stamp).run();
  return back(`connected:${profile.emailAddress}`);
}

async function accessToken(env, box) {
  const refresh = await open(env, box, aad(box.user_id));
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }) }).then((x) => x.json());
  if (!r.access_token) throw err(401, r.error === "invalid_grant" ? "Google signed Warplan out of your Gmail. Settings → Email → Connect Gmail again" : `Google token error: ${r.error || "unknown"}`);
  return r.access_token;
}

const fromB64url = (s) => new TextDecoder().decode(Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

// Send a full MIME message (built by mailer.buildMessage) as the user. It lands in their Gmail Sent folder.
export async function gmailSend(env, box, raw) {
  const bytes = new TextEncoder().encode(raw);
  let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const res = await fetch(`${API}/messages/send`, { method: "POST", headers: { Authorization: `Bearer ${await accessToken(env, box)}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") }) });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw err(502, `Gmail: ${e.error?.message || res.status}`); }
  return res.json();
}

function bodyText(part) {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return fromB64url(part.body.data);
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t; }
  if (part.mimeType === "text/html" && part.body?.data) return fromB64url(part.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return "";
}

// Every 10 minutes: new mail in each connected Gmail inbox from people Warplan has emailed goes to reply triage.
// Only senders already in sent_emails are read, so personal mail never reaches the AI.
export async function syncGmail(env, accountId, triage) {
  if (!gmailConfigured(env)) return { inboxes: 0, replies: 0 };
  const { results } = await env.DB.prepare("SELECT m.*, a.name AS account_name FROM mailboxes m JOIN accounts a ON a.id = m.account_id AND a.active = 1 WHERE m.host = 'gmail' AND (?1 IS NULL OR m.account_id = ?1) LIMIT 200").bind(accountId).all();
  let replies = 0;
  for (const box of results) {
    try {
      const key = `gmail:${box.user_id}`;
      const st = JSON.parse((await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = ?2").bind(box.account_id, key).first())?.data || "{}");
      const after = st.after || Math.floor(Date.now() / 1000) - 3600;
      const token = await accessToken(env, box);
      const list = await fetch(`${API}/messages?${new URLSearchParams({ q: `in:inbox -from:me after:${after}`, maxResults: "50" })}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
      let last = after;
      for (const { id } of (list.messages || []).reverse()) {
        const m = await fetch(`${API}/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json());
        const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name.toLowerCase(), x.value]));
        last = Math.max(last, Math.floor(+m.internalDate / 1000) || last);
        const from = String(h.from || "").match(/[^\s<>"]+@[^\s<>"]+/)?.[0]?.toLowerCase();
        if (!from || from === box.email) continue;
        const known = await env.DB.prepare("SELECT 1 FROM sent_emails WHERE account_id = ?1 AND to_email = ?2 LIMIT 1").bind(box.account_id, from).first();
        if (!known) continue;
        try { await triage(env, { account_id: box.account_id, account_name: box.account_name }, { lead_email: from, subject: h.subject || "", reply_text: bodyText(m.payload).slice(0, 8000) }, "gmail"); replies++; }
        catch (e) { console.warn("gmail triage", e.message); }
      }
      await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (account_id, key) DO UPDATE SET data = ?3, updated_at = ?4").bind(box.account_id, key, JSON.stringify({ after: last + 1 }), now()).run();
    } catch (e) { console.warn("gmail sync", box.email, e.message); }
  }
  return { inboxes: results.length, replies };
}
