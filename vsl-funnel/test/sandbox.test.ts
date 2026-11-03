import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAN, SANDBOX_CSP, cleanInput, detail, liveTimes, readOnlyRuntime, sandboxCallSession, sandboxPage, simulate, strategyTimes } from '../src/admin/sandbox';
import { auditCopy } from '../src/content/copy-rules';
import { inCallingHours, callingZones } from '../src/integrations/elevenlabs';
import { inTextingHours } from '../src/integrations/sms';
import { inQuiet, reminderTimes } from '../src/live/lifecycle';
import { SETTINGS } from '../src/settings';

// @ts-expect-error vite raw import of a browser script
import pageJs from '../public/assets/sandbox.js?raw';

const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const read = (p: string) => fs.readFileSync(`${node.cwd()}/${p}`, 'utf8');

const base = Object.fromEntries(SETTINGS.map((x) => [x.key, ''])) as Record<string, string>;
/** A stand-in database that records every statement and refuses anything that isn't a read. */
function makeRt(over: Record<string, string> = {}) {
  const sql: string[] = [];
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => { throw new Error('write'); } };
  const DB = { prepare: (q: string) => { sql.push(q); return stmt; }, batch: async () => { throw new Error('write'); } };
  const rt = { settings: { ...base, SALES_TIMEZONE: 'Australia/Sydney', SITE_NAME: 'G&L', ...over }, env: { DB }, origin: 'https://apply.test', reps: [], waitUntil: () => undefined } as never;
  return { rt, sql };
}
const ANCHOR = Date.parse('2026-11-03T00:00:00Z');
const run = (journey: 'live' | 'strategy', lead: Record<string, unknown> = {}, choices: Record<string, unknown> = {}, over: Record<string, string> = {}) => {
  const { rt } = makeRt(over);
  const inp = cleanInput({ journey, anchor: ANCHOR, lead, choices }, ANCHOR);
  return { sim: simulate(rt, inp), inp, rt };
};
const sent = (s: ReturnType<typeof simulate>, ch?: string) => s.events.filter((e) => e.status === 'sent' && (!ch || e.ch === ch));

afterEach(() => vi.unstubAllGlobals());

describe('Sandbox simulation follows the real rules', () => {
  it('quiet hours: a London lead’s 3-hour email for a 7 pm Sydney session falls in their quiet hours and is held back', () => {
    const { sim, rt, inp } = run('live', { country: 'GB', tz: 'Europe/London' });
    const T = liveTimes(rt, inp);
    const at = reminderTimes(T.start).r3h;
    expect(inQuiet(at, 'Europe/London', { from: 22, to: 7 })).toBe(true);
    const r3h = sim.events.find((e) => e.id === 'e:r3h')!;
    expect(r3h.status).toBe('skipped');
    expect(r3h.reason).toMatch(/quiet hours/);
    // The 24-hour email waits for the end of their quiet hours instead of going at 5 am.
    const r24 = sim.events.find((e) => e.id === 'e:r24h')!;
    expect(r24.status).toBe('sent');
    expect(inQuiet(r24.at, 'Europe/London', { from: 22, to: 7 })).toBe(false);
  });

  it('every text goes inside texting hours, every AI call inside calling hours', () => {
    for (const country of ['AU', 'US', 'GB', 'NZ'] as const) {
      for (const j of ['live', 'strategy'] as const) {
        const { sim } = run(j, { country, tz: undefined }, { appliesAt: 'weekday_night' });
        const zones = callingZones(sim.phone)!;
        for (const e of sent(sim, 'sms')) expect(inTextingHours(e.at, zones), `${country} ${j} ${e.title}`).toBe(true);
        for (const e of sent(sim, 'call')) expect(inCallingHours(e.at, zones), `${country} ${j} ${e.title}`).toBe(true);
      }
    }
  });

  it('consent: no "text me" means no texts, no "call me" means no calls', () => {
    const a = run('live', { textOk: false }).sim;
    expect(sent(a, 'sms')).toEqual([]);
    expect(a.events.filter((e) => e.ch === 'sms').every((e) => /text box/.test(e.reason ?? ''))).toBe(true);
    const b = run('live', { callOk: false }).sim;
    expect(sent(b, 'call')).toEqual([]);
    expect(b.events.some((e) => /call box/.test(e.reason ?? ''))).toBe(true);
    const c = run('strategy', { callOk: false, textOk: false }).sim;
    expect([...sent(c, 'call'), ...sent(c, 'sms')]).toEqual([]);
  });

  it('a country we don’t call or text gets email only, with the reason', () => {
    const { sim } = run('live', { country: 'NO', tz: 'Europe/Oslo' });
    expect([...sent(sim, 'call'), ...sent(sim, 'sms')]).toEqual([]);
    expect(sim.events.some((e) => /country we don’t call or text/.test(e.reason ?? ''))).toBe(true);
    expect(sent(sim, 'email').length).toBeGreaterThan(3);
  });

  it('bought in the session: no replay pitch, no "didn’t buy" call; the welcome email and thank-you call instead', () => {
    const { sim } = run('live', {}, { buys: 'live' });
    const ids = sent(sim).map((e) => e.id);
    expect(ids).not.toContain('e:replay');
    expect(ids).not.toContain('e:replay_last');
    expect(ids).not.toContain('e:post:nobuy_questions');
    expect(ids.some((i) => i.startsWith('c:w_post_nobuy'))).toBe(false);
    expect(ids).toContain('e:deposit_welcome');
    expect(ids.some((i) => i.startsWith('c:w_post_bought'))).toBe(true);
    expect(sim.events.find((e) => e.id === 'e:replay_last')?.reason).toMatch(/Already bought/);
  });

  it('under $1M revenue the deposit can’t be bought (the server refuses it)', () => {
    const { sim } = run('live', { revenue: 'lt1m' }, { buys: 'live' });
    expect(sim.events.find((e) => e.id === 'x:nobuy')?.status).toBe('skipped');
    expect(sent(sim).some((e) => e.ch === 'purchase')).toBe(false);
  });

  it('STOP to the first text stops every text and the webinar calls; emails keep coming (the real rule)', () => {
    const { sim } = run('live', {}, { optOut: 'text' });
    const stop = sim.events.find((e) => e.id === 'x:stop')!;
    expect(stop).toBeTruthy();
    expect(sent(sim, 'sms').filter((e) => e.at > stop.at)).toEqual([]);
    expect(sent(sim, 'call').filter((e) => e.at > stop.at)).toEqual([]);
    expect(sent(sim, 'email').filter((e) => e.at > stop.at).length).toBeGreaterThan(0);
  });

  it('"stop calling" on a call stops calls, texts and marketing emails (the live reminders still go: the real rule)', () => {
    const st = run('strategy', {}, { optOut: 'call' }).sim;
    const first = sent(st, 'call')[0];
    expect(first.sub).toMatch(/asked not to be called/);
    expect(sent(st).filter((e) => e.at > first.at && ['email', 'sms', 'call'].includes(e.ch))).toEqual([]);
    const lv = run('live', {}, { optOut: 'call' }).sim;
    const f2 = sent(lv, 'call')[0];
    const after = sent(lv).filter((e) => e.at > f2.at && ['email', 'sms', 'call'].includes(e.ch));
    expect(after.filter((e) => e.ch !== 'email')).toEqual([]);
    // sendDueMessages skips only the replay emails for an unsubscribed lead; the session reminders are not marketing.
    expect(after.every((e) => !['e:replay', 'e:replay_last'].includes(e.id) && !e.id.startsWith('e:post:'))).toBe(true);
    expect(lv.events.find((e) => e.id === 'e:replay')?.reason).toMatch(/Unsubscribed/);
  });

  it('dropped off mid-session: the call is planned from the leave time and the real wait', () => {
    const { sim } = run('live', {}, { leaveMin: 30 });
    const left = sim.events.find((e) => e.id.startsWith('c:w_left'));
    expect(left).toBeTruthy();
    const s = run('live', {}, { leaveMin: null }).sim;
    expect(s.events.some((e) => e.id.startsWith('c:w_left'))).toBe(false);
  });

  it('strategy: a late-night application gets the speed-to-lead call in the next calling hours; booking cancels the approval emails', () => {
    const { sim, inp } = run('strategy', {}, { appliesAt: 'weekday_night', booksAfter: 24 * 60 });
    const T = strategyTimes(inp);
    const speed = sim.events.find((e) => e.title === 'Speed to lead')!;
    expect(speed.status).toBe('sent');
    expect(speed.at).toBeGreaterThan(T.applyAt + 5 * 60_000);
    expect(sim.events.filter((e) => e.status === 'cancelled' && /Approved/.test(e.title)).length).toBeGreaterThan(0);
    expect(sim.events.some((e) => e.title === 'Booking confirmation' && e.status === 'sent')).toBe(true);
    expect(sim.tier).toBe('A');
  });

  it('strategy: a no-show gets the rebook call; under $1M (tier C) gets no speed-to-lead call', () => {
    const ns = run('strategy', {}, { noShow: true }).sim;
    expect(ns.events.some((e) => e.title === 'Missed call, rebook' && e.status === 'sent')).toBe(true);
    const c = run('strategy', { revenue: 'lt1m' }).sim;
    expect(c.tier).toBe('C');
    expect(c.events.some((e) => e.title === 'Speed to lead')).toBe(false);
  });

  it('the planner mirrors keep the thresholds of the real webinar call planner (SQL in webinarCandidates)', () => {
    const src = read('src/integrations/webinar-calls.ts');
    expect(src).toContain(`runAt: r.created_at + ${PLAN.welcomeAfterMin} * MIN`);
    expect(src).toContain(`${PLAN.dayBeforeMinLeadH} * HOUR).all`);
    expect(src).toContain(`runAt: r.starts_at - ${PLAN.startBeforeMin} * MIN, exactTime: true`);
    expect(src).toContain(`runAt: end + ${PLAN.nobuyAfterEndMin} * MIN`);
    expect(src).toContain(`runAt: end + ${PLAN.missedAfterEndMin} * MIN`);
    expect(src).toContain(`runAt: r.paid_at + ${PLAN.boughtAfterMin} * MIN`);
    expect(src).toContain(`r.seen > end - ${PLAN.leftEndGuardMin} * MIN`);
    // The live text sender's daily cap and the strategy text queue's are both three a day.
    expect(read('src/live/events.ts')).toContain('if ((today?.n ?? 0) >= 3) return false;');
    expect(read('src/integrations/sms.ts')).toContain("if ((today?.n ?? 0) >= 3) { await skip('daily cap (3)')");
  });
});

describe('Sandbox is read-only and sends nothing', () => {
  it('simulating and rendering every step reads only, never writes, never fetches', async () => {
    const fetchSpy = vi.fn(async () => { throw new Error('no network in the sandbox'); });
    vi.stubGlobal('fetch', fetchSpy);
    for (const j of ['live', 'strategy'] as const) {
      const { rt, sql } = makeRt({ SMS_SENDER_AU: 'GL Advisory' });
      const inp = cleanInput({ journey: j, anchor: ANCHOR, choices: { leaveMin: 50, noShow: true } }, ANCHOR);
      const sim = simulate(rt, inp);
      const ids = sim.events.filter((e) => ['email', 'sms', 'call'].includes(e.ch)).map((e) => e.id);
      for (const id of ids) {
        const d = await detail(rt, inp, id);
        expect(d, id).toBeTruthy();
        if (d!.kind === 'email') expect(d!.email?.html, id).toMatch(/<html/);
        if (d!.kind === 'call') expect(d!.call?.firstMessage, id).toMatch(/AI/);
      }
      expect(sql.length).toBeGreaterThan(0);
      for (const q of sql) expect(q.trim(), q).toMatch(/^(SELECT|WITH)\b/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 120_000);

  it('the read-only runtime refuses writes', () => {
    const { rt } = makeRt();
    const ro = readOnlyRuntime(rt);
    expect(() => ro.env.DB.prepare("UPDATE leads SET status = 'won'")).toThrow(/blocked/);
    expect(() => ro.env.DB.prepare('INSERT INTO emails (id) VALUES (1)')).toThrow(/blocked/);
    expect(() => ro.env.DB.prepare('WITH x AS (SELECT 1) DELETE FROM leads')).toThrow(/blocked/);
    expect(() => ro.env.DB.prepare('WITH x AS (SELECT 1) INSERT INTO leads SELECT * FROM x')).toThrow(/blocked/);
    expect(() => ro.env.DB.batch([])).toThrow(/blocked/);
    expect(() => ro.env.DB.prepare('SELECT 1')).not.toThrow();
  });

  it('Australian texts show the sender-name variant with an opt-out link', () => {
    const { sim } = run('live', {}, {}, { SMS_SENDER_AU: 'GL Advisory' });
    const t = sent(sim, 'sms')[0].text!;
    expect(t.firstText).toBe(true);
    expect(t.body).toMatch(/Reply STOP to opt out/);
    expect(t.auVariant?.from).toBe('GL Advisory');
    expect(t.auVariant?.body).toMatch(/Opt out: https:\/\/apply\.test\/so\//);
  });

  it('"Talk to Sam now" builds the call on the server, tagged as a demo', async () => {
    const { rt } = makeRt();
    for (const j of ['live', 'strategy'] as const) {
      const inp = cleanInput({ journey: j, anchor: ANCHOR }, ANCHOR);
      const call = sent(simulate(rt, inp), 'call')[0];
      const s = await sandboxCallSession(rt, inp, call.id);
      expect(s?.vars.demo).toBe('yes');
      expect(s?.agent).toBe(j === 'live' ? 'webinar' : 'outbound');
      expect(await sandboxCallSession(rt, inp, 'e:confirm')).toBeNull();
    }
  });
});

describe('Sandbox page and copy', () => {
  it('own strict CSP with no microphone, and the simulation label', () => {
    expect(SANDBOX_CSP).toMatch(/script-src 'self';/);
    expect(SANDBOX_CSP).toMatch(/frame-ancestors 'none'/);
    expect(SANDBOX_CSP).not.toMatch(/elevenlabs/);
    expect(sandboxPage()).toMatch(/Simulation: nothing is sent/);
    expect(read('src/index.ts')).toMatch(/app\.get\('\/admin\/sandbox', requireAdmin/);
  });

  it('every string the simulation shows passes the copy rules', () => {
    const combos: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['live', {}, {}], ['live', { country: 'NO' }, { buys: 'live' }], ['live', { country: 'US', tz: 'America/Los_Angeles', revenue: 'lt1m' }, { joins: false, buys: 'after', optOut: 'text' }],
      ['live', {}, { leaveMin: 30, buys: 'after', answers: false, optOut: 'call', registerBefore: 30 }],
      ['strategy', {}, {}], ['strategy', {}, { noShow: true, rebooks: true, optOut: 'text' }], ['strategy', { revenue: 'lt1m', callOk: false }, { booksAfter: null }], ['strategy', { country: 'US' }, { appliesAt: 'sunday', answers: false, optOut: 'call' }],
    ];
    for (const [j, l, c] of combos) {
      const { sim } = run(j as 'live', l, c);
      for (const e of sim.events) {
        for (const t of [e.title, e.reason ?? '', ...(e.lines ?? []), e.ch === 'sms' ? '' : e.sub ?? '']) expect(auditCopy(t), `${e.id}: ${t}`).toEqual([]);
        expect(`${e.title} ${e.reason ?? ''} ${(e.lines ?? []).join(' ')}`).not.toMatch(/—|!/);
      }
      for (const t of [...sim.assumptions, ...sim.account.notes]) expect(auditCopy(t), t).toEqual([]);
    }
  });

  it('the page script’s own words pass the copy rules', () => {
    const block = (pageJs as string).slice((pageJs as string).indexOf('var COPY = {'), (pageJs as string).indexOf('};', (pageJs as string).indexOf('var COPY = {')));
    const strings = [...block.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
    expect(strings.length).toBeGreaterThan(40);
    for (const s of strings) { expect(auditCopy(s), s).toEqual([]); expect(s).not.toMatch(/—|!/); }
    expect(pageJs).not.toMatch(/\bfree\b/i);
  });

  it('Funnel HQ links to it from the sidebar (Home) and the Home quick actions', () => {
    expect(read('public/admin/index.html')).toMatch(/data-href="\/admin\/sandbox"[^>]*>.*<span class="nl">Sandbox<\/span>/);
    expect(read('public/assets/admin-home.js')).toMatch(/'sandbox', 'playc', 'Open the sandbox'/);
  });
});
