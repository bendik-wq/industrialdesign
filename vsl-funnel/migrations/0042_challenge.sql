-- The First Deal Challenge: a 5-day live challenge on Zoom with our own companion pages.
-- Cohorts (5 days each, real dates set in Funnel HQ), paid registrations ($100 ticket, $300 VIP bump on the
-- saved card), per-day attendance and homework, the host-opened deposit offer (Days 4 and 5) and its deadline.

CREATE TABLE challenge_cohorts (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  start_date   TEXT NOT NULL,              -- YYYY-MM-DD, Day 1, in the cohort's time zone
  start_time   TEXT NOT NULL,              -- HH:MM daily start, in the cohort's time zone
  timezone     TEXT NOT NULL,              -- IANA, e.g. America/New_York
  duration_min INTEGER NOT NULL DEFAULT 90,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | cancelled
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- The five days, auto-scheduled from the cohort and editable one by one.
CREATE TABLE challenge_days (
  cohort_id    TEXT NOT NULL,
  day          INTEGER NOT NULL,           -- 1..5
  starts_at    INTEGER NOT NULL,           -- epoch ms
  duration_min INTEGER NOT NULL,
  join_url     TEXT,                       -- that day's Zoom (or other) link
  replay_url   TEXT,                       -- pasted after the session (Zoom cloud recording, or an uploaded file's URL)
  hot_seat_url TEXT,                       -- VIP hot seat link (blank = stay on the same Zoom after the session)
  edited       INTEGER NOT NULL DEFAULT 0, -- 1 = time set by hand (kept when the cohort's start changes)
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (cohort_id, day)
);

CREATE TABLE challenge_registrations (
  id           TEXT PRIMARY KEY,
  token        TEXT NOT NULL UNIQUE,       -- bearer token for the hub, day pages and emails
  cohort_id    TEXT NOT NULL,
  lead_id      TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0, -- nth challenge registration for this lead (email step block)
  revenue_band TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending (ticket unpaid) | paid | refunded
  vip          INTEGER NOT NULL DEFAULT 0,
  vip_seen_at  INTEGER,                    -- the VIP bump page was shown
  created_at   INTEGER NOT NULL,
  paid_at      INTEGER,
  vip_at       INTEGER,
  refunded_at  INTEGER
);
CREATE UNIQUE INDEX idx_chreg_once ON challenge_registrations(cohort_id, lead_id);
CREATE INDEX idx_chreg_lead ON challenge_registrations(lead_id);

-- Money: the ticket and the VIP upgrade (Whop). One payment in flight and one paid per registration and kind.
CREATE TABLE challenge_orders (
  id                     TEXT PRIMARY KEY,
  reg_id                 TEXT NOT NULL,
  lead_id                TEXT NOT NULL,
  kind                   TEXT NOT NULL,     -- ticket | vip
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired | refunded
  amount                 INTEGER NOT NULL,  -- smallest currency unit
  currency               TEXT NOT NULL,
  provider               TEXT NOT NULL DEFAULT 'whop', -- whop | none (free)
  method                 TEXT NOT NULL DEFAULT 'form', -- form (embedded) | one_click | hosted
  checkout_id            TEXT,              -- Whop checkout configuration (hosted)
  whop_payment_id        TEXT,
  whop_member_id         TEXT,
  whop_payment_method_id TEXT,
  card_brand             TEXT,
  card_last4             TEXT,
  refunded_amount        INTEGER NOT NULL DEFAULT 0,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  paid_at                INTEGER
);
CREATE UNIQUE INDEX idx_chord_pending ON challenge_orders(reg_id, kind) WHERE status = 'pending';
CREATE UNIQUE INDEX idx_chord_paid ON challenge_orders(reg_id, kind) WHERE status = 'paid';
CREATE INDEX idx_chord_pay ON challenge_orders(whop_payment_id);
CREATE INDEX idx_chord_lead ON challenge_orders(lead_id, status);

-- Per person per day: live attendance (Join on Zoom pressed, or the companion page open while live), replay, homework.
CREATE TABLE challenge_progress (
  reg_id        TEXT NOT NULL,
  day           INTEGER NOT NULL,
  joined_at     INTEGER,                   -- pressed Join on Zoom during the live window
  present_at    INTEGER,                   -- companion page open during the live window
  replay_at     INTEGER,                   -- opened the replay
  homework_at   INTEGER,
  PRIMARY KEY (reg_id, day)
);

-- The day's worksheet (answers as JSON), and the VIP worksheet review written by the team.
CREATE TABLE challenge_homework (
  reg_id       TEXT NOT NULL,
  cohort_id    TEXT NOT NULL,
  day          INTEGER NOT NULL,
  answers      TEXT NOT NULL,
  review       TEXT,
  reviewed_by  TEXT,
  reviewed_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (reg_id, day)
);
CREATE INDEX idx_chhw_cohort ON challenge_homework(cohort_id, day);

-- One answer per person per poll (results shown are the real counts).
CREATE TABLE challenge_polls (
  reg_id     TEXT NOT NULL,
  cohort_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  poll       TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (reg_id, day, poll)
);

-- VIP hot seat questions (VIP only), answered live on the hot seat after each session.
CREATE TABLE challenge_hot_seats (
  id         TEXT PRIMARY KEY,
  reg_id     TEXT NOT NULL,
  cohort_id  TEXT NOT NULL,
  day        INTEGER NOT NULL,
  question   TEXT NOT NULL,
  done_at    INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_chhot ON challenge_hot_seats(cohort_id, day);

-- challenge-offer: the deposit offer opened by the host per event key (challenge:<cohort>:<day>).
CREATE TABLE challenge_offer_state (
  event_key  TEXT PRIMARY KEY,
  open_at    INTEGER,
  closed_at  INTEGER,
  updated_at INTEGER NOT NULL
);

-- Engagement deposits started and paid from the challenge offer (per registration).
CREATE TABLE challenge_deposits (
  reg_id     TEXT PRIMARY KEY,
  cohort_id  TEXT NOT NULL,
  lead_id    TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  paid_at    INTEGER,
  amount     INTEGER,                      -- smallest currency unit
  currency   TEXT
);

-- The lead's current challenge registration (like webinar_token), for texts and emails.
ALTER TABLE leads ADD COLUMN challenge_token TEXT;
