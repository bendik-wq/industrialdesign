-- Cloudflare round, builder D: the funnel watchdog's runs (Browser Rendering) and Stream copies of room recordings.
-- Additive only.

-- One row per watchdog run (hourly when setting WATCHDOG is on). results: JSON [{name, path, status, ms, error}].
CREATE TABLE IF NOT EXISTS watchdog_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL,
  ms          INTEGER NOT NULL,
  ok          INTEGER NOT NULL,              -- 1 when every checked page passed
  checked     INTEGER NOT NULL,
  failed      INTEGER NOT NULL,
  skipped     INTEGER NOT NULL DEFAULT 0,
  trigger     TEXT NOT NULL DEFAULT 'cron',  -- cron | manual
  results     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchdog_runs_started ON watchdog_runs(started_at);

-- A room recording (room_recordings.id) copied to Cloudflare Stream. The replay plays through Stream once ready.
CREATE TABLE IF NOT EXISTS stream_videos (
  rec_id      TEXT PRIMARY KEY,
  uid         TEXT,
  state       TEXT NOT NULL,                 -- queued | inprogress | ready | error
  ready       INTEGER NOT NULL DEFAULT 0,
  hls         TEXT,
  preview     TEXT,
  thumbnail   TEXT,
  duration    REAL,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_stream_videos_uid ON stream_videos(uid);
