-- Paid masterclass products through Stripe Checkout: the front-end offer (default "Acquisition Assessment")
-- and, in required mode only, an optional paid seat.
-- One row per checkout attempt. A row becomes 'paid' exactly once (guarded on its Stripe session id),
-- so a webhook and the return-page check can both report the same payment without doubling anything.
CREATE TABLE webinar_passes (
  id                    TEXT PRIMARY KEY,
  reg_id                TEXT NOT NULL,            -- registration it was bought from
  lead_id               TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'offer',   -- offer (the front-end product) | seat (paid seat, required mode)
  product               TEXT,                     -- product name at the time of purchase
  status                TEXT NOT NULL DEFAULT 'pending', -- pending | paid | refunded | expired
  amount                INTEGER NOT NULL,         -- smallest currency unit (cents)
  currency              TEXT NOT NULL,            -- lower-case ISO code, as Stripe uses
  stripe_session_id     TEXT UNIQUE,
  stripe_payment_intent TEXT,
  checkout_url          TEXT,
  expires_at            INTEGER,                  -- when an unpaid checkout stops holding a weekly slot
  paid_at               INTEGER,
  refunded_at           INTEGER,
  refunded_amount       INTEGER NOT NULL DEFAULT 0,
  credit_amount         INTEGER NOT NULL DEFAULT 0, -- credited against the advisory engagement (same unit/currency)
  credit_used_contract  TEXT,                     -- the agreement the credit was applied to, once it is
  review_clicked_at     INTEGER,                  -- opened the assessment-session booking link
  review_booked_at      INTEGER,                  -- team marked the session as booked
  pack_viewed_at        INTEGER,                  -- opened their deal pack
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX idx_wp_reg ON webinar_passes(reg_id);
CREATE INDEX idx_wp_lead ON webinar_passes(lead_id, kind, status);
CREATE INDEX idx_wp_status ON webinar_passes(status, paid_at);
CREATE INDEX idx_wp_pi ON webinar_passes(stripe_payment_intent);

-- Per-registration replay window (offer holders keep the replay for 30 days instead of the global hours).
ALTER TABLE webinar_registrations ADD COLUMN replay_until INTEGER;
-- Registered while a paid seat was required: the room opens only once it is paid.
ALTER TABLE webinar_registrations ADD COLUMN pass_required INTEGER NOT NULL DEFAULT 0;

-- No column on leads: D1 caps a table at 100 columns and leads is there already. A lead "has bought"
-- when it has a paid row here (kind = 'offer'); that is the marker every report and page reads.
