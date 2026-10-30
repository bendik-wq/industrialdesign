-- Whop as the payment provider (WHOP_API_KEY set), and the pay-first First Deal Sprint (form, then pay, then book).

-- Which provider took this purchase: NULL or 'stripe' (everything before this migration) | 'whop'.
-- The existing columns hold the provider's own references, so markPassPaid stays idempotent on one unique key:
--   stripe_session_id      Stripe Checkout Session (cs_…)  | Whop checkout configuration (ch_…)
--   stripe_payment_intent  Stripe PaymentIntent (pi_…)     | Whop payment (pay_…), where a refund finds its purchase
--   checkout_url           Stripe Checkout URL              | Whop purchase_url
ALTER TABLE webinar_passes ADD COLUMN provider TEXT;

-- The short form a viewer fills in before paying for the Sprint (/sprint-start/:token). One row per
-- registration, overwritten on resubmit. Copied into deal_sprint_intake when the Sprint is paid.
CREATE TABLE deal_sprint_applications (
  reg_id          TEXT PRIMARY KEY,
  lead_id         TEXT NOT NULL,
  revenue         TEXT,
  ebitda          TEXT,
  industry        TEXT,
  locations       TEXT,
  buy_what        TEXT,
  timeline        TEXT,
  financials_url  TEXT,
  pass_id         TEXT,                 -- the paid Sprint it was copied into
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_dsa_lead ON deal_sprint_applications(lead_id, updated_at);
