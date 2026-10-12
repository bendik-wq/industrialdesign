-- Every Calendly booking ever made (one row per invitee per event), including ones from before the funnel.
-- Leads hold the latest booking; this keeps the full history for reporting.
CREATE TABLE calendly_bookings (
  invitee_uri   TEXT PRIMARY KEY,
  event_uri     TEXT NOT NULL,
  lead_id       TEXT,
  email         TEXT,
  name          TEXT,
  event_name    TEXT,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER,
  booked_at     INTEGER,
  status        TEXT NOT NULL,        -- active | canceled | no_show
  rescheduled   INTEGER NOT NULL DEFAULT 0,
  canceled_by   TEXT,
  cancel_reason TEXT,
  host_email    TEXT,
  join_url      TEXT,
  answers       TEXT,                 -- JSON [{q, a}]
  tracking      TEXT,                 -- JSON utm_* from Calendly
  synced_at     INTEGER NOT NULL
);
CREATE INDEX idx_calbook_lead ON calendly_bookings(lead_id);
CREATE INDEX idx_calbook_start ON calendly_bookings(start_at);
CREATE INDEX idx_calbook_email ON calendly_bookings(email);
