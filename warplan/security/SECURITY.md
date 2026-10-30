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
| Medium | Login rate limit raceable with parallel requests; anyone could lock a user out | Attempts reserved in one transaction before the password check; limits per email+IP (10), email (100), IP (50) |
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
| Files stored in D1 | R2 storage path built: with an R2 bucket bound as `FILES`, new files go to R2 and a cron job moves existing ones across. **Needs R2 enabled on the Cloudflare account** (dashboard → R2), then `wrangler r2 bucket create warplan-files` and a `FILES` binding. Until then the 1.5 GB/workspace quota applies |
| AI and data budgets could be overshot by a burst | Calls reserve a hold before running (`_hold` usage rows, `RESERVED` data runs) inside the same transaction as the limit check |
| Seller links never expired | Expire after 60 days (`link_expires_at`, migration `0001_link_expiry.sql`); a new link resets it |
| No `__Host-` cookie prefix | Cookie is `__Host-wp_s` (everyone signed in again once) |
| Sign-out ended every session (stateless cookie) | Server-side session ids: sign-out ends exactly that session; "sign out everywhere" ends all and revokes API tokens |
| Members could delete targets and documents | Owner-only, and not via API tokens |
| Invites revealed whether an email had a login | Check removed from invite creation; only the invitee learns it when accepting |
| Funnel: no bot check, raw IPs stored | Cloudflare Turnstile verified server-side; only a salted hash of the IP is kept (old IPs cleared) |
| 15-second session cache | 5 seconds, reads only: every write re-checks the session (verified: a write right after sign-out gets 401) |

### Still open

- R2: waiting for R2 to be enabled on the Cloudflare account (see above).
- Reads (GET) can be served from a 5-second session cache after a sign-out or removal; writes never are.
