import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { normalisePath, recordError } from './errors';

/**
 * Content-Security-Policy violation reports. Every CSP the app sends gets `report-uri` (older browsers, Firefox) and
 * `report-to` (the Reporting API) appended, pointing here; nothing else in a policy changes. Each violation lands in
 * the error log (Funnel HQ → Errors & cron) as kind "csp", grouped by directive, blocked origin and page.
 *
 * The endpoint is public by nature (browsers post without cookies), so it is rate limited per IP (PUBLIC_RATE_LIMITS),
 * reads at most MAX_REPORT_BYTES, files at most MAX_REPORTS_PER_POST reports per post, and ignores what browser
 * extensions trigger (their scripts aren't ours to fix).
 */
export const CSP_REPORT_PATH = '/csp-report';
export const CSP_GROUP = 'csp';
export const MAX_REPORT_BYTES = 16_384;
export const MAX_REPORTS_PER_POST = 5;

/** The policy with the report directives appended (unchanged when it already reports somewhere). */
export function withReporting(policy: string): string {
  if (/(^|;)\s*report-(uri|to)\b/i.test(policy)) return policy;
  return `${policy.trim().replace(/;\s*$/, '')}; report-uri ${CSP_REPORT_PATH}; report-to ${CSP_GROUP}`;
}

/** The Reporting-Endpoints header that names the `report-to` group (absolute URL, as the Reporting API wants). */
export const reportingEndpoints = (origin: string) => `${CSP_GROUP}="${origin}${CSP_REPORT_PATH}"`;

/** Adds reporting to a response's CSP (pages only; other responses don't run a policy). */
export function addCspReporting(headers: Headers, origin: string) {
  const csp = headers.get('content-security-policy');
  if (!csp || !/^text\/html/i.test(headers.get('content-type') ?? '')) return false;
  const next = withReporting(csp);
  if (next === csp) return false;
  headers.set('content-security-policy', next);
  if (!headers.has('reporting-endpoints')) headers.set('reporting-endpoints', reportingEndpoints(origin));
  return true;
}

export interface CspViolation { directive: string; blocked: string; page: string; sample: string | null; disposition: string }

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');

/** `https://cdn.x.com/a/b.js?k=1` → `https://cdn.x.com`; keywords (inline, eval, data, blob) stay as they are. */
export function blockedLabel(uri: string): string {
  const u = uri.trim();
  if (!u) return 'unknown';
  if (/^(inline|eval|wasm-eval|trusted-types-\w+|self)$/i.test(u)) return u.toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (scheme && !/^https?$/i.test(scheme[1]) && !/^wss?$/i.test(scheme[1])) return `${scheme[1].toLowerCase()}:`;
  try { return new URL(u).origin; } catch { return u.slice(0, 60); }
}

const pagePath = (uri: string) => { try { return normalisePath(new URL(uri).pathname); } catch { return 'unknown'; } };
const EXTENSION = /^(chrome|moz|safari(-web)?|ms-browser|edge)-extension:/i;

/** Violations from a report-uri body ({"csp-report": {...}}) or a Reporting API batch ([{type, body}]). */
export function parseReports(raw: string): CspViolation[] {
  let j: unknown;
  try { j = JSON.parse(raw); } catch { return []; }
  const bodies: Record<string, unknown>[] = [];
  if (Array.isArray(j)) {
    for (const r of j.slice(0, MAX_REPORTS_PER_POST)) {
      const x = r as { type?: unknown; body?: unknown };
      if (x && x.type === 'csp-violation' && x.body && typeof x.body === 'object') bodies.push(x.body as Record<string, unknown>);
    }
  } else if (j && typeof j === 'object' && (j as Record<string, unknown>)['csp-report'] && typeof (j as Record<string, unknown>)['csp-report'] === 'object') {
    bodies.push((j as Record<string, Record<string, unknown>>)['csp-report']);
  }
  const out: CspViolation[] = [];
  for (const b of bodies) {
    // report-uri uses kebab-case keys, the Reporting API camelCase.
    const directive = str(b['effective-directive'] ?? b.effectiveDirective ?? b['violated-directive'] ?? b.violatedDirective, 60).split(' ')[0] || 'unknown';
    const blockedRaw = str(b['blocked-uri'] ?? b.blockedURL ?? b.blockedUri);
    const sourceFile = str(b['source-file'] ?? b.sourceFile);
    if (EXTENSION.test(blockedRaw) || EXTENSION.test(sourceFile)) continue;
    out.push({
      directive,
      blocked: blockedLabel(blockedRaw),
      page: pagePath(str(b['document-uri'] ?? b.documentURL ?? b.documentUri, 2000)),
      sample: str(b['script-sample'] ?? b.sample, 40) || null,
      disposition: str(b.disposition, 20) || 'enforce',
    });
  }
  return out;
}

/** Reads at most `max` bytes of the body; null when it is bigger. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { await reader.cancel().catch(() => null); return null; }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const ch of chunks) { all.set(ch, at); at += ch.byteLength; }
  return new TextDecoder().decode(all);
}

/** POST /csp-report: files each violation in the error log. Always answers 204 (or 413) so browsers don't retry. */
export async function cspReportRoute(c: Context<AppEnv>) {
  const raw = await readCapped(c.req.raw, MAX_REPORT_BYTES);
  if (raw === null) return c.body(null, 413);
  const reports = parseReports(raw);
  const writes = reports.map((r) =>
    recordError(c.env, new Error(`CSP ${r.directive} blocked ${r.blocked}${r.sample ? ` (sample: ${r.sample})` : ''}${r.disposition === 'report' ? ' [report-only]' : ''}`), { kind: 'csp', source: `${r.directive} on ${r.page}` }),
  );
  const all = Promise.all(writes);
  try { c.executionCtx.waitUntil(all); } catch { await all; }
  return c.body(null, 204);
}
