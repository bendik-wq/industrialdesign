-- Owners Academy VSL funnel: first-party analytics + CRM schema.
-- All timestamps are unix epoch milliseconds.

-- One row per browser (first-party HttpOnly cookie `_fv`, 400 days).
CREATE TABLE visitors (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  lead_id         TEXT,
  -- first-touch attribution (never overwritten)
  ft_channel      TEXT,
  ft_source       TEXT,
  ft_medium       TEXT,
  ft_campaign     TEXT,
  ft_content      TEXT,
  ft_term         TEXT,
  ft_referrer     TEXT,
  ft_landing      TEXT,
  ft_click_id     TEXT,
  ft_click_type   TEXT,
  country         TEXT,
  city            TEXT,
  device          TEXT,
  browser         TEXT,
  os              TEXT,
  is_bot          INTEGER NOT NULL DEFAULT 0,
  session_count   INTEGER NOT NULL DEFAULT 0,
  pageview_count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_visitors_created ON visitors(created_at);
CREATE INDEX idx_visitors_lead ON visitors(lead_id);

-- One row per visit (30 min inactivity, or a new campaign click, starts a new one).
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  visitor_id      TEXT NOT NULL,
  started_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  landing_path    TEXT,
  landing_query   TEXT,
  referrer        TEXT,
  referrer_host   TEXT,
  channel         TEXT,
  utm_source      TEXT,
  utm_medium      TEXT,
  utm_campaign    TEXT,
  utm_content     TEXT,
  utm_term        TEXT,
  utm_id          TEXT,
  click_id        TEXT,
  click_type      TEXT,
  ad_id           TEXT,
  adset_id        TEXT,
  placement       TEXT,
  country         TEXT,
  region          TEXT,
  city            TEXT,
  postal_code     TEXT,
  timezone        TEXT,
  latitude        REAL,
  longitude       REAL,
  continent       TEXT,
  is_eu           INTEGER NOT NULL DEFAULT 0,
  asn             INTEGER,
  as_org          TEXT,
  colo            TEXT,
  http_protocol   TEXT,
  tls_version     TEXT,
  ip              TEXT,
  ip_hash         TEXT,
  user_agent      TEXT,
  device          TEXT,
  browser         TEXT,
  browser_version TEXT,
  os              TEXT,
  os_version      TEXT,
  accept_language TEXT,
  -- filled in by the client beacon
  language        TEXT,
  client_tz       TEXT,
  screen          TEXT,
  viewport        TEXT,
  dpr             REAL,
  connection      TEXT,
  is_bot          INTEGER NOT NULL DEFAULT 0,
  bot_reason      TEXT,
  variant         TEXT,
  pageviews       INTEGER NOT NULL DEFAULT 0,
  event_count     INTEGER NOT NULL DEFAULT 0,
  engaged_ms      INTEGER NOT NULL DEFAULT 0,
  max_scroll      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_visitor ON sessions(visitor_id);

-- Every tracked action, server-side and client-side, in one stream.
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  name        TEXT NOT NULL,
  visitor_id  TEXT,
  session_id  TEXT,
  lead_id     TEXT,
  path        TEXT,
  source      TEXT NOT NULL,          -- server | client | webhook | email | cron | admin
  variant     TEXT,
  is_bot      INTEGER NOT NULL DEFAULT 0,
  props       TEXT                    -- JSON
);
CREATE INDEX idx_events_ts ON events(ts);
CREATE INDEX idx_events_name_ts ON events(name, ts);
CREATE INDEX idx_events_session ON events(session_id);
CREATE INDEX idx_events_visitor ON events(visitor_id);
CREATE INDEX idx_events_lead ON events(lead_id);

-- Leads are created the moment step 1 of the application (contact details) is saved,
-- so abandoned applications can be recovered.
CREATE TABLE leads (
  id                    TEXT PRIMARY KEY,
  ref_code              TEXT NOT NULL UNIQUE,   -- short code used in WhatsApp + support
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  visitor_id            TEXT,
  session_id            TEXT,
  first_name            TEXT,
  last_name             TEXT,
  email                 TEXT,
  phone                 TEXT,
  whatsapp_opt_in       INTEGER NOT NULL DEFAULT 0,
  answers               TEXT NOT NULL DEFAULT '{}', -- JSON
  step_reached          INTEGER NOT NULL DEFAULT 0,
  app_started_at        INTEGER,
  app_completed_at      INTEGER,
  score                 INTEGER,
  score_breakdown       TEXT,                       -- JSON
  tier                  TEXT,                       -- A | B | C
  tier_override         TEXT,
  route                 TEXT,                       -- /book | /breakout | /resources
  closer_id             TEXT,
  status                TEXT NOT NULL DEFAULT 'partial',
      -- partial | applied | booked | showed | no_show | won | lost | nurture | disqualified
  booked_at             INTEGER,
  call_at               INTEGER,
  booking_provider      TEXT,
  booking_ref           TEXT,
  booking_cancelled_at  INTEGER,
  whatsapp_clicked_at   INTEGER,
  whatsapp_connected_at INTEGER,
  whatsapp_wa_id        TEXT,
  unsubscribed_at       INTEGER,
  revenue               REAL NOT NULL DEFAULT 0,
  notes                 TEXT,
  -- attribution snapshot at lead creation
  channel               TEXT,
  utm_source            TEXT,
  utm_medium            TEXT,
  utm_campaign          TEXT,
  utm_content           TEXT,
  utm_term              TEXT,
  click_id              TEXT,
  click_type            TEXT,
  ft_channel            TEXT,
  ft_source             TEXT,
  ft_campaign           TEXT,
  ft_content            TEXT,
  landing_path          TEXT,
  variant               TEXT,
  country               TEXT,
  city                  TEXT,
  device                TEXT,
  fbp                   TEXT,
  fbc                   TEXT
);
CREATE UNIQUE INDEX idx_leads_email ON leads(email);
CREATE INDEX idx_leads_created ON leads(created_at);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_leads_tier ON leads(tier);

-- One row per video view: watched-percent bitmap (100 buckets) powers the retention curve.
CREATE TABLE vsl_views (
  id              TEXT PRIMARY KEY,
  video_id        TEXT NOT NULL,
  visitor_id      TEXT,
  session_id      TEXT,
  lead_id         TEXT,
  variant         TEXT,
  started_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  duration        REAL,
  max_position    REAL NOT NULL DEFAULT 0,
  watched_seconds REAL NOT NULL DEFAULT 0,
  buckets         TEXT NOT NULL,           -- 100 chars of 0/1
  played          INTEGER NOT NULL DEFAULT 0,
  unmuted         INTEGER NOT NULL DEFAULT 0,
  completed       INTEGER NOT NULL DEFAULT 0,
  cta_revealed    INTEGER NOT NULL DEFAULT 0,
  cta_clicked     INTEGER NOT NULL DEFAULT 0,
  is_bot          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_vsl_video_started ON vsl_views(video_id, started_at);
CREATE INDEX idx_vsl_lead ON vsl_views(lead_id);

-- Email queue + log. Rows are scheduled by sequences and sent by the cron.
CREATE TABLE emails (
  id            TEXT PRIMARY KEY,
  lead_id       TEXT NOT NULL,
  sequence      TEXT NOT NULL,
  step          INTEGER NOT NULL,
  template      TEXT NOT NULL,
  to_email      TEXT NOT NULL,
  subject       TEXT,
  send_at       INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
      -- pending | sending | sent | simulated | skipped | cancelled | failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  sent_at       INTEGER,
  provider_id   TEXT,
  opened_at     INTEGER,
  open_count    INTEGER NOT NULL DEFAULT 0,
  clicked_at    INTEGER,
  click_count   INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_emails_due ON emails(status, send_at);
CREATE INDEX idx_emails_lead ON emails(lead_id);
CREATE UNIQUE INDEX idx_emails_unique_step ON emails(lead_id, sequence, step);

-- WhatsApp messages (Cloud API inbound/outbound).
CREATE TABLE whatsapp_messages (
  id          TEXT PRIMARY KEY,
  ts          INTEGER NOT NULL,
  lead_id     TEXT,
  direction   TEXT NOT NULL,         -- in | out
  wa_id       TEXT,
  body        TEXT,
  template    TEXT,
  status      TEXT,
  provider_id TEXT
);
CREATE INDEX idx_wa_lead ON whatsapp_messages(lead_id);

-- Integration keys connected from the dashboard (env vars always win).
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Small key/value state (round-robin pointers, cron cursors).
CREATE TABLE kv_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
