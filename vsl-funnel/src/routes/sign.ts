import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { sameOriginWrite } from '../admin/auth';
import { escHtml } from '../followup/dossier';
import { geoFromRequest } from '../lib/geo';
import { overLimit } from '../lib/ratelimit';
import { parseUA } from '../lib/ua';
import { type Contract, company, contractByToken, documentHtml, isExpired, markViewed, signContract } from '../sales/contracts';

/** /sign/<token>: read and e-sign an engagement letter; /sign/<token>/copy: the signed copy with its signing record. */
export const sign = new Hono<AppEnv>();

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escHtml(title)}</title><link rel="stylesheet" href="/assets/site.css"><link rel="stylesheet" href="/assets/sign.css"></head><body class="simple sign-page"><main class="sign-wrap">${body}</main><script src="/assets/sign.js" defer></script></body></html>`;

function headers(c: { header: (k: string, v: string) => void }) {
  c.header('cache-control', 'no-store');
  c.header('referrer-policy', 'no-referrer');
  c.header('x-robots-tag', 'noindex, nofollow');
}

const when = (ms: number | null, tz: string) => (ms ? new Date(ms).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }) + ` (${tz})` : '–');

function auditTrail(k: Contract, tz: string) {
  return `<section class="audit"><h2>Signing record</h2><dl>
    <dt>Document</dt><dd>${escHtml(k.title)}</dd>
    <dt>Document fingerprint (SHA-256)</dt><dd class="mono">${escHtml(k.doc_hash ?? '')}</dd>
    <dt>Signed for us by</dt><dd>${escHtml(k.our_signer ?? '')} on ${escHtml(when(k.our_signed_at, tz))}${k.our_signer_ip ? ` (IP ${escHtml(k.our_signer_ip)})` : ''}</dd>
    <dt>Sent to</dt><dd>${escHtml(k.client_email ?? '')} on ${escHtml(when(k.sent_at, tz))}</dd>
    <dt>First opened</dt><dd>${escHtml(when(k.viewed_at, tz))}</dd>
    <dt>Signed by</dt><dd>${escHtml(k.signer_name ?? '')}${k.signer_title ? `, ${escHtml(k.signer_title)}` : ''} (${k.signature_kind === 'drawn' ? 'drawn signature' : 'typed signature'})</dd>
    <dt>Signed at</dt><dd>${escHtml(when(k.signed_at, tz))}</dd>
    <dt>From</dt><dd>IP ${escHtml(k.signer_ip ?? 'unknown')}${k.signer_country ? `, ${escHtml(k.signer_country)}` : ''}</dd>
    <dt>Consent</dt><dd>Agreed to sign electronically and that the signature has the same effect as a handwritten one.</dd>
  </dl></section>`;
}

sign.get('/:token{[0-9a-f]{40}}', async (c) => {
  headers(c);
  const rt = runtimeFrom(c);
  const k = await contractByToken(rt, c.req.param('token'));
  if (!k || k.status === 'draft' || k.status === 'void' || !k.body_html) return c.html(page('Link not available', '<h1 class="h2">This link isn’t available</h1><p>It may have been replaced by a newer version. Reply to the email and we’ll send a fresh one.</p>'), 404);
  if (k.status === 'signed') return c.redirect(`/sign/${k.token}/copy`, 302);
  if (isExpired(k)) return c.html(page('Link expired', '<h1 class="h2">This signing link has expired</h1><p>Reply to the email and we’ll send a fresh one.</p>'), 410);
  // Link previews and mail scanners open links too; only a person counts as "opened".
  if (!parseUA(c.req.header('user-agent')).isBot) await markViewed(rt, k);
  const first = (k.client_name ?? '').trim();
  return c.html(page(k.title, `
    ${k.is_test ? '<p class="test-banner">Test agreement: signing it changes nothing.</p>' : ''}
    <article class="letter" data-letter>${documentHtml(rt, k)}</article>
    <form class="sign-form" data-sign-form data-hash="${escHtml(k.doc_hash ?? '')}" data-token="${escHtml(k.token)}" novalidate>
      <h2>Sign</h2>
      <label>Full name<input class="input" name="name" autocomplete="name" required value="${escHtml(first)}"></label>
      <label>Title / role <span class="muted">(optional)</span><input class="input" name="title" autocomplete="organization-title" placeholder="Director"></label>
      <div class="sig-tabs" role="tablist"><button type="button" class="on" data-mode="typed" role="tab" aria-selected="true">Type</button><button type="button" data-mode="drawn" role="tab" aria-selected="false">Draw</button></div>
      <div class="sig-typed" data-typed><span data-typed-preview>${escHtml(first || 'Your name')}</span></div>
      <div class="sig-draw" data-drawn hidden><canvas width="600" height="180" aria-label="Draw your signature"></canvas><button type="button" class="btn-sm ghost" data-clear>Clear</button></div>
      <label class="consent"><input type="checkbox" name="consent"> I have read this agreement, agree to its terms, and agree to sign it electronically with the same effect as a handwritten signature.</label>
      <p class="err" data-err role="alert"></p>
      <button class="btn" type="submit">Sign the agreement</button>
      <p class="muted small">We record your name, the time, your IP address and a fingerprint of this exact document with your signature. You’ll get a signed copy by email.</p>
    </form>`));
});

sign.post('/:token{[0-9a-f]{40}}', async (c) => {
  headers(c);
  if (!sameOriginWrite(c)) return c.json({ ok: false, error: 'Forbidden' }, 403);
  const ip = c.req.header('cf-connecting-ip') ?? null;
  if (await overLimit(c.env, `sign:${ip ?? 'unknown'}`, 20)) return c.json({ ok: false, error: 'Too many attempts. Try again in an hour.' }, 429);
  const rt = runtimeFrom(c);
  const k = await contractByToken(rt, c.req.param('token'));
  if (!k) return c.json({ ok: false, error: 'This link isn’t available.' }, 404);
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}) as Record<string, unknown>);
  const res = await signContract(rt, k, body, { ip, ua: c.req.header('user-agent') ?? null, country: geoFromRequest(c.req.raw).country });
  return c.json(res, res.ok ? 200 : 400);
});

sign.get('/:token{[0-9a-f]{40}}/copy', async (c) => {
  headers(c);
  const rt = runtimeFrom(c);
  const k = await contractByToken(rt, c.req.param('token'));
  if (!k || k.status !== 'signed' || !k.body_html) return c.redirect(k ? `/sign/${k.token}` : '/', 302);
  const tz = 'America/Denver';
  return c.html(page(`Signed: ${k.title}`, `
    <p class="signed-banner">${k.is_test ? 'Test agreement. ' : ''}Signed by both parties, ${escHtml(when(k.signed_at, tz))}. <button type="button" class="btn-sm ghost" data-print>Save as PDF / print</button></p>
    <article class="letter">${documentHtml(rt, k)}</article>${auditTrail(k, tz)}
    <p class="muted small" style="text-align:center;margin-top:14px">${escHtml(company(rt).name)}</p>`));
});
