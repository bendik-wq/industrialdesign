-- Deep-funnel conversion signals to Meta (overnight loop, round 2, "signals"). Additive only.
-- One row per signal per person per session (live event, auto-webinar session, challenge cohort or cohort day):
-- the key keeps each signal to one Conversions API event, whichever cron run or retry got there first.
CREATE TABLE IF NOT EXISTS meta_signals (
  key         TEXT PRIMARY KEY,               -- signal:funnel:session_ref:lead_id
  signal      TEXT NOT NULL,                  -- watched_30m | stayed_for_pitch | offer_opened | checkout_started | application_submitted | contract_signed
  funnel      TEXT NOT NULL,                  -- auto | live | challenge
  session_ref TEXT NOT NULL,                  -- webinar session id / live event id / challenge cohort (or cohort day)
  lead_id     TEXT NOT NULL,
  reg_id      TEXT,
  event_id    TEXT NOT NULL,                  -- the Conversions API event_id (deterministic, so retries de-duplicate)
  product     TEXT,                           -- checkout and offer signals: deposit | sprint | vip
  value       REAL,                           -- what was sent as value (NULL = no value sent)
  currency    TEXT,
  estimate    INTEGER NOT NULL DEFAULT 0,     -- 1 = the value is an estimate (META_SIGNAL_VALUES), 0 = real (contract value) or none
  basis       TEXT,                           -- where the value came from
  status      TEXT NOT NULL,                  -- sent | no_consent
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_signals_signal ON meta_signals(signal, sent_at);
CREATE INDEX IF NOT EXISTS idx_meta_signals_lead ON meta_signals(lead_id);
