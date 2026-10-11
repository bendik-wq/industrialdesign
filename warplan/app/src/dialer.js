// Power dialer. One line, one person, always a human on the call: no parallel or predictive dialing (those drop
// calls on whoever answers), no AI voices, no prerecorded voicemail drops. Built around what the best 1:1 dialers
// do well:
//   Queue      every target with a number; due callbacks first, then owners it's OK to ring right now (their
//              local time), best prospects first. Teammates never get the same owner (10-minute locks).
//   Guard      every dial, from the browser, the Twilio bridge or your own phone, is checked server-side:
//              calling hours in the owner's time zone, at most 3 attempts per number per 24 hours, the STOP / do-not-
//              call list. The same rules for every user, on every path.
//   Caller ID  local presence (same area code, then same country), spread across your numbers by how much each
//              was used today, so no single number burns out and gets labelled spam.
//   Outcomes   one key each; they set the next action and date, schedule timed callbacks, rest owners who never
//              pick up, add opt-outs to the do-not-call list, and can queue a follow-up text or email for approval.
//   Stats      dials, conversations, meetings, talk time, best hours to call (owner's local time), number health.
import { getTarget, updateTarget } from "./pipeline.js";
import { providerKeys } from "./keys.js";
import { STAGES } from "../public/js/deal.js";
import { pickCallerId, callerNumbers, countryCode } from "./numbers.js";
import { zonesFor, callWindow, localHour } from "../public/js/calltime.js";
import { propose } from "./approvals.js";

const err = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });
const now = () => new Date().toISOString();
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const ymd = (days) => { const d = new Date(Date.now() + days * 864e5); if (days > 0) { while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1); } return d.toISOString().slice(0, 10); };
const idx = (id) => STAGES.findIndex((s) => s.id === id);

export const MAX_ATTEMPTS_24H = 3;          // per number, rolling 24 hours (the strictest state rules)
export const RETRY_GAP_MIN = 90;            // don't redial a number within 90 minutes unless it's a callback or a double dial
const REST_AFTER = 6, REST_DAYS = 30;       // 6 unanswered attempts in 21 days: give them a month off
const NUMBER_DAILY_CAP = 100;               // dials per caller ID per day before we prefer another number
const LOCK_MIN = 10;

// What each outcome does to the target. stage = move forward to at least this stage.
export const DISPOSITIONS = {
  no_answer: { label: "No answer", key: "1", next: "Call again", days: 1 },
  voicemail: { label: "Left voicemail", key: "2", next: "Call again (left a voicemail)", days: 2 },
  gatekeeper: { label: "Gatekeeper", key: "3", next: "Call back and ask for the owner", days: 1, answered: true },
  callback: { label: "Call back later", key: "4", next: "Callback", days: 1, answered: true },
  connected: { label: "Spoke, no next step", key: "5", next: "Follow up", days: 7, stage: "contacted", answered: true },
  interested: { label: "Interested", key: "6", next: "Book the first proper call", days: 1, stage: "first_call", priority: 1, answered: true },
  meeting: { label: "Meeting booked", key: "7", next: "Meeting", days: 3, stage: "meeting", priority: 1, answered: true },
  not_interested: { label: "Not interested", key: "8", next: "Check back in 6 months", days: 180, priority: 3, stage: "contacted", answered: true },
  wrong_number: { label: "Wrong number", key: "9", next: "Find a working number", days: 0, answered: true },
  dnc: { label: "Do not call", key: "0", next: "Opted out of calls", days: 0, answered: true },
};
export const CONVERSATION = new Set(["connected", "interested", "meeting", "not_interested", "callback"]);
// The deal currency is a weak hint for where a number lives; the address is better ("03 5278 1121" in Geelong).
export const curFor = (t) => { const l = String(t?.location || ""); return /australia/i.test(l) ? "A$" : /united kingdom|\buk\b|england|scotland|wales/i.test(l) ? "£" : /canada/i.test(l) ? "C$" : t?.currency || "$"; };
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^00/, "");

// ------------------------------------------------------------------ settings
const DEFAULT_SETTINGS = { sundays: false, record: false, record_notice: "Hi, just so you know, this call is recorded.", followup_text: "Hi {first}, it's {me}. I just tried you by phone. I'm a local business owner and had a quick question about {company}. When's a good time to talk?" };
export async function dialerSettings(env, accountId) {
  const r = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'dialer'").bind(accountId).first();
  return { ...DEFAULT_SETTINGS, ...(r ? JSON.parse(r.data) : {}) };
}
export async function saveDialerSettings(env, ctx, b) {
  const cur = await dialerSettings(env, ctx.accountId);
  const next = {
    sundays: b.sundays != null ? !!b.sundays : cur.sundays, followup_text: b.followup_text != null ? String(b.followup_text).slice(0, 600) : cur.followup_text,
    record: b.record != null ? !!b.record : !!cur.record,
    record_notice: b.record_notice != null ? (String(b.record_notice).trim().slice(0, 200) || cur.record_notice) : cur.record_notice,
  };
  // A recorded call always tells the other side: an empty notice isn't allowed.
  if (next.record && !/record/i.test(next.record_notice || "")) throw err(400, "The notice has to say the call is recorded");
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'dialer', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(ctx.accountId, JSON.stringify(next), now()).run();
  return next;
}

// ------------------------------------------------------------------ the guard (every dial goes through it)
// Throws 409 with a plain reason when a call isn't allowed. `info` is the owner's time-zone info.
export async function dialGuard(env, accountId, { to, location, currency, retry = false, sundays }) {
  const settings = sundays == null ? await dialerSettings(env, accountId) : { sundays };
  const info = zonesFor({ phone: to, location, currency });
  const win = callWindow(info, new Date(), { sundays: settings.sundays });
  if (!win.callable) throw err(409, `Not now: ${win.reason}${win.opens_at ? `. Next window ${new Date(win.opens_at).toUTCString().slice(0, 22)} UTC` : ""}`, { code: "hours", window: win });
  const [dnc, recent] = await env.DB.batch([
    env.DB.prepare("SELECT reason FROM suppressions WHERE account_id = ?1 AND email = ?2").bind(accountId, `tel:${to}`),
    env.DB.prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM dial_attempts WHERE account_id = ?1 AND e164 = ?2 AND created_at >= ?3").bind(accountId, to, ago(864e5)),
  ]);
  if (dnc.results[0]) throw err(409, `${to} is on your do-not-call list (${dnc.results[0].reason})`, { code: "dnc" });
  const { n, last } = recent.results[0];
  if (n >= MAX_ATTEMPTS_24H) throw err(409, `Already dialed ${to} ${n} times in 24 hours: try again tomorrow`, { code: "cap" });
  if (!retry && last && Date.now() - Date.parse(last) < RETRY_GAP_MIN * 60e3 && Date.now() - Date.parse(last) > 120e3) throw err(409, `Dialed ${to} ${Math.round((Date.now() - Date.parse(last)) / 60e3)} minutes ago: space attempts out (or schedule a callback)`, { code: "gap" });
  return { info, window: win, attempts24h: n };
}

// Today's dials per caller ID, for spreading load across numbers.
export async function loadsToday(env, accountId) {
  const { results } = await env.DB.prepare("SELECT caller_id, COUNT(*) AS n FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 AND caller_id IS NOT NULL GROUP BY caller_id").bind(accountId, now().slice(0, 10)).all();
  return Object.fromEntries(results.map((r) => [r.caller_id, r.n]));
}
// Local presence first (same area code, then same country), then the least-used number of those today.
export function balancedCallerId(numbers, to, fallback, loads = {}) {
  const list = [...new Set((numbers || []).filter((n) => /^\+\d{8,15}$/.test(n)))];
  if (!list.length) return fallback || null;
  const best = pickCallerId(list, to, fallback);
  const cc = countryCode(to);
  const tier = (n) => (cc === "1" && n.slice(0, 5) === String(to).slice(0, 5) ? 0 : cc && countryCode(n) === cc ? 1 : 2);
  const t = tier(best);
  const peers = list.filter((n) => tier(n) === t);
  const fresh = peers.filter((n) => (loads[n] || 0) < NUMBER_DAILY_CAP);
  return (fresh.length ? fresh : peers).sort((a, b) => (loads[a] || 0) - (loads[b] || 0))[0] || best;
}

export async function recordAttempt(env, { accountId, userId, targetId, to, callerId, via, info, sessionId }) {
  const lh = localHour(info);
  if (!sessionId && userId) sessionId = (await env.DB.prepare("SELECT id FROM dial_sessions WHERE account_id = ?1 AND user_id = ?2 AND ended_at IS NULL AND last_seen >= ?3 ORDER BY id DESC LIMIT 1").bind(accountId, userId, ago(30 * 60e3)).first())?.id || null;
  const r = await env.DB.prepare("INSERT INTO dial_attempts (account_id, user_id, target_id, e164, caller_id, via, session_id, local_hour, local_dow, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id")
    .bind(accountId, userId || null, targetId || null, to, callerId || null, via, sessionId || null, lh?.hour ?? null, lh?.dow ?? null, now()).first();
  return r.id;
}

// Your own phone: checked and counted before the tel: link opens. (The browser phone and the bridge check on the
// server when Twilio asks.)
export async function preDial(env, ctx, b) {
  const t = b.target_id ? await getTarget(env, ctx, +b.target_id) : null;
  const to = e164(b.phone || t?.phone, curFor(t));
  if (!to) {
    // No country code: we can't check their clock, but the dial still counts.
    const raw = digits(b.phone || t?.phone);
    if (!raw) throw err(400, "No number to call");
    if (b.check_only) return { ok: true, e164: null, window: { known: false, callable: true }, warning: "Add the country code (+1, +44…) so Warplan can check their local time" };
    const id = await recordAttempt(env, { accountId: ctx.accountId, userId: ctx.user.id, targetId: t?.id, to: raw, via: b.via === "browser" ? "browser" : "phone", info: zonesFor({ location: t?.location, currency: t?.currency }), sessionId: +b.session_id || null });
    return { ok: true, attempt_id: id, e164: null, warning: "Add the country code so Warplan can check their local time" };
  }
  const g = await dialGuard(env, ctx.accountId, { to, location: t?.location, currency: t?.currency, retry: !!b.retry });
  if (b.check_only) return { ok: true, e164: to, window: g.window, attempts24h: g.attempts24h };
  const id = await recordAttempt(env, { accountId: ctx.accountId, userId: ctx.user.id, targetId: t?.id, to, via: b.via === "browser" ? "browser" : "phone", info: g.info, sessionId: +b.session_id || null });
  return { ok: true, attempt_id: id, e164: to, window: g.window, attempts24h: g.attempts24h + 1 };
}

// ------------------------------------------------------------------ queue
export async function queue(env, ctx, q) {
  const stage = q.get("stage"), term = q.get("q") ? `%${q.get("q")}%` : null, fresh = q.get("fresh") === "1", callableOnly = q.get("callable") === "1";
  const minScore = +q.get("score") || 0, list = q.get("list") || "";
  const stamp = now(), today = stamp.slice(0, 10);
  const [rows, cbs, locks, dnc, tries, settings] = await Promise.all([
    env.DB.prepare(`
      SELECT t.id, t.name, t.industry, t.location, t.owner_name, t.owner_age, t.stage, t.priority, t.next_action, t.next_date, t.phone, t.website, t.currency, t.motivation, t.email,
        (SELECT COUNT(*) FROM calls c WHERE c.target_id = t.id) AS calls,
        (SELECT MAX(created_at) FROM calls c WHERE c.target_id = t.id) AS last_call,
        (SELECT disposition FROM calls c WHERE c.target_id = t.id ORDER BY id DESC LIMIT 1) AS last_disposition,
        (SELECT score FROM target_intel i WHERE i.target_id = t.id) AS score,
        (SELECT group_concat(value || '|' || label, '¦') FROM (SELECT value, label FROM contacts c WHERE c.target_id = t.id AND c.kind = 'phone' ORDER BY CASE WHEN label LIKE '%owner%' OR label LIKE '%mobile%' THEN 0 ELSE 1 END, id)) AS phones
      FROM targets t
      WHERE t.account_id = ?1 AND t.stage NOT IN ('closed', 'lost') AND (?2 IS NULL OR t.stage = ?2)
        AND (?3 IS NULL OR t.name LIKE ?3 OR t.industry LIKE ?3 OR t.location LIKE ?3 OR t.tags LIKE ?3)
        AND (t.phone != '' OR EXISTS (SELECT 1 FROM contacts c WHERE c.target_id = t.id AND c.kind = 'phone'))
        AND (?4 = 0 OR NOT EXISTS (SELECT 1 FROM calls c WHERE c.target_id = t.id AND c.created_at >= ?5))
        AND (t.next_action NOT LIKE 'Opted out%')
        AND (?6 = 0 OR COALESCE((SELECT score FROM target_intel i WHERE i.target_id = t.id), 0) >= ?6)
        AND (?7 != 'new' OR NOT EXISTS (SELECT 1 FROM calls c WHERE c.target_id = t.id))
      ORDER BY t.priority, CASE WHEN last_call IS NULL THEN 0 ELSE 1 END, last_call
      LIMIT 400`).bind(ctx.accountId, stage || null, term, fresh ? 1 : 0, today, minScore, list).all(),
    env.DB.prepare("SELECT target_id, id, due_at, note FROM callbacks WHERE account_id = ?1 AND done_at IS NULL ORDER BY due_at").bind(ctx.accountId).all(),
    env.DB.prepare("SELECT l.target_id, l.user_id, u.name FROM dialer_locks l LEFT JOIN users u ON u.id = l.user_id WHERE l.account_id = ?1 AND l.until > ?2 AND l.user_id != ?3").bind(ctx.accountId, stamp, ctx.user.id || 0).all(),
    env.DB.prepare("SELECT email FROM suppressions WHERE account_id = ?1 AND email LIKE 'tel:%'").bind(ctx.accountId).all(),
    env.DB.prepare("SELECT e164, COUNT(*) AS n, MAX(created_at) AS last FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 GROUP BY e164").bind(ctx.accountId, ago(864e5)).all(),
    dialerSettings(env, ctx.accountId),
  ]);
  const cbBy = new Map(cbs.results.map((c) => [c.target_id, c]));
  const lockBy = new Map(locks.results.map((l) => [l.target_id, l]));
  const blocked = new Set(dnc.results.map((r) => r.email.slice(4)));
  const triesBy = new Map(tries.results.map((r) => [r.e164, r]));
  const at = new Date();
  let out = rows.results.filter((r) => !lockBy.has(r.id)).map((r) => {
    const phones = [];
    if (r.phone) phones.push({ value: r.phone, label: "Main" });
    for (const p of (r.phones || "").split("¦").filter(Boolean)) { const [value, label] = p.split("|"); const n = e164(value, curFor(r)); if (!phones.some((x) => digits(x.value) === digits(value) || (n && e164(x.value, curFor(r)) === n))) phones.push({ value, label: label || "" }); }
    for (const p of phones) {
      p.e164 = e164(p.value, curFor(r));
      const tr = p.e164 && triesBy.get(p.e164);
      p.tries24h = tr?.n || 0; p.last_try = tr?.last || null;
      p.blocked = p.e164 ? blocked.has(p.e164) : false;
      p.capped = p.tries24h >= MAX_ATTEMPTS_24H;
    }
    const usable = phones.filter((p) => !p.blocked && !p.capped);
    const info = zonesFor({ phone: usable[0]?.e164 || phones[0]?.e164, location: r.location, currency: r.currency });
    const win = callWindow(info, at, { sundays: settings.sundays });
    const cb = cbBy.get(r.id);
    const { phones: _p, phone: _ph, ...rest } = r;
    return { ...rest, phones, window: win, callback: cb || null, callback_due: !!(cb && cb.due_at <= ago(-10 * 60e3)), dialable: usable.length > 0 && win.callable };
  });
  if (list === "callbacks") out = out.filter((t) => t.callback);
  if (callableOnly) out = out.filter((t) => t.dialable || t.callback_due);
  // Due callbacks, then whoever can be called right now, then the rest; best prospects first within each.
  const rank = (t) => (t.callback_due ? 0 : t.dialable ? 1 : 2);
  const due = (t) => (t.next_date && t.next_date <= today ? 0 : 1);
  out.sort((a, b) => rank(a) - rank(b) || (a.callback_due && b.callback_due ? a.callback.due_at.localeCompare(b.callback.due_at) : 0) || due(a) - due(b) || (a.priority || 2) - (b.priority || 2) || (b.score || 0) - (a.score || 0) || (a.last_call ? 1 : 0) - (b.last_call ? 1 : 0) || String(a.last_call || "").localeCompare(String(b.last_call || "")));
  const twilio = !!(await providerKeys(env, ctx, ["twilio"])).twilio;
  return { twilio, dispositions: DISPOSITIONS, settings, rules: { max_attempts_24h: MAX_ATTEMPTS_24H, retry_gap_min: RETRY_GAP_MIN }, locked_by_others: locks.results.length, queue: out.slice(0, 300) };
}

// A teammate opening an owner in the dialer holds them for 10 minutes so nobody else rings them at the same time.
export async function claim(env, ctx, targetId) {
  const stamp = now(), until = new Date(Date.now() + LOCK_MIN * 60e3).toISOString();
  const r = await env.DB.prepare(`INSERT INTO dialer_locks (account_id, target_id, user_id, until) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (account_id, target_id) DO UPDATE SET user_id = ?3, until = ?4 WHERE dialer_locks.user_id = ?3 OR dialer_locks.until <= ?5 RETURNING user_id`).bind(ctx.accountId, +targetId, ctx.user.id || 0, until, stamp).first();
  if (r) return { ok: true, until };
  const who = await env.DB.prepare("SELECT u.name FROM dialer_locks l LEFT JOIN users u ON u.id = l.user_id WHERE l.account_id = ?1 AND l.target_id = ?2").bind(ctx.accountId, +targetId).first();
  throw err(409, `${who?.name || "A teammate"} is calling this owner right now`, { code: "locked" });
}
async function release(env, ctx, targetId) {
  await env.DB.prepare("DELETE FROM dialer_locks WHERE account_id = ?1 AND target_id = ?2 AND user_id = ?3").bind(ctx.accountId, targetId, ctx.user.id || 0).run();
}

// Everything worth knowing in the 10 seconds before the call.
export async function brief(env, ctx, id) {
  const t = await getTarget(env, ctx, id);
  const [intel, events, calls, cb, info] = await env.DB.batch([
    env.DB.prepare("SELECT score, data, updated_at FROM target_intel WHERE target_id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId),
    env.DB.prepare("SELECT kind, body, user_name, created_at FROM target_events WHERE account_id = ?1 AND target_id = ?2 ORDER BY id DESC LIMIT 6").bind(ctx.accountId, t.id),
    env.DB.prepare("SELECT c.disposition, c.notes, c.duration, c.created_at, u.name AS user_name FROM calls c LEFT JOIN users u ON u.id = c.user_id WHERE c.account_id = ?1 AND c.target_id = ?2 ORDER BY c.id DESC LIMIT 5").bind(ctx.accountId, t.id),
    env.DB.prepare("SELECT id, due_at, note FROM callbacks WHERE account_id = ?1 AND target_id = ?2 AND done_at IS NULL ORDER BY due_at LIMIT 1").bind(ctx.accountId, t.id),
    env.DB.prepare("SELECT e164, valid, line_type, carrier, checked_at FROM phone_info WHERE account_id = ?1 AND e164 IN (SELECT value FROM json_each(?2))").bind(ctx.accountId, JSON.stringify(await targetNumbers(env, ctx, t))),
  ]);
  const i = intel.results[0] ? { score: intel.results[0].score, ...JSON.parse(intel.results[0].data) } : null;
  return {
    intel: i ? { score: i.score, reason: i.readiness_reason, summary: i.summary, hooks: (i.conversation_hooks || []).slice(0, 4), signals: [...(i.owner_signals || []), ...(i.succession_signals || [])].slice(0, 4), ownership: i.ownership, years: i.years_in_business, employees: i.employees_estimate, google: i.google } : null,
    events: events.results, calls: calls.results, callback: cb.results[0] || null,
    lines: Object.fromEntries(info.results.map((r) => [r.e164, r])),
  };
}
async function targetNumbers(env, ctx, t) {
  const { results } = await env.DB.prepare("SELECT value FROM contacts WHERE account_id = ?1 AND target_id = ?2 AND kind = 'phone'").bind(ctx.accountId, t.id).all();
  return [...new Set([t.phone, ...results.map((r) => r.value)].map((v) => e164(v, curFor(t))).filter(Boolean))];
}

// Mobile or landline? Twilio Lookup (about $0.008 a number), cached 90 days. Owners' mobiles go first; dead
// numbers are flagged before anyone wastes a dial on them.
export async function checkLines(env, ctx, targetId) {
  const t = await getTarget(env, ctx, targetId);
  const tw = await twilio(env, ctx);
  const nums = (await targetNumbers(env, ctx, t)).slice(0, 5);
  const { results: cached } = await env.DB.prepare("SELECT e164 FROM phone_info WHERE account_id = ?1 AND checked_at >= ?2 AND e164 IN (SELECT value FROM json_each(?3))").bind(ctx.accountId, ago(90 * 864e5), JSON.stringify(nums)).all();
  const have = new Set(cached.map((r) => r.e164));
  for (const n of nums.filter((x) => !have.has(x))) {
    const res = await fetch(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(n)}?Fields=line_type_intelligence`, { headers: { Authorization: tw.auth } });
    const d = await res.json().catch(() => ({}));
    if (res.status === 401) throw err(400, "Twilio rejected the credentials");
    if (!res.ok && res.status !== 404) continue;
    const lti = d.line_type_intelligence || {};
    await env.DB.prepare("INSERT INTO phone_info (account_id, e164, valid, line_type, carrier, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (account_id, e164) DO UPDATE SET valid = ?3, line_type = ?4, carrier = ?5, checked_at = ?6")
      .bind(ctx.accountId, n, d.valid === false || res.status === 404 ? 0 : 1, lti.type || null, String(lti.carrier_name || "").slice(0, 80) || null, now()).run();
  }
  return (await brief(env, ctx, t.id)).lines;
}

// ------------------------------------------------------------------ logging an outcome
export async function logCall(env, ctx, b, hooks) {
  const t = await getTarget(env, ctx, +b.target_id);
  const d = DISPOSITIONS[b.disposition];
  if (!d) throw err(400, "Pick how the call went");
  const phone = String(b.phone || t.phone || "").slice(0, 40), notes = String(b.notes || "").trim().slice(0, 4000);
  const to = e164(phone, curFor(t)) || digits(phone) || null;
  const duration = b.duration != null ? Math.max(0, Math.min(36000, Math.round(+b.duration) || 0)) : null;
  const via = ["twilio", "browser"].includes(b.via) ? b.via : "phone";
  const stamp = now();
  const call = await env.DB.prepare("INSERT INTO calls (account_id, user_id, target_id, phone, via, call_sid, disposition, notes, duration, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) RETURNING id")
    .bind(ctx.accountId, ctx.user.id || null, t.id, phone, via, b.call_sid ? String(b.call_sid).slice(0, 64) : null, b.disposition, notes, duration, stamp).first();
  const answered = d.answered || (b.answered === true && !["no_answer", "voicemail"].includes(b.disposition)) ? 1 : 0;
  // Tie the outcome to the dial it came from (the latest open attempt on this number by this user), or record one.
  if (to) {
    const open = await env.DB.prepare("SELECT id FROM dial_attempts WHERE account_id = ?1 AND e164 = ?2 AND (user_id = ?3 OR user_id IS NULL) AND call_id IS NULL AND created_at >= ?4 ORDER BY id DESC LIMIT 1").bind(ctx.accountId, to, ctx.user.id || null, ago(3 * 3600e3)).first();
    if (open) await env.DB.prepare("UPDATE dial_attempts SET answered = ?2, disposition = ?3, duration = ?4, call_id = ?5, target_id = COALESCE(target_id, ?6) WHERE id = ?1").bind(open.id, answered, b.disposition, duration, call.id, t.id).run();
    else {
      const id = await recordAttempt(env, { accountId: ctx.accountId, userId: ctx.user.id, targetId: t.id, to, via, info: zonesFor({ phone: to, location: t.location, currency: t.currency }), sessionId: +b.session_id || null });
      await env.DB.prepare("UPDATE dial_attempts SET answered = ?2, disposition = ?3, duration = ?4, call_id = ?5 WHERE id = ?1").bind(id, answered, b.disposition, duration, call.id).run();
    }
  }
  const mins = duration ? ` · ${Math.floor(duration / 60)}m${String(duration % 60).padStart(2, "0")}s` : "";
  await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'call', ?5, ?6)")
    .bind(ctx.accountId, t.id, ctx.user.id || null, ctx.user.name || ctx.user.email, `${d.label}${mins} (${phone})${notes ? `: ${notes}` : ""}`, stamp).run();

  // Any call settles the owner's open callbacks; a new "call back" sets a timed one.
  await env.DB.prepare("UPDATE callbacks SET done_at = ?3 WHERE account_id = ?1 AND target_id = ?2 AND done_at IS NULL").bind(ctx.accountId, t.id, stamp).run();
  const fields = {};
  let date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.next_date || "")) ? b.next_date : ymd(d.days);
  fields.next_action = b.disposition === "callback" && notes ? `Callback: ${notes.slice(0, 120)}` : d.next;
  let callbackAt = null;
  if (b.disposition === "callback" || b.callback_at) {
    const when = Date.parse(b.callback_at || "");
    if (Number.isFinite(when) && when > Date.now() - 60e3 && when < Date.now() + 366 * 864e5) {
      callbackAt = new Date(when).toISOString();
      await env.DB.prepare("INSERT INTO callbacks (account_id, target_id, user_id, due_at, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(ctx.accountId, t.id, ctx.user.id || null, callbackAt, notes.slice(0, 300), stamp).run();
      date = callbackAt.slice(0, 10);
      const zone = zonesFor({ phone: to, location: t.location, currency: t.currency })?.zones?.[0];
      const label = new Intl.DateTimeFormat("en-US", { timeZone: zone || "UTC", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(callbackAt));
      fields.next_action = `Callback ${label} ${zone ? "their time" : "UTC"}${notes ? `: ${notes.slice(0, 100)}` : ""}`;
    }
  }
  fields.next_date = d.days || b.next_date || callbackAt ? date : ymd(0);
  // Owners who never pick up get a rest instead of a daily dial.
  if (["no_answer", "voicemail"].includes(b.disposition)) {
    const s = await env.DB.prepare("SELECT SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS spoke, SUM(CASE WHEN answered = 0 THEN 1 ELSE 0 END) AS missed FROM dial_attempts WHERE account_id = ?1 AND target_id = ?2 AND created_at >= ?3").bind(ctx.accountId, t.id, ago(21 * 864e5)).first();
    if (!s.spoke && s.missed >= REST_AFTER) { fields.next_action = `Rest: ${s.missed} tries without an answer. Try a letter or email first`; fields.next_date = ymd(REST_DAYS); }
  }
  if (d.stage && idx(t.stage) < idx(d.stage)) fields.stage = d.stage;
  if (d.priority) fields.priority = d.priority;
  if (b.disposition === "wrong_number" && phone) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM contacts WHERE account_id = ?1 AND target_id = ?2 AND kind = 'phone' AND value = ?3").bind(ctx.accountId, t.id, phone),
      env.DB.prepare("UPDATE targets SET phone = '' WHERE id = ?1 AND account_id = ?2 AND phone = ?3").bind(t.id, ctx.accountId, phone),
    ]);
  }
  if (b.disposition === "dnc" && to?.startsWith("+")) {
    await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, 'Asked not to be called', ?3)").bind(ctx.accountId, `tel:${to}`, stamp).run();
  }
  const updated = await updateTarget(env, ctx, t.id, fields, hooks);
  await release(env, ctx, t.id);

  // Optional follow-ups after a voicemail or a missed call: drafted now, sent only after someone approves in the Inbox.
  const queued = [];
  if (b.follow_text && to?.startsWith("+") && !["dnc", "wrong_number", "not_interested"].includes(b.disposition)) {
    const body = String(b.follow_text).trim().slice(0, 600);
    if (body) queued.push(await propose(env, ctx.accountId, { tool: "send_sms", input: { to, body, target_id: t.id }, target_id: t.id, title: `Text ${t.owner_name || t.name} after the call`, reason: body, source: "dialer" }));
  }
  if (b.follow_email && t.email && !["dnc", "wrong_number", "not_interested"].includes(b.disposition)) {
    const fe = b.follow_email;
    const subject = String(fe.subject || "").trim().slice(0, 200), text = String(fe.body || "").trim().slice(0, 4000);
    if (subject && text) queued.push(await propose(env, ctx.accountId, { tool: "send_email", input: { to: t.email, subject, body: text, target_id: t.id }, target_id: t.id, title: `Email ${t.owner_name || t.name} after the call`, reason: text.slice(0, 400), source: "dialer" }));
  }
  hooks.emit("call.logged", { target_id: t.id, target: t.name, disposition: b.disposition, notes, duration });
  return {
    id: call.id, callback_at: callbackAt, queued: queued.length,
    target: { id: updated.id, stage: updated.stage, next_action: updated.next_action, next_date: updated.next_date },
    receipt: `Logged “${d.label}” for ${t.name}; next: ${fields.next_action} (${fields.next_date})${queued.length ? ` · ${queued.length} follow-up${queued.length > 1 ? "s" : ""} waiting in the Inbox` : ""}`,
  };
}

export async function callHistory(env, ctx, q) {
  const { results } = await env.DB.prepare(`SELECT c.id, c.target_id, t.name AS target_name, c.phone, c.via, c.disposition, c.notes, c.duration, c.created_at, u.name AS user_name
    FROM calls c JOIN targets t ON t.id = c.target_id LEFT JOIN users u ON u.id = c.user_id WHERE c.account_id = ?1 AND (?2 IS NULL OR c.target_id = ?2) ORDER BY c.id DESC LIMIT 100`).bind(ctx.accountId, q.get("target") ? +q.get("target") : null).all();
  const today = now().slice(0, 10);
  const mine = results.filter((r) => r.created_at >= today);
  return { calls: results, today: { dials: mine.length, connects: mine.filter((r) => CONVERSATION.has(r.disposition)).length, meetings: mine.filter((r) => r.disposition === "meeting").length } };
}

// ------------------------------------------------------------------ sessions and stats
export async function startSession(env, ctx) {
  const stamp = now();
  await env.DB.prepare("UPDATE dial_sessions SET ended_at = last_seen WHERE account_id = ?1 AND user_id = ?2 AND ended_at IS NULL").bind(ctx.accountId, ctx.user.id || null).run();
  const r = await env.DB.prepare("INSERT INTO dial_sessions (account_id, user_id, started_at, last_seen) VALUES (?1, ?2, ?3, ?3) RETURNING id").bind(ctx.accountId, ctx.user.id || null, stamp).first();
  return { id: r.id, started_at: stamp };
}
export async function endSession(env, ctx, id) {
  await env.DB.prepare("UPDATE dial_sessions SET ended_at = ?4, last_seen = ?4 WHERE id = ?1 AND account_id = ?2 AND user_id = ?3").bind(+id, ctx.accountId, ctx.user.id || null, now()).run();
  return sessionStats(env, ctx, id);
}
// Live numbers for the session bar (and a heartbeat so the team view knows who's dialing).
export async function sessionStats(env, ctx, id) {
  const s = await env.DB.prepare("SELECT id, started_at, ended_at FROM dial_sessions WHERE id = ?1 AND account_id = ?2 AND user_id = ?3").bind(+id, ctx.accountId, ctx.user.id || null).first();
  if (!s) throw err(404, "No such session");
  if (!s.ended_at) await env.DB.prepare("UPDATE dial_sessions SET last_seen = ?2 WHERE id = ?1").bind(s.id, now()).run();
  const a = await env.DB.prepare(`SELECT COUNT(*) AS dials, SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered,
      SUM(CASE WHEN disposition IN ('connected','interested','meeting','not_interested','callback') THEN 1 ELSE 0 END) AS conversations,
      SUM(CASE WHEN disposition = 'meeting' THEN 1 ELSE 0 END) AS meetings, SUM(CASE WHEN disposition = 'interested' THEN 1 ELSE 0 END) AS interested,
      SUM(CASE WHEN answered = 1 THEN COALESCE(duration, 0) ELSE 0 END) AS talk, MIN(created_at) AS first, MAX(created_at) AS last
    FROM dial_attempts WHERE account_id = ?1 AND user_id = ?2 AND created_at >= ?3 AND (?4 IS NULL OR created_at <= ?4)`).bind(ctx.accountId, ctx.user.id || null, s.started_at, s.ended_at).first();
  const hours = Math.max((Date.parse(s.ended_at || now()) - Date.parse(s.started_at)) / 3600e3, 1 / 60);
  return { id: s.id, started_at: s.started_at, ended_at: s.ended_at, ...shape(a), per_hour: Math.round((a.dials || 0) / hours) };
}
const shape = (a) => ({ dials: a.dials || 0, answered: a.answered || 0, conversations: a.conversations || 0, meetings: a.meetings || 0, interested: a.interested || 0, talk_seconds: a.talk || 0, connect_rate: a.dials ? Math.round((100 * (a.answered || 0)) / a.dials) : 0 });

// Team view: today's and this week's leaderboard, who's dialing right now.
export async function teamStats(env, ctx) {
  const today = now().slice(0, 10), week = ymdBack(6);
  const [rows, live] = await env.DB.batch([
    env.DB.prepare(`SELECT a.user_id, u.name, SUM(CASE WHEN a.created_at >= ?2 THEN 1 ELSE 0 END) AS dials_today, COUNT(*) AS dials_week,
        SUM(CASE WHEN a.created_at >= ?2 AND a.disposition IN ('connected','interested','meeting','not_interested','callback') THEN 1 ELSE 0 END) AS conv_today,
        SUM(CASE WHEN a.disposition IN ('connected','interested','meeting','not_interested','callback') THEN 1 ELSE 0 END) AS conv_week,
        SUM(CASE WHEN a.disposition = 'meeting' THEN 1 ELSE 0 END) AS meetings_week, SUM(CASE WHEN a.answered = 1 THEN COALESCE(a.duration, 0) ELSE 0 END) AS talk_week
      FROM dial_attempts a LEFT JOIN users u ON u.id = a.user_id WHERE a.account_id = ?1 AND a.created_at >= ?3 GROUP BY a.user_id ORDER BY meetings_week DESC, conv_week DESC, dials_week DESC LIMIT 20`).bind(ctx.accountId, today, week),
    env.DB.prepare("SELECT s.user_id, u.name, s.started_at FROM dial_sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.account_id = ?1 AND s.ended_at IS NULL AND s.last_seen >= ?2").bind(ctx.accountId, ago(3 * 60e3)),
  ]);
  return { leaderboard: rows.results, dialing_now: live.results };
}
const ymdBack = (days) => new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);

// When do owners pick up (their local time), which numbers still get answered, where calls end up.
export async function insights(env, ctx) {
  const since = ago(90 * 864e5), week = ago(7 * 864e5);
  const [grid, numbers, dispo, avg] = await env.DB.batch([
    env.DB.prepare("SELECT local_dow AS dow, local_hour AS hour, COUNT(*) AS dials, SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered, SUM(CASE WHEN disposition IN ('connected','interested','meeting','not_interested','callback') THEN 1 ELSE 0 END) AS conversations FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 AND local_hour IS NOT NULL GROUP BY local_dow, local_hour").bind(ctx.accountId, since),
    env.DB.prepare(`SELECT caller_id, SUM(CASE WHEN created_at >= ?3 THEN 1 ELSE 0 END) AS today, COUNT(*) AS dials, SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered, SUM(CASE WHEN answered IS NOT NULL THEN 1 ELSE 0 END) AS logged
      FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 AND caller_id IS NOT NULL GROUP BY caller_id ORDER BY dials DESC LIMIT 50`).bind(ctx.accountId, week, now().slice(0, 10)),
    env.DB.prepare("SELECT disposition, COUNT(*) AS n FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 AND disposition IS NOT NULL GROUP BY disposition").bind(ctx.accountId, ago(30 * 864e5)),
    env.DB.prepare("SELECT COUNT(*) AS logged, SUM(CASE WHEN answered = 1 THEN 1 ELSE 0 END) AS answered FROM dial_attempts WHERE account_id = ?1 AND created_at >= ?2 AND answered IS NOT NULL").bind(ctx.accountId, week),
  ]);
  const base = avg.results[0].logged ? avg.results[0].answered / avg.results[0].logged : null;
  // A number answered at well under half the workspace's rate, on enough dials, is likely being labelled spam.
  const health = numbers.results.map((n) => {
    const rate = n.logged ? n.answered / n.logged : null;
    const risk = rate != null && base && n.logged >= 25 && rate < base * 0.45 ? "high" : rate != null && base && n.logged >= 15 && rate < base * 0.7 ? "watch" : "ok";
    return { caller_id: n.caller_id, today: n.today, dials_7d: n.dials, answer_rate: rate == null ? null : Math.round(rate * 100), risk, over_cap: n.today >= NUMBER_DAILY_CAP };
  });
  const best = grid.results.filter((g) => g.dials >= 5).map((g) => ({ ...g, rate: g.answered / g.dials })).sort((a, b) => b.rate - a.rate).slice(0, 3);
  return { grid: grid.results, best_slots: best, numbers: health, workspace_answer_rate: base == null ? null : Math.round(base * 100), dispositions: dispo.results, daily_cap: NUMBER_DAILY_CAP };
}

// ------------------------------------------------------------------ Twilio bridge
const COUNTRY_BY_CURRENCY = { "$": "1", "C$": "1", "£": "44", "A$": "61" };
export function e164(raw, currency) {
  let s = String(raw || "").trim().replace(/[\s().-]/g, "");
  if (s.startsWith("00")) s = `+${s.slice(2)}`;
  if (/^\+\d{8,15}$/.test(s)) return s;
  const d = s.replace(/\D/g, ""), cc = COUNTRY_BY_CURRENCY[currency];
  if (cc === "1" && d.length === 10) return `+1${d}`;
  if (cc === "1" && d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (cc === "44" && d.length === 11 && d.startsWith("0")) return `+44${d.slice(1)}`;
  if (cc === "61" && d.length === 10 && d.startsWith("0")) return `+61${d.slice(1)}`;
  return null;
}
export const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

export async function twilio(env, ctx) {
  const k = (await providerKeys(env, ctx, ["twilio"])).twilio;
  if (!k?.meta?.sid) throw err(400, "Connect Twilio under Settings → Integrations to dial from Warplan (or use your phone)");
  return { ...k.meta, token: k.key, auth: `Basic ${btoa(`${k.meta.sid}:${k.key}`)}` };
}
export async function twilioReq(tw, path, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}${path}`, { method: form ? "POST" : "GET", headers: { Authorization: tw.auth, ...(form && { "Content-Type": "application/x-www-form-urlencoded" }) }, body: form ? new URLSearchParams(form) : undefined });
  const d = await res.json().catch(() => ({}));
  if (res.status === 401) throw err(400, "Twilio rejected the credentials");
  if (!res.ok) throw err(400, `Twilio: ${d.message || `answered ${res.status}`}`);
  return d;
}

export async function startBridge(env, ctx, b) {
  const t = await getTarget(env, ctx, +b.target_id);
  const tw = await twilio(env, ctx);
  const to = e164(b.phone || t.phone, curFor(t));
  if (!to) throw err(400, "Save the number in +country format (e.g. +4791234567) so Twilio can dial it");
  const g = await dialGuard(env, ctx.accountId, { to, location: t.location, currency: t.currency, retry: !!b.retry });
  const cfg = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'phone'").bind(ctx.accountId).first();
  const callerId = balancedCallerId(callerNumbers(tw, cfg ? JSON.parse(cfg.data) : null), to, tw.from, await loadsToday(env, ctx.accountId));
  // Recording (opt-in) needs the workspace's signed webhook base, set up with the browser phone.
  let rec = null;
  if (cfg) {
    const pc = JSON.parse(cfg.data);
    if (pc.hook_ct && pc.origin) {
      const { open } = await import("./keys.js");
      const { recordingTwiml } = await import("./callnotes.js");
      const token = await open(env, { ciphertext: pc.hook_ct, iv: pc.hook_iv }, `acct:${ctx.accountId}:twilio_phone`).catch(() => null);
      if (token) rec = await recordingTwiml(env, ctx.accountId, `${pc.origin}/hooks/twilio/${token}`, to, ctx.user.id);
    }
  }
  const twiml = `<Response><Say>Connecting you to ${xml(t.name).slice(0, 80)}.</Say><Dial callerId="${xml(callerId)}" timeout="35" answerOnBridge="true"${rec ? rec.dialAttrs : ""}><Number${rec ? ` url="${xml(rec.numberUrl)}"` : ""}>${xml(to)}</Number></Dial></Response>`;
  if (!tw.agentPhone) throw err(400, "“Twilio rings my phone” needs your own number: add it to the Twilio card in Settings → Integrations (or call from the browser instead)");
  if (!callerId) throw err(400, "Your Twilio account has no number to call from yet: get one in the phone (bottom right) → ⚙");
  const call = await twilioReq(tw, "/Calls.json", { To: tw.agentPhone, From: callerId, Twiml: twiml, Timeout: "25" });
  await recordAttempt(env, { accountId: ctx.accountId, userId: ctx.user.id, targetId: t.id, to, callerId, via: "twilio", info: g.info, sessionId: +b.session_id || null });
  return { call_sid: call.sid, status: call.status, dialing: to, caller_id: callerId, ringing: tw.agentPhone.replace(/\d(?=\d{3})/g, "•") };
}
export async function bridgeStatus(env, ctx, sid) {
  if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw err(400, "Bad call id");
  const c = await twilioReq(await twilio(env, ctx), `/Calls/${sid}.json`);
  return { status: c.status, duration: c.duration != null ? +c.duration : null };
}
export async function hangup(env, ctx, sid) {
  if (!/^CA[0-9a-f]{32}$/i.test(sid)) throw err(400, "Bad call id");
  const c = await twilioReq(await twilio(env, ctx), `/Calls/${sid}.json`, { Status: "completed" });
  return { status: c.status };
}
