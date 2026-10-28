-- First Deal Sprint delivery (part 3 of the paid masterclass ladder).
-- A paid Sprint is a webinar_passes row (kind = 'offer', status = 'paid'). These tables hang off its id.

-- One row per Sprint: the calls, the outcome and the engagement it led to. Created on first touch.
CREATE TABLE deal_sprints (
  pass_id            TEXT PRIMARY KEY,          -- webinar_passes.id
  lead_id            TEXT NOT NULL,
  kickoff_booked_at  INTEGER,                   -- Day 1 kickoff call booked (team marks it, or the buyer clicked the link)
  kickoff_held_at    INTEGER,
  plan_booked_at     INTEGER,                   -- Day 7 Deal Plan session
  plan_held_at       INTEGER,
  outcome            TEXT,                      -- proposal_sent | signed | not_continuing | refunded
  outcome_at         INTEGER,
  proposal_sent_at   INTEGER,                   -- starts the proposal follow-up emails
  engagement_fee     INTEGER,                   -- whole currency units, as proposed or signed
  contract_id        TEXT,                      -- the engagement agreement
  notes              TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX idx_deal_sprints_lead ON deal_sprints(lead_id);

-- Each deliverable's status, filled in by the team on the Sprint board. Missing row = waiting.
CREATE TABLE deal_sprint_deliverables (
  pass_id     TEXT NOT NULL,
  key         TEXT NOT NULL,                    -- capacity | buy_box | shortlist | structure_memo | outreach_script | josh_review
  status      TEXT NOT NULL DEFAULT 'waiting',  -- waiting | in_progress | ready
  link        TEXT,                             -- https link to the document, when ready
  notes       TEXT,                             -- shown to the buyer when ready
  ready_at    INTEGER,
  emailed_at  INTEGER,                          -- the "it's ready" email went out
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (pass_id, key)
);

-- The buyer's intake form (business basics), from the Sprint page.
CREATE TABLE deal_sprint_intake (
  pass_id         TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL,
  revenue         TEXT,
  ebitda          TEXT,
  industry        TEXT,
  locations       TEXT,
  buy_what        TEXT,
  cash            TEXT,
  timeline        TEXT,
  financials_url  TEXT,
  notes           TEXT,
  submitted_at    INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

-- The Sprint fee credited on the engagement agreement (whole currency units), shown as its own line with the net due.
ALTER TABLE contracts ADD COLUMN credit_amount INTEGER NOT NULL DEFAULT 0;
ALTER TABLE contracts ADD COLUMN credit_label TEXT;
ALTER TABLE contracts ADD COLUMN credit_pass_id TEXT;
