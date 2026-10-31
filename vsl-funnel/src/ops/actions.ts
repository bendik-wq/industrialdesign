/**
 * STUB of builder A's shared action log (src/ops/actions.ts). A's version wins at merge; builder C codes
 * against the agreed names (logAction, proposeAction, registerActionHandler) and, for the Ads autopilot tab,
 * the helpers below (getAction, listActions, decideAction, updateActionPayload). If A names those differently,
 * the Ads autopilot routes in src/marketing/admin.ts are the only callers to rename.
 *
 * The table is A's migration (0043). This stub creates a compatible table on first use so builder C's tree
 * and tests run without it.
 */
import type { Runtime } from '../app';
import { newId } from '../lib/ids';

export type Dept = 'chief' | 'research' | 'marketing' | 'sales' | 'client_success' | 'support' | 'content' | 'dm';
export type Actor = 'auto' | 'you' | 'slack' | 'ai';
export type ActionStatus = 'done' | 'proposed' | 'approved' | 'rejected' | 'failed';
export type Risk = 'low' | 'medium' | 'high';
export type ActionHandler = (rt: Runtime, payload: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>;

export interface ActionRow {
  id: string; dept: Dept; kind: string; summary: string; detail: string | null; lead_id: string | null; actor: Actor;
  status: ActionStatus; risk: Risk | null; payload: string | null; result: string | null; created_at: number; decided_at: number | null;
}

const handlers = new Map<string, ActionHandler>();
export function registerActionHandler(kind: string, handler: ActionHandler) { handlers.set(kind, handler); }
export const hasActionHandler = (kind: string) => handlers.has(kind);

const ready = new WeakSet<object>();
async function ensure(rt: Runtime) {
  if (ready.has(rt.env.DB)) return;
  await rt.env.DB.prepare(`CREATE TABLE IF NOT EXISTS ops_actions (
    id TEXT PRIMARY KEY, dept TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT, lead_id TEXT, actor TEXT NOT NULL,
    status TEXT NOT NULL, risk TEXT, payload TEXT, result TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`).run();
  ready.add(rt.env.DB);
}

/** Kinds the owner switched to auto (comma list in the OPS_AUTO_KINDS setting; A's settings win at merge). */
export function isAutoAllowed(rt: Runtime, kind: string) {
  const raw = String((rt.settings as unknown as Record<string, string | undefined>).OPS_AUTO_KINDS ?? '');
  return raw.split(/[\s,]+/).filter(Boolean).some((k) => k === kind || (k.endsWith('*') && kind.startsWith(k.slice(0, -1))));
}

export async function logAction(rt: Runtime, a: { dept: Dept; kind: string; summary: string; detail?: string; leadId?: string; actor: Actor; status: ActionStatus; payload?: unknown }) {
  await ensure(rt);
  const id = newId('act');
  await rt.env.DB.prepare('INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, a.dept, a.kind, a.summary.slice(0, 500), a.detail ?? null, a.leadId ?? null, a.actor, a.status, a.payload === undefined ? null : JSON.stringify(a.payload), Date.now()).run();
  return id;
}

async function execute(rt: Runtime, id: string, kind: string, payload: Record<string, unknown>, actor: Actor) {
  const h = handlers.get(kind);
  if (!h) {
    await rt.env.DB.prepare("UPDATE ops_actions SET status = 'failed', result = ?, decided_at = ? WHERE id = ?").bind(`No handler for ${kind}`, Date.now(), id).run();
    return { ok: false, summary: `No handler for ${kind}` };
  }
  let r: { ok: boolean; summary: string };
  try { r = await h(rt, { ...payload, _action_id: id }); } catch (e) { r = { ok: false, summary: String(e instanceof Error ? e.message : e).slice(0, 500) }; }
  await rt.env.DB.prepare('UPDATE ops_actions SET status = ?, result = ?, decided_at = ?, actor = ? WHERE id = ?').bind(r.ok ? 'done' : 'failed', r.summary.slice(0, 2000), Date.now(), actor, id).run();
  return r;
}

/** Queues a proposal for approval, or runs it now when the owner set this kind to auto. */
export async function proposeAction(rt: Runtime, a: { dept: Dept; kind: string; summary: string; detail: string; payload: Record<string, unknown>; risk: Risk; leadId?: string }) {
  await ensure(rt);
  const id = newId('act');
  await rt.env.DB.prepare("INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, risk, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, 'ai', 'proposed', ?, ?, ?)")
    .bind(id, a.dept, a.kind, a.summary.slice(0, 500), a.detail, a.leadId ?? null, a.risk, JSON.stringify(a.payload), Date.now()).run();
  if (isAutoAllowed(rt, a.kind)) await execute(rt, id, a.kind, a.payload, 'auto');
  return id;
}

export async function getAction(rt: Runtime, id: string) {
  await ensure(rt);
  return rt.env.DB.prepare('SELECT * FROM ops_actions WHERE id = ?').bind(id).first<ActionRow>();
}

export async function listActions(rt: Runtime, f: { dept?: Dept; kindPrefix?: string; status?: ActionStatus[]; limit?: number } = {}) {
  await ensure(rt);
  const where: string[] = []; const args: unknown[] = [];
  if (f.dept) { where.push('dept = ?'); args.push(f.dept); }
  if (f.kindPrefix) { where.push('kind LIKE ?'); args.push(`${f.kindPrefix}%`); }
  if (f.status?.length) { where.push(`status IN (${f.status.map(() => '?').join(',')})`); args.push(...f.status); }
  const { results } = await rt.env.DB.prepare(`SELECT * FROM ops_actions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`).bind(...args, f.limit ?? 100).all<ActionRow>();
  return results;
}

/** Approve (runs the handler) or reject a proposal. */
export async function decideAction(rt: Runtime, id: string, decision: 'approve' | 'reject', actor: Actor = 'you') {
  const row = await getAction(rt, id);
  if (!row) return { ok: false, summary: 'Not found' };
  if (row.status !== 'proposed') return { ok: false, summary: `Already ${row.status}` };
  if (decision === 'reject') {
    await rt.env.DB.prepare("UPDATE ops_actions SET status = 'rejected', decided_at = ?, actor = ? WHERE id = ? AND status = 'proposed'").bind(Date.now(), actor, id).run();
    return { ok: true, summary: 'Rejected' };
  }
  const claim = await rt.env.DB.prepare("UPDATE ops_actions SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'proposed'").bind(Date.now(), id).run();
  if (!claim.meta.changes) return { ok: false, summary: 'Already decided' };
  return execute(rt, id, row.kind, row.payload ? JSON.parse(row.payload) : {}, actor);
}

/** The owner's Edit before approving: replaces the payload (and summary) of a proposal still waiting. */
export async function updateActionPayload(rt: Runtime, id: string, payload: Record<string, unknown>, summary?: string) {
  await ensure(rt);
  const r = await rt.env.DB.prepare("UPDATE ops_actions SET payload = ?, summary = COALESCE(?, summary) WHERE id = ? AND status = 'proposed'").bind(JSON.stringify(payload), summary ?? null, id).run();
  return Boolean(r.meta.changes);
}
