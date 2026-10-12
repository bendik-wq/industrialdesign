# Data model (D1 migrations, in order)

Add columns with new migrations; never edit an applied migration. Apply with `wrangler d1 migrations apply DB --local|--remote`.

**0001_init**
- `visitors`: id (= `_fv` cookie), first-touch attribution (ft_channel/source/medium/campaign/content/term/referrer/landing/click_id/click_type), geo, device, is_bot, counters, lead_id.
- `sessions`: id, visitor_id, landing_path/query, referrer, channel, utm_*, click_id/click_type, ad_id/adset_id/placement, full Cloudflare geo (country, region, city, postal, tz, lat/long, is_eu, asn, colo), ip / ip_hash, user_agent + parsed device/browser/os, accept_language, client_tz, screen/viewport/dpr/connection, is_bot + bot_reason, A/B variant, pageviews, event_count, engaged_ms, max_scroll.
- `events`: id, ts, name, visitor_id, session_id, lead_id, path, source (client/server/webhook/cron/admin), variant, is_bot, props JSON. Index on (name, ts), (lead_id), (visitor_id).
- `leads`: id, ref_code, contact fields, whatsapp_opt_in, answers JSON, step_reached, app_started/completed_at, score, score_breakdown, tier, tier_override, route, closer_id, status (partial|applied|booked|showed|no_show|won|lost|nurture|disqualified), booking fields (booked_at, call_at, provider, ref, cancelled_at), WhatsApp fields, unsubscribed_at, revenue, notes, last + first-touch attribution, landing_path, variant, geo, device, fbp, fbc.
- `vsl_views`: per visitor × video: duration, max_position, watched_seconds, buckets (100-bit watched bitmap), played, unmuted, completed, cta_revealed, cta_clicked.
- `emails`: queue + log. UNIQUE(lead_id, sequence, step). status pending|sending|sent|simulated|skipped|cancelled|failed; opens and clicks.
- `whatsapp_messages`, `settings` (key/value), `kv_state` (round-robin pointers, cron gates, `map:layout`, `map:custom`).

**0002_voice** `voice_calls` (transcript, recording_url, structured, summary, cost) + `leads.do_not_call_at`.
**0003_tracking** `forward_log` (per event × destination, with retries and backoff, match keys, payload) + `sessions.region_code`.
**0004_links** `tracked_links` (code, label, kind, video id/title/thumbnail, placement, dest_path, utm defaults, clicks).
**0005_sales** `reps` (role closer/setter, tiers, weight, calendar_url, commission_pct, monthly_target, slack/discord ids, active) + leads cash_collected, closed_at, showed_at, lost_reason, setter_id.
**0006_ai_calls** `outbound_calls` (kind confirm|speed_to_lead|rebook|test, status queued|dialing|done|failed|cancelled, run_at, attempts, conversation_id, call_sid, outcome) + leads call_consent_at, call_consent_text, timezone.
**0007_personalized_emails** emails.personalized (ai|rules|fallback|off), facts_used JSON, personalize_error.
**0008_calendly** leads booking_join_url, booking_reschedule_url, booking_cancel_url, booking_host_email, booking_answers JSON [{q,a}], booking_source (funnel|calendly-direct).
**0009_calendly_bookings** `calendly_bookings` keyed by invitee_uri: the full booking history, including people never in the funnel.
**0010_deal_markers** leads industry, revenue_band, budget_band, willing_to_invest, qual_source, qual_flags, temperature, objection, follow_up_at, decision_maker, fit_rating, offer, payment_plan, installments_total, next_payment_at, contract_signed_at, refunded_at, refund_amount, loi_signed_at, target_business + the `payments` ledger.
**0011_landers** sessions.lander, leads.lander, leads.ft_lander.
