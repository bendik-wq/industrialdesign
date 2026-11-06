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
  | 'voice_resource_sent'
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
  webinar_offer_purchased: 'Purchase', // the First Deal Sprint bought in the masterclass; value = what was paid
  webinar_seat_purchased: 'Purchase', // the paid masterclass ticket (value = the ticket price); won deals are Purchase too, each with its own order id and content name
  engagement_deposit_purchased: 'Purchase', // the engagement deposit (live webinar / challenge); value = what was paid
  live_ticket_purchased: 'Purchase', // the paid live webinar ticket
  live_registered: 'CompleteRegistration',
  // The acquisition readiness quiz (src/quiz): custom events. Saving a seat is the registration's own CompleteRegistration.
  quiz_start: 'QuizStart',
  quiz_lead: 'QuizLead',
  quiz_result: 'QuizResult',
  // Webinar attribution (src/attribution): the challenge's registration and purchases, which had no Meta event,
  // plus Lead once per registration and custom events for attending and seeing the offer (sent once each).
  challenge_registered: 'CompleteRegistration',
  challenge_ticket_paid: 'Purchase',
  challenge_vip_paid: 'Purchase',
  deposit_addon_purchased: 'Purchase', // the optional one-click add-on after the engagement deposit (src/sales/deposit-addon.ts); order id = its pass id
  ticket_addon_purchased: 'Purchase', // the optional one-click add-on on the masterclass ticket page (src/webinar/ticket-addon.ts); order id = its pass id
  attr_lead: 'Lead',
  attr_attended: 'WebinarAttended',
  attr_offer_seen: 'WebinarOfferSeen',
  attr_room_application: 'WebinarRoomApplication', // src/rooms: the application sent inside a live room (once per registration)
  attr_room_purchase: 'WebinarRoomPurchase', // src/rooms: a Sprint or deposit bought from a card pushed in a live room (once per registration)
  attr_watched_50: 'WebinarWatched50', // src/audiences: once per registration, from the room's watch data
  attr_checkout_started: 'InitiateCheckout', // src/audiences: once per registration that opened a checkout
  // Deep-funnel signals (src/tracking/signals.ts): custom events, once per person per session.
  signal_watched_30m: 'Watched30Min',
  signal_stayed_for_pitch: 'StayedForPitch',
  signal_offer_opened: 'OfferCardOpened',
  signal_checkout_started: 'OfferCheckoutStarted',
  signal_application_submitted: 'RoomApplicationSubmitted',
  signal_contract_signed: 'EngagementSigned', // offline conversion (system_generated); value = the contract fee
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
  webinar_seat_purchased: 'purchase', // the paid masterclass ticket
  engagement_deposit_purchased: 'purchase',
  live_ticket_purchased: 'purchase',
  live_registered: 'sign_up',
  quiz_start: 'quiz_start',
  quiz_answer: 'quiz_answer',
  quiz_gate_view: 'quiz_gate_view',
  quiz_lead: 'quiz_lead',
  quiz_result: 'quiz_result',
  quiz_register: 'quiz_register',
  challenge_registered: 'sign_up',
  challenge_ticket_paid: 'purchase',
  challenge_vip_paid: 'purchase',
  ticket_addon_purchased: 'purchase',
  deposit_addon_purchased: 'purchase',
  attr_lead: 'generate_lead',
  attr_attended: 'webinar_attended',
  attr_offer_seen: 'webinar_offer_seen',
  app_submitted: 'submit_application',
  lead_qualified: 'qualify_lead',
  booking_scheduled: 'book_appointment',
  whatsapp_click: 'contact_whatsapp',
};
