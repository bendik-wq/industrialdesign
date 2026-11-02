-- Rooms intel (src/rooms/intel.ts, intel-db.ts): transcripts, the AI debrief, the engagement timeline, the replay page,
-- simulive showings and highlight clips. Everything here is written by the server from real events.

-- Live captions (written by the room's live captions, area C). Shared schema: both migrations create it the same way.
CREATE TABLE IF NOT EXISTS room_captions (room_id TEXT, t_ms INTEGER, text TEXT, lang TEXT);
CREATE INDEX IF NOT EXISTS idx_room_captions_room ON room_captions (room_id, t_ms);

-- What happened in the room, with its real time: active speaker changes (reported by the host's browser), chat
-- messages and questions as they were sent, chapter marks, polls, the offer opening and closing.
CREATE TABLE IF NOT EXISTS room_intel_events (
  room_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- speaker | chat | question | chapter | poll | offer | react
  who TEXT,
  name TEXT,
  text TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_room_intel_events ON room_intel_events (room_id, at);
CREATE INDEX IF NOT EXISTS idx_room_intel_kind ON room_intel_events (room_id, kind, at);

-- Transcription of a recording with Workers AI Whisper, one chunk per step (cron or Funnel HQ), resumable.
CREATE TABLE IF NOT EXISTS room_transcribe_jobs (
  rec_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed | no_ai | unsupported
  container TEXT,                          -- webm | mp4
  header_end INTEGER,                      -- bytes of the init segment prepended to each chunk
  timescale INTEGER,                       -- mp4: the track timescale for tfdt
  next_offset INTEGER NOT NULL DEFAULT 0,  -- where the next chunk starts (always a cluster / fragment start)
  size INTEGER,
  chunks INTEGER NOT NULL DEFAULT 0,
  gaps INTEGER NOT NULL DEFAULT 0,         -- chunks Whisper could not read after retries (skipped, not invented)
  tries INTEGER NOT NULL DEFAULT 0,        -- failures on the current chunk
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  done_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_room_transcribe_status ON room_transcribe_jobs (status, updated_at);

-- The authoritative transcript: Whisper segments, times in ms from the start of the recording.
CREATE TABLE IF NOT EXISTS room_transcript (
  rec_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,                  -- the chunk's byte offset (a re-run replaces its own rows)
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  speaker TEXT,
  text TEXT NOT NULL,
  PRIMARY KEY (rec_id, start_ms, chunk)
);
CREATE INDEX IF NOT EXISTS idx_room_transcript_room ON room_transcript (room_id, start_ms);

-- One debrief per room (rebuilt on request): JSON with every number taken from the data.
CREATE TABLE IF NOT EXISTS room_debriefs (
  room_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                    -- claude | rules
  data TEXT NOT NULL,
  doc_id TEXT,                             -- the Command document it was posted as
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Highlight clips: definitions (the export runs in the owner's browser from the recording).
CREATE TABLE IF NOT EXISTS room_clips (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  rec_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | approved | posted
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_clips_room ON room_clips (room_id, start_ms);

-- Replay watching per person (the replay page pings while it plays): seconds watched and the furthest point.
CREATE TABLE IF NOT EXISTS room_replay_views (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,
  lead_id TEXT,
  reg_id TEXT,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  seconds INTEGER NOT NULL DEFAULT 0,
  max_pos INTEGER NOT NULL DEFAULT 0,
  minutes TEXT NOT NULL DEFAULT '',        -- one character per minute of the recording: 1 = watched
  PRIMARY KEY (room_id, who)
);
CREATE INDEX IF NOT EXISTS idx_room_replay_views_lead ON room_replay_views (lead_id);
