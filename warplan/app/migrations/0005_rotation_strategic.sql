-- Mailbox rotation and strategic buyers (schema v23). The ALTERs run once; the CREATE is safe to re-run.
CREATE TABLE IF NOT EXISTS mailbox_pool (     -- extra sending mailboxes a workspace's bots rotate through
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_by INTEGER,
  email TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,                          -- an SMTP host, or 'agentmail' for a managed inbox
  port INTEGER NOT NULL DEFAULT 0,
  username TEXT NOT NULL DEFAULT '',
  ciphertext TEXT NOT NULL DEFAULT '',
  iv TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 30,
  warmup INTEGER NOT NULL DEFAULT 1,           -- ramp up from a few a day
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, email)
);
ALTER TABLE sent_emails ADD COLUMN pool_id INTEGER;                -- null: the sender's own mailbox
ALTER TABLE bots ADD COLUMN mailboxes TEXT NOT NULL DEFAULT '["main"]';
ALTER TABLE bot_prospects ADD COLUMN mailbox TEXT NOT NULL DEFAULT '';
ALTER TABLE sell_prospects ADD COLUMN mailbox TEXT NOT NULL DEFAULT '';
ALTER TABLE sell_prospects ADD COLUMN buyer_kind TEXT NOT NULL DEFAULT 'fund';   -- fund | strategic
ALTER TABLE sell_prospects ADD COLUMN buyer TEXT NOT NULL DEFAULT '{}';          -- strategic buyer: name, website, phone, location, signals
CREATE INDEX IF NOT EXISTS sent_emails_pool_day ON sent_emails (pool_id, created_at);
