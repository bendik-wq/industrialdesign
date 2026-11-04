/**
 * "Hide personal details" for guest links (src/admin/guest.ts). One transform over every Funnel HQ response a
 * masked guest receives, so no endpoint has to remember to do it:
 *  - names → first name + last initial ("Dana Q."), by key (first_name / last_name / name …) and, in free text,
 *    wherever a known lead's "First Last" appears;
 *  - emails → d***@example.com, anywhere in any string;
 *  - phones → +61 4•• ••• 678 (phone-ish keys, and any +number in text);
 *  - free text (notes, transcripts, message bodies, answers, call summaries) → "(hidden)" in personal records;
 *  - IP addresses → "(hidden)".
 * Secrets are handled separately (scrubSecrets), for every guest whether or not details are hidden.
 */

export const HIDDEN = '(hidden)';

// ───────────── single values ─────────────

const initial = (s: string) => {
  const ch = [...s.trim()][0];
  return ch ? `${ch.toUpperCase()}.` : '';
};

/** "Dana Quixley" → "Dana Q."; "dana" → "dana"; "Mary Ann van Dyke" → "Mary V." */
export function maskName(full: string) {
  const words = full.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return full.trim();
  if (words[0].includes('@')) return maskEmail(full);
  return `${words[0]} ${initial(words[words.length - 1])}`;
}

/** "dana.quixley@example.com" → "d***@example.com". */
export function maskEmail(email: string) {
  return email.replace(EMAIL_RE, (_m, local: string, domain: string) => `${local[0]}***@${domain}`);
}

/** "+61412345678" → "+61 4•• ••• 678"; "0412 345 678" → "0••• ••• 678". */
export function maskPhone(phone: string) {
  const d = phone.replace(/\D/g, '');
  if (d.length < 6) return phone;
  const last = d.slice(-3);
  return phone.trim().startsWith('+') ? `+${d.slice(0, 2)} ${d[2]}•• ••• ${last}` : `${d[0]}••• ••• ${last}`;
}

/** Instagram / chat handles: "@dana_q" → "@d***". */
export function maskHandle(h: string) {
  const at = h.startsWith('@') ? '@' : '';
  const s = h.replace(/^@/, '');
  return s ? `${at}${s[0]}***` : h;
}

// ───────────── text ─────────────

const EMAIL_RE = /([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PLUS_PHONE_RE = /\+\d[\d ().-]{6,18}\d/g;
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g;
// "First Last" pairs in prose: a capitalised word, then a capitalised word we know as a lead's last name.
const PAIR_RE = /\b([A-Z][\p{L}'’-]+)(\s+)([A-Z][\p{L}'’-]+)\b/gu;

export interface MaskNames {
  /** Lower-case last names (3+ letters) of known people: in text, "Dana Quixley" becomes "Dana Q.". */
  last: Set<string>;
  /** Lower-case full names seen in this response (exact phrases replaced wherever they appear). */
  full: Map<string, string>;
}
export const emptyNames = (): MaskNames => ({ last: new Set(), full: new Map() });

/** Masks emails, +phone numbers, IPv4 addresses and known people's full names inside free text. */
export function maskText(s: string, names: MaskNames = emptyNames()) {
  let out = s.replace(EMAIL_RE, (m) => maskEmail(m)).replace(PLUS_PHONE_RE, (m) => maskPhone(m)).replace(IPV4_RE, HIDDEN);
  for (const [full, masked] of names.full) {
    if (full.length < 5 || !out.toLowerCase().includes(full)) continue;
    out = out.replace(new RegExp(full.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), masked);
  }
  if (names.last.size) out = out.replace(PAIR_RE, (m, a: string, sp: string, b: string) => (names.last.has(b.toLowerCase()) ? `${a}${sp}${initial(b)}` : m));
  return out;
}

// ───────────── JSON ─────────────

const FIRST = new Set(['first_name', 'firstname', 'first', 'given_name']);
const LAST = new Set(['last_name', 'lastname', 'last', 'surname', 'family_name']);
/** Keys that always hold a person's full name. */
const FULL = new Set(['full_name', 'lead_name', 'client_name', 'signer_name', 'from_name', 'to_name', 'contact_name', 'invitee_name', 'buyer_name', 'person', 'display_name', 'speaker', 'author_name', 'attendee']);
/** Keys that hold a person's name only inside a personal record. */
const FULL_IN_PERSONAL = new Set(['name', 'who', 'author', 'label_name']);
const HANDLE = new Set(['username', 'ig_username', 'handle', 'ig_handle', 'instagram']);
const IP = /(^|_)ip(_|$)|^ip_?hash$|^ip_address$|^client_ip$/i;
const EMAILISH = /email|^to_addr$|^reply_to$/i;
const PHONEISH = /phone|mobile|whatsapp|^wa_id$|^from_number$|^to_number$|^caller$|^callee$|^msisdn$/i;
/** Free text a person wrote or said, or that was written about them: hidden inside personal records. */
const FREE = new Set([
  'notes', 'note', 'owner_note', 'internal_note', 'transcript', 'transcript_text', 'summary', 'answers', 'raw_answers', 'answer',
  'body', 'text', 'message', 'messages', 'snippet', 'html', 'body_html', 'last_preview', 'first_message', 'last_message',
  'comment', 'comments', 'reply', 'public_reply', 'draft', 'drafts', 'question', 'structured', 'address', 'postal_code',
  'signature', 'user_agent', 'content', 'why', 'worst', 'desire', 'belief', 'evidence', 'quote', 'website', 'company',
  'client_company', 'detail', 'financials_url', 'recording_url', 'audio_url', 'transcript_url', 'analysis', 'data_collection',
]);
/** A record is personal when it carries one of these (a lead, a message, a call, an attendee, a signer…). */
const PERSONAL_MARKERS = [
  'lead_id', 'email', 'phone', 'first_name', 'last_name', 'from_number', 'to_phone', 'from_phone', 'wa_id', 'ig_user_id',
  'username', 'client_email', 'client_name', 'signer_name', 'reg_id', 'conversation_id', 'thread_id', 'visitor_id', 'contact_id', 'who',
];

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const personalObj = (o: Record<string, unknown>) => PERSONAL_MARKERS.some((k) => k in o && o[k] != null && o[k] !== '');

/** Collects the full names in a response (pass one), so free text elsewhere in it can be masked too. */
export function collectNames(v: unknown, names: MaskNames, depth = 0) {
  if (depth > 40) return;
  if (Array.isArray(v)) { for (const x of v) collectNames(x, names, depth + 1); return; }
  if (!isPlainObject(v)) return;
  const first = [...FIRST].map((k) => v[k]).find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  const last = [...LAST].map((k) => v[k]).find((x) => typeof x === 'string' && x.trim()) as string | undefined;
  if (last) addLast(names, last);
  if (first && last) addFull(names, `${first.trim()} ${last.trim()}`);
  const personal = personalObj(v);
  for (const [k, x] of Object.entries(v)) {
    const key = k.toLowerCase();
    if (typeof x === 'string' && (FULL.has(key) || (personal && FULL_IN_PERSONAL.has(key)))) addFull(names, x);
    else if (x && typeof x === 'object') collectNames(x, names, depth + 1);
  }
}
function addLast(names: MaskNames, last: string) {
  const l = last.trim().split(/\s+/).pop() ?? '';
  if (l.length >= 3) names.last.add(l.toLowerCase());
}
function addFull(names: MaskNames, full: string) {
  const f = full.trim().replace(/\s+/g, ' ');
  if (!f || f.includes('@') || f.split(' ').length < 2 || f.length > 80) return;
  names.full.set(f.toLowerCase(), maskName(f));
  addLast(names, f);
}

/** Hides every string inside a free-text value, keeping its shape (short codes such as "1m-3m" stay). */
function hideDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.trim() === '' || /^[\w.$+%-]{1,24}$/.test(v) ? v : HIDDEN;
  if (depth > 40) return HIDDEN;
  if (Array.isArray(v)) return v.map((x) => hideDeep(x, depth + 1));
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, hideDeep(x, depth + 1)]));
  return v;
}

/** A free-text field: a plain string is hidden whole; a JSON document (answers, structured call data) keeps its shape. */
function hideFree(v: unknown): unknown {
  if (typeof v !== 'string') return hideDeep(v);
  if (!v.trim()) return v;
  const t = v.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try { const p = JSON.parse(t); if (p && typeof p === 'object') return JSON.stringify(hideDeep(p)); } catch { /* plain text */ }
  }
  return HIDDEN;
}

/** Strings that are JSON documents (answers, structured call data) are masked as JSON, then put back as strings. */
function maskJsonString(s: string, names: MaskNames, personal: boolean, depth: number): string | null {
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('[')) || t.length < 2) return null;
  try { return JSON.stringify(walk(JSON.parse(t), names, personal, depth + 1)); } catch { return null; }
}

function maskValue(key: string, v: unknown, names: MaskNames, personal: boolean, depth: number): unknown {
  const k = key.toLowerCase();
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return IP.test(k) && v != null ? HIDDEN : v;
  if (IP.test(k)) return HIDDEN;
  if (personal && FREE.has(k)) return hideFree(v);
  if (typeof v === 'string') {
    if (FIRST.has(k)) return v;
    if (LAST.has(k)) return v.trim() ? initial(v.trim().split(/\s+/).pop() ?? '') : v;
    if (FULL.has(k) || (personal && FULL_IN_PERSONAL.has(k))) return v.includes('@') ? maskEmail(v) : maskName(maskText(v, names));
    if (HANDLE.has(k)) return maskHandle(v);
    if (EMAILISH.test(k)) return v.includes('@') ? maskEmail(v) : maskText(v, names);
    if (PHONEISH.test(k) && /\d{6,}|\d[\d ().-]{7,}\d/.test(v)) return maskPhone(v);
    const asJson = maskJsonString(v, names, personal, depth);
    return asJson ?? maskText(v, names);
  }
  return walk(v, names, personal, depth + 1);
}

function walk(v: unknown, names: MaskNames, personal: boolean, depth = 0): unknown {
  if (depth > 40) return v;
  if (typeof v === 'string') return maskText(v, names);
  if (Array.isArray(v)) return v.map((x) => walk(x, names, personal, depth + 1));
  if (!isPlainObject(v)) return v;
  const p = personal || personalObj(v);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = maskValue(k, x, names, p, depth);
  return out;
}

/**
 * Masks a parsed JSON response. `personalRoot`: the whole response is about people (the leads list, the DM inbox…),
 * so free text is hidden even in records that don't carry a lead id themselves.
 */
export function maskPii(v: unknown, opts: { personalRoot?: boolean; known?: MaskNames } = {}) {
  const names = opts.known ? { last: new Set(opts.known.last), full: new Map(opts.known.full) } : emptyNames();
  collectNames(v, names);
  return walk(v, names, !!opts.personalRoot);
}

/** Admin API paths (after /admin/api) whose whole response is about people. */
export const PERSONAL_PATHS = /^\/(leads|dm|sms|support|contracts|clients|voice|webinar-calls|rooms|reactivation|winback|sales|live|live-events|visitors|attribution\/(buyer|journey)|deal-sprint|challenge|dataq|vectors|intel|search|insights|ops\/threads|emails|webinar|links|audiences|camera-tests|precall-flow)(\/|$)/;

// ───────────── secrets ─────────────

/** Replaces every known secret value (8+ characters) inside a string. */
export function scrubSecrets(s: string, secrets: string[]) {
  let out = s;
  for (const sec of secrets) if (sec.length >= 8 && out.includes(sec)) out = out.split(sec).join(HIDDEN);
  return out;
}

/** Integrations: a secret setting shows only whether it is set. */
export function secretFieldsToSet(v: unknown, depth = 0): unknown {
  if (depth > 40) return v;
  if (Array.isArray(v)) return v.map((x) => secretFieldsToSet(x, depth + 1));
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = secretFieldsToSet(x, depth + 1);
  if (out.secret === true && 'value' in out) out.value = out.value ? 'set' : '';
  return out;
}
