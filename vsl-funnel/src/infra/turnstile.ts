import type { Runtime } from '../app';
import type { Env } from '../env';
import type { Settings } from '../settings';
import { recordError } from './errors';

/**
 * Cloudflare Turnstile (bot protection) on the public forms (Cloudflare platform round, builder B).
 *
 * Setting TURNSTILE_MODE:
 *  - off (default, or when either key is missing): nothing loads, nothing is checked; the forms work exactly as before.
 *  - log: the widget runs invisibly (it only shows itself when Cloudflare wants an interaction) and the server verifies
 *    the token, records pass/fail per form, and never refuses anything.
 *  - enforce: a failed or missing token is refused with a calm message (403, field "turnstile"); the form keeps what
 *    was typed and the widget runs again.
 * Fail open, always: if siteverify can't be reached (network, 5xx, timeout) or answers that our own secret is wrong,
 * the submission goes through and the problem goes to the error log (Funnel HQ → Errors & cron).
 *
 * Counts per UTC day, form and outcome are kept in kv_state (`tsv:<day>:<form>:<outcome>`) for the
 * "Bot protection" card. In enforce mode a hard failure also marks the visitor's session as non-human
 * (bot_reason "turnstile"), like the other non-human filters, so it stays out of ad audiences and numbers;
 * a later pass in the same session clears it. Visitors linked to a lead are never marked.
 *
 * Covered: the application (contact step), masterclass (auto webinar) registration, live registration, challenge
 * registration and the room general-admission join sheet. Never on staff/admin routes, webhooks or personal room links.
 */

export type TurnstileMode = 'off' | 'log' | 'enforce';
export const TURNSTILE_FORMS = ['apply', 'webinar', 'live', 'challenge', 'room_join'] as const;
export type TurnstileForm = (typeof TURNSTILE_FORMS)[number];
export type TurnstileOutcome = 'pass' | 'fail' | 'missing' | 'unreachable';
export const TURNSTILE_OUTCOMES: TurnstileOutcome[] = ['pass', 'fail', 'missing', 'unreachable'];

export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
export const TURNSTILE_SCRIPT = `${TURNSTILE_ORIGIN}/turnstile/v0/api.js`;
export const SITEVERIFY_URL = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;
export const SITEVERIFY_TIMEOUT_MS = 5000;

export const TURNSTILE_COPY = {
  failed: 'We couldn’t confirm this browser yet. Your details are still here. Wait a moment and send the form again.',
};

/** Error codes that mean our own configuration is wrong (or Cloudflare had a problem), not the visitor: fail open. */
const CONFIG_CODES = new Set(['missing-input-secret', 'invalid-input-secret', 'bad-request', 'internal-error']);
/** An expired or reused token: a real person who waited too long; refused in enforce mode but never marked a bot. */
const SOFT_CODES = new Set(['timeout-or-duplicate', 'missing-input-response']);

type S = Pick<Settings, 'TURNSTILE_MODE' | 'TURNSTILE_SITE_KEY' | 'TURNSTILE_SECRET_KEY'>;

export function turnstileMode(s: Partial<S> | null | undefined): TurnstileMode {
  const m = (s?.TURNSTILE_MODE ?? '').trim().toLowerCase();
  if (m !== 'log' && m !== 'enforce') return 'off';
  if (!s?.TURNSTILE_SITE_KEY?.trim() || !s?.TURNSTILE_SECRET_KEY?.trim()) return 'off';
  return m;
}
/** The site key browsers get, or null when Turnstile is off (then no script is loaded and no widget renders). */
export const turnstileSiteKey = (s: Partial<S> | null | undefined) => (turnstileMode(s) === 'off' ? null : s!.TURNSTILE_SITE_KEY!.trim());
/** Why the mode is off although someone asked for it (for the card). */
export function turnstileMisconfig(s: Partial<S>): string | null {
  const m = (s.TURNSTILE_MODE ?? '').trim().toLowerCase();
  if (m !== 'log' && m !== 'enforce') return null;
  if (!s.TURNSTILE_SITE_KEY?.trim()) return 'The site key is missing, so bot protection is off.';
  if (!s.TURNSTILE_SECRET_KEY?.trim()) return 'The secret key is missing, so bot protection is off.';
  return null;
}

export interface TurnstileVisitor { ip: string | null; sessionId?: string | null; visitorId?: string | null; leadId?: string | null; isBot?: boolean; botReason?: string | null }
export interface TurnstileResult { ok: boolean; mode: TurnstileMode; outcome: TurnstileOutcome | 'off'; codes: string[] }

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);
export const counterKey = (day: string, form: string, outcome: string) => `tsv:${day}:${form}:${outcome}`;

async function count(env: Pick<Env, 'DB'>, form: TurnstileForm, outcome: TurnstileOutcome, now: number) {
  try {
    await env.DB.prepare("INSERT INTO kv_state (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)")
      .bind(counterKey(dayOf(now), form, outcome)).run();
  } catch (e) { console.error('turnstile count', String(e).slice(0, 200)); }
}

/** Enforce-mode hard failure: this session (and the visitor, if none of their visits was a person) stops counting. */
async function markBot(env: Pick<Env, 'DB'>, v: TurnstileVisitor) {
  if (!v.sessionId || v.leadId) return;
  v.isBot = true;
  v.botReason = 'turnstile';
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET is_bot = 1, bot_reason = 'turnstile' WHERE id = ? AND is_bot = 0").bind(v.sessionId),
      env.DB.prepare('UPDATE events SET is_bot = 1 WHERE session_id = ?').bind(v.sessionId),
      ...(v.visitorId ? [env.DB.prepare('UPDATE visitors SET is_bot = 1 WHERE id = ? AND lead_id IS NULL AND NOT EXISTS (SELECT 1 FROM sessions WHERE visitor_id = ? AND is_bot = 0)').bind(v.visitorId, v.visitorId)] : []),
    ]);
  } catch (e) { console.error('turnstile mark', String(e).slice(0, 200)); }
}
/** A pass after an earlier Turnstile failure in the same session: the person counts again. */
async function clearBot(env: Pick<Env, 'DB'>, v: TurnstileVisitor) {
  if (!v.sessionId || v.botReason !== 'turnstile') return;
  v.isBot = false;
  v.botReason = null;
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE sessions SET is_bot = 0, bot_reason = NULL WHERE id = ? AND bot_reason = 'turnstile'").bind(v.sessionId),
      env.DB.prepare('UPDATE events SET is_bot = 0 WHERE session_id = ?').bind(v.sessionId),
      ...(v.visitorId ? [env.DB.prepare('UPDATE visitors SET is_bot = 0 WHERE id = ?').bind(v.visitorId)] : []),
    ]);
  } catch (e) { console.error('turnstile clear', String(e).slice(0, 200)); }
}

/**
 * Checks one form submission. `ok` false only in enforce mode, for a missing or failed token.
 * Never throws; siteverify problems fail open.
 */
export async function checkTurnstile(rt: Pick<Runtime, 'env' | 'settings'>, form: TurnstileForm, token: unknown, v: TurnstileVisitor, now = Date.now()): Promise<TurnstileResult> {
  const mode = turnstileMode(rt.settings);
  if (mode === 'off') return { ok: true, mode, outcome: 'off', codes: [] };
  const enforce = mode === 'enforce';
  if (typeof token !== 'string' || !token.trim() || token.length > 4096) {
    await count(rt.env, form, 'missing', now);
    return { ok: !enforce, mode, outcome: 'missing', codes: [] };
  }
  type Answer = { success?: boolean; 'error-codes'?: unknown };
  let data = null as Answer | null;
  let problem: string | null = null;
  try {
    const body = new FormData();
    body.append('secret', rt.settings.TURNSTILE_SECRET_KEY.trim());
    body.append('response', token);
    if (v.ip) body.append('remoteip', v.ip);
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS) });
    if (!res.ok) problem = `HTTP ${res.status}`;
    else {
      data = (await res.json().catch(() => null)) as Answer | null;
      if (!data || typeof data.success !== 'boolean') problem = 'unreadable answer';
    }
  } catch (e) {
    problem = (e as Error)?.name === 'TimeoutError' || (e as Error)?.name === 'AbortError' ? 'timed out' : 'unreachable';
  }
  const codes = Array.isArray(data?.['error-codes']) ? (data!['error-codes'] as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 5) : [];
  if (!problem && data && !data.success && codes.some((c) => CONFIG_CODES.has(c))) problem = `rejected our configuration (${codes.join(', ')})`;
  if (problem) {
    // Fail open: Cloudflare unreachable or our keys wrong must never stop a real person. The secret is never logged.
    await count(rt.env, form, 'unreachable', now);
    await recordError(rt.env, new Error(`Turnstile siteverify ${problem}; the ${form} form was let through`), { kind: 'request', source: `turnstile ${form}` });
    return { ok: true, mode, outcome: 'unreachable', codes };
  }
  if (data!.success) {
    await count(rt.env, form, 'pass', now);
    await clearBot(rt.env, v);
    return { ok: true, mode, outcome: 'pass', codes };
  }
  await count(rt.env, form, 'fail', now);
  if (enforce && (!codes.length || codes.some((c) => !SOFT_CODES.has(c)))) await markBot(rt.env, v);
  return { ok: !enforce, mode, outcome: 'fail', codes };
}

/** The Bot protection card: mode, keys, and pass/fail counts per form for the last `days` UTC days. */
export async function turnstileReport(rt: Pick<Runtime, 'env' | 'settings'>, now = Date.now(), days = 7) {
  const from = dayOf(now - (days - 1) * 86_400_000);
  const { results } = await rt.env.DB.prepare("SELECT key, value FROM kv_state WHERE key >= ? AND key < 'tsv;'").bind(`tsv:${from}`).all<{ key: string; value: string }>();
  const forms: Record<string, Record<TurnstileOutcome, number>> = {};
  for (const f of TURNSTILE_FORMS) forms[f] = { pass: 0, fail: 0, missing: 0, unreachable: 0 };
  for (const r of results) {
    const [, , form, outcome] = r.key.split(':');
    if (!forms[form] || !TURNSTILE_OUTCOMES.includes(outcome as TurnstileOutcome)) continue;
    forms[form][outcome as TurnstileOutcome] += Number(r.value) || 0;
  }
  const s = rt.settings;
  return {
    mode: turnstileMode(s),
    requested: (s.TURNSTILE_MODE || 'off').trim().toLowerCase() || 'off',
    siteKey: Boolean(s.TURNSTILE_SITE_KEY?.trim()),
    secretKey: Boolean(s.TURNSTILE_SECRET_KEY?.trim()),
    problem: turnstileMisconfig(s),
    days,
    forms: TURNSTILE_FORMS.map((f) => ({ form: f, ...forms[f] })),
  };
}
