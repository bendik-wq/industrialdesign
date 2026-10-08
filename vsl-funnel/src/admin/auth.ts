import type { Context, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { safeEqual, signToken, verifyToken } from '../lib/crypto';
import { getSecret } from '../lib/secret';

const ADMIN_COOKIE = '_fa';
const TTL_S = 7 * 24 * 3600;

/**
 * Password login for the dashboard (ADMIN_PASSWORD secret) with a signed,
 * HttpOnly session cookie. For a team, put /admin* behind Cloudflare Access as well.
 */
export async function login(c: Context<AppEnv>, password: unknown) {
  const expected = c.env.ADMIN_PASSWORD;
  if (!expected) return { ok: false, error: 'Set the ADMIN_PASSWORD secret first: npx wrangler secret put ADMIN_PASSWORD' };
  if (typeof password !== 'string' || !safeEqual(password, expected)) {
    await new Promise((r) => setTimeout(r, 750)); // slow down guessing
    return { ok: false, error: 'Wrong password' };
  }
  const exp = Math.floor(Date.now() / 1000) + TTL_S;
  const token = await signToken(await getSecret(c.env), `admin.${exp}`);
  setCookie(c, ADMIN_COOKIE, token, { path: '/', httpOnly: true, secure: new URL(c.req.url).protocol === 'https:', sameSite: 'Strict', maxAge: TTL_S });
  return { ok: true };
}

export const logout = (c: Context<AppEnv>) => deleteCookie(c, ADMIN_COOKIE, { path: '/' });

export async function isAdmin(c: Context<AppEnv>) {
  const token = getCookie(c, ADMIN_COOKIE);
  if (!token || !c.env.ADMIN_PASSWORD) return false;
  const payload = await verifyToken(await getSecret(c.env), token);
  const exp = Number(payload?.split('.')[1]);
  return Boolean(payload?.startsWith('admin.') && exp > Date.now() / 1000);
}

export async function requireAdmin(c: Context<AppEnv>, next: Next) {
  if (await isAdmin(c)) return next();
  if (c.req.path.startsWith('/admin/api/')) return c.json({ error: 'unauthorised' }, 401);
  return c.redirect('/admin/login', 302);
}
