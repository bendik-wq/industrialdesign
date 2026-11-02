#!/usr/bin/env node
// `npm run deploy`: wrangler deploy with a build id (git hash + UTC time) substituted for __BUILD_ID__, so every page
// references /assets/x.js?v=<build id> and a new deploy never serves stale browser code (src/infra/build.ts).
// Extra arguments pass through to wrangler (npm run deploy -- --dry-run --outdir dist).
import { execFileSync, spawnSync } from 'node:child_process';

let hash = 'nogit';
try { hash = execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8' }).trim() || hash; } catch { /* not a git checkout */ }
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13); // 20261102T0315
const id = `${hash}-${stamp}`.replace(/[^\w.-]/g, '');

console.log(`build id ${id}`);
const args = ['wrangler', 'deploy', '--define', `__BUILD_ID__:${JSON.stringify(id)}`, ...process.argv.slice(2)];
const r = spawnSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
