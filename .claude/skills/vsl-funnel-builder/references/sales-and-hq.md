# Sales team and Funnel HQ dashboard

## Reps (Team tab, `reps` table)
Each rep has: name, email, role (closer/setter), tiers taken, round-robin weight, calendar URL, commission %, monthly target, Slack and Discord user ids (for @mentions), and an active flag.

## Outcomes (`applyLeadUpdate` in `src/sales/outcomes.ts`)
- Statuses: booked → showed / no_show → won / lost (or disqualified, or nurture). The update stamps `showed_at` and `closed_at`, dated to the call when you log an old call.
- **Deal markers**: industry, revenue_band, budget_band, willing_to_invest, temperature (hot/warm/cold), objection (`OBJECTIONS`), follow_up_at, decision_maker, fit_rating 1–5, offer, payment_plan, installments_total, next_payment_at, contract_signed_at, refunded_at, refund_amount, loi_signed_at, target_business, lost_reason (`LOST_REASONS`).
- `payments` ledger: `recordPayment` and `deletePayment` keep `cash_collected` in sync.
- Side effects (skipped when `isHistorical(lead)`, i.e. a calendly-direct import or a call more than 14 days old):
  - no_show → `no_show` sequence + AI rebook call.
  - showed → `post_call`.
  - won → `won` onboarding.
  - lost → `lost` re-engagement.
  - won, lost or disqualified cancels every other sequence.
  - Team pings for each outcome.
  - Meta: CallShowed and Purchase with value.
- `pingUpcomingCalls` (cron): pings the assigned rep about 15 minutes before each call, with the lead summary and how much of the VSL they watched.
- Daily digest to Slack/Discord at a local time (`maybeSendDigest`).

## Notifications (`src/integrations/notify.ts`)
Slack incoming webhook and/or Discord webhook. Events: hot lead (A), qualified (B), booked, cancelled, call in 15 minutes, no-show, held, won 🎉, lost, AI call results, digest. **Escape Slack mrkdwn and Discord markdown** in lead-provided text, and keep PII to what the team needs.

## Funnel HQ tabs (`public/admin/index.html` + `public/assets/admin.js`)
Overview (KPIs + the full funnel to revenue + trends) · **Funnel map** · VSL (retention curve, pitch marker, drop-offs) · Links & videos · Traffic & ads (15 dimensions to revenue per visitor) · Landing pages & tests · On-page behaviour (clicks, form friction, exits, re-reads, highlights) · Application (step drop-off, answers, score histogram) · Sales team (calls, show rate, closes, cash by rep; call log to record outcomes; a needs-an-outcome list covering 30 days) · Insights (everyone who booked, split by tier; A-tier unpacked; Calendly monthly) · Team · Leads (CRM: search, filters, CSV, a drawer with the journey timeline, a Deal card, payments, behaviour facts with an email preview, Calendly bookings) · Emails (sequences, queue, behaviour triggers, deliverability) · Voice (ElevenLabs setup, call log, transcripts) · Tracking (forwarding and match quality) · Live (5-second stream) · Integrations (keys, test buttons, Calendly connect/sync/import/requalify).

A shared date-range + channel + campaign + variant + device filter bar sits at the top. Tabs that don't use it hide it (`noFilters`).

## Funnel map (`public/assets/funnel-map.js`)
- About 40 built-in nodes, each `{ id, kind (traffic|page|decision|auto|people|data), x, y, title, sub, tab, stat?, how }`. Edges are `[from, to, label | 'r:<rate>', style auto|data|dash]`. Nodes cover traffic → smart route → landers/main → VSL → application → score → A/B/C → booked → call → won/lost/no-show, plus the automations (AI calls, pre-call emails, pings, post-call, abandoned, speed-to-lead, get-booked, cancelled/rebook, onboarding, re-engagement, nurture) and the engine room (tracking, behaviour profile, triggers, Claude personalisation, application reader, callback agent, HQ).
- Rendering: 220×92 boxes positioned with transform, SVG bezier edges with arrowheads, rate labels computed from `/overview` (play→apply, applied, booked, show, close; hidden when over 100%). Live stat per node.
- Interactions:
  - Drag boxes (10 px snap); positions are saved (`PUT /admin/api/map-layout`, debounced) and shared by everyone.
  - Drag the background to pan; zoom −/+; Fit; Reset layout (confirms first; your own steps keep their positions).
  - Click a box to open a side panel: how it works, its stat, comes from / leads to (jump links), and "Open in Funnel HQ →".
  - **Editable**:
    - **+ Add step** creates your own box (title, subtitle, type, opens-tab, notes).
    - Drag the ● on a box's edge onto another box to draw an arrow, or use "Connect to…" with an optional label.
    - Your own boxes and arrows can be deleted.
    - Built-in boxes can have their title and subtitle edited and notes added, with a reset to default. They can't be deleted, because they describe the real system.
- Storage: `kv_state` `map:custom` = `{ nodes[], edges[], edits{} }`, validated server-side:
  - custom ids `u_[a-z0-9]{4,20}`;
  - limits of 200 nodes and 400 edges;
  - text length caps: title 60, subtitle 90, note 2000, label 30;
  - kind restricted to the allowed set.
- Everything rendered from it **must be escaped** in both HTML and attribute contexts.
