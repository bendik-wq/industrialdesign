import type { Runtime } from '../app';
import { newId } from '../lib/ids';

/**
 * STUB of builder A's shared action layer (src/ops/actions.ts). A's version replaces this file at merge;
 * builder E's code relies only on logAction, proposeAction and registerActionHandler (the names and
 * signatures in the shared brief). The stub keeps its own `ops_actions` table (created on first use,
 * IF NOT EXISTS) so tests and local runs work before A's migration 0043 exists.
 */
export type Dept = 'chief' | 'research' | 'marketing' | 'sales' | 'client_success' | 'support' | 'content' | 'dm';
export type Actor = 'auto' | 'you' | 'slack' | 'ai';
export type ActionStatus = 'done' | 'proposed' | 'approved' | 'rejected' | 'failed';
export type Risk = 'low' | 'medium' | 'high';
export type ActionHandler = (rt: Runtime, payload: Record<string, unknown>) => Promise<{ ok: boolean; summary: string }>;

const handlers = new Map<string, ActionHandler>();
export function registerActionHandler(kind: string, handler: ActionHandler) { handlers.set(kind, handler); }

async function ensure(rt: Runtime) {
  await rt.env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ops_actions (id TEXT PRIMARY KEY, dept TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, detail TEXT,
      lead_id TEXT, actor TEXT NOT NULL, status TEXT NOT NULL, risk TEXT, payload TEXT, result TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)`,
  ).run();
}

export async function logAction(rt: Runtime, a: { dept: Dept; kind: string; summary: string; detail?: string; leadId?: string | null; actor: Actor; status: ActionStatus; payload?: unknown }): Promise<string> {
  await ensure(rt);
  const id = newId('act_');
  await rt.env.DB.prepare('INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, a.dept, a.kind, a.summary.slice(0, 300), a.detail ?? null, a.leadId ?? null, a.actor, a.status, a.payload == null ? null : JSON.stringify(a.payload), Date.now()).run();
  return id;
}

/** Kinds the owner switched to "auto" (stub only: a comma list in OPS_AUTO_KINDS; A's layer has its own setting). */
const autoKinds = (rt: Runtime) => String((rt.settings as Partial<Record<string, string>>).OPS_AUTO_KINDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

export async function proposeAction(rt: Runtime, a: { dept: Dept; kind: string; summary: string; detail: string; payload: Record<string, unknown>; risk: Risk }): Promise<string> {
  await ensure(rt);
  const id = newId('act_');
  const auto = autoKinds(rt).includes(a.kind) && handlers.has(a.kind);
  await rt.env.DB.prepare('INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, risk, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, a.dept, a.kind, a.summary.slice(0, 300), a.detail, typeof a.payload.leadId === 'string' ? a.payload.leadId : null, auto ? 'auto' : 'ai', 'proposed', a.risk, JSON.stringify(a.payload), Date.now()).run();
  if (auto) await decideAction(rt, id, true);
  return id;
}

/** Approve (runs the registered handler) or reject a proposed action. */
export async function decideAction(rt: Runtime, id: string, approve: boolean) {
  await ensure(rt);
  const row = await rt.env.DB.prepare("SELECT kind, payload FROM ops_actions WHERE id = ? AND status = 'proposed'").bind(id).first<{ kind: string; payload: string | null }>();
  if (!row) return { ok: false, summary: 'Not waiting for a decision.' };
  if (!approve) {
    await rt.env.DB.prepare("UPDATE ops_actions SET status = 'rejected', decided_at = ? WHERE id = ?").bind(Date.now(), id).run();
    return { ok: true, summary: 'Rejected.' };
  }
  const h = handlers.get(row.kind);
  const res = h
    ? await h(rt, JSON.parse(row.payload ?? '{}') as Record<string, unknown>).catch((e: unknown) => ({ ok: false, summary: e instanceof Error ? e.message : 'failed' }))
    : { ok: false, summary: `No handler for ${row.kind}` };
  await rt.env.DB.prepare('UPDATE ops_actions SET status = ?, result = ?, decided_at = ? WHERE id = ?').bind(res.ok ? 'approved' : 'failed', res.summary, Date.now(), id).run();
  return res;
}
