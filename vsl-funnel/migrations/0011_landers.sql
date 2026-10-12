-- Industry landers: which one each session landed on, and which ones a lead saw (first + last).
ALTER TABLE sessions ADD COLUMN lander TEXT;
ALTER TABLE leads ADD COLUMN lander TEXT;
ALTER TABLE leads ADD COLUMN ft_lander TEXT;
CREATE INDEX idx_sessions_lander ON sessions(lander, started_at);
CREATE INDEX idx_leads_ft_lander ON leads(ft_lander);
