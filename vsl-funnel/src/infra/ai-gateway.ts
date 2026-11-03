import Anthropic from '@anthropic-ai/sdk';

/**
 * Cloudflare AI Gateway (Cloudflare round, builder C). With the setting AI_GATEWAY_ID set (e.g. "default"), every
 * Anthropic call goes through https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/anthropic, tagged with the
 * feature that made it (cf-aig-metadata), so Cloudflare shows cost, latency and errors per feature. Blank = the
 * direct API exactly as before. A gateway failure (network error, 5xx, or the gateway refusing with 401/403) is
 * retried once straight to Anthropic, so the gateway can never take an AI feature down.
 *
 * Workers AI calls (embeddings) pass { gateway: { id } } the same way, and fall back to a direct run on error.
 * Models and every other client option stay whatever each caller sets.
 */

/** The account the gateway lives in when CF_ACCOUNT_ID is blank. */
export const DEFAULT_CF_ACCOUNT = '50e9fc42a7947d3f932cd1ed0bf95c03';
export const GATEWAY_HOST = 'https://gateway.ai.cloudflare.com/v1';
export const ANTHROPIC_DIRECT = 'https://api.anthropic.com';

type S = Partial<Record<string, string>>;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ACCOUNT = /^[a-f0-9]{32}$/i;

export interface GatewayInfo { on: boolean; id: string; account: string; anthropicBase: string | null; dashboardUrl: string | null; problem: string | null }

export function gatewayInfo(settings: unknown): GatewayInfo {
  const s = (settings ?? {}) as S;
  const id = (s.AI_GATEWAY_ID || '').trim();
  const account = (s.CF_ACCOUNT_ID || '').trim() || DEFAULT_CF_ACCOUNT;
  if (!id) return { on: false, id: '', account, anthropicBase: null, dashboardUrl: null, problem: null };
  if (!ID.test(id)) return { on: false, id, account, anthropicBase: null, dashboardUrl: null, problem: 'The gateway id may only use letters, digits, - and _.' };
  if (!ACCOUNT.test(account)) return { on: false, id, account, anthropicBase: null, dashboardUrl: null, problem: 'The Cloudflare account id is 32 hex characters.' };
  return {
    on: true, id, account, problem: null,
    anthropicBase: `${GATEWAY_HOST}/${account}/${id}/anthropic`,
    dashboardUrl: `https://dash.cloudflare.com/${account}/ai/ai-gateway/gateways/${id}`,
  };
}

/** Feature tags are short and safe for a header ("room-helper", "support"). */
export const featureTag = (f: string) => (f || 'other').toLowerCase().replace(/[^a-z0-9:._/-]+/g, '-').slice(0, 48) || 'other';

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
const reusable = (b: unknown) => b == null || typeof b === 'string' || b instanceof ArrayBuffer || ArrayBuffer.isView(b) || b instanceof URLSearchParams;
/** Statuses that mean "the gateway (not Anthropic's answer) is the problem": try direct once. */
export const shouldFallBack = (status: number) => status >= 500 || status === 401 || status === 403;

/**
 * A fetch for the Anthropic SDK: requests to api.anthropic.com go to the gateway with the feature tag; a failed
 * gateway request is sent once more, unchanged, to api.anthropic.com. `inner` defaults to the global fetch at
 * call time (tests stub it).
 */
export function gatewayFetch(base: string, feature: string, inner?: FetchFn, onFallback?: (why: string) => void): FetchFn {
  const go: FetchFn = (i, init) => (inner ?? (globalThis.fetch as FetchFn))(i, init);
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ANTHROPIC_DIRECT)) return go(input, init);
    const via = base + url.slice(ANTHROPIC_DIRECT.length);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('cf-aig-metadata', JSON.stringify({ feature: featureTag(feature) }));
    const canRetry = !(input instanceof Request) && reusable(init?.body);
    try {
      const res = await go(via, { ...init, headers });
      if (!canRetry || !shouldFallBack(res.status)) return res;
      onFallback?.(`gateway answered ${res.status}`);
      try { await res.body?.cancel(); } catch { /* already consumed */ }
    } catch (e) {
      if (!canRetry || (e as { name?: string })?.name === 'AbortError') throw e;
      onFallback?.(`gateway unreachable: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
    }
    return go(url, init);
  };
}

export interface ClientOpts { apiKey: string | undefined; maxRetries?: number; timeout?: number }

/**
 * The one way to make an Anthropic client. Same options as before; with AI_GATEWAY_ID set the requests go
 * through the gateway (tagged with `feature`), otherwise this is exactly `new Anthropic(opts)`.
 */
export function anthropicClient(settings: unknown, feature: string, opts: ClientOpts): Anthropic {
  const g = gatewayInfo(settings);
  if (!g.on || !g.anthropicBase) return new Anthropic(opts);
  return new Anthropic({ ...opts, fetch: gatewayFetch(g.anthropicBase, feature, undefined, (why) => console.warn(`AI Gateway: ${why}; sent direct (${featureTag(feature)})`)) as never });
}

/** Workers AI: the gateway option for env.AI.run, or none. */
export function workersAiGateway(settings: unknown, feature: string): { gateway: { id: string; metadata: Record<string, string> } } | Record<string, never> {
  const g = gatewayInfo(settings);
  return g.on ? { gateway: { id: g.id, metadata: { feature: featureTag(feature) } } } : {};
}

interface AiRunner { run(model: string, input: unknown, opts?: unknown): Promise<unknown> }
/** env.AI.run through the gateway when it is on; a failure there is retried once without it. */
export async function runWorkersAi<T>(ai: AiRunner, settings: unknown, feature: string, model: string, input: unknown): Promise<T> {
  const opts = workersAiGateway(settings, feature);
  if (!('gateway' in opts)) return (await ai.run(model, input)) as T;
  try {
    return (await ai.run(model, input, opts)) as T;
  } catch (e) {
    console.warn(`AI Gateway (Workers AI): ${String((e as Error)?.message ?? e).slice(0, 120)}; ran direct`);
    return (await ai.run(model, input)) as T;
  }
}
