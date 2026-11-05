-- Radar v2, builder C (src/radar/formats.ts, adapt.ts, pipeline-flow.ts): the format of every top performer, the viral
-- formats they cluster into, how each format's script changes for G&L, and the analysis pipeline runs. Additive only.

-- One extracted format per item (video transcript or text body), validated and clamped in code.
CREATE TABLE IF NOT EXISTS radar_item_formats (
  item_id       TEXT PRIMARY KEY,           -- radar_items.id
  format_name   TEXT NOT NULL,              -- short and reusable: "Deal teardown with live scorecard"
  name_tokens   TEXT NOT NULL,              -- the normalised name tokens, space separated (for clustering)
  hook_type     TEXT NOT NULL,              -- result_first | contrarian | curiosity_gap | number | question | story_cold_open | call_out | proof_screenshot | other
  devices_json  TEXT NOT NULL DEFAULT '[]', -- ["scorecard","on_screen_numbers"]
  length_bucket TEXT NOT NULL,              -- micro | short | mid | long | xl | post | thread | article
  audience_json TEXT NOT NULL DEFAULT '[]', -- ["owner_1m","investor"]
  signature     TEXT NOT NULL,              -- name tokens | hook family | main devices | length bucket
  data_json     TEXT NOT NULL,              -- the whole extraction (hook, beats, devices, retention risks, CTA, emotion, why it went viral)
  brain         TEXT,                       -- claude | workers-ai
  format_id     TEXT,                       -- radar_formats.id once clustered
  extracted_at  TEXT NOT NULL,
  error         TEXT                        -- set when the extraction failed (the item is retried on a later run)
);
CREATE INDEX IF NOT EXISTS idx_radar_item_formats_format ON radar_item_formats(format_id);

-- The viral formats: deterministic clusters of item formats, named by one model call each.
CREATE TABLE IF NOT EXISTS radar_formats (
  id            TEXT PRIMARY KEY,           -- fmt_<hash of the seed signature>: stable across runs
  name          TEXT NOT NULL,
  definition    TEXT,                       -- two lines
  named_by      TEXT,                       -- claude | workers-ai | rule
  members_hash  TEXT,                       -- hash of the member ids at naming time (re-named only when it changes)
  signature     TEXT NOT NULL,
  hook_type     TEXT NOT NULL,
  devices_json  TEXT NOT NULL DEFAULT '[]',
  length_bucket TEXT,
  member_ids    TEXT NOT NULL DEFAULT '[]',
  stats_json    TEXT NOT NULL,              -- count, platforms, median score, sparkline, in-niche share, audience mix, first/last seen, trend
  rank          REAL NOT NULL DEFAULT 0,    -- median outlier x breadth x recency
  white_space   INTEGER NOT NULL DEFAULT 0, -- wins in adjacent niches, absent or weak in ours
  white_space_why TEXT,
  prev_count    INTEGER,                    -- the count at the previous run (trend)
  run_id        TEXT,                       -- the pipeline run that last clustered it
  active        INTEGER NOT NULL DEFAULT 1, -- 0 once a later clustering no longer finds it
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_formats_rank ON radar_formats(active, rank);

-- "How the script changes for our niche": per format (or per item on demand).
CREATE TABLE IF NOT EXISTS radar_adaptations (
  id            TEXT PRIMARY KEY,
  format_id     TEXT,                       -- radar_formats.id (null for an item adaptation)
  item_id       TEXT,                       -- radar_items.id (null for a format adaptation)
  members_hash  TEXT,                       -- the format's members when adapted (idempotency)
  run_id        TEXT,
  data_json     TEXT NOT NULL,              -- original skeleton, G&L beats side by side, hooks, legends per beat
  script_id     TEXT,                       -- studio_scripts.id
  flags_json    TEXT NOT NULL DEFAULT '[]', -- copy-rule flags left after the rewrite loop
  judge_json    TEXT,                       -- the blind judge: scores, notes, rounds
  judge_score   REAL,                       -- the lowest of the five scores (1 to 10)
  rounds        INTEGER NOT NULL DEFAULT 0, -- judge rewrites used (max 2)
  brain         TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft | judged | stored | failed
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_adaptations_format ON radar_adaptations(format_id, created_at);
CREATE INDEX IF NOT EXISTS idx_radar_adaptations_item ON radar_adaptations(item_id, created_at);

-- The analysis pipeline (sweep → transcribe → extract → cluster → adapt → judge → rewrite → store), one row per run.
-- The Workflow gl-radar-pipeline (or the inline runner) records each node's output here, so a step re-run is a no-op.
CREATE TABLE IF NOT EXISTS radar_pipeline_runs (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL,              -- button | cron
  status        TEXT NOT NULL,              -- running | done | failed
  node          TEXT,                       -- the node working now
  steps_json    TEXT NOT NULL DEFAULT '{}', -- {"<step name>": {"at": ..., "out": ...}}
  flow_id       TEXT,                       -- the Workflow instance id when it runs as a Workflow
  lease_until   TEXT,                       -- the inline runner's lease
  error         TEXT,
  started_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_pipeline_runs_started ON radar_pipeline_runs(started_at);
