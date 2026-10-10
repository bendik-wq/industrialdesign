-- Warplan schema. Apply with: npm run db:schema
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  max_territories INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO accounts (id, name, plan, max_territories, created_at) VALUES (1, 'Warplan HQ', 'admin', 999, datetime('now'));

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  is_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Conversations with the AI agents (Josh, the seller simulator, ...).
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_user ON threads (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id);

-- ------------------------------------------------------------------ v2: pipeline, documents, integrations, usage
-- Team invites (owners create a link; the invitee picks a password).
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by INTEGER,
  accepted_at TEXT
);

-- Bring-your-own provider keys, encrypted with AES-GCM (key derived from KEYS_SECRET). Never sent back to a browser.
CREATE TABLE IF NOT EXISTS account_keys (
  account_id INTEGER NOT NULL,
  provider TEXT NOT NULL,            -- anthropic | elevenlabs
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',     -- last 4 characters, for display
  meta TEXT NOT NULL DEFAULT '{}',   -- non-secret settings (e.g. ElevenLabs voice id, model)
  created_by INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- Acquisition targets: the deal pipeline.
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_by INTEGER,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  owner_age INTEGER,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  employees INTEGER,
  revenue REAL,
  ebitda REAL,
  asking REAL,
  currency TEXT NOT NULL DEFAULT '$',
  stage TEXT NOT NULL DEFAULT 'sourced',
  priority INTEGER NOT NULL DEFAULT 2,  -- 1 high, 2 normal, 3 low
  source TEXT NOT NULL DEFAULT '',
  motivation TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  next_date TEXT,
  deal TEXT,                            -- Deal Builder structure (JSON) for this target
  tags TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stage_at TEXT
);
CREATE INDEX IF NOT EXISTS targets_acct ON targets (account_id, stage, updated_at DESC);

-- Timeline per target: notes, calls, stage changes, generated documents.
CREATE TABLE IF NOT EXISTS target_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                   -- note | call | stage | doc | email | meeting
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS target_events_t ON target_events (target_id, id DESC);

-- Documents the agents write (LOI, outreach, diligence, board pack, 100-day plan), editable afterwards.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_acct ON documents (account_id, id DESC);
CREATE INDEX IF NOT EXISTS documents_target ON documents (target_id, id DESC);

-- AI usage per call, for the usage page, platform limits and cost control.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  own_key INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_acct ON usage (account_id, created_at);

-- Outgoing webhooks: POST signed JSON to the customer's own systems (Zapier, Make, a CRM) on events.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_status INTEGER,
  last_at TEXT
);

-- Per-user saved state (Deal Builder, Value Ladder), so it follows you across devices.
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ------------------------------------------------------------------ v3: agents act
-- Approve-before-act inbox: actions agents propose (autopilot, external agents); a person approves or dismisses.
CREATE TABLE IF NOT EXISTS agent_actions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'autopilot',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | dismissed | failed
  result TEXT,
  dedupe TEXT,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_actions_acct ON agent_actions (account_id, status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_actions_dedupe ON agent_actions (account_id, dedupe) WHERE status = 'pending';

-- Workspace settings (autopilot on/off, ...).
CREATE TABLE IF NOT EXISTS settings (
  account_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);
