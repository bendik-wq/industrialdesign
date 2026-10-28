-- The real live layer on top of the recorded masterclass: who is actually in a showing right now,
-- the showing's chat (real viewers and clearly labelled team messages), announcements (one-off from the
-- host console, or scheduled for a minute of every showing), "get a call from Josh's team" requests,
-- the team's private replies to room questions, and the peak number of people in each showing.

-- Chat messages, scoped to one showing. The autoincrement id is the feed cursor.
CREATE TABLE webinar_chat (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  reg_id       TEXT,                    -- the viewer's registration (null for team messages)
  lead_id      TEXT,
  author       TEXT NOT NULL,           -- viewer | team
  name         TEXT NOT NULL,           -- "Dana K.", "An owner", or the team display name
  body         TEXT NOT NULL,           -- sanitised plain text (links, emails, phone numbers removed)
  at_sec       INTEGER,                 -- position in the masterclass when posted
  pinned_at    INTEGER,
  deleted_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL         -- bumped on pin / delete so polling clients pick up the change
);
CREATE INDEX idx_wchat_session ON webinar_chat(session_id, id);
CREATE INDEX idx_wchat_updated ON webinar_chat(session_id, updated_at);
CREATE INDEX idx_wchat_reg ON webinar_chat(reg_id, created_at);

-- Presence pings: one row per person per showing, refreshed every ~15 s while the page is open.
CREATE TABLE webinar_presence (
  session_id TEXT NOT NULL,
  who        TEXT NOT NULL,             -- registration id, or host:<console id>
  kind       TEXT NOT NULL,             -- viewer | replay | host
  first_at   INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, who)
);
CREATE INDEX idx_wpres_seen ON webinar_presence(session_id, seen_at);

-- Most people truly in a showing at once (from presence), for Funnel HQ.
CREATE TABLE webinar_live_peaks (
  session_id   TEXT PRIMARY KEY,
  peak_viewers INTEGER NOT NULL DEFAULT 0,
  peak_at      INTEGER,
  updated_at   INTEGER NOT NULL
);

-- One-off announcements to a showing from the host console (banner in the room, optional button).
CREATE TABLE webinar_announcements (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  body       TEXT NOT NULL,
  link_url   TEXT,
  link_label TEXT,
  host_name  TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX idx_wann_session ON webinar_announcements(session_id, expires_at);

-- Scheduled announcements: "at minute 46 of every showing, show X with link Y for 10 minutes".
CREATE TABLE webinar_auto_announcements (
  id         TEXT PRIMARY KEY,
  at_min     INTEGER NOT NULL,
  minutes    INTEGER NOT NULL,
  body       TEXT NOT NULL,
  link_url   TEXT,
  link_label TEXT,
  replay     INTEGER NOT NULL DEFAULT 1, -- also show in the replay at that minute of the video
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- "Get a call from Josh's team" ($1M+ viewers), at most one per registration per showing.
CREATE TABLE webinar_hand_raises (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  reg_id       TEXT NOT NULL,
  lead_id      TEXT NOT NULL,
  at_sec       INTEGER,
  replay       INTEGER NOT NULL DEFAULT 0,
  host_present INTEGER NOT NULL DEFAULT 0,
  handled_at   INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wraise_once ON webinar_hand_raises(session_id, reg_id);
CREATE INDEX idx_wraise_created ON webinar_hand_raises(created_at);

-- The team's private reply to a question typed in the room (shown to that viewer only).
ALTER TABLE webinar_interactions ADD COLUMN team_answer TEXT;
ALTER TABLE webinar_interactions ADD COLUMN team_answer_by TEXT;
ALTER TABLE webinar_interactions ADD COLUMN team_answered_at INTEGER;
