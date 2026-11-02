# Smoke suite

End-to-end checks in a real browser (Playwright, Chromium). Run before and after every deploy.

## Local (full flows)

```sh
printf 'ADMIN_PASSWORD=devpass\n' > .dev.vars          # throwaway, gitignored; delete when done
npx wrangler d1 migrations apply DB --local
npx wrangler dev --local --port 8787                    # in another terminal
npm run smoke:local                                     # or: npm run smoke:local -- 8813
```

`--local` starts nothing. It reads `ADMIN_PASSWORD` from the environment (or `.dev.vars`), seeds local D1
with `seed.mjs` (a scheduled live session, a challenge cohort, one test lead; fixed ids, safe to re-run)
and uses a fake camera and microphone.

## Production (read-only)

```sh
npm run smoke:prod -- https://apply.grosfjeld-li.com
SMOKE_ADMIN_PASSWORD=... npm run smoke:prod -- https://apply.grosfjeld-li.com   # adds the Funnel HQ checks
```

Read-only by construction: the browser aborts every non-GET request (except the Funnel HQ sign-in), so
nothing is submitted, bought or emailed. It never signs out (that would end everyone's Funnel HQ session),
blocks third-party pixels, and the headless browser counts as a bot in analytics. The admin password comes
only from `SMOKE_ADMIN_PASSWORD` in the environment.

## Checks

| check | local | prod |
|---|---|---|
| health | `/health` returns ok and a build id | same |
| home+vsl | home renders a headline, the VSL video and application step 1; no sideways scroll at 390px | same |
| apply | completes the whole application, then the page it lands on (the breakout VSL) renders | step 1 renders |
| masterclass | registration form with times; room preview (`/webinar/room/preview?hq_preview=1`) | same (preview only with the admin password) |
| live | landing with the registration form (seeded session) | landing |
| challenge | landing with the registration form (seeded cohort) | landing |
| camera-test | page loads and the check runs with the fake camera | page loads (not started) |
| hq-tabs | every tab in `admin.js` TABS renders, no page errors, no 5xx API calls | same; a tab that needs a write (preview, ping) is noted, not failed |
| webinar-room | host joins and goes live; attendee (phone) joins through the general admission link; a push reaches the attendee; the automatic pushes list renders | skipped |
| meeting-room | host and guest each see two tiles (signalling only: no real media in a sandbox) | skipped |

Any page error or same-origin 5xx during a check fails it. Console errors, 4xx API calls and blocked
writes are listed as notes.

## Output

A pass/fail table with timings; `report.txt`, `report.json` (with per-tab load times) and screenshots of
every page of a failed check go to `scripts/smoke/out/<mode>-<time>/` (gitignored; `--out <dir>` to change).
Exit code 0 = all passed, 1 = a check failed, 2 = could not start (server down, bad arguments).

Options: `--only health,apply`, `--no-seed`, `--headed`, `--list`.
