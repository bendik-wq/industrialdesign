import { SfuError, sfuCall } from './sfu';
import { type RoomState, type TrackKind, type TrackRef, LIMITS, addTracks, canPublish, canPull, claimSession, ownsSession, removeTracks, validTrackName } from './state';

/**
 * The SFU proxy, run inside the room's Durable Object so every call is checked against the room's live state:
 *  - a session belongs to the participant who created it (later calls must name a session they own);
 *  - publishing needs permission now (meeting, host, co-host, or on stage), and track names carry the publisher's id;
 *  - pulling is limited to tracks currently published by someone visible, once the viewer may see the stage.
 * The browser never sees the app secret: it calls /api/rooms/:id/sfu/:op with its room ticket.
 */

export type SfuOp = 'session' | 'tracks' | 'renegotiate' | 'close' | 'update';
export const SFU_OPS: SfuOp[] = ['session', 'tracks', 'renegotiate', 'close', 'update'];
type S = Partial<Record<string, string>>;
const KINDS: TrackKind[] = ['audio', 'video', 'screen', 'screenaudio'];
const RIDS = ['f', 'h', 'q'];

export interface ProxyResult { status: number; body: Record<string, unknown>; changed: boolean }
const err = (status: number, error: string): ProxyResult => ({ status, body: { ok: false, error }, changed: false });

const sdp = (v: unknown) => {
  if (!v || typeof v !== 'object') return null;
  const d = v as { type?: unknown; sdp?: unknown };
  return (d.type === 'offer' || d.type === 'answer') && typeof d.sdp === 'string' && d.sdp.length < 200_000 ? { type: d.type, sdp: d.sdp } : null;
};
const simulcast = (v: unknown) => {
  const rid = v && typeof v === 'object' ? (v as { preferredRid?: unknown }).preferredRid : null;
  return typeof rid === 'string' && RIDS.includes(rid) ? { preferredRid: rid, priorityOrdering: 'asciibetical', ridNotAvailable: 'asciibetical' } : undefined;
};

export async function sfuProxy(st: RoomState, memberId: string, op: SfuOp, body: Record<string, unknown>, s: S, f: typeof fetch = fetch): Promise<ProxyResult> {
  const me = st.members[memberId];
  if (!me || me.connected === 0) return err(403, 'Join the room first.');
  try {
    if (op === 'session') {
      const r = await sfuCall(s, 'POST', 'sessions/new', undefined, f);
      const sessionId = String(r.sessionId ?? '');
      if (!claimSession(st, memberId, sessionId)) return err(502, 'The media server didn’t answer.');
      return { status: 200, body: { ok: true, sessionId }, changed: true };
    }
    const sessionId = body.sessionId;
    if (!ownsSession(st, memberId, sessionId)) return err(403, 'That media session isn’t yours.');
    const path = `sessions/${sessionId as string}`;

    if (op === 'tracks') {
      const tracks = Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]).slice(0, 8) : [];
      if (!tracks.length) return err(400, 'No tracks');
      const local = tracks.every((t) => t.location === 'local');
      const remote = tracks.every((t) => t.location === 'remote');
      if (!local && !remote) return err(400, 'Publish and subscribe in separate calls.');
      if (local) {
        if (!canPublish(st, me)) return err(403, 'Only people on stage can turn on a camera or mic.');
        if (st.mode === 'meeting' && !me.tracks.length) {
          const onCamera = Object.values(st.members).filter((m) => m.connected > 0 && m.tracks.length > 0 && m.id !== memberId).length;
          if (onCamera >= LIMITS.meetingOnCamera) return err(409, `This meeting already has ${LIMITS.meetingOnCamera} people on camera.`);
        }
        const offer = sdp(body.sessionDescription);
        if (!offer || offer.type !== 'offer') return err(400, 'Missing offer');
        for (const t of tracks) {
          if (!validTrackName(memberId, t.trackName) || !KINDS.includes(t.media as TrackKind) || (t.mid != null && typeof t.mid !== 'string')) return err(400, 'Bad track');
        }
        const r = await sfuCall(s, 'POST', `${path}/tracks/new`, { sessionDescription: offer, tracks: tracks.map((t) => ({ location: 'local', mid: t.mid, trackName: t.trackName })) }, f);
        const out = (r.tracks as { trackName?: string; mid?: string; errorCode?: string }[] | undefined) ?? [];
        const ok: TrackRef[] = tracks
          .filter((t) => out.some((o) => o.trackName === t.trackName && !o.errorCode))
          .map((t) => ({ trackName: t.trackName as string, kind: t.media as TrackKind, mid: out.find((o) => o.trackName === t.trackName)?.mid ?? (t.mid as string | null) ?? null, simulcast: t.simulcast === true }));
        addTracks(st, memberId, ok);
        return { status: 200, body: { ok: true, ...r }, changed: ok.length > 0 };
      }
      for (const t of tracks) if (!canPull(st, memberId, { sessionId: t.sessionId, trackName: t.trackName })) return err(403, 'That track isn’t on stage.');
      const r = await sfuCall(s, 'POST', `${path}/tracks/new`, {
        tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName, ...(simulcast(t.simulcast) ? { simulcast: simulcast(t.simulcast) } : {}) })),
      }, f);
      return { status: 200, body: { ok: true, ...r }, changed: false };
    }

    if (op === 'renegotiate') {
      const answer = sdp(body.sessionDescription);
      if (!answer || answer.type !== 'answer') return err(400, 'Missing answer');
      const r = await sfuCall(s, 'PUT', `${path}/renegotiate`, { sessionDescription: answer }, f);
      return { status: 200, body: { ok: true, ...r }, changed: false };
    }

    if (op === 'close') {
      const mids = (Array.isArray(body.tracks) ? (body.tracks as { mid?: unknown }[]) : []).map((t) => t.mid).filter((m): m is string => typeof m === 'string').slice(0, 16);
      if (!mids.length) return err(400, 'No tracks');
      const offer = sdp(body.sessionDescription);
      const r = await sfuCall(s, 'PUT', `${path}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), ...(offer ? { sessionDescription: offer, force: false } : { force: true }) }, f);
      const mine = me.tracks.filter((t) => t.mid && mids.includes(t.mid)).map((t) => t.trackName);
      removeTracks(st, memberId, mine);
      return { status: 200, body: { ok: true, ...r }, changed: mine.length > 0 };
    }

    // update: switch the simulcast layer of a track this person already pulls (lower layers for thumbnails).
    const tracks = (Array.isArray(body.tracks) ? (body.tracks as Record<string, unknown>[]) : []).slice(0, 12);
    if (!tracks.length) return err(400, 'No tracks');
    for (const t of tracks) {
      if (typeof t.mid !== 'string' || !simulcast(t.simulcast) || !canPull(st, memberId, { sessionId: t.sessionId, trackName: t.trackName })) return err(403, 'That track isn’t on stage.');
    }
    const r = await sfuCall(s, 'PUT', `${path}/tracks/update`, { tracks: tracks.map((t) => ({ location: 'remote', sessionId: t.sessionId, trackName: t.trackName, mid: t.mid, simulcast: simulcast(t.simulcast) })) }, f);
    return { status: 200, body: { ok: true, ...r }, changed: false };
  } catch (e) {
    if (e instanceof SfuError) return err(e.status, e.message);
    return err(502, 'The media server didn’t answer. Try again.');
  }
}

/** Force-closes someone's published tracks on the SFU (sent back to the audience, or removed from the room). */
export async function forceClose(s: S, sessionId: string | null, mids: string[], f: typeof fetch = fetch) {
  if (!sessionId || !mids.length) return false;
  await sfuCall(s, 'PUT', `sessions/${sessionId}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true }, f).catch(() => null);
  return true;
}
