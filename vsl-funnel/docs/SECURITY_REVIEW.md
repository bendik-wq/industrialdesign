# Security & privacy review (October 2026)

## How the review was run
1. **Four specialist reviewers** read the whole codebase. Each covered one area: auth/secrets; webhooks and the public API; privacy and compliance; XSS and injection.
2. **Three skeptic agents** each tried to disprove those findings. Where they could, they reproduced the attack against a local copy, and they also challenged everything the reviewers had marked "verified OK".
3. Only findings that survived were fixed (commit `bdcaee0`).
4. **A separate verifier** then reviewed the fixes for gaps and regressions. Its findings were fixed in the follow-up commit.

Regression tests live in `test/security.test.ts`. The full checklist is in `.claude/skills/vsl-funnel-builder/references/security-checklist.md`.

## Confirmed and fixed

| Area | Finding (as confirmed by the skeptics) | Fix |
|---|---|---|
| Email | Lead-written answers (why-now, business, Calendly answers) went into emails as raw HTML. Because email addresses aren't verified, anyone could make the business's domain send phishing links to any inbox. | Escape and defang at the source (the dossier). Links, domains, emails and phone numbers become `[…]`. Names must look like names. |
| Email | Rules-mode personalisation quoted the browser-reported FAQ question verbatim. | Only questions that exist in `FAQS` are used. `validateAi` also rejects domains, phone numbers and requests for payment or credentials. |
| Identity | Re-entering a known email overwrote the lead's phone and consent, re-subscribed them and linked the attacker's browser (leaking their answers). `/go/wa?l=<ref>` also linked browsers. | Unlinked browsers get a "continue" link emailed to the real inbox. A public form never re-subscribes. Ref codes no longer link browsers. |
| Bookings | `/api/booking/client` (a browser claim) fired emails, the AI confirmation call, Slack pings and Meta conversions. | Claims only update the page while a webhook or API can verify them. Side effects fire once, on verification. An alert goes out if a claim is never confirmed. |
| AI calls | Anyone could make the AI agent call any number (harassment / toll fraud), at hours based on the attacker's VPN location. | Calling hours come from the phone number's country, across all its zones, with Australian public holidays. Only listed countries are called. Caps: 3 calls per number per week and a daily account cap. Calls only after verified bookings. The first message gives a callback number and "say stop". Lead text is sanitised in prompts. |
| Inbound calls | Caller ID (which can be spoofed) unlocked the lead's email and business details. Opt-outs and link emails were triggered by a spoken email address. | Only the first name and call time are given to the agent. A spoken-email match is flagged for the team, with no action taken. |
| Admin | No login lockout. Sessions couldn't be revoked. No origin check on writes. No CSP or no-store. The email preview wasn't sandboxed. Secrets were partly unmasked. Open redirect via `//` in tracked links. The PostHog proxy was an open relay. | Lockout after 10 failures per 15 minutes per IP. Tokens are bound to the password and an epoch (revoked by logout). Same-origin writes only. CSP, HSTS and frame-deny. Sandboxed preview. Only the last 4 characters of secrets are shown. Path regex fixed. Proxy allowlist. |
| Chat pings | UTMs, emails and names could inject `@channel` mentions and fake "Open in Funnel HQ" links. Pings carried email, phone and transcripts. | Link and mention syntax is stripped. Pings carry only the name, ref and a dashboard link. |
| Privacy | The privacy page said "we never make AI calls". UK, EEA and Swiss visitors weren't consent-gated. Meta cookies were set before consent. Selecting or copying text in form fields captured typed text. PostHog got plaintext PII. Imported Calendly contacts could get marketing via webhooks. There was no retention limit. | The policy was rewritten to match the code (lawyer review still recommended). Consent is now required in the EU, UK, EEA and Switzerland, with a "Cookie settings" button. Ad cookies are only set after consent. Form fields are ignored. PostHog gets ids only. Direct imports get field updates only. Raw events are purged after 13 months. |

## Refuted or downgraded by the skeptics
- **Cross-site CSRF on admin:** SameSite=Strict blocks it. Only sibling subdomains could attempt it, and an origin check was added anyway.
- **Unsubscribe-page XSS:** real code bug, low likelihood (the provider is unlikely to deliver to such an address). Fixed regardless.
- **Timing attacks on signature comparisons:** not practical over Workers. Switched to `safeEqual` for hygiene.
- **No secrets in git history:** verified.
- **Admin routes are all behind auth, and there's no mass assignment:** verified.

## Still open (business decisions, not code bugs)
- **Put Cloudflare Access (SSO) in front of `/admin*`.** The shared password is the weakest remaining link, and there's no per-user audit log.
- **Turn on Turnstile** (`TURNSTILE_SECRET_KEY`). Consider per-IP caps or double opt-in so new sign-ups can't be used to mail-bomb.
- **Phone OTP before AI calls** would remove the remaining wrong-number risk.
- **Set geo permissions and spend limits** in Twilio and ElevenLabs.
- **Have a lawyer review the privacy policy and the consent wording** (Spam Act, TCPA, CASL, GDPR/PECR).
- **Opt-outs from unknown numbers** that call the inbound agent aren't stored anywhere yet.
- **State public holidays** in Australia aren't covered yet; only national holidays are.
