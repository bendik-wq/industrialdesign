-- Search & AI search: how often each search engine / AI crawler fetches each page, per day.
CREATE TABLE IF NOT EXISTS crawler_hits (
  day   TEXT NOT NULL,     -- YYYY-MM-DD (UTC)
  bot   TEXT NOT NULL,     -- e.g. GPTBot, ClaudeBot, PerplexityBot, Googlebot
  host  TEXT NOT NULL,     -- main | data | webinar
  path  TEXT NOT NULL,
  hits  INTEGER NOT NULL DEFAULT 0,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (day, bot, host, path)
);
CREATE INDEX IF NOT EXISTS idx_crawler_hits_bot ON crawler_hits(bot, day);
