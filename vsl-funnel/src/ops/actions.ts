import type { Runtime } from '../app';
import { newId } from '../lib/ids';

/**
 * The shared action layer every AI department writes through (Funnel HQ → Command).
 *
 *  - logAction:   record something that already happened (activity log).
 *  - proposeAction: queue something for the owner's Approve / Edit / Reject, unless its kind is listed in
 *                 OPS_AUTO_KINDS, in which case it runs at once (actor "auto") and the outcome is logged.
 *  - registerActionHandler: how a department teaches the layer to carry out one kind of action once approved.
 *
 * Nothing that spends money, sends to leads in bulk, changes ads or contacts a client may bypass proposeAction.
 */
export const DEPTS = ['chief', 'research', 'marketing', 'sales', 'client_success', 'support', 'content', 'dm'] as const;
export type Dept = (typeof DEPTS)[number];
export type Actor = 'auto' | 'you' | 'slack' | 'ai';
export type ActionStatus = 'done' | 'proposed' | 'approved' | 'rejected' | 'failed';
export type Risk = 'low' | 'medium' | 'high';
export const ACTORS: Actor[] = ['auto', 'you', 'slack', 'ai'];
export const STATUSES: ActionStatus[] = ['done', 'proposed', 'approved', 'rejected', 'failed'];
export const DEPT_LABEL: Record<Dept, string> = {
  chief: 'Chief of Staff', research: 'Research', marketing: 'Marketing', sales: 'Sales', client_success: 'Client Success', support: 'Support', content: 'Content', dm: 'DM inbox',
};

export interface LogInput {
  dept: Dept; kind: string; summary: string; detail?: string | null; leadId?: string | null;
  actor: Actor; status: ActionStatus; payload?: unknown; risk?: Risk | null; result?: string | null; source?: string | null;
}
export interface ProposeInput {
  dept: Dept; kind: string; summary: string; detail: string; payload: unknown; risk: Risk;
  leadId?: string | null; source?: string | null; actor?: Actor;
}
export type HandlerResult = { ok: boolean; summary: string };
export type ActionHandler = (rt: Runtime, payload: unknown) => Promise<HandlerResult>;

export interface ActionRow {
  id: string; dept: Dept; kind: string; summary: string; detail: string | null; lead_id: string | null; actor: Actor; status: ActionStatus;
  risk: Risk | null; payload: string | null; result: string | null; source: string | null; decided_by: string | null; decided_at: number | null;
  executed_at: number | null; edited_at: number | null; created_at: number; updated_at: number;
}

const handlers = new Map<string, { run: ActionHandler; label?: string }>();

/** Teach the layer to carry out one kind of action. A later registration for the same kind replaces the earlier one. */
export function registerActionHandler(kind: string, handler: ActionHandler, o: { label?: string } = {}) {
  handlers.set(kind, { run: handler, label: o.label });
}
export const hasHandler = (kind: string) => handlers.has(kind);
export const handlerKinds = () => [...handlers.entries()].map(([kind, h]) => ({ kind, label: h.label ?? kind })).sort((a, b) => a.kind.localeCompare(b.kind));
/** For tests: forget every registered handler. */
export const clearHandlers = () => handlers.clear();

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+$/g, '').slice(0, n);
const isDept = (d: unknown): d is Dept => typeof d === 'string' && (DEPTS as readonly string[]).includes(d);
const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
export const parsePayload = (raw: string | null): unknown => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

/** The kinds the owner switched to "auto" (OPS_AUTO_KINDS, comma list; default none). "dept.*" covers a whole department's kinds. */
export function autoKinds(rt: Pick<Runtime, 'settings'>): string[] {
  const raw = String((rt.settings as Partial<Record<string, string>>).OPS_AUTO_KINDS ?? '');
  return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}
export function isAuto(rt: Pick<Runtime, 'settings'>, kind: string) {
  return autoKinds(rt).some((k) => k === kind || (k.endsWith('.*') && kind.startsWith(k.slice(0, -1))) || k === '*');
}

/** Record an action. Returns its id. */
export async function logAction(rt: Runtime, a: LogInput, now = Date.now()): Promise<string> {
  const id = newId('act_');
  const dept = isDept(a.dept) ? a.dept : 'chief';
  await rt.env.DB.prepare(
    `INSERT INTO ops_actions (id, dept, kind, summary, detail, lead_id, actor, status, risk, payload, result, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, dept, clip(a.kind, 80), clip(a.summary, 300), a.detail ? clip(a.detail, 4000) : null, a.leadId ?? null, a.actor, a.status, a.risk ?? null,
    json(a.payload), a.result ? clip(a.result, 1000) : null, a.source ? clip(a.source, 120) : null, now, now).run();
  return id;
}

/** Queue an action for approval, or run it now when its kind is set to auto. Returns its id. */
export async function proposeAction(rt: Runtime, p: ProposeInput, now = Date.now()): Promise<string> {
  const auto = isAuto(rt, p.kind);
  const id = await logAction(rt, { dept: p.dept, kind: p.kind, summary: p.summary, detail: p.detail, payload: p.payload, risk: p.risk, leadId: p.leadId, source: p.source, actor: p.actor ?? 'ai', status: 'proposed' }, now);
  if (auto) await execute(rt, id, 'auto', now);
  return id;
}

export async function getAction(rt: Runtime, id: string) {
  return rt.env.DB.prepare('SELECT * FROM ops_actions WHERE id = ?').bind(id).first<ActionRow>();
}

/** Carry out a proposed action through its handler and record the outcome. */
async function execute(rt: Runtime, id: string, by: 'you' | 'slack' | 'auto', now: number) {
  // Claim: only a still-proposed action moves on (two clicks, or Slack and the dashboard at once, run it once).
  const claim = await rt.env.DB.prepare("UPDATE ops_actions SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ? AND status = 'proposed'").bind(by, now, now, id).run();
  if (!claim.meta.changes) return { ok: false, summary: 'This action was already decided.' };
  const row = (await getAction(rt, id))!;
  const h = handlers.get(row.kind);
  if (!h) {
    const summary = 'Approved. Nothing carries out this kind of action automatically yet, so do it by hand.';
    await rt.env.DB.prepare('UPDATE ops_actions SET result = ?, updated_at = ? WHERE id = ?').bind(summary, now, id).run();
    return { ok: true, summary };
  }
  let res: HandlerResult;
  try { res = await h.run(rt, parsePayload(row.payload)); } catch (e) { res = { ok: false, summary: e instanceof Error ? e.message : 'The handler failed.' }; }
  const done = Date.now();
  await rt.env.DB.prepare('UPDATE ops_actions SET status = ?, result = ?, executed_at = ?, updated_at = ? WHERE id = ?')
    .bind(res.ok ? 'done' : 'failed', clip(res.summary, 1000), done, done, id).run();
  return res;
}

export async function approveAction(rt: Runtime, id: string, by: 'you' | 'slack' = 'you', now = Date.now()) {
  const row = await getAction(rt, id);
  if (!row) return { ok: false, summary: 'Action not found.' };
  return execute(rt, id, by, now);
}

export async function rejectAction(rt: Runtime, id: string, by: 'you' | 'slack' = 'you', reason = '', now = Date.now()) {
  const r = await rt.env.DB.prepare("UPDATE ops_actions SET status = 'rejected', decided_by = ?, decided_at = ?, result = ?, updated_at = ? WHERE id = ? AND status = 'proposed'")
    .bind(by, now, reason ? clip(`Rejected: ${reason}`, 1000) : 'Rejected.', now, id).run();
  return { ok: Boolean(r.meta.changes), summary: r.meta.changes ? 'Rejected.' : 'This action was already decided.' };
}

/** Edit a proposal before approving it: summary, detail and the payload (JSON) its handler receives. */
export async function editAction(rt: Runtime, id: string, e: { summary?: unknown; detail?: unknown; payload?: unknown }, now = Date.now()) {
  const row = await getAction(rt, id);
  if (!row) return { ok: false, error: 'Action not found.' };
  if (row.status !== 'proposed') return { ok: false, error: 'Only a proposed action can be edited.' };
  let payload = row.payload;
  if (e.payload !== undefined) {
    if (typeof e.payload === 'string') { try { payload = JSON.stringify(JSON.parse(e.payload)); } catch { return { ok: false, error: 'The payload must be valid JSON.' }; } }
    else payload = JSON.stringify(e.payload);
  }
  const summary = typeof e.summary === 'string' && e.summary.trim() ? clip(e.summary.trim(), 300) : row.summary;
  const detail = typeof e.detail === 'string' ? clip(e.detail, 4000) : row.detail;
  await rt.env.DB.prepare('UPDATE ops_actions SET summary = ?, detail = ?, payload = ?, edited_at = ?, updated_at = ? WHERE id = ?').bind(summary, detail, payload, now, now, id).run();
  return { ok: true };
}

export interface ActionFilter { dept?: string; actor?: string; status?: string; limit?: number; before?: number; since?: number }
export async function listActions(rt: Runtime, f: ActionFilter = {}) {
  const where: string[] = ['1 = 1'];
  const args: (string | number)[] = [];
  if (f.dept && isDept(f.dept)) { where.push('dept = ?'); args.push(f.dept); }
  if (f.actor && (ACTORS as string[]).includes(f.actor)) { where.push('actor = ?'); args.push(f.actor); }
  if (f.status && (STATUSES as string[]).includes(f.status)) { where.push('status = ?'); args.push(f.status); }
  if (f.before) { where.push('created_at < ?'); args.push(f.before); }
  if (f.since) { where.push('created_at >= ?'); args.push(f.since); }
  const limit = Math.max(1, Math.min(500, f.limit ?? 100));
  const { results } = await rt.env.DB.prepare(`SELECT * FROM ops_actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`).bind(...args, limit).all<ActionRow>();
  return results;
}

/** What the log shows in the "who" column: Auto / You / AI / Slack. A proposal approved by you reads "AI → You". */
export function actorLabel(r: Pick<ActionRow, 'actor' | 'decided_by'>) {
  const name = (a: string | null) => (a === 'auto' ? 'Auto' : a === 'you' ? 'You' : a === 'slack' ? 'Slack' : a === 'ai' ? 'AI' : '');
  const first = name(r.actor);
  const second = name(r.decided_by);
  return second && second !== first ? `${first} → ${second}` : first;
}
