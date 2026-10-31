-- The Masterclass ticket paid on our own page with Whop's payment elements, card saved for later (so the
-- First Deal Sprint is one click). Whop's hosted checkout doesn't keep the card on one-time payments.

-- 1 = paid with the embedded form (a Whop payment we created from a confirmation token). Like one-click
-- rows, stripe_session_id is 'whop_<pay id>' and stripe_payment_intent the Whop payment id.
ALTER TABLE webinar_passes ADD COLUMN embedded INTEGER NOT NULL DEFAULT 0;

-- The double-submit guard: one embedded payment in flight per registration.
CREATE UNIQUE INDEX idx_wp_embedded ON webinar_passes(reg_id) WHERE embedded = 1 AND status = 'pending';
