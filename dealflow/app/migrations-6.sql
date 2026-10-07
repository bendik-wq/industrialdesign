-- v6 skeleton: adds conversation storage. Old v5 tables are left in place untouched (nothing reads them).
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
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id);
