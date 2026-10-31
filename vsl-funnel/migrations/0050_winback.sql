-- Win-back (Funnel HQ → Win-back, src/winback/*): invite cold leads (lost, no-show, cancelled, applied and never
-- booked, registered and never bought, ticket bought and no Sprint) into the newer funnels: the automated
-- masterclass, the next live webinar on Zoom, or the next First Deal Challenge cohort.
-- Nothing sends while a campaign is a draft, proposed, paused or stopped: the 5-minute cron sends only for a
-- campaign whose start was approved by the owner in Command (ops_actions kind sales.winback_start).

CREATE TABLE winback_campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | proposed | running | paused | stopped | done
  rules        TEXT NOT NULL DEFAULT '{}',    -- JSON segment rules: segments, minDays, tiers, bands, recentDays
  destination  TEXT NOT NULL DEFAULT 'masterclass', -- masterclass | live | challenge
  dest_ref     TEXT,                          -- live_webinars.id or challenge_cohorts.id
  steps        INTEGER NOT NULL DEFAULT 5,    -- emails per person (4-6)
  gap_days     INTEGER NOT NULL DEFAULT 3,    -- days between emails
  daily_cap    INTEGER NOT NULL DEFAULT 40,   -- most emails this campaign sends in one day (SALES_TIMEZONE)
  window_from  INTEGER NOT NULL DEFAULT 9,    -- sending window, local hours in SALES_TIMEZONE
  window_to    INTEGER NOT NULL DEFAULT 17,
  test_to      TEXT,                          -- the owner's address the last test went to
  test_sent_at INTEGER,
  action_id    TEXT,                          -- the sales.winback_start proposal
  proposed_at  INTEGER,
  approved_at  INTEGER,
  approved_by  TEXT,                          -- you | slack
  started_at   INTEGER,
  paused_at    INTEGER,
  stopped_at   INTEGER,
  ended_reason TEXT,
  held_reason  TEXT,                          -- why the cron is holding sends right now (destination not on sale)
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_winback_campaigns_status ON winback_campaigns(status);

-- Who is in a campaign: snapshotted from the previewed audience at the moment the owner approves the start.
CREATE TABLE winback_enrollments (
  campaign_id   TEXT NOT NULL,
  lead_id       TEXT NOT NULL,
  segment       TEXT NOT NULL,
  last_active_at INTEGER,                       -- their last real activity when enrolled (the emails say how long it has been)
  status       TEXT NOT NULL DEFAULT 'active', -- active | stopped | done
  stop_reason   TEXT,                           -- registered | bought | booked | replied | unsubscribed | ... | sequence finished
  next_step     INTEGER NOT NULL DEFAULT 0,
  next_at       INTEGER,
  first_sent_at INTEGER,
  last_sent_at  INTEGER,
  enrolled_at   INTEGER NOT NULL,
  stopped_at    INTEGER,
  PRIMARY KEY (campaign_id, lead_id)
);
CREATE INDEX idx_winback_enr_due ON winback_enrollments(status, next_at);
CREATE INDEX idx_winback_enr_lead ON winback_enrollments(lead_id, status);

-- Every win-back email sent (id = emails.id, so opens and clicks land on the emails row).
CREATE TABLE winback_sends (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  lead_id     TEXT NOT NULL,
  step        INTEGER NOT NULL,
  subject     TEXT,
  status      TEXT NOT NULL,                  -- sent | simulated | failed
  error       TEXT,
  sent_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_winback_sends_campaign ON winback_sends(campaign_id, sent_at);
CREATE INDEX idx_winback_sends_lead ON winback_sends(lead_id, sent_at);
