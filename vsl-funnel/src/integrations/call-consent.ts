import type { Runtime } from '../app';
import { CONSENT_COPY, captureConsent } from './consent-gate';

/**
 * Kept for older imports. The consent wording, its version and the recording now live in consent-gate.ts
 * (two separate boxes, calls and texts, with proof in consent_events).
 */
export const WEBINAR_CALL_CONSENT = { version: CONSENT_COPY.version, text: CONSENT_COPY.call };

/** The call box only (forms record both boxes with captureConsent). Returns true when call consent was recorded. */
export async function recordCallConsent(rt: Pick<Runtime, 'env'>, leadId: string, phone: string | null, body: Record<string, unknown>, now = Date.now()) {
  const r = await captureConsent(rt, leadId, { call_consent: body.call_consent }, { phone, source: 'form', page: '' }, now);
  return r.call;
}
