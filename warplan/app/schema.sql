-- Warplan schema. Apply with: npm run db:schema
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'standard',
  max_territories INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
INSERT OR IGNORE INTO accounts (id, name, plan, max_territories, created_at) VALUES (1, 'Warplan HQ', 'admin', 999, datetime('now'));

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'member',
  is_admin INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  session_epoch INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

-- Conversations with the AI agents (Josh, the seller simulator, ...).
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  agent TEXT NOT NULL,
  title TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS threads_user ON threads (user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,              -- user | assistant
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages (thread_id, id);

-- ------------------------------------------------------------------ v2: pipeline, documents, integrations, usage
-- Team invites (owners create a link; the invitee picks a password).
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by INTEGER,
  accepted_at TEXT
);

-- Bring-your-own provider keys, encrypted with AES-GCM (key derived from KEYS_SECRET). Never sent back to a browser.
CREATE TABLE IF NOT EXISTS account_keys (
  account_id INTEGER NOT NULL,
  provider TEXT NOT NULL,            -- anthropic | elevenlabs
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  hint TEXT NOT NULL DEFAULT '',     -- last 4 characters, for display
  meta TEXT NOT NULL DEFAULT '{}',   -- non-secret settings (e.g. ElevenLabs voice id, model)
  created_by INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- Acquisition targets: the deal pipeline.
CREATE TABLE IF NOT EXISTS targets (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  created_by INTEGER,
  name TEXT NOT NULL,
  industry TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  owner_name TEXT NOT NULL DEFAULT '',
  owner_age INTEGER,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  employees INTEGER,
  revenue REAL,
  ebitda REAL,
  asking REAL,
  currency TEXT NOT NULL DEFAULT '$',
  stage TEXT NOT NULL DEFAULT 'sourced',
  priority INTEGER NOT NULL DEFAULT 2,  -- 1 high, 2 normal, 3 low
  source TEXT NOT NULL DEFAULT '',
  motivation TEXT NOT NULL DEFAULT '',
  next_action TEXT NOT NULL DEFAULT '',
  next_date TEXT,
  deal TEXT,                            -- Deal Builder structure (JSON) for this target
  tags TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stage_at TEXT
);
CREATE INDEX IF NOT EXISTS targets_acct ON targets (account_id, stage, updated_at DESC);

-- Timeline per target: notes, calls, stage changes, generated documents.
CREATE TABLE IF NOT EXISTS target_events (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER,
  user_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                   -- note | call | stage | doc | email | meeting
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS target_events_t ON target_events (target_id, id DESC);

-- Documents the agents write (LOI, outreach, diligence, board pack, 100-day plan), editable afterwards.
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS documents_acct ON documents (account_id, id DESC);
CREATE INDEX IF NOT EXISTS documents_target ON documents (target_id, id DESC);

-- AI usage per call, for the usage page, platform limits and cost control.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  own_key INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_acct ON usage (account_id, created_at);

-- Outgoing webhooks: POST signed JSON to the customer's own systems (Zapier, Make, a CRM) on events.
CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '*',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_status INTEGER,
  last_at TEXT
);

-- Per-user saved state (Deal Builder, Value Ladder), so it follows you across devices.
CREATE TABLE IF NOT EXISTS user_state (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ------------------------------------------------------------------ v3: agents act
-- Approve-before-act inbox: actions agents propose (autopilot, external agents); a person approves or dismisses.
CREATE TABLE IF NOT EXISTS agent_actions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  tool TEXT NOT NULL,
  input TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'autopilot',
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | done | dismissed | failed
  result TEXT,
  dedupe TEXT,
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_actions_acct ON agent_actions (account_id, status, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_actions_dedupe ON agent_actions (account_id, dedupe) WHERE status = 'pending';

-- Workspace settings (autopilot on/off, ...).
CREATE TABLE IF NOT EXISTS settings (
  account_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, key)
);

-- ------------------------------------------------------------------ v4: scout, contacts, email
-- Contacts found for a target (website scan, Hunter, registry, typed in).
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- email | phone | pattern
  value TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'medium',  -- high | medium | guess
  created_at TEXT NOT NULL,
  UNIQUE (target_id, kind, value)
);
CREATE INDEX IF NOT EXISTS contacts_target ON contacts (target_id);

-- Each user's own sending mailbox (SMTP, e.g. Gmail with an app password). Password encrypted like account keys.
CREATE TABLE IF NOT EXISTS mailboxes (
  user_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  from_name TEXT NOT NULL DEFAULT '',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  signature TEXT NOT NULL DEFAULT '',
  postal_address TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 40,
  verified_at TEXT,
  updated_at TEXT NOT NULL
);

-- Every email sent from Warplan.
CREATE TABLE IF NOT EXISTS sent_emails (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  target_id INTEGER,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,            -- sent | failed
  error TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sent_emails_user ON sent_emails (user_id, created_at);
CREATE INDEX IF NOT EXISTS sent_emails_target ON sent_emails (target_id, id DESC);

-- People who asked not to be contacted. Checked before every send.
CREATE TABLE IF NOT EXISTS suppressions (
  account_id INTEGER NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, email)
);

-- v5: Monid data marketplace runs, sequencer pushes and replies, power dialer calls.
-- Every paid Monid run, so spend can be capped per workspace per month and shown in Usage.
CREATE TABLE IF NOT EXISTS monid_runs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  target_id INTEGER,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  run_id TEXT,
  status TEXT NOT NULL,            -- COMPLETED | RUNNING | FAILED | ...
  cost REAL NOT NULL DEFAULT 0,    -- USD, as Monid billed it
  purpose TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS monid_runs_acct ON monid_runs (account_id, created_at);

-- Leads pushed to a cold-email sequencer (Instantly, Smartlead, EmailBison).
CREATE TABLE IF NOT EXISTS campaign_leads (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  campaign_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL,
  status TEXT NOT NULL,            -- pushed | failed | replied
  error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (account_id, provider, campaign_id, email)
);
CREATE INDEX IF NOT EXISTS campaign_leads_target ON campaign_leads (target_id);

-- Replies that came back from sequencers (webhook), with the AI's read of them.
CREATE TABLE IF NOT EXISTS replies (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  provider TEXT NOT NULL DEFAULT '',
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',   -- interested | meeting | later | not_interested | ooo | unsubscribe | wrong_person | other
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS replies_acct ON replies (account_id, id DESC);

-- Power dialer: every call placed or logged.
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  target_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'phone',   -- phone (tel: link) | twilio
  call_sid TEXT,
  disposition TEXT NOT NULL DEFAULT '', -- connected | interested | meeting | callback | voicemail | no_answer | not_interested | wrong_number | gatekeeper
  notes TEXT NOT NULL DEFAULT '',
  duration INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS calls_target ON calls (target_id, id DESC);
CREATE INDEX IF NOT EXISTS calls_user ON calls (user_id, created_at);

-- v6: indexes for scale (account-wide feeds, reply matching, webhook token lookups).
CREATE INDEX IF NOT EXISTS target_events_acct ON target_events (account_id, id DESC);
CREATE INDEX IF NOT EXISTS contacts_acct_value ON contacts (account_id, value);
CREATE INDEX IF NOT EXISTS campaign_leads_acct_email ON campaign_leads (account_id, email);
CREATE INDEX IF NOT EXISTS calls_acct ON calls (account_id, id DESC);
CREATE INDEX IF NOT EXISTS sent_emails_acct ON sent_emails (account_id, id DESC);
CREATE INDEX IF NOT EXISTS settings_reply_hook ON settings (json_extract(data, '$.hash')) WHERE key = 'reply_hook';
CREATE INDEX IF NOT EXISTS settings_phone_hook ON settings (json_extract(data, '$.hook_hash')) WHERE key = 'phone';

-- v6: failed sign-in attempts, for rate limiting (per email and per IP, 15-minute window).
CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts (key, created_at);

-- v7: research dossier per target (AI read of Google profile, reviews, website, news) with a seller-readiness score.
CREATE TABLE IF NOT EXISTS target_intel (
  target_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  score INTEGER,                 -- 0-100 seller readiness
  data TEXT NOT NULL,            -- JSON: signals, size estimate, hooks, sources
  cost REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS target_intel_acct ON target_intel (account_id, score DESC);

-- v7: long-running Monid jobs finished in the background (meeting recordings, AI calls).
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  target_id INTEGER,
  kind TEXT NOT NULL,            -- meeting | ai_call
  run_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',  -- running | done | failed
  meta TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_open ON jobs (status, id);
CREATE INDEX IF NOT EXISTS jobs_acct ON jobs (account_id, id DESC);
CREATE INDEX IF NOT EXISTS settings_imessage_hook ON settings (json_extract(data, '$.hash')) WHERE key = 'imessage';

-- v9: iMessage Private API ("typing…" from the other side, set by the BlueBubbles typing-indicator webhook).
CREATE TABLE IF NOT EXISTS imessage_live (
  account_id INTEGER NOT NULL,
  chat TEXT NOT NULL,
  typing INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, chat)
);

-- v10: power dialer engine. Every dial (browser, bridge or your own phone) is an attempt: it drives the
-- 3-per-number-per-day cap, caller-ID rotation, "best time to call" and number-health stats.
CREATE TABLE IF NOT EXISTS dial_attempts (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  target_id INTEGER,
  e164 TEXT NOT NULL,
  caller_id TEXT,
  via TEXT NOT NULL DEFAULT 'phone',  -- browser | twilio | phone
  session_id INTEGER,
  local_hour INTEGER,
  local_dow INTEGER,
  answered INTEGER,                   -- 1 spoke to someone, 0 not, NULL unknown yet
  disposition TEXT,
  duration INTEGER,
  call_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS dial_attempts_num ON dial_attempts (account_id, e164, created_at);
CREATE INDEX IF NOT EXISTS dial_attempts_acct ON dial_attempts (account_id, created_at);
CREATE INDEX IF NOT EXISTS dial_attempts_caller ON dial_attempts (account_id, caller_id, created_at);
CREATE TABLE IF NOT EXISTS callbacks (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER,
  due_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  done_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS callbacks_due ON callbacks (account_id, done_at, due_at);
CREATE TABLE IF NOT EXISTS dialer_locks (
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  until TEXT NOT NULL,
  PRIMARY KEY (account_id, target_id)
);
CREATE TABLE IF NOT EXISTS dial_sessions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  started_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS dial_sessions_acct ON dial_sessions (account_id, last_seen);
CREATE TABLE IF NOT EXISTS phone_info (
  account_id INTEGER NOT NULL,
  e164 TEXT NOT NULL,
  valid INTEGER,
  line_type TEXT,                     -- mobile | landline | fixedVoip | nonFixedVoip | tollFree | ...
  carrier TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (account_id, e164)
);

-- v11: files Warplan makes for a deal (Excel models from the Deal Lab), served behind the session.
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  created_by INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_target ON files (account_id, target_id, id DESC);
-- Registry lookups (ABN Lookup, Companies House): who legally owns the business and since when.
CREATE TABLE IF NOT EXISTS target_registry (
  target_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- v12: recorded calls (opt-in, announced) and the AI notes written from them.
CREATE TABLE IF NOT EXISTS call_recordings (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER,
  target_id INTEGER,
  call_sid TEXT NOT NULL,
  recording_sid TEXT,
  recording_url TEXT,
  phone TEXT,
  duration INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',  -- transcribing | done | failed
  transcript TEXT,
  summary TEXT,                            -- JSON: summary, outcome, next_step, callback_when, notes, owner_facts, objections, sentiment
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, call_sid)
);
CREATE INDEX IF NOT EXISTS call_recordings_target ON call_recordings (account_id, target_id, id DESC);

-- v13: seller-signal watch. The last copy of each watched page, and the signals found when it changed.
CREATE TABLE IF NOT EXISTS watch_pages (
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  text TEXT,
  text_hash TEXT,
  checked_at TEXT,
  changed_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, target_id, url)
);
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,          -- for_sale | retirement | farewell | hiring_manager | reduced_hours | closing | owner_gone | new_owner
  strength INTEGER NOT NULL,   -- 3 act now … 1 worth a look; -1 probably already sold
  title TEXT NOT NULL,
  snippet TEXT NOT NULL DEFAULT '',
  url TEXT,
  first_look INTEGER NOT NULL DEFAULT 0,  -- found on the first read (already on the site), not a change
  seen_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS signals_acct ON signals (account_id, id DESC);
CREATE INDEX IF NOT EXISTS signals_target ON signals (account_id, target_id, kind, created_at);

-- v14: C1/C2 hub. The board, the professional bench and the lender matrix (JL skill: Capabilities and Capital).
CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- board | bench | lender
  role TEXT NOT NULL DEFAULT '',      -- board: chair | finance | legal | sector; bench: accountant | lawyer | sme; lender: bank type
  name TEXT NOT NULL,
  firm TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  linkedin TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'prospect',
  equity_pct REAL,                    -- board: founders' equity offered
  terms TEXT NOT NULL DEFAULT '{}',   -- JSON: lender matrix fields; bench fee terms; board vesting, bio
  notes TEXT NOT NULL DEFAULT '',
  last_contact TEXT,
  next_date TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relationships_acct ON relationships (account_id, kind, status);
-- A deal sent to a lender, and where it stands.
CREATE TABLE IF NOT EXISTS financing (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  relationship_id INTEGER NOT NULL,
  stage TEXT NOT NULL DEFAULT 'sent',  -- sent | term_sheet | credit | approved | declined
  amount REAL,
  terms TEXT NOT NULL DEFAULT '{}',    -- JSON: rate, years, dscr, pg, security, notes from the term sheet
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, target_id, relationship_id)
);
CREATE INDEX IF NOT EXISTS financing_target ON financing (account_id, target_id);

-- v15: the deal room. One per target: milestones of the five-step deal flow, the seller's upload link, and one
-- checklist table for the qualification gate, the diligence log, conditions precedent, settlement and 100 days.
CREATE TABLE IF NOT EXISTS deal_rooms (
  target_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  token_hash TEXT,                     -- sha256 of the seller's link token
  token_hint TEXT,
  link_on INTEGER NOT NULL DEFAULT 0,
  seller_name TEXT,
  nda_at TEXT, nda_name TEXT, nda_ip TEXT,
  first_contact TEXT,
  offer_at TEXT, offer_price REAL, offer_kind TEXT, offer_terms TEXT,
  loi_signed_at TEXT, exclusivity_days INTEGER,
  dd_start TEXT, contract_start TEXT, settled_at TEXT, final_price REAL,
  budget_fees REAL, spent_fees REAL,
  seller_seen_at TEXT, seller_views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS deal_rooms_token ON deal_rooms (token_hash);
CREATE TABLE IF NOT EXISTS deal_items (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  list TEXT NOT NULL,                  -- gate | dd | cp | close | plan
  section TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | requested | received | done | issue | na
  severity TEXT,                       -- high | medium | low (diligence issues, from the red flag matrix)
  action TEXT,
  seller INTEGER NOT NULL DEFAULT 0,   -- the seller sees it on their link
  upload INTEGER NOT NULL DEFAULT 0,   -- and can upload to it
  owner TEXT NOT NULL DEFAULT '',
  due_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deal_items_target ON deal_items (account_id, target_id, list, sort);
-- Files larger than one D1 row are stored in chunks; files.data then holds nothing and files.chunks the count.
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  data BLOB NOT NULL,
  PRIMARY KEY (file_id, n)
);
-- Which checklist item a deal-room file answers, who sent it, and how many chunks it's stored in (0 = in files.data).
CREATE TABLE IF NOT EXISTS room_files (
  file_id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  item_id INTEGER,
  source TEXT NOT NULL DEFAULT 'team',  -- team | seller
  chunks INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS room_files_target ON room_files (account_id, target_id);
-- v16: multi-layer agent runs. One row per run, one per layer it ran, and the findings it raised (alerts a monitor
-- keeps open while the problem persists and resolves when it's gone).
CREATE TABLE IF NOT EXISTS agent_runs (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  agent TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',   -- queued | running | done | failed
  step INTEGER NOT NULL DEFAULT 0,
  input TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',
  summary TEXT,
  error TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_account ON agent_runs (account_id, id DESC);
CREATE INDEX IF NOT EXISTS agent_runs_target ON agent_runs (account_id, agent, target_id, status);
CREATE TABLE IF NOT EXISTS agent_steps (
  run_id INTEGER NOT NULL,
  n INTEGER NOT NULL,
  layer TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running',
  summary TEXT,
  data TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, n)
);
CREATE TABLE IF NOT EXISTS agent_findings (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,
  agent TEXT NOT NULL,
  run_id INTEGER,
  severity TEXT NOT NULL DEFAULT 'medium',
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  metric TEXT,
  dedupe TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- open | resolved | dismissed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_findings_open ON agent_findings (account_id, dedupe) WHERE status = 'open' AND dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_findings_list ON agent_findings (account_id, status, target_id);
-- v17: monthly actuals for businesses you own (typed in, or imported by an agent from an uploaded P&L), and
-- snapshots of staff and customer lists so the retention agent can compare today with the day you bought it.
CREATE TABLE IF NOT EXISTS actuals (
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  period TEXT NOT NULL,                -- YYYY-MM
  revenue REAL, gross_profit REAL, wages REAL, ebitda REAL,
  cash REAL, receivables REAL, payables REAL, debt_service REAL, headcount INTEGER, customers INTEGER,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | file:<id>
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, target_id, period)
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                  -- staff | customers
  taken_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL                   -- JSON list
);
CREATE INDEX IF NOT EXISTS snapshots_target ON snapshots (account_id, target_id, kind, taken_at);
-- v18: board candidates the Board Scout found (LinkedIn), waiting for you to add or dismiss.
CREATE TABLE IF NOT EXISTS board_suggestions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  seat TEXT NOT NULL,                  -- chair | finance | legal | sector
  name TEXT NOT NULL,
  headline TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  firm TEXT NOT NULL DEFAULT '',
  score INTEGER NOT NULL DEFAULT 0,
  why TEXT NOT NULL DEFAULT '[]',      -- JSON list of scored reasons
  credibility TEXT NOT NULL DEFAULT '',
  watch_out TEXT NOT NULL DEFAULT '',
  pitch TEXT NOT NULL DEFAULT '',
  roles TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'new',  -- new | added | dismissed
  run_id INTEGER,
  relationship_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, url)
);
CREATE INDEX IF NOT EXISTS board_suggestions_list ON board_suggestions (account_id, status, seat, score DESC);
-- v19: one row per signed-in session, so signing out ends exactly that session (security audit, Oct 2026).
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
-- v20: the densification map. Your sites with their service radius, the default radius for a business you'd buy,
-- and a shared cache of geocoded place names (public geography, so one cache serves every workspace).
CREATE TABLE IF NOT EXISTS territory_sites (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  target_id INTEGER,                 -- set when the site is a business bought through the pipeline
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  radius_km REAL NOT NULL DEFAULT 25,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS territory_sites_account ON territory_sites (account_id);
CREATE TABLE IF NOT EXISTS territory_prefs (
  account_id INTEGER PRIMARY KEY,
  radius_km REAL NOT NULL DEFAULT 25,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geocode_cache (
  q TEXT PRIMARY KEY,                -- normalised query
  results TEXT NOT NULL,             -- JSON [{label, lat, lng}], [] when nothing was found
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS geocode_log (account_id INTEGER NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS geocode_log_at ON geocode_log (at);
-- v21: prospecting bots. Find the businesses you'd buy in an area, email the owner directly, follow up daily up to a
-- cap, then hand them to you to call. See src/bots.js.
CREATE TABLE IF NOT EXISTS bots (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,             -- sends from this person's connected mailbox
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'paused', -- active | paused
  mode TEXT NOT NULL DEFAULT 'review',  -- review (Inbox approval) | autopilot (sends on its own)
  industry TEXT NOT NULL,
  areas TEXT NOT NULL DEFAULT '[]',     -- JSON list of areas it rotates through
  buying TEXT NOT NULL DEFAULT '',      -- what you're looking to buy, as it reads in the email
  sender_name TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  daily_new INTEGER NOT NULL DEFAULT 10,
  touches INTEGER NOT NULL DEFAULT 6,   -- emails per prospect before it moves to the call list
  gap_days INTEGER NOT NULL DEFAULT 1,
  send_hour INTEGER NOT NULL DEFAULT 9,
  timezone TEXT NOT NULL DEFAULT 'Australia/Melbourne',
  owner_emails INTEGER NOT NULL DEFAULT 1, -- look up the owner's own email (paid data) before falling back to the front desk
  templates TEXT NOT NULL DEFAULT '{}',
  cursor TEXT NOT NULL DEFAULT '{}',    -- where the search left off, per area
  last_run_on TEXT,                     -- local date of the last daily run
  kind TEXT NOT NULL DEFAULT 'buy',
  sell TEXT NOT NULL DEFAULT '{}',
  buyers TEXT NOT NULL DEFAULT '{}',
  lock_until TEXT,                      -- a run in progress (so two can't overlap)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bots_account ON bots (account_id);
CREATE TABLE IF NOT EXISTS bot_prospects (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  email_kind TEXT NOT NULL DEFAULT '',  -- owner | decision_maker | front_desk
  status TEXT NOT NULL DEFAULT 'active', -- active | replied | opted_out | bounced | call | no_email | removed
  step INTEGER NOT NULL DEFAULT 0,      -- emails sent
  next_at TEXT,
  subject TEXT NOT NULL DEFAULT '',
  thread_id TEXT NOT NULL DEFAULT '',   -- Message-ID of the first email, for threading follow-ups
  action_id INTEGER,                    -- review mode: the Inbox proposal for the latest email
  score INTEGER NOT NULL DEFAULT 0,
  signals TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, target_id)
);
CREATE INDEX IF NOT EXISTS bot_prospects_due ON bot_prospects (bot_id, status, next_at);
CREATE TABLE IF NOT EXISTS bot_log (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  target_id INTEGER,
  kind TEXT NOT NULL,                   -- found | sent | follow_up | queued | replied | call | skipped | error | run
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_log_bot ON bot_log (bot_id, id DESC);
-- v22: sell-side bots (shop a business to the buyers directory) and 30/60-day flows.
CREATE TABLE IF NOT EXISTS sell_prospects (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL,
  bot_id INTEGER NOT NULL,
  fund_id TEXT NOT NULL,                -- id in the buyers directory (src/data/funds.js)
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active | replied | opted_out | bounced | no_email | removed | finished
  step INTEGER NOT NULL DEFAULT 0,
  next_at TEXT,
  subject TEXT NOT NULL DEFAULT '',
  action_id INTEGER,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (bot_id, fund_id)
);
CREATE INDEX IF NOT EXISTS sell_prospects_due ON sell_prospects (bot_id, status, next_at);
CREATE INDEX IF NOT EXISTS sell_prospects_account ON sell_prospects (account_id, fund_id);
CREATE TABLE IF NOT EXISTS fund_contacts (  -- shared: what each fund's own website lists (public)
  fund_id TEXT PRIMARY KEY,
  emails TEXT NOT NULL DEFAULT '[]',
  checked_at TEXT NOT NULL
);
-- Bots saved with the first, softer copy go back to the new direct defaults.

