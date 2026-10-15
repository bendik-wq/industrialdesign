-- Engagement letters sent for e-signature from Funnel HQ.
CREATE TABLE contracts (
  id            TEXT PRIMARY KEY,
  token         TEXT NOT NULL UNIQUE,      -- secret part of the signing link
  lead_id       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | sent | viewed | signed | void
  title         TEXT NOT NULL,
  client_name   TEXT,
  client_email  TEXT,
  client_company TEXT,
  fee           INTEGER NOT NULL,          -- whole currency units
  currency      TEXT NOT NULL DEFAULT 'AUD',
  payment_terms TEXT,
  success_fee   TEXT,
  scope         TEXT,
  term_text     TEXT,
  quote_basis   TEXT,                      -- why the auto-quote suggested this fee
  body_html     TEXT,                      -- the document exactly as sent (frozen at send)
  doc_hash      TEXT,                      -- SHA-256 of body_html
  created_at    INTEGER NOT NULL,
  sent_at       INTEGER,
  viewed_at     INTEGER,
  signed_at     INTEGER,
  voided_at     INTEGER,
  reminders     INTEGER NOT NULL DEFAULT 0,
  last_reminder_at INTEGER,
  signer_name   TEXT,
  signer_title  TEXT,
  signature     TEXT,                      -- typed name, or a PNG data URL when drawn
  signature_kind TEXT,                     -- typed | drawn
  signer_ip     TEXT,
  signer_ua     TEXT,
  signer_country TEXT
);
CREATE INDEX idx_contracts_lead ON contracts(lead_id);
CREATE INDEX idx_contracts_status ON contracts(status, sent_at);
