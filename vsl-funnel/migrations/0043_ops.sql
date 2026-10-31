-- Funnel HQ → Command: the Chief of Staff and the shared action layer (src/ops/*).

-- Every action any department takes or proposes, and what came of it (the activity log and the approval queue).
CREATE TABLE ops_actions (
  id          TEXT PRIMARY KEY,
  dept        TEXT NOT NULL,              -- chief | research | marketing | sales | client_success | support | content | dm
  kind        TEXT NOT NULL,              -- e.g. marketing.pause_campaign; handlers are registered per kind
  summary     TEXT NOT NULL,
  detail      TEXT,
  lead_id     TEXT,
  actor       TEXT NOT NULL,              -- auto | you | slack | ai (who took or proposed it)
  status      TEXT NOT NULL,              -- done | proposed | approved | rejected | failed
  risk        TEXT,                       -- low | medium | high (proposals)
  payload     TEXT,                       -- JSON the handler receives
  result      TEXT,                       -- the outcome: the handler's summary, or why it failed
  source      TEXT,                       -- chat:<thread> | monitor:<alert> | routine:<id> | brief | <module>
  decided_by  TEXT,                       -- you | slack | auto (who approved / rejected)
  decided_at  INTEGER,
  executed_at INTEGER,
  edited_at   INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ops_actions_created ON ops_actions(created_at);
CREATE INDEX idx_ops_actions_status ON ops_actions(status, created_at);
CREATE INDEX idx_ops_actions_dept ON ops_actions(dept, created_at);

-- Command chat threads (owner chats, routine runs, briefs) and their messages.
CREATE TABLE ops_threads (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'chat', -- chat | routine | brief | alert
  routine_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_threads_updated ON ops_threads(updated_at);

CREATE TABLE ops_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  role       TEXT NOT NULL,               -- user | assistant
  content    TEXT NOT NULL,               -- what is shown (markdown, links only into Funnel HQ)
  tools      TEXT,                        -- JSON: the tool calls made for this answer, with their sources
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_messages_thread ON ops_messages(thread_id, created_at);

-- Saved recurring instructions, run by the 5-minute cron in the owner's time zone.
CREATE TABLE ops_routines (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  instruction TEXT NOT NULL,
  cadence     TEXT NOT NULL,              -- daily | weekdays | weekly
  weekday     INTEGER,                    -- 0 = Sunday … 6 = Saturday (weekly)
  time        TEXT NOT NULL,              -- HH:MM, owner's time zone
  timezone    TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_thread TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ops_routines_due ON ops_routines(enabled, next_run_at);

-- Proactive alerts from the hourly monitors (key = metric + window + direction, for the debounce).
CREATE TABLE ops_alerts (
  id         TEXT PRIMARY KEY,
  key        TEXT NOT NULL,
  metric     TEXT NOT NULL,
  span       TEXT NOT NULL,               -- 24h | 7d
  direction  TEXT NOT NULL,               -- drop | spike
  severity   TEXT NOT NULL,               -- medium | high
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,               -- markdown with the numbers and their sources
  current    REAL,
  prior      REAL,
  action_id  TEXT,                        -- the proposed action, when one applies
  sent_at    INTEGER,                     -- pushed to Slack
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_alerts_key ON ops_alerts(key, created_at);
CREATE INDEX idx_ops_alerts_created ON ops_alerts(created_at);

-- Documents made on request (month-to-date summary and others): markdown, downloadable, optionally in Google Drive.
CREATE TABLE ops_documents (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'custom', -- mtd | week | custom | brief
  body       TEXT NOT NULL,               -- markdown
  drive_url  TEXT,
  thread_id  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ops_documents_created ON ops_documents(created_at);
