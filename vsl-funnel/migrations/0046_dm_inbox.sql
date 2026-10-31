-- Instagram DM sales inbox (Funnel HQ → DM inbox). Data comes only from Meta's official Instagram API
-- (webhooks + conversations API) for the owner's connected professional account. Never scraped.

-- One conversation per Instagram-scoped user id (IGSID).
CREATE TABLE dm_threads (
  id               TEXT PRIMARY KEY,
  ig_user_id       TEXT NOT NULL UNIQUE,
  username         TEXT,
  name             TEXT,
  lead_id          TEXT,
  lead_match       TEXT,                       -- email | phone | handle | link | manual
  status           TEXT NOT NULL DEFAULT 'new', -- new | replied | qualified | booked | showed | closed | lost
  assignee_id      TEXT,                       -- reps.id (a setter)
  tags             TEXT NOT NULL DEFAULT '[]', -- JSON array
  band             TEXT,                       -- hot | warm | cold
  score            INTEGER,
  score_reason     TEXT,
  revenue_band     TEXT,                       -- detected from what they wrote
  ai_flag          TEXT,                       -- junk | closing | NULL
  ai_reason        TEXT,
  ai_checked_at    INTEGER,
  source           TEXT,                       -- dm | comment | story_reply | story_mention | ad | import
  source_detail    TEXT,
  link_code        TEXT,                       -- tracked link sent in this thread (attribution)
  link_sent_at     INTEGER,
  opener_script_id TEXT,                       -- first script used to open / answer the thread
  last_in_at       INTEGER,                    -- their last message (opens the messaging window)
  last_out_at      INTEGER,
  last_message_at  INTEGER,
  last_preview     TEXT,
  window_hours     INTEGER NOT NULL DEFAULT 24, -- 168 after a click-to-Direct ad
  unread           INTEGER NOT NULL DEFAULT 0,
  follow_up_at     INTEGER,
  deal_value       REAL NOT NULL DEFAULT 0,
  replied_at       INTEGER,
  booked_at        INTEGER,
  showed_at        INTEGER,
  closed_at        INTEGER,
  lost_at          INTEGER,
  summary_at       INTEGER,                    -- pre-call summary written
  hot_alerted_at   INTEGER,
  followup_alerted_at INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_dm_threads_last ON dm_threads(last_message_at);
CREATE INDEX idx_dm_threads_lead ON dm_threads(lead_id);
CREATE INDEX idx_dm_threads_assignee ON dm_threads(assignee_id, status);

CREATE TABLE dm_messages (
  id           TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  mid          TEXT UNIQUE,                    -- Meta message id (dedupes webhook retries, echoes and imports)
  direction    TEXT NOT NULL,                  -- in | out
  kind         TEXT NOT NULL DEFAULT 'text',   -- text | story_reply | story_mention | postback | referral | attachment | private_reply
  body         TEXT,
  media_url    TEXT,
  sent_by      TEXT,                           -- rep id, 'trigger', 'assistant', 'instagram' (sent from the app) or NULL for inbound
  script_id    TEXT,
  ai_drafted   INTEGER NOT NULL DEFAULT 0,
  tag          TEXT,                           -- HUMAN_AGENT when sent in the 7-day human agent window
  status       TEXT NOT NULL DEFAULT 'received', -- received | sent | failed
  error        TEXT,
  ts           INTEGER NOT NULL
);
CREATE INDEX idx_dm_messages_thread ON dm_messages(thread_id, ts);
CREATE INDEX idx_dm_messages_script ON dm_messages(script_id);

-- Comments on the account's posts and reels (for keyword triggers and private replies).
CREATE TABLE dm_comments (
  id                TEXT PRIMARY KEY,          -- Instagram comment id
  media_id          TEXT,
  ig_user_id        TEXT,
  username          TEXT,
  body              TEXT,
  parent_id         TEXT,
  thread_id         TEXT,
  trigger_id        TEXT,
  public_reply_id   TEXT,
  private_reply_at  INTEGER,                   -- Meta allows one private reply per comment, within 7 days
  error             TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX idx_dm_comments_user ON dm_comments(ig_user_id);

-- Team chat, notes and AI pre-call summaries per conversation.
CREATE TABLE dm_notes (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'note',     -- note | summary | system
  author     TEXT,
  body       TEXT NOT NULL,
  ts         INTEGER NOT NULL
);
CREATE INDEX idx_dm_notes_thread ON dm_notes(thread_id, ts);

-- Scripts / quick replies library (openers, follow-ups, FAQ answers, objection handling).
CREATE TABLE dm_scripts (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'opener',   -- opener | followup | faq | objection | booking
  shortcut   TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Keyword triggers on comments, Story replies and DMs.
CREATE TABLE dm_triggers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  keywords      TEXT NOT NULL,                 -- comma separated
  match_mode    TEXT NOT NULL DEFAULT 'word',  -- word | contains | exact
  sources       TEXT NOT NULL DEFAULT '["comment","story_reply","dm"]',
  tag           TEXT,
  assign_to     TEXT,
  first_message TEXT,
  script_id     TEXT,
  link_code     TEXT,
  public_reply  TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  hits          INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
