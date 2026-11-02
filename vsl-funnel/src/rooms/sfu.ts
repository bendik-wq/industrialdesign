/**
 * Cloudflare Realtime from the server side. The app secret and the TURN token are settings (REALTIME_*), used
 * only here, and nothing returned to a browser ever contains them.
 *  - SFU: https://rtc.live.cloudflare.com/v1/apps/{appId}/sessions/new | sessions/{id}/tracks/new |
 *    sessions/{id}/renegotiate (PUT) | sessions/{id}/tracks/close (PUT) | sessions/{id}/tracks/update (PUT).
 *  - TURN: POST https://rtc.live.cloudflare.com/v1/turn/keys/{keyId}/credentials/generate-ice-servers {ttl}.
 */

export const SFU_BASE = 'https://rtc.live.cloudflare.com/v1';
type S = Partial<Record<string, string>>;

export function realtimeSetup(s: S) {
  const sfu = Boolean(s.REALTIME_APP_ID?.trim() && s.REALTIME_APP_SECRET?.trim());
  const turn = Boolean(s.REALTIME_TURN_KEY_ID?.trim() && s.REALTIME_TURN_TOKEN?.trim());
  const todo: string[] = [];
  if (!sfu) todo.push('Add the Cloudflare Realtime SFU app ID and secret under Integrations → Live (Rooms). Rooms can’t carry video without them.');
  if (!turn) todo.push('Add the Realtime TURN key ID and token under Integrations → Live (Rooms), so people on office and hotel networks can connect.');
  return { ready: sfu, sfu, turn, todo };
}

export class SfuError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

/** Calls the SFU. Returns the parsed JSON; throws SfuError with the SFU's own error text (never the secret). */
export async function sfuCall(s: S, method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, f: typeof fetch = fetch) {
  const appId = s.REALTIME_APP_ID?.trim();
  const secret = s.REALTIME_APP_SECRET?.trim();
  if (!appId || !secret) throw new SfuError('Rooms aren’t connected yet (Realtime app ID and secret).', 503);
  if (!/^[A-Za-z0-9/_-]+$/.test(path)) throw new SfuError('Bad path', 400);
  const res = await f(`${SFU_BASE}/apps/${encodeURIComponent(appId)}/${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { /* not JSON */ }
  if (!res.ok) throw new SfuError(String(json.errorDescription ?? json.errorCode ?? `SFU ${res.status}`).replace(secret, '').slice(0, 200), res.status >= 500 ? 502 : 400);
  if (json.errorCode) throw new SfuError(String(json.errorDescription ?? json.errorCode).slice(0, 200), 400);
  return json;
}

/** Short-lived ICE servers for one participant (STUN + TURN over UDP, TCP and TLS on 443). Port 53 is dropped: browsers block it. */
export async function mintIceServers(s: S, ttlSec = 4 * 3600, f: typeof fetch = fetch) {
  const keyId = s.REALTIME_TURN_KEY_ID?.trim();
  const token = s.REALTIME_TURN_TOKEN?.trim();
  if (!keyId || !token) return { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: false };
  const res = await f(`${SFU_BASE}/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ttl: ttlSec }),
  });
  if (!res.ok) throw new SfuError(`TURN credentials failed (${res.status})`, 502);
  const j = (await res.json()) as { iceServers?: { urls: string | string[]; username?: string; credential?: string }[] };
  const servers = (j.iceServers ?? []).map((sv) => ({ ...sv, urls: (Array.isArray(sv.urls) ? sv.urls : [sv.urls]).filter((u) => !/:53(\?|$)/.test(u)) })).filter((sv) => sv.urls.length);
  return { iceServers: servers, turn: true };
}
