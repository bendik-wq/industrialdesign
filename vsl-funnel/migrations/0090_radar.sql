-- Radar (Funnel HQ → Studio → Radar, src/radar/*): top performing videos and Meta ads, in and outside the niche,
-- pulled through Monid, scored, transcribed and analysed for G&L. Additive only.

-- The source map: every tool Monid offered for a slot (platform + kind), the one the owner picked, and the input
-- template that maps our query fields into that tool's input. A paid run only starts for a confirmed pick.
CREATE TABLE IF NOT EXISTS radar_tools (
  slot          TEXT NOT NULL,              -- youtube:search | youtube:transcript | tiktok:search | tiktok:transcript | instagram:search | meta_ads:ads
  provider      TEXT NOT NULL,              -- e.g. apify
  endpoint      TEXT NOT NULL,              -- e.g. /streamers/youtube-scraper
  name          TEXT,
  description   TEXT,
  price_json    TEXT,                       -- {type, amount, flatFee, currency, notes} from inspect
  schema_json   TEXT,                       -- inputSchema from inspect
  doc_url       TEXT,
  recommended   INTEGER NOT NULL DEFAULT 0, -- a known actor for this slot
  selected      INTEGER NOT NULL DEFAULT 0, -- the owner's pick (one per slot)
  template_json TEXT,                       -- the owner's input overrides (merged over the mapped input)
  confirmed_at  TEXT,                       -- set when the owner has seen the exact input and confirmed the pick
  found_at      TEXT NOT NULL,
  PRIMARY KEY (slot, provider, endpoint)
);

-- Watchlists ("radars"): saved searches.
CREATE TABLE IF NOT EXISTS radar_watchlists (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  keywords_json TEXT NOT NULL,              -- ["business acquisition", ...]
  platforms_json TEXT NOT NULL,             -- ["youtube","tiktok","meta_ads"]
  niche         TEXT NOT NULL DEFAULT 'in', -- in | out
  country       TEXT,                       -- ISO 3166 alpha-2, blank = any
  since_days    INTEGER,                    -- only items published in the last N days (blank = the tool's default)
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

-- Every Monid run: what was sent, where it is, what it cost (micro-dollars).
CREATE TABLE IF NOT EXISTS radar_runs (
  id            TEXT PRIMARY KEY,
  watchlist_id  TEXT,                       -- null for a transcript run
  item_id       TEXT,                       -- the item a transcript run is for
  slot          TEXT NOT NULL,
  provider      TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  input_json    TEXT NOT NULL,
  monid_run_id  TEXT,
  status        TEXT NOT NULL,              -- pending | running | completed | failed | skipped
  est_micros    INTEGER NOT NULL DEFAULT 0, -- the estimate checked against the budget before starting
  cost_micros   INTEGER NOT NULL DEFAULT 0, -- what Monid billed (or the estimate when it gave no bill)
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  result_count  INTEGER,
  items_saved   INTEGER,
  polls         INTEGER NOT NULL DEFAULT 0,
  next_poll_at  TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_runs_status ON radar_runs(status, next_poll_at);
CREATE INDEX IF NOT EXISTS idx_radar_runs_created ON radar_runs(created_at);

-- What the radars found, normalised across platforms.
CREATE TABLE IF NOT EXISTS radar_items (
  id            TEXT PRIMARY KEY,           -- platform:external_id
  platform      TEXT NOT NULL,              -- youtube | tiktok | instagram | meta_ads
  external_id   TEXT NOT NULL,
  url           TEXT,
  author        TEXT,
  author_id     TEXT,
  title         TEXT,
  caption       TEXT,
  published_at  TEXT,
  duration_s    REAL,
  views         INTEGER,
  likes         INTEGER,
  comments      INTEGER,
  shares        INTEGER,
  followers     INTEGER,
  thumbnail_url TEXT,
  embed_url     TEXT,
  media_url     TEXT,                       -- ads: the creative's own image or video URL
  media_kind    TEXT,                       -- image | video
  ad_start      TEXT,
  ad_end        TEXT,
  ad_active     INTEGER,
  ad_active_days INTEGER,
  ad_variants   INTEGER,
  ad_cta        TEXT,
  ad_link       TEXT,
  ad_platforms  TEXT,
  niche         TEXT,                       -- in | out | both
  radar_ids     TEXT NOT NULL DEFAULT '[]', -- JSON array of watchlist ids that found it
  score         REAL NOT NULL DEFAULT 0,    -- 0..100
  score_json    TEXT,                       -- the parts: outlier ratio, velocity, engagement, longevity, variants
  transcript    TEXT,
  transcript_source TEXT,                   -- monid | captions | missing | pending
  analysis_json TEXT,
  analysis_brain TEXT,
  analysis_flags TEXT,
  analyzed_at   TEXT,
  script_id     TEXT,
  raw_json      TEXT,
  first_seen    TEXT NOT NULL,
  last_seen     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_radar_items_platform ON radar_items(platform, score);
CREATE INDEX IF NOT EXISTS idx_radar_items_seen ON radar_items(last_seen);
