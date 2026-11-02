-- Rooms: how a webinar's audience receives the stage. NULL follows the ROOM_BROADCAST setting (auto by default);
-- 'auto' | 'sfu' | 'moq' override it for this room (Funnel HQ → Rooms). Hosts and people on stage always use the
-- SFU; MoQ (Cloudflare's Media over QUIC relay) only carries the composited stage to viewers.
ALTER TABLE rooms ADD COLUMN broadcast TEXT;
