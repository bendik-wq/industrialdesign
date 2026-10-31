# Claude (MCP), Zapier and the support inbox

## Claude connector (MCP server)

Endpoint: `https://<your apply domain>/mcp` (MCP Streamable HTTP, JSON responses, stateless).

1. Funnel HQ → Integrations → **Claude (MCP connector)** → **Generate token**. The token is shown once.
   Generating a new one stops the old one at once. (Or set `MCP_TOKEN` as a Worker secret.)
2. Connect a client:
   - **Claude Code**:
     `claude mcp add --transport http funnel-hq https://<domain>/mcp --header "Authorization: Bearer <token>"`
   - **Claude Desktop**: Settings → Connectors → Add custom connector with the secret URL below, or in
     `claude_desktop_config.json`:
     `{"mcpServers":{"funnel-hq":{"command":"npx","args":["-y","mcp-remote","https://<domain>/mcp","--header","Authorization: Bearer <token>"]}}}`
   - **claude.ai**: Settings → Connectors → Add custom connector (Team/Enterprise: an owner adds it).
     claude.ai custom connectors can't send a static header, so use the secret URL
     `https://<domain>/mcp/k/<token>`. Treat that URL like a password.

Protocol: dual-era. Modern clients (2026-07-28: per-request `_meta` version, `MCP-Protocol-Version`,
`Mcp-Method`, `Mcp-Name` headers checked against the body, `server/discover`) and legacy clients
(2025-03-26, 2025-06-18, 2025-11-25: `initialize` then `notifications/initialized`). No session ids are minted;
GET and DELETE answer 405. Requests carrying an `Origin` header must come from this site, claude.ai,
claude.com or `MCP_ALLOWED_ORIGINS`.

Read tools: `funnel_stats`, `find_leads`, `lead_detail`, `bookings`, `deals`, `ad_performance`, `webinar_stats`,
`sprint_board`, `client_health`, `support_queue`, `recent_actions`. Each result links to the Funnel HQ view it came from.

Write tools only create approvals (`proposeAction`): `propose_lead_note` (kind `lead.note`),
`propose_email_to_lead` (`mcp.email`), `propose_client_checkin` (`cs.checkin`), `propose_support_reply`
(`support.reply`). Nothing happens until someone approves, unless the owner sets that kind to auto.
Other modules add tools with `registerMcpTool()` in `src/mcp/tools.ts`.

## Zapier and other automation tools

**Out (events):** Integrations → Zapier & webhooks → Add hook (a Zapier "Catch Hook" URL) and pick events:
`lead.created`, `ticket.paid`, `booking.created`, `deal.won`, `deposit.paid`, `sprint.paid`, `refund.created`.
Events are detected from the database every 5 minutes (first run sets a cursor, no backfill). Each POST is
`{id, event, created_at, data}` with `X-Funnel-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`.
Retries: 1 min, 5 min, 30 min, 2 h, 6 h, 24 h; a `410` turns the hook off.

**In (actions):** generate the Zapier secret, then POST JSON with header `X-Zapier-Secret: <secret>` to
`/hooks/zapier/create-lead` (`{email, first_name, last_name, phone, source, note}`) or
`/hooks/zapier/add-note` (`{email | lead_id | ref, note}`).

## Support inbox

- **Resend inbound**: Funnel HQ → Support → Connect support inbox (creates an `email.received` webhook to
  `/hooks/resend-inbound` and stores its signing secret in `SUPPORT_RESEND_WEBHOOK_SECRET`). Add a receiving
  domain (MX) in Resend, or use the `<id>.resend.app` address and forward support@ to it. The webhook carries
  metadata only; the body is fetched from `GET https://api.resend.com/emails/receiving/{id}`.
- **Any forwarder** (Zapier Email Parser, Make, a Cloudflare Email Worker): POST `{from, subject, text, html,
  message_id, in_reply_to}` to `/hooks/support-email` with `X-Support-Secret: <SUPPORT_INBOUND_SECRET>`.
- Room questions (masterclass questions, live room chat questions, challenge hot seats) are imported every 5 minutes.
