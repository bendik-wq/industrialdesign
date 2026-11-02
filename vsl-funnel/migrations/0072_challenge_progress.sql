-- First Deal Challenge, round 2: each day's automatic push schedule for our room (NULL = the day's default,
-- see src/challenge/progress.ts) and the challenge's own switches (the homework reminder, off unless turned on).
ALTER TABLE challenge_days ADD COLUMN auto_push TEXT;

CREATE TABLE IF NOT EXISTS challenge_prefs (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
