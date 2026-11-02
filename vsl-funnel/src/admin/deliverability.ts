import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { parseFilters } from './stats';

/**
 * Funnel HQ → Emails → Deliverability (read-only; changes nothing about sending). Mounted at /admin/api/deliverability.
 *
 *  - DNS health of each sending domain Resend uses, looked up over DNS-over-HTTPS (Cloudflare's 1.1.1.1 JSON API):
 *    SPF and the bounce MX on the return-path subdomain (Resend's default `send.`), DKIM (`resend._domainkey`),
 *    DMARC policy and reporting address, the domain's own MX (replies), and the open/click tracking host
 *    (our own /o/ and /r/ links on the public origin). Each check is pass / warn / fail with the exact record to add.
 *    When the Resend key can read domains, the expected records (including the DKIM key) come from Resend itself.
 *  - Bounce and complaint trend per day (Resend webhooks → email_suppressions) against real sends, with thresholds.
 *  - Per-sequence opens, clicks, bounces and complaints, so a bad sequence stands out.
 */

export type Level = 'pass' | 'warn' | 'fail';
export interface DnsAnswer { name: string; type: number; data: string; TTL?: number }
export type Resolver = (name: string, type: 'TXT' | 'MX' | 'A' | 'AAAA' | 'CNAME') => Promise<{ ok: boolean; answers: DnsAnswer[]; error?: string; cname?: string }>;
export interface Check { id: string; label: string; level: Level; host: string; found: string[]; detail: string; fix: { type: string; name: string; value: string; priority?: number } | null }
export interface ExpectedRecord { kind: 'spf' | 'dkim' | 'mx'; type: 'TXT' | 'MX'; name: string; value: string | null; priority?: number }

export const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const DNS_TYPE: Record<string, number> = { A: 1, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };
export const THRESHOLDS = { bounceWarn: 0.02, bounceFail: 0.04, complaintWarn: 0.001, complaintFail: 0.003, minSent: 20, lowOpen: 0.1, minSentForOpens: 50 };

// ───────────── DNS over HTTPS ─────────────

/** One DoH JSON lookup. Status 0 = answer (possibly empty), 3 = NXDOMAIN (no such name: treated as no records). */
export function dohResolver(fetcher: typeof fetch = fetch, timeoutMs = 4000): Resolver {
  return async (name, type) => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const res = await fetcher(`${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: ctl.signal }).finally(() => clearTimeout(t));
      if (!res.ok) return { ok: false, answers: [], error: `DNS lookup answered ${res.status}` };
      const body = (await res.json()) as { Status?: number; Answer?: DnsAnswer[] };
      if (body.Status !== 0 && body.Status !== 3) return { ok: false, answers: [], error: `DNS status ${body.Status}` };
      const all = body.Answer ?? [];
      const alias = type === 'CNAME' ? undefined : all.find((a) => a.type === DNS_TYPE.CNAME && a.name.replace(/\.$/, '').toLowerCase() === name.toLowerCase());
      return { ok: true, answers: all.filter((a) => a.type === DNS_TYPE[type]), ...(alias ? { cname: alias.data.replace(/\.$/, '').toLowerCase() } : {}) };
    } catch (e) {
      return { ok: false, answers: [], error: e instanceof Error && e.name === 'AbortError' ? 'DNS lookup timed out' : 'DNS lookup failed' };
    }
  };
}

/** A TXT answer's data is one or more quoted strings ("v=spf1 " "include:…"): join them into the record's text. */
export function txtValue(data: string) {
  const parts = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : data.trim();
}
export function mxValue(data: string) {
  const [prio, host] = data.trim().split(/\s+/);
  return { priority: Number(prio), host: (host ?? '').replace(/\.$/, '').toLowerCase() };
}
export function parseDmarc(txt: string) {
  const tags: Record<string, string> = {};
  for (const part of txt.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return { v: tags.v, p: (tags.p ?? '').toLowerCase(), sp: tags.sp?.toLowerCase(), rua: tags.rua ? tags.rua.split(',').map((x) => x.trim()).filter(Boolean) : [], pct: tags.pct == null ? 100 : Number(tags.pct), adkim: tags.adkim, aspf: tags.aspf };
}

/** Two-part public suffixes common for this business's audience (AU, UK, NZ…), so mail.example.com.au → example.com.au. */
const SECOND_LEVEL = /\.(com|net|org|edu|gov|asn|id|co|ac|ltd|plc|me|biz|info)\.(au|uk|nz|za|jp|in|sg|br|mx|my|hk|tw|il|kr|ar|cn)$/;
export function orgDomain(host: string) {
  const h = host.toLowerCase().replace(/\.$/, '');
  const labels = h.split('.');
  return labels.slice(SECOND_LEVEL.test(h) ? -3 : -2).join('.');
}
export function domainOf(address: string | undefined | null) {
  const m = /<([^>]+)>/.exec(address ?? '') ?? [null, address ?? ''];
  const at = (m[1] ?? '').trim().lastIndexOf('@');
  if (at < 0) return null;
  const d = (m[1] ?? '').trim().slice(at + 1).toLowerCase().replace(/[^a-z0-9.-]/g, '');
  return d.includes('.') ? d : null;
}

/** Resend's records for a domain when nobody gave us its own list (region from the domain, default us-east-1). */
export function defaultExpected(region = 'us-east-1'): ExpectedRecord[] {
  return [
    { kind: 'mx', type: 'MX', name: 'send', value: `feedback-smtp.${region}.amazonses.com`, priority: 10 },
    { kind: 'spf', type: 'TXT', name: 'send', value: 'v=spf1 include:amazonses.com ~all' },
    { kind: 'dkim', type: 'TXT', name: 'resend._domainkey', value: null },
  ];
}

/** Resend's GET /domains/:id records → our expected list (names relative to the domain). */
export function expectedFromResend(domain: string, records: { record?: string; name?: string; type?: string; value?: string; priority?: number }[]): ExpectedRecord[] {
  const rel = (n: string) => { const x = n.toLowerCase().replace(/\.$/, ''); return x.endsWith(`.${domain}`) ? x.slice(0, -domain.length - 1) : x === domain ? '@' : x; };
  const out: ExpectedRecord[] = [];
  for (const r of records) {
    const rec = String(r.record ?? '').toUpperCase(), type = String(r.type ?? '').toUpperCase();
    if (!r.name || !r.value) continue;
    if (type === 'MX') out.push({ kind: 'mx', type: 'MX', name: rel(r.name), value: r.value.replace(/\.$/, '').toLowerCase(), priority: Number(r.priority) || 10 });
    else if (type === 'TXT' && (rec === 'SPF' || r.value.startsWith('v=spf1'))) out.push({ kind: 'spf', type: 'TXT', name: rel(r.name), value: r.value });
    else if ((type === 'TXT' || type === 'CNAME') && (rec === 'DKIM' || /_domainkey/.test(r.name))) out.push({ kind: 'dkim', type: 'TXT', name: rel(r.name), value: r.value });
  }
  return out.length ? out : defaultExpected();
}

/** A return-path name that is a CNAME to another service can't also hold Resend's records. */
const aliasNote = (host: string, cname?: string) => (cname ? ` ${host} is a CNAME to ${cname}, so its records belong to that service and Resend’s can’t sit next to it: remove the CNAME, or set a different custom return path in Resend → Domains.` : '');
const fqdn = (name: string, domain: string) => (name === '@' || !name ? domain : `${name}.${domain}`);

/** Every DNS check for one sending domain. Pure apart from the resolver, so tests feed it canned DoH answers. */
export async function checkDomain(domain: string, resolve: Resolver, o: { expected?: ExpectedRecord[]; trackingHost?: string | null } = {}): Promise<Check[]> {
  const expected = o.expected ?? defaultExpected();
  const org = orgDomain(domain);
  const out: Check[] = [];
  const lookupFail = (id: string, label: string, host: string, error?: string): Check => ({ id, label, level: 'warn', host, found: [], detail: `Couldn’t look this up (${error ?? 'no answer'}). Check again in a minute.`, fix: null });

  // SPF + bounce MX on the return-path subdomain (Resend: send.<domain>).
  for (const e of expected.filter((x) => x.kind === 'spf')) {
    const host = fqdn(e.name, domain);
    const r = await resolve(host, 'TXT');
    if (!r.ok) { out.push(lookupFail('spf', 'SPF', host, r.error)); continue; }
    const spf = r.answers.map((a) => txtValue(a.data)).filter((t) => /^v=spf1\b/i.test(t));
    const want = e.value ?? 'v=spf1 include:amazonses.com ~all';
    const includes = [...want.matchAll(/include:(\S+)/g)].map((m) => m[1].toLowerCase());
    const fix = { type: 'TXT', name: host, value: want };
    if (!spf.length) out.push({ id: 'spf', label: 'SPF', level: 'fail', host, found: [], detail: 'No SPF record, so receivers can’t confirm Resend may send for this domain.', fix });
    else if (spf.length > 1) out.push({ id: 'spf', label: 'SPF', level: 'fail', host, found: spf, detail: 'More than one SPF record: receivers treat that as an error. Merge them into one.', fix });
    else if (!includes.every((inc) => spf[0].toLowerCase().includes(`include:${inc}`))) out.push({ id: 'spf', label: 'SPF', level: 'fail', host, found: spf, detail: `The SPF record doesn’t include ${includes.join(', ')}.${aliasNote(host, r.cname)}`, fix });
    else if (/\+all\b/.test(spf[0])) out.push({ id: 'spf', label: 'SPF', level: 'warn', host, found: spf, detail: 'The record ends in +all, which lets anyone send as this domain.', fix });
    else out.push({ id: 'spf', label: 'SPF', level: 'pass', host, found: spf, detail: 'Resend is allowed to send for this domain.', fix: null });
  }
  for (const e of expected.filter((x) => x.kind === 'mx')) {
    const host = fqdn(e.name, domain);
    const r = await resolve(host, 'MX');
    if (!r.ok) { out.push(lookupFail('bounce_mx', 'Bounce MX', host, r.error)); continue; }
    const mx = r.answers.map((a) => mxValue(a.data));
    const want = (e.value ?? '').toLowerCase();
    const fix = { type: 'MX', name: host, value: want, priority: e.priority ?? 10 };
    if (mx.some((m) => m.host === want)) out.push({ id: 'bounce_mx', label: 'Bounce MX', level: 'pass', host, found: mx.map((m) => `${m.priority} ${m.host}`), detail: 'Bounces come back to Resend, which reports them here.', fix: null });
    else out.push({ id: 'bounce_mx', label: 'Bounce MX', host, level: 'fail', found: mx.map((m) => `${m.priority} ${m.host}`), detail: (mx.length ? `Points to ${mx[0].host}, not Resend’s ${want}.` : 'Missing: bounces can’t reach Resend, and the domain won’t verify.') + aliasNote(host, r.cname), fix });
  }

  // DKIM.
  for (const e of expected.filter((x) => x.kind === 'dkim')) {
    const host = fqdn(e.name, domain);
    const r = await resolve(host, 'TXT');
    if (!r.ok) { out.push(lookupFail('dkim', 'DKIM', host, r.error)); continue; }
    const txt = r.answers.map((a) => txtValue(a.data)).filter((t) => /(^|;)\s*p=/.test(t));
    const fix = { type: 'TXT', name: host, value: e.value ?? 'the DKIM value shown in Resend → Domains (starts with p=)' };
    const norm = (s: string) => s.replace(/\s+/g, '');
    if (!txt.length) out.push({ id: 'dkim', label: 'DKIM', level: 'fail', host, found: [], detail: 'No DKIM key, so mail isn’t signed for this domain and DMARC can’t pass on DKIM.', fix });
    else if (e.value && !txt.some((t) => norm(t) === norm(e.value!))) out.push({ id: 'dkim', label: 'DKIM', level: 'fail', host, found: txt.map((t) => t.slice(0, 80) + (t.length > 80 ? '…' : '')), detail: 'A key is published but it isn’t the one Resend signs with.', fix });
    else if (/(^|;)\s*p=\s*(;|$)/.test(txt[0])) out.push({ id: 'dkim', label: 'DKIM', level: 'fail', host, found: txt, detail: 'The key is empty (p=), which revokes it.', fix });
    else out.push({ id: 'dkim', label: 'DKIM', level: 'pass', host, found: txt.map((t) => t.slice(0, 80) + (t.length > 80 ? '…' : '')), detail: 'Mail is signed for this domain.', fix: null });
  }

  // DMARC: the domain's own record, else the organisational domain's (which covers subdomains via sp=).
  {
    let host = `_dmarc.${domain}`;
    let r = await resolve(host, 'TXT');
    let recs = r.ok ? r.answers.map((a) => txtValue(a.data)).filter((t) => /^v=DMARC1\b/i.test(t)) : [];
    let inherited = false;
    if (r.ok && !recs.length && org !== domain) {
      host = `_dmarc.${org}`;
      r = await resolve(host, 'TXT');
      recs = r.ok ? r.answers.map((a) => txtValue(a.data)).filter((t) => /^v=DMARC1\b/i.test(t)) : [];
      inherited = true;
    }
    const fixHost = `_dmarc.${org}`;
    const suggest = (p: string) => ({ type: 'TXT', name: fixHost, value: `v=DMARC1; p=${p}; rua=mailto:dmarc@${org}; adkim=r; aspf=r` });
    if (!r.ok) out.push(lookupFail('dmarc', 'DMARC', host, r.error));
    else if (!recs.length) out.push({ id: 'dmarc', label: 'DMARC', level: 'fail', host: fixHost, found: [], detail: 'No DMARC record. Gmail and Yahoo require one from bulk senders; mail can land in spam or be rejected.', fix: suggest('none') });
    else if (recs.length > 1) out.push({ id: 'dmarc', label: 'DMARC', level: 'fail', host, found: recs, detail: 'More than one DMARC record: receivers ignore both. Keep one.', fix: suggest('none') });
    else {
      const d = parseDmarc(recs[0]);
      const policy = inherited && d.sp ? d.sp : d.p;
      const notes: string[] = [];
      let level: Level = 'pass';
      if (!['none', 'quarantine', 'reject'].includes(policy)) { level = 'fail'; notes.push(`Policy “${policy || 'missing'}” isn’t valid (none, quarantine or reject).`); }
      else if (policy === 'none') { level = 'warn'; notes.push('p=none only monitors. Move to quarantine once the reports show SPF and DKIM passing.'); }
      if (!d.rua.length) { level = level === 'fail' ? 'fail' : 'warn'; notes.push('No rua= reporting address, so nobody sees the aggregate reports.'); }
      if (d.pct < 100) { level = level === 'fail' ? 'fail' : 'warn'; notes.push(`pct=${d.pct}: the policy covers only part of the mail.`); }
      const summary = `Policy ${policy}${inherited ? ` (from ${org})` : ''}${d.rua.length ? `, reports to ${d.rua.join(', ')}` : ''}.`;
      out.push({ id: 'dmarc', label: 'DMARC', level, host, found: recs, detail: [summary, ...notes].join(' '), fix: level === 'pass' ? null : suggest(policy === 'reject' || policy === 'quarantine' ? policy : 'none') });
    }
  }

  // The domain's own MX: replies to the From address need somewhere to go.
  {
    const r = await resolve(domain, 'MX');
    const mx = r.ok ? r.answers.map((a) => mxValue(a.data)) : [];
    if (!r.ok) out.push(lookupFail('mx', 'Inbox MX', domain, r.error));
    else if (!mx.length) out.push({ id: 'mx', label: 'Inbox MX', level: 'warn', host: domain, found: [], detail: 'No MX record: replies to the From address bounce, and some filters distrust domains that can’t receive mail. Add your mailbox provider’s MX (Google Workspace, Microsoft 365…), or set a Reply-to address on a domain that receives mail.', fix: { type: 'MX', name: domain, value: 'your mailbox provider’s MX host' } });
    else out.push({ id: 'mx', label: 'Inbox MX', level: 'pass', host: domain, found: mx.map((m) => `${m.priority} ${m.host}`), detail: 'Replies have somewhere to go.', fix: null });
  }

  // Open / click tracking host (our own /o/ pixel and /r/ redirects on the public origin).
  if (o.trackingHost) {
    const host = o.trackingHost.toLowerCase();
    const [a, cname] = await Promise.all([resolve(host, 'A'), resolve(host, 'CNAME')]);
    const found = [...a.answers.map((x) => `A ${x.data}`), ...cname.answers.map((x) => `CNAME ${x.data.replace(/\.$/, '')}`)];
    if (!a.ok && !cname.ok) out.push(lookupFail('tracking', 'Open & click tracking', host, a.error));
    else if (!found.length) out.push({ id: 'tracking', label: 'Open & click tracking', level: 'fail', host, found, detail: 'The tracking host doesn’t resolve, so every link in every email is broken. Check Public URL under Settings.', fix: { type: 'CNAME', name: host, value: 'your Workers custom domain' } });
    else if (orgDomain(host) !== org) out.push({ id: 'tracking', label: 'Open & click tracking', level: 'warn', host, found, detail: `Links and the open pixel point to ${orgDomain(host)} while mail comes from ${org}. Filters trust mail more when the link domain matches the sender.`, fix: null });
    else out.push({ id: 'tracking', label: 'Open & click tracking', level: 'pass', host, found, detail: `Opens and clicks are tracked on ${host}, the same domain the mail comes from.`, fix: null });
  }
  return out;
}

export const worst = (levels: Level[]): Level => (levels.includes('fail') ? 'fail' : levels.includes('warn') ? 'warn' : 'pass');

// ───────────── Resend's own view of the domains (read-only) ─────────────

interface ResendDomain { id: string; name: string; status?: string; region?: string; records?: { record?: string; name?: string; type?: string; value?: string; priority?: number; status?: string }[]; open_tracking?: boolean; click_tracking?: boolean }

async function resendDomains(rt: Runtime, fetcher: typeof fetch): Promise<{ domains: ResendDomain[]; note: string | null }> {
  const key = rt.settings.RESEND_API_KEY;
  if (!key) return { domains: [], note: 'No Resend key: the expected records are Resend’s defaults (the DKIM value can’t be compared).' };
  try {
    const h = { authorization: `Bearer ${key}` };
    const res = await fetcher('https://api.resend.com/domains', { headers: h });
    if (!res.ok) return { domains: [], note: res.status === 401 || res.status === 403 ? 'The Resend key is send-only, so it can’t read the domain list: the expected records are Resend’s defaults.' : `Resend answered ${res.status}: using Resend’s default records.` };
    const list = ((await res.json()) as { data?: ResendDomain[] }).data ?? [];
    const full = await Promise.all(list.slice(0, 5).map(async (d) => {
      const r = await fetcher(`https://api.resend.com/domains/${encodeURIComponent(d.id)}`, { headers: h }).catch(() => null);
      return r?.ok ? ({ ...d, ...((await r.json()) as ResendDomain) }) : d;
    }));
    return { domains: full, note: null };
  } catch {
    return { domains: [], note: 'Resend didn’t answer: using Resend’s default records.' };
  }
}

const dnsMemo = new Map<string, { at: number; value: unknown }>();
const DNS_TTL_MS = 10 * 60_000;

/** All sending domains: the From address's domain plus any domain Resend has (up to 5). DNS answers memoised 10 minutes. */
export async function dnsHealth(rt: Runtime, o: { fetcher?: typeof fetch; refresh?: boolean; now?: number } = {}) {
  const fetcher = o.fetcher ?? fetch;
  const now = o.now ?? Date.now();
  const memoKey = `${rt.settings.EMAIL_FROM ?? ''}|${rt.origin}|${rt.settings.RESEND_API_KEY ? 'k' : ''}`;
  const hit = dnsMemo.get(memoKey);
  if (!o.refresh && hit && now - hit.at < DNS_TTL_MS) return hit.value as Awaited<ReturnType<typeof computeDns>>;
  const value = await computeDns(rt, fetcher, now);
  dnsMemo.set(memoKey, { at: now, value });
  if (dnsMemo.size > 20) dnsMemo.delete(dnsMemo.keys().next().value!);
  return value;
}

async function computeDns(rt: Runtime, fetcher: typeof fetch, now: number) {
  const from = rt.settings.EMAIL_FROM || '';
  const fromDomain = domainOf(from);
  const { domains: resend, note } = await resendDomains(rt, fetcher);
  const names = [...new Set([fromDomain, ...resend.map((d) => d.name?.toLowerCase())].filter((x): x is string => Boolean(x)))].slice(0, 5);
  let trackingHost: string | null = null;
  try { trackingHost = new URL(rt.origin).hostname; } catch { /* none */ }
  if (trackingHost && /^(localhost|127\.0\.0\.1)$/.test(trackingHost)) trackingHost = null;
  const resolve = dohResolver(fetcher);
  const domains = await Promise.all(names.map(async (name) => {
    const rd = resend.find((d) => d.name?.toLowerCase() === name);
    const expected = rd?.records?.length ? expectedFromResend(name, rd.records) : defaultExpected(rd?.region);
    const checks = await checkDomain(name, resolve, { expected, trackingHost: name === fromDomain || !fromDomain ? trackingHost : null });
    if (rd && (rd.click_tracking || rd.open_tracking)) {
      checks.push({ id: 'resend_tracking', label: 'Resend tracking', level: 'warn', host: name, found: [rd.open_tracking ? 'open tracking on' : '', rd.click_tracking ? 'click tracking on' : ''].filter(Boolean), detail: 'Resend’s own open/click tracking is on as well as ours: links get wrapped twice. Our /o/ and /r/ links already count opens and clicks, so it can be switched off in Resend → Domains → Configuration.', fix: null });
    }
    return { domain: name, isFrom: name === fromDomain, resendStatus: rd?.status ?? null, region: rd?.region ?? null, level: worst(checks.map((c) => c.level)), checks };
  }));
  return {
    checkedAt: now, from: from || null, fromDomain, trackingHost, note,
    level: domains.length ? worst(domains.map((d) => d.level)) : ('fail' as Level),
    domains,
    empty: !names.length ? 'No From address set (Settings → Email → From address), so there’s no sending domain to check.' : null,
  };
}

// ───────────── bounces, complaints and sequences (from our own tables) ─────────────

export const rateLevel = (rate: number | null, warn: number, fail: number, sent: number): Level =>
  rate == null || sent < THRESHOLDS.minSent ? 'pass' : rate >= fail ? 'fail' : rate >= warn ? 'warn' : 'pass';

const DAY = 86_400_000;

export async function deliveryStats(rt: Runtime, f: { from: number; to: number; tzOffsetMin?: number }) {
  const db = rt.env.DB;
  const from = Math.max(f.from, f.to - 90 * DAY); // the daily trend covers at most 90 days
  const tz = (f.tzOffsetMin ?? 0) * 60_000;
  const dayExpr = (col: string) => `CAST((${col} + ${Math.round(tz)}) / ${DAY} AS INTEGER)`;
  const [sent, bad, seqs, totals] = await Promise.all([
    db.prepare(`SELECT ${dayExpr('sent_at')} AS d, COUNT(*) AS n FROM emails WHERE status = 'sent' AND sent_at BETWEEN ? AND ? GROUP BY 1`).bind(from, f.to).all<{ d: number; n: number }>(),
    db.prepare(`SELECT ${dayExpr('created_at')} AS d, SUM(reason = 'bounced') AS bounced, SUM(reason = 'complained') AS complained FROM email_suppressions WHERE created_at BETWEEN ? AND ? AND reason IN ('bounced', 'complained') GROUP BY 1`).bind(from, f.to).all<{ d: number; bounced: number; complained: number }>(),
    db.prepare(
      `SELECT sequence, COUNT(*) AS sent, SUM(opened_at IS NOT NULL) AS opened, SUM(clicked_at IS NOT NULL) AS clicked,
              SUM(error = 'bounced') AS bounced, SUM(error = 'complained') AS complained
         FROM emails WHERE status = 'sent' AND sent_at BETWEEN ? AND ? GROUP BY sequence ORDER BY sent DESC`,
    ).bind(f.from, f.to).all<{ sequence: string; sent: number; opened: number; clicked: number; bounced: number; complained: number }>(),
    db.prepare(`SELECT SUM(status = 'sent') AS real, SUM(status = 'simulated') AS simulated FROM emails WHERE sent_at BETWEEN ? AND ?`).bind(f.from, f.to).first<{ real: number | null; simulated: number | null }>(),
  ]);
  const byDay = new Map<number, { sent: number; bounced: number; complained: number }>();
  for (let d = Math.floor((from + tz) / DAY); d <= Math.floor((f.to + tz) / DAY); d++) byDay.set(d, { sent: 0, bounced: 0, complained: 0 });
  for (const r of sent.results) { const x = byDay.get(r.d); if (x) x.sent = Number(r.n) || 0; }
  for (const r of bad.results) { const x = byDay.get(r.d); if (x) { x.bounced = Number(r.bounced) || 0; x.complained = Number(r.complained) || 0; } }
  const days = [...byDay.entries()].map(([d, x]) => ({ day: new Date(d * DAY).toISOString().slice(0, 10), ...x }));
  const sum = (k: 'sent' | 'bounced' | 'complained', list = days) => list.reduce((a, x) => a + x[k], 0);
  const window = (list: typeof days) => {
    const s = sum('sent', list), b = sum('bounced', list), c = sum('complained', list);
    const bounceRate = s ? b / s : null, complaintRate = s ? c / s : null;
    return { sent: s, bounced: b, complained: c, bounceRate, complaintRate, bounceLevel: rateLevel(bounceRate, THRESHOLDS.bounceWarn, THRESHOLDS.bounceFail, s), complaintLevel: rateLevel(complaintRate, THRESHOLDS.complaintWarn, THRESHOLDS.complaintFail, s) };
  };
  const sequences = seqs.results.map((r) => {
    const sentN = Number(r.sent) || 0;
    const rate = (n: number) => (sentN ? (Number(n) || 0) / sentN : null);
    const flags: string[] = [];
    const bounceRate = rate(r.bounced), complaintRate = rate(r.complained), openRate = rate(r.opened);
    if (sentN >= THRESHOLDS.minSent && bounceRate != null && bounceRate >= THRESHOLDS.bounceWarn) flags.push('bounces');
    if ((Number(r.complained) || 0) > 0) flags.push('complaints');
    if (sentN >= THRESHOLDS.minSentForOpens && openRate != null && openRate < THRESHOLDS.lowOpen) flags.push('low opens');
    return {
      sequence: r.sequence, sent: sentN, opened: Number(r.opened) || 0, clicked: Number(r.clicked) || 0, bounced: Number(r.bounced) || 0, complained: Number(r.complained) || 0,
      openRate, clickRate: rate(r.clicked), bounceRate, complaintRate, flags,
      level: flags.includes('complaints') || (bounceRate != null && sentN >= THRESHOLDS.minSent && bounceRate >= THRESHOLDS.bounceFail) ? ('fail' as Level) : flags.length ? ('warn' as Level) : ('pass' as Level),
    };
  });
  return {
    days, range: window(days), last7: window(days.slice(-7)), sequences,
    real: Number(totals?.real) || 0, simulated: Number(totals?.simulated) || 0,
    thresholds: THRESHOLDS,
    note: 'Bounces and complaints come from Resend’s webhooks (hard bounces and spam reports block the address for good). Per-sequence bounces count emails Resend reported against that exact send. Apple Mail opens some emails automatically, so open rates run high.',
  };
}

export const deliverabilityAdmin = new Hono<AppEnv>();

deliverabilityAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  const f = parseFilters(c.req.query());
  const [dns, stats] = await Promise.all([dnsHealth(rt, { refresh: c.req.query('refresh') === '1' }), deliveryStats(rt, f)]);
  return c.json({ dns, stats });
});
