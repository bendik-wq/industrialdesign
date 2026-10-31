import type { Runtime } from '../app';
import { getLead, updateLead } from '../funnel/leads';

/**
 * Call consent from the webinar, live Zoom and challenge registration forms: an optional, unticked box under
 * the optional mobile field. Bump the version whenever the wording changes; it is stored with the lead
 * (leads.call_consent_text) next to the time it was given (leads.call_consent_at), like the application's box.
 */
export const WEBINAR_CALL_CONSENT = {
  version: 'webinar-v1',
  text: 'Josh’s team may call or text me at this number about this session and Josh’s offers, including automated and AI-voice calls. Optional and not required to register. Say stop on a call or reply STOP to opt out at any time.',
};

const ticked = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1';

/**
 * Records the box when it was ticked with a valid number. A number is only ever added to a lead that has none
 * (anyone can type anyone's email address), and consent only counts for the number already on the lead.
 * Returns true when consent was recorded.
 */
export async function recordCallConsent(rt: Pick<Runtime, 'env'>, leadId: string, phone: string | null, body: Record<string, unknown>, now = Date.now()) {
  if (!phone || !ticked(body.call_consent)) return false;
  const lead = await getLead(rt.env, leadId);
  if (!lead || lead.do_not_call_at) return false;
  if (lead.phone && lead.phone !== phone) return false;
  await updateLead(rt.env, leadId, { ...(lead.phone ? {} : { phone }), call_consent_at: lead.call_consent_at ?? now, call_consent_text: lead.call_consent_text ?? WEBINAR_CALL_CONSENT.version });
  return true;
}
