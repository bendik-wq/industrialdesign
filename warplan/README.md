# Warplan

An AI acquisition team for owners of $1M+ businesses who grow by buying competitors with vendor finance
(the 3C model: Capabilities, Capital, Closing).

Live: https://warplan.bendik-50e.workers.dev (email login, invite-only)

A separate app from Dealflow (`../dealflow`), with its own Worker, D1 database (`warplan`) and design.

## What's in it

**Agents (all live except Scout)**
- **Ask Josh**: the AI version of Josh Li, built on his playbook (`app/src/playbook.js`), house rules and full video
  transcripts (cached in Claude's context; searched passages on Workers AI). Replies stream. Josh sees the user's
  profile, their live pipeline and the target a conversation is about, and pushes on stalled targets.
- **Seller Simulator**: practise first calls and deal talks with realistic owners, or with the owner of any target
  in your pipeline (the AI invents consistent hidden motives). Josh scores every call (stored, trended on Command).
- **Deal Desk**: letter of intent and investment memo from a target's own Deal Builder structure.
- **Outreach**: letter, email, cold-call script, voicemail, LinkedIn note, in any language.
- **Diligence**: paste a P&L; get normalised EBITDA (signs and totals reconciled in code), red flags, questions and
  the next document request.
- **Capital Desk**: lender pack with the request, weakest-year and bad-year DSCR, security and who to call.
- **AI Board**: monthly board minutes over the whole pipeline: pursue / pause / drop, what you're avoiding, actions.
- **Integrator**: 100-day plan with day-1 words for staff and customers.

**Agentic (v3)**
- **Josh acts**: tool use over one shared toolbelt (`app/src/tools.js`): search/read the pipeline, add and update
  targets, log calls, run the deal engine, have the specialist agents write documents. Receipts for every change show
  live in the chat and stay in the history. Claude runs a full multi-step loop; the Workers AI fallback runs up to four
  rounds and reports only what actually happened.
- **MCP server** at `/mcp` (Streamable HTTP, JSON responses; protocol 2025-03-26 / 2025-06-18 / 2025-11-25): Claude
  Code, Claude Desktop (via mcp-remote), Cursor, n8n and any MCP client get the same tools. Auth with an API token as
  `Authorization: Bearer wp_...`, or `/mcp/wp_...` for URL-only clients. Setup snippets in Settings → Connect.
- **Headless agent**: `POST /api/agent {text}` for Zapier, Make, Slack bots.
- **Autopilot + approve-before-act inbox**: a Cron Trigger (06:00 UTC) proposes follow-ups for quiet targets, first
  letters for new ones, flags overdue actions and queues the Monday AI Board review. Nothing runs until someone approves
  it in the Inbox; external agents can queue proposals with `POST /api/inbox`. The `briefing.daily` webhook carries
  the morning summary to Slack, email or a CRM.

**Scout + outreach (v4)**
- **Scout** (`app/src/scout.js`): Norway (Brønnøysund: owner + birth date, company email and phone, revenue,
  operating profit), France (Sirene: owners + birth years), UK (Companies House key), anywhere via Google Places (key)
  or OpenStreetMap (free). Tick results and add them to the pipeline in one go.
- **Contact finder** (`app/src/enrich.js`): reads each company's website (homepage + contact/about pages) for emails
  and phones (mailto, tel, protected and obfuscated addresses), recognises the owner's own address, learns the company's
  email pattern and domain for owner guesses (clearly marked), and uses Hunter when a key is connected.
- **Email from your own mailbox** (`app/src/mailer.js`): SMTP over Cloudflare TCP sockets (Gmail/Workspace app
  password on 465, Microsoft 365 on 587 with STARTTLS + AUTH LOGIN). Verified against Gmail and Outlook from Cloudflare's
  network. Every send checks the do-not-contact list and a daily cap, adds signature, opt-out line and postal address,
  and logs on the target's timeline. Agents can only queue emails; a person sends them from the Inbox.

**Tools**
- **Pipeline**: targets on a drag-and-drop board (or sortable table) from Sourced to Closed, next actions with due
  dates (overdue flagged on Command), a timeline of notes/calls (dictate by voice), CSV import and export.
- **Deal Builder**: any mix of vendor finance, bank debt, rollover, investors, own cash; verdict on the two rules
  (majority control, DSCR ≥ 1.5 every year), bad-year stress test, the most the stack can pay. Saves per target.
- **Value Ladder**: your company today vs after N acquisitions with the same structure.
- **Desk**: every document the agents wrote; edit (markdown), copy, download, print to PDF.
- **Command palette**: ⌘K / Ctrl+K (or `/`) searches targets, documents and conversations and runs commands.

**Platform**
- Workspaces with owners and members; invite links (`/join`), roles, removal.
- **Bring your own AI**: owners connect their own Anthropic key (and model) and ElevenLabs key/voice under
  Settings → Integrations. Keys are verified with the provider, encrypted with AES-GCM (key from `KEYS_SECRET`),
  never returned to a browser. Without them the workspace uses the platform's AI with a daily cap.
- **API tokens** (`wp_…`, shown once) and **signed webhooks** (HMAC-SHA256 over `timestamp.body`).
- **Usage**: every AI call metered per workspace (tokens, cache reads, estimated Claude cost); per-minute limits.
- Security: PBKDF2 passwords, signed sessions invalidated on password change, CSP, origin check on cookie writes,
  no secrets in the repo.

**v5: the deal-flow machine (scrape → enrich → email → call)**
- **Data (Monid)**: one key for 2,500+ data and scraping APIs. Scout gets a *Google Maps (Monid)* source that works anywhere (~$0.0002 per 20 businesses). The Data page searches the catalogue, shows each endpoint's price, builds the input form and runs it. Every run is logged with what it cost, stops at a monthly cap per workspace, and agent runs above the per-run auto-approve limit (or with a price that can't be known up front) wait in the Inbox.
- **Deep enrich**: website via Google Maps if missing → Hunter domain search → Apollo people search (free) + match to find the owner → Hunter email finder → verification → LinkedIn → mobile (Clay, only on request). An Apollo match only counts if the person's employer is on the target's domain. If no owner turns up, a general manager or MD is labelled *decision maker*, never *owner*. Typical cost: $0.04–0.07 per company.
- **Sequencers**: push targets into Instantly, Smartlead or EmailBison campaigns, from the target page, the pipeline (by stage) or an agent (with approval). Each push uses the owner's best real email (never a guess), skips opt-outs and writes a personal opening line (`{{personalization}}`).
- **Reply webhook**: one secret URL per workspace (`/hooks/replies/rh_…`). Each reply lands on the target's timeline. The AI sorts it, moves the target on and suppresses the address on an unsubscribe. For interested or meeting replies it also queues a drafted answer in the Inbox.
- **ListKit / Apollo / Clay CSVs**: the pipeline importer maps their person-level headers (first and last name, company domain, city/state/country, title, LinkedIn).
- **Power dialer** (`#/dialer`): a queue of every live target with a phone number, due callbacks first.
  - Calls go out via a `tel:` link, or through a Twilio bridge on the workspace's own account: Twilio rings you, then connects the owner, with no recording.
  - Includes a first-call script and objection handlers, plus notes and a timer.
  - Keys 1–9 set the outcome. Each outcome sets the next action and date, moves the stage forward and logs the call on the timeline.
  - Auto-dial is available with Twilio.
- **Agent tools** (Josh, MCP, REST): `deep_enrich`, `monid_discover`, `monid_inspect`, `monid_run`, `monid_result`, `data_budget`, `list_campaigns`, `push_to_campaign`, `call_queue`, `log_call`, 25 tools in total.
- **New webhook events**: `reply.received`, `campaign.pushed`, `call.logged`.

**v6: browser phone**
- **Phone button on every page**: a keypad, texting threads, recent calls and in-call controls (mute, keypad tones, hang up). Clicking any phone number in Warplan dials it from the browser. After a call to a known target, two taps log how it went.
- **Runs on the workspace's Twilio**: Settings → Integrations → Twilio, then *Set up the browser phone* in the phone. That one click creates a Twilio API key (for short-lived access tokens) and a TwiML App, which points at `/hooks/twilio/<secret>/voice`.
  - Calls show the Twilio number, or your own number if you've verified it in Twilio.
  - Calls aren't recorded.
- **Incoming (optional)**: points the Twilio number at Warplan.
  - Incoming calls ring every teammate's browser, showing the target's name when the number is known. Missed calls go on the timeline.
  - Incoming texts go on the timeline, and STOP replies block further texts to that number.
  - Turning it off restores the number's previous settings.
- **Security**: every Twilio webhook request is checked against Twilio's signature and the workspace's account ID.
  - The API key secret is stored encrypted.
  - The Voice SDK is served from the app itself (`public/vendor`) so the page can keep allowing only its own scripts.
- **Agent tool** `send_sms`: always waits for your approval in the Inbox.

## API

`GET /api` returns the full reference. Authenticate with `Authorization: Bearer wp_...` (Settings → API).

```
GET    /api/home                         pipeline by stage, due actions, activity, practice scores
GET    /api/targets?stage=&q=            POST /api/targets · PATCH/DELETE /api/targets/:id
POST   /api/targets/import               {rows: [...]} up to 500 · GET /api/targets.csv
POST   /api/targets/:id/events           {kind: note|call|email|meeting, body}
POST   /api/documents/generate           {kind: loi|memo|lender|outreach|diligence|board|plan100, target_id, channel?, language?, financials?}
GET    /api/documents · GET/PATCH/DELETE /api/documents/:id
GET    /api/threads · POST /api/threads  {agent: josh, target?} | {agent: simulator, seller|target, difficulty, stage}
POST   /api/threads/:id/messages         {text}; send Accept: text/event-stream to stream
POST   /api/threads/:id/debrief          score a practice call
GET    /api/usage · GET /api/integrations · POST /api/webhooks
```

## Tests

```sh
cd app && npm test     # deal engine and diligence maths
```

## Deploy

```sh
cd app && npm install
npx wrangler d1 execute warplan --remote --file schema.sql
node scripts/build-kb.mjs && npx wrangler d1 execute warplan --remote --file kb.sql   # Josh's answers database
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # first-run setup key at /login
npx wrangler secret put KEYS_SECRET          # encrypts workspaces' own AI keys; never change it once set
npx wrangler secret put ANTHROPIC_API_KEY    # optional: Claude; otherwise Workers AI (Llama 3.3 70B)
npx wrangler secret put ELEVENLABS_API_KEY   # optional: ElevenLabs voices; otherwise Workers AI Aura
npx wrangler secret put JOSH_VOICE_ID        # optional: ElevenLabs voice ID for Josh (his consented clone)
```

First run: open `/login`. While no users exist it asks for the setup key (`DASHBOARD_PASSWORD`) and creates the
admin login.
