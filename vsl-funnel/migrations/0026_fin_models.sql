-- Funnel HQ financial model: saved scenarios (inputs only; the maths runs in the dashboard).
CREATE TABLE fin_models (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  data       TEXT NOT NULL,              -- JSON inputs { shared, vsl, webinar }
  updated_at INTEGER NOT NULL
);
