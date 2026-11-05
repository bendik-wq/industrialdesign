#!/usr/bin/env node
// Build the brain snapshot for the app (no network): reads ONLY wiki/engine/** and wiki/ventures/gl/** from the
// private brain checkout, builds the typed knowledge graph (src/brain/build.ts) and writes, into the gitignored
// .brain/ folder: snapshot.json (pages, chunks, edges, stats), seed-NNN.sql (D1 batches for scripts/brain/seed.mjs)
// and embed.json (the embedding job: the chunk ids and hashes POST /admin/api/brain/embed works through).
//
//   npm run brain:build                       # brain at $BRAIN_DIR or /home/user/brain
//   node scripts/brain/build.mjs --brain <dir> [--out .brain]
//
// PRIVACY: the output is brain text. It stays in .brain/ (gitignored) and goes to D1/Vectorize at deploy only.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBrain, inScope, toSeedSql } from '../../src/brain/build.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../..');
const arg = (name, d) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : d; };
const brain = resolve(arg('--brain', process.env.BRAIN_DIR || '/home/user/brain'));
const out = resolve(app, arg('--out', '.brain'));
const wiki = join(brain, 'wiki');

// Refuse to write brain text anywhere git would pick it up: the output folder must be named .brain.
if (!/(^|[\\/])\.brain([\\/][\w-]+)?$/.test(out)) {
  console.error(`Refusing to write to ${out}: brain output goes to a gitignored .brain/ folder.`);
  process.exit(1);
}

const files = [];
const walk = (dir) => {
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(wiki, p).split('\\').join('/');
      if (inScope(rel)) files.push({ path: rel, text: readFileSync(p, 'utf8') });
    }
  }
};
walk(join(wiki, 'engine'));
walk(join(wiki, 'ventures', 'gl'));
if (!files.length) { console.error(`No pages found under ${wiki}/engine or ${wiki}/ventures/gl.`); process.exit(1); }

let source = '';
try { source = execFileSync('git', ['-C', brain, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* not a git checkout */ }
const snap = buildBrain(files, { source: source ? `brain@${source}` : 'brain' });

mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (/^seed-\d+\.sql$/.test(f)) rmSync(join(out, f));
writeFileSync(join(out, 'snapshot.json'), JSON.stringify(snap));
const sql = toSeedSql(snap);
sql.forEach((s, i) => writeFileSync(join(out, `seed-${String(i + 1).padStart(3, '0')}.sql`), s));
writeFileSync(join(out, 'embed.json'), JSON.stringify({ build_id: snap.build_id, chunks: snap.chunks.map((c) => ({ id: c.id, hash: c.hash })) }));

const s = snap.stats;
console.log(`brain ${snap.source} → ${relative(app, out) || out}/ (build ${snap.build_id})`);
console.log(`  ${s.pages} pages, ${s.chunks} chunks, ${s.edges} edges, ${s.legends} legends`);
console.log(`  chunks by kind: ${JSON.stringify(s.by_kind)}`);
console.log(`  edges by type:  ${JSON.stringify(s.by_edge)}`);
console.log(`  ${sql.length} seed file(s), ${sql.reduce((n, x) => n + x.length, 0).toLocaleString('en-US')} bytes of SQL`);
console.log('Next: node scripts/brain/seed.mjs --local (or --remote at deploy), then POST /admin/api/brain/embed.');
