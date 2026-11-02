-- The host's panic button (src/rooms/panic.ts): a live room that is failing moves everyone to a fresh room, or
-- shows everyone the event's Zoom link. Additive only.
-- rooms.moved_to / moved_from link a room to the one that replaced it (the chain); moved_at is when it moved.
-- rooms.panic holds the room's panic settings as JSON ({ "cohost": true } lets co-hosts use the button).
ALTER TABLE rooms ADD COLUMN moved_to TEXT;
ALTER TABLE rooms ADD COLUMN moved_from TEXT;
ALTER TABLE rooms ADD COLUMN moved_at INTEGER;
ALTER TABLE rooms ADD COLUMN panic TEXT;
CREATE INDEX IF NOT EXISTS idx_rooms_moved_from ON rooms(moved_from);

-- Every panic action, refused or done: who pressed it, what it did, how many people the room told.
CREATE TABLE IF NOT EXISTS room_moves (
  id         TEXT PRIMARY KEY,
  root_room  TEXT NOT NULL,            -- the first room of the chain (the rate limit counts per chain)
  from_room  TEXT NOT NULL,
  to_room    TEXT,                     -- target 'room': the new room
  target     TEXT NOT NULL,            -- room | zoom | zoom_off | cohost
  ok         INTEGER NOT NULL DEFAULT 1,
  error      TEXT,                     -- why it was refused (too_soon, forbidden, ...)
  ref_type   TEXT,
  ref_id     TEXT,
  by_who     TEXT,
  by_role    TEXT,
  told       INTEGER NOT NULL DEFAULT 0, -- people connected that the room told (moved or shown the Zoom card)
  detail     TEXT,
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_moves_root ON room_moves(root_room, at);
CREATE INDEX IF NOT EXISTS idx_room_moves_from ON room_moves(from_room, at);
