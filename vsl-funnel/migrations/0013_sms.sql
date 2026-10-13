-- SMS follow-up (Twilio): queue + log, inbound replies, opt-outs.
CREATE TABLE sms_messages (
  id           TEXT PRIMARY KEY,
  lead_id      TEXT,
  direction    TEXT NOT NULL DEFAULT 'out',   -- out | in
  sequence     TEXT,
  step         INTEGER,
  template     TEXT,
  to_phone     TEXT,
  from_phone   TEXT,
  body         TEXT,
  link_target  TEXT,                          -- where /s/:id redirects (never taken from the URL)
  send_at      INTEGER,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | simulated | skipped | cancelled | failed | received
  attempts     INTEGER NOT NULL DEFAULT 0,
  sent_at      INTEGER,
  clicked_at   INTEGER,
  provider_id  TEXT,
  error        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_sms_dedupe ON sms_messages(lead_id, sequence, step) WHERE direction = 'out';
CREATE INDEX idx_sms_due ON sms_messages(status, send_at);
CREATE INDEX idx_sms_lead ON sms_messages(lead_id);

ALTER TABLE leads ADD COLUMN sms_opt_out_at INTEGER;
