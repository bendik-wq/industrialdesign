# Tracking (first-party, server-side first)

## Identity
- `_fv`: visitor id. A **server-set** HttpOnly, Secure, SameSite=Lax cookie with a 400-day life, so Safari's 7-day cap on JS cookies doesn't apply.
- `_fs`: session id. Times out after 30 minutes of inactivity, and a new ad click (new click id or UTMs) starts a new session.
- `withVisitor` middleware: resolves or creates the visitor and session, parses UA and bots, captures the Cloudflare geo/ASN/TLS, and writes the session row.
- **Page views are written server-side before the HTML is returned.** Skip prefetch/prerender (`Sec-Purpose`, `Purpose` headers).
- Identity stitching: contact details at application step 1 back-fill the anonymous history onto the lead. A tracked email link clicked on another device links that browser to the same lead.
- Webhooks and cron rebuild IP, UA, fbp and fbc from the lead's last session, so offline conversions still match in Meta.

## Attribution
- UTMs plus 11 ad click ids (gclid, gbraid, wbraid, fbclid, ttclid, msclkid, li_fat_id, twclid, ScCid, epik, rdt_cid). GA4-style channel grouping.
- First touch is stored on the visitor (`ft_*`). Last **non-direct** touch is stored on the lead at capture.
- `/l/:code` tracked links for YouTube descriptions, pinned comments and end screens. Each has a label, video, placement and default UTMs.
- Meta URL parameter template: `utm_source=facebook&utm_medium=paid&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&utm_term={{adset.name}}&ad_id={{ad.id}}&adset_id={{adset.id}}&placement={{placement}}`

## Event catalog (`src/tracking/catalog.ts`)
- Server/lifecycle: page_view, lead_captured, app_step, app_submitted, lead_qualified, booking_scheduled, booking_cancelled, lead_status_changed, email_sent/opened/clicked, whatsapp_click, ai_call_started/completed/unanswered.
- VSL: vsl_play, vsl_unmute, vsl_25/50/75/95/complete, vsl_cta_reveal, vsl_cta_click, vsl_rewatch, vsl_skip, vsl_pause, vsl_speed, vsl_volume, vsl_fullscreen.
- Deep on-page (client, **local only**, never forwarded): click, cta_hover, field_interaction (focus, time, corrections, paste, left empty: **never the value**), tab_return, text_select / text_copy (capped length, background only), section_dwell, section_revisit, page_exit, first_interaction, scroll, engaged time, rage clicks, exit intent, faq_open.
- `f.js` caps deep events at 150 per page. Sections are marked with `data-section="video|guarantee|testimonials|book_cta|…"` or `section[id]`.

## VSL heartbeat
The player posts every 10 s with a 100-bucket watched bitmap. The server ORs it into `vsl_views.buckets` and fires each milestone exactly once. A view counts only after the viewer unmutes. The pitch timestamp (`ctaRevealAt`) reveals the CTA, and returning visitors see it straight away.

## Forwarding (`src/tracking/forward.ts`)
- `track(rt, identity, { name, source, props, localOnly })` writes to D1, then fans out unless `localOnly` or in `MICRO_EVENTS`.
- **Meta CAPI**: SHA-256-hashed email, phone, name and country, plus fbp/fbc, IP and UA. `event_id` deduplicates with the Pixel. Use `META_TEST_EVENT_CODE` while testing. Optimise ads on `QualifiedLead` or `Schedule`, with value weighted by tier.
- **GA4** Measurement Protocol, **PostHog** server-side (distinct_id = visitor id; optional session replay through the first-party `/ph` proxy with inputs masked), and a **CRM webhook** with a lead snapshot.
- Retries go through `forward_log` with backoff, and the match keys are logged so the Tracking tab can show match quality.
- **EU consent:** with `CONSENT_REQUIRED_EU`, nothing is forwarded and no third-party script loads until the visitor consents. Optional `IP_ANONYMIZE` stores only an HMAC hash of the IP.
