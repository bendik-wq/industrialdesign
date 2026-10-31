-- AI phone calls for the automated webinar, the live Zoom webinar and the 5-day challenge
-- (src/integrations/webinar-calls.ts). They reuse the outbound_calls queue (kinds w_*), so the
-- global daily cap, the dialler, the post-call webhook and the Voice tab's queue all cover them.
ALTER TABLE outbound_calls ADD COLUMN wc_ref TEXT;        -- what the call is about: auto:<reg id> | live:<reg id> | ch:<reg id>:<day> | pass:<id> | vip:<order id>
ALTER TABLE outbound_calls ADD COLUMN wc_meta TEXT;       -- JSON: left_at, minute, offer_unlocked (left-mid-session calls)
ALTER TABLE outbound_calls ADD COLUMN wc_dialed_at INTEGER; -- when the number was actually dialled (per-person daily and weekly caps)
CREATE INDEX idx_outbound_wc ON outbound_calls(lead_id, kind, wc_ref);
CREATE INDEX idx_outbound_dialed ON outbound_calls(wc_dialed_at);
