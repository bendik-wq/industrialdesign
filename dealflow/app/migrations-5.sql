-- v5: accounts, users, invites, API tokens and exclusive territories. Safe to run once on a v4 database.
-- Existing data becomes account 1 ("Dealflow HQ"), the platform admin account.
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  max_territories INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO accounts (id, name, plan, max_territories, created_at) VALUES (1, 'Dealflow HQ', 'admin', 999, datetime('now'));

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',      -- owner | member
  is_admin INTEGER NOT NULL DEFAULT 0,      -- platform admin
  password_hash TEXT NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS users_account ON users (account_id);

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

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS territories (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  country TEXT NOT NULL,
  industry TEXT NOT NULL,
  region TEXT,                              -- NULL = the whole country
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS territories_lookup ON territories (country, industry);
CREATE INDEX IF NOT EXISTS territories_account ON territories (account_id);

ALTER TABLE searches ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leads ADD COLUMN account_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS searches_account ON searches (account_id, id DESC);

-- Pipeline and AI drafts are private to each account.
CREATE TABLE pipeline_v5 (
  account_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, company_id)
);
INSERT INTO pipeline_v5 (account_id, company_id, status, notes, updated_at) SELECT 1, company_id, status, notes, updated_at FROM pipeline;
DROP TABLE pipeline;
ALTER TABLE pipeline_v5 RENAME TO pipeline;
CREATE INDEX IF NOT EXISTS pipeline_company ON pipeline (company_id);

CREATE TABLE ai_outputs_v5 (
  account_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, company_id, kind)
);
INSERT INTO ai_outputs_v5 SELECT 1, company_id, kind, model, content, created_at FROM ai_outputs;
DROP TABLE ai_outputs;
ALTER TABLE ai_outputs_v5 RENAME TO ai_outputs;
