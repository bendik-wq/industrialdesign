-- Deal + qualification markers on every lead, and a payments ledger for cash collected.
ALTER TABLE leads ADD COLUMN industry TEXT;
ALTER TABLE leads ADD COLUMN revenue_band TEXT;          -- normalised: <100k | 100k-1m | 1m-5m | 5m-20m | 20m+
ALTER TABLE leads ADD COLUMN budget_band TEXT;           -- what they said they'd invest in advisory
ALTER TABLE leads ADD COLUMN willing_to_invest TEXT;     -- yes | no | unknown
ALTER TABLE leads ADD COLUMN qual_source TEXT;           -- application | calendly
ALTER TABLE leads ADD COLUMN qual_flags TEXT;            -- JSON array of notable signals
ALTER TABLE leads ADD COLUMN temperature TEXT;           -- hot | warm | cold
ALTER TABLE leads ADD COLUMN objection TEXT;             -- main objection heard on the call
ALTER TABLE leads ADD COLUMN follow_up_at INTEGER;
ALTER TABLE leads ADD COLUMN decision_maker INTEGER;     -- 1 yes, 0 no
ALTER TABLE leads ADD COLUMN fit_rating INTEGER;         -- 1–5, the closer's read after the call
ALTER TABLE leads ADD COLUMN offer TEXT;                 -- what they bought
ALTER TABLE leads ADD COLUMN payment_plan TEXT;          -- pif | split | monthly | custom
ALTER TABLE leads ADD COLUMN installments_total INTEGER;
ALTER TABLE leads ADD COLUMN next_payment_at INTEGER;
ALTER TABLE leads ADD COLUMN contract_signed_at INTEGER;
ALTER TABLE leads ADD COLUMN refunded_at INTEGER;
ALTER TABLE leads ADD COLUMN refund_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN loi_signed_at INTEGER;      -- the promise: signed LOI within 90 days
ALTER TABLE leads ADD COLUMN target_business TEXT;

CREATE TABLE payments (
  id         TEXT PRIMARY KEY,
  lead_id    TEXT NOT NULL,
  amount     REAL NOT NULL,                 -- negative = refund
  paid_at    INTEGER NOT NULL,
  method     TEXT,                          -- stripe | bank | card | other
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_payments_lead ON payments(lead_id);
CREATE INDEX idx_payments_paid ON payments(paid_at);
