import type { Runtime } from '../app';
import { auditCopy } from '../content/copy-rules';
import { type Member, type PushKind, type RoomState, engOf, isStaff } from './state';
import { type Bonus, E2_COPY, asksPrice, bonusDue, bonusView, cleanBonus, hotList, hotRow } from './engage2';
import type { LiveBits, RoomPerson } from './engage2-db';

/**
 * Engagement round 2 inside the room's Durable Object. RoomDO shows this hub every message first (observe: it
 * only counts reactions, offer opens and price questions, and never changes the message), hands it the e2_*
 * messages, each join, the minute alarm, the offer changing and the end of the session.
 *
 *  - Scores: once a minute while live (and at the end), from the database's rows plus this hub's own counts;
 *    written per member and on the lead; the hot list goes to the team.
 *  - The tab beacons: each one adds the time since the last (at most 90 seconds) to "in view" or "away",
 *    by the server's clock, only while live. A browser can't add more time than really passed.
 *  - Hot list actions: push the Sprint card or the application to one person (added to the open card for selected
 *    people when there is one, so nobody else's card is taken down); the mention is drawn by the host's browser
 *    and only offered for people who opted in to showing their first name.
 *  - The live-only bonus: shown to everyone; withdrawn by the server when its moment comes; buyers while live get it.
 */

export interface E2Host {
  st(): RoomState | null;
  deliver(to: string, msg: Record<string, unknown>): void;
  runtime(): Promise<Runtime>;
  storage: DurableObjectStorage;
  /** Persist the room's state and redraw everyone. */
  commit(now: number): Promise<void>;
}

const HANDLED = new Set(['e2_hello', 'e2_focus', 'e2_open', 'e2_hot_get', 'e2_push', 'e2_bonus_set', 'e2_bonus_withdraw']);
const BEACON_MAX_MS = 90_000;
const OPEN_GAP_MS = 10_000;
const REACTIONS_CAP = 200;

interface Saved extends LiveBits {
  /** The last beacon per member: whether the tab was in view, and when (server time). */
  last: Record<string, { v: boolean; at: number }>;
  openAt: Record<string, number>;
  /** The offer was seen open in this session (a host closing it early withdraws an offer-mode bonus). */
  seenOpen: boolean;
}
const fresh = (): Saved => ({ reactions: {}, focus: {}, opens: {}, price: {}, last: {}, openAt: {}, seenOpen: false });

export class Engage2Hub {
  private data: Saved | null = null;
  private loading: Promise<Saved> | null = null;
  private bonus: { at: number; b: Bonus | null; grants: string[] } | null = null;
  private hot: ReturnType<typeof hotRow>[] = [];
  private bought = 0;
  private scoredAt = 0;

  constructor(private host: E2Host) {}

  static handles(t: unknown) { return typeof t === 'string' && HANDLED.has(t); }

  private async load(): Promise<Saved> {
    if (this.data) return this.data;
    this.loading ??= this.host.storage.get<Saved>('e2').then((d) => (this.data = { ...fresh(), ...(d ?? {}) }));
    return this.loading;
  }
  private async persist() { if (this.data) await this.host.storage.put('e2', this.data); }
  private staffIds() { const st = this.host.st(); return st ? Object.values(st.members).filter((m) => m.connected > 0 && isStaff(m)).map((m) => m.id) : []; }
  private toStaff(msg: Record<string, unknown>) { for (const id of this.staffIds()) this.host.deliver(id, msg); }
  private live() { const st = this.host.st(); return Boolean(st && st.mode === 'webinar' && st.status === 'live'); }

  /**
   * Every message the room receives, before anything else handles it: counts only (reactions, offer opens are
   * separate messages, a price question in chat or the Q&A). Never changes or blocks the message.
   */
  async observe(actorId: string, msg: Record<string, unknown>, now: number) {
    const st = this.host.st();
    const me = st?.members[actorId];
    if (!st || !me || isStaff(me) || st.mode !== 'webinar' || st.status === 'ended') return;
    const t = msg.t;
    if (t === 'react') {
      const d = await this.load();
      d.reactions[actorId] = Math.min(REACTIONS_CAP, (d.reactions[actorId] ?? 0) + 1);
    } else if ((t === 'chat' || t === 'ask' || t === 'prebuy_q') && typeof msg.text === 'string' && asksPrice(msg.text.slice(0, 400))) {
      const d = await this.load();
      if (!d.price[actorId]) { d.price[actorId] = 1; await this.persist(); }
    }
    void now;
  }

  /** What one person needs when they join: the bonus (everyone), the hot list (staff). */
  async onJoin(m: Member, now: number) {
    const st = this.host.st();
    if (!st || st.mode !== 'webinar') return;
    const b = await this.bonusNow(now);
    this.host.deliver(m.id, { t: 'e2_bonus', bonus: this.bonusFor(m, b) });
    if (isStaff(m)) this.host.deliver(m.id, this.hotMsg());
  }

  /** An e2_* message. Returns an error code for the sender, or null. */
  async onMessage(actorId: string, msg: Record<string, unknown>, now: number): Promise<string | null> {
    const st = this.host.st();
    const me = st?.members[actorId];
    if (!st || !me) return 'not_in_room';
    const staff = isStaff(me);
    switch (msg.t) {
      case 'e2_hello': await this.onJoin(me, now); return null;
      case 'e2_focus': {
        if (staff || st.mode !== 'webinar') return null;
        const d = await this.load();
        const prev = d.last[actorId];
        const v = msg.v === true;
        if (prev && this.live()) {
          const gap = Math.max(0, Math.min(BEACON_MAX_MS, now - prev.at));
          const f = (d.focus[actorId] ??= { f: 0, a: 0 });
          if (prev.v) f.f += gap; else f.a += gap;
        }
        d.last[actorId] = { v, at: now };
        await this.persist();
        return null;
      }
      case 'e2_open': {
        if (staff || st.mode !== 'webinar') return null;
        const d = await this.load();
        if (now - (d.openAt[actorId] ?? 0) < OPEN_GAP_MS) return null;
        d.openAt[actorId] = now;
        d.opens[actorId] = Math.min(50, (d.opens[actorId] ?? 0) + 1);
        await this.persist();
        // A second open is a buying signal the host wants to see now, not in a minute.
        if (d.opens[actorId] === 2) await this.score(now, true);
        return null;
      }
      case 'e2_hot_get': {
        if (!staff) return 'forbidden';
        if (now - this.scoredAt > 15_000) await this.score(now, true);
        else this.host.deliver(actorId, this.hotMsg());
        return null;
      }
      case 'e2_push': return this.pushTo(st, me, msg, now);
      case 'e2_bonus_set': {
        if (!staff) return 'forbidden';
        if (st.mode !== 'webinar') return 'not_applicable';
        const c = cleanBonus(msg);
        if (!c) return 'bonus_text';
        if (auditCopy(c.text).length) return 'bonus_copy';
        const rt = await this.host.runtime();
        const { setBonus } = await import('./engage2-db');
        const r = await setBonus(rt, st.id, c, { by: me.id, live: st.status !== 'lobby' }, now);
        if (!r.ok) return r.error;
        this.bonus = null;
        await this.sendBonus(now);
        return null;
      }
      case 'e2_bonus_withdraw': {
        if (!staff) return 'forbidden';
        const rt = await this.host.runtime();
        const { withdrawBonus } = await import('./engage2-db');
        await withdrawBonus(rt, st.id, 'host', now);
        this.bonus = null;
        await this.sendBonus(now);
        return null;
      }
    }
    return 'unknown_message';
  }

  /**
   * The Sprint card or the application, to one person from the hot list. An open card that already reaches them
   * is left alone; an open card for selected people gets them added; otherwise a new card for them alone.
   * Returns null when the room's own push should run (the DO then applies { t: 'push', to: [id] }).
   */
  private async pushTo(st: RoomState, me: Member, msg: Record<string, unknown>, now: number): Promise<string | null> {
    if (!isStaff(me)) return 'forbidden';
    if (st.mode !== 'webinar' || st.status === 'ended') return 'not_applicable';
    const kind = msg.kind === 'sprint' ? 'sprint' : msg.kind === 'application' ? 'application' : null;
    if (!kind) return 'push_kind';
    const id = typeof msg.id === 'string' ? msg.id : '';
    const target = st.members[id];
    if (!target || isStaff(target)) return 'not_in_room';
    const e = engOf(st);
    if (!e.avail[kind]) return 'push_kind';
    const open = e.pushes.filter((p) => p.open && p.kind === kind && p.ref === null);
    if (open.some((p) => !p.to || p.to.includes(id))) return 'already_open';
    const shared = open.find((p) => p.to);
    if (shared?.to) {
      shared.to = [...shared.to, id].slice(0, 500);
      const rt = await this.host.runtime();
      await rt.env.DB.prepare('UPDATE room_pushes SET targets = ?, target_count = ? WHERE room_id = ? AND id = ?').bind(JSON.stringify(shared.to), shared.to.length, st.id, shared.id).run().catch(() => null);
      await this.host.commit(now);
      return null;
    }
    this.pending = { t: 'push', kind: kind as PushKind, to: [id] };
    return null;
  }
  /** Set by pushTo when the room's own push should run next (RoomDO takes it). */
  pending: Record<string, unknown> | null = null;
  takePending() { const p = this.pending; this.pending = null; return p; }

  // ───────────── scores and the hot list ─────────────

  private hotMsg() { return { t: 'e2_hot', rows: this.hot, bought: this.bought, at: this.scoredAt }; }

  /** Scores everyone, writes them, and sends the team the hot list. */
  async score(now: number, force = false) {
    const st = this.host.st();
    if (!st || st.mode !== 'webinar') return;
    if (!force && st.status !== 'live') return;
    const d = await this.load();
    const rt = await this.host.runtime();
    const { engage2Config, roomScores, saveScores } = await import('./engage2-db');
    const cfg = engage2Config(rt);
    const names: Record<string, string> = {};
    const online = new Set<string>();
    for (const m of Object.values(st.members)) { names[m.id] = m.name; if (m.connected > 0) online.add(m.id); }
    const consent = new Set(engOf(st).optIn);
    let people: RoomPerson[] = [];
    try { people = await roomScores(rt, st.id, d, { weights: cfg.weights, online, consent, names }); } catch (e) { console.error('room scores', String(e).slice(0, 200)); return; }
    await saveScores(rt, st.id, people, now).catch((e) => console.error('room scores save', String(e).slice(0, 200)));
    this.hot = hotList(people, { min: cfg.hotMin }).map(hotRow);
    this.bought = people.filter((p) => p.bought).length;
    this.scoredAt = now;
    this.toStaff(this.hotMsg());
  }

  // ───────────── the live-only bonus ─────────────

  private async bonusNow(now: number) {
    if (this.bonus && now - this.bonus.at < 60_000) return this.bonus.b;
    const rt = await this.host.runtime();
    const { getBonus, bonusGrants, settleBonus } = await import('./engage2-db');
    const id = this.host.st()!.id;
    let b = await getBonus(rt, id).catch(() => null);
    // Not withdrawn yet: bring it up to date from the room's row and the real offer (the object may have slept through the moment).
    if (b && b.withdrawnAt == null) {
      const row = await rt.env.DB.prepare('SELECT * FROM rooms WHERE id = ?').bind(id).first<import('./rooms').RoomRow>().catch(() => null);
      if (row) b = await settleBonus(rt, row, now).catch(() => b);
    }
    const grants = b ? await bonusGrants(rt, this.host.st()!.id).catch(() => []) : [];
    this.bonus = { at: now, b, grants };
    return b;
  }
  private bonusFor(m: Member, b: Bonus | null) {
    const st = this.host.st()!;
    const mine = Boolean(m.leadId && this.bonus?.grants.includes(m.leadId));
    const v = bonusView(b, st.offer, { staff: isStaff(m), mine });
    return v && isStaff(m) ? { ...v, grants: this.bonus?.grants.length ?? 0 } : v;
  }
  private async sendBonus(now: number) {
    const st = this.host.st();
    if (!st) return;
    const b = await this.bonusNow(now);
    for (const m of Object.values(st.members)) if (m.connected > 0) this.host.deliver(m.id, { t: 'e2_bonus', bonus: this.bonusFor(m, b) });
  }
  /** Withdraws the bonus when its moment came (the offer window closed, or the session ended). */
  async checkBonus(now: number) {
    const st = this.host.st();
    if (!st || st.mode !== 'webinar') return;
    const d = await this.load();
    if (st.offer.open && !d.seenOpen) { d.seenOpen = true; await this.persist(); }
    const b = await this.bonusNow(now);
    if (!b) return;
    const due = bonusDue(b, { status: st.status, endedAt: st.endedAt }, st.offer, now, d.seenOpen);
    if (!due.withdraw || !due.reason) return;
    const rt = await this.host.runtime();
    const { withdrawBonus } = await import('./engage2-db');
    const at = due.reason === 'ended' ? st.endedAt ?? now : st.offer.closesAt && st.offer.closesAt <= now ? st.offer.closesAt : now;
    await withdrawBonus(rt, st.id, due.reason, at);
    this.bonus = null;
    await this.sendBonus(now);
  }

  /** The minute alarm: scores while live, the bonus's withdrawal, buyers who just received it. */
  async tick(now: number) {
    const st = this.host.st();
    if (!st || st.mode !== 'webinar') return;
    await this.checkBonus(now);
    const before = this.bonus?.grants.length ?? 0;
    this.bonus = null;
    await this.bonusNow(now);
    if ((this.bonus as { grants: string[] } | null)?.grants.length !== before) await this.sendBonus(now);
    if (st.status === 'live') await this.score(now);
    await this.persist();
  }
  /** The offer opened or closed. */
  async onOffer(now: number) { await this.checkBonus(now); await this.sendBonus(now); }
  /** The session ended: final scores, and the bonus if it ends with the session. */
  async onEnded(now: number) { await this.score(now, true); await this.checkBonus(now); }
}

export { E2_COPY };
