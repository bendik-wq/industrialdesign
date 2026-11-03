-- Ads round 2 (additive only): hook rate and hold rate per video ad, concept rounds per industry (tagged with the
-- industry lander so spend routes through the smart route), and halo retargeting rounds.

-- Video metrics per ad per day from Meta insights (null for ads without video):
--   video_3s  = 3-second video views (actions[video_view]); hook rate = video_3s / impressions
--   thruplays = ThruPlays (video_thruplay_watched_actions); hold rate = thruplays / video_3s
--   video_p50 = plays watched to 50% (video_p50_watched_actions)
ALTER TABLE ad_insights ADD COLUMN video_3s INTEGER;
ALTER TABLE ad_insights ADD COLUMN thruplays INTEGER;
ALTER TABLE ad_insights ADD COLUMN video_p50 INTEGER;

-- The video an ad's creative uses (for the "watched 50% of an ad video" engagement audience).
ALTER TABLE ad_entities ADD COLUMN video_id TEXT;

-- Concept rounds per industry: the industry id (src/landers/catalog.ts) and the link the ads point at (/m?ind=…).
ALTER TABLE ads_concept_rounds ADD COLUMN industry TEXT;
ALTER TABLE ads_concept_rounds ADD COLUMN link TEXT;
-- Halo retargeting rounds: the engaged state the round is written for (src/audiences/halo.ts).
ALTER TABLE ads_concept_rounds ADD COLUMN halo TEXT;
