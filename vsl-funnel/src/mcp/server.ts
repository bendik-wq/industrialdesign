import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { safeEqual } from '../lib/crypto';
import { overLimit } from '../lib/ratelimit';
import { TOOLS } from './tools';

/**
 * Remote MCP server for Claude at /mcp (Streamable HTTP, JSON responses, stateless).
 *
 * Dual-era, per the MCP spec:
 *  - Modern clients (protocol 2026-07-28) send no handshake: every request carries its protocol version in
 *    params._meta and the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers, which must match the body.
 *    server/discover advertises our versions; results carry resultType and serverInfo.
 *  - Legacy clients (2025-03-26 to 2025-11-25) send initialize, then notifications/initialized (202), then
 *    tools/list and tools/call. We never mint an Mcp-Session-Id (sessions are optional there).
 * Auth: `Authorization: Bearer <MCP_TOKEN>` (constant-time compare), or the secret connector URL
 * /mcp/k/<MCP_TOKEN> for clients that cannot send a header (claude.ai custom connectors without OAuth).
 * Write tools only create proposals (see tools.ts).
 */

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const SERVER_INFO = { name: 'funnel-hq', title: 'Funnel HQ (G&L M&A Advisory)', version: '1.0.0' };
export const INSTRUCTIONS = 'Funnel HQ for G&L M&A Advisory: leads, calls, deals, ads, webinars, the Sprint board, client health and the support queue. Read tools return numbers from the same queries as the Funnel HQ views, with a link to the view. Write tools (propose_*) never act: they create an approval in Funnel HQ that a person decides on. Do not invent numbers; quote what the tools return.';

type Json = Record<string, unknown>;
type Id = string | number | null;

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const ERR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, headerMismatch: -32020, unsupportedVersion: -32022 };

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(body == null ? null : JSON.stringify(body), { status, headers: { ...(body == null ? {} : { 'content-type': 'application/json' }), 'cache-control': 'no-store', ...extra } });
const rpcError = (id: Id, code: number, message: string, data?: unknown) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** Decode the Base64 sentinel form (=?base64?...?=) used for non-ASCII header values. */
export function decodeHeaderValue(v: string | null) {
  if (v == null) return null;
  const m = /^=\?base64\?(.*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
}

export function tokenOk(expected: string, given: string | null | undefined) {
  return Boolean(expected && given && safeEqual(given, expected));
}

export function originAllowed(rt: Runtime, origin: string | null) {
  if (!origin) return true; // server-side clients (Claude Code, Claude Desktop, claude.ai connectors) send none
  const allowed = new Set([new URL(rt.origin).origin, 'https://claude.ai', 'https://claude.com', 'https://www.claude.ai']);
  for (const o of String(rt.settings.MCP_ALLOWED_ORIGINS ?? '').split(',')) if (o.trim()) allowed.add(o.trim().replace(/\/+$/, ''));
  return allowed.has(origin);
}

const toolList = () => TOOLS.map((t) => ({
  name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
  annotations: t.write ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } : { readOnlyHint: true, openWorldHint: false },
}));

async function callTool(rt: Runtime, params: Json) {
  const name = String(params.name ?? '');
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { error: { code: ERR.invalidParams, message: `Unknown tool: ${name}` } };
  const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json;
  try {
    const out = await tool.run(rt, args);
    let text = JSON.stringify(out);
    if (text.length > 80_000) text = `${text.slice(0, 80_000)}… (truncated; narrow the range or filters)`;
    return { result: { content: [{ type: 'text', text }], structuredContent: text.length <= 80_000 ? out : undefined, isError: false } };
  } catch (e) {
    return { result: { content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool failed.' }], isError: true } };
  }
}

/** Handle one HTTP request to the MCP endpoint. `pathToken` is the token from /mcp/k/<token>, if used. */
export async function handleMcp(rt: Runtime, req: Request, pathToken?: string): Promise<Response> {
  const origin = req.headers.get('origin');
  const cors: Record<string, string> = origin && originAllowed(rt, origin)
    ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id', 'access-control-expose-headers': 'www-authenticate', vary: 'origin' }
    : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: originAllowed(rt, origin) ? 204 : 403, headers: { ...cors, 'access-control-allow-methods': 'POST, OPTIONS' } });
  if (!originAllowed(rt, origin)) return json(403, rpcError(null, ERR.invalidRequest, 'Origin not allowed'));
  // Auth before anything else is revealed.
  const expected = String(rt.settings.MCP_TOKEN ?? '').trim();
  if (!expected) return json(503, rpcError(null, ERR.internal, 'The MCP server is off: generate a token in Funnel HQ → Integrations → Claude (MCP).'), cors);
  const header = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '')?.[1]?.trim();
  if (!tokenOk(expected, header ?? pathToken)) return json(401, rpcError(null, ERR.invalidRequest, 'Unauthorized'), { ...cors, 'www-authenticate': 'Bearer realm="funnel-hq-mcp"' });
  // No standalone SSE stream and no session termination: both answer 405.
  if (req.method !== 'POST') return json(405, null, { ...cors, allow: 'POST' });

  let msg: unknown;
  try { msg = JSON.parse(await req.text()); } catch { return json(400, rpcError(null, ERR.parse, 'Parse error'), cors); }
  if (Array.isArray(msg)) return json(400, rpcError(null, ERR.invalidRequest, 'Batches are not supported'), cors);
  if (!msg || typeof msg !== 'object' || (msg as Json).jsonrpc !== '2.0') return json(400, rpcError(null, ERR.invalidRequest, 'Invalid request'), cors);
  const m = msg as Json;
  if (typeof m.method !== 'string') return json(202, null, cors); // a response from the client: accepted, nothing to do
  if (!('id' in m)) return json(202, null, cors); // notifications (initialized, cancelled): accepted
  const id = (typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null) as Id;
  const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Json;
  const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Json;
  const reply = (body: unknown, status = 200) => json(status, body, cors);

  if (await overLimit(rt.env, 'mcp:all', 3000).catch(() => false)) return reply(rpcError(id, ERR.internal, 'Rate limited, try again later'), 429);

  // ── Legacy handshake ──
  if (m.method === 'initialize') {
    const requested = String(params.protocolVersion ?? '');
    const version = LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
    return reply({ jsonrpc: '2.0', id, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS } });
  }

  // ── Version: modern from _meta, legacy from the header (absent = 2025-03-26) ──
  const headerVersion = req.headers.get('mcp-protocol-version');
  const metaVersion = typeof meta[META_VERSION] === 'string' ? String(meta[META_VERSION]) : null;
  const version = metaVersion ?? headerVersion ?? '2025-03-26';
  if (!SUPPORTED_VERSIONS.includes(version)) return reply(rpcError(id, ERR.unsupportedVersion, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: version }), 400);
  const modern = MODERN_VERSIONS.includes(version);
  if (modern) {
    const mismatch = (what: string) => reply(rpcError(id, ERR.headerMismatch, `Header mismatch: ${what}`), 400);
    if (headerVersion !== version) return mismatch(`MCP-Protocol-Version header '${headerVersion ?? ''}' does not match body '${version}'`);
    if (req.headers.get('mcp-method') !== m.method) return mismatch(`Mcp-Method header does not match body method '${m.method}'`);
    if (m.method === 'tools/call' && decodeHeaderValue(req.headers.get('mcp-name')) !== String(params.name ?? '')) return mismatch('Mcp-Name header does not match params.name');
  }
  const done = (result: Json) => reply({ jsonrpc: '2.0', id, result: modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta as Json | undefined), 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : result });

  switch (m.method) {
    case 'ping':
      return done({});
    case 'server/discover':
      return done({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: 'private' });
    case 'tools/list':
      return done(modern ? { tools: toolList(), ttlMs: 300_000, cacheScope: 'private' } : { tools: toolList() });
    case 'tools/call': {
      const r = await callTool(rt, params);
      if ('error' in r && r.error) return reply({ jsonrpc: '2.0', id, error: r.error });
      return done(r.result as Json);
    }
    case 'resources/list':
      return done({ resources: [] });
    case 'prompts/list':
      return done({ prompts: [] });
    default:
      return reply(rpcError(id, ERR.methodNotFound, `Method not found: ${m.method}`), modern ? 404 : 200);
  }
}

export const mcpRoute = (c: Context<AppEnv>) => handleMcp(runtimeFrom(c), c.req.raw, c.req.param('token'));
