// The deal room: C3 of the 3C model (the JL skill) for one target. Steps 2-5 of the five-step deal flow as one
// workspace: the qualification gate (NDA, ≥3 years financial statements and tax returns; healthcare: billing by
// practitioner), the NBIO/LOI and its exclusivity clock, the diligence log graded by the skill's red flag decision
// matrix, the mandatory conditions precedent, contractual close and settlement, and the first 100 days.
// The seller gets a private link (no account) where they accept the NDA and upload what the gate asks for.
// Checklist lines come from ROOM_TEMPLATES in public/js/jl.js, quoted from the skill.
import { ROOM_TEMPLATES, RED_FLAG_MATRIX, TIMELINE, MOTIVATION } from "../public/js/jl.js";
import { sha256, randomToken } from "./auth.js";
import { now, displayName } from "./http.js";
import { propose } from "./approvals.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const LISTS = new Set(["gate", "dd", "cp", "close", "plan"]);
const STATUSES = new Set(["open", "requested", "received", "done", "issue", "na"]);
const SEVERITIES = new Set(["high", "medium", "low"]);
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : null);
const numOrNull = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const day = (iso) => Date.parse(String(iso).length === 10 ? `${iso}T12:00:00Z` : iso);
const daysBetween = (a, b = now()) => (a ? Math.floor((day(b) - day(a)) / 864e5) : null);
const addDaysTo = (iso, n) => new Date(day(iso) + n * 864e5).toISOString().slice(0, 10);
export const HEALTHCARE = /dental|dentist|clinic|medical|health|physio|chiro|optom|vet(erinar)?|pharm|podiat|psycholog|allied|radiolog|pathology|aged care|nursing|hospital|practice|orthodont|audiolog|osteo/i;

export const MAX_FILE = 20 * 1024 * 1024;
const CHUNK = 1_800_000;
const MAX_ROOM_FILES = 60;
// Every workspace's files share one database: a workspace stores at most this much, and a seller link takes at most
// 30 uploads an hour, so one link or one script can't fill it for everyone.
export const LINK_DAYS = 60;
export const WORKSPACE_BYTES = 1.5 * 1024 * 1024 * 1024, SELLER_UPLOADS_PER_HOUR = 30;
const MIME = { pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", csv: "text/csv", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain" };
export const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || "";

async function target(env, ctx, id) {
  const t = await env.DB.prepare("SELECT id, name, industry, stage, owner_name, currency, created_at FROM targets WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!t) throw err(404, "Target not found");
  return t;
}

// The room and its checklists exist from the first time anyone opens them.
async function ensureRoom(env, accountId, t) {
  const r = await env.DB.prepare("SELECT * FROM deal_rooms WHERE target_id = ?1 AND account_id = ?2").bind(t.id, accountId).first();
  if (r) return r;
  const stamp = now();
  const first = await env.DB.prepare("SELECT MIN(created_at) AS at FROM (SELECT created_at FROM calls WHERE account_id = ?1 AND target_id = ?2 UNION ALL SELECT created_at FROM target_events WHERE account_id = ?1 AND target_id = ?2 AND kind IN ('call', 'email', 'sms', 'meeting'))").bind(accountId, t.id).first();
  const healthcare = HEALTHCARE.test(`${t.industry} ${t.name}`);
  const rows = [];
  for (const [list, items] of Object.entries(ROOM_TEMPLATES)) {
    items.filter((x) => !x.healthcare || healthcare).forEach((x, i) => rows.push({ list, section: x.section, title: x.title, seller: x.seller ? 1 : 0, upload: x.upload ? 1 : 0, sort: i * 10 }));
  }
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO deal_rooms (target_id, account_id, first_contact, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(t.id, accountId, first?.at ? first.at.slice(0, 10) : null, stamp),
    ...rows.map((x) => env.DB.prepare("INSERT INTO deal_items (account_id, target_id, list, section, title, seller, upload, sort, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)").bind(accountId, t.id, x.list, x.section, x.title, x.seller, x.upload, x.sort, stamp)),
  ]);
  return env.DB.prepare("SELECT * FROM deal_rooms WHERE target_id = ?1 AND account_id = ?2").bind(t.id, accountId).first();
}

// Clocks and warnings, from the skill's timeline discipline: exclusivity (typically 60-90 days), DD window 90 days
// maximum, contract papering 4 weeks target, 3-6 months from LOI to close.
export function clocks(room, today = now()) {
  const out = { warnings: [] };
  const warn = (level, text) => out.warnings.push({ level, text });
  if (room.loi_signed_at && room.exclusivity_days) {
    const ends = addDaysTo(room.loi_signed_at, room.exclusivity_days), left = -daysBetween(ends, today);
    out.exclusivity = { ends, left };
    if (!room.settled_at) { if (left < 0) warn("high", `Exclusivity ended ${-left} days ago (${ends}).`); else if (left <= 14) warn("medium", `Exclusivity ends in ${left} days (${ends}).`); }
  }
  if (room.dd_start) {
    const end = room.contract_start || room.settled_at || today, used = daysBetween(room.dd_start, end);
    out.dd = { used, max: TIMELINE.ddDays, done: !!(room.contract_start || room.settled_at) };
    if (!out.dd.done) { if (used > TIMELINE.ddDays) warn("high", `Diligence is on day ${used}: the skill's window is 90 days maximum.`); else if (used > TIMELINE.ddDays - 15) warn("medium", `Diligence is on day ${used} of 90.`); }
  }
  if (room.contract_start) {
    const used = daysBetween(room.contract_start, room.settled_at || today);
    out.contract = { used, target: TIMELINE.contractDays, done: !!room.settled_at };
    if (!room.settled_at && used > TIMELINE.contractDays) warn("medium", `Contract papering is on day ${used}: the target is 4 weeks. Keep pressure on the lawyers to avoid fee-jacking.`);
  }
  const loi = room.loi_signed_at || room.offer_at;
  if (loi) {
    const months = daysBetween(loi, room.settled_at || today) / 30.4;
    out.loiToClose = { months: Math.round(months * 10) / 10, done: !!room.settled_at };
    if (!room.settled_at && months > 6) warn("medium", `${Math.floor(months)} months since the offer: the skill's total process is 3-6 months from LOI to close.`);
  }
  if (room.first_contact && room.settled_at) out.contactToClose = daysBetween(room.first_contact, room.settled_at);
  if (room.offer_price && room.final_price) out.ddVariance = Math.round(((room.final_price - room.offer_price) / room.offer_price) * 1000) / 10;
  if (room.budget_fees && room.spent_fees != null) out.feesVsBudget = Math.round((room.spent_fees / room.budget_fees) * 100);
  return out;
}

// JL motivation signal from the gate: "Provides financials within 1-2 days of NDA" (high) vs "Takes weeks to
// provide basic info" (low).
export function gateSignal(room, firstFinancialAt, today = now()) {
  if (!room.nda_at) return null;
  if (firstFinancialAt) {
    const d = daysBetween(room.nda_at, firstFinancialAt);
    if (d <= 2) return { level: "high", text: MOTIVATION.high[0], days: d };
    if (d >= 14) return { level: "low", text: MOTIVATION.low[0], days: d };
    return { level: "neutral", text: `Financials came ${d} days after the NDA.`, days: d };
  }
  const waiting = daysBetween(room.nda_at, today);
  return waiting >= 14 ? { level: "low", text: MOTIVATION.low[0], days: waiting } : { level: "waiting", text: `NDA in ${waiting} day${waiting === 1 ? "" : "s"} ago; no financials yet.`, days: waiting };
}

const ROOM_PUBLIC = ["link_on", "token_hint", "seller_name", "nda_at", "nda_name", "first_contact", "offer_at", "offer_price", "offer_kind", "offer_terms", "loi_signed_at", "exclusivity_days", "dd_start", "contract_start", "settled_at", "final_price", "budget_fees", "spent_fees", "seller_seen_at", "seller_views", "updated_at"];

export async function getRoom(env, ctx, targetId) {
  const t = await target(env, ctx, targetId);
  const room = await ensureRoom(env, ctx.accountId, t);
  const [items, files] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM deal_items WHERE account_id = ?1 AND target_id = ?2 ORDER BY list, sort, id").bind(ctx.accountId, t.id),
    env.DB.prepare("SELECT f.id, f.name, f.size, f.mime, f.created_at, rf.item_id, rf.source FROM room_files rf JOIN files f ON f.id = rf.file_id WHERE rf.account_id = ?1 AND rf.target_id = ?2 ORDER BY f.id DESC").bind(ctx.accountId, t.id),
  ]);
  const gateItems = items.results.filter((i) => i.list === "gate");
  const finIds = new Set(gateItems.filter((i) => /financial|tax|billing/i.test(i.title)).map((i) => i.id));
  const firstFin = files.results.filter((f) => finIds.has(f.item_id) && f.source === "seller").map((f) => f.created_at).sort()[0] || null;
  const lists = {};
  for (const i of items.results) (lists[i.list] ||= []).push(i);
  const progress = Object.fromEntries(Object.entries(lists).map(([k, v]) => { const live = v.filter((i) => i.status !== "na"); return [k, { done: live.filter((i) => ["done", "received"].includes(i.status)).length, total: live.length, issues: v.filter((i) => i.status === "issue").length }]; }));
  const gatePassed = gateItems.filter((i) => i.status !== "na").every((i) => ["done", "received"].includes(i.status)) && !!gateItems.length;
  const out = Object.fromEntries(ROOM_PUBLIC.map((k) => [k, room[k]]));
  return { target: t, room: out, lists, progress, gatePassed, files: files.results.map((f) => ({ ...f, url: `/api/files/${f.id}` })), clocks: clocks(room), gateSignal: gateSignal(room, firstFin), redFlagMatrix: RED_FLAG_MATRIX, healthcare: HEALTHCARE.test(`${t.industry} ${t.name}`) };
}

// Milestones. Moving one forward also moves the pipeline stage forward (never back).
const STAGE_ORDER = ["sourced", "contacted", "first_call", "meeting", "docs", "loi", "diligence", "closed"];
export async function updateRoom(env, ctx, targetId, b) {
  const t = await target(env, ctx, targetId);
  await ensureRoom(env, ctx.accountId, t);
  const c = {};
  for (const k of ["first_contact", "offer_at", "loi_signed_at", "dd_start", "contract_start", "settled_at"]) if (k in b) c[k] = ymd(b[k]);
  for (const k of ["offer_price", "final_price", "budget_fees", "spent_fees"]) if (k in b) { const n = numOrNull(b[k]); if (n != null && n < 0) throw err(400, "Amounts can't be negative"); c[k] = n; }
  if ("exclusivity_days" in b) { const n = numOrNull(b.exclusivity_days); c.exclusivity_days = n == null ? null : Math.max(0, Math.min(365, Math.round(n))); }
  if ("offer_kind" in b) c.offer_kind = ["NBIO", "LOI"].includes(b.offer_kind) ? b.offer_kind : null;
  if ("offer_terms" in b) c.offer_terms = text(b.offer_terms, 4000);
  if ("seller_name" in b) c.seller_name = text(b.seller_name, 120);
  const keys = Object.keys(c);
  if (!keys.length) return getRoom(env, ctx, targetId);
  const stamp = now();
  const prev = await env.DB.prepare("SELECT * FROM deal_rooms WHERE target_id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId).first();
  await env.DB.prepare(`UPDATE deal_rooms SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${keys.length + 3} WHERE target_id = ?1 AND account_id = ?2`).bind(t.id, ctx.accountId, ...keys.map((k) => c[k]), stamp).run();
  const stmts = [];
  const note = (body) => stmts.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6)").bind(ctx.accountId, t.id, ctx.user.id || null, displayName(ctx), body, stamp));
  let stage = null;
  if (c.offer_at && !prev.offer_at) { note(`${c.offer_kind || prev.offer_kind || "Offer"} sent${c.offer_price ? ` at ${c.offer_price.toLocaleString("en")}` : ""}.`); stage = "loi"; }
  if (c.loi_signed_at && !prev.loi_signed_at) { note(`LOI signed. Exclusivity ${c.exclusivity_days ?? prev.exclusivity_days ?? "?"} days.`); stage = "loi"; }
  if (c.dd_start && !prev.dd_start) { note("Due diligence started (90-day window)."); stage = "diligence"; }
  if (c.contract_start && !prev.contract_start) note("Contract papering started (4-week target).");
  if (c.settled_at && !prev.settled_at) {
    note(`Settled${c.final_price ? ` at ${c.final_price.toLocaleString("en")}` : ""}. First 100 days start.`); stage = "closed";
    // The 100-day plan's dates follow settlement: Day 30, 60 and 100.
    for (const x of ROOM_TEMPLATES.plan) stmts.push(env.DB.prepare("UPDATE deal_items SET due_date = ?4 WHERE account_id = ?1 AND target_id = ?2 AND list = 'plan' AND section = ?3 AND due_date IS NULL").bind(ctx.accountId, t.id, x.section, addDaysTo(c.settled_at, x.day)));
  }
  if (stage && STAGE_ORDER.indexOf(stage) > STAGE_ORDER.indexOf(t.stage)) {
    stmts.push(env.DB.prepare("UPDATE targets SET stage = ?3, stage_at = ?4, updated_at = ?4 WHERE id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId, stage, stamp));
    stmts.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'stage', ?5, ?6)").bind(ctx.accountId, t.id, ctx.user.id || null, displayName(ctx), `Stage → ${stage}`, stamp));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return getRoom(env, ctx, targetId);
}

function cleanItem(b, partial) {
  const c = {};
  if ("title" in b || !partial) { c.title = text(b.title, 300); if (!c.title) throw err(400, "Write what's needed"); }
  if ("section" in b) c.section = text(b.section, 120);
  if ("status" in b) { if (!STATUSES.has(b.status)) throw err(400, "Unknown status"); c.status = b.status; }
  if ("severity" in b) c.severity = SEVERITIES.has(b.severity) ? b.severity : null;
  if ("action" in b) c.action = text(b.action, 300) || null;
  if ("owner" in b) c.owner = text(b.owner, 80);
  if ("due_date" in b) c.due_date = ymd(b.due_date);
  if ("notes" in b) c.notes = text(b.notes, 4000);
  if ("seller" in b) c.seller = b.seller ? 1 : 0;
  if ("upload" in b) c.upload = b.upload ? 1 : 0;
  return c;
}

export async function addItem(env, ctx, targetId, b) {
  const t = await target(env, ctx, targetId);
  await ensureRoom(env, ctx.accountId, t);
  if (!LISTS.has(b.list)) throw err(400, "list is gate, dd, cp, close or plan");
  const c = cleanItem(b, false);
  // A red flag picked from the matrix brings its severity and action with it.
  const flag = RED_FLAG_MATRIX.find((f) => f.flag === c.title);
  if (flag) Object.assign(c, { status: "issue", severity: flag.severity, action: flag.action, section: c.section || "Red flags" });
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM deal_items WHERE account_id = ?1 AND target_id = ?2").bind(ctx.accountId, t.id).first();
  if (n >= 400) throw err(400, "That's 400 items in this room");
  const stamp = now();
  const cols = { account_id: ctx.accountId, target_id: t.id, list: b.list, section: "", sort: 10000 + n, created_at: stamp, updated_at: stamp, ...c };
  const keys = Object.keys(cols);
  return env.DB.prepare(`INSERT INTO deal_items (${keys.join(", ")}) VALUES (${keys.map((_, i) => `?${i + 1}`).join(", ")}) RETURNING *`).bind(...keys.map((k) => cols[k])).first();
}

export async function updateItem(env, ctx, id, b) {
  const c = cleanItem(b, true);
  const keys = Object.keys(c);
  if (!keys.length) throw err(400, "Nothing to change");
  if (c.status) c.done_at = ["done", "received"].includes(c.status) ? now() : null;
  const all = Object.keys(c);
  const row = await env.DB.prepare(`UPDATE deal_items SET ${all.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${all.length + 3} WHERE id = ?1 AND account_id = ?2 RETURNING *`).bind(+id, ctx.accountId, ...all.map((k) => c[k]), now()).first();
  if (!row) throw err(404, "No such item");
  return row;
}

export async function deleteItem(env, ctx, id) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM deal_items WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
    env.DB.prepare("UPDATE room_files SET item_id = NULL WHERE item_id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
  ]);
  return { ok: true };
}

// ------------------------------------------------------------------ files (team and seller uploads)
// Stored in D1: small files in files.data, larger ones in ~1.8 MB chunks.
export async function storeFile(env, accountId, targetId, { name, mime, bytes, itemId = null, source = "team", userId = null }) {
  const used = (await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE account_id = ?1").bind(accountId).first()).n;
  if (used + bytes.length > WORKSPACE_BYTES) throw err(413, "This workspace's file storage is full. Delete old files from deal rooms first.");
  const stamp = now();
  // With an R2 bucket bound (FILES), the bytes live there and D1 keeps only the record (chunks = -1). Without one,
  // small files go in files.data and larger ones in ~1.8 MB chunks.
  const r2 = !!env.FILES;
  const chunks = r2 ? -1 : bytes.length > CHUNK ? Math.ceil(bytes.length / CHUNK) : 0;
  const f = await env.DB.prepare("INSERT INTO files (account_id, target_id, name, mime, size, data, kind, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'room', ?7, ?8) RETURNING id")
    .bind(accountId, targetId, name, mime, bytes.length, chunks ? new Uint8Array(0) : bytes, userId, stamp).first();
  if (r2) await env.FILES.put(r2Key(accountId, f.id), bytes, { httpMetadata: { contentType: mime } });
  else for (let i = 0; i < chunks; i++) await env.DB.prepare("INSERT INTO file_chunks (file_id, n, data) VALUES (?1, ?2, ?3)").bind(f.id, i, bytes.subarray(i * CHUNK, (i + 1) * CHUNK)).run();
  await env.DB.prepare("INSERT INTO room_files (file_id, account_id, target_id, item_id, source, chunks) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(f.id, accountId, targetId, itemId, source, chunks).run();
  return { id: f.id, name, size: bytes.length, created_at: stamp };
}
export const r2Key = (accountId, fileId) => `room/${accountId}/${fileId}`;

// The bytes of a stored file (chunked or not), or null.
export async function fileBytes(env, accountId, id) {
  const f = await env.DB.prepare("SELECT f.name, f.mime, f.data, rf.chunks FROM files f LEFT JOIN room_files rf ON rf.file_id = f.id WHERE f.id = ?1 AND f.account_id = ?2").bind(+id, accountId).first();
  if (!f) return null;
  if (f.chunks === -1) {
    const o = env.FILES ? await env.FILES.get(r2Key(accountId, id)) : null;
    return o ? { name: f.name, mime: f.mime, body: new Uint8Array(await o.arrayBuffer()) } : null;
  }
  if (!f.chunks) return { name: f.name, mime: f.mime, body: f.data instanceof ArrayBuffer ? f.data : new Uint8Array(f.data) };
  const { results } = await env.DB.prepare("SELECT data FROM file_chunks WHERE file_id = ?1 ORDER BY n").bind(+id).all();
  const parts = results.map((r) => new Uint8Array(r.data)), size = parts.reduce((t, p) => t + p.length, 0);
  const body = new Uint8Array(size);
  let o = 0; for (const p of parts) { body.set(p, o); o += p.length; }
  return { name: f.name, mime: f.mime, body };
}

export function checkUpload(file) {
  if (!file || typeof file === "string" || !file.size) throw err(400, "Pick a file");
  if (file.size > MAX_FILE) throw err(413, "Files up to 20 MB. Split it or send a PDF.");
  const ext = extOf(file.name);
  if (!MIME[ext]) throw err(415, "PDF, Excel, CSV, Word, text or an image (PNG/JPG) only");
  return { name: text(file.name, 160).replace(/[\\/\0]/g, "_"), mime: MIME[ext] };
}

async function roomFileCount(env, accountId, targetId) {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM room_files WHERE account_id = ?1 AND target_id = ?2").bind(accountId, targetId).first()).n;
}

export async function teamUpload(env, ctx, targetId, form) {
  const t = await target(env, ctx, targetId);
  await ensureRoom(env, ctx.accountId, t);
  const file = form.get("file"), { name, mime } = checkUpload(file);
  if ((await roomFileCount(env, ctx.accountId, t.id)) >= MAX_ROOM_FILES) throw err(400, `That's ${MAX_ROOM_FILES} files in this room; delete some first`);
  let itemId = +form.get("item") || null;
  if (itemId && !(await env.DB.prepare("SELECT 1 FROM deal_items WHERE id = ?1 AND account_id = ?2 AND target_id = ?3").bind(itemId, ctx.accountId, t.id).first())) itemId = null;
  return storeFile(env, ctx.accountId, t.id, { name, mime, bytes: new Uint8Array(await file.arrayBuffer()), itemId, source: "team", userId: ctx.user.id || null });
}

export async function deleteRoomFile(env, ctx, id) {
  if (env.FILES && (await env.DB.prepare("SELECT 1 FROM files WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first())) await env.FILES.delete(r2Key(ctx.accountId, +id));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM file_chunks WHERE file_id = (SELECT id FROM files WHERE id = ?1 AND account_id = ?2)").bind(+id, ctx.accountId),
    env.DB.prepare("DELETE FROM room_files WHERE file_id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
    env.DB.prepare("DELETE FROM files WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId),
  ]);
  return { ok: true };
}

// ------------------------------------------------------------------ the seller's link
export async function createLink(env, ctx, targetId, origin) {
  const t = await target(env, ctx, targetId);
  await ensureRoom(env, ctx.accountId, t);
  const token = randomToken("r_");
  const expires = new Date(Date.now() + LINK_DAYS * 864e5).toISOString();
  await env.DB.prepare("UPDATE deal_rooms SET token_hash = ?3, token_hint = ?4, link_on = 1, link_expires_at = ?6, updated_at = ?5 WHERE target_id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId, await sha256(token), token.slice(-4), now(), expires).run();
  // Asking for the gate items is the moment they become "requested".
  await env.DB.prepare("UPDATE deal_items SET status = 'requested', updated_at = ?3 WHERE account_id = ?1 AND target_id = ?2 AND list = 'gate' AND seller = 1 AND status = 'open'").bind(ctx.accountId, t.id, now()).run();
  return { url: `${origin}/r/${token}`, expires_at: expires, note: `Anyone with this link can see the requested items and upload to them until ${expires.slice(0, 10)} (${LINK_DAYS} days). Making a new link turns the old one off.` };
}

export async function revokeLink(env, ctx, targetId) {
  await env.DB.prepare("UPDATE deal_rooms SET link_on = 0, token_hash = NULL, updated_at = ?3 WHERE target_id = ?1 AND account_id = ?2").bind(+targetId, ctx.accountId, now()).run();
  return { ok: true };
}

// Queue a polite chase for outstanding gate items. Nothing is sent until the user approves it in the Inbox.
export async function chaseSeller(env, ctx, targetId, b) {
  const room = await getRoom(env, ctx, targetId);
  const open = (room.lists.gate || []).filter((i) => i.seller && ["open", "requested"].includes(i.status));
  if (!open.length) throw err(400, "Nothing outstanding on the qualification gate");
  const to = await env.DB.prepare("SELECT email FROM targets WHERE id = ?1 AND account_id = ?2").bind(room.target.id, ctx.accountId).first();
  if (!to?.email) throw err(400, "Add the owner's email to the target first");
  const first = String(room.room.seller_name || room.target.owner_name || "").split(" ")[0] || "there";
  const link = b?.link ? `\n\nYou can send everything through this private link: ${String(b.link).slice(0, 300)}` : "";
  const id = await propose(env, ctx.accountId, {
    tool: "send_email", target_id: room.target.id, source: "deal room", dedupe: `chase:${room.target.id}:${now().slice(0, 10)}`,
    title: `Chase ${room.target.name} for the qualification documents`,
    reason: `${open.length} gate item${open.length === 1 ? "" : "s"} outstanding: ${open.map((i) => i.title).join("; ")}`,
    input: { to: to.email, target_id: room.target.id, subject: `${room.target.name}: next step`, body: `Hi ${first},\n\nThanks again for your time. To keep things moving, could you send over:\n${open.map((i) => `- ${i.title}`).join("\n")}${link}\n\nNo pressure at all, whenever suits.` },
  });
  return { queued: !!id, inbox: id };
}

// What the seller sees: only items marked for them, the names of what they've sent, and the buyer's name.
async function roomByToken(env, token) {
  if (!/^r_[\w-]{20,64}$/.test(String(token || ""))) throw err(404, "This link isn't valid");
  const room = await env.DB.prepare("SELECT * FROM deal_rooms WHERE token_hash = ?1 AND link_on = 1").bind(await sha256(token)).first();
  if (!room) throw err(404, "This link has been turned off. Ask the buyer for a new one.");
  if (room.link_expires_at && room.link_expires_at < now()) throw err(410, "This link has expired. Ask the buyer for a new one.");
  return room;
}

export async function sellerView(env, token) {
  const room = await roomByToken(env, token);
  const [t, acct, items, files] = await env.DB.batch([
    env.DB.prepare("SELECT name FROM targets WHERE id = ?1 AND account_id = ?2").bind(room.target_id, room.account_id),
    env.DB.prepare("SELECT name FROM accounts WHERE id = ?1").bind(room.account_id),
    env.DB.prepare("SELECT id, section, title, status, upload FROM deal_items WHERE account_id = ?1 AND target_id = ?2 AND seller = 1 ORDER BY list, sort, id").bind(room.account_id, room.target_id),
    env.DB.prepare("SELECT f.id, f.name, f.size, f.created_at, rf.item_id, rf.source FROM room_files rf JOIN files f ON f.id = rf.file_id JOIN deal_items i ON i.id = rf.item_id AND i.seller = 1 WHERE rf.account_id = ?1 AND rf.target_id = ?2 ORDER BY f.id").bind(room.account_id, room.target_id),
  ]);
  await env.DB.prepare("UPDATE deal_rooms SET seller_views = seller_views + 1, seller_seen_at = ?2 WHERE target_id = ?1").bind(room.target_id, now()).run();
  return {
    business: t.results[0]?.name || "", buyer: acct.results[0]?.name || "", nda: room.nda_at ? { at: room.nda_at, name: room.nda_name } : null,
    items: items.results.map((i) => ({ ...i, files: files.results.filter((f) => f.item_id === i.id).map((f) => ({ id: f.id, name: f.name, size: f.size, created_at: f.created_at, mine: f.source === "seller" })) })),
    maxMb: MAX_FILE / 1048576,
  };
}

// The seller accepts the NDA by typing their name (a record of acceptance; the buyer's lawyer decides whether a
// signed copy is also needed, which the seller can upload to the same item).
export async function sellerNda(env, token, b, ip, hooks) {
  const room = await roomByToken(env, token);
  const name = text(b.name, 120);
  if (name.length < 3 || !b.agree) throw err(400, "Type your full name and tick the box");
  const stamp = now();
  // The acceptance record (who, when, from where) is written once and never overwritten by a later visitor.
  const first = await env.DB.prepare("UPDATE deal_rooms SET nda_at = ?2, nda_name = ?3, nda_ip = ?4, seller_name = COALESCE(seller_name, ?3), updated_at = ?2 WHERE target_id = ?1 AND nda_at IS NULL").bind(room.target_id, stamp, name, String(ip || "").slice(0, 60)).run();
  if (!first.meta.changes) return { ok: true, already: true };
  await env.DB.batch([
    env.DB.prepare("UPDATE deal_items SET status = 'done', done_at = ?3, updated_at = ?3 WHERE account_id = ?1 AND target_id = ?2 AND list = 'gate' AND title LIKE 'NDA%'").bind(room.account_id, room.target_id, stamp),
    env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'Seller link', 'note', ?3, ?4)").bind(room.account_id, room.target_id, `NDA accepted by ${name} on the seller link.`, stamp),
  ]);
  hooks?.(room.account_id).emit("room.nda_accepted", { target_id: room.target_id, name });
  return { ok: true };
}

export async function sellerUpload(env, token, form, hooks) {
  const room = await roomByToken(env, token);
  const itemId = +form.get("item");
  const item = await env.DB.prepare("SELECT id, title FROM deal_items WHERE id = ?1 AND account_id = ?2 AND target_id = ?3 AND seller = 1 AND upload = 1").bind(itemId, room.account_id, room.target_id).first();
  if (!item) throw err(400, "Pick what this file is for");
  const gate = await env.DB.prepare(`SELECT r.nda_at, (SELECT COUNT(*) FROM room_files rf JOIN files f ON f.id = rf.file_id WHERE rf.account_id = r.account_id AND rf.target_id = r.target_id AND rf.source = 'seller' AND f.created_at > ?3) AS recent
    FROM deal_rooms r WHERE r.target_id = ?1 AND r.account_id = ?2`).bind(room.target_id, room.account_id, new Date(Date.now() - 3600_000).toISOString()).first();
  if (!gate?.nda_at) throw err(403, "Accept the confidentiality agreement first");
  if (gate.recent >= SELLER_UPLOADS_PER_HOUR) throw err(429, "That's a lot of uploads in an hour. Try again later, or email the buyer.");
  const file = form.get("file"), { name, mime } = checkUpload(file);
  if ((await roomFileCount(env, room.account_id, room.target_id)) >= MAX_ROOM_FILES) throw err(400, "This room is full. Email the buyer instead.");
  const f = await storeFile(env, room.account_id, room.target_id, { name, mime, bytes: new Uint8Array(await file.arrayBuffer()), itemId: item.id, source: "seller" });
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare("UPDATE deal_items SET status = 'received', done_at = COALESCE(done_at, ?2), updated_at = ?2 WHERE id = ?1 AND status IN ('open', 'requested')").bind(item.id, stamp),
    env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'Seller link', 'doc', ?3, ?4)").bind(room.account_id, room.target_id, `Seller uploaded "${name}" for: ${item.title}`, stamp),
  ]);
  hooks?.(room.account_id).emit("room.file_uploaded", { target_id: room.target_id, item: item.title, file: name });
  return { ok: true, file: { id: f.id, name, size: f.size, created_at: f.created_at, mine: true } };
}

// The seller can download what the buyer attached to a seller-visible item (the buyer's NDA, a request list).
export async function sellerFile(env, token, fileId) {
  const room = await roomByToken(env, token);
  const ok = await env.DB.prepare("SELECT 1 FROM room_files rf JOIN deal_items i ON i.id = rf.item_id AND i.seller = 1 WHERE rf.file_id = ?1 AND rf.account_id = ?2 AND rf.target_id = ?3 AND rf.source = 'team'").bind(+fileId, room.account_id, room.target_id).first();
  if (!ok) throw err(404, "No such file");
  const f = await fileBytes(env, room.account_id, fileId);
  return new Response(f.body, { headers: { "Content-Type": f.mime, "Content-Disposition": `attachment; filename="${f.name.replace(/[^\w.-]/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}

// Once an R2 bucket is bound, move files stored in D1 across, a few per run (cron), oldest first.
export async function migrateFilesToR2(env, limit = 15) {
  if (!env.FILES) return { moved: 0 };
  const { results } = await env.DB.prepare("SELECT file_id, account_id FROM room_files WHERE chunks >= 0 ORDER BY file_id LIMIT ?1").bind(limit).all();
  let moved = 0;
  for (const r of results) {
    const b = await fileBytes(env, r.account_id, r.file_id);
    if (!b) continue;
    await env.FILES.put(r2Key(r.account_id, r.file_id), b.body, { httpMetadata: { contentType: b.mime } });
    await env.DB.batch([
      env.DB.prepare("UPDATE room_files SET chunks = -1 WHERE file_id = ?1").bind(r.file_id),
      env.DB.prepare("UPDATE files SET data = ?2 WHERE id = ?1").bind(r.file_id, new Uint8Array(0)),
      env.DB.prepare("DELETE FROM file_chunks WHERE file_id = ?1").bind(r.file_id),
    ]);
    moved++;
  }
  return { moved };
}
