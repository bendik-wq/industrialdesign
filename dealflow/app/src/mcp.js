// Remote MCP server (Streamable HTTP transport, JSON responses). Point Claude or any MCP client at
//   https://<host>/mcp   with header   Authorization: Bearer <API_TOKEN>
// so the buyer's own assistant can search registries, value companies and work the pipeline.

const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "list_sources",
    description: "Countries Dealflow can search (with whether each is ready), their regions, and the industries available.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "start_search",
    description: "Start a background search of an official company registry. Returns the search id; poll list_searches for progress.",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", enum: ["fr", "no", "uk", "us"], description: "fr France, no Norway, uk United Kingdom, us United States" },
        industry: { type: "string", description: "Industry id from list_sources, e.g. hvac, dental, accounting" },
        region: { type: "string", description: "Region code from list_sources (fr département e.g. 69, no county e.g. 46) or free text city for uk/us" },
        minStaff: { type: "integer", minimum: 0, description: "Minimum registered headcount" },
      },
      required: ["country", "industry"],
      additionalProperties: false,
    },
  },
  {
    name: "list_searches",
    description: "All searches with status, progress and how many companies scored 'worth a call' or better.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "find_targets",
    description: "Ranked acquisition targets. Each has owner name and age, founded year, staff, revenue, valuation midpoint, fit score and verdict.",
    inputSchema: {
      type: "object",
      properties: {
        search: { type: "integer", description: "Limit to one search id" },
        country: { type: "string" },
        q: { type: "string", description: "Free text over name, town, owner, postcode" },
        minOwnerAge: { type: "integer" },
        minStaff: { type: "integer" },
        minFit: { type: "integer", description: "0–100; 50+ is 'worth a call', 65+ 'strong target'" },
        sort: { type: "string", enum: ["fit", "succession", "size", "owner_age", "founded", "staff", "value", "name"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_company",
    description: "Full record for one company: people on record with ages, financials, score breakdown, pipeline status and notes.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "value_deal",
    description: "Indicative valuation range and three seller-finance structures with year-by-year debt-service coverage (DSCR) for a company. Optionally test a specific price.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, price: { type: "number", description: "Purchase price in the company's currency" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "update_pipeline",
    description: "Set a company's pipeline stage and/or replace its notes.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        status: { type: "string", enum: ["New", "Researching", "Contacted", "Conversation", "NDA signed", "Financials", "LOI", "Passed", "Not a fit"] },
        notes: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "write_brief",
    description: "One-page acquisition brief for a company: why it could be a deal, risks, opening angle, first-call questions.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "add_company",
    description: "Add one company by its registry number (Norwegian org.nr or French SIREN), score and value it.",
    inputSchema: {
      type: "object",
      properties: { country: { type: "string", enum: ["fr", "no"] }, number: { type: "string" } },
      required: ["country", "number"],
      additionalProperties: false,
    },
  },
];

export async function handleMcp(request, ops) {
  if (request.method === "GET") return new Response("Use POST (Streamable HTTP, JSON responses).", { status: 405, headers: { Allow: "POST" } });
  if (request.method === "DELETE") return new Response(null, { status: 204 });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let body;
  try { body = await request.json(); } catch { return rpcError(null, -32700, "Parse error"); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map((m) => handle(m, ops)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(batch ? replies : replies[0]), { headers: { "Content-Type": "application/json" } });
}

async function handle(msg, ops) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return msg?.id != null ? err(msg.id, -32600, "Invalid request") : null;
  if (msg.id == null) return null; // notification (e.g. notifications/initialized)
  switch (msg.method) {
    case "initialize":
      return ok(msg.id, {
        protocolVersion: msg.params?.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "dealflow", title: "Dealflow acquisition targets", version: "1.0.0" },
        instructions: "Find owner-operated companies whose owners are likely to sell, value them, and structure seller-financed offers. Typical flow: list_sources → start_search → list_searches (until done) → find_targets → get_company / value_deal → write_brief → update_pipeline.",
      });
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, { tools: TOOLS });
    case "tools/call": {
      const { name, arguments: args = {} } = msg.params || {};
      if (!TOOLS.find((t) => t.name === name)) return err(msg.id, -32602, `Unknown tool: ${name}`);
      try {
        const result = await ops[name](args);
        return ok(msg.id, { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(msg.id, { isError: true, content: [{ type: "text", text: e.message || String(e) }] });
      }
    }
    default:
      return err(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcError = (id, code, message) => new Response(JSON.stringify(err(id, code, message)), { status: 400, headers: { "Content-Type": "application/json" } });
