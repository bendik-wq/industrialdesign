-- Research department: what $1M+ owners complain about and want (Reddit, YouTube, our own leads),
-- what competitors are running (Meta Ad Library), the themes Claude (or the rules) find in it,
-- and the angle backlog handed to Marketing. Every theme and angle links back to its evidence rows.

-- One row per piece of evidence: a Reddit post or comment, a YouTube video, or one of our own
-- voice-of-customer answers (application, booking form, call notes, webinar questions and chat).
CREATE TABLE research_items (
  id            TEXT PRIMARY KEY,          -- source:external id (stable, so re-collecting dedupes)
  source        TEXT NOT NULL,             -- reddit | youtube | voc
  kind          TEXT NOT NULL,             -- post | comment | video | application | booking | objection | call_note | webinar_question | webinar_chat
  external_id   TEXT NOT NULL,
  url           TEXT,                      -- public link (reddit / youtube) or the Funnel HQ view (voc)
  title         TEXT,
  body          TEXT,                      -- excerpt, at most 1200 characters, contact details removed for voc
  community     TEXT,                      -- subreddit, channel, or the voc form name
  query         TEXT,                      -- the search or listing that found it
  score         INTEGER NOT NULL DEFAULT 0, -- upvotes or views
  comments      INTEGER NOT NULL DEFAULT 0,
  lead_id       TEXT,
  revenue_band  TEXT,                      -- voc: the lead's revenue band
  published_at  INTEGER,
  collected_at  INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX idx_ritems_source ON research_items(source, published_at);
CREATE INDEX idx_ritems_collected ON research_items(collected_at);

-- Competitor and keyword ads from the Meta Ad Library API.
CREATE TABLE research_ads (
  id            TEXT PRIMARY KEY,          -- ad archive id
  page_id       TEXT,
  page_name     TEXT,
  tracked_as    TEXT,                      -- the competitor from settings, or "search: <term>"
  body          TEXT,                      -- ad text (first creative), at most 2000 characters
  title         TEXT,
  description   TEXT,
  caption       TEXT,                      -- landing domain shown on the ad
  link_url      TEXT,                      -- ad snapshot (Ad Library page for the ad)
  platforms     TEXT,                      -- JSON array
  languages     TEXT,                      -- JSON array
  start_at      INTEGER,
  stop_at       INTEGER,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);
CREATE INDEX idx_rads_page ON research_ads(page_name);
CREATE INDEX idx_rads_start ON research_ads(start_at);

-- Collection, analysis and brief runs (what ran, when, how much came in, and any error).
CREATE TABLE research_runs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,             -- collect | analyze | brief
  status        TEXT NOT NULL,             -- running | done | failed
  mode          TEXT,                      -- ai | rules
  stats         TEXT,                      -- JSON
  body          TEXT,                      -- brief: JSON { lines, numbers, links }
  error         TEXT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX idx_rruns_kind ON research_runs(kind, started_at);

-- Themes from one analysis run: market complaints and desires, our own voice of customer, and competitor angles.
CREATE TABLE research_themes (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  scope         TEXT NOT NULL,             -- market | voc | competitor
  kind          TEXT NOT NULL,             -- complaint | desire | objection | offer
  label         TEXT NOT NULL,
  summary       TEXT,
  item_count    INTEGER NOT NULL DEFAULT 0, -- counted from the linked rows, never from the model
  item_ids      TEXT NOT NULL DEFAULT '[]', -- JSON: research_items ids or research_ads ids
  meta          TEXT,                       -- JSON: competitor offer details (hook, offer, guarantee, price, longest running days)
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_rthemes_run ON research_themes(run_id, scope);

-- The angle backlog Marketing tests.
CREATE TABLE research_angles (
  id            TEXT PRIMARY KEY,
  run_id        TEXT,
  origin        TEXT NOT NULL DEFAULT 'ai', -- ai | rules
  hook          TEXT NOT NULL,
  promise       TEXT NOT NULL,
  proof_id      TEXT,                       -- one of the approved proof points (src/research/analyze.ts)
  audience      TEXT,
  revenue_band  TEXT,
  belief        TEXT,                       -- the belief it breaks
  evidence      TEXT NOT NULL DEFAULT '[]', -- JSON: research_items / research_ads ids
  status        TEXT NOT NULL DEFAULT 'new', -- new | approved | testing | winner | retired
  action_id     TEXT,                       -- the ops action proposed by "Send to Marketing"
  sent_at       INTEGER,
  fingerprint   TEXT NOT NULL,              -- normalised hook, so the same angle is not added twice
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_rangles_fp ON research_angles(fingerprint);
CREATE INDEX idx_rangles_status ON research_angles(status, created_at);
