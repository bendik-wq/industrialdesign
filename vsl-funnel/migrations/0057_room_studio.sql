-- Rooms: the production studio (builder B, src/rooms/studio.ts, studio-db.ts). Per-room studio settings (branding,
-- intro music, default scene and layout, the green room), show templates reusable across events, uploaded slide
-- decks (pages stored in R2 under slides/<room>/<deck>/<n>) and studio assets (logo, intro music; R2 studio/assets/<id>).

ALTER TABLE rooms ADD COLUMN studio TEXT;   -- JSON StudioSettings; NULL = the defaults

CREATE TABLE IF NOT EXISTS studio_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  settings TEXT NOT NULL,                   -- JSON StudioSettings
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS studio_decks (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  title TEXT NOT NULL,
  pages INTEGER NOT NULL DEFAULT 0,
  mime TEXT NOT NULL DEFAULT 'image/webp',
  notes TEXT,                               -- JSON array of presenter notes, one per page
  status TEXT NOT NULL DEFAULT 'uploading', -- uploading | ready
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_studio_decks_room ON studio_decks (room_id, created_at);

CREATE TABLE IF NOT EXISTS studio_assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                       -- logo | music
  name TEXT,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
