# Behaviour profile, triggers, Claude personalisation

## Profile (`src/personalize/profile.ts`)
`buildProfile(env, lead)` turns everything the lead did into **facts**: `{ key, text (for the model), weight, topics[], you? }`. The optional `you` field is a line that's safe to say to their face.

Sources: which lander and industry they came in on; visit count and return visits; VSL chapters watched (guarded by duration), rewatches, restarts, where they stopped; FAQ questions opened; section dwell and re-reads; copy and select (background only); exit section; CTA hesitation; tab switches; field struggle; application answers (`a_*` facts); the slowest question; going back to change answers; booking behaviour (picked a date but didn't confirm); email opens and clicks; AI call outcomes.

`TEMPLATE_TOPICS[template]` lists the topics each email covers, so facts that match its topic rank higher.

## Personalise (`src/personalize/personalize.ts`)
- Mode: `EMAIL_PERSONALIZE` = off | rules | ai. The default is ai if `ANTHROPIC_API_KEY` is set, otherwise rules.
- `pickFacts`: ranks facts by weight, plus 6 if the fact's topic matches the email, and skips facts that earlier emails to this lead already used (`emails.facts_used`).
- **Rules mode**: inserts one `you` line after the greeting. It only adds a bridge sentence ("So this one is about the money side.") when the fact's topic matches the email.
- **BACKGROUND set**: lander, tabs, cta_hesitate, selected, exit_section, field_struggle, copied, devices, engaged, speed, e_silent, exit, skip, pause, a_slowest, a_backs, resources. These help the model understand the lead but are **never said back**, because saying them would feel like surveillance.
- **AI mode** uses the Claude Messages API with the current most capable model (check the claude-api skill for the model id), medium effort, and a JSON-schema structured output: `{subject, preheader, paragraphs[], ps, facts_used[]}`. The system prompt covers voice, offer facts, banned words and the never-invent rule. **Links never go to the model**: they're placeholders swapped in afterwards. `validateAi` rejects outputs with URLs, banned words, unknown fact keys or a bad shape, and falls back to rules mode. Record `personalized`, `facts_used` and `personalize_error` per email.
- Lead-written text is untrusted input to the model. Fence it in the prompt, and validate the output so it contains no links or contact details that aren't in the draft.

## Behaviour-triggered emails (`src/personalize/triggers.ts`)
`RULES` (template, label, delay in minutes, `when(state, now)`), evaluated in batched queries every cron run:
- t_vsl_no_apply: watched 50%+ of the video, didn't finish applying (delay 30)
- t_stalled: stopped partway through the application, 30 min idle (45)
- t_finish_booking: picked a day on the calendar, didn't confirm (25)
- t_came_back: qualified, not booked, came back to the site (40)
- t_still_thinking: 3+ visits without booking (60)
- t_guarantee: read or re-read the guarantee, not booked (60)
- t_funding: looked into funding through the FAQ, a rewatch or a highlight (60)
- t_book_nudge: opened the booking page, didn't book (30)
- t_breakout_done: watched 70% of the breakout video, didn't book (30)
- t_watch_prep: booked more than 12h ago and hasn't watched the pre-call video (0)

Each rule fires **once per lead**, at most one trigger per lead per run, with a global `DAILY_CAP` of 8. The sends go into the `behaviour` sequence (step = rule index, append-only) and are re-checked at send time.
