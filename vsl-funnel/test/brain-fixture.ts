// The synthetic brain for the brain tests (test/brain-*.test.ts): a tiny made-up wiki under
// test/fixtures/brain-synthetic (fake legends, a fake venture, plus out-of-scope pages that must never load).
// No real brain text is ever used in tests or fixtures.
import type { Runtime } from '../src/app';
import { type BrainFile, type BrainSnapshot, buildBrain, toSeedSql } from '../src/brain/build';
import { SETTINGS, type Settings } from '../src/settings';
import { type SqlDb, d1, freshDb } from './studio-fakes';

const nodeP = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const nfs = nodeP.getBuiltinModule('node:fs') as { readdirSync(p: string, o: { withFileTypes: true }): { name: string; isDirectory(): boolean }[]; readFileSync(p: string, enc: string): string };

export const FIXTURE_WIKI = `${nodeP.cwd()}/test/fixtures/brain-synthetic/wiki`;

/** Every file of the synthetic wiki (in scope or not), as the build script would see it. */
export function fixtureFiles(): BrainFile[] {
  const out: BrainFile[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of nfs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(`${dir}/${e.name}`, r);
      else out.push({ path: r, text: nfs.readFileSync(`${dir}/${e.name}`, 'utf8') });
    }
  };
  walk(FIXTURE_WIKI, '');
  return out;
}

export const FIXED_AT = '2026-11-05T10:00:00.000Z';
export const fixtureSnapshot = (): BrainSnapshot => buildBrain(fixtureFiles(), { builtAt: FIXED_AT, source: 'synthetic' });

/** A fresh in-memory D1 (every migration) with the synthetic brain seeded through the same SQL the deploy uses. */
export function seededDb(snap = fixtureSnapshot()): SqlDb {
  const db = freshDb();
  for (const sql of toSeedSql(snap, 4000)) db.exec(sql);
  return db;
}

const blankSettings = () => Object.fromEntries(SETTINGS.map((s) => [s.key, ''])) as Settings;
export function rtFor(db: SqlDb, env: Record<string, unknown> = {}): Runtime {
  return { env: { DB: d1(db), ...env } as never, settings: blankSettings(), reps: [], origin: 'https://apply.test', waitUntil: () => {} };
}
