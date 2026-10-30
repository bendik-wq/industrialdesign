// Security-header wrapper for Workers whose source lives outside this repo (owners-vsl-funnel, cold-block).
// deploy.sh downloads the live bundle, adds this file as the entry point and re-uploads with the same bindings,
// secrets and assets. The original code runs unchanged; this only adds headers on the way out.
//
// HTML pages get a nonce-based CSP: every <script> matched by __SCRIPTS__ (owners funnel: inside <head> (where the app puts all of its own scripts,
// inline and external; cold-block: its fixed page, which has no user content) gets a fresh per-request nonce, and 'strict-dynamic' lets those scripts load what they
// need (Meta Pixel, PostHog, Calendly, Stripe, hls.js). A <script> injected into the body gets no nonce and
// doesn't run. Pages that already set a strict CSP (the admin, sandboxed previews) keep theirs.
import orig from "./__ORIG__";
export * from "./__ORIG__";

const MODE = "__MODE__"; // "enforce" or "report"
// Pages not yet verified in a browser (token-gated: opening one as a real registrant would log attendance) run
// the policy in report-only mode; the browser posts any violation to /__csp-report, which goes to the logs.
const REPORT_ONLY = new RegExp(__REPORT_ONLY__);
const BASE = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": __PERMISSIONS__,
  "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
};
const WEAK_CSP = /^object-src 'none'; base-uri 'none'; frame-ancestors 'self'$/;
const csp = (nonce) => [
  "default-src 'self'",
  `script-src 'nonce-${nonce}' 'strict-dynamic' __HASHES__'self' https: 'unsafe-inline'`, // 'self' https: 'unsafe-inline' only for browsers without nonce support; modern browsers ignore them
  "style-src 'self' 'unsafe-inline' https:",
  "font-src 'self' data: https:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self' https:",
  "frame-ancestors __FRAME__",
  "upgrade-insecure-requests",
  "report-uri /__csp-report",
].join("; ");

function nonceOf() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]);
}

async function secure(req, res) {
  if (res.status === 101 || res.webSocket) return res; // WebSocket upgrades pass through untouched
  const r = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE)) if (!r.headers.has(k)) r.headers.set(k, v);
  if (!r.headers.has("X-Frame-Options")) r.headers.set("X-Frame-Options", "__XFO__");
  const html = (r.headers.get("content-type") || "").includes("text/html");
  const current = r.headers.get("Content-Security-Policy");
  if (!html || (current && !WEAK_CSP.test(current))) {
    if (!current) r.headers.set("Content-Security-Policy", "object-src 'none'; base-uri 'none'; frame-ancestors __FRAME__");
    return r;
  }
  const nonce = nonceOf();
  if (MODE === "enforce" && !REPORT_ONLY.test(new URL(req.url).pathname)) r.headers.set("Content-Security-Policy", csp(nonce));
  else { r.headers.set("Content-Security-Policy", current || "object-src 'none'; base-uri 'none'; frame-ancestors __FRAME__"); r.headers.set("Content-Security-Policy-Report-Only", csp(nonce)); }
  return new HTMLRewriter().on("__SCRIPTS__", { element: (e) => e.setAttribute("nonce", nonce) }).transform(r);
}

export default {
  ...orig,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__csp-report" && request.method === "POST") {
      const body = (await request.text().catch(() => "")).slice(0, 4000);
      console.log("csp-violation", JSON.stringify({ page: request.headers.get("referer") || "", report: body }));
      return new Response(null, { status: 204 });
    }
    return secure(request, await orig.fetch(request, env, ctx));
  },
};
