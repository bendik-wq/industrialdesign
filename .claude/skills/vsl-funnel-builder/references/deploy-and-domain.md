# Deploy, custom domain, DNS, deliverability

## Deploy
```bash
npm install
npx wrangler d1 create <name>            # put database_id in wrangler.jsonc (binding DB)
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put ADMIN_PASSWORD   # long random value
npx wrangler secret put SESSION_SECRET
npm run check && npm run deploy          # CI or a scoped API token: CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```
`wrangler.jsonc` needs: `main`, `compatibility_date`, the assets binding to `public/`, the D1 binding `DB`, and the cron trigger `*/5 * * * *`.

Local: put `ADMIN_PASSWORD` and `SESSION_SECRET` in `.dev.vars` (gitignored). Run `npx wrangler d1 migrations apply DB --local`, then `npx wrangler dev --test-scheduled`. Trigger the cron with `curl localhost:8787/__scheduled?cron=*/5+*+*+*+*` (or `/cdn-cgi/handler/scheduled`). Use `npm run simulate -- 150` to push synthetic traffic through the real endpoints.

## Custom domain (domain at a registrar such as Porkbun → Cloudflare)
1. Add the zone in Cloudflare, then **copy the exact two nameservers Cloudflare assigns** into the registrar. Every zone gets a different pair, and users often paste the wrong ones.
2. Cloudflare's automatic DNS import can come back empty. Before switching nameservers, snapshot the existing public DNS (A, MX, TXT, CNAME, DKIM) and recreate every record. Otherwise email breaks.
3. Attach `apply.<domain>` to the Worker as a Custom Domain (Workers → Settings → Domains & Routes). It survives deploys.
4. Update `PUBLIC_URL` and point every webhook at the new domain: Calendly (create the new subscription, delete the old one), the ElevenLabs post-call and init webhooks, WhatsApp. Keep the old workers.dev URL working during the cutover.
5. Protect `/admin*` with Cloudflare Access.

## Email authentication
- **SPF**: one TXT record at the apex, merging every sender, e.g. `v=spf1 include:_spf.google.com include:<other senders> -all`. Never publish two SPF records.
- **DKIM**: add the provider's key (Google Workspace `google._domainkey`, Resend's records, etc.). For Google, the user then has to click "Start authentication" in the Admin console.
- **DMARC**: start with `p=none; rua=mailto:…`, then tighten to quarantine or reject once reports are clean.
- In a sandbox, DNS lookups can be intercepted. Verify with the Cloudflare API, RDAP or zone status rather than `dig`.
