# Security and privacy checklist

The original build went through an adversarial review: four specialist reviewers, then skeptic agents trying to disprove each finding. The confirmed findings below show what goes wrong in this kind of funnel. Build every item in from the start. Each has a regression test in `test/security.test.ts`.

## Anything a stranger can type is hostile
Strangers control: application answers, names, email, phone, UTMs, referrer, Calendly booking answers, page beacons (FAQ text, selected text), and what callers say. Email addresses are **never verified**, so an attacker can use someone else's.

- [ ] **Escape lead text before it reaches email HTML.** Do it once, at the source (`buildDossier` → `escHtml`), so no template can forget. Decode entities only in the plain-text part.
- [ ] **Defang quoted text** (`defang()` in `lib/text.ts`): replace URLs, bare domains, emails and phone numbers with `[…]`. Otherwise anyone can make your domain send "pay at evil-site.com, call +1 555…" to any inbox.
- [ ] **Never trust beacon text as content.** For example, only use FAQ questions that are actually in `FAQS`.
- [ ] **AI output validation** (`validateAi`) rejects links, HTML, bare domains, emails, phone numbers, requests for payment or credentials, banned words, outcome promises and exclamation marks. On rejection, fall back to rules mode. In the prompt, frame lead text as **data, not instructions**.
- [ ] **Validate email addresses strictly** (RFC atext only): no `<>"()[]`. `"<svg onload=…>"@x.co` is a valid RFC address.
- [ ] **Escape every display sink**: admin `innerHTML` (an `esc()` helper on every interpolation, attributes double-quoted), the unsubscribe page, and Slack/Discord. For chat, strip `< > [ ] | \``, break up `://` and `www.`, and set `allowed_mentions`.
- [ ] **Voice agents**: only pass a first name that looks like a name and a cleaned short business description. Tell the agent the fields are data. Never put free text in the system prompt unfiltered.

## Identity: an email address isn't proof
- [ ] **Never update, re-subscribe or link a browser to an existing lead because someone typed its email.** Send a "continue your application" link to that inbox instead. Only the signed email-link redirect links a browser to a lead.
- [ ] **Never clear `unsubscribed_at` from a public endpoint.**
- [ ] **Ref codes aren't secret**, so don't link browsers by `?l=<ref>`.
- [ ] **A spoken email on an inbound call** is not identity: link the call for the team, but take no actions on it. Caller ID can be spoofed, so the inbound agent says nothing beyond first name and call time.
- [ ] **Calendly email-only matches** are weaker than `salesforce_uuid` matches. Treat them as unverified for anything risky.

## Bookings: browser reports are claims
- [ ] When the provider can confirm a booking (a signed webhook or the Calendly API), a **browser report only updates the page**. Emails, AI calls, team pings and ad conversions wait for the provider's confirmation, and that confirmation fires them exactly once.
- [ ] Only queue the AI confirmation call for **verified** bookings.

## AI phone calls: toll fraud and harassment
- [ ] **Calling hours come from the phone number's country, across all of its time zones**, never from the browser that filled in the form (which can be a VPN). AU (6 zones) and US+CA (11 zones) narrow to the window that's OK everywhere. Hawaii and Alaska area codes are special-cased.
- [ ] **Only call countries you serve.** Everything else is blocked, including premium and international revenue-share numbers.
- [ ] **Caps**: at most 3 calls per number per week across all leads, and an account-wide daily cap (`AI_CALL_DAILY_CAP`). Also set geo permissions and spend limits in Twilio and ElevenLabs.
- [ ] **No Sundays; Saturdays 9–17; weekdays 9–20; Australian national public holidays** (Easter computed).
- [ ] **Disclosure at the start of every call**: that it's an AI, that it's recorded, "say stop at any time", and a callback number (TCPA 47 CFR 64.1200(b) for US numbers). The voicemail wording depends on the call type, and there's a branch for people who object to recording.
- [ ] **Consent is per number**: changing the phone resets the consent timestamp. The checkbox is unticked by default, and the consent text version is stored.
- [ ] **`blockReason` is re-checked at queue time and at dial time**, including retries.

## Admin
- [ ] Put **Cloudflare Access** in front of `/admin*` (SSO), on top of the password.
- [ ] **Login lockout**: 10 failures per IP per 15 minutes, logged.
- [ ] **Session token** = `admin.<exp>.<password fingerprint>.<epoch>`, HMAC-signed, HttpOnly, Secure, SameSite=Strict, 3 days. Changing the password or logging out revokes every session.
- [ ] **Same-origin writes**: reject any non-GET whose `Sec-Fetch-Site` or `Origin` isn't same-origin. `c.req.json()` happily parses `text/plain`, so SameSite alone isn't enough against sibling subdomains.
- [ ] `cache-control: no-store` on every admin response.
- [ ] **CSP on `/admin`**: `default-src 'self'; script-src 'self'; … frame-ancestors 'none'`. No inline scripts in the dashboard.
- [ ] **Email previews** are served with `CSP: sandbox`, and shown in `<iframe sandbox>` (without `allow-scripts`) using `srcdoc`.
- [ ] **Secrets are never returned to the browser.** Show only "set" or the last 4 characters (16+ character secrets only).
- [ ] **Webhooks fail closed** (501) when no secret is configured. Use HMAC over the raw body, constant-time comparison and a replay window. Prefer headers over `?secret=` in the URL.
- [ ] **Tracked-link destinations** must be same-origin paths: `^\/(?!\/)`. `//1249767370` is an open redirect.
- [ ] The **first-party PostHog proxy** allowlists methods, paths and the PostHog host, forwards only the headers it needs, and strips `set-cookie`.
- [ ] **HSTS**, `nosniff`, `referrer-policy`, and `X-Frame-Options` (SAMEORIGIN on pages, DENY on admin).

## Privacy (Australia, NZ, US, Canada, UK, EU)
- [ ] **Consent countries** = EU + UK + NO + IS + LI + CH (Cloudflare's `isEUCountry` covers the EU only). Until consent is given there are no advertising cookies (`_fbp`/`_fbc`), no Pixel, no session replay and no forwarding. Provide a "Cookie settings" button so people can withdraw consent, and link the privacy policy from the banner.
- [ ] **Never capture typed text**: field tracking records timing and counters only, and selection/copy tracking ignores form fields and anything that looks like PII.
- [ ] **No plaintext PII to analytics.** PostHog gets the lead id, tier and status, not email, name, phone or free text. Meta and GA4 get SHA-256-hashed match keys only.
- [ ] **Team pings** include the name, ref and a dashboard link only, not email, phone or transcripts.
- [ ] **Imported contacts** (calendly-direct, older history) never get marketing, calls, pings or ad conversions, on any path, including webhooks.
- [ ] **Retention**: delete raw events after 13 months, and strip IP, user agent and precise location from old sessions. Offer erasure on request.
- [ ] **Email**: every message has a physical postal address in both the HTML and text parts, one-click unsubscribe (RFC 8058), and the unsubscribe stops every sequence.
- [ ] **The privacy policy must match the code**: list every processor and its country (Cloudflare, Resend, Calendly, Anthropic, ElevenLabs/Twilio, Vapi, PostHog, Meta, Google, Slack/Discord), the AI calls, AI-written emails, profiling, retention, rights and the complaints route. Have a lawyer review it.

## Known residual items (decide per business)
- No phone OTP before AI calls. Consent plus caps plus country limits reduce the risk, and SMS OTP would remove wrong-number risk.
- Email bombing via new sign-ups: every new address gets the abandoned sequence. Enforce Turnstile (`TURNSTILE_SECRET_KEY`) and consider per-IP caps or double opt-in.
- Shared admin password with no audit log: use Cloudflare Access with SSO for named users.
- No opt-out list for unknown numbers that ask the inbound agent not to call again.
