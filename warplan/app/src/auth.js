// Accounts, users and sessions.
//   Passwords: PBKDF2-SHA256, 100k iterations (the Workers maximum), per-user salt.
//   Sessions: stateless signed cookie "uid.exp.sig"; the signature covers the user's session epoch, so changing
//   a password (or an admin removing a user) invalidates every existing session.
//   API tokens: random, shown once, stored only as SHA-256. The legacy API_TOKEN secret acts as platform admin.

const SESSION_DAYS = 30;
const ITER = 100000;
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf) => b64(buf).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function safeEqual(a, b) {
  const x = enc.encode(a), y = enc.encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

export async function hashPassword(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(bits)}`;
}

export async function verifyPassword(pw, stored) {
  const [scheme, iter, salt, hash] = String(stored || "").split("$");
  if (scheme !== "pbkdf2") return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: unb64(salt), iterations: +iter }, key, 256);
  return safeEqual(b64(bits), hash);
}

export async function sha256(s) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const randomToken = (prefix = "") => prefix + b64url(crypto.getRandomValues(new Uint8Array(24)));

export function passwordProblem(pw) {
  if (typeof pw !== "string" || pw.length < 10) return "Use at least 10 characters";
  if (pw.length > 200) return "That password is too long";
  return null;
}

async function hmac(env, data) {
  // Fail closed: sessions are never signed with a guessable fallback (like the setup password).
  const secret = env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw Object.assign(new Error("Sign-in isn't configured on this server (SESSION_SECRET)"), { status: 503 });
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

export async function sessionCookie(env, user) {
  const exp = Date.now() + SESSION_DAYS * 864e5;
  const sig = await hmac(env, `${user.id}.${exp}.${user.session_epoch}.${user.created_at}`);
  return `df_s=${user.id}.${exp}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}
export const clearCookie = "df_s=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

const USER_SQL = `SELECT u.id, u.account_id, u.email, u.name, u.role, u.is_admin, u.session_epoch, u.created_at, u.password_hash,
  a.name AS account_name, a.plan, a.max_territories, a.active AS account_active
  FROM users u JOIN accounts a ON a.id = u.account_id`;

export function toCtx(u) {
  return {
    user: { id: u.id, email: u.email, name: u.name, role: u.role },
    accountId: u.account_id,
    account: { id: u.account_id, name: u.account_name, plan: u.plan, maxTerritories: u.max_territories },
    isAdmin: !!u.is_admin,
    isOwner: u.role === "owner" || !!u.is_admin,
  };
}

// Resolve who is calling. Returns null when not signed in.
export async function getContext(request, env) {
  const bearer = (request.headers.get("Authorization") || "").match(/^Bearer (.+)$/)?.[1]?.trim();
  if (bearer) {
    if (env.API_TOKEN && safeEqual(bearer, env.API_TOKEN)) {
      const acct = await env.DB.prepare("SELECT * FROM accounts WHERE id = 1").first();
      return { user: { id: 0, email: "api", name: "Platform API", role: "owner" }, accountId: 1, account: { id: 1, name: acct?.name || "HQ", plan: acct?.plan, maxTerritories: acct?.max_territories }, isAdmin: true, isOwner: true, viaToken: true };
    }
    const row = await env.DB.prepare(`${USER_SQL} JOIN api_tokens t ON t.user_id = u.id WHERE t.token_hash = ?1`).bind(await sha256(bearer)).first();
    if (!row || !row.account_active) return null;
    env.DB.prepare("UPDATE api_tokens SET last_used_at = ?2 WHERE token_hash = ?1").bind(await sha256(bearer), new Date().toISOString()).run().catch(() => {});
    return { ...toCtx(row), viaToken: true };
  }
  const cookie = (request.headers.get("Cookie") || "").match(/(?:^|;\s*)df_s=([^;]+)/)?.[1];
  if (!cookie) return null;
  const [uid, exp, sig] = cookie.split(".");
  if (!uid || !(Number(exp) > Date.now())) return null;
  const u = await env.DB.prepare(`${USER_SQL} WHERE u.id = ?1`).bind(+uid).first();
  if (!u || !u.account_active) return null;
  if (!safeEqual(sig || "", await hmac(env, `${u.id}.${exp}.${u.session_epoch}.${u.created_at}`))) return null;
  return toCtx(u);
}

export async function findUserForLogin(env, email) {
  return env.DB.prepare(`${USER_SQL} WHERE lower(u.email) = lower(?1)`).bind(String(email || "").trim()).first();
}
