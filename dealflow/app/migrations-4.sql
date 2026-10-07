-- v4: agents. Safe to run once on a v3 database.
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  config TEXT NOT NULL,            -- JSON, see src/agents.js validateConfig
  buyer TEXT NOT NULL DEFAULT '{}',-- JSON outreach settings used for letters
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_run_at TEXT
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
