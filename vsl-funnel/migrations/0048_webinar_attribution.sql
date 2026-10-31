-- Webinar attribution: first and last touch, the full touch path, stage events per person per funnel
-- (automated webinar, live Zoom webinar, 5-day challenge), per-minute watch data for the live rooms and
-- a send-once log for the extra Meta stage events. The leads table is at D1's 100-column limit, so
-- everything lives in its own tables, keyed by lead and registration.

-- Which browsers (visitor ids) belong to which person. Filled at registration and checkout (the browser
-- that did it), and from the cross-domain link token (apply. → live. and back) so both cookies join up.
CREATE TABLE attr_people (
  lead_id    TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  via        TEXT NOT NULL,                 -- registration | checkout | lead | xdomain
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, visitor_id)
);
CREATE INDEX idx_attr_people_visitor ON attr_people(visitor_id);

-- Two cookies on two of our domains that are the same browser (a link carried the signed token across).
CREATE TABLE attr_xdomain (
  visitor_id   TEXT NOT NULL,               -- the browser on this domain
  other_id     TEXT NOT NULL,               -- the same browser's id on the domain the link came from
  from_host    TEXT,
  to_host      TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (visitor_id, other_id)
);
CREATE INDEX idx_attr_xdomain_other ON attr_xdomain(other_id);

-- The touch path: one row per visit (session) by any of a person's browsers, copied from sessions when the
-- person converts, so the path survives session clean-up. Ordered by ts.
CREATE TABLE attr_touches (
  session_id    TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  visitor_id    TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  landing       TEXT,
  channel       TEXT,
  platform      TEXT,
  source        TEXT,
  medium        TEXT,
  campaign      TEXT,
  content       TEXT,
  term          TEXT,
  link_code     TEXT,                       -- tracked link (/l/<code>) when utm_content is one
  ad_id         TEXT,                       -- Meta ad id (utm_content={{ad.id}} or ad_id=)
  adset_id      TEXT,
  campaign_id   TEXT,
  click_type    TEXT,                       -- fbclid | gclid | ...
  click_id      TEXT,
  referrer_host TEXT,
  device        TEXT,
  country       TEXT
);
CREATE INDEX idx_attr_touches_lead ON attr_touches(lead_id, ts);

-- One row per registration, purchase and signed engagement, with the first and last touch at that moment.
-- amount and refunded are in the smallest currency unit; revenue = amount - refunded.
CREATE TABLE attr_conversions (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,              -- registered | ticket_paid | sprint_paid | deposit_paid | vip_paid | engagement_signed
  funnel        TEXT NOT NULL,              -- auto | live | challenge
  ref_id        TEXT NOT NULL,              -- registration / pass / order / contract id
  reg_id        TEXT,                       -- the funnel registration it belongs to
  lead_id       TEXT NOT NULL,
  occurred_at   INTEGER NOT NULL,
  amount        INTEGER NOT NULL DEFAULT 0,
  refunded      INTEGER NOT NULL DEFAULT 0,
  currency      TEXT,
  edition       TEXT,                       -- auto webinar: recorded | ai (when it was captured)
  cohort_ref    TEXT,                       -- webinar session id / live event id / challenge cohort id
  visitor_id    TEXT,
  touches       INTEGER NOT NULL DEFAULT 0, -- touches on the path up to this conversion
  fbc           TEXT,
  fbp           TEXT,
  ft_ts INTEGER, ft_channel TEXT, ft_platform TEXT, ft_source TEXT, ft_medium TEXT, ft_campaign TEXT, ft_content TEXT, ft_term TEXT,
  ft_link_code TEXT, ft_ad_id TEXT, ft_adset_id TEXT, ft_campaign_id TEXT, ft_click_type TEXT, ft_landing TEXT, ft_referrer_host TEXT, ft_device TEXT, ft_country TEXT,
  lt_ts INTEGER, lt_channel TEXT, lt_platform TEXT, lt_source TEXT, lt_medium TEXT, lt_campaign TEXT, lt_content TEXT, lt_term TEXT,
  lt_link_code TEXT, lt_ad_id TEXT, lt_adset_id TEXT, lt_campaign_id TEXT, lt_click_type TEXT, lt_landing TEXT, lt_referrer_host TEXT, lt_device TEXT, lt_country TEXT,
  gclid         TEXT,
  fbclid        TEXT,
  via           TEXT NOT NULL DEFAULT 'live', -- live (captured as it happened) | sync (back-filled) | metadata (from the checkout)
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  UNIQUE (kind, ref_id)
);
CREATE INDEX idx_attr_conv_time ON attr_conversions(funnel, kind, occurred_at);
CREATE INDEX idx_attr_conv_lead ON attr_conversions(lead_id, occurred_at);

-- Stage events per person per funnel, de-duplicated by id (funnel:reg:stage[:detail]).
CREATE TABLE attr_stages (
  id         TEXT PRIMARY KEY,
  funnel     TEXT NOT NULL,                 -- auto | live | challenge
  stage      TEXT NOT NULL,                 -- registered, ticket_paid, attended, watched_25 ... (see src/attribution/stages.ts)
  lead_id    TEXT NOT NULL,
  reg_id     TEXT NOT NULL,
  cohort_ref TEXT,
  edition    TEXT,
  ts         INTEGER NOT NULL,
  value      REAL,                          -- minutes, cents, day number…
  detail     TEXT,                          -- chapter id, poll answer, day…
  source     TEXT NOT NULL DEFAULT 'server' -- server | client | zoom | sync
);
CREATE INDEX idx_attr_stages_q ON attr_stages(funnel, stage, ts);
CREATE INDEX idx_attr_stages_lead ON attr_stages(lead_id, ts);
CREATE INDEX idx_attr_stages_reg ON attr_stages(reg_id);

-- Minutes on screen in the live rooms (live webinar companion room, challenge day pages), from the rooms'
-- own presence polls. One row per person per minute after the start; the auto webinar keeps its own per-minute
-- strings on webinar_registrations.
CREATE TABLE attr_watch (
  funnel     TEXT NOT NULL,                 -- live | challenge
  event_ref  TEXT NOT NULL,                 -- live event id / challenge:<cohort>:<day>
  reg_id     TEXT NOT NULL,
  lead_id    TEXT NOT NULL,
  minute     INTEGER NOT NULL,
  source     TEXT NOT NULL DEFAULT 'room',  -- room | zoom
  PRIMARY KEY (funnel, event_ref, reg_id, minute)
);
CREATE INDEX idx_attr_watch_event ON attr_watch(funnel, event_ref);

-- Distinct visitors per funnel landing page per day (the "visit" stage).
CREATE TABLE attr_visits (
  funnel     TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  day        TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  ts         INTEGER NOT NULL,
  session_id TEXT,
  PRIMARY KEY (funnel, visitor_id, day)
);
CREATE INDEX idx_attr_visits_ts ON attr_visits(funnel, ts);

-- Extra Meta stage events (Lead per registration, attended, offer seen) sent once each.
CREATE TABLE attr_capi (
  key      TEXT PRIMARY KEY,                -- name:reg id
  name     TEXT NOT NULL,
  lead_id  TEXT NOT NULL,
  event_id TEXT NOT NULL,
  sent_at  INTEGER NOT NULL
);
