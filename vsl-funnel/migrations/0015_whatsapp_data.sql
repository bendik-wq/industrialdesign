-- WhatsApp as a channel for the SMS sequences, and the data-buyer referral page.
ALTER TABLE sms_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'sms';
-- Consent wording that names WhatsApp (application v2 / webinar). Older consents cover calls and texts only.
ALTER TABLE leads ADD COLUMN wa_consent_at INTEGER;

CREATE TABLE IF NOT EXISTS data_referrals (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  first_name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  website TEXT,
  phone TEXT,
  revenue TEXT,
  visitor_id TEXT,
  session_id TEXT,
  channel TEXT,
  utm_source TEXT,
  utm_campaign TEXT,
  country TEXT,
  redirected INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_data_referrals_created ON data_referrals (created_at);
CREATE INDEX IF NOT EXISTS idx_data_referrals_email ON data_referrals (email);
