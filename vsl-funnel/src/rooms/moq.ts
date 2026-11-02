import { hmacHex } from '../lib/crypto';

/**
 * Big webinars over Cloudflare MoQ (Media over QUIC, IETF moq-transport draft-16 on Cloudflare's relay).
 *
 * Hosts and people on stage stay on the Realtime SFU exactly as before. The host's browser composites the stage
 * (the same 1280x720 canvas and mixed audio the recorder builds), encodes it with WebCodecs and publishes it as
 * one broadcast per room to the relay; viewers subscribe to it, decode with WebCodecs and render to a canvas.
 * Cloudflare has no SFU→MoQ bridge (the relay only carries what a MoQ publisher sends), so the host's browser is
 * the publisher. Everything else (chat, Q&A, polls, hands, the offer, presence and minutes) stays on the room's
 * WebSocket for every viewer, whichever way their media arrives.
 *
 * Tokens (JWTs Cloudflare mints per relay, passed in the URL path on draft-16):
 *  - MOQ_PUBLISH_TOKEN (publish + subscribe) reaches only the host's signed-in browser (admin session + host ticket);
 *  - MOQ_SUBSCRIBE_TOKEN reaches a viewer only while they hold a valid room ticket, may see the stage and are
 *    routed to MoQ. Neither is ever embedded in a page.
 * Both tokens cover the whole relay, so each room's broadcast name is an HMAC of the room id under the app
 * secret: knowing a token is not enough to find a room's stream.
 */

export const MOQ_DEFAULT_RELAY = 'https://draft-16.cloudflare.mediaoverquic.com';
export type BroadcastMode = 'auto' | 'sfu' | 'moq';
export const BROADCAST_MODES: BroadcastMode[] = ['auto', 'sfu', 'moq'];
export const MOQ_AUTO_AUDIENCE = 25;
type S = Partial<Record<string, string>>;

export const parseMode = (v: unknown): BroadcastMode | null => (typeof v === 'string' && (BROADCAST_MODES as string[]).includes(v.trim().toLowerCase()) ? (v.trim().toLowerCase() as BroadcastMode) : null);

/** The relay's base URL (https, no trailing slash); a bad value falls back to Cloudflare's draft-16 relay. */
export function relayUrl(s: S) {
  const raw = s.MOQ_RELAY_URL?.trim();
  if (!raw) return MOQ_DEFAULT_RELAY;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.search || u.hash) return MOQ_DEFAULT_RELAY;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return MOQ_DEFAULT_RELAY; }
}

/** What a relay JWT allows (read from its payload; the relay checks the signature). */
export function tokenInfo(token: string | undefined, now = Date.now()) {
  const t = token?.trim();
  if (!t || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t)) return null;
  try {
    const json = atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'));
    const p = JSON.parse(json) as { exp?: number; operations?: unknown };
    const ops = Array.isArray(p.operations) ? p.operations.filter((x): x is string => typeof x === 'string') : [];
    const exp = typeof p.exp === 'number' ? p.exp * 1000 : null;
    return { publish: ops.includes('publish'), subscribe: ops.includes('subscribe'), exp, expired: exp !== null && exp <= now };
  } catch { return null; }
}

/** Whether MoQ is usable, and what the owner still has to set (for Funnel HQ). */
export function moqSetup(s: S, now = Date.now()) {
  const pub = tokenInfo(s.MOQ_PUBLISH_TOKEN, now);
  const sub = tokenInfo(s.MOQ_SUBSCRIBE_TOKEN, now);
  const todo: string[] = [];
  if (!pub) todo.push('Optional, for big webinars: add the MoQ relay’s publish token (Integrations → Live). Until then every viewer watches over the SFU.');
  else if (!pub.publish) todo.push('The MoQ publish token can’t publish. Paste the relay’s publish and subscribe token.');
  else if (pub.expired) todo.push('The MoQ publish token has expired. Create a new one for the relay.');
  if (!sub) { if (pub) todo.push('Add the MoQ relay’s subscribe-only token too (Integrations → Live).'); }
  else if (!sub.subscribe) todo.push('The MoQ subscribe token can’t subscribe. Paste the relay’s subscribe-only token.');
  else if (sub.expired) todo.push('The MoQ subscribe token has expired. Create a new one for the relay.');
  const ready = Boolean(pub?.publish && !pub.expired && sub?.subscribe && !sub.expired);
  return { ready, relay: relayUrl(s), expires: ready ? Math.min(pub!.exp ?? Infinity, sub!.exp ?? Infinity) : null, todo };
}

/** The mode for one room: its own override (Funnel HQ), else ROOM_BROADCAST, else auto. */
export const broadcastMode = (s: S, override?: string | null): BroadcastMode => parseMode(override) ?? parseMode(s.ROOM_BROADCAST) ?? 'auto';
export function audienceThreshold(s: S) {
  const n = Math.round(Number(s.ROOM_MOQ_AUDIENCE));
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : MOQ_AUTO_AUDIENCE;
}

/** The room's broadcast name on the relay: unguessable without the app secret, stable for the room. */
export async function broadcastName(secret: string, roomId: string) {
  return `gl/${(await hmacHex(secret, `moq-broadcast:${roomId}`)).slice(0, 40)}`;
}

/** The URL a browser connects to (draft-16 takes the token as the path). */
export const connectUrl = (relay: string, token: string) => `${relay}/${token.trim()}`;
