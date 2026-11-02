-- Payment links via Whop (src/sales/paylinks.ts): the real deadline a purchase is sold under, the room push it
-- came from, and the cached Whop checkout session (checkout configuration) per purchase.

-- The deadline the pay page counts down to and enforces (offer close, replay close or the push's price hold);
-- NULL = no real deadline, so no timer is shown.
ALTER TABLE webinar_passes ADD COLUMN deadline_at INTEGER;
ALTER TABLE webinar_passes ADD COLUMN deadline_reason TEXT;      -- 'offer' | 'replay' | 'hold'
ALTER TABLE webinar_passes ADD COLUMN push_id INTEGER;           -- room_pushes.id the buyer pressed (room cards)
ALTER TABLE webinar_passes ADD COLUMN whop_plan_id TEXT;         -- the inline plan Whop made for the cached checkout
ALTER TABLE webinar_passes ADD COLUMN checkout_expires_at INTEGER; -- the cached Whop checkout is reused until then

-- A push's price hold (Funnel HQ → Rooms, per room, default off): the card's price holds until this moment and
-- the server refuses its checkout after it. NULL = no hold.
ALTER TABLE room_pushes ADD COLUMN hold_until INTEGER;
