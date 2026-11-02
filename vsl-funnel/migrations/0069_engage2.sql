-- Rooms, engagement round 2 (src/rooms/engage2.ts, engage2-db.ts, engage2-do.ts): a 0-100 engagement score per
-- attendee from real signals in the room, the same score on the lead (a new table: the leads table is at its
-- column limit), the per-room live-only bonus with its real withdrawal, and the bonus granted to buyers who
-- bought while it was live. Additive only.

CREATE TABLE IF NOT EXISTS room_engage_scores (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,
  lead_id TEXT,
  name TEXT,
  score INTEGER NOT NULL DEFAULT 0,      -- 0..100
  signals TEXT NOT NULL DEFAULT '{}',    -- JSON: the inputs the score came from
  why TEXT NOT NULL DEFAULT '[]',        -- JSON: plain reasons, strongest first
  buying TEXT NOT NULL DEFAULT '[]',     -- JSON: buying signals (checkout, offer_twice, price)
  bought INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, who)
);
CREATE INDEX IF NOT EXISTS idx_room_engage_scores_lead ON room_engage_scores (lead_id);
CREATE INDEX IF NOT EXISTS idx_room_engage_scores_rank ON room_engage_scores (room_id, score);

CREATE TABLE IF NOT EXISTS lead_engage_scores (
  lead_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,                 -- the room the latest score is from
  score INTEGER NOT NULL DEFAULT 0,
  best_score INTEGER NOT NULL DEFAULT 0, -- the highest across rooms
  why TEXT NOT NULL DEFAULT '[]',
  buying TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_live_bonus (
  room_id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  asset TEXT,                            -- an unlock asset id (engage.ts ASSETS), or NULL
  until TEXT NOT NULL DEFAULT 'offer',   -- offer = withdrawn when the room's real offer window closes; end = when the session ends
  on_at INTEGER NOT NULL,                -- live from here
  withdrawn_at INTEGER,                  -- set once, by the server, never cleared
  withdrawn_reason TEXT,                 -- offer_closed | ended | host
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS room_bonus_grants (
  room_id TEXT NOT NULL,
  pass_id TEXT NOT NULL,                 -- the purchase (webinar_passes.id)
  lead_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- offer (the Sprint) | deposit
  text TEXT NOT NULL,                    -- the bonus as it stood when they bought
  asset TEXT,
  paid_at INTEGER NOT NULL,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, pass_id)
);
CREATE INDEX IF NOT EXISTS idx_room_bonus_grants_lead ON room_bonus_grants (lead_id);
