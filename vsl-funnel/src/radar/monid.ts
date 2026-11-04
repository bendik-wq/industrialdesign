/**
 * Radar: the Monid client (https://api.monid.ai/v1). Every call is server-side from the Worker with the owner's
 * MONID_API_KEY, short, and parsed defensively: Monid's discover response is not documented to us, and run output
 * comes from many different tools.
 *
 *  - discover {query, limit}       → candidate tools (provider + endpoint + description, maybe a price)
 *  - inspect {provider, endpoint}  → the tool's inputSchema and price
 *  - run {provider, endpoint, input} → 200 COMPLETED with output, or 202 RUNNING with a runId to poll
 *  - GET /runs/:runId              → RUNNING | COMPLETED | FAILED | BLOCKED | STOPPED | TIME_OUT
 *
 * No call here waits for a run to finish: a 202 is stored and polled by the cron (src/radar/engine.ts).
 */

export const MONID_BASE = 'https://api.monid.ai/v1';
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface MonidPrice { type: 'PER_CALL' | 'PER_RESULT' | string; amount: number; flatFee: number; currency: string; notes?: string }
export interface MonidTool {
  provider: string; endpoint: string; name?: string; description?: string; price?: MonidPrice | null;
  inputSchema?: unknown; docUrl?: string; summary?: string; notes?: string;
}
export type RunStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED' | 'STOPPED' | 'TIME_OUT' | string;
export interface MonidRun { runId: string; status: RunStatus; output: unknown; resultCount: number | null; costMicros: number | null; error?: string }

export class MonidError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'MonidError'; }
}

export interface MonidClient {
  discover(query: string, limit?: number): Promise<MonidTool[]>;
  inspect(provider: string, endpoint: string): Promise<MonidTool>;
  run(provider: string, endpoint: string, input: unknown): Promise<MonidRun>;
  getRun(runId: string): Promise<MonidRun>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown): number | null => {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && isFinite(Number(v))) return Number(v);
  return null;
};

/** A price in any shape Monid may give, as {type, amount, flatFee, currency}. */
export function parsePrice(v: unknown): MonidPrice | null {
  if (!isObj(v)) {
    const n = num(v);
    return n == null ? null : { type: 'PER_CALL', amount: n, flatFee: 0, currency: 'USD' };
  }
  const amount = num(v.amount) ?? num(v.value) ?? num(v.price) ?? num(v.perResult) ?? num(v.per_result);
  if (amount == null && num(v.flatFee) == null) return null;
  return {
    type: str(v.type).toUpperCase() || (v.perResult != null || v.per_result != null ? 'PER_RESULT' : 'PER_CALL'),
    amount: amount ?? 0,
    flatFee: num(v.flatFee) ?? num(v.flat_fee) ?? 0,
    currency: str(v.currency) || 'USD',
    notes: str(v.notes) || undefined,
  };
}

/** Money in micro-dollars from an amount and its currency ("USD" or "MICRO_DOLLAR"). */
export function toMicros(amount: number, currency = 'USD'): number {
  if (!isFinite(amount) || amount < 0) return 0;
  if (/micro/i.test(currency)) return Math.round(amount);
  if (/cent/i.test(currency)) return Math.round(amount * 10_000);
  return Math.round(amount * 1_000_000);
}

/** What a run is expected to cost: the flat fee plus the per-call or per-result amount, in micro-dollars. */
export function estimateMicros(price: MonidPrice | null | undefined, results: number): number {
  if (!price) return 0;
  const per = price.type === 'PER_RESULT' ? price.amount * Math.max(1, results) : price.amount;
  return toMicros(per + (price.flatFee || 0), price.currency);
}

/** One tool from any object that names a provider and an endpoint. */
function toolFrom(o: Record<string, unknown>): MonidTool | null {
  // {tool: {...}} or {endpoint: {path, ...}}: lift the inner object once.
  if (isObj(o.tool)) { const { tool, ...rest } = o; return toolFrom({ ...rest, ...(tool as Record<string, unknown>) }); }
  if (isObj(o.endpoint)) { const e = o.endpoint as Record<string, unknown>; return toolFrom({ ...o, ...e, endpoint: e.endpoint ?? e.path ?? e.id ?? '' }); }
  const provider = str(o.provider) || str(o.providerId) || str(o.provider_id) || (isObj(o.provider) ? str(o.provider.id) || str(o.provider.slug) : '');
  let endpoint = str(o.endpoint) || str(o.path) || str(o.endpointPath) || str(o.actor) || str(o.actorId);
  if (!provider || !endpoint) return null;
  if (!endpoint.startsWith('/')) endpoint = `/${endpoint.replace(/~/g, '/')}`;
  return {
    provider, endpoint,
    name: str(o.name) || str(o.title) || str(o.providerName) || undefined,
    description: (str(o.description) || str(o.summary)).slice(0, 600) || undefined,
    price: parsePrice(o.price ?? o.pricing),
    inputSchema: o.inputSchema ?? o.input_schema,
    docUrl: str(o.docUrl) || str(o.doc_url) || undefined,
  };
}

/** Find every tool in a discover response, whatever the wrapper: an array, {results}, {tools}, {data: {items}}. */
export function parseDiscover(body: unknown, limit = 20): MonidTool[] {
  const out: MonidTool[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 5 || out.length >= limit) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (!isObj(v)) return;
    const t = toolFrom(v);
    if (t) {
      const k = `${t.provider} ${t.endpoint}`;
      if (!seen.has(k)) { seen.add(k); out.push(t); }
      return;
    }
    for (const x of Object.values(v)) if (x && typeof x === 'object') walk(x, depth + 1);
  };
  walk(body, 0);
  return out;
}

/** Billing in micro-dollars: billing.actualCost {value, unit|currency}, else the run's price, else null. */
export function costOf(body: Record<string, unknown>): number | null {
  const b = isObj(body.billing) ? body.billing : null;
  const actual = b && isObj(b.actualCost) ? b.actualCost : b && isObj(b.cost) ? b.cost : null;
  if (actual) {
    const v = num(actual.value) ?? num(actual.amount);
    if (v != null) return toMicros(v, str(actual.unit) || str(actual.currency) || 'MICRO_DOLLAR');
  }
  if (b) { const v = num(b.actualCostMicros) ?? num(b.costMicros); if (v != null) return Math.round(v); }
  return null;
}

export function parseRun(body: unknown, httpStatus = 200): MonidRun {
  const o = isObj(body) ? body : {};
  const runId = str(o.runId) || str(o.id) || str(o.run_id);
  let status = str(o.status).toUpperCase();
  if (!status) status = httpStatus === 202 ? 'RUNNING' : o.output !== undefined ? 'COMPLETED' : 'RUNNING';
  const err = str(o.error) || (isObj(o.error) ? str(o.error.message) : '') || str(o.message);
  return {
    runId, status, output: o.output ?? o.results ?? o.data ?? null,
    resultCount: num(o.resultCount) ?? (Array.isArray(o.output) ? o.output.length : null),
    costMicros: costOf(o),
    error: status === 'COMPLETED' || status === 'RUNNING' ? undefined : err || undefined,
  };
}

export const RUN_DONE = new Set(['COMPLETED', 'FAILED', 'BLOCKED', 'STOPPED', 'TIME_OUT', 'ABORTED', 'CANCELLED']);

/** The client. `fetchFn` is injectable for tests; every request gives up after `timeoutMs`. */
export function monidClient(apiKey: string, fetchFn: FetchFn = (i, r) => fetch(i, r), timeoutMs = 25_000): MonidClient {
  if (!apiKey) throw new MonidError('Add the Monid API key in Integrations first.', 0);
  const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
    const res = await fetchFn(`${MONID_BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = isObj(json) ? str(json.error) || (isObj(json.error) ? str(json.error.message) : '') || str(json.message) : '';
      if (res.status === 401 || res.status === 403) throw new MonidError('Monid did not accept the API key. Check it in Integrations.', res.status);
      if (res.status === 402) throw new MonidError('The Monid account is out of credit.', res.status);
      if (res.status === 429) throw new MonidError('Monid asked us to slow down. The next check tries again.', res.status);
      throw new MonidError(`Monid answered ${res.status}${msg ? `: ${msg.slice(0, 200)}` : ''}`, res.status);
    }
    return { status: res.status, json };
  };
  return {
    async discover(query, limit = 10) {
      const { json } = await call('POST', '/discover', { query, limit });
      return parseDiscover(json, limit * 2);
    },
    async inspect(provider, endpoint) {
      const { json } = await call('POST', '/inspect', { provider, endpoint });
      const o = isObj(json) ? json : {};
      const t = toolFrom({ provider, endpoint, ...o }) ?? { provider, endpoint };
      return { ...t, provider, endpoint, name: str(o.providerName) || t.name, summary: str(o.summary) || undefined, notes: str(o.notes) || undefined };
    },
    async run(provider, endpoint, input) {
      const { status, json } = await call('POST', '/run', { provider, endpoint, input });
      const r = parseRun(json, status);
      if (!r.runId && r.status === 'RUNNING') throw new MonidError('Monid started a run but gave no run id.', status);
      return r;
    },
    async getRun(runId) {
      const { status, json } = await call('GET', `/runs/${encodeURIComponent(runId)}`);
      return { ...parseRun(json, status), runId };
    },
  };
}
