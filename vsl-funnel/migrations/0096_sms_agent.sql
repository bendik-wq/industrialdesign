-- AI texting agent (src/integrations/sms-agent.ts): replies to a lead's texts by SMS.
-- Per-lead state in its own table (leads is at D1's 100-column limit). paused_at set = no AI replies: the agent handed the
-- thread to the team, or the team paused it in Funnel HQ.
CREATE TABLE IF NOT EXISTS sms_agent_state (
  lead_id    TEXT PRIMARY KEY,
  paused_at  INTEGER,
  paused_by  TEXT,      -- 'agent' (handoff) | 'team' (Funnel HQ)
  reason     TEXT,
  updated_at INTEGER NOT NULL
);
-- The lead's text thread and the agent's daily caps.
CREATE INDEX IF NOT EXISTS idx_sms_lead_created ON sms_messages(lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_sms_template_created ON sms_messages(template, created_at);
