-- Q&A that sells (src/rooms/qa.ts, qa-db.ts): every audience question and chat question the co-host queued, its
-- objection type (keyword rules, re-tagged by the AI co-host when the Anthropic key is set), and whether the team
-- answered it and showed the offer card again. Funnel HQ → Rooms reads it next to purchases (webinar_passes,
-- room_push_events) to show which objections came before buying and which didn't. Additive only.

CREATE TABLE IF NOT EXISTS room_objections (
  room_id     TEXT NOT NULL,
  ref         TEXT NOT NULL,              -- qa:<question id> | chat:<message id> | pre:<who>:<time>
  item_id     INTEGER NOT NULL,           -- the co-host queue item it joined (clustered repeats share one)
  who         TEXT NOT NULL,              -- room member id
  lead_id     TEXT,
  qtype       TEXT NOT NULL,              -- price | time | trust | fit | financing | timing | logistics | other
  tagged_by   TEXT NOT NULL DEFAULT 'rules', -- rules | ai
  source      TEXT NOT NULL,              -- question | chat | prebuy
  text        TEXT,
  at          INTEGER NOT NULL,
  answered_at INTEGER,
  reopened_at INTEGER,                    -- answered with "reopen the offer"
  PRIMARY KEY (room_id, ref)
);
CREATE INDEX IF NOT EXISTS idx_room_objections_item ON room_objections (room_id, item_id);
CREATE INDEX IF NOT EXISTS idx_room_objections_at ON room_objections (at);
CREATE INDEX IF NOT EXISTS idx_room_pushes_created ON room_pushes (created_at);
