-- YouTube topic sprints (2 weeks, 5–10 topics) from the idea generator.
CREATE TABLE yt_sprints (
  id         TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  source     TEXT NOT NULL,          -- ai | rules
  focus      TEXT,                   -- optional angle the sprint was asked to explore
  data       TEXT NOT NULL,          -- the sprint (JSON)
  inputs     TEXT                    -- what the generator saw (JSON summary)
);
CREATE INDEX idx_yt_sprints_created ON yt_sprints(created_at);
