-- The watch experience: saved key points, real reactions per chapter and the acquisition readiness score.
-- Buy-in answers (kind = 'buyin') live in webinar_interactions; handled = 1 there hides one from the wall.

-- Key points a viewer saved to their notes (one row per takeaway per registration).
CREATE TABLE webinar_notes (
  id          TEXT PRIMARY KEY,
  reg_id      TEXT NOT NULL,
  lead_id     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  takeaway_id TEXT NOT NULL,
  text        TEXT NOT NULL,             -- the line as they saw it
  at_sec      INTEGER NOT NULL,          -- where it sits in the masterclass
  replay      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wn_reg ON webinar_notes(reg_id, takeaway_id);
CREATE INDEX idx_wn_lead ON webinar_notes(lead_id);
CREATE INDEX idx_wn_created ON webinar_notes(created_at);

-- "New to me" / "I'd do this" / "Explain more": one of each per chapter per registration.
CREATE TABLE webinar_reactions (
  id         TEXT PRIMARY KEY,
  reg_id     TEXT NOT NULL,
  lead_id    TEXT NOT NULL,
  session_id TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- new | do | explain
  chapter_at INTEGER NOT NULL,           -- minute the chapter starts
  minute     INTEGER NOT NULL,           -- minute of the masterclass when pressed
  replay     INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_wre_reg ON webinar_reactions(reg_id, kind, chapter_at);
CREATE INDEX idx_wre_chapter ON webinar_reactions(chapter_at, kind);
CREATE INDEX idx_wre_created ON webinar_reactions(created_at);

-- Acquisition readiness score (0-100), kept once someone answers something in the room.
CREATE TABLE webinar_scores (
  reg_id     TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL,
  score      INTEGER NOT NULL,
  gap        TEXT,
  factors    TEXT,                       -- JSON [[factor, points], ...]
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_ws_lead ON webinar_scores(lead_id);
CREATE INDEX idx_ws_updated ON webinar_scores(updated_at);

-- Buy-in answers and the wall query.
CREATE INDEX IF NOT EXISTS idx_wi_buyin ON webinar_interactions(kind, key, created_at);
