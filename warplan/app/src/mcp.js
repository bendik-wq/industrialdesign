// Remote MCP server (Model Context Protocol, Streamable HTTP transport, JSON responses).
// Lets Claude (Code, Desktop, claude.ai), Cursor, n8n, ChatGPT and any MCP client drive Warplan with the same tools Josh
// uses. Auth: a Warplan API token, as `Authorization: Bearer wp_...` or in the URL (/mcp/wp_...) for clients that can't
// set headers. Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
import { mcpTools, runTool } from "./tools.js";
import { aiEnv } from "./keys.js";
import { hookEmitter } from "./pipeline.js";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER = { name: "warplan", title: "Warplan", version: "2.1.0" };
const INSTRUCTIONS = `Warplan is an acquisition workspace for owners buying competitors with little or no money down.
Use search_pipeline to find targets (never guess ids), get_target for detail, pipeline_overview for the big picture.
Deal rules: the buyer keeps majority voting control and DSCR (free cash flow / total annual debt service) stays at 1.5x or more every year; use model_deal for any structure maths.
On a first call with an owner there is no talk of numbers. Writes (create/update/log/draft) happen in the user's real workspace and are visible to their team.`;

const rpc = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const reply = (body, status = 200, extra = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { ...(body == null ? {} : { "Content-Type": "application/json" }), ...extra } });

export async function handleMcp(request, env, ctx, exec) {
  if (request.method === "GET") return reply({ error: "This MCP server answers POST requests only (no SSE stream)." }, 405, { Allow: "POST, DELETE" });
  if (request.method === "DELETE") return reply(null, 204);
  if (request.method !== "POST") return reply(null, 405, { Allow: "POST, DELETE" });
  const version = request.headers.get("MCP-Protocol-Version");
  if (version && !VERSIONS.includes(version)) return reply(rpcError(null, -32600, `Unsupported MCP-Protocol-Version ${version}. Supported: ${VERSIONS.join(", ")}`), 400);
  let msg;
  try { msg = await request.json(); } catch { return reply(rpcError(null, -32700, "Parse error"), 400); }
  const batch = Array.isArray(msg), list = batch ? msg : [msg];
  if (!list.length || list.length > 20) return reply(rpcError(null, -32600, "Invalid request"), 400);
  const hooks = hookEmitter(env, ctx.accountId, (p) => exec.waitUntil(p));
  let ai = null;
  const out = [];
  for (const m of list) {
    if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") { if (m && "id" in m) out.push(rpcError(m.id, -32600, "Invalid request")); continue; }
    const isNotification = !("id" in m);
    if (isNotification) continue; // notifications/initialized, notifications/cancelled, ...
    out.push(await dispatch(m, async () => (ai ??= await aiEnv(env, ctx)), env, ctx, hooks));
  }
  if (!out.length) return reply(null, 202);
  return reply(batch ? out : out[0]);
}

async function dispatch(m, getAi, env, ctx, hooks) {
  const p = m.params || {};
  switch (m.method) {
    case "initialize":
      return rpc(m.id, {
        protocolVersion: VERSIONS.includes(p.protocolVersion) ? p.protocolVersion : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });
    case "server/discover": // stateless revision of the spec
      return rpc(m.id, { supportedVersions: VERSIONS, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    case "ping":
      return rpc(m.id, {});
    case "tools/list":
      return rpc(m.id, { tools: mcpTools() });
    case "resources/list":
      return rpc(m.id, { resources: [] });
    case "prompts/list":
      return rpc(m.id, { prompts: [] });
    case "tools/call": {
      if (typeof p.name !== "string") return rpcError(m.id, -32602, "params.name is required");
      if (!mcpTools().some((t) => t.name === p.name)) return rpcError(m.id, -32602, `Unknown tool: ${p.name}`);
      const r = await runTool(env, ctx, await getAi(), hooks, p.name, p.arguments || {});
      return rpc(m.id, { content: [{ type: "text", text: JSON.stringify(r.result, null, 2) }], structuredContent: r.result, isError: !r.ok });
    }
    default:
      return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}
