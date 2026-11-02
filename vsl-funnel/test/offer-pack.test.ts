import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { type Identity, type RoomState, apply, join, newEngage, newRoomState, view } from '../src/rooms/state';
import { DEFAULT_STUDIO, STUDIO_COPY, SCENES, classifyHostCue, cleanStudioSettings, configureStudio, parseStudioSettings, runOfShow, studioMeta, studioOf } from '../src/rooms/studio';
import { DEFAULT_PACK, MONEY_CLAIM, PACK_COPY, cleanAnchor, cleanPack, cleanStack, classifyPackCue, packIssues } from '../src/rooms/studio-pack';
import { feeBands, generosity, moneyBackDays, packConfig, packPrices, priceText, refundDays } from '../src/rooms/studio-pack-terms';
import { pathsFor, saveRoomStudio, studioPageConfig } from '../src/rooms/studio-routes';
import { createRoom, getRoom } from '../src/rooms/rooms';
import { parseMaterial } from '../src/admin/materials';
import { DEPOSIT_REFUND_TERMS } from '../src/sales/deposit';
import { FEE_BY_REVENUE } from '../src/sales/contracts';
import { MONEY_BACK_HEADLINE } from '../src/sales/guarantee';

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
const rtWith = (settings: Record<string, string>) => ({ ...rt, settings } as unknown as Runtime);
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
const AVAIL = { application: true, sprint: true, deposit: true, vip: false, resources: [] as string[] };
function room(pack: Partial<typeof DEFAULT_PACK> = {}) {
  const st = newRoomState({ id: 'rmpack123456', mode: 'webinar', title: 'Live masterclass', startsAt: T0 + 10 * MIN, offerAvailable: true });
  st.eng = newEngage({ avail: { ...AVAIL } });
  configureStudio(st, studioMeta({ ...DEFAULT_STUDIO, pack: { ...DEFAULT_PACK, ...pack } }, true, 'Josh Li'));
  studioOf(st)!.greenDefault = false;
  for (const w of [host, cohost, ann]) join(st, w, T0);
  return st;
}
const ok = (st: RoomState, who: string, msg: Record<string, unknown>, t = T0) => { const r = apply(st, who, msg, t); expect(r.error ?? null).toBeNull(); return r; };
const no = (st: RoomState, who: string, msg: Record<string, unknown>, err: string, t = T0) => { const r = apply(st, who, msg, t); expect(r.ok).toBe(false); expect(r.error).toBe(err); return r; };
const sv = (st: RoomState, who: string, t = T0) => view(st, st.members[who], t).studio!;
const openOffer = (st: RoomState) => { st.offer = { available: true, open: true, closesAt: T0 + 48 * 60 * MIN, label: '$5,000' }; };

// ───────────── settings ─────────────

describe('pack settings (Funnel HQ → Rooms → Studio)', () => {
  it('defaults: deposit card, five stack parts each with its objection, three comparison rows', () => {
    const p = cleanPack({});
    expect(p).toEqual(DEFAULT_PACK);
    expect(p.offerCard).toBe('deposit');
    expect(p.stack).toHaveLength(5);
    expect(p.stack.every((x) => x.objection && x.title)).toBe(true);
    expect(p.anchor).toHaveLength(3);
    expect(parseStudioSettings(null).pack).toEqual(DEFAULT_PACK);
  });

  it('a stack line with a typed money figure or a value claim is left out, with the reason', () => {
    const issues: string[] = [];
    const stack = cleanStack([
      'I don’t have the cash | Deal structure worth $97,000 | none',
      'Where do I start | Total value 50k | engagement',
      'Lenders | Lender introductions | deposit',
      'Help | The 3C model | made-up-key',
      { objection: 'Time', title: 'Weekly working sessions', price: 'sprint' },
    ], issues);
    expect(stack.map((x) => x.title)).toEqual(['Lender introductions', 'The 3C model', 'Weekly working sessions']);
    expect(stack.map((x) => x.price)).toEqual(['deposit', 'none', 'sprint']);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/real prices from settings only/);
    for (const s of ['$5,000', '50k', '1.2m', '250,000', 'Valued at', 'worth it']) expect(MONEY_CLAIM.test(s), s).toBe(true);
    for (const s of ['The 1.5x test', 'Ninety days done with you', 'Your buy box']) expect(MONEY_CLAIM.test(s), s).toBe(false);
  });

  it('comparison rows need a label and a figure; a typed "Illustrative:" prefix is dropped because the screen adds it', () => {
    const rows = cleanAnchor('An adviser | Illustrative: $15K a month | retainer\nNo figure here\n | $5K | no label\nWaiting | $200K |');
    expect(rows).toEqual([{ label: 'An adviser', figure: '$15K a month', note: 'retainer' }, { label: 'Waiting', figure: '$200K', note: '' }]);
  });

  it('round-trips through the studio settings, with limits, and saves to the room (templates carry it)', async () => {
    const s = cleanStudioSettings({ pack: { offerCard: 'paths', bridgeLine: '  The teaching is done. <b>Here</b> is how we do this with you.  ', stack: 'A | B | engagement\n'.repeat(12), anchor: 'x | y | z\n'.repeat(9) } });
    expect(s.pack.offerCard).toBe('paths');
    expect(s.pack.bridgeLine).toBe('The teaching is done. b Here /b is how we do this with you.');
    expect(s.pack.stack).toHaveLength(7);
    expect(s.pack.anchor).toHaveLength(4);
    expect(cleanStudioSettings({ pack: { offerCard: 'everything' } }).pack.offerCard).toBe('deposit');
    // Other studio fields saved later keep the pack.
    const r = await createRoom(rt, { mode: 'webinar', title: 'Live one', refType: 'none' });
    await saveRoomStudio(rt, r, { pack: { offerCard: 'paths', bridgeLine: 'One decision tonight.' } });
    await saveRoomStudio(rt, (await getRoom(rt, r.id))!, { introTitle: 'The structure session' });
    const saved = parseStudioSettings((await getRoom(rt, r.id))!.studio);
    expect(saved.pack).toMatchObject({ offerCard: 'paths', bridgeLine: 'One decision tonight.' });
    expect(saved.pack.stack).toEqual(DEFAULT_PACK.stack);
    expect(studioMeta(saved, true).pack).toEqual({ steps: 6, offerCard: 'paths', line: 'One decision tonight.' });
  });

  it('copy-rule warnings for the owner’s own lines', () => {
    expect(packIssues(DEFAULT_PACK)).toEqual([]);
    const bad = cleanPack({ bridgeLine: 'This might change everything!' });
    expect(packIssues(bad).join(' ')).toMatch(/hedge/);
    expect(packIssues(bad).join(' ')).toMatch(/exclamation/);
  });
});

// ───────────── real prices and real terms ─────────────

describe('prices: only what we sell, from settings', () => {
  it('the deposit, the engagement fee by size and nothing else by default', () => {
    const p = packPrices(rt, 'live');
    expect(p.deposit).toBe('$5,000');
    expect(p.engagement).toBe('$40K to $70K');
    expect(p.fees).toEqual([{ range: '$1M to $3M', label: '$40K' }, { range: '$3M to $10M', label: '$50K' }, { range: '$10M to $25M', label: '$60K' }, { range: '$25M to $50M', label: '$70K' }]);
    expect(feeBands().map((b) => b.fee)).toEqual([FEE_BY_REVENUE['1_3m'], FEE_BY_REVENUE['3_10m'], FEE_BY_REVENUE['10_25m'], FEE_BY_REVENUE['25_50m']]);
    // The Sprint isn't on sale without a payment provider; a live webinar has no ticket price unless one is set.
    expect(p.sprint).toBeNull();
    expect(p.ticket).toBeNull();
    expect(priceText(p, 'sprint')).toBeNull();
    expect(priceText(p, 'ticket')).toBeNull();
    expect(priceText(p, 'none')).toBeNull();
  });

  it('follows the settings: deposit amount, Sprint price and name, ticket by room kind, the intake cap', () => {
    const r = rtWith({ ENGAGEMENT_DEPOSIT: '7500', WHOP_API_KEY: 'k', WEBINAR_PASS: 'upsell', WEBINAR_PASS_PRICE: '2500', LIVE_TICKET_PRICE: '100', ENGAGEMENT_INTAKE_CAP: '6' });
    const p = packPrices(r, 'live');
    expect(p).toMatchObject({ deposit: '$7,500', sprint: { name: 'First Deal Sprint', label: '$2,500' }, ticket: '$100', depositCap: 6 });
    expect(priceText(p, 'deposit')).toBe('$7,500 deposit');
    expect(priceText(p, 'sprint')).toBe('First Deal Sprint $2,500');
    expect(packPrices(rtWith({}), 'challenge').ticket).toBe('$100'); // CHALLENGE_PRICE blank = 100
    expect(packPrices(rtWith({ CHALLENGE_PRICE: '0' }), 'challenge').ticket).toBeNull();
    expect(packPrices(rtWith({ WHOP_API_KEY: 'k', WEBINAR_PASS: 'off' }), 'live').sprint).toBeNull();
  });

  it('the page config shows only those prices, and no total or value anywhere', () => {
    const cfg = packConfig(rtWith({ WHOP_API_KEY: 'k', LIVE_TICKET_PRICE: '100' }), { ref_type: 'live' }, { ...DEFAULT_PACK, stack: [...DEFAULT_PACK.stack, { objection: 'Smaller first', title: 'The Sprint credit', price: 'sprint' }] });
    const real = new Set(['$5,000', '$40K', '$50K', '$60K', '$70K', '$3,000', '$100']);
    const shown = JSON.stringify({ stack: cfg.stack, why: cfg.why, ours: cfg.anchor.ours }).match(/\$[\d,]+K?(?![\d,KM])/g) ?? []; // prices ("$1M to $3M" are revenue bands, not prices)
    expect(shown.length).toBeGreaterThan(5);
    for (const m of shown) expect(real.has(m), m).toBe(true);
    expect(JSON.stringify(cfg.stack)).not.toMatch(/total|value|worth/i);
    expect(cfg.stack.items[0].price).toBe('$40K to $70K by size');
    expect(cfg.stack.items.at(-1)!.price).toBe('First Deal Sprint $3,000');
    expect(cfg.stack.reveal).toMatchObject({ today: '$5,000 deposit today', ticket: 'Your $100 ticket comes off the deposit.' });
    expect(cfg.anchor.ours.figure).toBe('$40K to $70K by size');
  });

  it('the generosity line is built from the real terms', () => {
    expect(refundDays()).toBe(Number(/within (\d+) days/.exec(DEPOSIT_REFUND_TERMS)![1]));
    expect(moneyBackDays()).toBe(Number(/(\d+)-day/.exec(MONEY_BACK_HEADLINE)![1]));
    const plain = generosity(packPrices(rt, 'live'));
    expect(plain.short).toBe('Why the terms are this generous: the $5,000 deposit is credited in full against the fee, it is refunded if you decide not to sign, and you have 7 days money-back after signing.');
    expect(plain.lines.join(' ')).toMatch(/within 14 days of your onboarding call/);
    expect(plain.lines.join(' ')).not.toMatch(/capped|ticket|Sprint/);
    const full = generosity(packPrices(rtWith({ WHOP_API_KEY: 'k', LIVE_TICKET_PRICE: '100', ENGAGEMENT_INTAKE_CAP: '6' }), 'live'));
    expect(full.short).toMatch(/your \$100 ticket comes off it/);
    expect(full.lines).toContain('Places are capped at 6 a week because the same team works on every deal.');
    expect(full.lines).toContain('The First Deal Sprint ($3,000) is credited in full against the engagement if you continue.');
  });
});

// ───────────── the live part ─────────────

describe('pitch scenes in the room', () => {
  it('the three pitch scenes switch like any scene; the first one starts the pitch clock (server time) once', () => {
    expect(SCENES).toEqual(expect.arrayContaining(['bridge', 'stack', 'anchor']));
    const st = room();
    no(st, 'rann', { t: 'studio_scene', scene: 'bridge' }, 'forbidden');
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'main' }, T0 + 1000);
    expect(sv(st, 'hadmin').pack.pitchAt).toBeNull();
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'bridge' }, T0 + 50 * MIN);
    expect(sv(st, 'rann').scene).toBe('bridge');
    ok(st, 'hadmin', { t: 'studio_scene', scene: 'stack' }, T0 + 60 * MIN);
    expect(sv(st, 'hadmin').pack.pitchAt).toBe(T0 + 50 * MIN);
    expect('pitchAt' in sv(st, 'rann').pack).toBe(false); // the audience doesn't get the team's clock
    ok(st, 'hadmin', { t: 'studio_pack', op: 'clock' }, T0 + 70 * MIN);
    expect(sv(st, 'hadmin').pack.pitchAt).toBe(T0 + 70 * MIN);
  });

  it('the host advances the stack one part at a time, within its parts and the price step', () => {
    const st = room();
    expect(sv(st, 'rann').pack).toMatchObject({ step: 0, steps: 6 });
    no(st, 'rann', { t: 'studio_pack', op: 'step', delta: 1 }, 'forbidden');
    no(st, 'gco1', { t: 'studio_pack', op: 'step', delta: 1 }, 'forbidden'); // a co-host who isn't a producer
    for (let i = 0; i < 9; i++) ok(st, 'hadmin', { t: 'studio_pack', op: 'step', delta: 1 });
    expect(sv(st, 'rann').pack.step).toBe(6);
    expect(apply(st, 'hadmin', { t: 'studio_pack', op: 'step', delta: 1 }, T0).changed).toBe(false);
    ok(st, 'hadmin', { t: 'studio_pack', op: 'step', n: 2 });
    expect(sv(st, 'rann').pack.step).toBe(2);
    ok(st, 'hadmin', { t: 'studio_pack', op: 'step', n: -5 });
    expect(sv(st, 'rann').pack.step).toBe(0);
    no(st, 'hadmin', { t: 'studio_pack', op: 'step', n: 'x' }, 'bad_value');
    no(st, 'hadmin', { t: 'studio_pack', op: 'dance' }, 'bad_value');
    // A producer can run it too.
    ok(st, 'hadmin', { t: 'studio_crew', id: 'gco1', producer: true });
    ok(st, 'gco1', { t: 'studio_cue', cue: 'pack:next' });
    expect(sv(st, 'rann').pack.step).toBe(1);
  });

  it('the transition line: Funnel HQ’s default, the host’s live edit wins for the session', () => {
    const st = room({ bridgeLine: 'The teaching is done.' });
    expect(sv(st, 'rann').pack.line).toBe('The teaching is done.');
    ok(st, 'hadmin', { t: 'studio_pack', op: 'line', text: '  Here is why the engagement exists.\n' });
    expect(sv(st, 'rann').pack.line).toBe('Here is why the engagement exists.');
    configureStudio(st, studioMeta({ ...DEFAULT_STUDIO, pack: { ...DEFAULT_PACK, bridgeLine: 'Something else' } }, true));
    expect(sv(st, 'rann').pack.line).toBe('Here is why the engagement exists.');
  });

  it('both paths: one cue pushes the deposit and the Sprint; the deposit still needs the offer open', () => {
    const st = room();
    ok(st, 'hadmin', { t: 'golive' });
    no(st, 'hadmin', { t: 'studio_cue', cue: 'push:paths' }, 'offer_closed');
    expect(st.eng!.pushes).toHaveLength(0);
    openOffer(st);
    const r = ok(st, 'hadmin', { t: 'studio_cue', cue: 'push:paths' });
    expect(r.effects.map((e) => (e as { push: { kind: string } }).push.kind)).toEqual(['deposit', 'sprint']);
    expect(view(st, st.members.rann, T0).eng!.pushes.map((p: { kind: string }) => p.kind)).toEqual(['deposit', 'sprint']);
    // A deposit-card room: push:deposit stays one card.
    const st2 = room();
    ok(st2, 'hadmin', { t: 'golive' }); openOffer(st2);
    expect(ok(st2, 'hadmin', { t: 'studio_cue', cue: 'push:deposit' }).effects).toHaveLength(1);
    // A two-paths room: the deposit cue pushes both.
    const st3 = room({ offerCard: 'paths' });
    ok(st3, 'hadmin', { t: 'golive' }); openOffer(st3);
    expect(sv(st3, 'rann').pack.offerCard).toBe('paths');
    expect(ok(st3, 'hadmin', { t: 'studio_cue', cue: 'push:deposit' }).effects).toHaveLength(2);
    // Without the Sprint on sale, the paths cue pushes the deposit alone.
    const st4 = room();
    st4.eng!.avail.sprint = false;
    ok(st4, 'hadmin', { t: 'golive' }); openOffer(st4);
    expect(ok(st4, 'hadmin', { t: 'studio_cue', cue: 'push:paths' }).effects).toHaveLength(1);
  });

  it('run-of-show cues: PRE-PITCH, SHOW STACK, STACK NEXT, SHOW COMPARISON, PUSH PATHS, in both pitch scripts', () => {
    expect(classifyHostCue('PRE-PITCH')).toMatchObject({ cue: 'scene:bridge' });
    expect(classifyHostCue('SHOW STACK')).toMatchObject({ cue: 'scene:stack' });
    expect(classifyHostCue('STACK NEXT')).toMatchObject({ cue: 'pack:next' });
    expect(classifyHostCue('SHOW COMPARISON')).toMatchObject({ cue: 'scene:anchor' });
    expect(classifyHostCue('PUSH PATHS')).toMatchObject({ cue: 'push:paths' });
    expect(classifyPackCue('OPEN OFFER')).toBeNull();
    for (const id of ['live-webinar', 'challenge-day-5']) {
      const ros = runOfShow(parseMaterial(fs.readFileSync(`${node.cwd()}/public/materials/${id}.md`, 'utf8')));
      const cues = ros.flatMap((s) => s.cues.map((c) => c.cue));
      for (const c of ['scene:bridge', 'scene:stack', 'scene:anchor']) expect(cues, `${id} ${c}`).toContain(c);
      // The transition comes before the offer opens.
      const bridgeAt = ros.findIndex((s) => s.cues.some((c) => c.cue === 'scene:bridge'));
      const openAt = ros.findIndex((s) => s.cues.some((c) => c.cue === 'offer:open'));
      expect(bridgeAt).toBeGreaterThanOrEqual(0);
      expect(bridgeAt).toBeLessThanOrEqual(openAt);
      const s = ros[bridgeAt].cues.findIndex((c) => c.cue === 'scene:bridge'), o = ros[bridgeAt].cues.findIndex((c) => c.cue === 'offer:open');
      if (bridgeAt === openAt) expect(s).toBeLessThan(o);
    }
  });
});

// ───────────── the page and the paths endpoint ─────────────

describe('the room page and the two paths', () => {
  it('the page config carries the pack (with prices) when the route passes the runtime', async () => {
    const r = await createRoom(rt, { mode: 'webinar', title: 'Live one', refType: 'none' });
    const cfg = studioPageConfig(r, { id: 'rann', name: 'Ann', role: 'attendee' }, true, rt)!;
    expect(cfg.pack!.prices.deposit).toBe('$5,000');
    expect(cfg.pack!.why.short).toMatch(/^Why the terms are this generous/);
    expect(studioPageConfig(r, { id: 'rann', name: 'Ann', role: 'attendee' }, true)!.pack).toBeNull();
  });

  it('paths without a lead: list prices only, nothing personal', async () => {
    const r = await createRoom(rt, { mode: 'webinar', title: 'Live one', refType: 'none' });
    const out = await pathsFor(rt, r, { id: 'gx', leadId: null });
    expect(out).toMatchObject({ lead: false, deposit: null, sprint: null, prices: { deposit: '$5,000' } });
  });
});

// ───────────── copy ─────────────

describe('copy', () => {
  it('every offer pack string passes the copy rules (no hedges, no exclamation marks, no em dashes)', () => {
    const strings: string[] = [];
    const walk = (v: unknown) => { if (typeof v === 'string') strings.push(v); else if (typeof v === 'function') strings.push(String((v as (a: string, b: string) => string)('3', '7'))); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
    walk(PACK_COPY);
    walk(DEFAULT_PACK);
    walk(packConfig(rtWith({ WHOP_API_KEY: 'k', LIVE_TICKET_PRICE: '100', ENGAGEMENT_INTAKE_CAP: '6' }), { ref_type: 'live' }, DEFAULT_PACK));
    walk(STUDIO_COPY.scenes);
    walk(STUDIO_COPY.shortcuts);
    expect(strings.length).toBeGreaterThan(80);
    for (const s of strings) {
      expect(auditCopy(s), s).toEqual([]);
      expect(s, s).not.toMatch(/[!—]/);
      expect(s, s).not.toMatch(/\bfree (call|session|consult)/i);
    }
  });
});
