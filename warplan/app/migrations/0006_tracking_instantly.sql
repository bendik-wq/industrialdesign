-- Open/click tracking and Instantly delivery for bots (schema v24). Each ALTER runs once.
ALTER TABLE bots ADD COLUMN delivery TEXT NOT NULL DEFAULT 'direct';   -- direct (Warplan sends) | instantly
ALTER TABLE bots ADD COLUMN track_opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN track_clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bots ADD COLUMN ext_campaign TEXT NOT NULL DEFAULT '{}';  -- Instantly campaign ids, per email set
ALTER TABLE bot_prospects ADD COLUMN opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_prospects ADD COLUMN clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bot_prospects ADD COLUMN last_open TEXT;
ALTER TABLE bot_prospects ADD COLUMN hot INTEGER NOT NULL DEFAULT 0;  -- a call task was raised for heavy opening
ALTER TABLE sell_prospects ADD COLUMN opens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sell_prospects ADD COLUMN clicks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sell_prospects ADD COLUMN last_open TEXT;
ALTER TABLE sell_prospects ADD COLUMN hot INTEGER NOT NULL DEFAULT 0;
