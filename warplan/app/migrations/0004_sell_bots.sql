-- Sell-side bots and long flows (schema v22). The ALTERs run once; the CREATEs are safe to re-run.
ALTER TABLE bots ADD COLUMN kind TEXT NOT NULL DEFAULT 'buy';      -- buy (email owners) | sell (shop a business to buyers)
ALTER TABLE bots ADD COLUMN sell TEXT NOT NULL DEFAULT '{}';       -- the business being sold, as it reads in the email
ALTER TABLE bots ADD COLUMN buyers TEXT NOT NULL DEFAULT '{}';     -- which buyers: segments, countries, sector words
CREATE TABLE IF NOT EXISTS sell_prospects (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  fund_id TEXT NOT NULL,                -- id in the buyers directory (src/data/funds.js)
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active | replied | opted_out | bounced | no_email | removed | finished
  step INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  subject TEXT NOT NULL DEFAULT '',
  action_id INTEGER,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, fund_id)
);
CREATE INDEX IF NOT EXISTS sell_prospects_due ON sell_prospects (bot_id, status, next_at);
CREATE INDEX IF NOT EXISTS sell_prospects_account ON sell_prospects (account_id, fund_id);
CREATE TABLE IF NOT EXISTS fund_contacts (  -- shared: what each fund's own website lists (public)
  fund_id TEXT PRIMARY KEY,
  emails TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL
);
-- Bots saved with the first, softer copy go back to the new direct defaults.
UPDATE bots SET templates = '{}' WHERE templates LIKE '%Probably not, right?%';
