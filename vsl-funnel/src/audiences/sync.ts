import type { Runtime } from '../app';
import { metaWriteConfigured, metaWriteToken } from '../integrations/meta-ads';
import { proposeAction, registerActionHandler } from '../ops/actions';
import { flag } from '../settings';
import { identityFromLead, track } from '../tracking/track';
import { LEARNING_NOTE, LOOKALIKE_SOURCES, type PlanItem, RECOMMENDATIONS, buildPlan, conversionRule, lookalikeSpec, websiteRule } from './catalog';
import { bookingValues, scheduleValueOn } from './enrich';
import { MetaError, audienceSize, createCustomConversion, createListAudience, createLookalike, createWebsiteAudience, uploadUsers } from './meta';
import { EXCLUDED_LABEL, LIST_SCHEMA, VALUE_SCHEMA, hashRow, membersHash, segmentMembers } from './segments';
import { activeSlots } from './segments';

/**
 * Meta audiences: the plan, its state in Meta, "Create all in Meta" (an approval in Command, kind
 * marketing.audiences_create, risk medium), lookalike proposals (marketing.lookalike_create) and the daily resync.
 *
 * Nothing reaches Meta unless (a) the owner approved the action that queued it and (b) the write token
 * (META_ADS_WRITE_TOKEN with ads_management) is set. The cron only continues queued work and re-syncs audiences
 * an approved action created.
 */

export const CREATE_KIND = 'marketing.audiences_create';
export const LOOKALIKE_KIND = 'marketing.lookalike_create';
const DAY = 86_400_000;
const s = (rt: Pick<Runtime, 'settings'>) => rt.settings as Partial<Record<string, string>>;

export const retentionDays = (rt: Pick<Runtime, 'settings'>) => { const n = Math.round(Number(s(rt).META_AUDIENCE_RETENTION_DAYS)); return Number.isFinite(n) && n >= 1 ? Math.min(180, n) : 180; };
export const lookalikeCountries = (rt: Pick<Runtime, 'settings'>) => {
  const list = String(s(rt).META_LOOKALIKE_COUNTRIES || 'AU').split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c));
  return list.length ? [...new Set(list)].slice(0, 6) : ['AU'];
};
export const syncOn = (rt: Pick<Runtime, 'settings'>) => flag(s(rt).META_AUDIENCE_SYNC, true);

export async function currentPlan(rt: Pick<Runtime, 'env' | 'settings'>) {
  const slots = await activeSlots(rt).catch(() => []);
  return buildPlan({ slots, countries: lookalikeCountries(rt) });
}

export interface StateRow {
  key: string; kind: string; name: string; meta_id: string | null; status: string; spec: string | null; our_count: number | null; members_hash: string | null;
  size_lower: number | null; size_upper: number | null; meta_status: string | null; error: string | null; action_id: string | null;
  created_at: number; updated_at: number; meta_created_at: number | null; last_synced_at: number | null; size_checked_at: number | null;
}
const allState = async (rt: Pick<Runtime, 'env'>) => (await rt.env.DB.prepare('SELECT * FROM meta_audiences').all<StateRow>()).results;

// ───────────── setup ─────────────

async function termsAccepted(rt: Pick<Runtime, 'env'>) {
  const r = await rt.env.DB.prepare("SELECT value FROM settings WHERE key = '_meta_ca_terms'").first<{ value: string }>().catch(() => null);
  return r?.value === 'accepted' ? true : r?.value === 'refused' ? false : null;
}
export async function setTerms(rt: Pick<Runtime, 'env'>, v: 'accepted' | 'refused' | 'unknown') {
  const now = Date.now();
  await rt.env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('_meta_ca_terms', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(v, now).run();
}

export async function setup(rt: Pick<Runtime, 'env' | 'settings'>) {
  const st = s(rt);
  const terms = await termsAccepted(rt);
  const steps = [
    { id: 'pixel', done: Boolean(st.META_PIXEL_ID), label: 'Meta Pixel connected', detail: st.META_PIXEL_ID ? `Pixel ${st.META_PIXEL_ID}` : 'Add the Pixel ID under Integrations, Ads.' },
    { id: 'capi', done: Boolean(st.META_ACCESS_TOKEN), label: 'Conversions API token', detail: st.META_ACCESS_TOKEN ? 'Server events reach Meta with the variant params.' : 'Add the Conversions API token under Integrations, Ads.' },
    { id: 'account', done: Boolean(st.META_AD_ACCOUNT_ID), label: 'Ad account chosen', detail: st.META_AD_ACCOUNT_ID ? `act_${st.META_AD_ACCOUNT_ID}` : 'Pick it with Connect ad account on Traffic & ads.' },
    { id: 'write', done: Boolean(metaWriteToken(rt as Runtime)), label: 'Write token with ads_management', detail: 'In Meta Business Settings, Users, System users: add a system user (Admin), assign the ad account with Manage campaigns and the Pixel (dataset), then Generate new token with ads_management (and ads_read). Paste it as Meta ads write token (ads_management) under Integrations, Ads.' },
    { id: 'terms', done: terms === true, label: 'Custom Audience terms accepted', detail: terms === false ? 'Meta refused a list upload because the terms are not accepted. Open business.facebook.com/ads/manage/customaudiences/tos/?act=' + (st.META_AD_ACCOUNT_ID || '<ad account id>') + ', accept as the business that owns the ad account, then tick this step.' : 'Open business.facebook.com/ads/manage/customaudiences/tos/?act=' + (st.META_AD_ACCOUNT_ID || '<ad account id>') + ' while logged in as an admin of the business that owns the ad account, accept the Custom Audience terms, then tick this step.' },
  ];
  const ready = steps.filter((x) => x.id !== 'terms' && x.id !== 'capi').every((x) => x.done);
  return { steps, ready, terms, retentionDays: retentionDays(rt), countries: lookalikeCountries(rt), syncOn: syncOn(rt), scheduleValue: scheduleValueOn(rt) };
}

// ───────────── report for Funnel HQ ─────────────

export async function audiencesReport(rt: Pick<Runtime, 'env' | 'settings'>) {
  const [plan, state, su, values] = await Promise.all([currentPlan(rt), allState(rt), setup(rt), bookingValues(rt).catch(() => [])]);
  const byKey = new Map(state.map((r) => [r.key, r]));
  // Live sizes from our own data: one count per segment (the list and website versions of a segment share it).
  const counts = new Map<string, { n: number; excluded: Record<string, number>; total: number }>();
  for (const it of plan) {
    if (!it.segment) continue;
    const sk = JSON.stringify(it.segment);
    if (counts.has(sk)) continue;
    const m = await segmentMembers(rt, it.segment).catch(() => null);
    counts.set(sk, m ? { n: m.members.length, excluded: m.excluded, total: m.total } : { n: 0, excluded: {}, total: 0 });
  }
  const items = plan.map((it) => {
    const r = byKey.get(it.key);
    const c = it.segment ? counts.get(JSON.stringify(it.segment)) : undefined;
    const src = it.source ? byKey.get(it.source) : undefined;
    return {
      key: it.key, kind: it.kind, group: it.group, name: it.name, description: it.description, exclusion: Boolean(it.exclusion), valueBased: Boolean(it.valueBased),
      ours: c ? { n: c.n, total: c.total, excluded: Object.entries(c.excluded).map(([k, n]) => ({ reason: EXCLUDED_LABEL[k as keyof typeof EXCLUDED_LABEL] ?? k, n })) } : null,
      status: r?.status ?? 'not_created', metaId: r?.meta_id ?? null, error: r?.error ?? null,
      size: r && (r.size_lower != null || r.size_upper != null) ? { lower: r.size_lower, upper: r.size_upper, at: r.size_checked_at } : null,
      metaStatus: r?.meta_status ?? null, lastSynced: r?.last_synced_at ?? null, created: r?.meta_created_at ?? null,
      rule: it.kind === 'website' ? websiteRule(it, String(s(rt).META_PIXEL_ID || '<pixel id>'), retentionDays(rt)) : it.kind === 'conversion' ? conversionRule(it) : it.kind === 'lookalike' ? lookalikeSpec(it) : null,
      source: it.source ?? null, sourceReady: it.source ? src?.status === 'created' : null,
    };
  });
  const pending = (await rt.env.DB.prepare("SELECT id, kind, summary, created_at FROM ops_actions WHERE kind IN (?, ?) AND status = 'proposed' ORDER BY created_at DESC LIMIT 5").bind(CREATE_KIND, LOOKALIKE_KIND).all<{ id: string; kind: string; summary: string; created_at: number }>().catch(() => ({ results: [] }))).results;
  return {
    setup: su, items, pending, recommendations: RECOMMENDATIONS, learningNote: LEARNING_NOTE,
    bookingValues: values,
    summary: {
      conversions: items.filter((i) => i.kind === 'conversion').length, website: items.filter((i) => i.kind === 'website').length,
      lists: items.filter((i) => i.kind === 'list').length, lookalikes: items.filter((i) => i.kind === 'lookalike').length,
      created: items.filter((i) => i.status === 'created').length, queued: items.filter((i) => i.status === 'queued').length, errors: items.filter((i) => i.status === 'error').length,
    },
  };
}

// ───────────── proposals ─────────────

export class AudienceError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

/** "Create all in Meta": one proposal for every conversion and audience not created yet (lookalikes are proposed separately). */
export async function proposeCreateAll(rt: Runtime) {
  const su = await setup(rt);
  if (!su.ready) throw new AudienceError(`Finish the setup first: ${su.steps.filter((x) => !x.done && x.id !== 'terms' && x.id !== 'capi').map((x) => x.label.toLowerCase()).join(', ')}.`, 409);
  if (await rt.env.DB.prepare("SELECT 1 AS x FROM ops_actions WHERE kind = ? AND status = 'proposed' LIMIT 1").bind(CREATE_KIND).first()) throw new AudienceError('A proposal to create them is already waiting for your approval in Command.', 409);
  const [plan, state] = await Promise.all([currentPlan(rt), allState(rt)]);
  const done = new Set(state.filter((r) => r.status === 'created' || r.status === 'queued').map((r) => r.key));
  const keys = plan.filter((i) => i.kind !== 'lookalike' && !done.has(i.key)).map((i) => i.key);
  if (!keys.length) throw new AudienceError('Everything planned is already created or queued.', 409);
  const n = (k: string) => plan.filter((i) => keys.includes(i.key) && i.kind === k).length;
  const id = await proposeAction(rt, {
    dept: 'marketing', kind: CREATE_KIND, risk: 'medium', source: 'audiences',
    summary: `Create ${keys.length} Meta audiences and custom conversions`,
    detail: `${n('conversion')} custom conversions, ${n('website')} website audiences (Pixel rules, ${su.retentionDays} days) and ${n('list')} customer-list audiences (hashed email, phone, name and country of people with marketing consent; synced daily) in ad account act_${s(rt).META_AD_ACCOUNT_ID}. Nothing is spent and no ad changes; campaigns use them only once you pick them in Ads Manager.`,
    payload: { keys },
  });
  return { id, keys: keys.length };
}

/** Lookalikes (1% and 3% per country) from one buyer list that already exists in Meta. */
export async function proposeLookalikes(rt: Runtime, source: string) {
  if (!LOOKALIKE_SOURCES.includes(source)) throw new AudienceError('Lookalikes are made from the buyer lists only.');
  if (!metaWriteConfigured(rt)) throw new AudienceError('Add the Meta write token (ads_management) first.', 409);
  const [plan, state] = await Promise.all([currentPlan(rt), allState(rt)]);
  const src = state.find((r) => r.key === source);
  if (!src || src.status !== 'created' || !src.meta_id) throw new AudienceError('Create the source audience in Meta first.', 409);
  const done = new Set(state.filter((r) => r.status === 'created' || r.status === 'queued').map((r) => r.key));
  const keys = plan.filter((i) => i.kind === 'lookalike' && i.source === source && !done.has(i.key)).map((i) => i.key);
  if (!keys.length) throw new AudienceError('These lookalikes already exist or are queued.', 409);
  const id = await proposeAction(rt, {
    dept: 'marketing', kind: LOOKALIKE_KIND, risk: 'medium', source: 'audiences',
    summary: `Create ${keys.length} lookalike audiences from ${src.name}`,
    detail: `1% and 3% lookalikes for ${lookalikeCountries(rt).join(', ')} from ${src.name} (${src.our_count ?? 0} people uploaded). Meta needs at least 100 matched people from a country in the source.`,
    payload: { keys },
  });
  return { id, keys: keys.length };
}

const payloadKeys = (raw: unknown) => (Array.isArray((raw as { keys?: unknown })?.keys) ? ((raw as { keys: unknown[] }).keys.filter((k) => typeof k === 'string') as string[]) : []);

/** Approved: mark the items queued and create as many as fit now; the cron continues the rest. */
async function queueApproved(rt: Runtime, raw: unknown, kinds: string[]) {
  if (!metaWriteConfigured(rt)) return { ok: false, summary: 'No Meta write token (ads_management), so nothing was created. Add it under Integrations, Ads and approve again.' };
  const plan = await currentPlan(rt);
  const wanted = new Set(payloadKeys(raw));
  const items = plan.filter((i) => wanted.has(i.key) && kinds.includes(i.kind));
  const now = Date.now();
  for (const it of items) {
    await rt.env.DB.prepare(
      `INSERT INTO meta_audiences (key, kind, name, status, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, ?)
       ON CONFLICT(key) DO UPDATE SET status = CASE WHEN meta_audiences.status = 'created' THEN 'created' ELSE 'queued' END, name = excluded.name, error = NULL, updated_at = excluded.updated_at`,
    ).bind(it.key, it.kind, it.name, now, now).run();
  }
  const r = await processQueue(rt, 25);
  return { ok: r.errors === 0 || r.created > 0, summary: `Queued ${items.length}. Created ${r.created} now${r.errors ? `, ${r.errors} failed (see Meta audiences)` : ''}; the rest continue every 5 minutes.` };
}

registerActionHandler(CREATE_KIND, (rt, raw) => queueApproved(rt, raw, ['conversion', 'website', 'list']), { label: 'Create Meta audiences and custom conversions' });
registerActionHandler(LOOKALIKE_KIND, (rt, raw) => queueApproved(rt, raw, ['lookalike']), { label: 'Create Meta lookalike audiences' });

// ───────────── doing the work ─────────────

const ORDER: Record<string, number> = { conversion: 0, website: 1, list: 2, lookalike: 3 };

/** Creates queued items in Meta, at most `budget` Graph calls per run. */
export async function processQueue(rt: Runtime, budget = 20) {
  const out = { created: 0, errors: 0, calls: 0 };
  if (!metaWriteConfigured(rt)) return out;
  const queued = (await rt.env.DB.prepare("SELECT * FROM meta_audiences WHERE status = 'queued'").all<StateRow>()).results.sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  if (!queued.length) return out;
  const plan = await currentPlan(rt);
  const byKey = new Map(plan.map((i) => [i.key, i]));
  for (const row of queued) {
    if (out.calls >= budget) break;
    const it = byKey.get(row.key);
    if (!it) { await mark(rt, row.key, { status: 'error', error: 'No longer in the plan (its session time has no sessions any more).' }); continue; }
    try {
      out.calls += await createOne(rt, it);
      out.created++;
    } catch (e) {
      out.errors++;
      out.calls++;
      if (e instanceof MetaError && e.terms) await setTerms(rt, 'refused');
      await mark(rt, row.key, { status: 'error', error: String(e instanceof Error ? e.message : e).slice(0, 500) });
    }
  }
  return out;
}

async function mark(rt: Pick<Runtime, 'env'>, key: string, f: Partial<Record<'status' | 'error' | 'meta_id' | 'spec' | 'our_count' | 'members_hash' | 'meta_created_at' | 'last_synced_at' | 'size_lower' | 'size_upper' | 'meta_status' | 'size_checked_at', string | number | null>>) {
  const cols = Object.keys(f);
  await rt.env.DB.prepare(`UPDATE meta_audiences SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE key = ?`).bind(...cols.map((c) => (f as Record<string, unknown>)[c] ?? null), Date.now(), key).run();
}

/** Creates one item (and uploads a list's first members). Returns the Graph calls used. */
async function createOne(rt: Runtime, it: PlanItem): Promise<number> {
  const pixel = String(s(rt).META_PIXEL_ID || '');
  const now = Date.now();
  if (it.kind === 'conversion') {
    const rule = conversionRule(it);
    const r = await createCustomConversion(rt, { name: it.name, description: it.description, rule, customEventType: it.customEventType! });
    await mark(rt, it.key, { status: 'created', meta_id: r.id, spec: JSON.stringify(rule), meta_created_at: now, error: null });
    return 1;
  }
  if (it.kind === 'website') {
    const rule = websiteRule(it, pixel, retentionDays(rt));
    const r = await createWebsiteAudience(rt, { name: it.name, description: it.description, rule, retentionDays: retentionDays(rt) });
    await mark(rt, it.key, { status: 'created', meta_id: r.id, spec: JSON.stringify(rule), meta_created_at: now, error: null });
    return 1;
  }
  if (it.kind === 'lookalike') {
    const src = await rt.env.DB.prepare("SELECT meta_id FROM meta_audiences WHERE key = ? AND status = 'created'").bind(it.source!).first<{ meta_id: string }>();
    if (!src?.meta_id) throw new Error('The source audience is not in Meta yet.');
    const spec = lookalikeSpec(it);
    const r = await createLookalike(rt, { name: it.name, originId: src.meta_id, spec });
    await mark(rt, it.key, { status: 'created', meta_id: r.id, spec: JSON.stringify(spec), meta_created_at: now, error: null });
    return 1;
  }
  // Customer list: create (unless a failed upload left one behind), then upload everyone.
  const existing = await rt.env.DB.prepare('SELECT meta_id FROM meta_audiences WHERE key = ?').bind(it.key).first<{ meta_id: string | null }>();
  let calls = 0;
  let id = existing?.meta_id ?? null;
  if (!id) {
    id = (await createListAudience(rt, { name: it.name, description: it.description, valueBased: Boolean(it.valueBased) })).id;
    calls++;
    await mark(rt, it.key, { meta_id: id, meta_created_at: now });
  }
  calls += await syncList(rt, it, id, false);
  await mark(rt, it.key, { status: 'created', error: null });
  return calls;
}

/** Uploads a list's current members (full replace after the first upload). Returns the Graph calls used. */
export async function syncList(rt: Runtime, it: PlanItem, metaId: string, replace: boolean) {
  const { members } = await segmentMembers(rt, it.segment!);
  const rows = await Promise.all(members.map((m) => hashRow(m, Boolean(it.valueBased))));
  const hash = await membersHash(rows);
  const prev = await rt.env.DB.prepare('SELECT members_hash FROM meta_audiences WHERE key = ?').bind(it.key).first<{ members_hash: string | null }>();
  const now = Date.now();
  // Unchanged since the last upload, or nobody to upload (Meta rejects an empty upload): nothing to send.
  if ((replace && prev?.members_hash === hash) || !rows.length) {
    await mark(rt, it.key, { our_count: rows.length, last_synced_at: now });
    return 0;
  }
  await mark(rt, it.key, { status: 'syncing' });
  try {
    const calls = await uploadUsers(rt, metaId, it.valueBased ? VALUE_SCHEMA : LIST_SCHEMA, rows, replace);
    await mark(rt, it.key, { status: 'created', our_count: rows.length, members_hash: hash, last_synced_at: now, error: null });
    if (rows.length) await setTerms(rt, 'accepted');
    return calls;
  } catch (e) {
    if (e instanceof MetaError && e.terms) await setTerms(rt, 'refused');
    await mark(rt, it.key, { status: 'created', error: `Last sync failed: ${String(e instanceof Error ? e.message : e).slice(0, 400)}` });
    throw e;
  }
}

/** Sync one created list now (Funnel HQ "Sync now"). */
export async function syncNow(rt: Runtime, key: string) {
  if (!metaWriteConfigured(rt)) throw new AudienceError('Add the Meta write token (ads_management) first.', 409);
  const row = await rt.env.DB.prepare("SELECT * FROM meta_audiences WHERE key = ? AND kind = 'list' AND status = 'created'").bind(key).first<StateRow>();
  if (!row?.meta_id) throw new AudienceError('Only a list that exists in Meta can be synced.', 404);
  const it = (await currentPlan(rt)).find((i) => i.key === key);
  if (!it) throw new AudienceError('This list is no longer in the plan.', 404);
  await syncList(rt, it, row.meta_id, Boolean(row.members_hash));
  return { ok: true };
}

/**
 * Cron (every 5 minutes, light): continue queued creations, then once a day per list re-upload its members
 * (full replace, skipped when unchanged) and refresh Meta's size estimates. Only with the write token, and only
 * for items an approved action created. Also sends the two extra webinar stage events audiences use.
 */
export async function maybeSyncAudiences(rt: Runtime) {
  const out = { stageEvents: await sendStageFollowups(rt).catch(() => 0), queue: null as null | Awaited<ReturnType<typeof processQueue>>, synced: 0, sized: 0 };
  if (!metaWriteConfigured(rt)) return out;
  out.queue = await processQueue(rt, 15);
  const now = Date.now();
  if (syncOn(rt)) {
    const due = (await rt.env.DB.prepare("SELECT * FROM meta_audiences WHERE kind = 'list' AND status = 'created' AND meta_id IS NOT NULL AND COALESCE(last_synced_at, 0) < ? ORDER BY COALESCE(last_synced_at, 0) LIMIT 2").bind(now - DAY + 30 * 60_000).all<StateRow>()).results;
    if (due.length) {
      const plan = await currentPlan(rt);
      for (const row of due) {
        const it = plan.find((i) => i.key === row.key);
        if (!it) continue;
        try { await syncList(rt, it, row.meta_id!, Boolean(row.members_hash)); out.synced++; } catch { /* recorded on the row */ }
      }
    }
  }
  const sizeDue = (await rt.env.DB.prepare("SELECT key, meta_id FROM meta_audiences WHERE kind != 'conversion' AND status = 'created' AND meta_id IS NOT NULL AND COALESCE(size_checked_at, 0) < ? LIMIT 5").bind(now - DAY).all<{ key: string; meta_id: string }>()).results;
  for (const r of sizeDue) {
    try {
      const z = await audienceSize(rt, r.meta_id);
      await mark(rt, r.key, { size_lower: z.approximate_count_lower_bound ?? null, size_upper: z.approximate_count_upper_bound ?? null, meta_status: z.delivery_status?.description ?? z.operation_status?.description ?? null, size_checked_at: now });
      out.sized++;
    } catch (e) {
      await mark(rt, r.key, { meta_status: String(e instanceof Error ? e.message : e).slice(0, 200), size_checked_at: now });
    }
  }
  return out;
}

// ───────────── extra stage events: watched 50% and checkout started (once per registration) ─────────────

const FOLLOWUPS = [
  { stage: 'watched_50', name: 'attr_watched_50', id: 'w50' },
  { stage: 'checkout_started', name: 'attr_checkout_started', id: 'ics' },
  { stage: 'ticket_checkout_started', name: 'attr_checkout_started', id: 'ics' },
];

/**
 * Meta has no event for watch depth or for opening our checkout, so audiences for "watched 50%+" and "started
 * checkout, didn't buy" need one. Sent once per registration from the stage rows (src/attribution), within Meta's
 * 7-day window, through track() so consent, retries and the delivery log apply as for every other event.
 */
export async function sendStageFollowups(rt: Runtime, limit = 25) {
  const st = s(rt);
  if (!st.META_PIXEL_ID || !st.META_ACCESS_TOKEN || !flag(st.META_STAGE_EVENTS, true)) return 0;
  let sent = 0;
  for (const f of FOLLOWUPS) {
    const { results } = await rt.env.DB.prepare(
      `SELECT a.funnel, a.lead_id, a.reg_id FROM attr_stages a
        WHERE a.stage = ? AND a.ts > ? AND NOT EXISTS (SELECT 1 FROM attr_capi c WHERE c.key = ? || ':' || a.reg_id) LIMIT ?`,
    ).bind(f.stage, Date.now() - 6 * DAY, f.name, limit).all<{ funnel: string; lead_id: string; reg_id: string }>().catch(() => ({ results: [] as { funnel: string; lead_id: string; reg_id: string }[] }));
    for (const r of results) {
      const eventId = `${f.id}-${r.reg_id}`.slice(0, 64);
      const ins = await rt.env.DB.prepare('INSERT OR IGNORE INTO attr_capi (key, name, lead_id, event_id, sent_at) VALUES (?, ?, ?, ?, ?)').bind(`${f.name}:${r.reg_id}`, f.name, r.lead_id, eventId, Date.now()).run();
      if (!ins.meta.changes) continue;
      await track(rt, await identityFromLead(rt.env, r.lead_id), { name: f.name, source: 'server', path: r.funnel === 'auto' ? '/webinar' : `/${r.funnel}`, props: { funnel: r.funnel, reg_id: r.reg_id }, eventId });
      sent++;
    }
  }
  return sent;
}
