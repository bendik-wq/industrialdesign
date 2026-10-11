-- Sales team: reps (closers / setters), call outcomes and deal values on leads.
CREATE TABLE reps (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  email           TEXT,
  role            TEXT NOT NULL DEFAULT 'closer',   -- closer | setter | manager
  tiers           TEXT NOT NULL DEFAULT 'A,B',      -- which lead tiers they take
  weight          REAL NOT NULL DEFAULT 1,          -- share of round-robin
  calendar_url    TEXT,                             -- their booking link
  booking_setting TEXT,                             -- legacy: read the link from a setting (BOOKING_URL_A/B)
  commission_pct  REAL NOT NULL DEFAULT 0,          -- % of cash collected
  monthly_target  REAL NOT NULL DEFAULT 0,          -- revenue target per month
  slack_user_id   TEXT,                             -- for @mentions
  discord_user_id TEXT,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL
);
INSERT INTO reps (id, name, role, tiers, weight, booking_setting, created_at) VALUES
  ('josh', 'Josh Li', 'closer', 'A', 1, 'BOOKING_URL_A', 0),
  ('advisor', 'M&A Advisor', 'closer', 'B', 1, 'BOOKING_URL_B', 0);

ALTER TABLE leads ADD COLUMN cash_collected REAL NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN closed_at INTEGER;
ALTER TABLE leads ADD COLUMN showed_at INTEGER;
ALTER TABLE leads ADD COLUMN lost_reason TEXT;
ALTER TABLE leads ADD COLUMN setter_id TEXT;
CREATE INDEX idx_leads_call ON leads(call_at);
CREATE INDEX idx_leads_closer ON leads(closer_id);
