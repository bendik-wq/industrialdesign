-- Scored target companies (rebuilt by ingest; safe to wipe and reseed).
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  legal_name TEXT,
  owner TEXT,
  sole INTEGER,
  county TEXT,
  metro TEXT,
  street TEXT,
  city TEXT,
  zip TEXT,
  entity TEXT,
  licensed_since INTEGER,
  business_since INTEGER,
  license_count INTEGER,
  active_licenses INTEGER,
  outlets INTEGER,
  class_a INTEGER,
  size_score INTEGER,
  size_tier TEXT,
  succession_score INTEGER,
  fit_score INTEGER,
  non_target INTEGER,
  website TEXT,
  phone TEXT,
  email TEXT,
  rating REAL,
  reviews INTEGER,
  signals TEXT,
  licensees TEXT
);
CREATE INDEX IF NOT EXISTS companies_fit ON companies (non_target, fit_score DESC);
CREATE INDEX IF NOT EXISTS companies_metro ON companies (metro);

-- Deal pipeline, keyed by the stable company key so reseeding never loses work.
CREATE TABLE IF NOT EXISTS pipeline (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
