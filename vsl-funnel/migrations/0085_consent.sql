-- Consent proof and the contact gate's log (src/integrations/consent-gate.ts). Additive only: leads is near
-- D1's 100-column limit, so proof lives here. Nothing is backfilled: rows exist only for consents captured
-- (and withdrawals seen) from this migration on. Older consents keep their leads.* timestamp as "legacy proof".

-- One row per consent given or withdrawn, per channel. A grant applies only to `phone` (E.164): when the
-- lead's number changes, a 'revoked' row (source 'phone-changed') is written and the old grant stops counting.
CREATE TABLE IF NOT EXISTS consent_events (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  channel       TEXT NOT NULL,              -- call | sms | whatsapp
  action        TEXT NOT NULL,              -- granted | revoked
  phone         TEXT,                       -- the number the consent (or withdrawal) applies to
  source        TEXT NOT NULL,              -- which form or event: apply, webinar, live, challenge, admission, webinar-thanks, live-texts, stop-reply, do-not-call, phone-changed, unticked
  page_url      TEXT,                       -- the page path the form was on
  text_version  TEXT,                       -- the version of the wording shown
  text          TEXT,                       -- the exact wording shown next to the box
  ip_hash       TEXT,                       -- HMAC of the IP (never the IP itself)
  user_agent    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_consent_events_lead ON consent_events(lead_id, channel, created_at);
CREATE INDEX IF NOT EXISTS idx_consent_events_at ON consent_events(created_at);

-- Every automated call or text the gate refused (outcome 'blocked'), and every owner test send it let through
-- (outcome 'test'), so Funnel HQ can list them. Blocks are deduped per lead, channel, purpose and reason per hour.
CREATE TABLE IF NOT EXISTS contact_gate_log (
  id          TEXT PRIMARY KEY,
  lead_id     TEXT,
  channel     TEXT NOT NULL,                -- call | sms | whatsapp
  purpose     TEXT NOT NULL,                -- e.g. ai_call:confirm, sms:booked, live_text, followup_text, test
  outcome     TEXT NOT NULL,                -- blocked | test
  reason      TEXT NOT NULL,
  phone       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contact_gate_log_at ON contact_gate_log(created_at);
CREATE INDEX IF NOT EXISTS idx_contact_gate_log_lead ON contact_gate_log(lead_id, created_at);
