-- Reactivation campaign: when a lead was reactivated and from which group (own table: leads is at D1's column limit).
CREATE TABLE IF NOT EXISTS lead_reactivation (
  lead_id        TEXT PRIMARY KEY,
  reactivated_at INTEGER NOT NULL,
  segment        TEXT
);

-- Email editor: an edited version of a built-in email (merge tags like {first_name}); deleting the row restores the default.
CREATE TABLE IF NOT EXISTS email_overrides (
  template   TEXT PRIMARY KEY,
  subject    TEXT NOT NULL,
  preheader  TEXT,
  body       TEXT NOT NULL,   -- paragraphs separated by a blank line
  cta_label  TEXT,
  cta_href   TEXT,
  ps         TEXT,
  updated_at INTEGER NOT NULL
);

-- Content analytics: one row per video/post per day it was checked (so growth can be charted).
CREATE TABLE IF NOT EXISTS content_items (
  id           TEXT PRIMARY KEY,          -- yt:<videoId> | ig:<mediaId>
  platform     TEXT NOT NULL,             -- youtube | instagram
  title        TEXT,
  url          TEXT,
  thumbnail    TEXT,
  published_at INTEGER,
  duration_s   INTEGER,
  kind         TEXT,                      -- video | short | reel | image | carousel
  views        INTEGER,
  likes        INTEGER,
  comments     INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_items_platform ON content_items (platform, published_at);
CREATE TABLE IF NOT EXISTS content_snapshots (
  item_id  TEXT NOT NULL,
  day      TEXT NOT NULL,                 -- YYYY-MM-DD
  views    INTEGER,
  likes    INTEGER,
  comments INTEGER,
  PRIMARY KEY (item_id, day)
);
