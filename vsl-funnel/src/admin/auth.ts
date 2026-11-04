import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { safeEqual, signToken, verifyToken } from '../lib/crypto';
import { getSecret } from '../lib/secret';
import { hit } from '../lib/ratelimit';
import { guestGate, guestSession } from './guest';

export const ADMIN_COOKIE = '_fa';
const TTL_S = 3 * 24 * 3600;
const MAX_FAILS = 10;
const FAIL_WINDOW_MS = 15 * 60_000;
/** Failed logins from all IPs together per hour before sign-in pauses for the rest of that hour. */
export const MAX_GLOBAL_FAILS = 300;
const GLOBAL_FAIL_WINDOW_MS = 3_600_000;
const GLOBAL_FAIL_KEY = 'rl:login-fail:all';
export const LOGIN_COPY = {
  wrong: 'Wrong password',
  tooMany: 'Too many attempts. Wait 15 minutes and try again.',
  tooManyAll: 'Sign-in is paused after many wrong passwords. Try again within the hour.',
  setup: 'Set the ADMIN_PASSWORD secret first: npx wrangler secret put ADMIN_PASSWORD',
};

/** Short fingerprint of the current password: changing ADMIN_PASSWORD signs every existing session out. */
async function passwordPrint(pw: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`admin-pw|${pw}`));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Bumped by "log out everywhere" (and every logout, since there's one shared password). */
async function sessionEpoch(c: Context<AppEnv>) {
  const row = await c.env.DB.prepare("SELECT value FROM kv_state WHERE key = 'admin:epoch'").first<{ value: string }>();
  return row?.value ?? '0';
}
const isLocal = (c: Context<AppEnv>) => /^(localhost|127\.0\.0\.1)$/.test(new URL(c.req.url).hostname);

/**
 * Password login for the dashboard (ADMIN_PASSWORD secret) with a signed,
 * HttpOnly session cookie. For a team, put /admin* behind Cloudflare Access as well.
 */
export async function login(c: Context<AppEnv>, password: unknown) {
  const expected = c.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, error: LOGIN_COPY.setup, code: 'setup' as const };
  // Lockout per IP: 10 attempts in 15 minutes, then wait. Counted atomically before the password is checked, so a
  // burst of parallel guesses can't all slip in under the limit (the old read-then-write counter let them). Plus a
  // ceiling on failed attempts from all IPs together (a guesser spread over many IPs). Cloudflare Access on /admin*
  // is still the real fix.
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const key = `rl:login:${ip}`;
  if ((await hit(c.env, key, FAIL_WINDOW_MS)) > MAX_FAILS) return { ok: false, error: LOGIN_COPY.tooMany, code: 'tooMany' as const };
  if ((await peek(c, GLOBAL_FAIL_KEY, GLOBAL_FAIL_WINDOW_MS)) >= MAX_GLOBAL_FAILS) return { ok: false, error: LOGIN_COPY.tooManyAll, code: 'tooManyAll' as const };
  if (typeof password !== 'string' || !safeEqual(password, expected)) {
    await hit(c.env, GLOBAL_FAIL_KEY, GLOBAL_FAIL_WINDOW_MS);
    console.warn('admin login failed', ip);
    await new Promise((r) => setTimeout(r, 750)); // slow down guessing
    return { ok: false, error: LOGIN_COPY.wrong, code: 'wrong' as const };
  }
  await c.env.DB.prepare('DELETE FROM kv_state WHERE key = ?').bind(key).run();
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  // A fresh random id per sign-in: every login gets a token never handed out before (rotation on login).
  const sid = [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const token = await signToken(await getSecret(c.env), `admin.${exp}.${await passwordPrint(expected)}.${await sessionEpoch(c)}.${sid}`);
  setCookie(c, ADMIN_COOKIE, token, { path: '/', httpOnly: true, secure: !isLocal(c), sameSite: 'Strict', maxAge: TTL_S });
  return { ok: true, error: null, code: null };
}

/** Hits on a counter in its current window, without counting one. */
async function peek(c: Context<AppEnv>, key: string, windowMs: number) {
  const row = await c.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(key).first<{ value: string }>();
  try { const v = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return v.t && Date.now() - v.t < windowMs ? v.n ?? 0 : 0; } catch { return 0; }
}

/** Logging out ends every admin session (the token can't be revoked any other way). */
export async function logout(c: Context<AppEnv>) {
  const wasAdmin = await isAdmin(c);
  deleteCookie(c, ADMIN_COOKIE, { path: '/' });
  // Only a signed-in admin can end everyone's sessions (otherwise anyone could log the team out on repeat).
  if (wasAdmin) await c.env.DB.prepare("INSERT INTO kv_state (key, value) VALUES ('admin:epoch', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(Date.now())).run();
}

/** The owner (password session) only. Guests are never admins: see canView for read-only pages outside requireAdmin. */
export async function isAdmin(c: Context<AppEnv>) {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token || !c.env.ADMIN_PASSWORD) return false;
  const payload = await verifyToken(await getSecret(c.env), token);
  const [tag, exp, print, epoch] = payload?.split('.') ?? [];
  return tag === 'admin' && Number(exp) > Date.now() / 1000 && print === (await passwordPrint(c.env.ADMIN_PASSWORD)) && epoch === (await sessionEpoch(c));
}

/** Changes must come from the dashboard itself, not from another site or subdomain (defence on top of SameSite). */
export function sameOriginWrite(c: Context<AppEnv>) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) return true;
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  const origin = c.req.header('origin');
  if (origin) return origin === new URL(c.req.url).origin;
  // No Origin: accept only if the browser vouched for same-origin via Sec-Fetch-Site. A scripted client
  // that sends neither is rejected (the SameSite=Strict cookie already blocks cross-site, this adds depth).
  return site === 'same-origin';
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (!sameOriginWrite(c)) return c.json({ error: 'forbidden' }, 403);
  if (await isAdmin(c)) {
    await next();
    c.header('cache-control', 'no-store'); // lead data must not sit in the browser cache
    return;
  }
  // A guest link (src/admin/guest.ts): read-only, secrets out, personal details hidden when the invite says so.
  const guest = await guestSession(c);
  if (guest) return guestGate(c, next, guest);
  if (c.req.path.startsWith('/admin/api/')) return c.json({ error: 'unauthorised' }, 401);
  return c.redirect('/admin/login', 302);
}

/** The owner, or a guest with a live link: for read-only pages that check the session themselves (/materials). */
export async function canView(c: Context<AppEnv>) {
  return (await isAdmin(c)) || Boolean(await guestSession(c));
}
