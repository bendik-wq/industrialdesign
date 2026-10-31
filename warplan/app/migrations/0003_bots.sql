-- Prospecting bots (schema v21). Safe to re-run.
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,             -- sends from this person's connected mailbox
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused', -- active | paused
  mode TEXT NOT NULL DEFAULT 'review',  -- review (Inbox approval) | autopilot (sends on its own)
  industry TEXT NOT NULL,
  areas TEXT NOT NULL DEFAULT '[]',     -- JSON list of areas it rotates through
  buying TEXT NOT NULL DEFAULT '',      -- what you're looking to buy, as it reads in the email
  sender_name TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  daily_new INTEGER NOT NULL DEFAULT 10,
  touches INTEGER NOT NULL DEFAULT 6,   -- emails per prospect before it moves to the call list
  gap_days INTEGER NOT NULL DEFAULT 1,
  send_hour INTEGER NOT NULL DEFAULT 9,
  timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  owner_emails INTEGER NOT NULL DEFAULT 1, -- look up the owner's own email (paid data) before falling back to the front desk
  templates TEXT NOT NULL DEFAULT '{}',
  cursor TEXT NOT NULL DEFAULT '{}',    -- where the search left off, per area
  last_run_on TEXT,                     -- local date of the last daily run
  lock_until TEXT,                      -- a run in progress (so two can't overlap)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bots_account ON bots (account_id);
CREATE TABLE IF NOT EXISTS bot_prospects (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  email_kind TEXT NOT NULL DEFAULT '',  -- owner | decision_maker | front_desk
  status TEXT NOT NULL DEFAULT 'active', -- active | replied | opted_out | bounced | call | no_email | removed
  step INTEGER NOT NULL DEFAULT 0,      -- emails sent
  next_at TEXT,
  subject TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',   -- Message-ID of the first email, for threading follow-ups
  action_id INTEGER,                    -- review mode: the Inbox proposal for the latest email
  score INTEGER NOT NULL DEFAULT 0,
  signals TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, target_id)
);
CREATE INDEX IF NOT EXISTS bot_prospects_due ON bot_prospects (bot_id, status, next_at);
CREATE TABLE IF NOT EXISTS bot_log (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  target_id INTEGER,
  kind TEXT NOT NULL,                   -- found | sent | follow_up | queued | replied | call | skipped | error | run
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_log_bot ON bot_log (bot_id, id DESC);
