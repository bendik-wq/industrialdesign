-- Live events (live webinar sessions, challenge days) run on Zoom. One row per event key:
-- 'webinar:<session id>' or 'challenge:<cohort id>:<day>'. The join link is pasted in Funnel HQ or created
-- through the Zoom API (Server-to-Server OAuth). zoom_start_url is the host's start link: admin only, never
-- sent to viewers (Zoom expires it after two hours, so the host console fetches a fresh one on demand).
CREATE TABLE live_events (
  key            TEXT PRIMARY KEY,
  title          TEXT,
  starts_at      INTEGER,            -- ms; null = not scheduled yet
  duration_min   INTEGER,
  join_url       TEXT,
  zoom_id        TEXT,               -- Zoom meeting or webinar number, when created through the API
  zoom_kind      TEXT,               -- 'meeting' | 'webinar'
  zoom_start_url TEXT,
  zoom_password  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
