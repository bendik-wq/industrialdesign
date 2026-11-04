import type { Runtime } from '../app';
import type { Env } from '../env';
import type { Lead } from '../funnel/leads';
import { hmacHex } from '../lib/crypto';
import { newId } from '../lib/ids';
import { getSecret } from '../lib/secret';
import { callingZones } from './elevenlabs';

/**
 * The one gate in front of every automated call, text and WhatsApp message (US TCPA, AU Spam Act and
 * Do Not Call Register Act, and the UK/NZ/IE/SG/UAE equivalents). The send primitives (sendSmsNow,
 * sendWhatsAppText/Template, dial) refuse to run without a ContactPass, and a pass can only be made here:
 *
 *  - canCall / canText: the lead agreed to THAT channel, for the number on file now (a new number needs new
 *    consent), hasn't replied STOP or asked not to be called, isn't an imported contact without consent, and
 *    the number is in a country we contact. Every refusal is logged (contact_gate_log, deduped per hour).
 *  - testPass: the owner's test call or text from a Funnel HQ test button, to a number that is not a lead's
 *    number without consent. Always logged (outcome 'test').
 *  - replyPass: a reply to a message the person just sent us (STOP confirmation, "C" to confirm). Only the
 *    inbound webhooks may use it (test/consent-gate.test.ts scans for it).
 *
 * test/consent-gate.test.ts fails if any file outside the primitives calls a provider endpoint directly.
 */

// ───────────────────────────── the wording (bump the version on any change) ─────────────────────────────

/**
 * Shown next to two separate, unticked boxes on every form that takes a mobile number. Optional: consent is
 * never a condition of registering, applying or buying (TCPA; bundled consent is invalid under the Spam Act).
 * The exact text and its version are stored with each consent (consent_events).
 */
export const CONSENT_COPY = {
  version: 'c3-2026-11',
  call: 'Calls: G&L M&A Advisory (Josh Li’s team) may call me at this number about my registration, application or strategy call and Josh’s offers, including automated and AI-voice calls, which are recorded. Consent isn’t required to register or buy. Say stop on any call to opt out.',
  sms: 'Texts: G&L M&A Advisory (Josh Li’s team) may text me at this number by SMS or WhatsApp about my registration, application or strategy call and Josh’s offers, including automated texts. Consent isn’t required to register or buy. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out.',
};

/** The line above the two boxes. */
export const CONSENT_LEGEND = 'Calls and texts (optional, tick either, both or neither)';

/** Consent wording versions from before c3: every one of them said "call or text", so a call consent from then covers texts too. */
const legacyCallCoversTexts = (version: string | null) => !version || !version.startsWith('c3');
/**
 * The application's old box (v1, v2) covered "my application and strategy call" only, and the old session text
 * boxes covered that session's reminders only: neither covers calls or texts that sell (the webinar, live and
 * challenge offer calls, offer follow-up texts). Consents with proof rows use the c3 wording, which names offers.
 */
const APPLICATION_ONLY = new Set(['v1', 'v2']);
const OFFER_PURPOSE = /^(ai_call:w_|sms:(webinar|challenge|live)|live_text|followup_text:(?!no_show))/;
const REMINDER_PURPOSE = /^(sms:(webinar|challenge|live)|live_text)/;

export type ContactChannel = 'call' | 'sms' | 'whatsapp';

export interface ConsentRow {
  channel: ContactChannel;
  action: 'granted' | 'revoked';
  phone: string | null;
  source: string;
  page_url: string | null;
  text_version: string | null;
  created_at: number;
}

// ───────────────────────────── the rule (pure; the sandbox mirrors it) ─────────────────────────────

type GateLead = Pick<Lead, 'phone' | 'do_not_call_at' | 'sms_opt_out_at' | 'booking_source' | 'call_consent_at' | 'call_consent_text' | 'sms_consent_at' | 'wa_consent_at' | 'whatsapp_connected_at'>;

/** Why this lead can't be contacted on this channel (null = allowed). `rows` are the lead's consent_events, oldest first. */
export function consentBlock(lead: GateLead, channel: ContactChannel, rows: ConsentRow[], purpose = ''): string | null {
  if (!lead.phone) return 'no phone number';
  if (!callingZones(lead.phone)) return 'number outside the countries we contact';
  if (channel === 'call' && lead.do_not_call_at) return 'asked not to be called';
  if (lead.sms_opt_out_at) return 'replied STOP';
  const mine = rows.filter((r) => r.channel === channel);
  const last = mine[mine.length - 1];
  // They messaged us on WhatsApp after the last consent change: replies and templates there are allowed.
  if (channel === 'whatsapp' && lead.whatsapp_connected_at && (!last || last.created_at <= lead.whatsapp_connected_at)) return null;
  if (last) {
    if (last.action !== 'granted') return last.source === 'phone-changed' ? 'number changed since consent' : 'consent withdrawn';
    if (last.phone !== lead.phone) return 'consent was for a different number';
    return null;
  }
  // No proof rows (consent from before 0085): the leads.* timestamp is the proof, never for imported contacts.
  if (lead.booking_source === 'calendly-direct') return 'imported contact without consent';
  const offer = OFFER_PURPOSE.test(purpose);
  const callCovers = Boolean(lead.call_consent_at) && !(offer && APPLICATION_ONLY.has(lead.call_consent_text ?? ''));
  if (channel === 'call') return callCovers ? null : lead.call_consent_at ? 'old consent wording doesn’t cover offers' : 'no consent to call';
  // The old session text boxes: reminders for that session, nothing that sells.
  const smsCovers = Boolean(lead.sms_consent_at) && (!offer || REMINDER_PURPOSE.test(purpose));
  const oldTextConsent = Boolean(lead.sms_consent_at) || (Boolean(lead.call_consent_at) && legacyCallCoversTexts(lead.call_consent_text));
  if (channel === 'sms') return smsCovers || (callCovers && legacyCallCoversTexts(lead.call_consent_text)) ? null : oldTextConsent ? 'old consent wording doesn’t cover this text' : 'no consent to text';
  return lead.wa_consent_at && (!offer || REMINDER_PURPOSE.test(purpose) || !APPLICATION_ONLY.has(lead.call_consent_text ?? '')) ? null : lead.wa_consent_at ? 'old consent wording doesn’t cover this text' : 'no consent to WhatsApp';
}

// ───────────────────────────── passes ─────────────────────────────

/** Proof the gate said yes, for one channel and one destination. Only this module can make one; it expires after 10 minutes. */
export interface ContactPass {
  readonly channel: ContactChannel;
  readonly to: string;
  readonly leadId: string | null;
  readonly purpose: string;
  readonly basis: 'consent' | 'test' | 'reply';
  readonly at: number;
}
const issued = new WeakSet<ContactPass>();
const PASS_TTL = 10 * 60_000;
function issue(p: Omit<ContactPass, 'at'>): ContactPass {
  const pass = Object.freeze({ ...p, at: Date.now() });
  issued.add(pass);
  return pass;
}
/** Called by every send primitive: the destination, or a throw when there is no valid pass for this channel. */
export function passTo(pass: ContactPass | null | undefined, channel: ContactChannel): string {
  if (!pass || !issued.has(pass) || pass.channel !== channel || Date.now() - pass.at > PASS_TTL || !pass.to) throw new Error(`Blocked by the contact gate: no consent pass for this ${channel === 'call' ? 'call' : 'message'}`);
  return pass.to;
}
/** Test helper and Sandbox: is this a real pass. */
export const isPass = (p: unknown): p is ContactPass => typeof p === 'object' && p !== null && issued.has(p as ContactPass);

// ───────────────────────────── the gate ─────────────────────────────

export async function consentRows(env: Env, leadId: string): Promise<ConsentRow[]> {
  const { results } = await env.DB.prepare('SELECT channel, action, phone, source, page_url, text_version, created_at FROM consent_events WHERE lead_id = ? ORDER BY created_at, rowid').bind(leadId).all<ConsentRow>();
  return results ?? [];
}

export type Gate = { ok: true; pass: ContactPass } | { ok: false; reason: string };

const waTo = (lead: Pick<Lead, 'phone' | 'whatsapp_wa_id'>) => lead.whatsapp_wa_id || (lead.phone ?? '').replace(/\D/g, '');

async function gate(rt: Pick<Runtime, 'env'>, lead: Lead, channel: ContactChannel, purpose: string, log: boolean): Promise<Gate> {
  let rows: ConsentRow[];
  try {
    rows = await consentRows(rt.env, lead.id);
  } catch (e) {
    console.error('contact gate: consent lookup failed', String(e).slice(0, 200));
    return { ok: false, reason: 'consent check failed' }; // fails closed
  }
  const reason = consentBlock(lead, channel, rows, purpose);
  if (reason) {
    if (log) await logGate(rt, { leadId: lead.id, channel, purpose, outcome: 'blocked', reason, phone: lead.phone });
    return { ok: false, reason };
  }
  return { ok: true, pass: issue({ channel, to: channel === 'whatsapp' ? waTo(lead) : lead.phone!, leadId: lead.id, purpose, basis: 'consent' }) };
}

/** May we place an automated (AI) call to this lead now? `purpose` names the flow, e.g. "ai_call:confirm". */
export const canCall = (rt: Pick<Runtime, 'env'>, lead: Lead, purpose: string, o: { log?: boolean } = {}) => gate(rt, lead, 'call', purpose, o.log ?? true);
/** May we text this lead (SMS, or WhatsApp)? */
export const canText = (rt: Pick<Runtime, 'env'>, lead: Lead, purpose: string, channel: 'sms' | 'whatsapp' = 'sms', o: { log?: boolean } = {}) => gate(rt, lead, channel, purpose, o.log ?? true);

/**
 * The owner's test call or text from a Funnel HQ test button. Refused when the number belongs to a lead who
 * hasn't agreed to that channel (a test button is never a way round the gate). Always logged.
 */
export async function testPass(rt: Pick<Runtime, 'env'>, channel: ContactChannel, to: string, purpose: string): Promise<Gate> {
  const phone = to.startsWith('+') ? to : `+${to.replace(/\D/g, '')}`;
  const { results } = await rt.env.DB.prepare('SELECT * FROM leads WHERE phone = ? LIMIT 20').bind(phone).all<Lead>();
  for (const lead of results ?? []) {
    const reason = consentBlock(lead, channel, await consentRows(rt.env, lead.id).catch(() => []));
    if (reason) {
      await logGate(rt, { leadId: lead.id, channel, purpose: `test:${purpose}`, outcome: 'blocked', reason: `test to a lead's number: ${reason}`, phone });
      return { ok: false, reason: `That number belongs to a lead the gate blocks (${reason}). Use your own number.` };
    }
  }
  await logGate(rt, { leadId: null, channel, purpose: `test:${purpose}`, outcome: 'test', reason: 'owner test from Funnel HQ', phone });
  return { ok: true, pass: issue({ channel, to: channel === 'whatsapp' ? phone.replace(/\D/g, '') : phone, leadId: null, purpose: `test:${purpose}`, basis: 'test' }) };
}

/** A reply to a message this person just sent us (inbound webhooks only). */
export const replyPass = (channel: 'sms' | 'whatsapp', to: string, purpose: string) => issue({ channel, to, leadId: null, purpose: `reply:${purpose}`, basis: 'reply' });

export async function logGate(rt: Pick<Runtime, 'env'>, x: { leadId: string | null; channel: ContactChannel; purpose: string; outcome: 'blocked' | 'test'; reason: string; phone: string | null }, now = Date.now()) {
  const stmt = x.outcome === 'blocked'
    ? rt.env.DB.prepare(`INSERT INTO contact_gate_log (id, lead_id, channel, purpose, outcome, reason, phone, created_at)
        SELECT ?, ?, ?, ?, 'blocked', ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM contact_gate_log WHERE lead_id IS ? AND channel = ? AND purpose = ? AND reason = ? AND created_at > ?)`)
      .bind(newId('cg'), x.leadId, x.channel, x.purpose.slice(0, 80), x.reason.slice(0, 200), x.phone, now, x.leadId, x.channel, x.purpose.slice(0, 80), x.reason.slice(0, 200), now - 3_600_000)
    : rt.env.DB.prepare(`INSERT INTO contact_gate_log (id, lead_id, channel, purpose, outcome, reason, phone, created_at) VALUES (?, ?, ?, ?, 'test', ?, ?, ?)`)
      .bind(newId('cg'), x.leadId, x.channel, x.purpose.slice(0, 80), x.reason.slice(0, 200), x.phone, now);
  await stmt.run().catch((e: unknown) => console.error('contact gate log', String(e).slice(0, 200)));
}

// ───────────────────────────── recording consent ─────────────────────────────

const ticked = (v: unknown) => v === true || v === 'true' || v === 'on' || v === '1';
export const tickedCall = (body: Record<string, unknown>) => ticked(body.call_consent);
export const tickedTexts = (body: Record<string, unknown>) => ticked(body.sms_consent);

export interface ConsentCapture {
  /** The number typed on the form. Consent is recorded only when it is the number on the lead now. */
  phone: string | null;
  call: boolean;
  texts: boolean;
  /** Which form: apply, webinar, live, challenge, admission, webinar-thanks, live-texts. */
  source: string;
  /** The page path the form was on. */
  page?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** Wording shown (defaults to CONSENT_COPY). */
  copy?: { version: string; call?: string; sms?: string };
}

const cleanPage = (p: unknown) => (typeof p === 'string' ? p.replace(/[^\w\-./?=&%:]/g, '').slice(0, 200) || null : null);
/** The page the form was on, from the body the browser sent (consent_page) or the route's own path. */
export const consentPage = (body: Record<string, unknown>, fallback: string) => cleanPage(body.consent_page) ?? fallback;

async function ipHashOf(env: Env, ip: string | null | undefined) {
  return ip ? (await hmacHex(await getSecret(env), ip)).slice(0, 24) : null;
}

/**
 * Records what was ticked, with proof (time, channel, number, exact wording and version, form, page, hashed IP,
 * user agent), and keeps the leads.* timestamps the rest of the app reads in step. Never records consent for a
 * number other than the lead's, never overrides "do not call" or STOP. Returns what was recorded.
 */
export async function recordConsent(rt: Pick<Runtime, 'env'>, leadId: string, c: ConsentCapture, now = Date.now()): Promise<{ call: boolean; texts: boolean }> {
  const out = { call: false, texts: false };
  if (!c.phone || (!c.call && !c.texts)) return out;
  const lead = await rt.env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(leadId).first<Lead>();
  if (!lead || lead.phone !== c.phone) return out;
  const copy = { version: c.copy?.version ?? CONSENT_COPY.version, call: c.copy?.call ?? CONSENT_COPY.call, sms: c.copy?.sms ?? CONSENT_COPY.sms };
  const ipHash = await ipHashOf(rt.env, c.ip);
  const ua = c.userAgent ? c.userAgent.slice(0, 300) : null;
  const page = cleanPage(c.page);
  const rows: [ContactChannel, string][] = [];
  if (c.call && !lead.do_not_call_at && !lead.sms_opt_out_at) { rows.push(['call', copy.call]); out.call = true; }
  if (c.texts && !lead.sms_opt_out_at) { rows.push(['sms', copy.sms], ['whatsapp', copy.sms]); out.texts = true; }
  if (!rows.length) return out;
  const db = rt.env.DB;
  await db.batch([
    ...rows.map(([channel, text]) => db.prepare(`INSERT INTO consent_events (id, lead_id, channel, action, phone, source, page_url, text_version, text, ip_hash, user_agent, created_at)
      VALUES (?, ?, ?, 'granted', ?, ?, ?, ?, ?, ?, ?, ?)`).bind(newId('ce'), leadId, channel, c.phone, c.source.slice(0, 40), page, copy.version, text, ipHash, ua, now)),
    db.prepare(`UPDATE leads SET ${[
      ...(out.call ? ['call_consent_at = ?', 'call_consent_text = ?'] : []),
      ...(out.texts ? ['sms_consent_at = ?', 'wa_consent_at = ?'] : []),
      'updated_at = ?',
    ].join(', ')} WHERE id = ?`).bind(...(out.call ? [now, copy.version] : []), ...(out.texts ? [now, now] : []), now, leadId),
  ]);
  return out;
}

/**
 * A form's two boxes, end to end: adds the typed number to a lead that has none (a number is never swapped on a
 * lead from a public form: anyone can type anyone's email), then records what was ticked for that number.
 */
export async function captureConsent(rt: Pick<Runtime, 'env'>, leadId: string, body: Record<string, unknown>, o: { phone: string | null; source: string; page: string; ip?: string | null; userAgent?: string | null }, now = Date.now()) {
  const call = tickedCall(body), texts = tickedTexts(body);
  if (!o.phone || (!call && !texts)) return { call: false, texts: false };
  const lead = await rt.env.DB.prepare('SELECT id, phone FROM leads WHERE id = ?').bind(leadId).first<{ id: string; phone: string | null }>();
  if (!lead) return { call: false, texts: false };
  if (!lead.phone) {
    const { updateLead } = await import('../funnel/leads');
    await updateLead(rt.env, leadId, { phone: o.phone });
  }
  return recordConsent(rt, leadId, { phone: o.phone, call, texts, source: o.source, page: consentPage(body, o.page), ip: o.ip, userAgent: o.userAgent }, now);
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
/** The two separate, unticked boxes (calls, texts) for a server-rendered form, in that form's own label class. */
export function consentBoxes(labelClass: string, o: { checked?: { call?: boolean; texts?: boolean }; space?: string } = {}) {
  const sp = o.space ?? ' ';
  return `<label class="${escHtml(labelClass)} consent-box"><input type="checkbox" name="call_consent"${o.checked?.call ? ' checked' : ''}>${sp}<span>${escHtml(CONSENT_COPY.call)}</span></label>
<label class="${escHtml(labelClass)} consent-box"><input type="checkbox" name="sms_consent"${o.checked?.texts ? ' checked' : ''}>${sp}<span>${escHtml(CONSENT_COPY.sms)}</span></label>`;
}

/** A withdrawal (unticked on the application, STOP, "don't call me"): proof that it happened, for the number it applied to. */
export async function recordWithdrawal(rt: Pick<Runtime, 'env'>, leadId: string, channels: ContactChannel[], source: string, phone: string | null, now = Date.now()) {
  if (!channels.length) return;
  const db = rt.env.DB;
  await db.batch(channels.map((ch) => db.prepare(`INSERT INTO consent_events (id, lead_id, channel, action, phone, source, created_at) VALUES (?, ?, ?, 'revoked', ?, ?, ?)`)
    .bind(newId('ce'), leadId, ch, phone, source.slice(0, 40), now))).catch((e: unknown) => console.error('consent withdrawal', String(e).slice(0, 200)));
}

/**
 * The statements that make a number change void the old consent: run BEFORE the UPDATE that sets the new number.
 * Each one does nothing unless the lead had a different number. Used by updateLead, so no path can change a
 * number and keep consent given for the old one.
 */
export function phoneChangeStatements(env: Env, leadId: string, newPhone: string | null, now = Date.now()) {
  const db = env.DB;
  const changed = 'FROM leads WHERE id = ? AND phone IS NOT NULL AND phone IS NOT ?';
  return [
    ...(['call', 'sms', 'whatsapp'] as const).map((ch) => db.prepare(`INSERT INTO consent_events (id, lead_id, channel, action, phone, source, created_at)
      SELECT ?, id, ?, 'revoked', phone, 'phone-changed', ? ${changed}`).bind(newId('ce'), ch, now, leadId, newPhone)),
    db.prepare(`UPDATE leads SET call_consent_at = NULL, call_consent_text = NULL, sms_consent_at = NULL, wa_consent_at = NULL WHERE id = ? AND phone IS NOT NULL AND phone IS NOT ?`).bind(leadId, newPhone),
  ];
}

// ───────────────────────────── Funnel HQ ─────────────────────────────

/** The lead drawer: consent per channel with its proof, and any opt-outs. */
export async function consentSummary(env: Env, lead: Lead) {
  const rows = await env.DB.prepare('SELECT channel, action, phone, source, page_url, text_version, text, ip_hash, user_agent, created_at FROM consent_events WHERE lead_id = ? ORDER BY created_at, rowid')
    .bind(lead.id).all<ConsentRow & { text: string | null; ip_hash: string | null; user_agent: string | null }>().then((r) => r.results ?? []).catch(() => []);
  const channels = (['call', 'sms', 'whatsapp'] as const).map((channel) => {
    const mine = rows.filter((r) => r.channel === channel);
    const last = mine[mine.length - 1] ?? null;
    const block = consentBlock(lead, channel, rows);
    const legacyAt = channel === 'call' ? lead.call_consent_at : channel === 'sms' ? lead.sms_consent_at ?? (legacyCallCoversTexts(lead.call_consent_text) ? lead.call_consent_at : null) : lead.wa_consent_at;
    return {
      channel,
      allowed: !block,
      reason: block,
      proof: last ? { action: last.action, at: last.created_at, phone: last.phone, source: last.source, page: last.page_url, version: last.text_version, text: (last as { text?: string | null }).text ?? null, ip_hash: (last as { ip_hash?: string | null }).ip_hash ?? null, user_agent: (last as { user_agent?: string | null }).user_agent ?? null }
        : legacyAt ? { action: 'granted', at: legacyAt, phone: null, source: 'legacy (before consent proof was recorded)', page: null, version: channel === 'call' || !lead.sms_consent_at ? lead.call_consent_text : null, text: null, ip_hash: null, user_agent: null } : null,
    };
  });
  const recent = await env.DB.prepare("SELECT channel, purpose, reason, created_at FROM contact_gate_log WHERE lead_id = ? AND outcome = 'blocked' ORDER BY created_at DESC LIMIT 10")
    .bind(lead.id).all<{ channel: string; purpose: string; reason: string; created_at: number }>().then((r) => r.results ?? []).catch(() => []);
  return {
    channels,
    history: rows.map((r) => ({ channel: r.channel, action: r.action, at: r.created_at, phone: r.phone, source: r.source, version: r.text_version })),
    opt_outs: { sms_stop_at: lead.sms_opt_out_at, do_not_call_at: lead.do_not_call_at, email_unsubscribed_at: lead.unsubscribed_at },
    blocked: recent,
  };
}

/** Settings → Errors & jobs: blocked attempts by reason (7 days), and the owner's test sends. */
export async function gateReport(env: Env, now = Date.now()) {
  const since = now - 7 * 86_400_000;
  const [by, tests, proof] = await Promise.all([
    env.DB.prepare("SELECT channel, reason, COUNT(*) AS n, COUNT(DISTINCT lead_id) AS people, MAX(created_at) AS last FROM contact_gate_log WHERE outcome = 'blocked' AND created_at > ? GROUP BY channel, reason ORDER BY n DESC LIMIT 50")
      .bind(since).all<{ channel: string; reason: string; n: number; people: number; last: number }>(),
    env.DB.prepare("SELECT channel, purpose, phone, created_at FROM contact_gate_log WHERE outcome = 'test' AND created_at > ? ORDER BY created_at DESC LIMIT 20").bind(since).all<{ channel: string; purpose: string; phone: string; created_at: number }>(),
    env.DB.prepare('SELECT channel, COUNT(DISTINCT lead_id) AS n FROM consent_events WHERE action = \'granted\' AND created_at > ? GROUP BY channel').bind(since).all<{ channel: string; n: number }>(),
  ]);
  return { since, blocked: by.results ?? [], tests: tests.results ?? [], granted: proof.results ?? [] };
}
