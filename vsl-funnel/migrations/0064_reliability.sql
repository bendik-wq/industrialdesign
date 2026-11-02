-- Reliability (overnight loop, round 1): inbound webhook bookkeeping, Durable Object clean-up log and indexes
-- for the hottest queries. Additive only: new tables and CREATE INDEX IF NOT EXISTS.

-- One row per inbound webhook event (Resend, Calendly, ElevenLabs, Instagram, WhatsApp, Zapier): a provider's
-- retry of an event already handled is answered without running it twice; a failed run runs again on the retry;
-- Instagram events are stored before they are acknowledged and processed in the background (the cron retries).
CREATE TABLE IF NOT EXISTS webhook_events (
  id          TEXT PRIMARY KEY,                -- provider:event id (or provider:sha256:<body hash> when the provider sends no id)
  provider    TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  kind        TEXT,                            -- event type, when known
  status      TEXT NOT NULL,                   -- processing | done | failed | queued
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  payload     TEXT,                            -- queued events only; cleared once processed
  received_at INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_retry ON webhook_events(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_webhook_events_provider ON webhook_events(provider, received_at);

-- Rooms whose Durable Object storage was cleared after the room ended (ROOM_DO_KEEP_DAYS).
CREATE TABLE IF NOT EXISTS room_do_gc (
  room_id    TEXT PRIMARY KEY,
  cleaned_at INTEGER NOT NULL,
  detail     TEXT
);

-- ── indexes for the hot queries (scripts/d1-perf.mjs has the before/after plans and timings) ──
-- Resend bounces/complaints mark the email by its provider id (was a full scan of emails per webhook).
CREATE INDEX IF NOT EXISTS idx_emails_provider ON emails(provider_id);
-- Funnel HQ overview and funnel map: emails sent in a date range, per sequence.
CREATE INDEX IF NOT EXISTS idx_emails_sent ON emails(sent_at);
CREATE INDEX IF NOT EXISTS idx_emails_seq_sent ON emails(sequence, sent_at);
-- AI call caps (cron, per call placed: kind != 'test' AND created_at > ?) and the funnel map's calls per kind.
CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_calls(created_at);
CREATE INDEX IF NOT EXISTS idx_outbound_kind_created ON outbound_calls(kind, created_at);
-- Calls to one number (abuse cap), inbound caller lookups.
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone);
-- Attribution stage sync (cron) and the Webinar tab: registrations by date.
CREATE INDEX IF NOT EXISTS idx_webinar_reg_created ON webinar_registrations(created_at);
-- WhatsApp: duplicate deliveries and status updates find the message by its provider id.
CREATE INDEX IF NOT EXISTS idx_wa_provider ON whatsapp_messages(provider_id);
-- Lead journey: VSL views by browser.
CREATE INDEX IF NOT EXISTS idx_vsl_visitor ON vsl_views(visitor_id, started_at);
-- Webinar tab: chat stats and the SMS log by date.
CREATE INDEX IF NOT EXISTS idx_wchat_created ON webinar_chat(created_at);
CREATE INDEX IF NOT EXISTS idx_sms_created ON sms_messages(created_at);
-- Attribution: paid-social touches in a date range.
CREATE INDEX IF NOT EXISTS idx_attr_touches_ts ON attr_touches(ts);
-- Unpaid challenge registrations (sales follow-ups cron).
CREATE INDEX IF NOT EXISTS idx_chreg_status ON challenge_registrations(status, created_at);
