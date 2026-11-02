-- Overnight loop round 1, "dataflow": daily data-quality checks and the export audit log (src/dataq/*).
-- New tables only (additive). leads is at D1's column limit and is not touched.

-- One row per check per local day (owner's time zone). A re-run on the same day replaces that day's row.
CREATE TABLE IF NOT EXISTS dq_results (
  day         TEXT NOT NULL,              -- YYYY-MM-DD in the owner's time zone
  check_key   TEXT NOT NULL,              -- e.g. leads_no_attribution (src/dataq/checks.ts)
  n           INTEGER,                    -- rows with the problem (NULL = could not be measured, e.g. Meta not connected)
  total       INTEGER,                    -- rows looked at (the denominator)
  examples    TEXT,                       -- JSON array of up to 10 example ids
  detail      TEXT,                       -- JSON: breakdown per kind / event / key
  computed_at INTEGER NOT NULL,
  PRIMARY KEY (day, check_key)
);
CREATE INDEX IF NOT EXISTS idx_dq_results_key ON dq_results(check_key, day);

-- Every export downloaded from Funnel HQ (who, what, which range, how many rows, with or without personal details).
CREATE TABLE IF NOT EXISTS dq_exports (
  id          TEXT PRIMARY KEY,
  dataset     TEXT NOT NULL,              -- leads | registrations | payments | rooms | emails | ai_calls
  format      TEXT NOT NULL,              -- csv | json
  from_ts     INTEGER NOT NULL,
  to_ts       INTEGER NOT NULL,
  pii         INTEGER NOT NULL DEFAULT 0, -- 1 = names, emails and phone numbers included
  rows        INTEGER,                    -- filled in when the stream finishes
  capped      INTEGER NOT NULL DEFAULT 0, -- 1 = stopped at the row cap
  actor       TEXT NOT NULL,              -- 'admin' (the signed-in Funnel HQ session)
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_dq_exports_created ON dq_exports(created_at);
