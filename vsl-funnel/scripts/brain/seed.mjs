#!/usr/bin/env node
// Seed the brain into D1 from the gitignored .brain/seed-NNN.sql files that scripts/brain/build.mjs wrote.
//
//   node scripts/brain/seed.mjs --local      # local D1 (wrangler dev); apply migrations first
//   node scripts/brain/seed.mjs --remote     # production D1 (the lead runs this at deploy)
//
// Idempotent: pages and chunks are upserted, unchanged chunks keep their embeddings, the last file swaps out rows
// from older builds and rebuilds the full-text index. Then embed: POST /admin/api/brain/embed (or let the cron).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const where = process.argv.includes('--remote') ? '--remote' : process.argv.includes('--local') ? '--local' : null;
if (!where) { console.error('Say where: --local or --remote.'); process.exit(1); }
const dir = join(app, '.brain');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^seed-\d+\.sql$/.test(f)).sort() : [];
if (!files.length) { console.error('No .brain/seed-*.sql yet. Run npm run brain:build first.'); process.exit(1); }

for (const f of files) {
  console.log(`${f} → D1 (${where.slice(2)})`);
  const r = spawnSync('npx', ['wrangler', 'd1', 'execute', 'DB', where, '--yes', `--file=${join(dir, f)}`], { cwd: app, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${f} failed; fix and run again (it is safe to repeat).`); process.exit(r.status ?? 1); }
}
console.log('Seeded. Embed next: POST /admin/api/brain/embed (Funnel HQ → Studio → Radar → Brain), or let the cron finish it.');
