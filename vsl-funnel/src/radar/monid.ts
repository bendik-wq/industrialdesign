/**
 * Radar: the Monid client (https://api.monid.ai/v1). Every call is server-side from the Worker with the owner's
 * MONID_API_KEY, short, and parsed defensively: run output comes from many different tools.
 *
 *  - discover {query, limit}       → candidate tools (provider + endpoint + description, maybe a price)
 *  - inspect {provider, endpoint}  → {provider, providerName, endpoint, description, summary, input: {body: <JSON schema>,
 *                                     bodyType}, price, docUrl, notes, ...}
 *  - run {provider, endpoint, input: {body}} → {runId, status: 'RUNNING' | 'COMPLETED', price, ...}
 *  - GET /runs/:runId              → {runId, status, input, providerResponse: {httpStatus, error?}, price, cost: {value,
 *                                     currency} in dollars, resultCount, billedUnits, output}
 *
 * Prices: {type: 'PER_CALL' | 'PER_RESULT', amount: {value, currency}} or {type: 'PER_UNIT_MATRIX', amount (the base),
 * selectors: [{key, in}], variants: [{when: {route}, price: {type, amount}}]}: the variant matching the input wins.
 * A run that COMPLETED with providerResponse.httpStatus >= 400 failed (the provider refused the input; cost 0).
 *
 * No call here waits for a run to finish: a 202 is stored and polled by the cron (src/radar/engine.ts).
 */

export const MONID_BASE = 'https://api.monid.ai/v1';
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface PriceVariant { when: Record<string, string>; type: string; amount: number; currency: string; label?: string; flatFee?: number }
export interface MonidPrice {
  type: 'PER_CALL' | 'PER_RESULT' | 'PER_UNIT_MATRIX' | string; amount: number; flatFee: number; currency: string; notes?: string;
  /** PER_UNIT_MATRIX: which input fields pick the variant (`in` is 'body' for every known tool). */
  selectors?: { key: string; in: string }[]; variants?: PriceVariant[];
}
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

/** An amount as a number plus its currency: 0.005, "0.005" or {value, currency}. */
function money(v: unknown, currency: string): { n: number | null; currency: string } {
  if (isObj(v)) return { n: num(v.value) ?? num(v.amount), currency: str(v.currency) || str(v.unit) || currency };
  return { n: num(v), currency };
}

/** A price in any shape Monid may give, as {type, amount, flatFee, currency} (plus the variants of a matrix). */
export function parsePrice(v: unknown): MonidPrice | null {
  if (!isObj(v)) {
    const n = num(v);
    return n == null ? null : { type: 'PER_CALL', amount: n, flatFee: 0, currency: 'USD' };
  }
  // TIERED {amount, default: {type, amount, flatFee}, tiers: [{when, price}]}: the default tier applies (the other tiers
  // are options Radar never asks for, such as hosting the video).
  if (str(v.type).toUpperCase() === 'TIERED' && isObj(v.default)) {
    const d = parsePrice(v.default);
    if (d) return { ...d, notes: d.notes ?? (Array.isArray(v.notes) ? v.notes.map(str).filter(Boolean).join(' ').slice(0, 400) || undefined : undefined) };
  }
  const a = money(v.amount ?? v.value ?? v.price ?? v.perResult ?? v.per_result, str(v.currency) || 'USD');
  const fee = money(v.flatFee ?? v.flat_fee, a.currency);
  const variants: PriceVariant[] = [];
  if (Array.isArray(v.variants)) {
    for (const x of v.variants) {
      if (!isObj(x) || !isObj(x.when)) continue;
      // Monid's {when, price: {type, amount, flatFee?}}, or a variant already parsed and stored ({when, type, amount, currency, flatFee?}).
      const p = parsePrice(x.price ?? { type: x.type, amount: x.amount, currency: x.currency, flatFee: x.flatFee });
      if (p) variants.push({ when: Object.fromEntries(Object.entries(x.when).map(([k, w]) => [k, str(w)])), type: p.type, amount: p.amount, currency: p.currency, ...(p.flatFee ? { flatFee: p.flatFee } : {}), label: str(x.label) || undefined });
    }
  }
  if (a.n == null && fee.n == null && !variants.length) return null;
  const notes = Array.isArray(v.notes) ? v.notes.map(str).filter(Boolean).join(' ') : str(v.notes);
  const out: MonidPrice = {
    type: str(v.type).toUpperCase() || (v.perResult != null || v.per_result != null ? 'PER_RESULT' : 'PER_CALL'),
    amount: a.n ?? 0,
    flatFee: fee.n ?? 0,
    currency: a.currency,
    notes: notes.slice(0, 400) || undefined,
  };
  if (variants.length) {
    out.variants = variants;
    out.selectors = Array.isArray(v.selectors) ? v.selectors.filter(isObj).map((x) => ({ key: str(x.key), in: str(x.in) || 'body' })).filter((x) => x.key) : [];
  }
  return out;
}

/**
 * The price that applies to one input, always a plain PER_CALL or PER_RESULT price: for a matrix, the variant whose
 * `when` matches the input's body (the route the input picks), else the base amount per call.
 */
export function priceFor(price: MonidPrice | null | undefined, input?: unknown): MonidPrice | null {
  if (!price) return null;
  if (!price.variants?.length) return price;
  const b = isObj(input) && isObj(input.body) ? input.body : isObj(input) ? input : {};
  const hit = price.variants.find((v) => Object.entries(v.when).every(([k, w]) => str(b[k]) === w));
  if (hit) return { type: hit.type, amount: hit.amount, flatFee: hit.flatFee ?? 0, currency: hit.currency };
  return { type: 'PER_CALL', amount: price.amount, flatFee: price.flatFee, currency: price.currency };
}

/** Money in micro-dollars from an amount and its currency ("USD" or "MICRO_DOLLAR"). */
export function toMicros(amount: number, currency = 'USD'): number {
  if (!isFinite(amount) || amount < 0) return 0;
  if (/micro/i.test(currency)) return Math.round(amount);
  if (/cent/i.test(currency)) return Math.round(amount * 10_000);
  return Math.round(amount * 1_000_000);
}

/** What a run is expected to cost: the flat fee plus the per-call or per-result amount, in micro-dollars. */
export function estimateMicros(price: MonidPrice | null | undefined, results: number, input?: unknown): number {
  const p = priceFor(price, input);
  if (!p) return 0;
  const per = p.type === 'PER_RESULT' ? p.amount * Math.max(1, results) : p.amount;
  return toMicros(per + (p.flatFee || 0), p.currency);
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
    // inspect gives the JSON schema of the request body as input.body (older shapes: inputSchema).
    inputSchema: (isObj(o.input) && isObj(o.input.body) ? o.input.body : undefined) ?? o.inputSchema ?? o.input_schema,
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

/** Billing in micro-dollars: cost {value, currency} (dollars), else billing.actualCost {value, unit|currency}, else null. */
export function costOf(body: Record<string, unknown>): number | null {
  if (isObj(body.cost)) {
    const v = num(body.cost.value) ?? num(body.cost.amount);
    if (v != null) return toMicros(v, str(body.cost.currency) || str(body.cost.unit) || 'USD');
  }
  const b = isObj(body.billing) ? body.billing : null;
  const actual = b && isObj(b.actualCost) ? b.actualCost : b && isObj(b.cost) ? b.cost : null;
  if (actual) {
    const v = num(actual.value) ?? num(actual.amount);
    if (v != null) return toMicros(v, str(actual.unit) || str(actual.currency) || 'MICRO_DOLLAR');
  }
  if (b) { const v = num(b.actualCostMicros) ?? num(b.costMicros); if (v != null) return Math.round(v); }
  return null;
}

/** The message in an error that may be a string, {message}, {error: "..."} or {error: {message}}. */
function errText(e: unknown): string {
  if (typeof e === 'string') return e.trim();
  if (!isObj(e)) return '';
  return str(e.message) || errText(e.error) || str(e.code);
}

export function parseRun(body: unknown, httpStatus = 200): MonidRun {
  const o = isObj(body) ? body : {};
  const runId = str(o.runId) || str(o.id) || str(o.run_id);
  let status = str(o.status).toUpperCase();
  if (!status) status = httpStatus === 202 ? 'RUNNING' : o.output !== undefined ? 'COMPLETED' : 'RUNNING';
  let err = errText(o.error) || str(o.message);
  // COMPLETED with the provider refusing the input (providerResponse {httpStatus: 400, error: {error, code}}) is a failure.
  const pr = isObj(o.providerResponse) ? o.providerResponse : null;
  const prStatus = pr ? num(pr.httpStatus) : null;
  if (pr && status === 'COMPLETED' && ((prStatus != null && prStatus >= 400) || errText(pr.error))) {
    status = 'FAILED';
    err = errText(pr.error) || `the provider answered ${prStatus}`;
  }
  return {
    runId, status, output: o.output ?? o.results ?? o.data ?? null,
    resultCount: num(o.resultCount) ?? num(o.billedUnits) ?? (Array.isArray(o.output) ? o.output.length : null),
    costMicros: costOf(o),
    error: status === 'COMPLETED' || status === 'RUNNING' ? undefined : err || undefined,
  };
}

/** The run request's input: the tool's body wrapped as {body} (an input already wrapped is sent as it is). */
export function runInput(input: unknown): Record<string, unknown> {
  if (isObj(input) && isObj(input.body) && Object.keys(input).every((k) => ['body', 'query', 'path', 'headers'].includes(k))) return input;
  return { body: isObj(input) ? input : {} };
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
      const msg = isObj(json) ? errText(json.error) || str(json.message) : '';
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
      const notes = Array.isArray(o.notes) ? o.notes.map(str).filter(Boolean).join(' ') : str(o.notes);
      return { ...t, provider, endpoint, name: str(o.providerName) || t.name, summary: str(o.summary) || undefined, notes: notes || undefined };
    },
    async run(provider, endpoint, input) {
      const { status, json } = await call('POST', '/run', { provider, endpoint, input: runInput(input) });
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
