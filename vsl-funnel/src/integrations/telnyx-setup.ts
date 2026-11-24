import type { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { TARGET_COUNTRIES } from '../config';
import { saveSettings } from '../settings';
import { CONSENT_ONE } from './consent-gate';
import { DEFAULT_SMS_SEQUENCES } from './sms-defaults';

/**
 * Funnel HQ → SMS → Telnyx setup. Every Telnyx call runs here, server-side, with the TELNYX_API_KEY Worker secret
 * (the key never reaches the browser). Admin-only routes under /admin/api/telnyx/*.
 *
 *  1. Messaging profile: show and fix the inbound webhook, the profile-level alpha sender (which made Telnyx send
 *     "GL Advisory" to every country: 40305), the allowed destination countries, and the number's profile.
 *  2. US 10DLC: brand (real business details only), campaign (prefilled from the app's real copy), number assignment.
 *  3. Australian mobile number for two-way texts: search, regulatory requirements, documents, order, status.
 *
 * Free fixes run on their own button; anything that costs money (brand, campaign, number order) runs only on its own
 * button press, and the price Telnyx returns is shown next to it.
 */

const API = 'https://api.telnyx.com/v2';
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface TxResult<T = unknown> { ok: boolean; status: number; data: T | null; error: string | null }

type Rt = Pick<Runtime, 'settings' | 'origin'>;
const key = (rt: Rt) => String(rt.settings.TELNYX_API_KEY ?? '').trim();
const profileId = (rt: Rt) => String(rt.settings.TELNYX_MESSAGING_PROFILE_ID ?? '').trim();
const fromNumber = (rt: Rt) => String(rt.settings.SMS_FROM ?? '').trim();

/** One Telnyx call. Errors come back verbatim (title, detail, code) so Funnel HQ can show exactly what Telnyx said. */
export async function tx<T = unknown>(rt: Rt, method: string, path: string, body?: unknown, f: Fetcher = fetch): Promise<TxResult<T>> {
  if (!key(rt)) return { ok: false, status: 0, data: null, error: 'TELNYX_API_KEY is not set on the Worker.' };
  const init: RequestInit = { method, headers: { authorization: `Bearer ${key(rt)}`, accept: 'application/json' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)['content-type'] = 'application/json'; }
  let res: Response;
  try { res = await f(`${API}${path}`, init); } catch (e) { return { ok: false, status: 0, data: null, error: `Could not reach Telnyx: ${String(e).slice(0, 200)}` }; }
  const json = (await res.json().catch(() => null)) as (T & { errors?: { title?: string; detail?: string; code?: string }[] }) | null;
  if (!res.ok) {
    const errs = (json as { errors?: { title?: string; detail?: string; code?: string }[] } | null)?.errors ?? [];
    const msg = errs.map((e) => [e.title, e.detail, e.code ? `(${e.code})` : ''].filter(Boolean).join(' ')).join('; ') || JSON.stringify(json ?? {}).slice(0, 300);
    return { ok: false, status: res.status, data: json, error: `Telnyx ${res.status}: ${msg}`.slice(0, 600) };
  }
  return { ok: true, status: res.status, data: json, error: null };
}

const unwrap = <T>(r: TxResult<{ data?: T }>): T | null => (r.ok && r.data ? (r.data.data ?? null) : null);

// ───────────── 1. messaging profile ─────────────

export const webhookUrl = (rt: Rt) => `${String(rt.settings.PUBLIC_URL || rt.origin).replace(/\/+$/, '')}/hooks/telnyx/sms`;

/** The countries texts may go to: the ones we contact (TARGET_COUNTRIES) plus NO (the owner's own tests). */
export const wantedCountries = () => [...new Set([...TARGET_COUNTRIES, 'NO'])];

/** Existing allowed countries plus ours, upper-case, no duplicates, existing ones kept first. */
export function mergeWhitelist(existing: unknown, add: string[] = wantedCountries()) {
  const cur = Array.isArray(existing) ? existing.map((c) => String(c).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)) : [];
  return [...new Set([...cur, ...add.map((c) => c.toUpperCase())])];
}

interface Profile { id: string; name?: string; enabled?: boolean; webhook_url?: string | null; webhook_failover_url?: string | null; webhook_api_version?: string; alpha_sender?: string | null; whitelisted_destinations?: string[] }
interface PhoneNumber { id: string; phone_number: string; status?: string; messaging_profile_id?: string | null; connection_id?: string | null }
interface NumberMessaging { id?: string; phone_number?: string; messaging_profile_id?: string | null; features?: Record<string, unknown>; eligible_messaging_products?: string[]; messaging_product?: string; health?: unknown; country_code?: string; type?: string }

export async function findNumber(rt: Rt, phone: string, f: Fetcher = fetch) {
  if (!phone) return null;
  const r = await tx<{ data?: PhoneNumber[] }>(rt, 'GET', `/phone_numbers?filter[phone_number]=${encodeURIComponent(phone)}&page[size]=5`, undefined, f);
  return (unwrap(r) ?? []).find((n) => n.phone_number === phone) ?? null;
}

export async function profileStatus(rt: Rt, f: Fetcher = fetch) {
  const pid = profileId(rt);
  const expected = { webhook_url: webhookUrl(rt), webhook_api_version: '2', countries: wantedCountries() };
  if (!key(rt)) return { connected: false, error: 'TELNYX_API_KEY is not set on the Worker.', expected };
  const prof = pid ? await tx<{ data?: Profile }>(rt, 'GET', `/messaging_profiles/${encodeURIComponent(pid)}`, undefined, f) : null;
  const profile = prof ? unwrap(prof) : null;
  const num = await findNumber(rt, fromNumber(rt), f);
  const msg = num ? unwrap(await tx<{ data?: NumberMessaging }>(rt, 'GET', `/phone_numbers/${encodeURIComponent(num.id)}/messaging`, undefined, f)) : null;
  const allowed = (profile?.whitelisted_destinations ?? []).map((c) => c.toUpperCase());
  const missing = expected.countries.filter((c) => !allowed.includes(c));
  const problems: { key: 'profile' | 'webhook' | 'alpha' | 'whitelist' | 'number'; text: string }[] = [];
  if (!pid) problems.push({ key: 'profile', text: 'TELNYX_MESSAGING_PROFILE_ID is not set.' });
  else if (!profile) problems.push({ key: 'profile', text: prof?.error ?? 'The messaging profile could not be read.' });
  if (profile && profile.webhook_url !== expected.webhook_url) problems.push({ key: 'webhook', text: `Inbound texts go to ${profile.webhook_url || 'nowhere'}, not ${expected.webhook_url}.` });
  if (profile && profile.webhook_url === expected.webhook_url && profile.webhook_api_version !== '2') problems.push({ key: 'webhook', text: `Webhook API version is ${profile.webhook_api_version ?? 'unset'}; it needs to be 2.` });
  if (profile?.alpha_sender) problems.push({ key: 'alpha', text: `The profile sends every text as "${profile.alpha_sender}". Most countries refuse an unregistered name and the US/Canada refuse names entirely. Funnel HQ already uses the name for Australian numbers only.` });
  if (profile && missing.length) problems.push({ key: 'whitelist', text: `Texts can't go to: ${missing.join(', ')}.` });
  if (fromNumber(rt) && !num) problems.push({ key: 'number', text: `${fromNumber(rt)} (SMS_FROM) isn't a number on this Telnyx account.` });
  else if (num && pid && (msg?.messaging_profile_id ?? num.messaging_profile_id) !== pid) problems.push({ key: 'number', text: `${num.phone_number} isn't on this messaging profile.` });
  return {
    connected: true,
    expected,
    profile: profile ? { id: profile.id, name: profile.name ?? null, enabled: profile.enabled ?? null, webhook_url: profile.webhook_url ?? null, webhook_api_version: profile.webhook_api_version ?? null, alpha_sender: profile.alpha_sender ?? null, whitelisted_destinations: allowed } : null,
    profileError: prof && !prof.ok ? prof.error : null,
    number: num ? { id: num.id, phone_number: num.phone_number, status: num.status ?? null, messaging_profile_id: msg?.messaging_profile_id ?? num.messaging_profile_id ?? null, features: msg?.features ?? null, messaging_product: msg?.messaging_product ?? null, type: msg?.type ?? null } : null,
    auNumber: String(rt.settings.SMS_FROM_AU ?? '').trim() || null,
    problems,
  };
}

/** The PATCH body for each free fix (pure, so the tests can check it). */
export const fixBodies = {
  webhook: (rt: Rt) => ({ webhook_url: webhookUrl(rt), webhook_api_version: '2' }),
  alpha: () => ({ alpha_sender: null }),
  whitelist: (existing: unknown) => ({ whitelisted_destinations: mergeWhitelist(existing) }),
};

export type FixName = 'webhook' | 'alpha' | 'whitelist' | 'number';

export async function applyFix(rt: Rt, which: FixName, f: Fetcher = fetch): Promise<TxResult> {
  const pid = profileId(rt);
  if (!pid) return { ok: false, status: 0, data: null, error: 'TELNYX_MESSAGING_PROFILE_ID is not set.' };
  const path = `/messaging_profiles/${encodeURIComponent(pid)}`;
  if (which === 'webhook') return tx(rt, 'PATCH', path, fixBodies.webhook(rt), f);
  if (which === 'alpha') return tx(rt, 'PATCH', path, fixBodies.alpha(), f);
  if (which === 'whitelist') {
    const cur = unwrap(await tx<{ data?: Profile }>(rt, 'GET', path, undefined, f));
    if (!cur) return { ok: false, status: 0, data: null, error: 'The messaging profile could not be read.' };
    return tx(rt, 'PATCH', path, fixBodies.whitelist(cur.whitelisted_destinations), f);
  }
  const num = await findNumber(rt, fromNumber(rt), f);
  if (!num) return { ok: false, status: 0, data: null, error: `${fromNumber(rt) || 'SMS_FROM'} isn't a number on this Telnyx account.` };
  return assignNumberToProfile(rt, num.id, pid, f);
}

export function assignNumberToProfile(rt: Rt, numberId: string, pid: string, f: Fetcher = fetch) {
  return tx(rt, 'PATCH', `/phone_numbers/${encodeURIComponent(numberId)}/messaging`, { messaging_profile_id: pid }, f);
}

// ───────────── 2. US 10DLC ─────────────

export interface BrandInput {
  companyName: string; displayName: string; entityType: string; country: string; ein: string; einIssuingCountry: string;
  street: string; city: string; state: string; postalCode: string; website: string;
  firstName: string; lastName: string; email: string; phone: string; vertical: string;
}
const BRAND_REQUIRED: (keyof BrandInput)[] = ['companyName', 'displayName', 'entityType', 'country', 'ein', 'einIssuingCountry', 'street', 'city', 'state', 'postalCode', 'website', 'firstName', 'lastName', 'email', 'phone', 'vertical'];
export const BRAND_DEFAULTS: Partial<BrandInput> = { entityType: 'PRIVATE_PROFIT', country: 'AU', einIssuingCountry: 'AU', website: 'https://apply.grosfjeld-li.com', vertical: 'PROFESSIONAL' };

/** Real details only: every required field must be filled in on the form (defaults are only the few listed above). */
export function brandBody(input: Record<string, unknown>): { ok: true; body: BrandInput } | { ok: false; missing: string[] } {
  const v = (k: keyof BrandInput) => String(input[k] ?? BRAND_DEFAULTS[k] ?? '').trim();
  const body = Object.fromEntries(BRAND_REQUIRED.map((k) => [k, v(k)])) as unknown as BrandInput;
  const missing = BRAND_REQUIRED.filter((k) => !body[k]);
  if (missing.length) return { ok: false, missing };
  if (!/^\S+@\S+\.\S+$/.test(body.email)) return { ok: false, missing: ['email'] };
  if (!/^\+\d{8,15}$/.test(body.phone.replace(/[\s()-]/g, ''))) return { ok: false, missing: ['phone'] };
  body.phone = body.phone.replace(/[\s()-]/g, '');
  body.country = body.country.toUpperCase(); body.einIssuingCountry = body.einIssuingCountry.toUpperCase();
  return { ok: true, body };
}

/** Real sample texts from the default sequences (booked confirmation, 24h reminder, no-show), plus one AI reply. */
export function sampleTexts() {
  const fill = (t: string) => t.replace(/\{first_name\}/g, 'Sarah').replace(/\{call_time\}/g, 'Tue 3 Mar, 10:00am').replace(/\{closer\}/g, 'Josh').replace(/\{link\}/g, 'https://apply.grosfjeld-li.com/l/ab12');
  const step = (seq: string, n: number) => DEFAULT_SMS_SEQUENCES.find((s) => s.id === seq)?.steps.find((s) => s.n === n)?.body ?? '';
  return [
    fill(step('booked', 1)),
    fill(step('booked', 3)),
    fill(step('no_show', 1)),
    'Sam here, Josh\'s AI assistant at G&L. Happy to help: the strategy call is 30 minutes with Josh\'s team. I have Tue 10am or Wed 2pm open. Want one of those? Reply STOP to opt out.',
  ].filter(Boolean).map((t) => t.slice(0, 1024));
}

export const HELP_MESSAGE = 'G&L M&A Advisory: texts about your application, strategy call and webinar. Email support via apply.grosfjeld-li.com. Reply STOP to opt out. Msg & data rates may apply.';
export const STOP_MESSAGE = 'You\'re unsubscribed from G&L M&A Advisory texts. No more messages will be sent. Reply START to resubscribe.';

/** The campaign, prefilled from the app's real copy and consent wording. */
export function campaignBody(brandId: string) {
  const s = sampleTexts();
  return {
    brandId,
    usecase: 'MIXED',
    subUsecases: ['CUSTOMER_CARE', 'MARKETING'],
    description: 'G&L M&A Advisory (Josh Li) acquisition advisory: strategy-call and webinar reminders, application follow-up, and replies from an AI assistant that says it is an AI. Sent only to people who opted in on our web forms.',
    messageFlow: `People opt in on our web forms (e.g. https://apply.grosfjeld-li.com/apply) by entering their mobile number and ticking a single, unticked checkbox labelled "${CONSENT_ONE.label}", next to this text: "${CONSENT_ONE.text}" Ticking is optional and not required to apply or register.`,
    sample1: s[0], sample2: s[1], sample3: s[2], sample4: s[3],
    helpMessage: HELP_MESSAGE,
    optoutMessage: STOP_MESSAGE,
    optinMessage: 'You\'re subscribed to G&L M&A Advisory texts about your application, call and webinar. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.',
    helpKeywords: 'HELP,INFO',
    optoutKeywords: 'STOP,STOPALL,UNSUBSCRIBE,CANCEL,END,QUIT',
    optinKeywords: 'START,YES',
    embeddedLink: true,
    embeddedPhone: false,
    numberPool: false,
    ageGated: false,
    directLending: false,
    subscriberOptin: true,
    subscriberOptout: true,
    subscriberHelp: true,
    termsAndConditions: true,
    autoRenewal: true,
  };
}

interface Brand { brandId?: string; tcrBrandId?: string; displayName?: string; companyName?: string; identityStatus?: string; status?: string; failureReasons?: unknown }
interface Campaign { campaignId?: string; tcrCampaignId?: string; brandId?: string; usecase?: string; campaignStatus?: string; status?: string; submissionStatus?: string; failureReasons?: unknown; monthlyCost?: string | number }

const records = <T>(d: unknown): T[] => {
  const x = d as { records?: T[]; data?: T[] } | T[] | null;
  if (Array.isArray(x)) return x;
  return x?.records ?? x?.data ?? [];
};

export async function tenDlcStatus(rt: Rt, f: Fetcher = fetch) {
  const brandsR = await tx(rt, 'GET', '/10dlc/brand?recordsPerPage=50', undefined, f);
  const brands = records<Brand>(brandsR.data).map((b) => ({ brandId: b.brandId ?? null, tcrBrandId: b.tcrBrandId ?? null, name: b.displayName ?? b.companyName ?? null, identityStatus: b.identityStatus ?? b.status ?? null, failureReasons: b.failureReasons ?? null }));
  const campaigns: ReturnType<typeof campaignRow>[] = [];
  for (const b of brands.filter((x) => x.brandId)) {
    const r = await tx(rt, 'GET', `/10dlc/campaign?brandId=${encodeURIComponent(b.brandId!)}&recordsPerPage=50`, undefined, f);
    campaigns.push(...records<Campaign>(r.data).map(campaignRow));
  }
  const phone = fromNumber(rt);
  // One number's campaign assignment (404 = not assigned yet).
  const assignR = phone ? await tx(rt, 'GET', `/10dlc/phone_number_campaigns/${encodeURIComponent(phone)}`, undefined, f) : null;
  type Assign = { phoneNumber?: string; campaignId?: string; assignmentStatus?: string; failureReasons?: unknown };
  const one = assignR?.ok ? ((assignR.data as { data?: Assign } & Assign | null)?.data ?? (assignR.data as Assign | null)) : null;
  const assigned: Assign[] = one && (one.campaignId || one.assignmentStatus) ? [one] : [];
  return {
    brands, campaigns,
    number: phone || null,
    assignment: assigned[0] ? { campaignId: assigned[0].campaignId ?? null, status: assigned[0].assignmentStatus ?? null, failureReasons: assigned[0].failureReasons ?? null } : null,
    error: brandsR.ok ? null : brandsR.error,
    brandDefaults: BRAND_DEFAULTS,
    campaignPreview: campaignBody('(your brand)'),
  };
}
function campaignRow(c: Campaign) {
  return { campaignId: c.campaignId ?? null, tcrCampaignId: c.tcrCampaignId ?? null, brandId: c.brandId ?? null, usecase: c.usecase ?? null, status: c.campaignStatus ?? c.submissionStatus ?? c.status ?? null, monthlyCost: c.monthlyCost ?? null, failureReasons: c.failureReasons ?? null };
}

export const createBrand = (rt: Rt, body: BrandInput, f: Fetcher = fetch) => tx(rt, 'POST', '/10dlc/brand', body, f);
export const createCampaign = (rt: Rt, brandId: string, f: Fetcher = fetch) => tx(rt, 'POST', '/10dlc/campaignBuilder', campaignBody(brandId), f);
export const assignCampaign = (rt: Rt, campaignId: string, f: Fetcher = fetch) => tx(rt, 'POST', '/10dlc/phone_number_campaigns', { phoneNumber: fromNumber(rt), campaignId }, f);

// ───────────── 3. Australian mobile number ─────────────

interface Available { phone_number: string; features?: { name: string }[]; cost_information?: { upfront_cost?: string; monthly_cost?: string; currency?: string }; region_information?: { region_type?: string; region_name?: string }[] }

export async function auNumbers(rt: Rt, f: Fetcher = fetch) {
  const q = 'filter[country_code]=AU&filter[phone_number_type]=mobile&filter[features][]=sms&filter[limit]=10';
  const r = await tx<{ data?: Available[] }>(rt, 'GET', `/available_phone_numbers?${q}`, undefined, f);
  return {
    numbers: (unwrap(r) ?? []).map((n) => ({ phone_number: n.phone_number, features: (n.features ?? []).map((x) => x.name), upfront: n.cost_information?.upfront_cost ?? null, monthly: n.cost_information?.monthly_cost ?? null, currency: n.cost_information?.currency ?? null, region: n.region_information?.map((x) => x.region_name).filter(Boolean).join(', ') || null })),
    error: r.ok ? null : r.error,
  };
}

interface RequirementType { id: string; name?: string; type?: string; description?: string; example?: string; acceptance_criteria?: unknown }
export async function auRequirements(rt: Rt, f: Fetcher = fetch) {
  const r = await tx<{ data?: { id?: string; requirements_types?: RequirementType[]; action?: string; phone_number_type?: string }[] }>(rt, 'GET', '/requirements?filter[country_code]=AU&filter[phone_number_type]=mobile&filter[action]=ordering', undefined, f);
  const groups = unwrap(r) ?? [];
  const types = groups.flatMap((g) => g.requirements_types ?? []);
  return { requirements: types.map((t) => ({ id: t.id, name: t.name ?? null, type: t.type ?? null, description: t.description ?? null, example: t.example ?? null })), error: r.ok ? null : r.error };
}

/** A document (e.g. proof of address) forwarded to Telnyx; returns its id for the order's requirement. */
export async function uploadDocument(rt: Rt, file: File, f: Fetcher = fetch) {
  const fd = new FormData();
  fd.append('file', file, file.name || 'document');
  const r = await tx<{ data?: { id?: string; status?: string } }>(rt, 'POST', '/documents', fd, f);
  const d = unwrap(r);
  return { ok: r.ok && Boolean(d?.id), id: d?.id ?? null, status: d?.status ?? null, error: r.error };
}

export function orderBody(rt: Rt, phone: string, reqs: unknown) {
  const list = (Array.isArray(reqs) ? reqs : []).map((x) => ({ requirement_id: String((x as { requirement_id?: unknown }).requirement_id ?? ''), field_value: String((x as { field_value?: unknown }).field_value ?? '').trim() })).filter((x) => x.requirement_id && x.field_value);
  const body: Record<string, unknown> = { phone_numbers: [{ phone_number: phone, ...(list.length ? { regulatory_requirements: list } : {}) }] };
  if (profileId(rt)) body.messaging_profile_id = profileId(rt);
  return body;
}

export const orderAuNumber = (rt: Rt, phone: string, reqs: unknown, f: Fetcher = fetch) => tx(rt, 'POST', '/number_orders', orderBody(rt, phone, reqs), f);

/** The order's status; once it succeeded, the number is saved as SMS_FROM_AU (and moved onto the profile if needed). */
export async function auOrderStatus(rt: Runtime, id: string, f: Fetcher = fetch) {
  const r = await tx<{ data?: { id?: string; status?: string; requirements_met?: boolean; phone_numbers?: { phone_number?: string; status?: string; requirements_status?: string }[] } }>(rt, 'GET', `/number_orders/${encodeURIComponent(id)}`, undefined, f);
  const d = unwrap(r);
  const phone = d?.phone_numbers?.[0]?.phone_number ?? null;
  let saved = false;
  if (d?.status === 'success' && phone && /^\+61/.test(phone)) {
    const num = await findNumber(rt, phone, f);
    if (num && profileId(rt) && num.messaging_profile_id !== profileId(rt)) await assignNumberToProfile(rt, num.id, profileId(rt), f);
    if (String(rt.settings.SMS_FROM_AU ?? '').trim() !== phone) { await saveSettings(rt.env, { SMS_FROM_AU: phone }); saved = true; }
  }
  return { id: d?.id ?? id, status: d?.status ?? null, requirementsMet: d?.requirements_met ?? null, numbers: d?.phone_numbers ?? [], savedAsSender: saved, error: r.ok ? null : r.error };
}

// ───────────── routes ─────────────

export function mountTelnyxAdmin(admin: Hono<AppEnv>) {
  admin.get('/telnyx/status', async (c) => c.json(await profileStatus(runtimeFrom(c))));
  admin.post('/telnyx/fix/:which', async (c) => {
    const which = c.req.param('which');
    const rt = runtimeFrom(c);
    if (which === 'all') {
      const out: Record<string, string | null> = {};
      for (const w of ['webhook', 'alpha', 'whitelist', 'number'] as FixName[]) out[w] = (await applyFix(rt, w)).error;
      return c.json({ ok: Object.values(out).every((e) => !e), errors: out, status: await profileStatus(rt) });
    }
    if (!['webhook', 'alpha', 'whitelist', 'number'].includes(which)) return c.json({ ok: false, error: 'Unknown fix' }, 400);
    const r = await applyFix(rt, which as FixName);
    return c.json({ ok: r.ok, error: r.error, status: await profileStatus(rt) }, r.ok ? 200 : 400);
  });

  admin.get('/telnyx/10dlc', async (c) => c.json(await tenDlcStatus(runtimeFrom(c))));
  admin.post('/telnyx/10dlc/brand', async (c) => {
    const input = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    const b = brandBody(input);
    if (!b.ok) return c.json({ ok: false, error: `Fill in: ${b.missing.join(', ')}`, missing: b.missing }, 400);
    const r = await createBrand(runtimeFrom(c), b.body);
    return c.json({ ok: r.ok, error: r.error, brand: r.data }, r.ok ? 200 : 400);
  });
  admin.post('/telnyx/10dlc/campaign', async (c) => {
    const { brandId } = await c.req.json<{ brandId?: string }>().catch(() => ({ brandId: '' }));
    if (!brandId) return c.json({ ok: false, error: 'Pick the brand first.' }, 400);
    const r = await createCampaign(runtimeFrom(c), String(brandId));
    return c.json({ ok: r.ok, error: r.error, campaign: r.data }, r.ok ? 200 : 400);
  });
  admin.post('/telnyx/10dlc/assign', async (c) => {
    const { campaignId } = await c.req.json<{ campaignId?: string }>().catch(() => ({ campaignId: '' }));
    const rt = runtimeFrom(c);
    if (!campaignId) return c.json({ ok: false, error: 'Pick the campaign first.' }, 400);
    if (!fromNumber(rt)) return c.json({ ok: false, error: 'SMS_FROM is not set.' }, 400);
    const r = await assignCampaign(rt, String(campaignId));
    return c.json({ ok: r.ok, error: r.error, assignment: r.data }, r.ok ? 200 : 400);
  });

  admin.get('/telnyx/au/numbers', async (c) => c.json(await auNumbers(runtimeFrom(c))));
  admin.get('/telnyx/au/requirements', async (c) => c.json(await auRequirements(runtimeFrom(c))));
  admin.post('/telnyx/au/document', async (c) => {
    const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
    const file = form.file;
    if (!(file instanceof File) || !file.size) return c.json({ ok: false, error: 'Choose a file first.' }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ ok: false, error: 'Files up to 10 MB.' }, 413);
    const r = await uploadDocument(runtimeFrom(c), file);
    return c.json(r, r.ok ? 200 : 400);
  });
  admin.post('/telnyx/au/order', async (c) => {
    const body = await c.req.json<{ phone_number?: string; requirements?: unknown }>().catch(() => ({} as { phone_number?: string; requirements?: unknown }));
    const phone = String(body.phone_number ?? '').trim();
    if (!/^\+61\d{9}$/.test(phone)) return c.json({ ok: false, error: 'Pick an Australian number from the list.' }, 400);
    const r = await orderAuNumber(runtimeFrom(c), phone, body.requirements);
    const d = (r.data as { data?: { id?: string; status?: string } } | null)?.data;
    return c.json({ ok: r.ok, error: r.error, orderId: d?.id ?? null, status: d?.status ?? null }, r.ok ? 200 : 400);
  });
  admin.get('/telnyx/au/order/:id', async (c) => c.json(await auOrderStatus(runtimeFrom(c), c.req.param('id'))));
}
