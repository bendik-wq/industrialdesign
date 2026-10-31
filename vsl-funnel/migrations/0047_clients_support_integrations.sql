-- Builder E: Client Success, the support inbox, outbound/inbound webhooks (Zapier-style). The MCP server
-- needs no table (its bearer token is the MCP_TOKEN setting). Proposed actions live in ops_actions (0043).

-- ── Client Success ──
-- One row per client: a lead with a paid First Deal Sprint, a paid engagement deposit or a signed engagement.
-- Rebuilt by the daily job (src/clients/health.ts); checklist ticks and next check-in survive rebuilds.
CREATE TABLE cs_clients (
  lead_id          TEXT PRIMARY KEY,
  client_type      TEXT NOT NULL,              -- sprint | deposit | engagement (the furthest step reached)
  since_at         INTEGER NOT NULL,           -- when they became a client of that type
  health           INTEGER,                    -- 0..100
  band             TEXT,                       -- healthy | watch | at_risk | churned
  reasons          TEXT,                       -- JSON [{label, delta, source}]
  flags            TEXT,                       -- JSON ["payment_overdue", ...]
  last_contact_at  INTEGER,                    -- last two-way contact (their message, a session, a call)
  last_outbound_at INTEGER,                    -- last message from the team
  next_checkin_at  INTEGER,
  checklist        TEXT NOT NULL DEFAULT '{}', -- JSON {item_key: done_at} ticked by hand (derived items are computed)
  owner_note       TEXT,
  scored_at        INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX idx_cs_clients_band ON cs_clients(band, health);
CREATE INDEX idx_cs_clients_next ON cs_clients(next_checkin_at);

-- Daily health per client, for the trend line.
CREATE TABLE cs_health_history (
  lead_id TEXT NOT NULL,
  day     TEXT NOT NULL,                       -- YYYY-MM-DD
  health  INTEGER NOT NULL,
  band    TEXT NOT NULL,
  PRIMARY KEY (lead_id, day)
);

-- What the team logs by hand: weekly working sessions attended or missed, calls, notes.
CREATE TABLE cs_touchpoints (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL,
  kind       TEXT NOT NULL,                    -- session_attended | session_missed | call | note | outreach_sent
  at         INTEGER NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cs_touch_lead ON cs_touchpoints(lead_id, at);

-- Scheduled check-ins: drafted (Claude, or the built-in template), proposed through the action layer
-- (kind cs.checkin), sent by email only once approved.
CREATE TABLE cs_checkins (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL,
  due_at     INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'proposed', -- proposed | sent | skipped | failed
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,                    -- plain text, paragraphs separated by blank lines
  reason     TEXT,                             -- why now (from the health reasons)
  drafted_by TEXT NOT NULL DEFAULT 'template', -- claude | template | you
  action_id  TEXT,
  error      TEXT,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_cs_checkins_lead ON cs_checkins(lead_id, created_at);
CREATE INDEX idx_cs_checkins_status ON cs_checkins(status, due_at);

-- ── Support inbox ──
CREATE TABLE support_threads (
  id              TEXT PRIMARY KEY,
  channel         TEXT NOT NULL,               -- email | room | live | challenge | zapier
  source_ref      TEXT UNIQUE,                 -- dedupe key: email Message-ID, room question id, hot seat id
  subject         TEXT,
  from_email      TEXT,
  from_name       TEXT,
  lead_id         TEXT,
  status          TEXT NOT NULL DEFAULT 'open', -- open | drafted | escalated | answered | closed
  escalated       INTEGER NOT NULL DEFAULT 0,
  escalate_reason TEXT,
  last_inbound_at INTEGER,
  last_outbound_at INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_support_threads_status ON support_threads(status, updated_at);
CREATE INDEX idx_support_threads_lead ON support_threads(lead_id);
CREATE INDEX idx_support_threads_email ON support_threads(from_email, updated_at);

CREATE TABLE support_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  direction  TEXT NOT NULL,                    -- in | out
  body       TEXT NOT NULL,
  from_email TEXT,
  message_id TEXT,                             -- email Message-ID (threading)
  provider_id TEXT,                            -- Resend id
  sent_by    TEXT,                             -- you | auto (outbound)
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_support_messages_thread ON support_messages(thread_id, created_at);

CREATE TABLE support_drafts (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL,
  body            TEXT NOT NULL,
  citations       TEXT NOT NULL DEFAULT '[]',  -- JSON [{id, title, url}]
  confidence      REAL,
  escalate        INTEGER NOT NULL DEFAULT 0,
  escalate_reason TEXT,
  status          TEXT NOT NULL DEFAULT 'draft', -- draft | sent | discarded
  model           TEXT,
  action_id       TEXT,
  edited          INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE INDEX idx_support_drafts_thread ON support_drafts(thread_id, created_at);

-- ── Outbound webhooks (Zapier "Catch Hook", Make, n8n…) ──
CREATE TABLE hook_subscriptions (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  events      TEXT NOT NULL,                   -- JSON array of event names, or ["*"]
  secret      TEXT NOT NULL,                   -- HMAC key for X-Funnel-Signature
  label       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  last_status INTEGER,
  last_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- Every business event, once (event + ref), whether or not anyone subscribes.
CREATE TABLE hook_events (
  id         TEXT PRIMARY KEY,
  event      TEXT NOT NULL,
  ref_id     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_hook_events_once ON hook_events(event, ref_id);

CREATE TABLE hook_deliveries (
  id           TEXT PRIMARY KEY,
  sub_id       TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | delivered | failed
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_at      INTEGER NOT NULL,
  last_status  INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE UNIQUE INDEX idx_hook_deliveries_once ON hook_deliveries(sub_id, event_id);
CREATE INDEX idx_hook_deliveries_due ON hook_deliveries(status, next_at);
