-- Rooms, call quality and reliability (area A "media", src/rooms/media.ts). One row per person per room: the
-- device and browser they joined on, how their media arrived (SFU or MoQ, direct or through a TURN relay), how
-- many times they reconnected, and their connection quality over the session (each browser reports its own
-- round trip, loss, jitter and bitrates every few seconds; the room writes the summary once a minute).
-- Diagnostics only: nothing here is shown to attendees or used for permissions.

CREATE TABLE IF NOT EXISTS room_media (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,                 -- the room member id (host:…, reg:…, lead:…, guest:…)
  name TEXT,
  role TEXT,
  lead_id TEXT,
  os TEXT,                           -- windows | mac | ios | android | chromeos | linux | other
  browser TEXT,                      -- chrome | edge | safari | firefox | samsung | other
  mobile INTEGER NOT NULL DEFAULT 0,
  path TEXT,                         -- sfu | moq | none (how the stage reached them at the last report)
  relay INTEGER NOT NULL DEFAULT 0,  -- 1 = through a TURN relay
  proto TEXT,                        -- udp | tcp | tls
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  reconnects INTEGER NOT NULL DEFAULT 0,
  worst TEXT NOT NULL DEFAULT 'good', -- good | fair | poor | bad
  n_good INTEGER NOT NULL DEFAULT 0,
  n_fair INTEGER NOT NULL DEFAULT 0,
  n_poor INTEGER NOT NULL DEFAULT 0,
  n_bad INTEGER NOT NULL DEFAULT 0,
  rtt_avg INTEGER,                   -- ms
  loss_avg REAL,                     -- 0..1
  jitter_avg INTEGER,                -- ms
  kbps_in_avg INTEGER,
  kbps_out_avg INTEGER,
  audio_only_samples INTEGER NOT NULL DEFAULT 0,
  fx TEXT,                           -- background effect in use: off | blur | brand
  noise TEXT,                        -- noise reduction: std | strong | off
  last_json TEXT,
  PRIMARY KEY (room_id, who)
);
CREATE INDEX IF NOT EXISTS idx_room_media_lead ON room_media (lead_id);
