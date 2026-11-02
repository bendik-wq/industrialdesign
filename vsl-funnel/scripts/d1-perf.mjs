// D1 query performance check: builds a local SQLite database from the migrations, seeds it with realistic
// volume (5k leads, 50k events, 20k sessions, 60k emails, ...), then times the hottest queries (the 5-minute
// cron, Funnel HQ overview / attribution / rooms, the room Durable Object's presence feed) and prints their
// query plans, before and after a migration (default: 0064, the indexes).
//
//   node scripts/d1-perf.mjs            # before/after 0064
//   node scripts/d1-perf.mjs --scale 2  # double the volume
//   node scripts/d1-perf.mjs --json     # machine-readable
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const scale = Number(args[args.indexOf('--scale') + 1]) || 1;
const json = args.includes('--json');
const migration = args.includes('--migration') ? args[args.indexOf('--migration') + 1] : '0064';

export const HOT_QUERIES = [
  // ── cron (every 5 minutes) ──
  { name: 'cron: attribution stage sync (registered, 120 days)', sql: `SELECT 'auto:'||r.id||':registered', r.lead_id, r.session_id, (SELECT edition FROM attr_conversions c WHERE c.kind = 'registered' AND c.ref_id = r.id), r.created_at FROM webinar_registrations r WHERE r.created_at >= ?1`, params: (t) => [t.now - 120 * t.DAY] },
  { name: 'cron: auto-webinar watch stages', sql: `SELECT r.id, r.lead_id, s.starts_at FROM webinar_registrations r JOIN webinar_sessions s ON s.id = r.session_id WHERE r.created_at >= ? AND (r.joined_at IS NOT NULL OR r.replay_at IS NOT NULL) LIMIT 5000`, params: (t) => [t.now - 120 * t.DAY] },
  { name: 'cron: AI call daily cap', sql: `SELECT COUNT(*) AS n FROM outbound_calls WHERE kind != 'test' AND created_at > ?`, params: (t) => [t.now - t.DAY] },
  { name: 'cron: AI calls to one number this week', sql: `SELECT COUNT(DISTINCT oc.lead_id || ':' || oc.kind) AS n FROM outbound_calls oc JOIN leads l ON l.id = oc.lead_id WHERE l.phone = ? AND oc.kind != 'test' AND oc.created_at > ?`, params: (t) => ['+61400000123', t.now - 7 * t.DAY] },
  { name: 'cron: DM link → lead match', sql: `SELECT DISTINCT t.id AS thread_id, v.lead_id FROM sessions s CROSS JOIN dm_threads t JOIN visitors v ON v.id = s.visitor_id WHERE s.started_at > ? AND s.landing_query LIKE '%dm=%' AND s.landing_query LIKE '%dm=' || t.id || '%' AND s.started_at >= t.link_sent_at - 60000 AND t.lead_id IS NULL AND t.link_sent_at IS NOT NULL AND v.lead_id IS NOT NULL LIMIT 20`, params: (t) => [t.now - 60 * t.DAY], before: `SELECT t.id AS thread_id, v.lead_id FROM dm_threads t JOIN sessions s ON s.landing_query LIKE '%dm=' || t.id || '%' JOIN visitors v ON v.id = s.visitor_id WHERE t.lead_id IS NULL AND t.link_sent_at IS NOT NULL AND v.lead_id IS NOT NULL LIMIT 20`, beforeParams: () => [] },
  { name: 'cron: tracking forward log clean-up (count)', sql: `SELECT COUNT(*) FROM forward_log WHERE (status = 'sent' AND updated_at < ?) OR updated_at < ?`, params: (t) => [t.now - 7 * t.DAY, t.now - 30 * t.DAY] },
  { name: 'webhook: Resend bounce marks the email', sql: `SELECT COUNT(*) FROM emails WHERE provider_id = ?`, params: () => ['re_00001234'] },
  { name: 'webhook: WhatsApp message dedupe', sql: `SELECT 1 FROM whatsapp_messages WHERE provider_id = ? LIMIT 1`, params: () => ['wamid.0000123'] },
  { name: 'cron: unpaid challenge follow-ups', sql: `SELECT r.lead_id, r.token, r.created_at FROM challenge_registrations r WHERE r.status = 'pending' AND r.created_at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM challenge_registrations x WHERE x.lead_id = r.lead_id AND x.status = 'paid')`, params: (t) => [t.now - 3 * t.DAY, t.now - t.DAY] },
  // ── Funnel HQ ──
  { name: 'HQ overview: emails sent in range', sql: `SELECT SUM(status = 'simulated') AS simulated, SUM(status = 'sent') AS real FROM emails WHERE sent_at BETWEEN ? AND ?`, params: (t) => [t.now - 7 * t.DAY, t.now] },
  { name: 'HQ funnel map: emails per sequence', sql: `SELECT COUNT(*) AS n FROM emails WHERE sequence = ? AND status IN ('sent','simulated') AND sent_at BETWEEN ? AND ?`, params: (t) => ['nurture', t.now - 30 * t.DAY, t.now] },
  { name: 'HQ funnel map: calls per kind', sql: `SELECT COUNT(*) AS n FROM outbound_calls WHERE kind = ? AND created_at BETWEEN ? AND ?`, params: (t) => ['confirm', t.now - 30 * t.DAY, t.now] },
  { name: 'HQ webinar: registrations in range', sql: `SELECT COUNT(*) AS registrations, COUNT(DISTINCT r.lead_id) AS people, SUM(r.joined_at IS NOT NULL) AS attended FROM webinar_registrations r WHERE r.created_at BETWEEN ? AND ?`, params: (t) => [t.now - 30 * t.DAY, t.now] },
  { name: 'HQ webinar: chat stats', sql: `SELECT SUM(author = 'viewer') AS messages FROM webinar_chat WHERE created_at BETWEEN ? AND ?`, params: (t) => [t.now - 30 * t.DAY, t.now] },
  { name: 'HQ webinar: interactions list', sql: `SELECT i.id, i.kind FROM webinar_interactions i LEFT JOIN leads l ON l.id = i.lead_id WHERE i.created_at BETWEEN ? AND ? ORDER BY i.created_at DESC LIMIT 200`, params: (t) => [t.now - 30 * t.DAY, t.now] },
  { name: 'HQ attribution: paid-social touches', sql: `SELECT COUNT(*) AS n FROM attr_touches WHERE ts > ? AND ad_id IS NOT NULL`, params: (t) => [t.now - 30 * t.DAY] },
  { name: 'HQ lead journey: VSL views by browser', sql: `SELECT id, video_id, started_at FROM vsl_views WHERE visitor_id = ? ORDER BY started_at DESC`, params: () => ['v000123'] },
  { name: 'HQ lead: VSL views by lead or browser', sql: `SELECT id FROM vsl_views WHERE lead_id = ? OR visitor_id = ? ORDER BY started_at DESC`, params: () => ['l000123', 'v000123'] },
  { name: 'HQ SMS log', sql: `SELECT s.direction, s.body FROM sms_messages s LEFT JOIN leads l ON l.id = s.lead_id WHERE s.created_at BETWEEN ? AND ? ORDER BY s.created_at DESC LIMIT 60`, params: (t) => [t.now - 7 * t.DAY, t.now] },
  { name: 'HQ events: page views in range', sql: `SELECT COUNT(*) FROM events WHERE name = 'page_view' AND ts BETWEEN ? AND ?`, params: (t) => [t.now - 7 * t.DAY, t.now] },
  { name: 'HQ sessions in range', sql: `SELECT COUNT(*) FROM sessions WHERE started_at BETWEEN ? AND ? AND is_bot = 0`, params: (t) => [t.now - 7 * t.DAY, t.now] },
  // ── rooms ──
  { name: 'room DO feed: viewers in the last 90s', sql: `SELECT COUNT(*) AS n FROM webinar_presence WHERE session_id = ? AND kind = 'viewer' AND seen_at > ?`, params: (t) => ['ev_big', t.now - 90_000] },
  { name: 'HQ rooms list', sql: `SELECT r.id, (SELECT COUNT(*) FROM room_attendance a WHERE a.room_id = r.id) AS people FROM rooms r ORDER BY COALESCE(r.starts_at, r.created_at) DESC LIMIT 100`, params: () => [] },
];

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T00:00:00Z');

function openDb(upTo) {
  const db = new DatabaseSync(':memory:');
  const dir = path.join(root, 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (upTo && f.slice(0, 4) >= upTo) continue;
    db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  }
  return db;
}

/** Seeds a table with n rows; columns not given get a value fitting their type (NOT NULL respected). */
function seed(db, table, n, row) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.length) return;
  const st = db.prepare(`INSERT OR IGNORE INTO ${table} (${cols.map((c) => c.name).join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) {
    const given = row(i);
    st.run(...cols.map((c) => {
      if (c.name in given) return given[c.name];
      if (c.pk) return `${table}_${i}`;
      if (c.dflt_value != null) return c.type.toUpperCase().includes('INT') ? Number(String(c.dflt_value).replace(/'/g, '')) || 0 : String(c.dflt_value).replace(/^'|'$/g, '');
      if (!c.notnull) return null;
      return c.type.toUpperCase().includes('INT') || c.type.toUpperCase().includes('REAL') ? 0 : `${c.name}_${i % 50}`;
    }));
  }
  db.exec('COMMIT');
}

export function seedRealistic(db, k = 1) {
  const L = 5000 * k, rnd = (a) => Math.floor(Math.random() * a);
  const ago = (days) => NOW - Math.floor(Math.random() * days * DAY);
  const pad = (i) => String(i).padStart(6, '0');
  seed(db, 'leads', L, (i) => ({ id: `l${pad(i)}`, email: `p${i}@x.test`, ref_code: `R${pad(i)}`, created_at: ago(365), updated_at: ago(30), phone: `+614000${pad(i)}`, status: ['partial', 'qualified', 'booked', 'won'][i % 4] }));
  seed(db, 'visitors', 15000 * k, (i) => ({ id: `v${pad(i)}`, created_at: ago(365), lead_id: i % 3 === 0 ? `l${pad(i % L)}` : null }));
  seed(db, 'sessions', 20000 * k, (i) => ({ id: `s${pad(i)}`, visitor_id: `v${pad(rnd(15000 * k))}`, started_at: ago(365), is_bot: i % 20 === 0 ? 1 : 0, landing_query: i % 50 === 0 ? `dm=t${pad(i % 400)}` : 'utm_source=meta' }));
  const names = ['page_view', 'vsl_play', 'cta_click', 'lead_captured', 'app_submitted', 'scroll', 'vsl_progress'];
  seed(db, 'events', 50000 * k, (i) => ({ id: `e${pad(i)}`, name: names[i % names.length], ts: ago(365), session_id: `s${pad(rnd(20000 * k))}`, visitor_id: `v${pad(rnd(15000 * k))}`, lead_id: i % 5 === 0 ? `l${pad(rnd(L))}` : null }));
  seed(db, 'emails', 60000 * k, (i) => ({ id: `m${pad(i)}`, lead_id: `l${pad(i % L)}`, sequence: ['nurture', 'precall', 'abandoned', 'noshow'][i % 4], step: Math.floor(i / L), status: i % 7 === 0 ? 'pending' : 'sent', send_at: ago(365), sent_at: i % 7 === 0 ? null : ago(365), provider_id: `re_${pad(i)}`, to_email: `p${i % L}@x.test`, template: `t${i % 30}` }));
  seed(db, 'outbound_calls', 3000 * k, (i) => ({ id: `oc${pad(i)}`, lead_id: `l${pad(rnd(L))}`, kind: ['confirm', 'speed_to_lead', 'rebook', 'test'][i % 4], status: 'done', created_at: ago(365), updated_at: ago(365), run_at: ago(365), conversation_id: `conv${i}` }));
  seed(db, 'webinar_sessions', 400 * k, (i) => ({ id: `ws${pad(i)}`, starts_at: ago(365) }));
  seed(db, 'webinar_registrations', 8000 * k, (i) => ({ id: `wr${pad(i)}`, lead_id: `l${pad(rnd(L))}`, session_id: `ws${pad(rnd(400 * k))}`, created_at: ago(365), joined_at: i % 2 ? ago(365) : null, token: `tok${i}` }));
  seed(db, 'attr_conversions', 8000 * k, (i) => ({ id: `ac${pad(i)}`, kind: i % 3 ? 'registered' : 'ticket_paid', funnel: 'auto', ref_id: `wr${pad(i)}`, reg_id: `wr${pad(i)}`, lead_id: `l${pad(rnd(L))}`, occurred_at: ago(365) }));
  seed(db, 'attr_touches', 20000 * k, (i) => ({ session_id: `s${pad(i)}`, lead_id: `l${pad(rnd(L))}`, visitor_id: `v${pad(rnd(15000))}`, ts: ago(365), ad_id: i % 4 ? null : `ad${i % 40}` }));
  seed(db, 'vsl_views', 20000 * k, (i) => ({ id: `vv${pad(i)}`, visitor_id: `v${pad(rnd(15000 * k))}`, lead_id: i % 4 ? null : `l${pad(rnd(L))}`, started_at: ago(365), video_id: 'main' }));
  seed(db, 'forward_log', 15000 * k, (i) => ({ event_id: `e${pad(i)}`, dest: ['meta', 'ga4'][i % 2], status: i % 10 ? 'sent' : 'failed', ts: ago(60), updated_at: ago(60) }));
  seed(db, 'whatsapp_messages', 5000 * k, (i) => ({ id: `w${pad(i)}`, ts: ago(365), provider_id: `wamid.${pad(i)}`, direction: 'in' }));
  seed(db, 'challenge_registrations', 3000 * k, (i) => ({ id: `cr${pad(i)}`, cohort_id: `co${i % 20}`, lead_id: `l${pad(i % L)}`, status: i % 3 ? 'paid' : 'pending', created_at: ago(120), token: `ct${i}` }));
  seed(db, 'webinar_chat', 20000 * k, (i) => ({ id: i + 1, session_id: `ws${pad(rnd(400))}`, reg_id: `wr${pad(rnd(8000))}`, author: 'viewer', body: 'hello there', created_at: ago(365), updated_at: ago(365) }));
  seed(db, 'webinar_interactions', 20000 * k, (i) => ({ id: `wi${pad(i)}`, reg_id: `wr${pad(rnd(8000))}`, kind: ['poll', 'question', 'offer', 'reaction'][i % 4], key: `k${i}`, created_at: ago(365) }));
  seed(db, 'sms_messages', 10000 * k, (i) => ({ id: `sm${pad(i)}`, lead_id: `l${pad(rnd(L))}`, created_at: ago(365), direction: 'out', sequence: `s${i}`, step: 0 }));
  seed(db, 'dm_threads', 400, (i) => ({ id: `t${pad(i)}`, ig_user_id: `ig${i}`, lead_id: null, link_sent_at: ago(365), created_at: ago(365), updated_at: ago(30) }));
  seed(db, 'webinar_presence', 3000 * k, (i) => ({ session_id: i < 2000 ? 'ev_big' : `ev${i % 50}`, who: `r${i}`, kind: i % 5 ? 'viewer' : 'replay', first_at: NOW - 3600_000, seen_at: NOW - rnd(600_000) }));
  seed(db, 'rooms', 300, (i) => ({ id: `rm${pad(i)}`, created_at: ago(365), starts_at: ago(365) }));
  seed(db, 'room_attendance', 30000 * k, (i) => ({ room_id: `rm${pad(i % 300)}`, who: `w${i}`, role: 'attendee', first_at: ago(365), last_at: ago(365) }));
}

function measure(db, q, sql, old = false) {
  const params = (old && q.beforeParams ? q.beforeParams : q.params)({ now: NOW, DAY });
  let stmt;
  try { stmt = db.prepare(sql); } catch (e) { return { error: String(e.message ?? e) }; }
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail);
  stmt.all(...params); // warm
  const runs = 5, t0 = performance.now();
  for (let i = 0; i < runs; i++) stmt.all(...params);
  return { ms: (performance.now() - t0) / runs, plan };
}

export function runBench(k = scale) {
  const before = openDb(migration);
  const after = openDb(null);
  seedRealistic(before, k);
  // Same data in both: copy the seeded file over and apply the remaining migrations.
  const tmp = path.join(process.env.TMPDIR || '/tmp', `d1-perf-${process.pid}.sqlite`);
  try { fs.rmSync(tmp); } catch { /* none */ }
  before.exec(`VACUUM INTO '${tmp}'`);
  after.close();
  const after2 = new DatabaseSync(tmp);
  const dir = path.join(root, 'migrations');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) if (f.slice(0, 4) >= migration) after2.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
  after2.exec('ANALYZE'); before.exec('ANALYZE');
  const rows = HOT_QUERIES.map((q) => ({ name: q.name, before: measure(before, q, q.before ?? q.sql, true), after: measure(after2, q, q.sql) }));
  after2.close(); fs.rmSync(tmp);
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const rows = runBench(scale);
  if (json) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  const f = (x) => (x.error ? 'error' : `${x.ms.toFixed(2)} ms`);
  console.log(`D1 hot queries, ${5000 * scale} leads / ${50000 * scale} events (before = migrations < ${migration}, after = all)\n`);
  for (const r of rows) {
    console.log(`${r.name}\n  before ${f(r.before).padStart(11)}  ${r.before.plan?.join(' | ') ?? r.before.error}\n  after  ${f(r.after).padStart(11)}  ${r.after.plan?.join(' | ') ?? r.after.error}`);
  }
}
