-- Dealflow schema (v5: accounts + territories). Apply with: npm run db:schema
DROP TABLE IF EXISTS territories;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS invites;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS agent_targets;
DROP TABLE IF EXISTS agent_runs;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS leads;
DROP TABLE IF EXISTS ai_outputs;
DROP TABLE IF EXISTS pipeline;
DROP TABLE IF EXISTS search_results;
DROP TABLE IF EXISTS searches;
DROP TABLE IF EXISTS companies;
DROP TABLE IF EXISTS accounts;

CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,            -- fr_sirene | no_brreg | uk_ch | places | us_tx_tdlr
  source_id TEXT NOT NULL,         -- SIREN, org.nr, company number, place id, license key
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  legal_form TEXT,
  industry_code TEXT,
  address TEXT,
  city TEXT,
  region TEXT,
  postcode TEXT,
  lat REAL,
  lng REAL,
  founded INTEGER,
  employees_min INTEGER,
  employees_band TEXT,
  establishments INTEGER,
  revenue REAL,
  revenue_year INTEGER,
  currency TEXT,
  owner_name TEXT,
  owner_age INTEGER,
  people TEXT,                     -- JSON [{name, role, birthYear, birthMonth}]
  website TEXT,
  phone TEXT,
  email TEXT,
  rating REAL,
  reviews INTEGER,
  registry_url TEXT,
  size_score INTEGER,
  succession_score INTEGER,
  fit_score INTEGER,
  verdict TEXT,
  summary TEXT,
  signals TEXT,                    -- JSON [{type, label, pts, detail}]
  excluded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  industry TEXT,
  fin_year INTEGER,
  ebit REAL,
  net_income REAL,
  payroll REAL,
  cash REAL,
  equity REAL,
  long_term_debt REAL,
  valuation_mid REAL,
  inbound INTEGER NOT NULL DEFAULT 0,
  UNIQUE (source, source_id)
);
CREATE INDEX companies_fit ON companies (excluded, fit_score DESC);
CREATE INDEX companies_country ON companies (country, fit_score DESC);

CREATE TABLE searches (
  id INTEGER PRIMARY KEY,
  country TEXT NOT NULL,
  industry TEXT NOT NULL,
  region TEXT,
  region_label TEXT,
  min_staff INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued | running | done | failed
  total INTEGER,                   -- matches reported by the source
  found INTEGER NOT NULL DEFAULT 0,-- companies saved
  pages INTEGER,
  pages_done INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  account_id INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX searches_account ON searches (account_id, id DESC);

CREATE TABLE search_results (
  search_id INTEGER NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  PRIMARY KEY (search_id, company_id)
);
CREATE INDEX search_results_company ON search_results (company_id);

CREATE TABLE pipeline (
  account_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, company_id)
);
CREATE INDEX pipeline_company ON pipeline (company_id);

CREATE TABLE ai_outputs (
  account_id INTEGER NOT NULL,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- brief | letter
  model TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, company_id, kind)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  name TEXT, email TEXT, phone TEXT,
  timeline TEXT, message TEXT,
  valuation_low REAL, valuation_high REAL, currency TEXT,
  created_at TEXT NOT NULL,
  account_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  config TEXT NOT NULL,            -- JSON, see src/agents.js validateConfig
  buyer TEXT NOT NULL DEFAULT '{}',-- JSON outreach settings used for letters
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  account_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,            -- queued | running | done | failed
  trigger TEXT NOT NULL,           -- manual | schedule | mcp
  search_id INTEGER,
  targets INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  log TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent ON agent_runs (agent_id, id DESC);
CREATE TABLE IF NOT EXISTS agent_targets (
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, company_id)
);

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

