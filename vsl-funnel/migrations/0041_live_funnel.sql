-- The live webinar funnel (scheduled live events run on Zoom, with our own companion room) and the
-- engagement deposit, its offer. The auto webinar's tables are untouched: live events and their
-- registrations have their own tables; the room's chat, presence and peaks reuse webinar_chat,
-- webinar_presence and webinar_live_peaks keyed by the event id (le…, never a webinar_sessions id).

CREATE TABLE live_webinars (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  starts_at        INTEGER NOT NULL,
  tz               TEXT NOT NULL,                 -- the time zone the owner scheduled it in (shown in Funnel HQ)
  duration_min     INTEGER NOT NULL DEFAULT 120,
  join_url         TEXT,                          -- Zoom (or other) link; viewers reach it through the room
  replay_url       TEXT,                          -- recording link, shown in the room until the offer closes
  status           TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | cancelled
  ended_at         INTEGER,                       -- the host pressed End; otherwise starts_at + duration_min
  offer_opened_at  INTEGER,                       -- the host pressed Open the offer
  offer_closed_at  INTEGER,                       -- the host pressed Close offer (before the deadline)
  offer_hours      INTEGER,                       -- LIVE_OFFER_HOURS when the offer opened: the deadline is end + these hours
  timer_on         INTEGER NOT NULL DEFAULT 0,    -- the host's "Show timer": the countdown to the deadline in every room
  pinned           TEXT,                          -- the host's pinned message
  pinned_at        INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_live_webinars_start ON live_webinars(status, starts_at);

CREATE TABLE live_webinar_regs (
  id               TEXT PRIMARY KEY,
  token            TEXT NOT NULL UNIQUE,          -- personal room link
  event_id         TEXT NOT NULL,
  lead_id          TEXT NOT NULL,
  seq              INTEGER NOT NULL DEFAULT 0,    -- nth live registration for this lead (email step block)
  new_lead         INTEGER NOT NULL DEFAULT 0,
  revenue_band     TEXT,
  ticket_required  INTEGER NOT NULL DEFAULT 0,    -- registered while LIVE_TICKET_PRICE was set
  sms_ok           INTEGER NOT NULL DEFAULT 0,    -- ticked the text-me box on this registration
  joined_at        INTEGER,                       -- first time in the room during the event (presence) or Join on Zoom
  zoom_clicked_at  INTEGER,
  last_seen_at     INTEGER,
  offer_seen_at    INTEGER,                       -- their room showed the open offer
  offer_clicked_at INTEGER,
  replay_at        INTEGER,                       -- in the room after the event ended
  created_at       INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_live_reg_once ON live_webinar_regs(event_id, lead_id);
CREATE INDEX idx_live_reg_lead ON live_webinar_regs(lead_id);

-- Polls the host pushes to every room.
CREATE TABLE live_webinar_polls (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL,
  question   TEXT NOT NULL,
  options    TEXT NOT NULL,                       -- JSON array of strings
  opened_at  INTEGER NOT NULL,
  closed_at  INTEGER
);
CREATE INDEX idx_live_webinar_polls_event ON live_webinar_polls(event_id, opened_at);
CREATE TABLE live_webinar_poll_votes (
  poll_id    TEXT NOT NULL,
  reg_id     TEXT NOT NULL,
  choice     INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, reg_id)
);

-- Purchases from the live funnels (kind 'deposit' and 'live_ticket'; builder C's challenge ones too):
-- where it was bought (live | challenge), the event or cohort, and where the buyer goes once it is paid.
ALTER TABLE webinar_passes ADD COLUMN source TEXT;
ALTER TABLE webinar_passes ADD COLUMN ref_id TEXT;
ALTER TABLE webinar_passes ADD COLUMN return_url TEXT;
CREATE INDEX idx_wp_source ON webinar_passes(kind, source, ref_id);
