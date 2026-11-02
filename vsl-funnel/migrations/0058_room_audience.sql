-- Rooms: the audience experience (area C: src/rooms/audience*.ts, captions.ts, public/assets/room-audience.js).
-- Live captions (machine transcription of the host's microphone, with a visible notice in the room), their
-- machine translations, the per-room switches, purchase announcements (only with the buyer's opt-in, first
-- name and city only), the abandoned-checkout nudge (once), and the reaction pulse per minute.

-- One row per caption line. t_ms = milliseconds since the room went live (the start of the audio piece), so a
-- transcript reads in order. lang = the language as spoken (ISO 639-1, 'en' by default). Builder D's transcript
-- reads this table: keep the four columns as they are.
CREATE TABLE IF NOT EXISTS room_captions (
  room_id TEXT NOT NULL,
  t_ms    INTEGER NOT NULL,
  text    TEXT NOT NULL,
  lang    TEXT NOT NULL DEFAULT 'en'
);
CREATE INDEX IF NOT EXISTS idx_room_captions ON room_captions (room_id, t_ms);

-- Machine translations, cached per caption line and language (translated once, whoever asks).
CREATE TABLE IF NOT EXISTS room_caption_tr (
  room_id TEXT NOT NULL,
  t_ms    INTEGER NOT NULL,
  lang    TEXT NOT NULL,
  text    TEXT NOT NULL,
  PRIMARY KEY (room_id, t_ms, lang)
);

-- The host's switches for one room (no row = the settings' defaults).
CREATE TABLE IF NOT EXISTS room_audience (
  room_id    TEXT PRIMARY KEY,
  proof_on   INTEGER,           -- purchase announcements (NULL = ROOM_PROOF)
  updated_at INTEGER NOT NULL
);

-- The opt-in from the room's payment and application cards. Nothing is announced without a row here.
CREATE TABLE IF NOT EXISTS room_proof_consent (
  room_id      TEXT NOT NULL,
  who          TEXT NOT NULL,
  lead_id      TEXT,
  first_name   TEXT,
  city         TEXT,
  show_city    INTEGER NOT NULL DEFAULT 1,
  consent_at   INTEGER NOT NULL,
  withdrawn_at INTEGER,
  PRIMARY KEY (room_id, who)
);
CREATE INDEX IF NOT EXISTS idx_room_proof_consent_lead ON room_proof_consent (lead_id, consent_at);

-- Each announcement once per buyer and kind (the real event it came from is the pass or the application).
CREATE TABLE IF NOT EXISTS room_proof_events (
  room_id TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  kind    TEXT NOT NULL,        -- deposit | sprint | application
  text    TEXT NOT NULL,
  ref     TEXT,                 -- the pass id (purchases)
  at      INTEGER NOT NULL,
  PRIMARY KEY (room_id, lead_id, kind)
);

-- Checkouts started in the room, and the one nudge each may get.
CREATE TABLE IF NOT EXISTS room_checkouts (
  room_id    TEXT NOT NULL,
  who        TEXT NOT NULL,
  kind       TEXT NOT NULL,     -- deposit | sprint
  lead_id    TEXT,
  started_at INTEGER NOT NULL,
  nudged_at  INTEGER,
  PRIMARY KEY (room_id, who, kind)
);

-- Reactions per minute (the host's pulse, kept for the report).
CREATE TABLE IF NOT EXISTS room_reaction_pulse (
  room_id TEXT NOT NULL,
  minute  INTEGER NOT NULL,     -- epoch minute
  n       INTEGER NOT NULL,
  kinds   TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (room_id, minute)
);
