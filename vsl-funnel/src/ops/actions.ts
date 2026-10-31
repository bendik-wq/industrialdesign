import type { Runtime } from '../app';
import { newId } from '../lib/ids';

/**
 * STUB of builder A's shared action log (src/ops/actions.ts, table ops_actions in migration 0043).
 * Same names and signatures; A's version replaces this file at merge. Until then it writes to
 * ops_actions when the table exists and otherwise only logs to the console, so nothing breaks.
 */
export type Dept = 'chief' | 'research' | 'marketing' | 'sales' | 'client_success' | 'support' | 'content' | 'dm';
export type Actor = 'auto' | 'you' | 'slack' | 'ai';
export type ActionStatus = 'done' | 'proposed' | 'approved' | 'rejected' | 'failed';

export interface ActionInput {
  dept: Dept;
  kind: string;
  summary: string;
  detail?: string;
  leadId?: string | null;
  actor: Actor;
  status: ActionStatus;
  payload?: unknown;
}

export async function logAction(rt: Runtime, a: ActionInput): Promise<string> {
  const id = newId('act');
  try {
    await rt.env.DB.prepare('INSERT INTO ops_actions (id, ts, dept, kind, summary, detail, lead_id, actor, status, payload) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(id, Date.now(), a.dept, a.kind, a.summary.slice(0, 500), a.detail?.slice(0, 4000) ?? null, a.leadId ?? null, a.actor, a.status, a.payload === undefined ? null : JSON.stringify(a.payload).slice(0, 8000))
      .run();
  } catch {
    console.log('action', a.dept, a.kind, a.status, a.summary);
  }
  return id;
}

type Handler = (rt: Runtime, payload: unknown) => Promise<{ ok: boolean; summary: string }>;
const handlers = new Map<string, Handler>();
export function registerActionHandler(kind: string, handler: Handler) { handlers.set(kind, handler); }

export async function proposeAction(rt: Runtime, a: { dept: Dept; kind: string; summary: string; detail: string; payload: unknown; risk: 'low' | 'medium' | 'high' }): Promise<string> {
  return logAction(rt, { dept: a.dept, kind: a.kind, summary: a.summary, detail: a.detail, actor: 'ai', status: 'proposed', payload: a.payload });
}
