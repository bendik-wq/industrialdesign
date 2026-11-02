-- Ads autopilot: concept testing (rounds of 4 concepts x 3 ads), hook-only variants of winners,
-- and video scripts / hook packs for Josh to record. Additive only.

-- One test round: four concepts, three ads each (or hook-only variants of a winner), launched through the approval queue.
CREATE TABLE ads_concept_rounds (
  id          TEXT PRIMARY KEY,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'concepts',   -- concepts | hooks (hook-only variants of a winner)
  origin      TEXT NOT NULL DEFAULT 'template',   -- ai | template
  status      TEXT NOT NULL DEFAULT 'drafted',    -- drafted | proposed | launched | exported | failed
  adset_id    TEXT,
  creative_id TEXT,
  action_id   TEXT,
  spec        TEXT,                               -- paste-ready spec when there's no write token
  error       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ads_rounds_created ON ads_concept_rounds(created_at);

-- A concept: the fixed bundle of variables every ad in it shares.
CREATE TABLE ads_concepts (
  id          TEXT PRIMARY KEY,
  round_id    TEXT NOT NULL,
  idx         INTEGER NOT NULL,                   -- 1..4 within the round
  desire      TEXT NOT NULL,
  awareness   TEXT NOT NULL,                      -- unaware | problem | solution | product | most
  format      TEXT NOT NULL,
  audience    TEXT NOT NULL,
  angle       TEXT NOT NULL,                      -- the angle text (the sales argument)
  angle_id    TEXT,                               -- research_angles.id when it came from Research
  angle_key   TEXT,                               -- built-in angle key when it came from the rule angles
  framework   TEXT NOT NULL,
  proof_id    TEXT,
  verdict     TEXT,                               -- winner | loser | null
  verdict_by  TEXT,                               -- auto | you
  parent_id   TEXT,                               -- hook round: the winning concept
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ads_concepts_round ON ads_concepts(round_id, idx);

-- One ad: hook and body kept apart, so hook-only variants reuse the body word for word.
CREATE TABLE ads_concept_ads (
  id           TEXT PRIMARY KEY,
  round_id     TEXT NOT NULL,
  concept_id   TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'execution', -- execution | hook_variant
  parent_ad_id TEXT,                              -- the winning ad a hook variant was made from
  hook         TEXT NOT NULL,
  body         TEXT NOT NULL,
  headline     TEXT NOT NULL,
  description  TEXT,
  utm_content  TEXT NOT NULL,                     -- the tag results are matched on
  meta_ad_id   TEXT,                              -- the paused ad Meta created, once launched
  status       TEXT NOT NULL DEFAULT 'draft',     -- draft | proposed | launched | exported | failed
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_ads_concept_ads_tag ON ads_concept_ads(utm_content);
CREATE INDEX idx_ads_concept_ads_concept ON ads_concept_ads(concept_id, idx);
CREATE INDEX idx_ads_concept_ads_round ON ads_concept_ads(round_id);
CREATE INDEX idx_ads_concept_ads_meta ON ads_concept_ads(meta_ad_id);

-- Video scripts for Josh to record. Hooks are stored apart from the body so any hook can be swapped in.
CREATE TABLE ads_scripts (
  id          TEXT PRIMARY KEY,
  format      TEXT NOT NULL,                      -- talking_head | podcast_clip | double_hook | mechanism | cost_of_waiting
  title       TEXT NOT NULL,
  angle       TEXT NOT NULL,
  angle_id    TEXT,
  angle_key   TEXT,
  hooks       TEXT NOT NULL DEFAULT '[]',         -- JSON [string]
  body        TEXT NOT NULL DEFAULT '[]',         -- JSON [{ beat, say, screen? }]
  cta         TEXT NOT NULL,
  notes       TEXT,                               -- recording notes (on-screen text, labels)
  origin      TEXT NOT NULL DEFAULT 'template',   -- ai | template
  status      TEXT NOT NULL DEFAULT 'draft',      -- draft | recorded | retired
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_ads_scripts_created ON ads_scripts(created_at);

-- Standalone hook packs (swap into any script or ad).
CREATE TABLE ads_hooks (
  id          TEXT PRIMARY KEY,
  pack_id     TEXT NOT NULL,
  style       TEXT NOT NULL,                      -- callout | question | contrarian | proof | mechanism | cost | double
  text        TEXT NOT NULL,
  angle       TEXT,
  awareness   TEXT,
  status      TEXT NOT NULL DEFAULT 'new',        -- new | used | retired
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_ads_hooks_pack ON ads_hooks(pack_id, created_at);
