# Webinar (masterclass) on its own subdomain

## What it is
`live.<domain>` is served by the same Worker, with host-based routing: on the webinar host, `/` is the webinar sign-up page. Funnel and admin paths redirect to the main domain. Without a host it runs under `/webinar`.

Registrants become leads, with full attribution. Meta gets `CompleteRegistration` and GA4 gets `sign_up`.

## Data (migration 0012)
- `webinar_sessions`: starts_at (unique), title, mode, join_url, video_src, status, auto.
- `webinar_registrations`: token (personal link), session_id, lead_id, `seq` (nth registration → email step block), `new_lead`, joined_at, watch_seconds, max_position, cta_at, replay_at, replay_seconds.
- leads: `webinar_at` (the email anchor), webinar_registered_at, webinar_attended_at, webinar_watch_pct, webinar_cta_at, webinar_replay_at, webinar_token.

## Sessions
- **Weekly schedule** (`WEBINAR_SCHEDULE` = "Tue 19:00, Thu 12:00" in `SALES_TIMEZONE`). A cron job creates the sessions two weeks ahead, using `INSERT OR IGNORE` on starts_at, and they're DST-safe through `zonedTime`. One-off sessions are added on the Funnel HQ → Webinar tab.
- **Modes:**
  - `evergreen`: our room plays the recording **in sync with the clock**. Everyone sees the same moment, seeking is snapped back, and the client corrects for clock skew using serverNow. The room is labelled as a masterclass, never as "live".
  - `stream`: live in our own room via **Cloudflare Stream Live**. The host streams over RTMPS from OBS, StreamYard or Zoom (Zoom's "Live on custom live streaming service"), and the room plays the HLS (`WEBINAR_STREAM_HLS`) with hls.js.
  - `live`: an external join link (Zoom, YouTube). It's only handed out from 10 minutes before the start; the click is recorded as attendance.
- **Phases:** waiting, running (duration `WEBINAR_DURATION_MIN`), replay (`WEBINAR_REPLAY_HOURS`, enforced on the server), expired (offers to rebook into the next session). Cancelling a session moves its registrants to the next one, and they get fresh confirmation emails.

## Pages
- **Sign-up:** sessions listed in the visitor's time zone, first name and email.
- **Registered:** countdown, Google calendar link plus an `.ics` file, prep steps.
- **Room:** waiting countdown, then the video, live stream or join button. The "See if you qualify" offer appears at `WEBINAR_PITCH_AT`, and attendance is heartbeated every 15 seconds.
- **Replay** and **expired/rebook** pages.

## Security
- The token is the bearer for the room. `/w/:token` (the offer button through to the application) only links the browser to the lead when **the registration created the lead**, because otherwise anyone could register with someone else's email to get a token.
- An existing lead is never modified by registration, apart from the webinar anchor fields.
- Sign-ups are capped at 8 per IP per hour, and Turnstile is used if configured.
- Heartbeats credit at most the time since the last beat.

## Emails (`webinar` sequence, `cycle: 12`; each registration gets its own block, `stepBase = seq*12`)
1. Confirmation (calendar links)
2. Reminders 24h, 3h and 15m before
3. "We've started" (skipped if they've joined)
4. 80 minutes after the start:
   - attended → thanks plus apply;
   - missed → replay.
5. The replay is coming down (~40h)
6. Offer at 3 days, story at 5 days, last note at 8 days. These stop once they apply or book.

Attendance only counts for **this** session (`webinar_attended_at >= webinar_at - 30m`). Reminders whose time has passed are skipped when they register.

## Funnel HQ → Webinar
- KPIs: registrations, show rate, average time watched, offer clicks, then applied, booked and won.
- Upcoming sessions (cancel and move people), plus a form to add a session.
- Past sessions: show rate, how far people watched, offer clicks, applied, booked.
- Registrants table, linked to the lead drawer.
- Funnel map nodes: webinar sign-up → room → apply, plus webinar emails.

## Zoom
- **Simplest:** a `live` session with the Zoom join link.
- **Branded room:** Zoom → Live streaming → custom service → the Cloudflare Stream RTMPS URL and key → a `stream` session.
- Reverse-engineering Zoom's client or protocol isn't an option, because it breaks Zoom's terms.
