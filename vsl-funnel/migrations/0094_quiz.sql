-- The acquisition readiness quiz (src/quiz): one row per quiz started, filled in as the person answers, passes the
-- email gate, sees the result and saves a seat. Additive only. The lead's own columns (revenue_band, industry) are
-- reused; everything quiz-specific lives here because leads is at D1's 100-column limit.
CREATE TABLE IF NOT EXISTS quiz_responses (
  id               TEXT PRIMARY KEY,
  token            TEXT NOT NULL UNIQUE,          -- the personal result link (/quiz/r/<token>)
  visitor_id       TEXT,
  session_id       TEXT,
  lead_id          TEXT,                          -- set at the email gate
  first_name       TEXT,                          -- as typed at the gate (an existing lead keeps its own)
  answers          TEXT NOT NULL DEFAULT '{}',    -- {"revenue":"3_10m","industry":"healthcare",...}
  step_reached     INTEGER NOT NULL DEFAULT 0,    -- highest question answered (1..10)
  score            INTEGER,                       -- readiness 0..100 (src/quiz/scoring.ts)
  archetype        TEXT,                          -- consolidator | first_deal | stuck_scaler | exit_builder | foundation
  gaps             TEXT,                          -- ["funding","deal_flow"]
  revenue_band     TEXT,                          -- the lead band ('3m-10m'), for reports
  target           TEXT,                          -- QUIZ_TARGET when the seat was saved: webinar | live
  reg_id           TEXT,                          -- webinar_registrations.id or live_webinar_regs.id
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,                       -- answered the last question
  gate_viewed_at   INTEGER,
  lead_at          INTEGER,
  result_viewed_at INTEGER,
  registered_at    INTEGER,
  channel          TEXT,
  utm_source       TEXT,
  utm_campaign     TEXT,
  utm_content      TEXT,
  device           TEXT,
  is_bot           INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quiz_started ON quiz_responses(started_at);
CREATE INDEX IF NOT EXISTS idx_quiz_lead ON quiz_responses(lead_id);
CREATE INDEX IF NOT EXISTS idx_quiz_archetype ON quiz_responses(archetype, lead_at);

-- Segment tags on a lead (email and audience segmentation). The quiz writes quiz:<archetype> and quiz:gap:<gap>.
CREATE TABLE IF NOT EXISTS lead_tags (
  lead_id    TEXT NOT NULL,
  tag        TEXT NOT NULL,
  source     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_lead_tags_tag ON lead_tags(tag);
