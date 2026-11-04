import type { Context, Hono, Next } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { BRAND } from '../config';
import { hmacHex, safeEqual, sha256, signToken, verifyToken } from '../lib/crypto';
import { newId } from '../lib/ids';
import { hit } from '../lib/ratelimit';
import { getSecret } from '../lib/secret';
import { SETTINGS } from '../settings';
import { PERSONAL_PATHS, type MaskNames, emptyNames, maskPii, maskText, scrubSecrets, secretFieldsToSet } from './pii-mask';

/**
 * Guest access to Funnel HQ: the owner makes a link for one person (Settings & system → Guest access), that person
 * opens it and sees Funnel HQ without the admin password, read-only, optionally with personal details hidden, until
 * the link expires or the owner revokes it.
 *
 *  - The link carries 32 random bytes; only their SHA-256 is stored (admin_invites.token_hash), and it is shown once.
 *  - Opening it sets a separate signed cookie (_fg) bound to the invite id. It lasts 12 hours from the last request
 *    (sliding) and never past the invite's expiry. Every request re-reads the invite, so a revoke ends it at once.
 *  - The owner's password login and its "log out ends every session" stay exactly as they were; guests are not
 *    admins (isAdmin stays false for them), so nothing that checks isAdmin directly (room host powers, Drive OAuth,
 *    the PII export switch) is reachable.
 *  - requireAdmin hands guest requests to guestGate: every non-GET is refused (default deny; GUEST_WRITE_ALLOW is
 *    the explicit list of harmless ones, empty today), so are a few GETs that act (GUEST_DENY_GET), and every
 *    response goes through one transform: secrets out always, personal details out when the invite says so.
 *  - Every guest request is logged (method, path, status, hashed IP; never bodies or query strings).
 */

export const GUEST_COOKIE = '_fg';
/** Idle limit of a guest session (sliding), and the longest an invite can last. */
export const GUEST_IDLE_S = 12 * 3600;
export const INVITE_MAX_DAYS = 90;
export const INVITE_ROLES = ['viewer'] as const;
const REFRESH_AFTER_MS = 5 * 60_000;
const REDEEM_MAX = 20;
const REDEEM_WINDOW_MS = 15 * 60_000;
export const INVITE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export const GUEST_COPY = {
  readOnly: 'This is a guest view, so changes are switched off. Ask the owner to make the change.',
  ownerOnly: 'Only the owner can open this.',
  hostOnly: 'Guests can look at the room list and replays, but only the owner can join a room as the host.',
  invalid: 'This link does not work any more. It may have expired or been switched off. Ask the person who sent it for a new one.',
  tooMany: 'Too many tries from this connection. Wait 15 minutes, then open the link again.',
  welcome: 'Opening Funnel HQ as a guest.',
  left: 'You have left the guest view. Open the link again to come back while it is still active.',
};

export interface GuestSession {
  id: string;
  label: string;
  role: 'viewer';
  maskPii: boolean;
  expiresAt: number;
}
interface InviteRow {
  id: string; label: string; role: string; mask_pii: number; token_hash: string; created_at: number;
  expires_at: number; revoked_at: number | null; last_used_at: number | null; uses: number;
}

const isLocal = (c: Context<AppEnv>) => /^(localhost|127\.0\.0\.1)$/.test(new URL(c.req.url).hostname);
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const tokenHash = (token: string) => sha256(`admin-invite|${token}`);
export const newInviteToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// ───────────── the guest session ─────────────

/** Per-request memo: the guest (or null), and whether guestGate already ran (sub-routers repeat requireAdmin). */
const memo = new WeakMap<Request, { guest?: GuestSession | null; gated?: boolean }>();
const slot = (c: Context<AppEnv>) => { let m = memo.get(c.req.raw); if (!m) memo.set(c.req.raw, (m = {})); return m; };

async function setGuestCookie(c: Context<AppEnv>, inviteId: string, inviteExp: number) {
  const now = Date.now();
  const exp = Math.min(inviteExp, now + GUEST_IDLE_S * 1000);
  const token = await signToken(await getSecret(c.env), `guest.${inviteId}.${exp}.${now}`);
  setCookie(c, GUEST_COOKIE, token, { path: '/', httpOnly: true, secure: !isLocal(c), sameSite: 'Strict', maxAge: Math.max(1, Math.floor((exp - now) / 1000)) });
}

/** The guest behind this request, or null. Checks the signed cookie, then the invite (revoked or expired → null). */
export async function guestSession(c: Context<AppEnv>): Promise<GuestSession | null> {
  const m = slot(c);
  if (m.guest !== undefined) return m.guest;
  m.guest = null;
  const raw = getCookie(c, GUEST_COOKIE);
  if (!raw) return null;
  const payload = await verifyToken(await getSecret(c.env), raw);
  const [tag, id, exp, iat] = payload?.split('.') ?? [];
  const now = Date.now();
  if (tag !== 'guest' || !id || !(Number(exp) > now)) return null;
  const row = await c.env.DB.prepare('SELECT * FROM admin_invites WHERE id = ?').bind(id).first<InviteRow>().catch(() => null);
  if (!row || row.revoked_at || !(row.expires_at > now) || row.role !== 'viewer') return null;
  m.guest = { id: row.id, label: row.label, role: 'viewer', maskPii: !!row.mask_pii, expiresAt: row.expires_at };
  // Sliding: a guest who keeps using it stays in (never past the invite's expiry).
  if (now - Number(iat) > REFRESH_AFTER_MS) await setGuestCookie(c, row.id, row.expires_at);
  return m.guest;
}

// ───────────── what a guest may do ─────────────

/** Harmless writes a viewer may make (method + full path). Empty: every change is refused. */
export const GUEST_WRITE_ALLOW: { method: string; path: RegExp }[] = [];

/** GETs that act, cost money, export personal data or reveal a secret: refused for every guest. */
export const GUEST_DENY_GET: { path: RegExp; why: string }[] = [
  { path: /^\/admin\/api\/guest-access(\/|$)/, why: 'owner only: guest links' },
  { path: /^\/admin\/api\/google\/connect$/, why: 'starts the Google Drive OAuth (would change Integrations)' },
  { path: /^\/admin\/api\/live-events\/[^/]+\/start$/, why: 'mints a Zoom host start link' },
  { path: /\.csv$/i, why: 'CSV exports carry personal data' },
  { path: /^\/admin\/api\/(dataq|export)\/export|^\/admin\/api\/export\//, why: 'data exports' },
  { path: /^\/admin\/api\/voice\/assistant\.json$/, why: 'carries the voice webhook secret' },
  { path: /^\/admin\/api\/leads\/[^/]+\/preview-email$/, why: 'writes the email with the AI (costs money)' },
  { path: /^\/admin\/rooms\/[^/]+$/, why: 'joins a live room as the host' },
  { path: /^\/admin\/live\/[^/]+\/room$/, why: 'joins a live room as the host' },
];
/** Also refused when personal details are hidden: call recordings. */
const MASKED_DENY_GET: RegExp[] = [/^\/admin\/api\/voice\/elevenlabs\/audio\//];

export function guestDecision(method: string, path: string, maskPii: boolean): { ok: true } | { ok: false; status: number; error: string } {
  const m = method.toUpperCase();
  if (/^\/admin\/api\/guest-access(\/|$)/.test(path)) return { ok: false, status: 403, error: GUEST_COPY.ownerOnly };
  if (m === 'GET' || m === 'HEAD') {
    if (/^\/admin\/(rooms\/[^/]+|live\/[^/]+\/room)$/.test(path)) return { ok: false, status: 403, error: GUEST_COPY.hostOnly };
    if (GUEST_DENY_GET.some((d) => d.path.test(path)) || (maskPii && MASKED_DENY_GET.some((r) => r.test(path)))) return { ok: false, status: 403, error: GUEST_COPY.ownerOnly };
    return { ok: true };
  }
  if (m === 'OPTIONS') return { ok: true };
  if (GUEST_WRITE_ALLOW.some((a) => a.method === m && a.path.test(path))) return { ok: true };
  return { ok: false, status: 403, error: GUEST_COPY.readOnly };
}

// ───────────── the one response transform ─────────────

/** Every secret value this deployment knows (settings marked secret, plus the Worker's own secrets). */
function knownSecrets(c: Context<AppEnv>): string[] {
  const out = new Set<string>();
  const s = (c.get('settings') ?? {}) as Record<string, string>;
  for (const d of SETTINGS) if ('secret' in d && d.secret && s[d.key]) out.add(String(s[d.key]).trim());
  for (const [k, v] of Object.entries(c.env as unknown as Record<string, unknown>)) {
    if (typeof v !== 'string' || /PUBLIC|SITE_KEY/.test(k)) continue;
    if (/SECRET|TOKEN|PASSWORD|API_KEY|_KEY$|WEBHOOK_URL/.test(k)) out.add(v.trim());
  }
  return [...out].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
}

/** Known people's last names, so "Dana Quixley" in any prose becomes "Dana Q.". Cached per isolate for a minute. */
let namesCache: { at: number; names: MaskNames } | null = null;
async function knownNames(c: Context<AppEnv>): Promise<MaskNames> {
  if (namesCache && Date.now() - namesCache.at < 60_000) return namesCache.names;
  const names = emptyNames();
  try {
    const { results } = await c.env.DB.prepare("SELECT last_name FROM leads WHERE last_name IS NOT NULL AND last_name != '' ORDER BY created_at DESC LIMIT 20000").all<{ last_name: string }>();
    for (const r of results) { const l = r.last_name.trim().split(/\s+/).pop() ?? ''; if (l.length >= 3) names.last.add(l.toLowerCase()); }
  } catch { /* the leads table is always there; an error just means prose isn't name-scrubbed */ }
  namesCache = { at: Date.now(), names };
  return names;
}
/** Tests only. */
export function resetGuestCaches() { namesCache = null; }

async function transform(c: Context<AppEnv>, g: GuestSession) {
  const res = c.res;
  if (!res || res.status === 204 || res.status === 304 || !res.body) return;
  const ct = res.headers.get('content-type') ?? '';
  const isJson = /json/i.test(ct);
  const isText = /^text\/|xml|javascript/i.test(ct);
  if (!isJson && !isText) return; // audio, images, video: passed through (recordings are refused when details are hidden)
  const secrets = knownSecrets(c);
  const names = g.maskPii ? await knownNames(c) : emptyNames();
  const text = await res.text();
  let body = text;
  if (isJson) {
    try {
      let v = secretFieldsToSet(JSON.parse(text));
      if (g.maskPii) v = maskPii(v, { personalRoot: PERSONAL_PATHS.test(c.req.path.replace(/^\/admin\/api/, '')), known: names });
      body = JSON.stringify(v);
    } catch { body = g.maskPii ? maskText(text, names) : text; }
  } else if (g.maskPii) body = maskText(text, names);
  body = scrubSecrets(body, secrets);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-store');
  c.res = undefined as unknown as Response; // replace, don't merge (Hono would copy the old content-length over)
  c.res = new Response(body, { status: res.status, headers });
}

async function logRequest(c: Context<AppEnv>, g: GuestSession, status: number) {
  const ip = c.req.header('cf-connecting-ip');
  const ipHash = ip ? (await hmacHex(await getSecret(c.env), `guestip|${ip}`)).slice(0, 24) : null;
  const now = Date.now();
  const page = c.req.method === 'GET' && c.req.path === '/admin';
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO admin_invite_log (invite_id, at, method, path, status, ip_hash) VALUES (?, ?, ?, ?, ?, ?)').bind(g.id, now, c.req.method, c.req.path.slice(0, 300), status, ipHash),
    c.env.DB.prepare(`UPDATE admin_invites SET last_used_at = ?, uses = uses + ? WHERE id = ?`).bind(now, page ? 1 : 0, g.id),
  ]);
}
const background = (c: Context<AppEnv>, p: Promise<unknown>) => {
  const q = p.catch((e) => console.error('guest log failed', e instanceof Error ? e.message : 'error'));
  try { c.executionCtx.waitUntil(q); } catch { void q; }
};

/** Logs a guest's request to a read-only page outside requireAdmin (/materials). */
export function logGuestView(c: Context<AppEnv>, g: GuestSession, status: number) { background(c, logRequest(c, g, status)); }

/** Called by requireAdmin for a request that carries a valid guest session instead of the owner's. */
export async function guestGate(c: Context<AppEnv>, next: Next, g: GuestSession) {
  const m = slot(c);
  if (m.gated) { await next(); return; } // a sub-router's requireAdmin: the outer call already gates and transforms
  m.gated = true;
  const d = guestDecision(c.req.method, c.req.path, g.maskPii);
  if (!d.ok) {
    background(c, logRequest(c, g, d.status));
    c.header('cache-control', 'no-store');
    if (c.req.path.startsWith('/admin/api/')) return c.json({ ok: false, error: d.error, guest: true }, d.status as 403);
    return c.html(guestPage('Guest view', d.error, '/admin', 'Back to Funnel HQ'), d.status as 403);
  }
  await next();
  await transform(c, g);
  background(c, logRequest(c, g, c.res.status));
}

// ───────────── pages ─────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
export const GUEST_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/** A calm one-message page (invalid link, refused page, left). `refresh` sends the browser on (same-origin). */
export function guestPage(title: string, message: string, href: string | null, action: string | null, refresh = false) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">${refresh && href ? `<meta http-equiv="refresh" content="0;url=${esc(href)}">` : ''}<title>${esc(title)}</title>` +
    `<style>:root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--mut:#6e6e73;--link:#0f2c5c;--card:#fff}` +
    `@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--mut:#a1a1a6;--link:#9ab8ec;--card:#1c1c1e}}` +
    `body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}` +
    `main{max-width:420px;margin:24px 16px;padding:32px;background:var(--card);border-radius:16px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;color:var(--mut)}` +
    `a.btn{display:inline-block;padding:10px 18px;border-radius:999px;background:var(--link);color:#fff;text-decoration:none;font-weight:600}</style></head>` +
    `<body><main><h1>${esc(title)}</h1><p>${esc(message)}</p>${href && action ? `<a class="btn" href="${esc(href)}">${esc(action)}</a>` : ''}</main></body></html>`;
}

// ───────────── routes ─────────────

/** Public: /admin/invite/<token> (sign in through a link) and POST /admin/guest/leave (end just this guest session). */
export function mountGuestPublic(app: Hono<AppEnv>, sameOriginWrite: (c: Context<AppEnv>) => boolean) {
  app.get('/admin/invite/:token', async (c) => {
    c.header('content-security-policy', GUEST_PAGE_CSP);
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    if ((await hit(c.env, `rl:invite:${ip}`, REDEEM_WINDOW_MS)) > REDEEM_MAX) return c.html(guestPage('Guest link', GUEST_COPY.tooMany, null, null), 429);
    const token = c.req.param('token');
    const now = Date.now();
    let row: InviteRow | null = null;
    if (INVITE_TOKEN_RE.test(token)) {
      const h = await tokenHash(token);
      row = await c.env.DB.prepare('SELECT * FROM admin_invites WHERE token_hash = ?').bind(h).first<InviteRow>();
      if (row && !safeEqual(row.token_hash, h)) row = null;
    }
    if (!row || row.revoked_at || !(row.expires_at > now)) {
      deleteCookie(c, GUEST_COOKIE, { path: '/' });
      return c.html(guestPage('Guest link', GUEST_COPY.invalid, null, null), 401);
    }
    await setGuestCookie(c, row.id, row.expires_at);
    const ipHash = ip !== 'unknown' ? (await hmacHex(await getSecret(c.env), `guestip|${ip}`)).slice(0, 24) : null;
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE admin_invites SET uses = uses + 1, last_used_at = ? WHERE id = ?').bind(now, row.id),
      c.env.DB.prepare('INSERT INTO admin_invite_log (invite_id, at, method, path, status, ip_hash) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, now, 'GET', '/admin/invite/…', 200, ipHash),
    ]);
    // A page, not a redirect: the cookie is SameSite=Strict, and a link opened from email or chat is a cross-site
    // navigation, so a redirect straight to /admin would arrive without it. The refresh below starts on our page.
    return c.html(guestPage('Funnel HQ', GUEST_COPY.welcome, '/admin', 'Open Funnel HQ', true));
  });
  app.post('/admin/guest/leave', async (c) => {
    if (!sameOriginWrite(c)) return c.text('Forbidden', 403);
    deleteCookie(c, GUEST_COOKIE, { path: '/' });
    c.header('content-security-policy', GUEST_PAGE_CSP);
    return c.html(guestPage('Guest view', GUEST_COPY.left, null, null));
  });
}

const inviteView = (r: InviteRow, now = Date.now()) => ({
  id: r.id, label: r.label, role: r.role, maskPii: !!r.mask_pii, createdAt: r.created_at, expiresAt: r.expires_at,
  revokedAt: r.revoked_at, lastUsedAt: r.last_used_at, uses: r.uses,
  state: r.revoked_at ? 'revoked' : r.expires_at <= now ? 'expired' : 'active',
});

/** Funnel HQ APIs (on the admin router, behind requireAdmin): who am I, and the owner's Guest access page. */
export function mountGuestAdmin(admin: Hono<AppEnv>) {
  admin.get('/whoami', async (c) => {
    const g = await guestSession(c);
    const by = c.get('settings')?.SITE_NAME || BRAND.name;
    if (g) return c.json({ role: 'viewer', guest: true, label: g.label, maskPii: g.maskPii, expiresAt: g.expiresAt, sharedBy: by });
    return c.json({ role: 'owner', guest: false, sharedBy: by });
  });

  admin.get('/guest-access', async (c) => {
    const now = Date.now();
    const { results } = await c.env.DB.prepare('SELECT * FROM admin_invites ORDER BY (revoked_at IS NULL AND expires_at > ?) DESC, created_at DESC LIMIT 100').bind(now).all<InviteRow>();
    return c.json({ invites: results.map((r) => inviteView(r, now)), maxDays: INVITE_MAX_DAYS, roles: INVITE_ROLES });
  });

  admin.get('/guest-access/:id/log', async (c) => {
    const { results } = await c.env.DB.prepare('SELECT at, method, path, status FROM admin_invite_log WHERE invite_id = ? ORDER BY at DESC LIMIT 200').bind(c.req.param('id')).all();
    return c.json({ log: results });
  });

  admin.post('/guest-access', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { label?: unknown; role?: unknown; days?: unknown; maskPii?: unknown };
    const label = String(b.label ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!label) return c.json({ ok: false, error: 'Add who the link is for.' }, 400);
    const role = String(b.role ?? 'viewer');
    if (!(INVITE_ROLES as readonly string[]).includes(role)) return c.json({ ok: false, error: 'Guest links are view-only for now.' }, 400);
    const days = Number(b.days);
    if (!Number.isFinite(days) || days <= 0 || days > INVITE_MAX_DAYS) return c.json({ ok: false, error: `Pick an expiry between 1 hour and ${INVITE_MAX_DAYS} days.` }, 400);
    const now = Date.now();
    const token = newInviteToken();
    const row: InviteRow = {
      id: newId('inv_'), label, role, mask_pii: b.maskPii === false ? 0 : 1, token_hash: await tokenHash(token),
      created_at: now, expires_at: now + Math.max(3_600_000, Math.round(days * 86_400_000)), revoked_at: null, last_used_at: null, uses: 0,
    };
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO admin_invites (id, label, role, mask_pii, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(row.id, row.label, row.role, row.mask_pii, row.token_hash, row.created_at, row.expires_at),
      // Keep the access log to 180 days.
      c.env.DB.prepare('DELETE FROM admin_invite_log WHERE at < ?').bind(now - 180 * 86_400_000),
    ]);
    // The link is returned once, here. Only its hash is kept.
    return c.json({ ok: true, invite: inviteView(row, now), url: `${new URL(c.req.url).origin}/admin/invite/${token}` });
  });

  admin.post('/guest-access/:id/revoke', async (c) => {
    const r = await c.env.DB.prepare('UPDATE admin_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(Date.now(), c.req.param('id')).run();
    return c.json({ ok: true, revoked: (r.meta?.changes ?? 0) > 0 });
  });
}
