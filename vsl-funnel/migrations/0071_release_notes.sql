-- Overnight loop round 2, "command": what was deployed and when, for Command → Activity and the morning brief.
-- Additive only. `npm run deploy` (scripts/deploy.mjs) builds the notes (build id, deploy time, the last commit
-- subjects) into the Worker; the Worker records them here once, the first time Command's cron runs on that build
-- (src/ops/releases.ts). An empty table is fine: Command then shows nothing about deploys.
CREATE TABLE IF NOT EXISTS release_notes (
  build       TEXT PRIMARY KEY,           -- the build id (__BUILD_ID__, also in /health)
  deployed_at INTEGER NOT NULL,           -- when npm run deploy ran (ms)
  notes       TEXT NOT NULL DEFAULT '[]', -- JSON array of commit subjects, newest first (secrets masked, trimmed)
  version_id  TEXT,                       -- Cloudflare Worker version id, when the binding is present
  recorded_at INTEGER NOT NULL            -- when the Worker first saw this build running
);
CREATE INDEX IF NOT EXISTS idx_release_notes_deployed ON release_notes(deployed_at);
