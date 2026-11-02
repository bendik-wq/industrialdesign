import type { Env } from '../env';
import type { Runtime } from '../app';
import { loadSettings } from '../settings';
import { type Effect, type Identity, type Member, type MoqState, type RoomMode, type RoomState, apply, broadcastLive, broadcastView, canSeeStage, configureMoq, connectedCount, isStaff, join, leave, mediaPath, newMoqState, newRoomState, prune, shouldPublishMoq, view } from './state';
import { broadcastName, connectUrl, relayUrl } from './moq';
import { getSecret } from '../lib/secret';
import { type SfuOp, SFU_OPS, forceClose, sfuProxy } from './proxy';
import { feedPresence, getRoom, markRoom, roomOffer, setRoomOffer } from './rooms';

/**
 * One Durable Object per room: signalling and state over WebSockets with hibernation (the object sleeps between
 * messages; sockets stay open), the SFU proxy, and a once-a-minute alarm that feeds presence and minutes into D1
 * while anyone is connected. The Worker authenticates every request (room ticket) and passes the identity in
 * x-room-who; the object is only reachable through the Worker.
 */

const ALARM_MS = 60_000;
interface Meta { id: string; mode: RoomMode; title: string; startsAt: number | null; offerAvailable: boolean; origin: string; moq?: { mode: MoqState['mode']; ready: boolean; minAudience: number } }

export class RoomDO {
  private st: RoomState | null = null;
  private meta: Meta | null = null;
  /** Whether the last state everyone received had the MoQ broadcast live (the alarm re-sends when it lapses). */
  private sentLive = false;

  constructor(private ctx: DurableObjectState, private env: Env) {
    void ctx.blockConcurrencyWhile(async () => {
      this.st = (await ctx.storage.get<RoomState>('st')) ?? null;
      this.meta = (await ctx.storage.get<Meta>('meta')) ?? null;
    });
  }

  private async runtime(): Promise<Runtime> {
    const settings = await loadSettings(this.env);
    return { env: this.env, settings, reps: [], origin: this.meta?.origin ?? 'https://example.com', waitUntil: (p) => this.ctx.waitUntil(p.catch((e) => console.error('room background', e))) };
  }
  private async save() { if (this.st) await this.ctx.storage.put('st', this.st); }

  private async ensureState(meta: Meta) {
    if (!this.meta || this.meta.origin !== meta.origin || this.meta.title !== meta.title || this.meta.startsAt !== meta.startsAt) {
      this.meta = meta;
      await this.ctx.storage.put('meta', meta);
    }
    if (!this.st) {
      this.st = newRoomState({ id: meta.id, mode: meta.mode, title: meta.title, startsAt: meta.startsAt, offerAvailable: meta.offerAvailable });
      const rt = await this.runtime();
      const row = await getRoom(rt, meta.id);
      if (row?.status === 'ended') { this.st.status = 'ended'; this.st.endedAt = row.ended_at; }
      if (row?.status === 'live' && meta.mode === 'webinar') { this.st.status = 'live'; this.st.wentLiveAt = row.went_live_at; }
      if (meta.offerAvailable) this.st.offer = await roomOffer(rt, { ref_type: row?.ref_type ?? 'none', ref_id: row?.ref_id ?? null }).catch(() => this.st!.offer);
    }
    this.st.title = meta.title;
    this.st.startsAt = meta.startsAt;
    this.st.moq ??= newMoqState();
    return this.st;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    let who: Identity, meta: Meta;
    try {
      who = JSON.parse(req.headers.get('x-room-who') ?? '') as Identity;
      meta = JSON.parse(req.headers.get('x-room-meta') ?? '') as Meta;
    } catch { return new Response('bad request', { status: 400 }); }
    const st = await this.ensureState(meta);
    const now = Date.now();
    // MoQ config (settings and the Funnel HQ override) arrives with every request.
    const reconfigured = meta.moq ? configureMoq(st, meta.moq) : false;

    if (url.pathname === '/ws') {
      if (req.headers.get('upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      const r = join(st, who, now);
      this.ctx.acceptWebSocket(server, [who.id]);
      server.serializeAttachment({ id: who.id });
      if (!r.ok) {
        server.send(JSON.stringify({ t: 'refused', reason: r.error }));
        server.close(4003, r.error);
        return new Response(null, { status: 101, webSocket: client });
      }
      this.reconcile();
      await this.save();
      server.send(JSON.stringify(view(st, r.member, now, { chat: true })));
      this.broadcast(now, who.id);
      await this.feed([r.member], now);
      // A meeting is live from its first join (webinars wait for the host's Go live).
      if (st.mode === 'meeting' && connectedCount(st) === 1) await markRoom(await this.runtime(), st.id, 'live', {}, now).catch(() => null);
      if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now + ALARM_MS);
      return new Response(null, { status: 101, webSocket: client });
    }

    const m = /^\/sfu\/([a-z]+)$/.exec(url.pathname);
    if (m && SFU_OPS.includes(m[1] as SfuOp) && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const rt = await this.runtime();
      const r = await sfuProxy(st, who.id, m[1] as SfuOp, body, rt.settings);
      if (r.changed) { await this.save(); this.broadcast(Date.now()); }
      return Response.json(r.body, { status: r.status });
    }

    if (reconfigured) { await this.save(); this.broadcast(now); }

    if (url.pathname === '/moq' && req.method === 'POST') return this.moqAccess(st, who, req.headers.get('x-room-admin') === '1', now);

    if (url.pathname === '/info' || url.pathname === '/config') {
      return Response.json({ status: st.status, count: connectedCount(st), peak: st.peak, stage: Object.values(st.members).filter((x) => x.connected && (x.stage || isStaff(x))).length, broadcast: st.mode === 'webinar' ? broadcastView(st, now) : null });
    }
    return new Response('not found', { status: 404 });
  }

  /**
   * The relay URL and token for one browser. The publish token only for the host on an admin session while the
   * room should publish; the subscribe token only for a viewer the room is routing to MoQ (so: the stage is live).
   */
  private async moqAccess(st: RoomState, who: Identity, admin: boolean, now: number) {
    const me = st.members[who.id];
    const deny = (error: string) => Response.json({ ok: false, error }, { status: 403 });
    if (!me || me.connected === 0) return deny('Join the room first.');
    const rt = await this.runtime();
    const s = rt.settings as unknown as Record<string, string | undefined>;
    const relay = relayUrl(s);
    const name = await broadcastName(await getSecret(this.env), st.id);
    if (me.role === 'host') {
      if (!admin || who.role !== 'host') return deny('forbidden');
      if (!shouldPublishMoq(st, me)) return deny('not_publishing');
      const token = s.MOQ_PUBLISH_TOKEN?.trim();
      if (!token) return deny('not_configured');
      return Response.json({ ok: true, url: connectUrl(relay, token), name, role: 'publish' }, { headers: { 'cache-control': 'no-store' } });
    }
    if (!canSeeStage(st, me) || mediaPath(st, me, now) !== 'moq') return deny('not_routed');
    const token = s.MOQ_SUBSCRIBE_TOKEN?.trim();
    if (!token) return deny('not_configured');
    return Response.json({ ok: true, url: connectUrl(relay, token), name, role: 'subscribe' }, { headers: { 'cache-control': 'no-store' } });
  }

  /** Sockets are the truth for who is connected (after an eviction the stored counts may be stale). */
  private reconcile() {
    if (!this.st) return;
    const counts = new Map<string, number>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { id?: string } | null;
      if (a?.id && ws.readyState === 1) counts.set(a.id, (counts.get(a.id) ?? 0) + 1);
    }
    for (const mem of Object.values(this.st.members)) {
      const n = counts.get(mem.id) ?? 0;
      if (mem.connected === n) continue;
      if (n === 0) { mem.connected = 1; leave(this.st, mem.id, Date.now()); } else mem.connected = n;
    }
  }

  private send(ws: WebSocket, data: string) { try { ws.send(data); } catch { /* closed */ } }

  /** Everyone gets their own view (the audience never gets the attendee list). */
  private broadcast(now: number, except?: string) {
    if (!this.st) return;
    this.sentLive = broadcastLive(this.st, now);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { id?: string } | null;
      const mem = a?.id ? this.st.members[a.id] : null;
      if (!mem || a?.id === except) continue;
      this.send(ws, JSON.stringify(view(this.st, mem, now)));
    }
  }
  private deliver(to: string, msg: Record<string, unknown>) {
    const data = JSON.stringify(msg);
    const list = to === 'all' ? this.ctx.getWebSockets() : this.ctx.getWebSockets(to);
    for (const ws of list) this.send(ws, data);
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (!this.st || typeof data !== 'string' || data.length > 8000) return;
    const a = ws.deserializeAttachment() as { id?: string } | null;
    if (!a?.id) return;
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { return; }
    const now = Date.now();
    const r = apply(this.st, a.id, msg, now);
    if (!r.ok) { this.send(ws, JSON.stringify({ t: 'error', error: r.error, for: (msg as { t?: unknown })?.t ?? null })); return; }
    for (const o of r.out) this.deliver(o.to, o.msg);
    for (const e of r.effects) await this.effect(e, now);
    if (r.changed || r.effects.length) { await this.save(); this.broadcast(now); }
    else if (r.out.some((o) => (o.msg as { t?: string }).t === 'chat')) await this.save();
  }

  private async effect(e: Effect, now: number) {
    const st = this.st!;
    const rt = await this.runtime();
    switch (e.type) {
      case 'went_live':
        await markRoom(rt, st.id, 'live', {}, now).catch((x) => console.error('room live', x));
        await this.feed(Object.values(st.members).filter((m) => m.connected > 0), now);
        return;
      case 'ended':
        await markRoom(rt, st.id, 'ended', {}, now).catch((x) => console.error('room end', x));
        return;
      case 'offer': {
        const row = await getRoom(rt, st.id);
        if (!row) return;
        const r = await setRoomOffer(rt, row, e.open, now);
        if (!r.ok) { this.deliver('all', { t: 'notice', staffOnly: true, text: r.error }); return; }
        st.offer = await roomOffer(rt, row, now);
        if (st.offer.open) await this.feed(Object.values(st.members).filter((m) => m.connected > 0), now, true);
        return;
      }
      case 'close_tracks':
        await forceClose(rt.settings, e.sessionId, e.mids);
        return;
      case 'kick':
        for (const ws of this.ctx.getWebSockets(e.memberId)) { try { ws.close(4003, 'removed'); } catch { /* closed */ } }
        if (st.members[e.memberId]) { st.members[e.memberId].connected = 1; leave(st, e.memberId, now); }
        return;
      case 'on_stage':
        await this.feed([st.members[e.memberId]].filter(Boolean), now);
        return;
      case 'recording':
        return;
    }
  }

  async webSocketClose(ws: WebSocket) { await this.closed(ws); }
  async webSocketError(ws: WebSocket) { await this.closed(ws); }
  private async closed(ws: WebSocket) {
    if (!this.st) return;
    const a = ws.deserializeAttachment() as { id?: string } | null;
    if (!a?.id) return;
    const now = Date.now();
    const m = leave(this.st, a.id, now);
    if (m && m.connected === 0) {
      await this.env.DB.prepare('UPDATE room_attendance SET last_at = ? WHERE room_id = ? AND who = ?').bind(now, this.st.id, a.id).run().catch(() => null);
      // Their tracks are gone with their connection.
    }
    await this.save();
    this.broadcast(now);
  }

  private async feed(members: Member[], now: number, offerOpen = false) {
    if (!this.st || !members.length) return;
    const rt = await this.runtime();
    const row = await getRoom(rt, this.st.id);
    if (!row) return;
    await feedPresence(rt, row, members.map((m) => ({ id: m.id, role: m.role, name: m.name, leadId: m.leadId, regId: m.regId, stage: m.stage })), now, { live: this.st.status === 'live', offerOpen: offerOpen || this.st.offer.open }).catch((e) => console.error('room presence', e));
  }

  /** Every minute while anyone is connected: presence and minutes, the peak, the offer's real state. */
  async alarm() {
    if (!this.st) return;
    this.reconcile();
    const now = Date.now();
    const here = Object.values(this.st.members).filter((m) => m.connected > 0);
    if (here.length) {
      await this.feed(here, now);
      const rt = await this.runtime();
      await markRoom(rt, this.st.id, 'peak', { peak: this.st.peak }, now).catch(() => null);
      if (this.st.offer.available) {
        const row = await getRoom(rt, this.st.id);
        if (row) {
          const before = JSON.stringify(this.st.offer);
          this.st.offer = await roomOffer(rt, row, now).catch(() => this.st!.offer);
          if (JSON.stringify(this.st.offer) !== before) this.broadcast(now);
        }
      }
      if (this.st.timer && this.st.timer.endsAt < now - 60_000) { this.st.timer = null; this.broadcast(now); }
      // The host's broadcast went quiet without a goodbye: viewers go back to the SFU.
      if (this.sentLive && !broadcastLive(this.st, now)) this.broadcast(now);
      await this.ctx.storage.setAlarm(now + ALARM_MS);
    }
    prune(this.st, now);
    await this.save();
  }
}
