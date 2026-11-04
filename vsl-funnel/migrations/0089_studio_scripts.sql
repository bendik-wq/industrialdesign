-- G&L Studio, builder C: one-click face-cam scripts (src/studio/scripts.ts, Funnel HQ → Studio → Scripts).
-- Each row is one generated shooting script: the inputs, which brain wrote it, the script itself as JSON
-- (hooks, beats with a layout per beat, titles, thumbnail text, description, CTA) and any copy-rule flags left
-- after the one automatic rewrite. Additive only.
CREATE TABLE IF NOT EXISTS studio_scripts (
  id          TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL,                -- ISO time
  updated_at  TEXT,
  topic       TEXT NOT NULL,                -- what the video is about, in the owner's words or from a YouTube idea
  source      TEXT NOT NULL DEFAULT 'topic',-- topic | idea (a YouTube sprint topic, with its pack when written)
  source_ref  TEXT,                         -- sprint_id:topic_id for an idea
  format      TEXT NOT NULL,                -- long | short | vsl | webinar | email
  icp         TEXT NOT NULL,                -- trapped | ceiling | deployer | prisoner
  framework   TEXT NOT NULL,                -- the framework used (auto resolves to one before writing)
  brain       TEXT NOT NULL,                -- claude | workers-ai
  title       TEXT,                         -- the first title option, for the list
  est_seconds INTEGER,                      -- from the spoken word count
  data        TEXT NOT NULL,                -- the script JSON
  flags       TEXT,                         -- JSON array of copy-rule flags still present after the rewrite
  attempts    INTEGER NOT NULL DEFAULT 1,   -- 2 when the first draft was rewritten for the copy rules
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_studio_scripts_created ON studio_scripts(deleted_at, created_at);
