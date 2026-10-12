# Application, scoring, routing

## Questions (config-driven: `APPLICATION` in `src/config.ts`)
Each question has `id`, `type` (contact | text | single | multi), title, help, options `{value, label, points, flags[]}`, and for text questions `minLength` and points by length. The original question set:
1. contact (first name, last name, email, mobile + call consent)
2. business (text: what you sell, who to, where)
3. role (owner 20 / co-owner 16 / exec 6 [flag not_owner] / no business 0 [no_business])
4. revenue (<$1M 0 [under_1m] / $1–3M 15 [small] / $3–10M 22 / $10M+ 25)
5. profit (loss 0 [unprofitable] / <$250k 8 / $250k–1M 16 / $1M+ 20)
6. goal (acquire 10 / group 10 / exit 8 / unsure 2)
7. timeline (0–6 mo 15 / 6–12 10 / 12+ 4 / exploring 0 [exploring])
8. blockers (multi: deal_flow, funding, valuation, integration, time, never_considered; these drive follow-up copy, not points)
9. readiness (yes 15 / with partner 9 [partner] / not now 0 [not_ready])
10. why_now (text; +5 at 160+ chars, +3 at 60+)

## Scoring (`src/funnel/scoring.ts`)
- Sum the points, then derive flags: excluded industry (whole-word match on the business text), personal email domain, out-of-market country, blocklist.
- `TIER_THRESHOLDS = { A: 70, B: 40 }`. **Hard caps (`TIER_RULES`)**: blocked, excluded industry, no business or under $1M → max C. Not owner, unprofitable, not ready, exploring, personal email + small, or out of market → max B.
- Store `score_breakdown` so the dashboard can explain every tier.

## Routing
- `TIER_ROUTES`: A → `/book` (closer calendar), B → `/breakout` (objections, then the setter or closer calendar), C → `/resources`.
- **Weighted round-robin** across active reps who take that tier, with the pointer in `kv_state`. Reps live in the `reps` table (Team tab), falling back to `CLOSERS` in config.
- On submit: cancel `abandoned`, start the tier sequence plus the 6-month `nurture`, queue the speed-to-lead AI call (A/B, consent only), send a Slack/Discord ping for A and B, and track `app_submitted` + `lead_qualified` with a value weighted by tier.

## Abandoned application
Contact at step 1 creates the lead (status `partial`) and starts `abandoned` (5 emails over 4 days), which is cancelled on submit. Re-submitting with the same email reopens the same lead.
