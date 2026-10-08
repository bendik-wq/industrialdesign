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
