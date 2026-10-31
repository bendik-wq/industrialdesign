import type { Runtime } from '../app';

/**
 * Zoom through a Server-to-Server OAuth app (marketplace.zoom.us → Develop → Build app → Server-to-Server OAuth).
 *  - token:   POST https://zoom.us/oauth/token  grant_type=account_credentials&account_id=…  (Basic client_id:client_secret), ~1 hour, no refresh token
 *  - meeting: POST https://api.zoom.us/v2/users/{userId}/meetings   (type 2 = scheduled; meeting:write:meeting[:admin])
 *  - webinar: POST https://api.zoom.us/v2/users/{userId}/webinars   (type 5; needs the Webinar add-on; webinar:write:webinar[:admin])
 *  - fresh host link: GET /meetings/{id} or /webinars/{id} → start_url (start_url expires two hours after it is issued)
 * Errors come back as { code, message }; code 200 on a webinar call means "Webinar plan is missing" or "No permission".
 */

export const ZOOM_TOKEN_URL = 'https://zoom.us/oauth/token';
export const ZOOM_API = 'https://api.zoom.us/v2';

/** Scopes the owner adds to the app (granular names; the classic meeting:write:admin also works). */
export const ZOOM_SCOPES = {
  required: ['meeting:write:meeting:admin', 'meeting:read:meeting:admin'],
  webinar: ['webinar:write:webinar:admin', 'webinar:read:webinar:admin', 'webinar:read:list_webinars:admin'],
};

export const ZOOM_STEPS = [
  'In Zoom, open marketplace.zoom.us, then Develop, then Build app, and choose Server-to-Server OAuth app.',
  `Under Scopes add ${ZOOM_SCOPES.required.join(' and ')}. If your account has Zoom Webinars, add ${ZOOM_SCOPES.webinar.join(', ')} too.`,
  'Activate the app, then copy the Account ID, Client ID and Client secret.',
  'Paste them into Funnel HQ → Integrations → Live (Zoom account ID, Zoom client ID, Zoom client secret) and press Check on the Zoom card.',
];

export class ZoomError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null = null) { super(message); }
}

export const zoomConfigured = (s: Runtime['settings']) => Boolean(s.ZOOM_ACCOUNT_ID && s.ZOOM_CLIENT_ID && s.ZOOM_CLIENT_SECRET);
const hostUser = (s: Runtime['settings']) => encodeURIComponent((s.ZOOM_HOST_USER || '').trim() || 'me');

let tokenCache: { k: string; token: string; scope: string; exp: number } | null = null;
/** For tests. */
export const resetZoomToken = () => { tokenCache = null; };

export async function zoomToken(rt: Runtime): Promise<{ token: string; scope: string }> {
  const s = rt.settings;
  if (!zoomConfigured(s)) throw new ZoomError('Zoom isn’t connected: add the account ID, client ID and client secret under Integrations → Live.', 0);
  const k = `${s.ZOOM_ACCOUNT_ID}|${s.ZOOM_CLIENT_ID}|${s.ZOOM_CLIENT_SECRET.slice(-6)}`;
  if (tokenCache && tokenCache.k === k && tokenCache.exp > Date.now() + 60_000) return tokenCache;
  const res = await fetch(ZOOM_TOKEN_URL, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${s.ZOOM_CLIENT_ID}:${s.ZOOM_CLIENT_SECRET}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'account_credentials', account_id: s.ZOOM_ACCOUNT_ID }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; expires_in?: number; reason?: string; error?: string };
  if (!res.ok || !j.access_token) {
    const why = j.reason || j.error || `HTTP ${res.status}`;
    const hint = /client|credential|unauthori/i.test(why) ? ' Check the client ID and secret.' : /account/i.test(why) ? ' Check the account ID, and that the app is activated.' : '';
    throw new ZoomError(`Zoom refused the credentials: ${why}.${hint}`, res.status);
  }
  tokenCache = { k, token: j.access_token, scope: j.scope ?? '', exp: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return tokenCache;
}

async function zoomApi<T>(rt: Runtime, method: string, path: string, body?: unknown): Promise<T> {
  const { token } = await zoomToken(rt);
  const res = await fetch(`${ZOOM_API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {} as T;
  const j = (await res.json().catch(() => ({}))) as T & { code?: number; message?: string };
  if (!res.ok) throw new ZoomError(j.message || `Zoom answered HTTP ${res.status}`, res.status, typeof j.code === 'number' ? j.code : null);
  return j;
}

/** Granular (meeting:write:meeting:admin) or classic (meeting:write:admin) scope names both count. */
export const hasScope = (scope: string, prefix: string) => scope.split(/\s+/).some((x) => x === prefix || x.startsWith(`${prefix}:`));

/** Zoom wants yyyy-MM-ddTHH:mm:ssZ (GMT), no milliseconds. */
export const zoomTime = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

export interface ZoomEvent { id: string; kind: 'meeting' | 'webinar'; joinUrl: string; startUrl: string | null; password: string | null }

interface ZoomCreated { id?: number | string; join_url?: string; start_url?: string; password?: string }

/** Is this error Zoom saying the account has no Webinar add-on (or this user can't host webinars)? */
const noWebinarPlan = (e: unknown) => e instanceof ZoomError && (e.code === 200 || e.status === 403 || /webinar plan|no permission/i.test(e.message));

/**
 * Creates the Zoom event: a Zoom Webinar when the app has the webinar scope and the account has the add-on
 * (attendees are view-only, the host and panelists present), otherwise a meeting with everyone muted on entry.
 */
export async function createZoomEvent(rt: Runtime, ev: { title: string; startsAt: number; durationMin: number; agenda?: string | null }): Promise<ZoomEvent> {
  const { scope } = await zoomToken(rt);
  const user = hostUser(rt.settings);
  const base = { topic: ev.title.slice(0, 200), start_time: zoomTime(ev.startsAt), duration: Math.max(15, Math.min(600, Math.round(ev.durationMin))), timezone: 'UTC', ...(ev.agenda ? { agenda: ev.agenda.slice(0, 2000) } : {}) };
  const done = (kind: ZoomEvent['kind'], r: ZoomCreated): ZoomEvent => {
    if (!r.id || !r.join_url) throw new ZoomError('Zoom created the event but sent no join link back.', 502);
    return { id: String(r.id), kind, joinUrl: r.join_url, startUrl: r.start_url ?? null, password: r.password ?? null };
  };
  if (hasScope(scope, 'webinar:write')) {
    try {
      return done('webinar', await zoomApi<ZoomCreated>(rt, 'POST', `/users/${user}/webinars`, {
        ...base, type: 5, settings: { host_video: true, panelists_video: true, approval_type: 2, practice_session: false, auto_recording: 'none' },
      }));
    } catch (e) {
      if (!noWebinarPlan(e)) throw e; // a real error, not "no webinar add-on": say so
    }
  }
  return done('meeting', await zoomApi<ZoomCreated>(rt, 'POST', `/users/${user}/meetings`, {
    ...base, type: 2, settings: { host_video: true, participant_video: false, join_before_host: false, mute_upon_entry: true, waiting_room: false, approval_type: 2, auto_recording: 'none' },
  }));
}

/** A fresh host start link (Zoom expires start_url two hours after issuing it). */
export async function freshStartUrl(rt: Runtime, kind: string, id: string): Promise<string | null> {
  const r = await zoomApi<{ start_url?: string }>(rt, 'GET', `/${kind === 'webinar' ? 'webinars' : 'meetings'}/${encodeURIComponent(id)}`);
  return r.start_url ?? null;
}

export interface ZoomCheck { configured: boolean; ready: boolean; reason: string | null; canCreate: boolean; canRefreshHostLink: boolean; webinars: boolean | null; scopes: string[]; steps: string[] }

/** Funnel HQ → Integrations → Zoom → Check: the token, its scopes, and whether webinars are available. */
export async function zoomCheck(rt: Runtime): Promise<ZoomCheck> {
  const out: ZoomCheck = { configured: zoomConfigured(rt.settings), ready: false, reason: null, canCreate: false, canRefreshHostLink: false, webinars: null, scopes: [], steps: ZOOM_STEPS };
  if (!out.configured) { out.reason = 'Zoom API not connected. Events still run: paste a Zoom link per event in its host console.'; return out; }
  try {
    resetZoomToken();
    const { scope } = await zoomToken(rt);
    out.scopes = scope.split(/\s+/).filter(Boolean);
    out.canCreate = hasScope(scope, 'meeting:write');
    out.canRefreshHostLink = hasScope(scope, 'meeting:read');
    if (hasScope(scope, 'webinar:read')) {
      try { await zoomApi(rt, 'GET', `/users/${hostUser(rt.settings)}/webinars?page_size=1`); out.webinars = true; } catch (e) { if (noWebinarPlan(e)) out.webinars = false; else throw e; }
    }
    out.ready = out.canCreate;
    out.reason = out.canCreate ? null : `The Zoom app needs the ${ZOOM_SCOPES.required[0]} scope to create meetings.`;
  } catch (e) {
    out.reason = e instanceof Error ? e.message : 'Zoom didn’t answer';
  }
  return out;
}
