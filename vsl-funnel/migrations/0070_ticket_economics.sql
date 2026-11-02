-- Front-end economics (overnight loop round 2): which ticket funnel an ad campaign feeds, when the owner sets it
-- by hand in Funnel HQ → Financial model. Without a row the campaign is matched from the registrations it brought
-- (utm / campaign id on the registration's touches), then from its name. funnel: auto | live | challenge | none.
-- The one-click ticket add-on needs no table: it is a webinar_passes row with kind = 'addon'.
CREATE TABLE IF NOT EXISTS econ_campaigns (
  campaign_id TEXT PRIMARY KEY,
  funnel      TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
