/**
 * Canonical event names. Server events are emitted by the Worker itself;
 * client events are the only names the public /e beacon accepts.
 */
export const CLIENT_EVENTS = new Set([
  'webinar_register_click', 'webinar_unmute', 'webinar_offer_shown',
  'voice_input', // { mode: live | record, field, what } — never the words
  'scroll_depth', // { pct: 25 | 50 | 75 | 100 }
  'engaged_time', // { ms } — sent when the page is hidden
  'cta_click', // { id, label }
  'cta_locked_click', // { at, unlock_at } tapped the locked button under the VSL
  'faq_open', // { q, video }
  'faq_video_play', // { video }
  'outbound_click', // { href }
  'app_view_step', // { step, question }
  'app_back', // { step }
  'form_error', // { step, field }
  'booking_view', // { provider }
  'booking_date_selected',
  'booking_scheduled_client', // { event_uri, invitee_uri }
  'consent_update', // { granted }
  'rage_click', // { selector }
  'copy_text',
  'text_copy', // { text }
  'section_dwell', // { <section id>: seconds visible, ... }
  'vsl_rewatch', // { video, from, to }
  'vsl_skip', // { video, from, to }
  'vsl_pause', // { video, at }
  'vsl_speed', // { video, rate }
  'vsl_volume', // { video, level, at }
  'vsl_fullscreen', // { video, at }
  'click', // { el, text, section, x, y (% of page), dead }
  'cta_hover', // { id, ms } hovered without clicking
  'field_interaction', // { field, ms, chars, changed, corrections, pasted, empty } (never values)
  'tab_return', // { away_s }
  'text_select', // { text, section }
  'section_revisit', // { section }
  'page_exit', // { section, scroll, s, interacted }
  'first_interaction', // { type, ms }
  'exit_intent',
]);

export type ServerEvent =
  | 'page_view'
  | 'lead_captured'
  | 'app_step_saved'
  | 'app_submitted'
  | 'lead_qualified'
  | 'lead_routed'
  | 'booking_scheduled'
  | 'booking_cancelled'
  | 'lead_status_changed'
  | 'whatsapp_click'
  | 'whatsapp_connected'
  | 'whatsapp_sent'
  | 'whatsapp_inbound'
  | 'email_sent'
  | 'email_open'
  | 'email_click'
  | 'unsubscribe'
  | 'vsl_play'
  | 'vsl_unmute'
  | 'vsl_25'
  | 'vsl_50'
  | 'vsl_75'
  | 'vsl_95'
  | 'vsl_complete'
  | 'vsl_cta_reveal'
  | 'vsl_cta_click'
  | 'voice_web_start'
  | 'voice_call_started'
  | 'voice_call_completed'
  | 'voice_link_sent'
  | 'voice_opt_out';

export type EventSource = 'server' | 'client' | 'webhook' | 'email' | 'cron' | 'admin';

/** Server events mapped to ad-platform conversions. Anything not listed stays first-party + PostHog only. */
export const META_EVENTS: Partial<Record<string, string>> = {
  page_view: 'PageView',
  vsl_play: 'ViewContent',
  vsl_50: 'VSL50',
  vsl_cta_reveal: 'VSLPitchReached',
  lead_captured: 'Lead',
  webinar_registered: 'CompleteRegistration',
  webinar_offer_purchased: 'FrontEndPurchase', // the masterclass offer (Acquisition Assessment); 'Purchase' stays for won deals
  webinar_seat_purchased: 'WebinarSeatPurchase',
  app_submitted: 'SubmitApplication',
  lead_qualified: 'QualifiedLead',
  booking_scheduled: 'Schedule',
  whatsapp_click: 'Contact',
};

export const GA4_EVENTS: Partial<Record<string, string>> = {
  page_view: 'page_view',
  vsl_play: 'video_start',
  vsl_50: 'video_progress',
  vsl_complete: 'video_complete',
  lead_captured: 'generate_lead',
  webinar_registered: 'sign_up',
  webinar_offer_purchased: 'front_end_purchase',
  webinar_seat_purchased: 'webinar_seat_purchase',
  app_submitted: 'submit_application',
  lead_qualified: 'qualify_lead',
  booking_scheduled: 'book_appointment',
  whatsapp_click: 'contact_whatsapp',
};
