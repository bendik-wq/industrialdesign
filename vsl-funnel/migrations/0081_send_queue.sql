-- Cloudflare platform round, builder A: the send queue (Queues) and the live reminder workflow (Workflows).
-- Additive only. Both features are off by default (settings SEND_VIA_QUEUE, LIVE_REMINDERS_VIA_WORKFLOW).

-- One row per job handed to the `gl-send` queue (src/infra/queue.ts): the dedupe key (kind:id), its state and
-- retries, so the cron never queues the same row twice and Funnel HQ → Errors & cron can show sent, failed,
-- retried and dead-lettered counts. `payload` is kept only while a job can still be retried.
CREATE TABLE IF NOT EXISTS send_jobs (
  key         TEXT PRIMARY KEY,            -- email:<id> | sms:<id> | call:<id> | track:<event id>
  kind        TEXT NOT NULL,               -- email | sms | call | track
  ref         TEXT NOT NULL,               -- the row id (emails, sms_messages, outbound_calls) or the event id
  state       TEXT NOT NULL,               -- queued | done | later | failed | dlq
  attempts    INTEGER NOT NULL DEFAULT 0,  -- consumer runs that ended in a retry
  last_error  TEXT,
  payload     TEXT,                        -- the message body (JSON), for the DLQ retry button
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  done_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_send_jobs_kind_state ON send_jobs(kind, state, updated_at);
CREATE INDEX IF NOT EXISTS idx_send_jobs_state ON send_jobs(state, updated_at);

-- One row per registration driven by a LiveReminderWorkflow instance (instance id = registration id). The
-- workflow writes a heartbeat at every step; the cron skips a registration only while its heartbeat is fresh.
CREATE TABLE IF NOT EXISTS live_reminder_flows (
  reg_id        TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL,
  status        TEXT NOT NULL,             -- running | done | stopped | failed
  reason        TEXT,                      -- why it finished, or the last error
  steps         INTEGER NOT NULL DEFAULT 0,
  sent          INTEGER NOT NULL DEFAULT 0,
  next_wake_at  INTEGER,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_live_reminder_flows_event ON live_reminder_flows(event_id, status);
