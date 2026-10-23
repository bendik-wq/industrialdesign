-- Ad spend by campaign and day (synced from Meta, or typed in for other platforms).
CREATE TABLE ad_spend (
  platform      TEXT NOT NULL,             -- meta | google | youtube | other
  campaign_id   TEXT NOT NULL,             -- the platform's id, or a slug for manual rows
  day           TEXT NOT NULL,             -- YYYY-MM-DD (manual monthly rows use the 1st)
  campaign_name TEXT,
  spend         REAL NOT NULL DEFAULT 0,
  impressions   INTEGER NOT NULL DEFAULT 0,
  clicks        INTEGER NOT NULL DEFAULT 0,
  link_clicks   INTEGER NOT NULL DEFAULT 0,
  currency      TEXT,
  source        TEXT NOT NULL DEFAULT 'sync', -- sync | manual
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (platform, campaign_id, day)
);
CREATE INDEX idx_ad_spend_day ON ad_spend(day);

-- Which funnel a campaign feeds (auto-guessed from the name; changeable in Funnel HQ).
CREATE TABLE ad_campaigns (
  platform    TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  funnel      TEXT NOT NULL,                -- vsl | webinar | other
  PRIMARY KEY (platform, campaign_id)
);

-- Which minutes of the masterclass each person actually had on screen ('1' per minute), live and replay.
ALTER TABLE webinar_registrations ADD COLUMN live_minutes TEXT;
ALTER TABLE webinar_registrations ADD COLUMN replay_minutes TEXT;
