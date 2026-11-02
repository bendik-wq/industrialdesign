-- Meta audiences and custom conversions (src/audiences/*): what is planned, what was created in Meta (only after
-- the owner approves "Create all in Meta" in Command), and the daily customer-list resync. One row per planned item,
-- keyed by our own stable key (e.g. list_buyer_first_deal_sprint, conv_booked_tier_a). The leads table is at D1's
-- column limit, so nothing is added there.
CREATE TABLE meta_audiences (
  key            TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,              -- conversion | website | list | lookalike
  name           TEXT NOT NULL,              -- the name it has (or will have) in Meta
  meta_id        TEXT,                       -- Meta's id once created
  status         TEXT NOT NULL DEFAULT 'not_created', -- not_created | queued | created | syncing | error
  spec           TEXT,                       -- JSON: what was sent to Meta (rule, lookalike spec), for the record
  our_count      INTEGER,                    -- people in our own data at the last sync (lists) or check
  members_hash   TEXT,                       -- fingerprint of the last uploaded member set (skips unchanged uploads)
  size_lower     INTEGER,                    -- Meta's approximate_count_lower_bound
  size_upper     INTEGER,
  meta_status    TEXT,                       -- Meta's operation / delivery status text
  error          TEXT,
  action_id      TEXT,                       -- the approved ops_actions row that created it
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  meta_created_at INTEGER,
  last_synced_at INTEGER,                    -- last full customer-list upload (lists)
  size_checked_at INTEGER
);
CREATE INDEX idx_meta_aud_status ON meta_audiences(kind, status);
