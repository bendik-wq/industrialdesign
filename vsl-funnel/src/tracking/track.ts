import type { Runtime } from '../app';
import type { Env } from '../env';
import type { VisitorCtx } from '../lib/identity';
import { newId } from '../lib/ids';
import type { EventSource, ServerEvent } from './catalog';
import { forwardEvent } from './forward';
import type { MatchGeo } from './match';

/** Who an event belongs to, plus what ad platforms need to match it. */
export interface TrackIdentity {
  visitorId: string | null;
  sessionId: string | null;
  leadId: string | null;
  variant?: string | null;
  isBot?: boolean;
  isNewVisitor?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  marketingConsent?: boolean;
  pageUrl?: string | null;
  /** IP geolocation of the visitor's session, used for Meta match keys. */
  geo?: MatchGeo | null;
}

export interface TrackInput {
  name: ServerEvent | (string & {});
  source: EventSource;
  props?: Record<string, unknown>;
  path?: string | null;
  /** Reuse a client-generated id so Pixel + CAPI events deduplicate. */
  eventId?: string;
}

export const identityFromVisitor = (v: VisitorCtx, pageUrl?: string | null, leadId?: string | null): TrackIdentity => ({
  visitorId: v.visitorId,
  sessionId: v.sessionId,
  leadId: leadId ?? v.leadId,
  variant: v.variant,
  isBot: v.isBot,
  isNewVisitor: v.isNewVisitor,
  ip: v.ip,
  userAgent: v.userAgent,
  fbp: v.fbp,
  fbc: v.fbc,
  marketingConsent: v.marketingConsent,
  pageUrl: pageUrl ?? null,
  geo: { country: v.geo.country, region: v.geo.region, regionCode: v.geo.regionCode, city: v.geo.city, postalCode: v.geo.postalCode },
});

/**
 * Identity for events that happen without the visitor present (webhooks, cron,
 * email opens): rebuilt from the lead and their most recent session so ad
 * platforms can still match the conversion.
 */
export async function identityFromLead(env: Env, leadId: string): Promise<TrackIdentity> {
  const row = await env.DB.prepare(
    `SELECT l.visitor_id, l.variant, l.fbp, l.fbc, s.id AS session_id, s.ip, s.user_agent, s.is_eu,
            s.country, s.region, s.region_code, s.city, s.postal_code
       FROM leads l
       LEFT JOIN sessions s ON s.visitor_id = l.visitor_id
      WHERE l.id = ?
      ORDER BY s.last_seen_at DESC LIMIT 1`,
  )
    .bind(leadId)
    .first<{
      visitor_id: string | null; variant: string | null; fbp: string | null; fbc: string | null; session_id: string | null; ip: string | null;
      user_agent: string | null; is_eu: number | null; country: string | null; region: string | null; region_code: string | null; city: string | null; postal_code: string | null;
    }>();
  return {
    visitorId: row?.visitor_id ?? null,
    sessionId: row?.session_id ?? null,
    leadId,
    variant: row?.variant ?? null,
    ip: row?.ip ?? null,
    userAgent: row?.user_agent ?? null,
    fbp: row?.fbp ?? null,
    fbc: row?.fbc ?? null,
    // Lead-level events after an application imply the visitor accepted our terms;
    // EU visitors still only forward if they granted consent on the site.
    marketingConsent: !row?.is_eu,
    geo: row ? { country: row.country, region: row.region, regionCode: row.region_code, city: row.city, postalCode: row.postal_code } : null,
  };
}

/** Write one event to the first-party stream and fan it out to connected tools. Returns the event id. */
export async function track(rt: Runtime, who: TrackIdentity, input: TrackInput): Promise<string> {
  const id = input.eventId && /^[\w-]{8,64}$/.test(input.eventId) ? input.eventId : newId('e');
  const ts = Date.now();
  const props = input.props && Object.keys(input.props).length ? JSON.stringify(input.props).slice(0, 8000) : null;

  const stmts = [
    rt.env.DB.prepare(
      'INSERT OR IGNORE INTO events (id, ts, name, visitor_id, session_id, lead_id, path, source, variant, is_bot, props) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(id, ts, input.name, who.visitorId, who.sessionId, who.leadId, input.path ?? null, input.source, who.variant ?? null, who.isBot ? 1 : 0, props),
  ];
  if (who.sessionId) stmts.push(rt.env.DB.prepare('UPDATE sessions SET event_count = event_count + 1, last_seen_at = ? WHERE id = ?').bind(ts, who.sessionId));
  await rt.env.DB.batch(stmts);

  if (!who.isBot) rt.waitUntil(forwardEvent(rt, who, { id, ts, name: input.name, props: input.props ?? {}, path: input.path ?? null, source: input.source }));
  return id;
}
