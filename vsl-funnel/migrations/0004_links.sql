-- Tracked links (e.g. one per YouTube video + placement). /l/<code> redirects to
-- the funnel with UTMs; utm_content = code, so every session, lead, booking and
-- sale traces back to the exact video and placement that sent it.
CREATE TABLE tracked_links (
  code         TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- youtube | custom
  video_id     TEXT,                   -- YouTube video id
  video_title  TEXT,
  thumbnail    TEXT,
  placement    TEXT,                   -- description | pinned_comment | end_screen | … (utm_term)
  dest_path    TEXT NOT NULL DEFAULT '/',
  utm_source   TEXT NOT NULL,
  utm_medium   TEXT NOT NULL,
  utm_campaign TEXT NOT NULL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  last_click_at INTEGER,
  archived     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_links_video ON tracked_links(video_id);
CREATE INDEX idx_sessions_content ON sessions(utm_content);
CREATE INDEX idx_leads_content ON leads(utm_content);
CREATE INDEX idx_leads_ft_content ON leads(ft_content);
