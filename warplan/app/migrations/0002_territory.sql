-- Densification map (schema v20). Safe to re-run.
CREATE TABLE IF NOT EXISTS territory_sites (id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, target_id INTEGER, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', lat REAL NOT NULL, lng REAL NOT NULL, radius_km REAL NOT NULL DEFAULT 25, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS territory_sites_account ON territory_sites (account_id);
CREATE TABLE IF NOT EXISTS territory_prefs (account_id INTEGER PRIMARY KEY, radius_km REAL NOT NULL DEFAULT 25, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS geocode_cache (q TEXT PRIMARY KEY, results TEXT NOT NULL, at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS geocode_log (account_id INTEGER NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS geocode_log_at ON geocode_log (at);
