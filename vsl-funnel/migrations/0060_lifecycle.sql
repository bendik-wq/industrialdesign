-- Builder E (lifecycle): registration to replay for live events (src/live/lifecycle*.ts, src/rooms/lifecycle.ts).
-- Own tables only (leads is at D1's column limit; live_webinar_regs stays as it is).

-- Per event: the calendar SEQUENCE (bumped on every reschedule or cancel, so calendar apps update the entry
-- they already hold), the pre-show video and slides, the reminder cadence, and the subject-line test switch.
CREATE TABLE IF NOT EXISTS lc_events (
  event_id     TEXT PRIMARY KEY,
  ics_seq      INTEGER NOT NULL DEFAULT 0,
  rv           INTEGER NOT NULL DEFAULT 0,       -- reminder version: bumped when the start moves (reminders run again for the new time)
  starts_at    INTEGER,                          -- the start the current SEQUENCE describes
  video_url    TEXT,                             -- "watch this before" (https, or a path on this site)
  slides       TEXT,                             -- JSON [{title, body}] for the waiting room loop (blank = defaults)
  cadence      TEXT,                             -- JSON {email: {kind: bool}, sms: {kind: bool}} (blank = defaults)
  subject_ab   INTEGER NOT NULL DEFAULT 0,       -- 1 = split reminder subject lines A/B
  notice_at    INTEGER,                          -- last reschedule/cancel notice sent
  updated_at   INTEGER NOT NULL
);

-- Per registration: calendar, per-person time zone, the one-tap text opt-in, the pre-show question and
-- worksheet, the personal referral code, who referred them, and the registration IP (hashed, fraud checks only).
CREATE TABLE IF NOT EXISTS lc_regs (
  reg_id          TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL,
  lead_id         TEXT NOT NULL,
  tz              TEXT,
  cal_added_at    INTEGER,
  cal_kind        TEXT,                          -- google | outlook | apple | ics
  sms_optin_at    INTEGER,
  question        TEXT,
  question_at     INTEGER,
  worksheet       TEXT,                          -- JSON (Deal Plan fields)
  worksheet_at    INTEGER,
  preshow_at      INTEGER,                       -- first opened the pre-show page
  ref_code        TEXT,
  ref_clicks      INTEGER NOT NULL DEFAULT 0,
  referred_by     TEXT,                          -- referrer's reg id (counted or not: see lc_referrals)
  ip_hash         TEXT,
  visitor_id      TEXT,
  created_at      INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lc_regs_ref ON lc_regs(ref_code);
CREATE INDEX IF NOT EXISTS idx_lc_regs_event ON lc_regs(event_id);

-- Every referred registration, with the fraud verdict. status: counted | attended | rejected
CREATE TABLE IF NOT EXISTS lc_referrals (
  referred_reg_id TEXT PRIMARY KEY,
  referrer_reg_id TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  status          TEXT NOT NULL,
  reason          TEXT,                          -- self | same_ip | same_browser | over_cap | other_event
  rewarded_at     INTEGER,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lc_referrals_referrer ON lc_referrals(referrer_reg_id);

-- Tracked returns: which reminder (email, text, calendar entry) someone clicked to come back to their room.
CREATE TABLE IF NOT EXISTS lc_touches (
  reg_id    TEXT NOT NULL,
  event_id  TEXT NOT NULL,
  via       TEXT NOT NULL,                       -- e-r1h | s-missing | cal | ...
  at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lc_touches_reg ON lc_touches(reg_id, at);
CREATE INDEX IF NOT EXISTS idx_lc_touches_event ON lc_touches(event_id);
