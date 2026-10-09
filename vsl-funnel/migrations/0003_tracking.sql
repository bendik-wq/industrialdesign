-- Delivery log for every server-side conversion sent to Meta CAPI / GA4 (and
-- PostHog failures). Failed sends keep their payload and are retried by cron.
CREATE TABLE forward_log (
  event_id     TEXT NOT NULL,
  dest         TEXT NOT NULL,          -- meta | ga4 | posthog | webhook
  event_name   TEXT NOT NULL,
  ts           INTEGER NOT NULL,       -- when the event happened
  status       TEXT NOT NULL,          -- sent | failed | retrying
  attempts     INTEGER NOT NULL DEFAULT 1,
  http_status  INTEGER,
  error        TEXT,
  response     TEXT,                   -- e.g. Meta fbtrace_id / events_received
  match_keys   TEXT,                   -- comma list of user_data keys sent to Meta
  payload      TEXT,                   -- request body, kept only until delivered
  next_try_at  INTEGER,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (event_id, dest)
);
CREATE INDEX idx_forward_status ON forward_log(status, next_try_at);
CREATE INDEX idx_forward_ts ON forward_log(ts);

ALTER TABLE sessions ADD COLUMN region_code TEXT;
