-- Overnight round 1 (infra): an internal error log and per-job cron timings for Funnel HQ → Errors & cron.
-- Own tables only, additive. Rows older than 14 days are removed by the error-log retention job (src/infra/errors.ts).

-- One row per distinct error (fingerprint = kind + where + the message with numbers and ids blanked out).
CREATE TABLE IF NOT EXISTS app_errors (
  fingerprint TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,              -- request | webhook | cron | room
  source      TEXT NOT NULL,              -- route pattern, webhook path, cron job name or room handler
  message     TEXT NOT NULL,              -- the latest message (trimmed, secrets masked)
  stack       TEXT,                       -- the first lines of the latest stack
  count       INTEGER NOT NULL DEFAULT 0,
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  notified_at INTEGER                     -- when the "new error" Slack ping went out (setting ERRORS_SLACK)
);
CREATE INDEX IF NOT EXISTS idx_app_errors_last ON app_errors(last_at);

-- Counts per UTC day and fingerprint, for the per-day view.
CREATE TABLE IF NOT EXISTS app_error_days (
  day         TEXT NOT NULL,              -- YYYY-MM-DD (UTC)
  fingerprint TEXT NOT NULL,
  kind        TEXT NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, fingerprint)
);

-- One row per cron job: the latest run and running totals.
CREATE TABLE IF NOT EXISTS cron_runs (
  job          TEXT PRIMARY KEY,
  last_started INTEGER NOT NULL,
  last_ms      INTEGER,                   -- duration of the latest run (the budget, for a run still going when it passed it)
  last_status  TEXT NOT NULL,             -- ok | failed | slow (passed its time budget; it keeps running in the background)
  last_error   TEXT,
  last_ok_at   INTEGER,
  runs         INTEGER NOT NULL DEFAULT 0,
  fails        INTEGER NOT NULL DEFAULT 0,
  slow         INTEGER NOT NULL DEFAULT 0,
  total_ms     INTEGER NOT NULL DEFAULT 0,
  max_ms       INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL
);
