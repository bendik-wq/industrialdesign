-- The First Deal Sprint, sold in the room: it unlocks at the pitch minute, closes when that
-- registration's replay closes, and carries a fast-action bonus for 24 hours after it unlocked.

-- When the offer unlocked for this registration (first time only: reloading never resets it).
-- The offer deadline is the registration's replay close; the fast-action bonus ends 24 hours after this
-- or at that deadline, whichever is first.
ALTER TABLE webinar_registrations ADD COLUMN offer_unlocked_at INTEGER;

-- Per purchase: the price before the ticket credit, the ticket payments taken off it, the payment plan
-- and its Stripe subscription, and whether it was bought inside the fast-action window.
ALTER TABLE webinar_passes ADD COLUMN list_amount INTEGER;                       -- full price (one payment, or the plan total)
ALTER TABLE webinar_passes ADD COLUMN ticket_credit INTEGER NOT NULL DEFAULT 0;  -- paid masterclass tickets taken off the first payment
ALTER TABLE webinar_passes ADD COLUMN installments INTEGER NOT NULL DEFAULT 1;   -- 1 = one payment; 2 = "2 payments of ..."
ALTER TABLE webinar_passes ADD COLUMN installments_paid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE webinar_passes ADD COLUMN stripe_subscription_id TEXT;              -- payment plans only
ALTER TABLE webinar_passes ADD COLUMN plan_cancel_at INTEGER;                   -- when we told Stripe to stop the plan after its last payment
ALTER TABLE webinar_passes ADD COLUMN fast_bonus INTEGER NOT NULL DEFAULT 0;    -- bought before the fast-action deadline
CREATE INDEX idx_wp_sub ON webinar_passes(stripe_subscription_id);

-- One row per Stripe invoice paid on a payment plan: the guard that makes invoice.paid idempotent,
-- and where a refunded charge finds its purchase.
CREATE TABLE webinar_pass_payments (
  id                TEXT PRIMARY KEY,
  pass_id           TEXT NOT NULL,
  stripe_invoice_id TEXT NOT NULL UNIQUE,
  payment_intent    TEXT,
  amount            INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  installment       INTEGER NOT NULL,
  paid_at           INTEGER NOT NULL
);
CREATE INDEX idx_wpp_pass ON webinar_pass_payments(pass_id);
CREATE INDEX idx_wpp_pi ON webinar_pass_payments(payment_intent);
