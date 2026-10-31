-- Marketing and Sales departments: Meta ads read at ad level, the ads autopilot (fatigue, losers, winners →
-- proposals through ops_actions), new ad drafts from angles, and bulk sales follow-ups (quiet leads, no-shows,
-- unpaid tickets and deposits) with a per-message preview and their own send queue.

-- Ads, ad sets and campaigns as Meta last reported them (status, budget, creative), refreshed hourly.
CREATE TABLE ad_entities (
  id               TEXT PRIMARY KEY,               -- Meta object id
  level            TEXT NOT NULL,                  -- ad | adset | campaign
  name             TEXT,
  status           TEXT,                           -- ACTIVE | PAUSED | ARCHIVED | DELETED (configured)
  effective_status TEXT,                           -- what Meta says is actually delivering
  campaign_id      TEXT,
  adset_id         TEXT,
  daily_budget     INTEGER,                        -- ad sets / CBO campaigns: smallest currency unit
  creative_id      TEXT,
  created_time     INTEGER,                        -- epoch ms
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_ad_entities_level ON ad_entities(level, effective_status);
CREATE INDEX idx_ad_entities_adset ON ad_entities(adset_id);

-- Daily insights per ad (Meta revises recent days, so the last 7 are re-fetched every hour).
CREATE TABLE ad_insights (
  ad_id        TEXT NOT NULL,
  day          TEXT NOT NULL,                      -- YYYY-MM-DD in the ad account's time zone
  adset_id     TEXT,
  campaign_id  TEXT,
  ad_name      TEXT,
  spend        REAL NOT NULL DEFAULT 0,
  impressions  INTEGER NOT NULL DEFAULT 0,
  reach        INTEGER NOT NULL DEFAULT 0,
  frequency    REAL,
  clicks       INTEGER NOT NULL DEFAULT 0,
  link_clicks  INTEGER NOT NULL DEFAULT 0,
  ctr          REAL,                               -- link CTR, percent (inline_link_click_ctr)
  cpc          REAL,                               -- cost per link click
  currency     TEXT,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (ad_id, day)
);
CREATE INDEX idx_ad_insights_day ON ad_insights(day);
CREATE INDEX idx_ad_insights_adset ON ad_insights(adset_id, day);

-- One row per autopilot proposal target per window, so the hourly run never proposes the same change twice.
CREATE TABLE ads_autopilot_log (
  key        TEXT PRIMARY KEY,                     -- rule:target (e.g. pause:<ad id>)
  action_id  TEXT,                                 -- the ops_actions row it created
  rule       TEXT NOT NULL,                        -- fatigue | loser | winner | shift
  target_id  TEXT NOT NULL,
  reason     TEXT,
  created_at INTEGER NOT NULL
);

-- Budget moved per ad set per day (bounded by ADS_MAX_DAILY_SHIFT_PCT), from executed shift actions.
CREATE TABLE ads_budget_shifts (
  id          TEXT PRIMARY KEY,
  day         TEXT NOT NULL,                       -- YYYY-MM-DD (UTC)
  adset_id    TEXT NOT NULL,
  delta       INTEGER NOT NULL,                    -- smallest currency unit, negative = taken away
  before_amt  INTEGER,
  after_amt   INTEGER,
  action_id   TEXT,
  applied     INTEGER NOT NULL DEFAULT 0,          -- 1 = sent to Meta, 0 = apply manually
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ads_shift_day ON ads_budget_shifts(day, adset_id);

-- Ad drafts written from a research angle: three primary texts and headlines, then paused ads or a paste-ready spec.
CREATE TABLE ads_angle_drafts (
  id          TEXT PRIMARY KEY,
  angle       TEXT NOT NULL,
  evidence    TEXT,
  drafts      TEXT NOT NULL,                       -- JSON [{ primary, headline, description, utm_content }]
  adset_id    TEXT,
  creative_id TEXT,                                -- an existing creative / image to reuse, or null (text-only placeholder)
  status      TEXT NOT NULL DEFAULT 'drafted',     -- drafted | proposed | launched | exported | failed
  ad_ids      TEXT,                                -- JSON of the paused ads Meta created
  spec        TEXT,                                -- the paste-ready spec when there's no write token
  action_id   TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Bulk sales follow-ups: one drafted message per lead and channel, previewed in the proposal, sent on approval.
CREATE TABLE ops_followup_messages (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL,                        -- one bulk proposal
  action_id  TEXT,
  play       TEXT NOT NULL,                        -- quiet | no_show | unpaid
  lead_id    TEXT NOT NULL,
  channel    TEXT NOT NULL,                        -- email | sms
  to_addr    TEXT NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  link       TEXT,
  status     TEXT NOT NULL DEFAULT 'draft',        -- draft | queued | sending | sent | simulated | skipped | rejected | failed
  send_at    INTEGER,
  sent_at    INTEGER,
  error      TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_ofm_batch ON ops_followup_messages(batch_id);
CREATE INDEX idx_ofm_due ON ops_followup_messages(status, send_at);
CREATE INDEX idx_ofm_lead ON ops_followup_messages(lead_id, created_at);
