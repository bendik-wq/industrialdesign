-- The brain (src/brain/*): Bendik's copy and venture knowledge as a graph with retrieval, used by Radar and Studio.
-- Filled only at deploy by scripts/brain/build.mjs + seed.mjs from the private brain checkout (wiki/engine/** and
-- wiki/ventures/gl/** only). Empty tables mean "no brain": every caller then behaves exactly as before. Additive only.

-- One row per wiki page.
CREATE TABLE IF NOT EXISTS brain_pages (
  id            TEXT PRIMARY KEY,           -- the page name (file name without .md; unique across the wiki)
  path          TEXT NOT NULL,              -- wiki/engine/copy/legends/....md
  title         TEXT NOT NULL,
  summary       TEXT,
  folder        TEXT NOT NULL,              -- engine/copy/legends, ventures/gl/people, ...
  legend        TEXT,                       -- the copywriting legend this page is about (legends/* only)
  pagerank      REAL NOT NULL DEFAULT 0,
  links_json    TEXT,                       -- outgoing [[links]] to pages that are loaded
  headings_json TEXT,
  build_id      TEXT,
  updated_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_pages_folder ON brain_pages(folder);

-- Retrieval units: a page split by its headings (~600 to 1,200 characters).
CREATE TABLE IF NOT EXISTS brain_chunks (
  id            TEXT PRIMARY KEY,           -- <page>#<n>
  page_id       TEXT NOT NULL,
  ord           INTEGER NOT NULL DEFAULT 0,
  title         TEXT NOT NULL,              -- the page title (kept here so the full-text index can weight it)
  heading       TEXT,
  text          TEXT NOT NULL,
  kind          TEXT NOT NULL,              -- principle | technique | example | fact | rule
  tags_json     TEXT,                       -- {techniques[], links[], src[], unverified}
  legend        TEXT,
  verified      INTEGER NOT NULL DEFAULT 1, -- 0 when the chunk carries an **unverified** mark
  hash          TEXT,                       -- content hash; a changed chunk is embedded again
  embedded_hash TEXT,                       -- the hash that was last embedded into Vectorize (namespace brain)
  build_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_brain_chunks_page ON brain_chunks(page_id, ord);
CREATE INDEX IF NOT EXISTS idx_brain_chunks_legend ON brain_chunks(legend);

-- Typed edges between pages: links_to, backlink, sibling (same folder), part_of (to the folder's hub).
CREATE TABLE IF NOT EXISTS brain_edges (
  src    TEXT NOT NULL,
  dst    TEXT NOT NULL,
  type   TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (src, dst, type)
);
CREATE INDEX IF NOT EXISTS idx_brain_edges_dst ON brain_edges(dst);

-- BM25 over chunks (title and heading weighted up at query time). External content: the seed's last step rebuilds it.
CREATE VIRTUAL TABLE IF NOT EXISTS brain_fts USING fts5(
  title, heading, text, legend,
  content='brain_chunks', content_rowid='rowid',
  tokenize='porter unicode61'
);
