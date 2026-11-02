-- Funnel HQ speed (overnight loop round 2, "deliverability + speed"). Indexes only, additive.
-- Measured on the seeded local DB (scripts/d1-perf.mjs volume, no ANALYZE stats for the new indexes, as on D1):
-- attribution "people" 260 ms -> 2 ms, stage money 2.5 -> 1.3 ms, Emails tab template stats 72 -> 12 ms.
-- attr_conversions by registration (people list, stage money, cohort revenue): was a full scan per row.
CREATE INDEX IF NOT EXISTS idx_attr_conv_reg ON attr_conversions(reg_id, kind);
-- "Did this registrant reach stage X" (EXISTS … reg_id = ? AND stage = ?) in cohorts, revenue and rooms: an exact
-- two-column match, so the planner can't pick a worse single-column index when the table has no statistics.
CREATE INDEX IF NOT EXISTS idx_attr_stages_reg_stage ON attr_stages(reg_id, stage);
-- Emails tab: per-template stats filter on created_at (was a full scan of emails).
CREATE INDEX IF NOT EXISTS idx_emails_created ON emails(created_at);
