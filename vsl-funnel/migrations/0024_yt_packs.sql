-- Per-video packs: the full script, slides and packaging for one video in a sprint.
CREATE TABLE yt_packs (
  id         TEXT PRIMARY KEY,          -- <sprint_id>:<topic_id>
  sprint_id  TEXT NOT NULL,
  topic_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  source     TEXT NOT NULL,             -- ai | rules | written
  data       TEXT NOT NULL,             -- the pack (JSON)
  miro_url   TEXT,                      -- presentation board, once built
  doc_url    TEXT                       -- Google Doc, once created
);
CREATE INDEX idx_yt_packs_sprint ON yt_packs(sprint_id);
