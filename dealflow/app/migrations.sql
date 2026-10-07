-- v3: financials, AI outputs, inbound seller leads. Safe to run once on a v2 database.
ALTER TABLE companies ADD COLUMN industry TEXT;
ALTER TABLE companies ADD COLUMN fin_year INTEGER;
ALTER TABLE companies ADD COLUMN ebit REAL;
ALTER TABLE companies ADD COLUMN net_income REAL;
ALTER TABLE companies ADD COLUMN payroll REAL;
ALTER TABLE companies ADD COLUMN cash REAL;
ALTER TABLE companies ADD COLUMN equity REAL;
ALTER TABLE companies ADD COLUMN long_term_debt REAL;
ALTER TABLE companies ADD COLUMN valuation_mid REAL;
ALTER TABLE companies ADD COLUMN inbound INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS ai_outputs (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- brief | letter
  model TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (company_id, kind)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  name TEXT, email TEXT, phone TEXT,
  timeline TEXT, message TEXT,
  valuation_low REAL, valuation_high REAL, currency TEXT,
  created_at TEXT NOT NULL
);
