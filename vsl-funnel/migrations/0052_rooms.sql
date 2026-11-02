-- Rooms: our own video rooms on Cloudflare Realtime (SFU for media, TURN for networks that block UDP, a
-- Durable Object per room for signalling and state). Two modes on one engine: 'webinar' (host and co-hosts on
-- stage, the audience watches) and 'meeting' (everyone on camera, up to about 12).
-- A room belongs to a live webinar ('live', ref_id = live_webinars.id), a challenge day ('challenge',
-- ref_id = 'challenge:<cohort>:<day>') or a post-purchase meeting with a lead or client ('lead', ref_id = lead id).
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  mode          TEXT NOT NULL,                 -- webinar | meeting
  title         TEXT NOT NULL,
  ref_type      TEXT NOT NULL,                 -- live | challenge | lead | none
  ref_id        TEXT,
  lead_id       TEXT,                          -- meetings: the client or lead invited
  starts_at     INTEGER,
  duration_min  INTEGER NOT NULL DEFAULT 60,
  status        TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | live | ended | cancelled
  went_live_at  INTEGER,
  ended_at      INTEGER,
  peak          INTEGER NOT NULL DEFAULT 0,    -- most people connected at once (real count from the room's sockets)
  replay_url    TEXT,                          -- the uploaded recording, when there is one
  created_by    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_rooms_ref ON rooms(ref_type, ref_id) WHERE ref_type IN ('live', 'challenge');
CREATE INDEX idx_rooms_start ON rooms(starts_at);
CREATE INDEX idx_rooms_lead ON rooms(lead_id);

-- Attendance per person per room, fed by the room itself (join, every minute while connected, leave).
CREATE TABLE room_attendance (
  room_id     TEXT NOT NULL,
  who         TEXT NOT NULL,                   -- the participant id (reg id, lead id, host id or guest id)
  lead_id     TEXT,
  reg_id      TEXT,
  name        TEXT,
  role        TEXT NOT NULL,                   -- host | cohost | guest | attendee
  first_at    INTEGER NOT NULL,
  last_at     INTEGER NOT NULL,
  minutes     INTEGER NOT NULL DEFAULT 0,      -- distinct minutes connected
  joins       INTEGER NOT NULL DEFAULT 1,
  on_stage_at INTEGER,                         -- first time this person was brought on stage (webinars)
  PRIMARY KEY (room_id, who)
);
CREATE INDEX idx_room_att_lead ON room_attendance(lead_id);

-- Host-side recordings (composited stage + mixed audio), uploaded to R2 in parts when the RECORDINGS bucket is bound.
CREATE TABLE room_recordings (
  id          TEXT PRIMARY KEY,
  room_id     TEXT NOT NULL,
  r2_key      TEXT NOT NULL,
  upload_id   TEXT,
  mime        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'recording', -- recording | ready | failed
  parts       INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER
);
CREATE INDEX idx_room_rec_room ON room_recordings(room_id, started_at);

-- Where each live event and challenge day runs: 'zoom' (the link, as today) or 'room' (ours).
ALTER TABLE live_webinars ADD COLUMN platform TEXT NOT NULL DEFAULT 'zoom';
ALTER TABLE challenge_days ADD COLUMN platform TEXT NOT NULL DEFAULT 'zoom';
