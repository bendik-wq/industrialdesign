import type { Context } from 'hono';
import type { AppEnv, Runtime } from '../app';
import type { Env } from '../env';
import { hmacHex, safeEqual } from '../lib/crypto';
import { getSecret } from '../lib/secret';

/**
 * Short-lived signed links to objects in the R2 bucket RECORDINGS (Cloudflare round, builder D):
 *  - rendered PDFs (pdf/…), handed to the person who asked for the download;
 *  - room recordings (rooms/…), handed to Cloudflare Stream's copy-from-URL API.
 * GET /files/s/<base64url key>?e=<expiry ms>&n=<download name>&s=<signature>. The signature covers the key, the
 * expiry and the download name; past the expiry or with any part changed the link answers 404. Only the two
 * prefixes above can be signed or served.
 */
export const SIGNED_PREFIXES = ['pdf/', 'rooms/'] as const;
export const SIGNED_FILE_PATH = '/files/s/';

const b64url = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch { return null; }
};

export const signableKey = (key: string) =>
  key.length <= 300 && !key.includes('..') && !key.includes('//') && /^[A-Za-z0-9/_.-]+$/.test(key) && SIGNED_PREFIXES.some((p) => key.startsWith(p));
const cleanName = (n: string) => n.replace(/[^A-Za-z0-9 ._-]/g, '').trim().slice(0, 80);

async function signature(env: Env, key: string, exp: number, name: string) {
  return (await hmacHex(await getSecret(env), `file|${key}|${exp}|${name}`)).slice(0, 32);
}

/** A link to `key` that works for `ttlMs`. `name` makes the browser download it under that file name. */
export async function signedFileUrl(rt: Pick<Runtime, 'env' | 'origin'>, key: string, ttlMs: number, o: { name?: string; now?: number } = {}) {
  if (!signableKey(key)) throw new Error('This file can’t be linked.');
  const exp = (o.now ?? Date.now()) + Math.max(1000, ttlMs);
  const name = cleanName(o.name ?? '');
  const q = new URLSearchParams({ e: String(exp) });
  if (name) q.set('n', name);
  q.set('s', await signature(rt.env, key, exp, name));
  return `${rt.origin}${SIGNED_FILE_PATH}${b64url(key)}?${q.toString()}`;
}

/** The R2 key a link names, or null when the link is broken, tampered with or expired. */
export async function verifySignedFile(env: Env, encodedKey: string, q: { e?: string; n?: string; s?: string }, now = Date.now()) {
  const key = unb64url(encodedKey);
  if (!key || !signableKey(key)) return null;
  const exp = Number(q.e);
  if (!Number.isFinite(exp) || exp < now) return null;
  const name = cleanName(q.n ?? '');
  if (name !== (q.n ?? '')) return null;
  if (typeof q.s !== 'string' || !/^[0-9a-f]{32}$/.test(q.s)) return null;
  return safeEqual(await signature(env, key, exp, name), q.s) ? { key, name } : null;
}

/** GET /files/s/:k */
export async function signedFileRoute(c: Context<AppEnv>) {
  const bucket = c.env.RECORDINGS;
  if (!bucket) return c.notFound();
  const ok = await verifySignedFile(c.env, c.req.param('k') ?? '', { e: c.req.query('e'), n: c.req.query('n'), s: c.req.query('s') });
  if (!ok) return c.notFound();
  const obj = await bucket.get(ok.key);
  if (!obj || !('body' in obj)) return c.notFound();
  const headers = new Headers({
    'content-type': obj.httpMetadata?.contentType || 'application/octet-stream',
    'content-length': String(obj.size),
    'cache-control': 'private, no-store',
    'x-robots-tag': 'noindex',
    'referrer-policy': 'no-referrer',
  });
  if (ok.name) headers.set('content-disposition', `attachment; filename="${ok.name}"`);
  return new Response(obj.body, { status: 200, headers });
}
