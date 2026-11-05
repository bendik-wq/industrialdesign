-- Radar v2 (src/radar/*): more platforms (X, LinkedIn, Reddit, Substack), a keyword universe grouped into themed radars,
-- curated subreddits and Substack publications, paged searches, full sweeps with a cost estimate, and automatic
-- transcription of the best new videos after each sweep. Additive only.

-- Items: the full text of text posts (it doubles as their transcript), the engagement counts the new platforms give,
-- the query that found the item, where it came from (a subreddit or a publication host), and timed transcript segments.
ALTER TABLE radar_items ADD COLUMN body_text TEXT;              -- X, LinkedIn, Reddit, Substack: the post's full text
ALTER TABLE radar_items ADD COLUMN bookmarks INTEGER;           -- X bookmarks
ALTER TABLE radar_items ADD COLUMN saves INTEGER;               -- saves where a platform reports them
ALTER TABLE radar_items ADD COLUMN reposts INTEGER;             -- X reposts + quotes, Substack restacks
ALTER TABLE radar_items ADD COLUMN query TEXT;                  -- the search (or source) that found it last
ALTER TABLE radar_items ADD COLUMN source_ref TEXT;             -- reddit: the subreddit; substack: the publication host
ALTER TABLE radar_items ADD COLUMN transcript_segments TEXT;    -- JSON [{start, end?, text}] when the tool gave timings
ALTER TABLE radar_items ADD COLUMN transcribed_at TEXT;
CREATE INDEX IF NOT EXISTS idx_radar_items_first_seen ON radar_items(first_seen);
CREATE INDEX IF NOT EXISTS idx_radar_items_source ON radar_items(platform, source_ref);

-- Radars: a theme (their keywords come from the keyword universe), X's min_faves floor and a page override.
ALTER TABLE radar_watchlists ADD COLUMN theme TEXT;
ALTER TABLE radar_watchlists ADD COLUMN min_faves INTEGER;      -- X: only posts with at least this many likes (blank = 200 in niche, 1000 adjacent)
ALTER TABLE radar_watchlists ADD COLUMN pages INTEGER;          -- pages per search (blank = RADAR_PAGES)

-- Runs: the sweep they belong to, the page, the query and the source (subreddit or publication) they ran for.
ALTER TABLE radar_runs ADD COLUMN sweep_id TEXT;
ALTER TABLE radar_runs ADD COLUMN page INTEGER NOT NULL DEFAULT 1;
ALTER TABLE radar_runs ADD COLUMN query TEXT;
ALTER TABLE radar_runs ADD COLUMN source_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_radar_runs_sweep ON radar_runs(sweep_id, status);

-- The keyword universe: every search term, in the niche or adjacent, grouped by theme. Radars with a theme search
-- the enabled keywords of that theme.
CREATE TABLE IF NOT EXISTS radar_keywords (
  id          TEXT PRIMARY KEY,
  keyword     TEXT NOT NULL,
  tier        TEXT NOT NULL DEFAULT 'in',  -- in | adjacent
  theme       TEXT NOT NULL,               -- pe_ma | smb_acquisition | owner_exits | breakdowns | wealth | operators | ...
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_radar_keywords_kw ON radar_keywords(theme, keyword);

-- Substack has no search: the publications Radar reads, ranked against each publication's own median.
CREATE TABLE IF NOT EXISTS radar_publications (
  id             TEXT PRIMARY KEY,         -- the host, e.g. www.notboring.co
  url            TEXT NOT NULL,
  name           TEXT NOT NULL,
  niche          TEXT NOT NULL DEFAULT 'out',
  verified       INTEGER NOT NULL DEFAULT 0, -- 1 = a fetch returned posts (or known to be on Substack)
  enabled        INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,                    -- the provider's message when a fetch failed
  median_interactions REAL,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL
);

-- Reddit: the curated subreddits whose top posts Radar reads.
CREATE TABLE IF NOT EXISTS radar_subreddits (
  name           TEXT PRIMARY KEY,         -- without r/
  niche          TEXT NOT NULL DEFAULT 'in',
  enabled        INTEGER NOT NULL DEFAULT 1,
  disabled_reason TEXT,
  last_run_at    TEXT,
  created_at     TEXT NOT NULL
);

-- Sweeps: one press of Full sweep (or a cron round), its estimate, progress and the automatic transcripts after it.
CREATE TABLE IF NOT EXISTS radar_sweeps (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,             -- full | cron | radar
  status        TEXT NOT NULL,             -- running | transcribing | done
  est_micros    INTEGER NOT NULL DEFAULT 0,
  queued        INTEGER NOT NULL DEFAULT 0,
  transcripts_queued INTEGER NOT NULL DEFAULT 0,
  notes_json    TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_radar_sweeps_started ON radar_sweeps(started_at);

-- Small key/value state: platform switches and the one-time v2 seeding marker.
CREATE TABLE IF NOT EXISTS radar_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
