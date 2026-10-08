import type { Runtime } from '../app';
import type { VisitorCtx } from '../lib/identity';
import { CLIENT_EVENTS } from './catalog';
import { identityFromVisitor, track } from './track';

interface ClientEvent {
  n: string;
  p?: Record<string, unknown>;
  eid?: string;
}

export interface CollectPayload {
  path?: string;
  url?: string;
  events?: ClientEvent[];
  meta?: { lang?: string; tz?: string; screen?: string; viewport?: string; dpr?: number; conn?: string };
}

const str = (v: unknown, max = 60) => (typeof v === 'string' ? v.slice(0, max) : null);

/** Sanitises client props: flat primitives only, bounded size. */
function cleanProps(p: unknown): Record<string, unknown> {
  if (!p || typeof p !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p).slice(0, 20)) {
    if (!/^[\w.-]{1,40}$/.test(k)) continue;
    if (typeof v === 'string') out[k] = v.slice(0, 300);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Client beacon: browser context (once per session) + whitelisted interaction events. */
export async function collect(rt: Runtime, v: VisitorCtx, body: CollectPayload) {
  const db = rt.env.DB;
  const path = str(body.path, 200);
  const pageUrl = str(body.url, 1000);

  if (body.meta) {
    const m = body.meta;
    await db.prepare('UPDATE sessions SET language = ?, client_tz = ?, screen = ?, viewport = ?, dpr = ?, connection = ? WHERE id = ?')
      .bind(str(m.lang, 20), str(m.tz, 60), str(m.screen, 20), str(m.viewport, 20), typeof m.dpr === 'number' ? m.dpr : null, str(m.conn, 20), v.sessionId)
      .run();
  }

  const accepted: string[] = [];
  for (const ev of (body.events ?? []).slice(0, 25)) {
    if (!ev || typeof ev.n !== 'string' || !CLIENT_EVENTS.has(ev.n)) continue;
    const props = cleanProps(ev.p);
    if (ev.n === 'scroll_depth' && typeof props.pct === 'number') {
      await db.prepare('UPDATE sessions SET max_scroll = MAX(max_scroll, ?) WHERE id = ?').bind(Math.min(100, props.pct), v.sessionId).run();
    }
    if (ev.n === 'engaged_time' && typeof props.ms === 'number') {
      await db.prepare('UPDATE sessions SET engaged_ms = engaged_ms + ? WHERE id = ?').bind(Math.min(30 * 60_000, Math.max(0, Math.round(props.ms))), v.sessionId).run();
    }
    accepted.push(await track(rt, identityFromVisitor(v, pageUrl), { name: ev.n, source: 'client', path, props, eventId: ev.eid }));
  }
  return accepted;
}
