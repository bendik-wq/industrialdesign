-- Round 4 "lifecycle2" (src/live/lifecycle2*.ts): per-event switches for the bootcamp lead-in, the adaptive
-- sequence for late sign-ups, and the missed-live path. All off by default (a row only exists once the owner
-- switches something on in Funnel HQ → Live webinars). Additive only: the emails themselves are rows in
-- `emails` (sequence 'lc2:<event id>'), so the existing claim, retry and opened/clicked tracking apply.
CREATE TABLE IF NOT EXISTS lc2_events (
  event_id    TEXT PRIMARY KEY,
  leadin      INTEGER NOT NULL DEFAULT 0,   -- 1 = the 3-part lead-in before the session (page + email)
  adaptive    INTEGER NOT NULL DEFAULT 0,   -- 1 = late sign-ups get one essentials email instead of a partial series
  missed      INTEGER NOT NULL DEFAULT 0,   -- 1 = the short missed-live path (replaces the no-show highlights email)
  updated_at  INTEGER NOT NULL
);
