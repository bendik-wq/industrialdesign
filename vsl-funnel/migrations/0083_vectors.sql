-- Cloudflare round, builder C: Vectorize (index gl-knowledge) bookkeeping. Additive only.

-- One row per vector we put in the index. The index itself holds the numbers and a little metadata; this table
-- holds what we need to decide whether to re-embed (a hash of the text that was embedded, and a hash of the
-- metadata) and a short snippet so search results can show what matched without another lookup.
CREATE TABLE IF NOT EXISTS vec_items (
  id          TEXT PRIMARY KEY,           -- the vector id: lead:<id> | q:<…> | note:<…> | doc:<…>
  ns          TEXT NOT NULL,              -- Vectorize namespace: lead | q | note | doc
  ref         TEXT NOT NULL,              -- what it points at: a lead id, room_id|ref, voice call id, passage id
  lead_id     TEXT,                       -- the lead it belongs to, when there is one
  text_hash   TEXT NOT NULL,              -- SHA-256 of the embedded text (a change re-embeds)
  meta_hash   TEXT NOT NULL,              -- SHA-256 of the metadata (a change re-upserts the same values)
  snippet     TEXT,                       -- up to 300 characters of the text, for result lists
  pass        INTEGER NOT NULL DEFAULT 0, -- the indexing pass that last saw it (docs no longer seen are removed)
  indexed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vec_items_ns ON vec_items(ns, ref);
CREATE INDEX IF NOT EXISTS idx_vec_items_lead ON vec_items(lead_id);

-- Where each source's indexing pass has reached (resumable across cron ticks).
CREATE TABLE IF NOT EXISTS vec_cursor (
  source      TEXT PRIMARY KEY,           -- leads | questions | notes | calls | docs
  cursor      TEXT NOT NULL DEFAULT '',   -- the last rowid (or passage position) done in this pass
  pass        INTEGER NOT NULL DEFAULT 0, -- the current pass number
  pass_started_at INTEGER,
  pass_done_at INTEGER,                   -- when the last full pass finished (the next starts after a gap)
  embedded    INTEGER NOT NULL DEFAULT 0, -- vectors embedded in total (for Funnel HQ)
  last_error  TEXT,
  updated_at  INTEGER NOT NULL
);
