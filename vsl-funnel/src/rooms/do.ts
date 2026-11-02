import type { Env } from '../env';
import type { Runtime } from '../app';
import { loadSettings } from '../settings';
import { type Effect, type EngageAvail, type Identity, type Member, type MoqState, type PointAward, type RoomMode, type RoomState, apply, audienceMembers, onTimeAwards, broadcastLive, broadcastView, canSeeStage, configureMoq, connectedCount, engOf, isStaff, join, leave, mediaPath, newEngage, newMoqState, newRoomState, prune, pushFor, shouldPublishMoq, tickMinutes, view, autoPushDue, type AutoPush } from './state';
import { type AgendaItem, ENGAGE_COPY, ON_TIME_MS, assetById } from './engage';
import { broadcastName, connectUrl, relayUrl } from './moq';
import { getSecret } from '../lib/secret';
import { type SfuOp, SFU_OPS, forceClose, sfuProxy } from './proxy';
import { feedPresence, getRoom, markRoom, roomOffer, setRoomOffer } from './rooms';
import { type StudioDefaults, canLoadSlide, configureStudio } from './studio'; // builder B (studio)
import { AudienceHub } from './audience-do'; // area C: reactions, captions, the co-host, announcements, nudges
import { MediaReports, heldIds, holdOnClose, isHeld, previewProxy, resume as resumeMedia, staffView, wantsQuality } from './media';
import { boundRoomState, cleanupAt, keepDays } from './hygiene'; // reliability: bounded state, ended-room clean-up
import { Engage2Hub } from './engage2-do'; // engage2: engagement score, hot list, live-only bonus

/**
 * One Durable Object per room: signalling and state over WebSockets with hibernation (the object sleeps between
 * messages; sockets stay open), the SFU proxy, and a once-a-minute alarm that feeds presence and minutes into D1
 * while anyone is connected. The Worker authenticates every request (room ticket) and passes the identity in
 * x-room-who; the object is only reachable through the Worker.
 */

const ALARM_MS = 60_000;
interface Meta {
  id: string; mode: RoomMode; title: string; startsAt: number | null; offerAvailable: boolean; origin: string; moq?: { mode: MoqState['mode']; ready: boolean; minAudience: number };
  /** Engagement (webinars): what the host can push here, the agenda, whether the leaderboard starts on. */
  engage?: { avail: EngageAvail; agenda: AgendaItem[]; board: boolean; auto?: AutoPush[] };
  /** Studio (builder B): Funnel HQ's per-room defaults and whether the studio is on. */
  studio?: StudioDefaults;
}

export class RoomDO {
  private st: RoomState | null = null;
  private meta: Meta | null = null;
  /** Whether the last state everyone received had the MoQ broadcast live (the alarm re-sends when it lapses). */
  private sentLive = false;
  /** Call quality reports (area A "media", src/rooms/media.ts). */
  private mediaReports: MediaReports | null = null;
  private get media() { return (this.mediaReports ??= new MediaReports(this.ctx.storage)); }

  /** Area C (audience): reactions, captions, the AI co-host, purchase announcements, the checkout nudge. */
  private aud: AudienceHub;
  /** Engage2: the engagement score, the host's hot list, the live-only bonus. */
  private e2: Engage2Hub;

  constructor(private ctx: DurableObjectState, private env: Env) {
    this.aud = this.newHub();
    this.e2 = this.newE2();
    void ctx.blockConcurrencyWhile(async () => {
      this.st = (await ctx.storage.get<RoomState>('st')) ?? null;
      this.meta = (await ctx.storage.get<Meta>('meta')) ?? null;
    });
  }

  private newHub() {
    const ctx = this.ctx;
    return new AudienceHub({
      st: () => this.st, deliver: (to, msg) => this.deliver(to, msg), runtime: () => this.runtime(), storage: ctx.storage,
      waitUntil: (p) => ctx.waitUntil(p.catch((e) => console.error('room audience', e))), commit: async (now) => { await this.save(); this.broadcast(now); },
    });
  }

  private newE2() {
    return new Engage2Hub({ st: () => this.st, deliver: (to, msg) => this.deliver(to, msg), runtime: () => this.runtime(), storage: this.ctx.storage, commit: async (now) => { await this.save(); this.broadcast(now); } });
  }

  private async runtime(): Promise<Runtime> {
    const settings = await loadSettings(this.env);
    return { env: this.env, settings, reps: [], origin: this.meta?.origin ?? 'https://example.com', waitUntil: (p) => this.ctx.waitUntil(p.catch((e) => console.error('room background', e))) };
  }
  private async save() { if (this.st) await this.ctx.storage.put('st', this.st); }

  private async ensureState(meta: Meta) {
    if (!this.meta || this.meta.origin !== meta.origin || this.meta.title !== meta.title || this.meta.startsAt !== meta.startsAt || JSON.stringify(this.meta.engage ?? null) !== JSON.stringify(meta.engage ?? null) || JSON.stringify(this.meta.studio ?? null) !== JSON.stringify(meta.studio ?? null)) {
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
    if (meta.engage) {
      // The leaderboard default applies when the room's engagement state is first made; the host's switch wins after that.
      this.st.eng ??= newEngage({ board: meta.engage.board });
      this.st.eng.avail = meta.engage.avail;
      this.st.eng.agenda = meta.engage.agenda;
      this.st.eng.auto = meta.engage.auto ?? [];
      if (this.st.eng.chapter >= this.st.eng.agenda.length) this.st.eng.chapter = this.st.eng.agenda.length - 1;
    }
    if (meta.studio) configureStudio(this.st, meta.studio); // studio defaults (builder B)
    return this.st;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // Reliability: the daily sweep clears ended rooms past the keep period (only the Worker's cron calls this; it
    // clears nothing unless the room ended long enough ago and nobody is connected).
    if (url.pathname === '/gc' && req.method === 'POST' && req.headers.get('x-room-gc') === '1') return Response.json(await this.gc(Date.now(), true));
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
      const resumed = resumeMedia(st, who.id, now); // media: back within the reconnect hold
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
      await this.aud.onJoin(r.member, now).catch(() => null);
      await this.e2.onJoin(r.member, now).catch(() => null); // engage2: the bonus, the hot list
      // media: whether the room kept their media session through the reconnect, who else is reconnecting, and for staff everyone's connection.
      server.send(JSON.stringify({ t: 'resumed', sessionId: resumed?.sessionId ?? null, held: Boolean(resumed) }));
      if (resumed) this.deliver('all', { t: 'mhold', ids: heldIds(st, now) });
      else if (heldIds(st, now).length) server.send(JSON.stringify({ t: 'mhold', ids: heldIds(st, now) }));
      if (wantsQuality(r.member)) server.send(JSON.stringify({ t: 'mq_all', people: await this.media.snapshot(st) }));
      this.broadcast(now, who.id);
      await this.feed([r.member], now);
      // Joined within five minutes of Go live: on time.
      if (st.mode === 'webinar' && st.status === 'live' && !isStaff(r.member) && st.wentLiveAt && now - st.wentLiveAt <= ON_TIME_MS) await this.award([{ memberId: who.id, action: 'on_time', key: '1' }], now);
      // A meeting is live from its first join (webinars wait for the host's Go live).
      if (st.mode === 'meeting' && connectedCount(st) === 1) await markRoom(await this.runtime(), st.id, 'live', {}, now).catch(() => null);
      await this.ensureMinuteAlarm(now);
      return new Response(null, { status: 101, webSocket: client });
    }

    const m = /^\/sfu\/([a-z]+)$/.exec(url.pathname);
    if (m && SFU_OPS.includes(m[1] as SfuOp) && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const rt = await this.runtime();
      const r = body.preview === true ? await previewProxy(st, who.id, m[1] as SfuOp, body, rt.settings, Date.now()) : await sfuProxy(st, who.id, m[1] as SfuOp, body, rt.settings); // media: "How attendees see me"
      if (r.changed) { await this.save(); this.broadcast(Date.now()); }
      return Response.json(r.body, { status: r.status });
    }

    if (reconfigured) { await this.save(); this.broadcast(now); }

    if (url.pathname.startsWith('/audience/')) { const ar = await this.aud.fetch(url.pathname, req, now); if (ar) return ar; }

    if (url.pathname === '/moq' && req.method === 'POST') return this.moqAccess(st, who, req.headers.get('x-room-admin') === '1', now);

    // The room's HTTP calls (application, Deal Plan) report what happened: awards and push events.
    if (url.pathname === '/engage' && req.method === 'POST') {
      const b = (await req.json().catch(() => ({}))) as { awards?: PointAward[]; event?: { kind: 'application'; ev: 'submitted' } };
      const awards = (b.awards ?? []).filter((a) => a && a.memberId === who.id);
      if (awards.length) await this.award(awards, now);
      return Response.json({ ok: true, points: st.eng?.pts[who.id] ?? 0 });
    }
    if (url.pathname === '/engage/report') {
      const top = [...st.qa].sort((a, b) => b.votes.length - a.votes.length || a.at - b.at).slice(0, 10).map((q) => ({ text: q.text, votes: q.votes.length, name: q.name, answered: q.answered }));
      return Response.json({ questions: top, chapter: st.eng?.chapter ?? -1, board: st.eng?.board ?? false });
    }

    // Studio (builder B): may this person load this slide? (attendees: only pages the stage has shown)
    if (url.pathname === '/studio/slide') {
      const b = (await req.json().catch(() => ({}))) as { deck?: string; page?: number };
      return Response.json({ ok: canLoadSlide(st, st.members[who.id] ?? who, String(b.deck ?? ''), Number(b.page)) });
    }
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
      if (n === 0 && isHeld(this.st, mem.id, Date.now())) continue; // media: reconnecting within the hold
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
    if (now - this.alarmCheckedAt > ALARM_MS) await this.ensureMinuteAlarm(now).catch(() => null); // self-heal a lost alarm
    // engage2: counts reactions and price questions (never changes the message); owns e2_* messages.
    if (msg && typeof msg === 'object') await this.e2.observe(a.id, msg as Record<string, unknown>, now).catch(() => null);
    if (Engage2Hub.handles((msg as { t?: unknown })?.t)) {
      const err = await this.e2.onMessage(a.id, msg as Record<string, unknown>, now).catch(() => 'unavailable');
      if (err) { this.send(ws, JSON.stringify({ t: 'error', error: err, for: (msg as { t?: unknown }).t })); return; }
      const next = this.e2.takePending(); // a hot-list push runs as the room's own push to that person
      if (!next) return;
      msg = next;
    }
    if (AudienceHub.handles((msg as { t?: unknown })?.t)) {
      const err = await this.aud.onMessage(a.id, msg as Record<string, unknown>, now);
      if (err) { this.send(ws, JSON.stringify({ t: 'error', error: err, for: (msg as { t?: unknown }).t })); return; }
      const next = this.aud.takePending(); // qa-sells: "answer and reopen the offer" runs the room's own push
      if (!next) return;
      msg = next;
    }
    // Intel (area D): intel_* messages (the active speaker from the host's browser) never touch the state machine.
    if (typeof (msg as { t?: unknown })?.t === 'string' && ((msg as { t: string }).t).startsWith('intel_')) {
      const { onIntelMessage } = await import('./intel-db');
      const x = await onIntelMessage(this.env, this.st, a.id, msg as Record<string, unknown>, now).catch(() => ({ ok: false as const, error: 'unavailable' }));
      if (!x.ok) this.send(ws, JSON.stringify({ t: 'error', error: x.error, for: (msg as { t: string }).t }));
      return;
    }
    // media: a browser's own connection report (staff hear about changes); staff asking for everyone's.
    const mt = (msg as { t?: unknown })?.t;
    if (mt === 'mq' || mt === 'mq_all') { await this.mediaMessage(ws, a.id, msg as Record<string, unknown>, now); return; }
    const r = apply(this.st, a.id, msg, now);
    if (!r.ok) { this.send(ws, JSON.stringify({ t: 'error', error: r.error, for: (msg as { t?: unknown })?.t ?? null })); return; }
    // Intel (area D): chat, questions, chapters, polls, reactions and the recording switch go into the room's timeline.
    const st0 = this.st, actor = a.id;
    this.ctx.waitUntil(import('./intel-db').then((m) => m.onRoomMessage(this.env, st0, actor, msg as Record<string, unknown>, now)).catch(() => null));
    if ((msg as { t?: unknown }).t === 'push_close') {
      const rt = await this.runtime();
      const { closePushes } = await import('./engage-db');
      await closePushes(rt, this.st.id, [Number((msg as { pid?: unknown }).pid)], now).catch(() => null);
    }
    for (const o of r.out) this.deliver(o.to, o.msg);
    for (const e of r.effects) await this.effect(e, now);
    if (r.changed || r.effects.length) { await this.save(); this.broadcast(now); }
    else if (r.out.some((o) => (o.msg as { t?: string }).t === 'chat' || (o.msg as { t?: string }).t === 'lc_from')) await this.save(); // lc_from: the waiting room's list (builder E)
    await this.aud.afterApply(a.id, msg as Record<string, unknown>, now).catch((e) => console.error('room audience', e));
  }

  private async effect(e: Effect, now: number) {
    const st = this.st!;
    const rt = await this.runtime();
    switch (e.type) {
      case 'went_live':
        await markRoom(rt, st.id, 'live', {}, now).catch((x) => console.error('room live', x));
        await this.feed(Object.values(st.members).filter((m) => m.connected > 0), now);
        await this.award(onTimeAwards(st), now);
        return;
      case 'ended': {
        await markRoom(rt, st.id, 'ended', {}, now).catch((x) => console.error('room end', x));
        const { closePushes } = await import('./engage-db');
        await closePushes(rt, st.id, 'all_but_deposit', now).catch(() => null);
        await this.e2.onEnded(now).catch((x) => console.error('room engage2 end', x)); // engage2: final scores, the bonus
        return;
      }
      case 'award':
        await this.award(e.awards, now);
        return;
      case 'pushed': {
        const { savePush } = await import('./engage-db');
        const targets = audienceMembers(st).filter((m) => pushFor(e.push, m));
        await savePush(rt, st.id, e.push, e.push.to ? e.push.to.length : targets.length).catch((x) => console.error('room push', x));
        // A pushed resource is theirs: everyone it reaches now (and anyone who opens it later) can download it.
        if (e.push.kind === 'resource' && e.push.ref) for (const m of targets) await this.grant(m, [e.push.ref], 'push', now, false);
        return;
      }
      case 'push_ev': {
        const m = st.members[e.memberId];
        const p = engOf(st).pushes.find((x) => x.id === e.pushId);
        if (!m || !p) return;
        const { recordPushEvent } = await import('./engage-db');
        await recordPushEvent(rt, await this.roomLike(), p.id, m, e.ev, p.kind, now).catch((x) => console.error('room push event', x));
        if (p.kind === 'resource' && p.ref && (e.ev === 'shown' || e.ev === 'opened')) await this.grant(m, [p.ref], 'push', now);
        return;
      }
      case 'quiz_answer': {
        const m = st.members[e.memberId];
        if (!m) return;
        const { recordQuiz } = await import('./engage-db');
        await recordQuiz(rt, await this.roomLike(), m, e.quizId, e.choice, e.correct, e.question, now).catch((x) => console.error('room quiz', x));
        return;
      }
      case 'end_unlocks': {
        const { endUnlocks, engageConfig } = await import('./engage-db');
        const assets = endUnlocks(engageConfig(rt).unlocks);
        if (!assets.length) return;
        for (const id of e.memberIds) { const m = st.members[id]; if (m) await this.grant(m, assets, 'end', now, false); }
        return;
      }
      case 'offer': {
        const row = await getRoom(rt, st.id);
        if (!row) return;
        const r = await setRoomOffer(rt, row, e.open, now);
        if (!r.ok) { this.deliver('all', { t: 'notice', staffOnly: true, text: r.error }); return; }
        st.offer = await roomOffer(rt, row, now);
        if (st.offer.open) await this.feed(Object.values(st.members).filter((m) => m.connected > 0), now, true);
        await this.e2.onOffer(now).catch(() => null); // engage2: an offer-mode bonus follows the real window
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

  private roomRow: { at: number; row: Awaited<ReturnType<typeof getRoom>> } | null = null;
  /** The room's row (cached a minute) for the engagement writes. */
  private async roomLike() {
    const st = this.st!;
    if (!this.roomRow || Date.now() - this.roomRow.at > 60_000) this.roomRow = { at: Date.now(), row: await getRoom(await this.runtime(), st.id) };
    return this.roomRow.row ?? { id: st.id, ref_type: 'none' as const, ref_id: null, title: st.title };
  }

  /**
   * Records point awards (the database enforces each action's cap and de-duplicates by key), updates the
   * room's copy of each person's points, grants any threshold unlock they reached, and tells each person what
   * they earned. One redraw for the whole batch.
   */
  private async award(awards: PointAward[], now: number) {
    const st = this.st;
    if (!st || st.mode !== 'webinar' || !awards.length) return;
    const rt = await this.runtime();
    const { awardPoints, engageConfig, thresholdUnlocks } = await import('./engage-db');
    const cfg = engageConfig(rt);
    const room = await this.roomLike();
    const list = awards.map((a) => ({ a, m: st.members[a.memberId] })).filter((x) => x.m && !isStaff(x.m));
    const done = await awardPoints(rt, room, list.map(({ a, m }) => ({ who: m, action: a.action, key: a.key })), cfg.rules, now).catch((e) => { console.error('room awards', String(e).slice(0, 200)); return []; });
    if (!done.length) return;
    const e = engOf(st);
    for (const d of done) {
      e.pts[d.who] = (e.pts[d.who] ?? 0) + d.points;
      const m = st.members[d.who];
      const fresh = thresholdUnlocks(cfg.unlocks, e.pts[d.who]).filter((x) => !(e.unlocks[d.who] ?? []).includes(x));
      const unlocked = fresh.length && m ? await this.grant(m, fresh, 'points', now, false) : [];
      this.deliver(d.who, { t: 'award', action: d.action, label: cfg.rules[d.action].label, points: d.points, total: e.pts[d.who], unlocked: unlocked.map((x) => assetById(x)?.title ?? x) });
    }
    await this.save();
    this.broadcast(now);
  }
  /** Grants assets to one person (once each), and tells them unless the caller does. */
  private async grant(m: Member, assets: string[], source: 'points' | 'end' | 'push', now: number, tell = true) {
    const st = this.st!;
    const rt = await this.runtime();
    const { grantUnlocks } = await import('./engage-db');
    const fresh = await grantUnlocks(rt, await this.roomLike(), m, assets, source, now).catch(() => [] as string[]);
    const e = engOf(st);
    // Granted now or before: either way the database has them.
    const mine = new Set([...(e.unlocks[m.id] ?? []), ...assets.filter((a) => assetById(a))]);
    e.unlocks[m.id] = [...mine];
    if (tell && fresh.length) {
      this.deliver(m.id, { t: 'unlocked', titles: fresh.map((x) => assetById(x)?.title ?? x), text: ENGAGE_COPY.unlocked(fresh.map((x) => assetById(x)?.title ?? x).join(', ')) });
      await this.save();
      this.broadcast(now);
    }
    return fresh;
  }

  private async mediaMessage(ws: WebSocket, id: string, msg: Record<string, unknown>, now: number) {
    const st = this.st!;
    const me = st.members[id];
    if (msg.t === 'mq_all') { if (wantsQuality(me)) this.send(ws, JSON.stringify({ t: 'mq_all', people: await this.media.snapshot(st) })); return; }
    const r = await this.media.ingest(st, id, msg.q, now);
    if (!r?.changed) return;
    const data = JSON.stringify({ t: 'mq', p: staffView(r.rec) });
    for (const s of this.ctx.getWebSockets()) {
      const att = s.deserializeAttachment() as { id?: string } | null;
      if (att?.id && att.id !== id && wantsQuality(st.members[att.id])) this.send(s, data);
    }
  }

  async webSocketClose(ws: WebSocket, code?: number) { await this.closed(ws, code); }
  async webSocketError(ws: WebSocket) { await this.closed(ws); }
  private async closed(ws: WebSocket, code?: number) {
    if (!this.st) return;
    const a = ws.deserializeAttachment() as { id?: string } | null;
    if (!a?.id) return;
    const now = Date.now();
    // media: a drop without a goodbye keeps their place (stage, hand, media session) for a short while.
    if (holdOnClose(this.st, a.id, code, now)) {
      await this.save();
      this.deliver('all', { t: 'mhold', ids: heldIds(this.st, now) });
      return;
    }
    const m = leave(this.st, a.id, now);
    // media: the last person left, so the alarm stops: write the call quality summaries now.
    if (connectedCount(this.st) === 0) await this.media.flush(this.env.DB, this.st.id);
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

  /**
   * The minute loop runs while anyone is connected. A clean-up alarm (far in the future) may be pending for an
   * ended room; someone joining brings the minute loop back. Also called on messages, so a lost alarm heals.
   */
  private alarmCheckedAt = 0;
  private async ensureMinuteAlarm(now: number) {
    this.alarmCheckedAt = now;
    const at = await this.ctx.storage.getAlarm();
    if (at == null || at > now + ALARM_MS) await this.ctx.storage.setAlarm(now + ALARM_MS);
  }

  /** Every minute while anyone is connected: presence and minutes, the peak, the offer's real state. */
  async alarm() {
    if (!this.st) {
      // State already cleared (or never made): nothing to run; leftovers from a cleared room go on the sweep.
      return;
    }
    const heldBefore = heldIds(this.st, Date.now()).length;
    this.reconcile();
    const now = Date.now();
    const here = Object.values(this.st.members).filter((m) => m.connected > 0);
    // The next minute is booked first: an error anywhere below can't end the room's minute loop.
    if (here.length) await this.ctx.storage.setAlarm(now + ALARM_MS);
    try {
      await this.minute(now, heldBefore, here);
    } catch (e) {
      console.error('room alarm', String(e).slice(0, 300));
    }
    prune(this.st, now);
    const trimmed = boundRoomState(this.st);
    if (trimmed.members || trimmed.eng || trimmed.chat) console.log('room state trimmed', this.st.id, trimmed);
    await this.save();
    // Nobody here: an ended room books its clean-up (or is cleared now when it's due).
    if (!here.length) await this.gc(now, false).catch((e) => console.error('room gc', String(e).slice(0, 200)));
  }

  private async minute(now: number, heldBefore: number, here: Member[]) {
    const st = this.st!;
    // media: holds that ran out are departures now; the call quality summaries go to D1.
    if (heldBefore && heldIds(st, now).length !== heldBefore) { this.broadcast(now); this.deliver('all', { t: 'mhold', ids: heldIds(st, now) }); }
    await this.media.flush(this.env.DB, st.id);
    if (!here.length) return;
    await this.feed(here, now);
    const rt = await this.runtime();
    await markRoom(rt, st.id, 'peak', { peak: st.peak }, now).catch(() => null);
    if (st.offer.available) {
      const row = await getRoom(rt, st.id);
      if (row) {
        const before = JSON.stringify(st.offer);
        st.offer = await roomOffer(rt, row, now).catch(() => st.offer);
        if (JSON.stringify(st.offer) !== before) this.broadcast(now);
      }
    }
    if (st.timer && st.timer.endsAt < now - 60_000) { st.timer = null; this.broadcast(now); }
    // Engagement: ten-minute awards, and the retention curve (attendees here at this minute since Go live).
    if (st.mode === 'webinar' && st.status === 'live') {
      const ticks = tickMinutes(st);
      if (ticks.length) await this.award(ticks, now);
      // Automatic pushes that are due (the room's schedule, minutes after Go live).
      const due = autoPushDue(st, now);
      for (const e of due.effects) await this.effect(e, now);
      if (due.changed) { await this.save(); this.broadcast(now); }
      if (st.wentLiveAt) {
        const { recordMinute } = await import('./engage-db');
        await recordMinute(rt, st.id, Math.floor((now - st.wentLiveAt) / 60_000), audienceMembers(st).length).catch(() => null);
      }
    }
    // The host's broadcast went quiet without a goodbye: viewers go back to the SFU.
    if (this.sentLive && !broadcastLive(st, now)) this.broadcast(now);
    await this.aud.tick(now).catch((e) => console.error('room audience tick', e));
    await this.e2.tick(now).catch((e) => console.error('room engage2 tick', e));
  }

  /**
   * Ended-room clean-up (ROOM_DO_KEEP_DAYS after the room ended and everyone left): clears this object's storage
   * (state, meta, call quality reports, audience data) and its alarm. Not due yet: books an alarm for when it is.
   * The database (attendance, the chat timeline, recordings, debriefs) is never touched.
   */
  private async gc(now: number, fromSweep: boolean) {
    const connected = this.ctx.getWebSockets().filter((ws) => ws.readyState === 1).length;
    if (connected) return { cleared: false, reason: 'connected' };
    if (!this.st) {
      const any = (await this.ctx.storage.list({ limit: 1 })).size;
      if (!any) return { cleared: false, reason: 'empty' };
      if (!fromSweep) return { cleared: false, reason: 'no_state' };
    }
    const rt = await this.runtime();
    if (this.st && this.st.status !== 'ended') {
      // Ended or cancelled from Funnel HQ without anyone in the room: the database knows.
      const row = await getRoom(rt, this.st.id).catch(() => null);
      if (row && (row.status === 'ended' || row.status === 'cancelled')) { this.st.status = 'ended'; this.st.endedAt = row.ended_at ?? now; await this.save(); }
    }
    const keep = keepDays(rt.settings as unknown as Record<string, string | undefined>);
    const due = this.st ? cleanupAt(this.st, keep, 0) : now;
    if (due == null) return { cleared: false, reason: 'not_ended' };
    if (due > now) {
      await this.ctx.storage.setAlarm(due);
      return { cleared: false, reason: 'not_yet', at: due };
    }
    const roomId = this.st?.id ?? this.meta?.id ?? null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.st = null; this.meta = null; this.mediaReports = null; this.roomRow = null; this.aud = this.newHub(); this.e2 = this.newE2();
    if (roomId) await this.env.DB.prepare('INSERT INTO room_do_gc (room_id, cleaned_at, detail) VALUES (?, ?, ?) ON CONFLICT(room_id) DO NOTHING').bind(roomId, now, fromSweep ? 'sweep' : 'alarm').run().catch(() => null);
    return { cleared: true, reason: fromSweep ? 'sweep' : 'alarm' };
  }
}
