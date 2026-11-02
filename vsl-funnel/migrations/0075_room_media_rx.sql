-- Rooms, host diagnostics (src/rooms/media.ts, room-media.js). One row per person per room: how long they could
-- not see or hear the host (from their own browser's receive checks: the host's video frames and audio bytes
-- arriving, pull errors, autoplay), how many separate times, and the last reason. For the host's own row,
-- how many times the camera self-check republished their video. Shown in Funnel HQ → Rooms → a room.
-- Diagnostics only: nothing here is shown to attendees or used for permissions. Additive (a new table).

CREATE TABLE IF NOT EXISTS room_media_rx (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,                       -- the room member id
  name TEXT,
  role TEXT,
  lead_id TEXT,
  no_video_ms INTEGER NOT NULL DEFAULT 0,  -- time the host's video was expected but not arriving
  no_audio_ms INTEGER NOT NULL DEFAULT 0,  -- time the host's sound was expected but not playing
  video_episodes INTEGER NOT NULL DEFAULT 0,
  audio_episodes INTEGER NOT NULL DEFAULT 0,
  video_reason TEXT,                       -- not_found | retrying | pending | stalled | audio_only | no_connection | moq_wait
  audio_reason TEXT,                       -- the same, plus autoplay
  republishes INTEGER NOT NULL DEFAULT 0,  -- host: automatic republishes by the camera self-check
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, who)
);
