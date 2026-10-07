# Warplan

An AI acquisition team for owners of $1M+ businesses who grow by buying competitors with vendor finance
(the 3C model: Capabilities, Capital, Closing).

Live: https://warplan.bendik-50e.workers.dev (email login, invite-only)

A separate app from Dealflow (`../dealflow`), with its own Worker, D1 database (`warplan`) and design.

## Live today

- **Ask Josh** (`app/src/agents.js`, persona `josh`): the AI version of Josh's acquisition advice, grounded in
  the 3C playbook. Type or talk (Whisper speech-to-text), replies read aloud (Deepgram Aura). Conversations are
  saved per user. It always says it is the AI version, never invents stories or deals attributed to Josh, and
  sends legal, tax and lending specifics to the user's advisors.
- **Seller Simulator**: role-play a first call with a realistic owner (HVAC contractor, dentist, accountant),
  each with hidden motives the buyer has to earn. Voice in and out, three difficulty levels. "End call" sends
  the transcript to Josh, who scores rapport, discovery, money talk and next step, quotes the best and worst
  moments, and opens a Josh conversation to keep going.
- **Value Ladder** (browser only): what the owner's own company is worth today and after buying N competitors,
  with price, seller-note share, synergies, debt service, debt cover (DSCR, 1.5x bar) and equity after 3 years.
  Size-based multiples show the multiple-arbitrage effect. "Ask Josh about these numbers" hands the plan to Josh.

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
npx wrangler deploy
npx wrangler secret put DASHBOARD_PASSWORD   # first-run setup key at /login
npx wrangler secret put ANTHROPIC_API_KEY    # optional: Claude; otherwise Workers AI (Llama 3.3 70B)
```

First run: open `/login`. While no users exist it asks for the setup key (`DASHBOARD_PASSWORD`) and creates the
admin login.
