# Warplan security log

Recurring checks (`probe.sh` black-box, `npm test` regressions in `app/test/security.test.js`, plus a code review) run on a schedule. Each run adds a dated entry below; fixed items move to the table with their commit.

## 2026-10-30: full audit (auth, tenant isolation, injection/XSS/SSRF/prompt injection, public surface, secrets/crypto)

Clean: no SQL injection, XSS, command/path injection, SSRF to private networks, secrets in git history, or broken crypto. Headers, CSRF origin checks, password hashing, token storage and webhook signatures were sound.

### Fixed

| Sev | Issue | Fix |
|---|---|---|
| Critical | Shared platform Monid key let any workspace call `agentmail` / `smolmachine` / `recall` with other workspaces' inbox and machine ids (read seller replies, send as them, run commands on their Deal Lab VM) | `userRunnable()` blocks account-resource providers from the data console, `monid_run`, `monid_inspect` and discover; only internal code calls them |
| High | API tokens / MCP clients could send email, SMS, iMessage, push campaigns, dial, record meetings, run paid agents and Monid directly over REST, skipping the Inbox | `TOKEN_VIA_INBOX`: tokens get 403 and are told to queue via `POST /api/inbox` |
| High | Anyone emailing the agent inbox (or holding the reply-hook URL) triggered unmetered Opus calls | AI triage only for senders matched to a target, on Haiku, `checkLimits` + `record`, duplicate deliveries dropped |
| High | Zip-bomb `.xlsx` (seller upload) crashed agent runs and wedged the agent for that target | Streaming inflate capped at 40 MB/entry, 120 MB/file, declared-size check; CSV width/cell caps; runs stuck >15 min are failed |
| High | Prompt injection: tool results could steer Josh to leak data via URLs/searches or redirect a contact's email | House rule 6 (untrusted text is data), approval for data-like URLs/searches and for changes to email/phone/website |
| Medium | API tokens survived password change and "sign out everywhere" | Both now delete the user's tokens |
| Medium | Plain sign-out left the 30-day cookie valid | Sign-out bumps the session epoch (ends this user's sessions everywhere) |
| Medium | Login rate limit raceable with parallel requests; anyone could lock a user out | Attempts reserved in one transaction before the password check; limits per email+IP (10), email (30, was 100), IP (50) |
| Medium | Members/tokens could read the owner's personal iMessages | iMessage read/act routes owner-only, no tokens |
| Medium | Members/tokens could read webhook URLs (Zapier/Make secrets) and key metadata | Redacted unless signed-in owner |
| Medium | Seller-link visitors could overwrite the NDA acceptance record | NDA recorded once (`nda_at IS NULL`) |
| Medium | Seller links could fill the shared database (60 × 20 MB per link, no NDA) | NDA required to upload, 30 uploads/hour/link, 1.5 GB per workspace, `Content-Length` required |
| Medium | Unmetered AI calls (campaign personalisation, research, meeting notes, call notes) | All `record()`ed; personalisation `checkLimits` + Haiku |
| Medium | Excel deal model wrote free text that could become formulas (`=HYPERLINK`, `WEBSERVICE`) | `txt()` prefixes formula-looking text |
| Low | Spoofed `From:` could move deals via Gmail sync | Requires `dmarc=pass` or `dkim=pass` |
| Low | Redirects re-sent body and signature headers to another host; webhooks followed redirects | Cross-host hops drop body/credentials; webhooks `hops: 0`; `global_fetch_strictly_public` |
| Low | EmailBison base URL weakly validated; sequencer requests followed redirects with keys | `publicUrl` check, `redirect: "manual"` |
| Low | Co-owner could remove the platform admin | Only the admin can change the admin |
| Low | Members could approve paid notetaker/campaign pushes; members could run paid Board Scout | Added to `COSTLY`; Board Scout owner-only |
| Low | Setup key compared with `!==` | `safeEqual` |
| Low | Raw upstream AI errors returned to clients | Generic 502, detail logged |
| Low | CSV export missed `\t`/`\r` formula prefixes; data console attribute not escaped | Fixed |
| Low | Funnel: no security headers, admin password brute-forceable | `_headers` + Worker headers; 10 failed admin logins/hour/IP then locked |
| Low | Root `.gitignore` didn't cover `.dev.vars` / `.env` | Added |

### Open items closed (same day, second pass)

| Was open | Now |
|---|---|
| Tokens in URLs (`/mcp/wp_…`, hook paths) in request logs | Per-request invocation logs off (`observability.logs.invocation_logs: false`); console logs kept |
| Webhook signing secrets in plain text | Sealed with AES-GCM bound to the workspace (`sealed:v1:`); older rows re-sealed on first use |
| Legacy `API_TOKEN` platform-admin secret | Code path removed (it wasn't set in production) |
| Files stored in D1 | Uploaded files live in R2 (`warplan-files`, binding `FILES`); D1 keeps only the record. A cron job moves any older D1 files across. Verified live: upload → stored in R2 with 0 bytes in D1 → download byte-identical → target delete removes the object. 1.5 GB/workspace quota still applies |
| AI and data budgets could be overshot by a burst | Calls reserve a hold before running (`_hold` usage rows, `RESERVED` data runs) inside the same transaction as the limit check |
| Seller links never expired | Expire after 60 days (`link_expires_at`, migration `0001_link_expiry.sql`); a new link resets it |
| No `__Host-` cookie prefix | Cookie is `__Host-wp_s` (everyone signed in again once) |
| Sign-out ended every session (stateless cookie) | Server-side session ids: sign-out ends exactly that session; "sign out everywhere" ends all and revokes API tokens |
| Members could delete targets and documents | Owner-only, and not via API tokens |
| Invites revealed whether an email had a login | Check removed from invite creation; only the invitee learns it when accepting |
| Funnel: no bot check, raw IPs stored | Cloudflare Turnstile verified server-side; only a salted hash of the IP is kept (old IPs cleared) |
| 15-second session cache | 5 seconds, reads only: every write re-checks the session (verified: a write right after sign-out gets 401) |

## 2026-10-30: pentest (four parallel attackers against a local two-workspace copy, then live)

Tried: cross-workspace access on every route (IDOR), stored/reflected XSS, SSRF, cookie forgery and tampering, session replay, CSRF, token tricks, login brute force, and races (parallel bursts).

Held: workspace B's data could not be read or changed from workspace A on any route. Every forged/tampered cookie was refused (uid swap, expiry change, truncated or empty signature, old cookie name, duplicate cookies). Sign-out, password change, role change and removal all end the old session at once for writes. CSRF: cross-site, `null` and look-alike origins refused. Invites, NDA, Inbox approve and setup are single-use under parallel requests.

| Sev | Found | Fix |
|---|---|---|
| Medium | SSRF guard only checked the text of the address, so a name like `127.0.0.1.nip.io` passed (Workers can't reach private networks, so not exploitable today) | Every fetch hop and webhook URL is resolved over DNS-over-HTTPS; any private, loopback, link-local, CGNAT or IPv4-mapped address is refused |
| Low | Login cap per account was 100 / 15 min across all IPs | 30 |
| Low | Board Scout "add" could add the same person twice under parallel clicks | Suggestion claimed atomically before the relationship is created |
| Low | Two agent runs could start at once for the same target | Check and insert in one statement |
| Low | Parallel seller uploads could overshoot the hourly cap and workspace quota | Both checked inside the insert |
| Low | Three links rendered without a scheme check (research source, call recording, room file) | Scheme/path checked before rendering |
| Low | JSON request bodies had no size limit | 1 MB, else 413 |

Dealflow app (same day): `__Host-` cookie with server-side sessions, signing fails closed without `SESSION_SECRET`, legacy `API_TOKEN` removed, login throttled per account across IPs, AI and agent usage metered per user/workspace, public forms rate-limited, CSRF origin check, CSV formula escaping, security headers. Marketing site: CSP and security headers via `_headers`.

Can't be fixed from this repo: the `cold-block` and `owners-vsl-funnel` Workers have no security headers and their source isn't here.

## 2026-10-30: full-repo audit (auth, access control, secrets, injection, dependencies, headers)

Clean: no secrets in tracked files or git history; PBKDF2-SHA256 100k with per-user salt in both apps; every SQL value bound, every dynamic column from an allowlist; no CORS headers (same-origin only); generic 500s, no stack traces; HSTS + CSP + frame/nosniff headers live on every host; lockfiles all from registry.npmjs.org with integrity hashes.

| Sev | Found | Fix |
|---|---|---|
| High (dev only) | `wrangler` 4.147 pulled in vulnerable `miniflare` / `sharp` (librsvg CVE) / `undici` (DoS, SRI bypass) in all three apps; local tooling, not deployed code | `wrangler` 4.156.0, `npm audit` now 0 |
| Medium | Funnel CSP allowed `'unsafe-inline'` scripts (one inline block) | Script moved to `/app.js`; `script-src 'self' https://challenges.cloudflare.com` |
| Medium | Funnel admin lockout per IP only; rotating IPs allowed unlimited password guesses | Also locks after 50 failures/hour from everywhere |
| Low | Funnel skipped the bot check entirely if `TURNSTILE_SECRET` were missing | Fails closed (503) |
| Low | Dealflow `?sort=constructor` / `?page=1e309` produced malformed SQL (500) | `Object.hasOwn` on the sort map; page capped |

## 2026-10-30: last open items closed; headers on the two outside Workers

| Was open | Now |
|---|---|
| Reads could use a 5-second session cache after sign-out/removal | Cache removed: every request re-checks the session. Verified live: 401 on the very next read after sign-out |
| Rate limits trusted `CF-Connecting-IP` even off Cloudflare | Read only when `request.cf` is present (the edge set it); otherwise one shared bucket. Seller-NDA IP uses the same helper. Dealflow too |
| `cold-block` had no security headers | Wrapped (`funnels/edge-headers`): HSTS, nosniff, Referrer-Policy, Permissions-Policy, X-Frame-Options DENY, nonce + `strict-dynamic` CSP. Game, three.js and WebSocket (101) verified |
| `owners-vsl-funnel` public pages had a minimal CSP (scripts unrestricted) and no Permissions-Policy | Same wrapper: per-request nonce on `<head>` scripts (the app's own, Meta Pixel, PostHog), `strict-dynamic`, admin-login snippet allowed by hash, Permissions-Policy (microphone only for voice input). Enforced on every public page; verified in a browser with zero violations and Pixel/PostHog/config loading. Registrant-only pages (`/registered`, `/room`, `/replay`, `/worksheet`, `/notes`, `/blueprint`, `/pack`, `/book`) run it report-only, logging any violation via `/__csp-report`, until real visits confirm they're clean |

The two Workers' source isn't in this repo. `funnels/edge-headers/deploy.sh <worker> enforce` downloads the live bundle, adds `secure.js` as the entry point and re-uploads it with the same bindings, secrets and assets. **Re-run it after any new deploy of those Workers**: a fresh deploy from their own source replaces the wrapper.

Registrant-only pages (room, replay, registered, worksheet, notes, blueprint, pack, book) were switched to enforced as well (Oct 30): every one loaded in a browser with zero violations, with the Pixel, PostHog and page config running.

Territory map (Oct 30): map tiles from tile.openstreetmap.org are the only new image source in the CSP; Leaflet 1.9.4 is vendored (integrity checked against the npm registry); geocoding (Nominatim) goes through `safeFetch` with no redirects, is cached and rate-limited per workspace (20/min, 400/day) and platform-wide (50/min); every site query is scoped to the workspace.

## 2026-10-31: prospecting bots

Owner-only and signed-in only to create, change, run or switch to autopilot (autopilot needs an explicit confirmation). Every query is scoped to the workspace. Sends go through the normal mailbox path (do-not-contact list, daily cap, sender name and opt-out line on every email); a reply, opt-out, bounce or manual stage change stops a prospect; emails per prospect are capped at 10; runs are weekdays only, locked so two can't overlap, and the daily new-business total holds across manual runs. Thread headers only accept a Message-ID. Business search and paid lookups stay inside the workspace's data budget.

## 2026-10-31: sell-side bots and buyers directory

The directory is static, public data (firm names, websites, published criteria), bundled with the app. Sell bots email only a fund's shared inbox found on its own website (deals@, info@ …), never a named person; fund contact lookups are cached across workspaces because they're public. Flows go up to 60 emails (weekdays only) with the same stop rules: reply, opt-out, bounce, or the owner skipping an email in review mode; an out-of-office reply pauses a week. Sell prospects are scoped to the workspace and a fund contacted by one bot isn't picked again by another.

## 2026-10-31: mailbox rotation and strategic buyers

Sending mailboxes in the pool are workspace-owned, added only by owners signed in; an SMTP login is tested before it's saved and the password is sealed (AES-GCM) bound to the workspace and address. Every send checks the box belongs to the workspace and is active, and respects its own daily cap and warm-up ramp; rotated emails carry Reply-To (and List-Unsubscribe) pointing at the sender's own mailbox so replies and opt-outs still stop the bots. A prospect stays on one mailbox. Strategic buyers come from public business listings; only shared inboxes (info@, contact@, ceo@ …) are emailed, otherwise the phone goes on the call list.

### Still open

- Nothing.
