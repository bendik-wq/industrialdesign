# Warplan

An AI acquisition team for owners of $1M+ businesses who grow by buying competitors with vendor finance
(the 3C model: Capabilities, Capital, Closing).

Live: https://warplan.bendik-50e.workers.dev (email login, invite-only)

A separate app from Dealflow (`../dealflow`), with its own Worker, D1 database (`warplan`) and design.

## Live today

- **Ask Josh** (`app/src/agents.js`, `app/src/playbook.js`): the AI version of Josh Li. Talks like Josh, answers
  first, and pushes hard toward action in plain language (no templated "next step" endings). Built on:
  - **Josh's playbook** (`app/src/playbook.js`): the 3C model, his deal structures (Vanilla Pop, Pension Plan,
    Hallelujah, Kingly 36), outreach, due diligence, closing and post-deal, distilled from all his videos.
  - **House rules** that override the videos: no money down; any mix of vendor finance, commercial debt, seller
    rollover, investor capital (and own cash by choice) is fine as long as the buyer keeps majority control and
    DSCR stays at 1.5x+ every year; no numbers on the first call with an owner.
  - **His full video transcripts** (`knowledge/josh-transcripts.txt`). With `ANTHROPIC_API_KEY` set, all of them go
    into Claude's context on every message as a cached block (about 90k tokens; cache reads keep it cheap). Without
    it, the best-matching passages are pulled from a D1 full-text index (`app/scripts/build-kb.mjs`).
  - Voice in (Whisper) and out (ElevenLabs, Josh's voice via `JOSH_VOICE_ID`). Says it's the AI version when asked
    and never invents stories beyond the transcripts.
- **Deal Builder**: stack the five capital elements any way you like (with presets for Josh's structures), with
  payment holidays and interest-only periods on the seller note, non-voting rollover/investor shares, and free cash
  flow as a share of EBITDA. Shows the verdict on the two rules (control, 1.5x DSCR in the weakest year), the capital
  stack, year-by-year debt cover and the highest price the stack can carry. "Ask Josh about this deal" hands it over.
- **Seller Simulator**: role-play with realistic owners (HVAC, dental, accounting) who have hidden motives, as a
  **first call** (no numbers: owners cool off if you push price) or a **deal-talk** second conversation. Voice in and
  out; Josh scores the call with a stage-specific rubric and opens a conversation to keep going.
- **Value Ladder**: what the owner's own company is worth today and after buying N competitors, using the Deal
  Builder's structure for every deal, including the share of the group sellers and investors end up holding.

## Roadmap agents (shown in the app as "Training")

Scout (off-market sourcing from registries), Outreach, Capital Desk (financing), Diligence (quality of earnings),
Deal Desk (NBIO/LOI), AI Board (monthly board meeting), Integrator (first 100 days).

## API

All endpoints need the session cookie from `POST /api/login`.

```
GET    /api/me
GET    /api/agents                     roster (live + coming) and simulator sellers
GET    /api/threads?agent=josh         your conversations
POST   /api/threads                    {agent: "josh"} or {agent: "simulator", seller, difficulty}
GET    /api/threads/:id                conversation with messages
POST   /api/threads/:id/messages       {text} → {reply}
POST   /api/threads/:id/debrief        simulator call → Josh's scored debrief (new Josh thread)
DELETE /api/threads/:id
POST   /api/voice/transcribe           raw audio → {text}
POST   /api/voice/speak                {text, speaker} → audio/mpeg
```

## Deploy

```sh
cd app && npm install
npx wrangler d1 execute warplan --remote --file schema.sql
node scripts/build-kb.mjs && npx wrangler d1 execute warplan --remote --file kb.sql   # Josh's answers database
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # first-run setup key at /login
npx wrangler secret put ANTHROPIC_API_KEY    # optional: Claude; otherwise Workers AI (Llama 3.3 70B)
npx wrangler secret put ELEVENLABS_API_KEY   # optional: ElevenLabs voices; otherwise Workers AI Aura
npx wrangler secret put JOSH_VOICE_ID        # optional: ElevenLabs voice ID for Josh (his consented clone)
```

First run: open `/login`. While no users exist it asks for the setup key (`DASHBOARD_PASSWORD`) and creates the
admin login.
