-- One-click First Deal Sprint: charge the payment method the buyer used for their Whop ticket.

-- The buyer's Whop member and saved payment method, from a paid Whop payment (stored on every Whop
-- purchase; one-click reads the lead's paid ticket). Card brand and last 4 are only for "the Visa ending 4242".
ALTER TABLE webinar_passes ADD COLUMN whop_member_id TEXT;
ALTER TABLE webinar_passes ADD COLUMN whop_payment_method_id TEXT;
ALTER TABLE webinar_passes ADD COLUMN card_brand TEXT;
ALTER TABLE webinar_passes ADD COLUMN card_last4 TEXT;

-- 1 = bought with one click (a Whop payment on the saved method, no checkout page). For these rows
-- stripe_session_id is 'whop_<pay id>' and stripe_payment_intent the Whop payment id.
ALTER TABLE webinar_passes ADD COLUMN one_click INTEGER NOT NULL DEFAULT 0;

-- The double-click guard: one one-click attempt in flight per registration. A second click can't insert
-- its row, so it never reaches Whop (which also gets the row id as its Idempotency-Key).
CREATE UNIQUE INDEX idx_wp_one_click ON webinar_passes(reg_id) WHERE one_click = 1 AND status = 'pending';
