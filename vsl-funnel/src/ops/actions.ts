import type { Runtime } from '../app';
import { newId } from '../lib/ids';

/**
 * STUB of the shared action layer (builder A owns src/ops/actions.ts and the ops_actions table; A's version
 * wins at merge). Same names and signatures, so departments can code against it. Writes to ops_actions when
 * the table exists and otherwise only logs, so nothing breaks in a tree without A's migration.
 */
export type Dept = 'chief' | 'research' | 'marketing' | 'sales' | 'client_success' | 'support' | 'content' | 'dm';
export type ActionActor = 'auto' | 'you' | 'slack' | 'ai';
export type ActionStatus = 'done' | 'proposed' | 'approved' | 'rejected' | 'failed';

export interface LogActionInput {
  dept: Dept; kind: string; summary: string; detail?: string; leadId?: string;
  actor: ActionActor; status: ActionStatus; payload?: unknown;
}
export interface ProposeActionInput { dept: Dept; kind: string; summary: string; detail: string; payload: unknown; risk: 'low' | 'medium' | 'high' }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ActionHandler = (rt: Runtime, payload: any) => Promise<{ ok: boolean; summary: string }>;

const handlers = new Map<string, ActionHandler>();
export function registerActionHandler(kind: string, handler: ActionHandler) { handlers.set(kind, handler); }

export async function logAction(rt: Runtime, a: LogActionInput): Promise<string> {
  const id = newId('act_');
  try {
    await rt.env.DB.prepare(
      'INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, a.dept, a.kind, a.summary, a.detail ?? null, a.leadId ?? null, a.actor, a.status, a.payload === undefined ? null : JSON.stringify(a.payload), Date.now(), Date.now()).run();
  } catch {
    console.log('ops action (stub)', a.dept, a.kind, a.status, a.summary);
  }
  return id;
}

export async function proposeAction(rt: Runtime, p: ProposeActionInput): Promise<string> {
  return logAction(rt, { dept: p.dept, kind: p.kind, summary: p.summary, detail: p.detail, actor: 'ai', status: 'proposed', payload: { ...(p.payload as object), risk: p.risk } });
}
