import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { auditCopy } from '../src/content/copy-rules';
import { SETTINGS } from '../src/settings';
import { buildBrief, composeBrief } from '../src/ops/brief';
import { type BriefHealth, buildHealth, composeHealth } from '../src/ops/brief-health';
import { listActions } from '../src/ops/actions';
import { runOps } from '../src/ops/cron';
import { TOOLS, runTool } from '../src/ops/tools';
import { HEALTH_TOOLS } from '../src/ops/tools-health';
import { deployedBuild, listReleases, parseReleaseNotes, recordRelease, releaseLine } from '../src/ops/releases';

// ───────────── A real SQLite database shaped like D1, every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };

function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const isRead = /^\s*(SELECT|WITH)\b/i.test(sql);
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => {
        if (isRead) return { results: db.prepare(sql).all(...norm()), meta: { changes: 0 } };
        const r = db.prepare(sql).run(...norm());
        return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb(skip: (f: string) => boolean = () => false) {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql') && !skip(x)).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}
const makeRt = (db: DatabaseSync, settings: Record<string, string> = {}, env: Record<string, unknown> = {}) =>
  ({ env: { DB: d1(db), ...env }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), OPS_TIMEZONE: 'Australia/Sydney', OPS_BRIEF_TIME: 'off', ...settings }, reps: [], origin: 'https://apply.test', waitUntil: () => {} }) as unknown as Runtime;

const NOW = Date.UTC(2026, 10, 2, 20, 30); // Tue 3 Nov 07:30 in Sydney
const H = 3_600_000, DAY = 86_400_000;
const utc = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Seeds one row (or a few) in every table the health sections read. */
function seed(db: DatabaseSync) {
  // errors: one new fingerprint, one old but seen again, one stale (outside the window)
  db.prepare('INSERT INTO app_errors (fingerprint, kind, source, message, stack, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('fp1', 'webhook', '/webhooks/whop', 'Whop signature mismatch', 'Error: x\n at y', 4, NOW - 3 * H, NOW - H);
  db.prepare('INSERT INTO app_errors (fingerprint, kind, source, message, stack, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('fp2', 'cron', 'AI calls', 'timeout', null, 40, NOW - 9 * DAY, NOW - 2 * H);
  db.prepare('INSERT INTO app_errors (fingerprint, kind, source, message, stack, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('fp3', 'request', '/apply', 'old', null, 1, NOW - 5 * DAY, NOW - 5 * DAY);
  db.prepare('INSERT INTO app_error_days (day, fingerprint, kind, count) VALUES (?, ?, ?, ?)').run(utc(NOW), 'fp1', 'webhook', 4);
  db.prepare('INSERT INTO app_error_days (day, fingerprint, kind, count) VALUES (?, ?, ?, ?)').run(utc(NOW), 'fp2', 'cron', 2);
  db.prepare('INSERT INTO app_error_days (day, fingerprint, kind, count) VALUES (?, ?, ?, ?)').run(utc(NOW - DAY), 'fp2', 'cron', 1);
  db.prepare('INSERT INTO app_error_days (day, fingerprint, kind, count) VALUES (?, ?, ?, ?)').run(utc(NOW - 5 * DAY), 'fp3', 'request', 1);
  // cron: one failed, one slow, one fine
  const cron = db.prepare('INSERT INTO cron_runs (job, last_started, last_ms, last_status, last_error, last_ok_at, runs, fails, slow, total_ms, max_ms, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  cron.run('Emails', NOW - 4 * 60_000, 900, 'failed', 'D1 busy', NOW - H, 100, 3, 0, 90000, 2000, NOW);
  cron.run('Ads sync', NOW - 4 * 60_000, 120000, 'slow', null, NOW - DAY, 50, 0, 2, 9000, 120000, NOW);
  cron.run('Rooms', NOW - 4 * 60_000, 80, 'ok', null, NOW - 4 * 60_000, 50, 0, 0, 4000, 300, NOW);
  db.prepare("INSERT INTO kv_state (key, value) VALUES ('cron:last_tick', ?)").run(JSON.stringify({ at: NOW - 4 * 60_000, ms: 1200, jobs: 3, failed: ['Emails'], slow: ['Ads sync'] }));
  // data quality: leads with no source got worse, duplicates got better
  const dq = db.prepare('INSERT INTO dq_results (day, check_key, n, total, examples, detail, computed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  dq.run('2026-11-03', 'leads_no_attribution', 7, 40, '["l1"]', '{}', NOW);
  dq.run('2026-11-02', 'leads_no_attribution', 2, 38, '[]', '{}', NOW - DAY);
  dq.run('2026-11-03', 'duplicate_leads', 1, 500, '[]', '{}', NOW);
  dq.run('2026-11-02', 'duplicate_leads', 3, 500, '[]', '{}', NOW - DAY);
  // MER: 1,000 spend and 2,500 revenue in the last 7 days
  db.prepare("INSERT INTO ad_spend (platform, campaign_id, day, spend, currency, updated_at) VALUES ('meta', 'c1', ?, 1000, 'USD', ?)").run(utc(NOW - 2 * DAY), NOW);
  db.prepare("INSERT INTO attr_conversions (id, kind, funnel, ref_id, lead_id, occurred_at, amount, refunded, currency, created_at, updated_at) VALUES ('cv1', 'deposit_paid', 'live', 'p1', 'lead_1', ?, 250000, 0, 'USD', ?, ?)").run(NOW - 2 * DAY, NOW - 2 * DAY, NOW - 2 * DAY);
  // Meta signals
  const sg = db.prepare("INSERT INTO meta_signals (key, signal, funnel, session_ref, lead_id, event_id, status, sent_at) VALUES (?, ?, 'live', 'ev1', ?, ?, ?, ?)");
  sg.run('k1', 'watched_30m', 'lead_1', 'e1', 'sent', NOW - 2 * H);
  sg.run('k2', 'watched_30m', 'lead_2', 'e2', 'sent', NOW - 3 * H);
  sg.run('k3', 'checkout_started', 'lead_3', 'e3', 'no_consent', NOW - 3 * H);
  sg.run('k4', 'offer_opened', 'lead_4', 'e4', 'sent', NOW - 3 * DAY); // outside the window
  // a room last night: 3 attendees (a host not counted), 1 push, 1 buyer
  db.prepare("INSERT INTO rooms (id, mode, title, ref_type, status, went_live_at, ended_at, peak, created_at, updated_at) VALUES ('rm1', 'webinar', 'Live masterclass', 'live', 'ended', ?, ?, 4, ?, ?)").run(NOW - 10 * H, NOW - 8 * H, NOW - DAY, NOW);
  const att = db.prepare("INSERT INTO room_attendance (room_id, who, lead_id, role, first_at, last_at, minutes) VALUES ('rm1', ?, ?, ?, ?, ?, ?)");
  att.run('h', null, 'host', NOW - 10 * H, NOW - 8 * H, 120);
  att.run('a1', 'lead_1', 'attendee', NOW - 10 * H, NOW - 8 * H, 90);
  att.run('a2', 'lead_2', 'attendee', NOW - 10 * H, NOW - 9 * H, 40);
  att.run('a3', 'lead_3', 'attendee', NOW - 10 * H, NOW - 10 * H + 600_000, 10);
  db.prepare("INSERT INTO room_pushes (room_id, id, kind, target_count, created_at) VALUES ('rm1', 1, 'deposit', 3, ?)").run(NOW - 9 * H);
  const pe = db.prepare("INSERT INTO room_push_events (room_id, push_id, who, event, lead_id, at) VALUES ('rm1', 1, ?, ?, ?, ?)");
  for (const w of ['a1', 'a2', 'a3']) pe.run(w, 'shown', null, NOW - 9 * H);
  pe.run('a1', 'opened', 'lead_1', NOW - 9 * H); pe.run('a1', 'paid', 'lead_1', NOW - 9 * H);
  // a deploy last night
  db.prepare("INSERT INTO release_notes (build, deployed_at, notes, recorded_at) VALUES ('ab12cd34-20261102T1000', ?, ?, ?)").run(NOW - 10 * H, JSON.stringify(['Rooms: retry pulls', 'Brief: health sections']), NOW - 10 * H + 300_000);
}

const fetchMock = vi.fn(async () => new Response('ok'));
beforeEach(() => { fetchMock.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

// ───────────────────────── The brief's health sections ─────────────────────────
describe('morning brief: health sections from real data', () => {
  it('reads errors, cron, data quality, MER, Meta signals, rooms and deploys from the database', async () => {
    const db = freshDb(); seed(db);
    const h = await buildHealth(makeRt(db, { ADS_MER_FLOOR: '3' }), NOW - DAY, 'in the last 24 hours', NOW);
    expect(h.errors).toMatchObject({ distinct: 2, fresh: 1, occurrences: 7 }); // fp3 is outside the window; 4 + 2 + 1 on the UTC days since the window began
    expect(h.errors!.top[0]).toMatchObject({ source: '/webhooks/whop', count: 4 });
    expect(h.cron!.jobs.map((j) => [j.job, j.status])).toEqual([['Emails', 'failed'], ['Ads sync', 'slow']]);
    expect(h.cron!.tickAgoMin).toBeNull(); // ticked 4 minutes ago: not stale
    expect(h.dataq).toMatchObject({ day: '2026-11-03', prevDay: '2026-11-02', worse: [{ label: 'Leads with no source', n: 7, total: 40, delta: 5 }] });
    expect(h.mer).toMatchObject({ mer: 2.5, revenue: 2500, spend: 1000, floor: 3, comparable: true });
    expect(h.signals).toMatchObject({ sent: 2, noConsent: 1 });
    expect(h.rooms).toEqual([{ id: 'rm1', title: 'Live masterclass', status: 'ended', peak: 4, attendees: 3, avgMinutes: 47, pushes: 1, purchases: 1 }]);
    expect(h.build!.releases.map((r) => r.build)).toEqual(['ab12cd34-20261102T1000']);
  });

  it('puts every section in the daily brief, each number linked to its Funnel HQ view', async () => {
    const db = freshDb(); seed(db);
    const d = await buildBrief(makeRt(db, { ADS_MER_FLOOR: '3' }), 'daily', NOW);
    const md = composeBrief(d).markdown;
    expect(md).toContain('## Errors');
    expect(md).toContain('[2 distinct errors](/admin#errors) seen in the last 24 hours, [1 new](/admin#errors)');
    expect(md).toContain('- **Emails** failed: D1 busy · [3 failures in total](/admin#errors)');
    expect(md).toContain('- **Ads sync** slow, ran past its budget at [120 s](/admin#errors)\n');
    expect(md).toContain('## Data quality got worse (2026-11-03 vs 2026-11-02)');
    expect(md).toContain('- **Leads with no source**: [7 of 40](/admin#links) ([+5](/admin#links) vs the day before)');
    expect(md).not.toContain('Duplicate leads'); // it got better: not in "got worse"
    expect(md).toContain('[2.50](/admin#autopilot) ([$2,500](/admin#autopilot) revenue net of refunds ÷ [$1,000](/admin#autopilot) ad spend)');
    expect(md).toContain('**Under the floor of [3](/admin#autopilot)**');
    expect(md).toContain('[2 signals](/admin#audiences) sent to Meta in the last 24 hours, [1 held back](/admin#audiences) (no consent)');
    expect(md).toContain('- **Live masterclass**: [3 attendees](/admin#rooms), peak [4](/admin#rooms), [47 min](/admin#rooms) average, [1 push](/admin#rooms), [1 purchase](/admin#rooms)');
    expect(md).toContain('- Deployed ab12cd34-20261102T1000 at Mon 2 Nov 21:30: Rooms: retry pulls; Brief: health sections');
    // Every digit in the health part sits inside a link or comes from a label, date, build or job name given in the data.
    const health = md.slice(md.indexOf('## Errors'));
    const stripped = health.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/2026-11-0[123]/g, '').replace(/ab12cd34-20261102T1000/g, '').replace(/Mon 2 Nov 21:30/g, '').replace(/UTC days/, '').replace(/\/webhooks\/whop/, '').replace(/last 24 hours|last 7 days|7 days before/g, '').replace(/5-minute/g, '').replace(/D1 busy/g, '').replace(/Watched 30\+ minutes/g, '');
    expect(stripped).not.toMatch(/\d/);
  });

  it('leaves out every health section when there is nothing to report, and never breaks the brief', async () => {
    const db = freshDb();
    const md = composeBrief(await buildBrief(makeRt(db), 'daily', NOW)).markdown;
    for (const h of ['## Errors', '## Cron jobs', '## Data quality', '## Blended MER', '## Meta signals', '## Rooms', '## Deploys']) expect(md).not.toContain(h);
    // tables missing (an install before these migrations): still a brief, just without the sections
    const old = freshDb((f) => f >= '0062');
    const md2 = composeBrief(await buildBrief(makeRt(old), 'daily', NOW)).markdown;
    expect(md2).toContain('# Morning brief');
    expect(md2).not.toContain('## Errors');
  });

  it('a stopped cron shows on its own; the weekend summary counts since Saturday', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO kv_state (key, value) VALUES ('cron:last_tick', ?)").run(JSON.stringify({ at: NOW - 47 * 60_000 }));
    const h = await buildHealth(makeRt(db), NOW - DAY, 'in the last 24 hours', NOW);
    expect(h.cron).toEqual({ jobs: [], tickAgoMin: 47 });
    expect(composeHealth(h, String).join('\n')).toContain('The 5-minute cron last ran [47 minutes ago](/admin#errors).');
    const w = await buildBrief(makeRt(db), 'weekend', NOW);
    expect(w.health?.window).toMatch(/^since Sat/);
  });

  it('composeHealth is pure and empty without data', () => {
    expect(composeHealth(undefined, String)).toEqual([]);
    expect(composeHealth({ window: 'in the last 24 hours' }, String)).toEqual([]);
    const h: BriefHealth = { window: 'in the last 24 hours', mer: { mer: null, revenue: 10, spend: 5, currency: 'EUR', prevMer: null, floor: null, comparable: false } };
    expect(composeHealth(h, String).join('\n')).toContain('different currencies');
  });
});

// ───────────────────────── Chat read tools ─────────────────────────
describe('Command chat: health and marketing read tools', () => {
  it('registers every tool once, with descriptions that pass the copy rules', () => {
    const names = TOOLS.map((t) => t.name);
    for (const t of ['errors', 'cron_health', 'data_quality', 'mer', 'ad_concepts', 'meta_signals', 'room_engagement', 'deploys']) expect(names).toContain(t);
    expect(new Set(names).size).toBe(names.length);
    for (const t of HEALTH_TOOLS) { expect(auditCopy(t.description!), t.name).toEqual([]); expect(t.description).not.toMatch(/—|!/); }
  });

  it('answers "what broke overnight?" and "which ad concept is winning?" from real rows, without writing anything', async () => {
    const db = freshDb(); seed(db);
    const rt = makeRt(db, { ADS_MER_FLOOR: '3' });
    db.prepare("INSERT INTO ads_concept_rounds (id, label, kind, status, created_at, updated_at) VALUES ('r1', 'Round 1', 'concepts', 'launched', ?, ?)").run(NOW - 10 * DAY, NOW);
    const con = db.prepare("INSERT INTO ads_concepts (id, round_id, idx, desire, awareness, format, audience, angle, framework, verdict, verdict_by, created_at, updated_at) VALUES (?, 'r1', ?, 'profit', 'problem', 'talking_head', 'Owners', 'Buy a competitor', 'pas', ?, ?, ?, ?)");
    con.run('c1', 1, 'winner', 'you', NOW - 10 * DAY, NOW); con.run('c2', 2, null, null, NOW - 10 * DAY, NOW);
    const before = db.prepare('SELECT (SELECT COUNT(*) FROM ops_actions) + (SELECT COUNT(*) FROM release_notes) + (SELECT COUNT(*) FROM app_errors) AS n').get() as { n: number };
    const ctx = { threadId: 'th_test', now: NOW };

    const e = await runTool(rt, 'errors', { days: 2 }, ctx);
    expect(e.sources[0].href).toBe('/admin#errors');
    expect((e.result as { distinct: number; top: { where: string; new_in_window: boolean }[] }).top.find((x) => x.where === '/webhooks/whop')?.new_in_window).toBe(true);

    const c = await runTool(rt, 'cron_health', {}, ctx);
    expect((c.result as { not_ok: { job: string }[] }).not_ok.map((j) => j.job).sort()).toEqual(['Ads sync', 'Emails']);

    const q = await runTool(rt, 'data_quality', {}, ctx);
    expect((q.result as { checks: { key: string; got_worse: boolean }[] }).checks.find((x) => x.key === 'leads_no_attribution')?.got_worse).toBe(true);
    expect(q.sources[0].href).toBe('/admin#tracking');

    const m = await runTool(rt, 'mer', {}, ctx);
    expect(m.result).toMatchObject({ floor: 3, holding_scaling: true, last_7_days: { mer: 2.5 } });

    const a = await runTool(rt, 'ad_concepts', {}, ctx);
    expect((a.result as { winners: { concept: number }[] }).winners.map((w) => w.concept)).toEqual([1]);
    expect(a.sources[0].href).toBe('/admin#autopilot');

    const s = await runTool(rt, 'meta_signals', { range: '24h' }, ctx);
    const sig = (s.result as { signals: { signal: string; sent: number; no_consent: number }[] }).signals;
    expect(sig.find((x) => x.signal === 'Watched 30+ minutes')?.sent).toBe(2);
    expect(sig.find((x) => x.signal === 'Started offer checkout')?.no_consent).toBe(1);

    const r = await runTool(rt, 'room_engagement', { range: '24h' }, ctx);
    const room = (r.result as { rooms: { title: string; attendees: number; stayed_30_min: number; purchases: number; pushes: Record<string, { shown: number; opened: number; paid: number }> }[] }).rooms[0];
    expect(room).toMatchObject({ title: 'Live masterclass', attendees: 3, stayed_30_min: 2, purchases: 1 });
    expect(room.pushes.deposit).toMatchObject({ pushes: 1, shown: 3, opened: 1, paid: 1 });

    const d = await runTool(rt, 'deploys', {}, ctx);
    expect((d.result as { releases: { build: string; changes: string[] }[] }).releases[0].changes).toEqual(['Rooms: retry pulls', 'Brief: health sections']);

    const after = db.prepare('SELECT (SELECT COUNT(*) FROM ops_actions) + (SELECT COUNT(*) FROM release_notes) + (SELECT COUNT(*) FROM app_errors) AS n').get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(await listActions(rt, {})).toEqual([]); // read tools never propose or log anything
  });

  it('works on an empty install', async () => {
    const rt = makeRt(freshDb());
    for (const t of HEALTH_TOOLS) {
      const out = await runTool(rt, t.name, {}, { threadId: 'th', now: NOW });
      expect(out.summary, t.name).toBeTruthy();
      expect(out.sources.length, t.name).toBeGreaterThan(0);
    }
  });
});

// ───────────────────────── What changed (release notes) ─────────────────────────
describe('release notes: "Deployed <build> at <time>: <notes>"', () => {
  it('cleans the notes the deploy script passes in: valid build, up to 12 subjects, secrets masked', () => {
    expect(parseReleaseNotes('not json')).toBeNull();
    expect(parseReleaseNotes({ build: 'bad id!', at: 1, notes: [] })).toBeNull();
    const r = parseReleaseNotes(JSON.stringify({ build: 'ab12cd34-20261102T1000', at: NOW, notes: ['Fix  rooms\nretry', 'key sk_live_abcdefghij leaked', ...Array.from({ length: 20 }, (_, i) => `n${i}`), 42] }))!;
    expect(r.notes[0]).toBe('Fix rooms retry');
    expect(r.notes[1]).toBe('key sk_*** leaked');
    expect(r.notes).toHaveLength(12);
  });

  it('records each build once, lists newest first, and is harmless without the table', async () => {
    const db = freshDb();
    const rt = makeRt(db, {}, { CF_VERSION_METADATA: { id: '1234abcd-0000-1111-2222-333344445555' } });
    const info = { build: 'b1', at: NOW - DAY, notes: ['one'] };
    expect(await recordRelease(rt, info, NOW)).toBe(true);
    expect(await recordRelease(rt, info, NOW + 1)).toBe(false);
    expect(await recordRelease(rt, { build: 'b2', at: NOW, notes: [] }, NOW)).toBe(true);
    expect(await recordRelease(rt, null, NOW)).toBe(false);
    const rows = await listReleases(rt);
    expect(rows.map((r) => r.build)).toEqual(['b2', 'b1']);
    expect(rows[1]).toMatchObject({ notes: ['one'], version_id: '1234abcd-0000-1111-2222-333344445555' });
    expect(releaseLine(rows[1], () => 'Mon 2 Nov 07:30')).toBe('Deployed b1 at Mon 2 Nov 07:30: one');
    expect(releaseLine(rows[0], () => 'Tue 3 Nov 07:30')).toBe('Deployed b2 at Tue 3 Nov 07:30');
    expect(releaseLine({ build: 'b', deployed_at: 0, notes: ['a', 'b', 'c', 'd'] }, () => 'x', 2)).toBe('Deployed b at x: a; b (and 2 more)');
    expect(deployedBuild(rt.env)).toBe('1234abcd0000'); // the Worker version id, as on /health
    expect(deployedBuild({})).toBeNull(); // local dev: not a deploy

    const old = makeRt(freshDb((f) => f.startsWith('0071')));
    expect(await recordRelease(old, info, NOW)).toBe(false);
    expect(await listReleases(old)).toEqual([]);
  });

  it('the Command cron runs with no bundled notes and records nothing', async () => {
    const db = freshDb();
    const r = await runOps(makeRt(db), NOW);
    expect(r.release).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM release_notes').get()).toEqual({ n: 0 });
  });

  it('the deploy script passes the notes as a define next to the build id', () => {
    const js = fs.readFileSync(`${node.cwd()}/scripts/deploy.mjs`, 'utf8');
    expect(js).toContain("'--define', `__RELEASE_NOTES__:${JSON.stringify(release)}`");
    expect(js).toContain("'--no-merges'");
  });
});
