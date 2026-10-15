CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT, business TEXT, email TEXT, phone TEXT, status TEXT, industry TEXT, years TEXT, systems TEXT,
  watched INTEGER, source TEXT, ip TEXT, country TEXT
);
CREATE INDEX IF NOT EXISTS leads_ip_time ON leads (ip, created_at);
