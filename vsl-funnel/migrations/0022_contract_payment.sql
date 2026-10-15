-- Per-agreement payment link, payment email and paid tracking.
ALTER TABLE contracts ADD COLUMN pay_link TEXT;
ALTER TABLE contracts ADD COLUMN pay_email_sent_at INTEGER;
ALTER TABLE contracts ADD COLUMN paid_at INTEGER;
