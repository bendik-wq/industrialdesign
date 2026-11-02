import type { Runtime } from '../app';
import { adAccountPath, metaWriteToken } from '../integrations/meta-ads';
import { META_API_VERSION } from '../tracking/forward';

/**
 * Marketing API calls for audiences and custom conversions. Every call here needs the write token
 * (META_ADS_WRITE_TOKEN, ads_management) and is only reached from an approved action or the daily resync of
 * audiences an approved action created. Nothing here falls back to the Conversions API token.
 */

const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;
/** Meta's customer-file limit per request. */
export const BATCH = 10_000;

export class MetaError extends Error {
  constructor(message: string, readonly code?: number, readonly terms = false) { super(message); }
}

async function call<T>(rt: Pick<Runtime, 'settings'>, method: 'GET' | 'POST', path: string, params: Record<string, unknown> = {}): Promise<T> {
  const token = metaWriteToken(rt as Runtime);
  if (!token) throw new MetaError('No Meta write token (ads_management). Add it under Integrations, Ads.');
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  form.set('access_token', token);
  const res = method === 'GET'
    ? await fetch(`${GRAPH}/${path}?${form.toString()}`)
    : await fetch(`${GRAPH}/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number; error_subcode?: number } };
  if (!res.ok || body.error) {
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    const code = body.error?.code;
    const terms = code === 1870090 || body.error?.error_subcode === 1870090 || /terms/i.test(msg) && /custom audience/i.test(msg);
    throw new MetaError(terms ? `Meta needs the Custom Audience terms accepted for this ad account first (${msg}).`
      : /permission|ads_management/i.test(msg) ? `Meta refused it (${msg}). The write token needs ads_management on this ad account.` : `Meta: ${msg}`, code, terms);
  }
  return body;
}

const act = (rt: Pick<Runtime, 'settings'>) => adAccountPath(rt as Runtime);

export const createCustomConversion = (rt: Pick<Runtime, 'settings'>, o: { name: string; description: string; rule: unknown; customEventType: string }) =>
  call<{ id: string }>(rt, 'POST', `${act(rt)}/customconversions`, {
    name: o.name, description: o.description, event_source_id: rt.settings.META_PIXEL_ID, custom_event_type: o.customEventType, rule: o.rule, action_source_type: 'website',
  });

export const createWebsiteAudience = (rt: Pick<Runtime, 'settings'>, o: { name: string; description: string; rule: unknown; retentionDays: number }) =>
  call<{ id: string }>(rt, 'POST', `${act(rt)}/customaudiences`, { name: o.name, description: o.description, rule: o.rule, retention_days: o.retentionDays, prefill: true });

export const createListAudience = (rt: Pick<Runtime, 'settings'>, o: { name: string; description: string; valueBased: boolean }) =>
  call<{ id: string }>(rt, 'POST', `${act(rt)}/customaudiences`, {
    name: o.name, description: o.description, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', ...(o.valueBased ? { is_value_based: true } : {}),
  });

export const createLookalike = (rt: Pick<Runtime, 'settings'>, o: { name: string; originId: string; spec: unknown }) =>
  call<{ id: string }>(rt, 'POST', `${act(rt)}/customaudiences`, { name: o.name, subtype: 'LOOKALIKE', origin_audience_id: o.originId, lookalike_spec: o.spec });

export const audienceSize = (rt: Pick<Runtime, 'settings'>, id: string) =>
  call<{ approximate_count_lower_bound?: number; approximate_count_upper_bound?: number; operation_status?: { code?: number; description?: string }; delivery_status?: { code?: number; description?: string } }>(
    rt, 'GET', encodeURIComponent(id), { fields: 'approximate_count_lower_bound,approximate_count_upper_bound,operation_status,delivery_status' });

/** A positive id below 2^53, unique enough within the ad account for one upload session. */
export function sessionId() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0] % 2 ** 21) * 2 ** 32 + a[1] + 1;
}

/**
 * Uploads hashed rows in sessions of up to 10,000 per request: /users adds (first upload), /usersreplace swaps the
 * whole list (later syncs; Meta keeps ad sets out of a new learning phase for a replace). Returns the batch count.
 */
export async function uploadUsers(rt: Pick<Runtime, 'settings'>, audienceId: string, schema: readonly string[], rows: (string | number)[][], replace: boolean) {
  if (!rows.length) return 0;
  const session_id = sessionId();
  const batches = Math.ceil(rows.length / BATCH);
  for (let i = 0; i < batches; i++) {
    const data = rows.slice(i * BATCH, (i + 1) * BATCH);
    await call(rt, 'POST', `${encodeURIComponent(audienceId)}/${replace ? 'usersreplace' : 'users'}`, {
      payload: { schema, data },
      session: { session_id, batch_seq: i + 1, last_batch_flag: i === batches - 1, estimated_num_total: rows.length },
    });
  }
  return batches;
}
