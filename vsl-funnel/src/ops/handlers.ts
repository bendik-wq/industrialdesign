import type { Runtime } from '../app';
import { registerActionHandler } from './actions';
import { saveDocument, summaryDocument } from './documents';
import { createRoutine, describeSchedule, RoutineError, cleanRoutine } from './routines';
import { opsSlackConfigured, postOps } from './slack';

/**
 * The Chief of Staff's own action kinds. Other departments register theirs from their own modules
 * (registerActionHandler in actions.ts); a kind with no handler is approved and then done by hand.
 */
const obj = (p: unknown) => (p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {});

export function registerCoreHandlers() {
  registerActionHandler('ops.routine_create', async (rt: Runtime, payload) => {
    try {
      const r = cleanRoutine(rt, obj(payload));
      await createRoutine(rt, obj(payload));
      return { ok: true, summary: `Routine "${r.name}" created: ${describeSchedule(r)}.` };
    } catch (e) {
      if (e instanceof RoutineError) return { ok: false, summary: e.message };
      throw e;
    }
  }, { label: 'Create a routine' });

  registerActionHandler('ops.slack_message', async (rt: Runtime, payload) => {
    const text = String(obj(payload).text ?? '').trim();
    if (!text) return { ok: false, summary: 'The message is empty.' };
    if (!opsSlackConfigured(rt)) return { ok: false, summary: 'Slack is not connected (Integrations → Alerts).' };
    const lines = text.split('\n');
    const sent = await postOps(rt, { title: lines[0].slice(0, 200), lines: lines.slice(1) });
    return sent.slack || sent.discord ? { ok: true, summary: 'Posted to the team channel.' } : { ok: false, summary: 'Slack did not accept the message.' };
  }, { label: 'Post to the team Slack' });

  registerActionHandler('ops.document', async (rt: Runtime, payload) => {
    const p = obj(payload);
    if (typeof p.range === 'string') {
      const d = await summaryDocument(rt, p.range);
      await saveDocument(rt, d);
      return { ok: true, summary: `Saved "${d.title}" in Documents.` };
    }
    const title = String(p.title ?? '').trim(), body = String(p.markdown ?? '').trim();
    if (!body) return { ok: false, summary: 'The document is empty.' };
    await saveDocument(rt, { title: title || 'Document', body });
    return { ok: true, summary: `Saved "${title || 'Document'}" in Documents.` };
  }, { label: 'Save a document' });
}

registerCoreHandlers();
