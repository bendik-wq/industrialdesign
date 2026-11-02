#!/usr/bin/env node
// `npm run deploy`: wrangler deploy with a build id (git hash + UTC time) substituted for __BUILD_ID__, so every page
// references /assets/x.js?v=<build id> and a new deploy never serves stale browser code (src/infra/build.ts).
// It also substitutes __RELEASE_NOTES__ (build id, deploy time, the last commit subjects) so Command can show
// "Deployed <build> at <time>: <notes>" (src/ops/releases.ts). No git, no notes: the Worker just shows none.
// Extra arguments pass through to wrangler (npm run deploy -- --dry-run --outdir dist).
import { execFileSync, spawnSync } from 'node:child_process';

let hash = 'nogit';
try { hash = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim() || hash; } catch { /* not a git checkout */ }
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13); // 20261102T0315
const id = `${hash}-${stamp}`.replace(/[^\w.-]/g, '');

let notes = [];
try {
  notes = execFileSync('git', ['log', '-n', '12', '--no-merges', '--format=%s'], { encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 160));
} catch { /* not a git checkout: no notes */ }
const release = JSON.stringify({ build: id, at: Date.now(), notes });

console.log(`build id ${id}${notes.length ? ` (${notes.length} change notes)` : ''}`);
const args = ['wrangler', 'deploy', '--define', `__BUILD_ID__:${JSON.stringify(id)}`, '--define', `__RELEASE_NOTES__:${JSON.stringify(release)}`, ...process.argv.slice(2)];
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
