-- G&L Studio (src/studio): screen recordings with the face cam, their Drive copies and the automatic edit.
-- Status, in order: recording → uploaded → in_drive → queued → transcribing → planning → rendering → delivering → done;
-- also failed (error says why; failed_stage is where retry starts) and skipped (a Drive file we chose not to edit).
CREATE TABLE IF NOT EXISTS studio_videos (
  id TEXT PRIMARY KEY,
  title TEXT,
  source TEXT NOT NULL DEFAULT 'studio',          -- 'studio' (recorded here) | 'drive' (found in the Drive folder)
  layout TEXT,                                     -- orbit | split | spotlight | stage | vertical | cinema
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  duration_s REAL,
  width INTEGER,
  height INTEGER,
  mime TEXT,
  raw_key TEXT,                                    -- R2 STUDIO: raw/<id>.<ext>
  raw_size INTEGER,
  upload_id TEXT,                                  -- R2 multipart upload while recording (or importing from Drive)
  parts_json TEXT,                                 -- {"p<n>": {"e": etag, "s": bytes}}
  markers_json TEXT,                               -- [{t, kind: chapter|retake|highlight, label?}]
  script_id TEXT,
  drive_raw_id TEXT,
  drive_raw_link TEXT,
  status TEXT NOT NULL DEFAULT 'recording',
  progress REAL NOT NULL DEFAULT 0,                -- 0..1 within the current stage
  stage_detail TEXT,
  transcript_key TEXT,
  plan_json TEXT,
  plan_brain TEXT,                                 -- 'claude' | 'workers-ai' | 'rules'
  edited_key TEXT,
  edited_size INTEGER,
  edited_width INTEGER,
  edited_height INTEGER,
  drive_edited_id TEXT,
  drive_edited_link TEXT,
  shorts_json TEXT,                                -- [{n, key, size, title, in, out, drive_id?, drive_link?}]
  error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  -- Pipeline bookkeeping (not part of the browser contract):
  failed_stage TEXT,                               -- the status a retry starts again from
  notes TEXT,                                      -- the owner's notes for a re-edit
  probe_json TEXT,                                 -- the editor's ffprobe of the raw (fps, codecs, audio)
  analysis_key TEXT,                               -- R2: silences and audio chunk list
  thumb_key TEXT,
  lease_until INTEGER,                             -- ms; one worker advances a video at a time
  next_at INTEGER,                                 -- ms; when the cron may advance it next
  flow_id TEXT                                     -- the running Workflow instance, when there is one
);
CREATE INDEX IF NOT EXISTS idx_studio_videos_status ON studio_videos (status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_studio_videos_created ON studio_videos (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_videos_drive_raw ON studio_videos (drive_raw_id) WHERE drive_raw_id IS NOT NULL;

-- The visual timeline: one plain sentence per thing that happened.
CREATE TABLE IF NOT EXISTS studio_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  at TEXT NOT NULL,
  stage TEXT NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_events_video ON studio_events (video_id, id);

-- Small state: last and next Drive scan, resumable Drive upload sessions, import progress, Drive files we created.
CREATE TABLE IF NOT EXISTS studio_state (
  key TEXT PRIMARY KEY,
  value TEXT
);
