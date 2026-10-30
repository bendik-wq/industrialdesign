-- Seller links expire (security audit, Oct 2026). Run once: npm run db:migrate. Existing live links get 60 days.
ALTER TABLE deal_rooms ADD COLUMN link_expires_at TEXT;
UPDATE deal_rooms SET link_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+60 days') WHERE link_on = 1;
