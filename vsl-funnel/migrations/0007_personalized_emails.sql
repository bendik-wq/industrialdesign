-- How each email was personalised, and which behaviour facts it used (so the next email uses different ones).
ALTER TABLE emails ADD COLUMN personalized TEXT;   -- ai | rules | fallback | off
ALTER TABLE emails ADD COLUMN facts_used TEXT;     -- JSON array of fact keys
ALTER TABLE emails ADD COLUMN personalize_error TEXT;
