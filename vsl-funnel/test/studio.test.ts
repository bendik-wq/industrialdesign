import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, canPull, join, leave, newEngage, newRoomState, view } from '../src/rooms/state';
import {
  DEFAULT_STUDIO, STUDIO_COPY, canDirect, canLoadSlide, classifyHostCue, cleanStudioSettings, configureStudio, countdownView, parseStudioSettings, runOfShow, scriptFor, studioMeta, studioOf,
} from '../src/rooms/studio';
import { applyTemplate, createDeck, getDeck, listDecks, listTemplates, saveRoomStudio, saveTemplate, studioPageConfig } from '../src/rooms/studio-routes';
import { createRoom, getRoom } from '../src/rooms/rooms';
import { parseMaterial } from '../src/admin/materials';

// ───────────── A real SQLite database shaped like D1, with every migration applied ─────────────

interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const st = {
      sql,
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => { const r = db.prepare(sql).run(...norm()); return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const MIN = 60_000;
const T0 = Date.parse('2026-11-03T02:00:00Z');
let db: DatabaseSync;
let rt: Runtime;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  db = freshDb();
  rt = { env: { DB: d1(db), SESSION_SECRET: 'test-session-secret' }, settings: {}, reps: [], origin: 'https://apply.test', waitUntil: () => {} } as unknown as Runtime;
});
afterEach(() => { vi.useRealTimers(); });

const host: Identity = { id: 'hadmin', name: 'Josh Li', role: 'host' };
const cohost: Identity = { id: 'gco1', name: 'Mia Park', role: 'cohost' };
const ann: Identity = { id: 'rann', name: 'Ann Baker', role: 'attendee', leadId: 'l1', regId: 'r1' };
const bob: Identity = { id: 'rbob', name: 'Bob Cole', role: 'attendee', leadId: 'l2', regId: 'r2' };
const AVAIL = { application: true, sprint: true, deposit: true, vip: false, resources: [] as string[] };
/** A webinar room as the Durable Object makes it: Funnel HQ's studio defaults applied before anyone joins. */
function room(o: { offer?: boolean; green?: boolean } = {}) {
  const st = newRoomState({ id: 'rmstudio1234', mode: 'webinar', title: 'Live masterclass', startsAt: T0 + 10 * MIN, offerAvailable: o.offer ?? true });
  st.eng = newEngage({ avail: { ...AVAIL } });
  configureStudio(st, studioMeta(DEFAULT_STUDIO, true, 'Josh Li'));
  if (o.green === false) studioOf(st)!.greenDefault = false;
  for (const w of [host, cohost, ann, bob]) join(st, w, T0);
  return st;
}
const ok = (st: RoomState, who: string, msg: Record<string, unknown>, t = T0) => { const r = apply(st, who, msg, t); expect(r.error ?? null).toBeNull(); return r; };
const no = (st: RoomState, who: string, msg: Record<string, unknown>, err: string, t = T0) => { const r = apply(st, who, msg, t); expect(r.ok).toBe(false); expect(r.error).toBe(err); return r; };
const sv = (st: RoomState, who: string, t = T0) => view(st, st.members[who], t).studio!;

// ───────────── scenes ─────────────

describe('scene state machine', () => {
  it('starts on Funnel HQ’s first scene and switches with one message; every scene and layout is checked', () => {
    const st = room();
    expect(sv(st, 'rann').scene).toBe('intro');
    expect(sv(st, 'rann').layout).toBe('solo');
    for (const scene of ['main', 'brb', 'qa', 'offer', 'outro', 'intro']) {
      ok(st, 'hadmin', { t: 'studio_scene', scene }, T0 + 1000);
      expect(sv(st, 'rann').scene).toBe(scene);
      expect(st.studio!.sceneAt).toBe(T0 + 1000);
    }
    no(st, 'hadmin', { t: 'studio_scene', scene: 'party' }, 'bad_value');
    no(st, 'hadmin', { t: 'studio_scene', scene: 'main', layout: 'mosaic' }, 'bad_value');
    no(st, 'hadmin', { t: 'studio_scene', scene: 'slides' }, 'no_deck'); // slides need a deck first
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'main', layout: 'side' });
    expect(sv(st, 'rbob').layout).toBe('side');
    for (const layout of ['solo', 'side', 'speaker_screen', 'screen', 'grid']) { ok(st, 'hadmin', { t: 'studio_layout', layout }); expect(st.studio!.layout).toBe(layout); }
    no(st, 'hadmin', { t: 'studio_layout', layout: 'pip' }, 'bad_value');
  });

  it('slides: a deck goes on stage, pages move within it, and the scene leaves when the deck does', () => {
    const st = room();
    no(st, 'hadmin', { t: 'studio_deck', deck: { id: 'nope', pages: 3 } }, 'bad_value');
    no(st, 'hadmin', { t: 'studio_deck', deck: { id: 'dkabc12345', pages: 0 } }, 'bad_value');
    ok(st, 'hadmin', { t: 'studio_deck', deck: { id: 'dkabc12345', title: 'Masterclass', pages: 3 } });
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'slides' });
    ok(st, 'hadmin', { t: 'studio_page', delta: 1 });
    ok(st, 'hadmin', { t: 'studio_page', delta: 5 });
    expect(st.studio!.page).toBe(2); // clamped to the last page
    expect(apply(st, 'hadmin', { t: 'studio_page', delta: 1 }, T0).changed).toBe(false);
    ok(st, 'hadmin', { t: 'studio_page', n: 0 });
    expect(sv(st, 'rann')).toMatchObject({ scene: 'slides', page: 0, deck: { id: 'dkabc12345', pages: 3 } });
    ok(st, 'hadmin', { t: 'studio_deck', deck: null });
    expect(st.studio!.scene).toBe('main');
  });

  it('meetings have no studio', () => {
    const st = newRoomState({ id: 'rmmeet12345', mode: 'meeting', title: 'Kickoff', startsAt: null });
    join(st, host, T0);
    no(st, 'hadmin', { t: 'studio_scene', scene: 'main' }, 'not_applicable');
    expect(view(st, st.members.hadmin, T0)).not.toHaveProperty('studio');
  });
});

// ───────────── permissions: host, producer, co-host, attendee ─────────────

describe('permissions', () => {
  it('the host directs; a co-host can’t until the host makes them a producer; attendees never', () => {
    const st = room();
    no(st, 'rann', { t: 'studio_scene', scene: 'main' }, 'forbidden');
    no(st, 'gco1', { t: 'studio_scene', scene: 'main' }, 'forbidden');
    no(st, 'gco1', { t: 'studio_cue', cue: 'push:application' }, 'forbidden');
    no(st, 'rann', { t: 'studio_crew', id: 'gco1', producer: true }, 'forbidden');
    no(st, 'gco1', { t: 'studio_crew', id: 'gco1', producer: true }, 'forbidden'); // only the host makes producers
    no(st, 'hadmin', { t: 'studio_crew', id: 'rann', producer: true }, 'not_applicable'); // only co-hosts become producers
    const r = ok(st, 'hadmin', { t: 'studio_crew', id: 'gco1', producer: true });
    expect(r.out).toEqual([{ to: 'gco1', msg: { t: 'studio_role', producer: true, by: 'Josh Li' } }]);
    expect(canDirect(st, st.members.gco1)).toBe(true);
    expect(sv(st, 'gco1').me).toMatchObject({ direct: true, producer: true, green: false }); // producers work backstage, out of the green room
    ok(st, 'gco1', { t: 'studio_scene', scene: 'main', layout: 'grid' });
    ok(st, 'gco1', { t: 'studio_lower', on: true });
    ok(st, 'gco1', { t: 'studio_cue', cue: 'push:application' });
    // A producer still can't end the session or make other producers.
    no(st, 'gco1', { t: 'end' }, 'forbidden');
    no(st, 'gco1', { t: 'studio_crew', id: 'gco1', producer: false }, 'forbidden');
    ok(st, 'hadmin', { t: 'studio_crew', id: 'gco1', producer: false });
    no(st, 'gco1', { t: 'studio_scene', scene: 'intro' }, 'forbidden');
    // The host ends the session.
    ok(st, 'hadmin', { t: 'end' });
  });

  it('the audience never receives the backstage parts of the studio', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'studio_back', text: 'Mic check at 7:55' });
    const a = sv(st, 'rann') as Record<string, unknown>;
    for (const k of ['back', 'green', 'crew', 'ros', 'lowerDraft', 'tickerDraft']) expect(a).not.toHaveProperty(k);
    const hv = sv(st, 'hadmin') as Record<string, unknown>;
    expect(hv).toHaveProperty('back');
    expect(hv).toHaveProperty('green');
  });
});

// ───────────── the green room ─────────────

describe('green room', () => {
  it('a co-host waits backstage: the host sees and hears them, the audience neither sees nor can pull them', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'golive' });
    st.members.gco1.sessionId = 'sessCohost1'; st.members.gco1.tracks = [{ trackName: 'gco1-audio', kind: 'audio' }];
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id)).toEqual(['hadmin']);
    expect(view(st, st.members.hadmin, T0).stage.find((m) => m.id === 'gco1')).toMatchObject({ green: true });
    expect(canPull(st, 'rann', { sessionId: 'sessCohost1', trackName: 'gco1-audio' })).toBe(false);
    expect(canPull(st, 'hadmin', { sessionId: 'sessCohost1', trackName: 'gco1-audio' })).toBe(true);
    expect(sv(st, 'gco1').me.green).toBe(true);
    // Audio check, then the host brings them on.
    ok(st, 'gco1', { t: 'studio_ready', on: true });
    expect((sv(st, 'hadmin') as { green: { id: string; ready: boolean }[] }).green).toEqual([expect.objectContaining({ id: 'gco1', ready: true })]);
    no(st, 'rann', { t: 'studio_green', id: 'gco1', on: false }, 'forbidden');
    const r = ok(st, 'hadmin', { t: 'studio_green', id: 'gco1', on: false });
    expect(r.out).toEqual([{ to: 'gco1', msg: { t: 'studio_on_stage' } }]);
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id).sort()).toEqual(['gco1', 'hadmin']);
    expect(canPull(st, 'rann', { sessionId: 'sessCohost1', trackName: 'gco1-audio' })).toBe(true);
    // A reconnect keeps their place on stage.
    leave(st, 'gco1', T0 + 1000); join(st, cohost, T0 + 2000);
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id)).toContain('gco1');
    // The host can send them back.
    ok(st, 'hadmin', { t: 'studio_green', id: 'gco1', on: true });
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id)).toEqual(['hadmin']);
    no(st, 'hadmin', { t: 'studio_green', id: 'hadmin', on: true }, 'not_applicable');
    no(st, 'hadmin', { t: 'studio_green', id: 'rbob', on: true }, 'not_applicable'); // not on stage
  });

  it('an invited guest lands in the green room after accepting', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'golive' });
    ok(st, 'hadmin', { t: 'invite', id: 'rann' });
    ok(st, 'rann', { t: 'accept' });
    expect(st.members.rann.stage).toBe(true);
    expect(sv(st, 'rann').me.green).toBe(true);
    expect(view(st, st.members.rbob, T0).stage.map((m) => m.id)).not.toContain('rann');
    no(st, 'rbob', { t: 'studio_ready', on: true }, 'not_applicable');
  });

  it('the backstage chat reaches backstage people only', () => {
    const st = room();
    no(st, 'rann', { t: 'studio_back', text: 'hello' }, 'forbidden');
    const r = ok(st, 'gco1', { t: 'studio_back', text: 'Ready when you are' });
    expect(r.out.map((o) => o.to).sort()).toEqual(['gco1', 'hadmin']);
    expect(r.out[0].msg).toMatchObject({ t: 'studio_back', m: { name: 'Mia Park', text: 'Ready when you are' } });
  });

  it('a room with the green room off puts co-hosts straight on stage', () => {
    const st = room({ green: false });
    ok(st, 'hadmin', { t: 'golive' });
    expect(view(st, st.members.rann, T0).stage.map((m) => m.id).sort()).toEqual(['gco1', 'hadmin']);
  });
});

// ───────────── slides: no skipping ahead ─────────────

describe('slide access', () => {
  it('attendees load only pages the stage has shown, of the deck on stage, while live; staff load anything', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'studio_deck', deck: { id: 'dkdeck00001', title: 'Deck', pages: 10 } });
    expect(canLoadSlide(st, st.members.hadmin, 'dkdeck00001', 9)).toBe(true);
    expect(canLoadSlide(st, st.members.gco1, 'dkdeck00001', 5)).toBe(true);
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 0)).toBe(false); // not live, nothing shown
    ok(st, 'hadmin', { t: 'golive' });
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 0)).toBe(false); // deck chosen but not shown on stage yet
    ok(st, 'hadmin', { t: 'studio_page', n: 3 }); // rehearsing backstage while the main scene is up
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 3)).toBe(false);
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'slides' });
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 3)).toBe(true);
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 2)).toBe(true); // earlier pages stay available
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 4)).toBe(false); // no skipping ahead
    ok(st, 'hadmin', { t: 'studio_page', delta: 1 });
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', 4)).toBe(true);
    expect(canLoadSlide(st, st.members.rann, 'dkother0001', 0)).toBe(false);
    expect(canLoadSlide(st, st.members.rann, 'dkdeck00001', -1)).toBe(false);
    expect(canLoadSlide(st, null, 'dkdeck00001', 0)).toBe(false);
  });

  it('decks are stored per room', async () => {
    const r1 = await createRoom(rt, { mode: 'webinar', title: 'A', refType: 'none' });
    const r2 = await createRoom(rt, { mode: 'webinar', title: 'B', refType: 'none' });
    const id = (await createDeck(rt, r1.id, 'Masterclass <deck>', 12))!;
    expect(id).toMatch(/^dk[a-z0-9]{6,40}$/);
    expect(await createDeck(rt, r1.id, 'Too big', 301)).toBeNull();
    expect((await getDeck(rt, r1.id, id))!.title).toBe('Masterclass deck');
    expect(await getDeck(rt, r2.id, id)).toBeNull();
    expect((await listDecks(rt, r1.id)).length).toBe(1);
  });
});

// ───────────── cues call the room's own engagement actions ─────────────

describe('cues', () => {
  it('push the application, open the offer (with its scene), launch a quiz and a poll, pin a line', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'golive' });
    const app = ok(st, 'hadmin', { t: 'studio_cue', cue: 'push:application' });
    expect(app.effects).toEqual([{ type: 'pushed', push: expect.objectContaining({ kind: 'application', open: true, by: 'hadmin' }) }]);
    expect(st.eng!.pushes.filter((p) => p.open).map((p) => p.kind)).toEqual(['application']);

    const offer = ok(st, 'hadmin', { t: 'studio_cue', cue: 'offer:open' });
    expect(offer.effects).toEqual([{ type: 'offer', open: true }]);
    expect(st.studio!.scene).toBe('offer');

    // The deposit card needs the offer open in the room's state (the Durable Object sets it after the offer effect).
    no(st, 'hadmin', { t: 'studio_cue', cue: 'push:deposit' }, 'offer_closed');
    st.offer = { available: true, open: true, closesAt: T0 + 48 * 60 * MIN, label: '$5,000' };
    expect(ok(st, 'hadmin', { t: 'studio_cue', cue: 'push:deposit' }).effects[0]).toMatchObject({ type: 'pushed', push: { kind: 'deposit' } });

    ok(st, 'hadmin', { t: 'studio_cue', cue: 'quiz:dscr' });
    expect(st.eng!.quizzes.at(-1)).toMatchObject({ open: true, correct: 1 });
    no(st, 'hadmin', { t: 'studio_cue', cue: 'quiz:nope' }, 'not_found');

    ok(st, 'hadmin', { t: 'studio_cue', cue: 'poll', question: 'What would you buy first?', options: ['A competitor', 'A supplier', 'Not sure yet'] });
    expect(st.polls.at(-1)).toMatchObject({ question: 'What would you buy first?', open: true });

    const pin = ok(st, 'hadmin', { t: 'studio_cue', cue: 'pin', text: 'The deposit button is under the video.' });
    expect(pin.out[0].msg).toMatchObject({ t: 'chat', m: { text: 'The deposit button is under the video.' } });
    expect(st.chat.pinned).toBe(st.chat.seq);

    ok(st, 'hadmin', { t: 'studio_cue', cue: 'scene:qa' });
    expect(st.studio!.scene).toBe('qa');
    no(st, 'hadmin', { t: 'studio_cue', cue: 'launch:rockets' }, 'bad_value');
  });

  it('a cue the room refuses changes nothing', () => {
    const st = room({ offer: false });
    no(st, 'hadmin', { t: 'studio_cue', cue: 'offer:open' }, 'no_offer');
    expect(st.studio!.scene).toBe('intro');
    st.eng!.avail.sprint = false;
    no(st, 'hadmin', { t: 'studio_cue', cue: 'push:sprint' }, 'push_kind');
  });

  it('the script’s host lines become cues', () => {
    expect(classifyHostCue('OPEN OFFER')).toMatchObject({ cue: 'offer:open' });
    expect(classifyHostCue('SHOW TIMER')).toMatchObject({ cue: 'countdown:offer' });
    expect(classifyHostCue('TAKE QUESTIONS')).toMatchObject({ cue: 'scene:qa' });
    expect(classifyHostCue('POLL target_type')).toMatchObject({ cue: 'poll', preset: 'target_type' });
    expect(classifyHostCue('PIN The button is in the room tab.')).toMatchObject({ cue: 'pin', text: 'The button is in the room tab.' });
    expect(classifyHostCue('QUIZ dscr')).toMatchObject({ cue: 'quiz:dscr' });
    expect(classifyHostCue('Smile at the camera')).toMatchObject({ cue: null });
  });

  it('the live webinar script parses into a run of show with planned times and its cues', () => {
    const md = fs.readFileSync(`${node.cwd()}/public/materials/live-webinar.md`, 'utf8');
    const ros = runOfShow(parseMaterial(md));
    expect(ros.length).toBeGreaterThan(10);
    expect(ros[0]).toMatchObject({ index: 0, at: 0, planned: 300 }); // [00:00] to [05:00]
    expect(ros.every((s) => s.planned > 0 && s.paras.length > 0)).toBe(true);
    const cues = ros.flatMap((s) => s.cues.map((c) => c.cue));
    expect(cues).toContain('offer:open');
    expect(cues).toContain('countdown:offer');
    expect(cues).toContain('scene:qa');
    expect(cues).toContain('poll');
    expect(scriptFor({ ref_type: 'live', ref_id: 'ev1' })).toBe('live-webinar');
    expect(scriptFor({ ref_type: 'challenge', ref_id: 'challenge:c1:3' })).toBe('challenge-day-3');
    expect(scriptFor({ ref_type: 'live', ref_id: 'ev1' }, 'challenge-day-5')).toBe('challenge-day-5');
  });

  it('sections are stamped with the server’s time', () => {
    const st = room();
    no(st, 'gco1', { t: 'studio_section', n: 0 }, 'forbidden');
    ok(st, 'hadmin', { t: 'studio_section', n: 0 }, T0 + 5000);
    ok(st, 'hadmin', { t: 'studio_section', n: 1 }, T0 + 305_000);
    ok(st, 'hadmin', { t: 'studio_section', n: 0 }, T0 + 400_000); // going back keeps the first start
    expect(st.studio!.ros).toEqual({ section: 0, at: { 0: T0 + 5000, 1: T0 + 305_000 } });
  });
});

// ───────────── overlays ─────────────

describe('overlays', () => {
  it('the countdown is stamped from the server clock; a time sent by the browser is ignored', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'studio_countdown', kind: 'custom', sec: 300, label: 'Doors close', endsAt: T0 + 999 * MIN }, T0 + 7000);
    expect(sv(st, 'rann').countdown).toEqual({ kind: 'custom', endsAt: T0 + 7000 + 300_000, label: 'Doors close' });
    no(st, 'hadmin', { t: 'studio_countdown', kind: 'custom', sec: 5 }, 'bad_value');
    no(st, 'hadmin', { t: 'studio_countdown', kind: 'custom', sec: 5 * 3600 }, 'bad_value');
    ok(st, 'hadmin', { t: 'studio_countdown', kind: null });
    expect(sv(st, 'rann').countdown).toBeNull();
  });

  it('the offer countdown follows the offer’s real close time, and only while it is open', () => {
    const st = room();
    no(st, 'hadmin', { t: 'studio_countdown', kind: 'offer' }, 'offer_no_close');
    st.offer = { available: true, open: true, closesAt: T0 + 48 * 60 * MIN, label: '$5,000' };
    ok(st, 'hadmin', { t: 'studio_countdown', kind: 'offer' });
    expect(sv(st, 'rbob').countdown).toEqual({ kind: 'offer', endsAt: T0 + 48 * 60 * MIN, label: STUDIO_COPY.offerCloses });
    st.offer.closesAt = T0 + 30 * MIN; // the server moved it: the overlay follows
    expect(countdownView(st, st.studio!)!.endsAt).toBe(T0 + 30 * MIN);
    st.offer.open = false;
    expect(sv(st, 'rbob').countdown).toBeNull();
    // The offer scene brings its countdown with it when the offer is open.
    st.offer.open = true; st.studio!.countdown = null;
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'offer' });
    expect(sv(st, 'rbob').countdown).toMatchObject({ kind: 'offer' });
  });

  it('the break timer is server time too', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'studio_brb', sec: 300 }, T0 + 1234);
    expect(sv(st, 'rann').brbEndsAt).toBe(T0 + 1234 + 300_000);
    no(st, 'hadmin', { t: 'studio_brb', sec: 10 }, 'bad_value');
  });

  it('lower third, ticker, logo, and a chat message or question on screen with the first name only', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'golive' });
    expect(sv(st, 'rann').lower).toBeNull();
    ok(st, 'hadmin', { t: 'studio_lower', on: true });
    expect(sv(st, 'rann').lower).toEqual({ name: 'Josh Li', title: 'Founder, G&L M&A Advisory' });
    ok(st, 'hadmin', { t: 'studio_lower', name: 'Mia <b>Park</b>\u0007', title: 'Co-host', on: true });
    expect(sv(st, 'rann').lower!.name).toBe('Mia <b>Park</b>'); // control characters stripped; the canvas draws text, never HTML
    ok(st, 'hadmin', { t: 'studio_ticker', text: 'Questions go in the Q&A tab', on: true });
    expect(sv(st, 'rann').ticker).toBe('Questions go in the Q&A tab');
    ok(st, 'hadmin', { t: 'studio_ticker', text: '', on: true });
    expect(sv(st, 'rann').ticker).toBeNull(); // nothing to show
    ok(st, 'hadmin', { t: 'studio_logo', on: false });
    expect(sv(st, 'rann').logo).toBe(false);
    ok(st, 'rann', { t: 'chat', text: 'How do lenders treat seller rollover?' });
    ok(st, 'hadmin', { t: 'studio_highlight', kind: 'chat', mid: st.chat.seq });
    expect(sv(st, 'rbob').highlight).toEqual({ kind: 'chat', name: 'Ann', text: 'How do lenders treat seller rollover?' });
    ok(st, 'rbob', { t: 'ask', text: 'What if the seller wants all cash?' });
    ok(st, 'hadmin', { t: 'studio_highlight', kind: 'question', mid: st.qaSeq });
    expect(sv(st, 'rann').highlight).toMatchObject({ kind: 'question', name: 'Bob' });
    no(st, 'hadmin', { t: 'studio_highlight', kind: 'chat', mid: 999 }, 'not_found');
    no(st, 'rann', { t: 'studio_highlight', kind: null }, 'forbidden');
    ok(st, 'hadmin', { t: 'studio_highlight', kind: null });
    expect(sv(st, 'rann').highlight).toBeNull();
  });
});

// ───────────── Funnel HQ settings and templates ─────────────

describe('settings and templates', () => {
  it('cleans settings: bad colours, asset ids and scenes fall back; strings are bounded', () => {
    const s = cleanStudioSettings({ colors: { bg: 'red', accent: '#123456' }, logo: 'javascript:alert(1)', music: 'sa0123456789', scene: 'party', layout: 'grid', introTitle: 'x'.repeat(500), offerPoints: 'One\nTwo\n\nThree', script: '../etc' });
    expect(s.colors).toEqual({ bg: DEFAULT_STUDIO.colors.bg, accent: '#123456', text: DEFAULT_STUDIO.colors.text });
    expect(s.logo).toBeNull();
    expect(s.music).toBe('sa0123456789');
    expect(s.scene).toBe('intro');
    expect(s.layout).toBe('grid');
    expect(s.introTitle.length).toBe(120);
    expect(s.offerPoints).toEqual(['One', 'Two', 'Three']);
    expect(s.script).toBeNull();
    expect(parseStudioSettings('{not json')).toEqual(DEFAULT_STUDIO);
    expect(studioMeta(DEFAULT_STUDIO, false).on).toBe(false); // ROOM_STUDIO off wins
  });

  it('a room’s settings save, become a template, and apply to another room', async () => {
    const a = await createRoom(rt, { mode: 'webinar', title: 'Live one', refType: 'none' });
    const b = await createRoom(rt, { mode: 'webinar', title: 'Live two', refType: 'none' });
    await saveRoomStudio(rt, a, { colors: { bg: '#112233', accent: '#c9a227', text: '#ffffff' }, introTitle: 'The structure session', scene: 'main' });
    const fresh = (await getRoom(rt, a.id))!;
    expect(parseStudioSettings(fresh.studio)).toMatchObject({ introTitle: 'The structure session', scene: 'main', colors: { bg: '#112233' } });
    expect(await saveTemplate(rt, { name: '  ', settings: {} })).toBeNull();
    const tid = (await saveTemplate(rt, { name: 'Masterclass show', settings: parseStudioSettings(fresh.studio) }))!;
    expect((await listTemplates(rt)).map((t) => t.name)).toEqual(['Masterclass show']);
    await applyTemplate(rt, tid, b);
    const b2 = (await getRoom(rt, b.id))!;
    expect(parseStudioSettings(b2.studio)).toMatchObject({ introTitle: 'The structure session', colors: { bg: '#112233' } });
    expect(await applyTemplate(rt, 'stnope', b)).toBeNull();
    // The page config: branding for everyone, pdf.js (pinned with integrity) for staff only.
    const att = studioPageConfig(b2, { id: 'rann', name: 'Ann', role: 'attendee' }, true)!;
    expect(att.brand.introTitle).toBe('The structure session');
    expect(att.pdfjs).toBeNull();
    const hostCfg = studioPageConfig(b2, { id: 'hadmin', name: 'Josh', role: 'host' }, true)!;
    expect(hostCfg.pdfjs!.src).toMatch(/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/3\.11\.174\//);
    expect(hostCfg.pdfjs!.integrity).toMatch(/^sha384-/);
  });
});

// ───────────── copy ─────────────

describe('copy', () => {
  it('every studio string passes the copy rules', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (typeof v === 'function') strings.push(String((v as (a: string, b: string) => string)('3', '7'))); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(STUDIO_COPY);
    walk(DEFAULT_STUDIO.lowerTitle);
    expect(strings.length).toBeGreaterThan(100);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[!—]/);
    }
  });
});
