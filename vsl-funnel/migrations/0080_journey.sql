-- Overnight loop round 4, "journey": where each buyer came from, and the optional post-deposit add-on.
-- Additive only.

-- One row per buyer conversion (deposit, Sprint, signed engagement): the path that led to it, computed from the
-- attribution, room, email, SMS, call and checkout rows up to the moment they bought. Funnel HQ → Webinar
-- attribution reads it for "common paths to a deposit"; the lead drawer builds its timeline live.
CREATE TABLE IF NOT EXISTS attr_buyer_paths (
  conv_id      TEXT PRIMARY KEY,           -- attr_conversions.id
  lead_id      TEXT NOT NULL,
  kind         TEXT NOT NULL,              -- deposit_paid | sprint_paid | engagement_signed
  funnel       TEXT,
  occurred_at  INTEGER NOT NULL,
  hours_to_buy REAL,                       -- first known touch (or the lead's creation) to the purchase
  path         TEXT NOT NULL,              -- the step sequence, ' > ' joined (what "common paths" groups on)
  summary      TEXT NOT NULL,              -- JSON: first touch, ad/concept/hook, landers, minutes, pushes, questions, messages, checkouts
  computed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attr_buyer_paths_at ON attr_buyer_paths(occurred_at);
CREATE INDEX IF NOT EXISTS idx_attr_buyer_paths_lead ON attr_buyer_paths(lead_id);

-- The post-deposit add-on is offered once per buyer: shown on the welcome page until bought or declined.
CREATE TABLE IF NOT EXISTS deposit_addon_offers (
  lead_id        TEXT PRIMARY KEY,
  first_shown_at INTEGER,
  declined_at    INTEGER,
  updated_at     INTEGER NOT NULL
);

-- The buyer timeline reads these per lead.
CREATE INDEX IF NOT EXISTS idx_room_push_events_lead ON room_push_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_room_objections_lead ON room_objections(lead_id);
CREATE INDEX IF NOT EXISTS idx_webinar_interactions_lead ON webinar_interactions(lead_id, kind);
