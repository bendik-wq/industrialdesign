-- Rooms: engagement (src/rooms/engage.ts, engage-db.ts). Pushes from the host (the application, a payment card, a
-- resource), what each person did with them, Deal momentum points (one row per real action, de-duplicated by
-- key, capped per action), unlocks, knowledge checks, the Deal Plan worksheet, the retention curve, and the
-- per-room engagement settings. Everything here is written by the server from real events.

CREATE TABLE IF NOT EXISTS room_pushes (
  room_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- application | sprint | deposit | vip | resource
  ref TEXT,                        -- the resource id for kind = resource
  targets TEXT,                    -- NULL = everyone in the room; else a JSON array of member ids
  target_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY (room_id, id)
);

CREATE TABLE IF NOT EXISTS room_push_events (
  room_id TEXT NOT NULL,
  push_id INTEGER NOT NULL,
  who TEXT NOT NULL,
  event TEXT NOT NULL,             -- shown | opened | started | submitted | paid | dismissed
  lead_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, push_id, who, event)
);
CREATE INDEX IF NOT EXISTS idx_room_push_events_lead ON room_push_events (lead_id);

CREATE TABLE IF NOT EXISTS room_points (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,
  action TEXT NOT NULL,            -- on_time | present_10 | chapter | poll | question | quiz | quiz_correct | plan_step | application | stayed_end
  key TEXT NOT NULL,
  points INTEGER NOT NULL,
  lead_id TEXT,
  reg_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, who, action, key)
);
CREATE INDEX IF NOT EXISTS idx_room_points_lead ON room_points (lead_id);

CREATE TABLE IF NOT EXISTS room_unlocks (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,
  asset TEXT NOT NULL,
  source TEXT NOT NULL,            -- points | end | push
  lead_id TEXT,
  at INTEGER NOT NULL,
  opened_at INTEGER,
  PRIMARY KEY (room_id, who, asset)
);

CREATE TABLE IF NOT EXISTS room_quiz_answers (
  room_id TEXT NOT NULL,
  quiz_id INTEGER NOT NULL,
  who TEXT NOT NULL,
  question TEXT,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  lead_id TEXT,
  at INTEGER NOT NULL,
  PRIMARY KEY (room_id, quiz_id, who)
);

CREATE TABLE IF NOT EXISTS room_plans (
  room_id TEXT NOT NULL,
  who TEXT NOT NULL,
  lead_id TEXT,
  reg_id TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  steps TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, who)
);
CREATE INDEX IF NOT EXISTS idx_room_plans_lead ON room_plans (lead_id);

-- Attendees connected per minute since Go live (the retention curve).
CREATE TABLE IF NOT EXISTS room_minutes (
  room_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (room_id, minute)
);

-- Per-room engagement settings (agenda, leaderboard default) and when the summary emails went out.
ALTER TABLE rooms ADD COLUMN engage TEXT;
ALTER TABLE rooms ADD COLUMN summary_at INTEGER;
-- The person's engagement across rooms is read from room_points by lead_id (leads is at D1's 100-column limit).
