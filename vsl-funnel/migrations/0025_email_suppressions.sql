-- Addresses we must never email again: hard bounces and spam complaints reported by Resend, or added by hand.
CREATE TABLE email_suppressions (
  email       TEXT PRIMARY KEY,          -- lower-cased
  reason      TEXT NOT NULL,             -- bounced | complained | manual
  detail      TEXT,                      -- provider message, e.g. the bounce reason
  provider_id TEXT,                      -- Resend email id that triggered it
  created_at  INTEGER NOT NULL
);
