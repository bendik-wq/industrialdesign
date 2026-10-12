# Gotchas (each one was hit in the original build)

- **Historical imports almost emailed real people.** Importing past Calendly bookings created leads, and logging their old outcomes would have fired no-show, post-call and won emails, team pings and Meta Purchase events. Fix: `isHistorical(lead)` (calendly-direct, or a call more than 14 days old) skips every side effect, and tracking uses `localOnly`.
- **The Calendly link 404'd** after the username changed. Validate the booking URL and refresh it from the API.
- **Reconnecting the Calendly webhook** left a stale subscription. Delete the old one, and never delete subscriptions you didn't create.
- **Main-page A/B stats were inflated by lander visitors.** Exclude `ft_lander` and require a `page_view` on "/".
- **Industry keyword false positives**: "pet" matched inside "competitor". Use word boundaries for short keywords and add plurals and synonyms. Duplicate headlines appeared when two industries shared the word "practice".
- **Variable shadowing in `f.js`**: a second `var sent` broke scroll tracking. Wrap features in IIFEs and use unique names.
- **Creepy personalisation**: "You copied this text…" read like surveillance. Only say back facts that have an explicit `you` line, and keep background facts in the `BACKGROUND` set. Bridge sentences only appear when the topic matches.
- **The personaliser repeated application answers** inside emails that already quoted them. Add `ANSWER_FACTS` to `used` for dossier templates.
- **Template crashes on empty applications** (non-null assertions). Every template needs fallbacks, and a test renders every template against an empty lead.
- **Subject collisions across sequences** (a test asserts subjects are unique). Check when adding templates.
- **Rates over 100%** (more leads than plays, because imports never watched): hide impossible rates.
- **Killing `wrangler dev` with pkill inside a compound shell command** returns exit 144. Run the kill as a separate command.
- **Cloudflare's DNS import came back empty**: recreate the records from a public-DNS snapshot.
- **Users enter the wrong Cloudflare nameservers**: give the exact pair.
- Auto-mode safety classifiers may block DNS, domain and certificate changes. Ask the user to do those steps, or have them approve.
- When a voice prompt changes, the live ElevenLabs agent doesn't update until you re-run provision.

## From the security review
- **Lead text became HTML in emails.** The new follow-up templates quoted why-now and booking answers raw, which let anyone send phishing links from your domain to any inbox (email addresses aren't verified). Escape and defang at the source.
- **Email-match takeover**: re-entering a known email overwrote the phone number, cleared the unsubscribe and linked the attacker's browser to the lead.
- **Fake bookings**: `/api/booking/client` (a browser report) triggered the confirmation AI call, emails and the Meta Schedule event. Combined with an unverified phone number, that made Sam a free robocaller to any number.
- **Calling hours came from the browser's IP time zone**, so a VPN made us ring someone at night.
- **Rules-mode personalisation quoted the FAQ question from the beacon verbatim**, which a script can set to anything.
- **Cloudflare `isEUCountry` excludes the UK.**
- **`getSelection()` returns text typed in a textarea**, so "selected text" tracking captured form input.
- **The privacy policy said "we never make AI calls"** after AI calls were added. Keep the policy in step with the code.
- Agents running security work can be stopped by model safeguards partway through. Frame tasks as defensive review of the owner's own code, and keep the evidence you already have.
