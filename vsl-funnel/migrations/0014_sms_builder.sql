-- SMS builder: two-way confirmations ("Reply C to confirm").
ALTER TABLE leads ADD COLUMN sms_confirmed_at INTEGER;
-- Consent to texts only (webinar sign-up), separate from call consent (which also covers AI calls).
ALTER TABLE leads ADD COLUMN sms_consent_at INTEGER;
