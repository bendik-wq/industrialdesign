#!/usr/bin/env node
/**
 * Seeds the LOCAL D1 database (wrangler dev --local) with the few rows the smoke suite needs:
 * a scheduled live session (so /live shows its registration form), a challenge cohort with its five
 * days (so /challenge shows its form) and one test lead (the guest of the meeting-room check).
 *
 * Idempotent: fixed ids, INSERT OR REPLACE, dates relative to now. LOCAL ONLY: it never passes --remote.
 *
 *   node scripts/smoke/seed.mjs            # from vsl-funnel/
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED = {
  liveId: 'lw_smoke',
  cohortId: 'cc_smoke',
  leadId: 'l_smoke_meeting',
  leadEmail: 'smoke-meeting@example.com',
};

const DAY = 86_400_000;
const q = (v) => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export function seedSql(now = Date.now()) {
  const liveAt = now + 3 * DAY;
  const cohortAt = now + 5 * DAY;
  const tz = 'Australia/Sydney';
  const date = new Date(cohortAt).toISOString().slice(0, 10);
  const lines = [
    `INSERT OR REPLACE INTO live_webinars (id, title, starts_at, tz, duration_min, status, created_at, updated_at)
       VALUES (${q(SEED.liveId)}, 'Smoke test live session', ${liveAt}, ${q(tz)}, 120, 'scheduled', ${now}, ${now});`,
    `INSERT OR REPLACE INTO challenge_cohorts (id, name, start_date, start_time, timezone, duration_min, status, created_at, updated_at)
       VALUES (${q(SEED.cohortId)}, 'Smoke test cohort', ${q(date)}, '19:00', ${q(tz)}, 90, 'scheduled', ${now}, ${now});`,
    ...[1, 2, 3, 4, 5].map((d) => `INSERT OR REPLACE INTO challenge_days (cohort_id, day, starts_at, duration_min, edited, updated_at)
       VALUES (${q(SEED.cohortId)}, ${d}, ${cohortAt + (d - 1) * DAY}, 90, 0, ${now});`),
    `INSERT OR IGNORE INTO leads (id, ref_code, first_name, last_name, email, created_at, updated_at)
       VALUES (${q(SEED.leadId)}, 'SMOKEMEET', 'Morgan', 'Smoke', ${q(SEED.leadEmail)}, ${now}, ${now});`,
  ];
  return lines.join('\n');
}

/** Runs the seed against the local D1 (the same .wrangler state wrangler dev --local uses). */
export function seedLocal({ cwd, quiet = true } = {}) {
  const root = cwd ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'smoke-seed-'));
  const file = join(dir, 'seed.sql');
  writeFileSync(file, seedSql());
  try {
    execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--file', file], { cwd: root, stdio: quiet ? 'pipe' : 'inherit', env: { ...process.env, CI: '1' } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seedLocal({ quiet: false });
  console.log('Seeded local D1: live session, challenge cohort, meeting test lead.');
}
