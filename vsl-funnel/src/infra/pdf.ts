import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { hmacHex, safeEqual, sha256 } from '../lib/crypto';
import { overLimit } from '../lib/ratelimit';
import { getSecret } from '../lib/secret';
import { flag } from '../settings';
import { blockTrackers, browserAvailable, withBrowser } from './browser';
import { recordError } from './errors';
import { signedFileUrl } from './signed-files';

/**
 * Download PDF (Cloudflare round, builder D; setting PDF_RENDER, off by default).
 *
 * The Deal Plan page (/rooms/plan/:id/:ref) and the signed agreement (/sign/:token/copy) get a Download PDF link.
 * The link renders our own page in Cloudflare Browser Rendering, at its own address plus a signed render token
 * that lasts five minutes (?pdf=…; the page then leaves out its own PDF and print buttons), stores the PDF in the R2
 * bucket RECORDINGS under pdf/, and sends the person to a signed link to that file that lasts ten minutes.
 * The stored key carries a fingerprint of what the page shows, so a changed plan or a newly paid agreement renders
 * again and an unchanged one is reused.
 *
 * Off, or without the BROWSER or RECORDINGS binding (local dev), nothing changes: no link, and the page's own
 * print / save as PDF stays. A failed render sends the person back to the page.
 */
export const PDF_RENDER_TTL_MS = 5 * 60_000;
export const PDF_LINK_TTL_MS = 10 * 60_000;
/** Renders per IP per hour (a cached PDF doesn't count). */
export const PDF_RENDERS_PER_HOUR = 20;

export const pdfEnabled = (rt: Pick<Runtime, 'env' | 'settings'>) => flag(rt.settings.PDF_RENDER) && browserAvailable(rt.env) && Boolean(rt.env.RECORDINGS);

const tokenSig = async (rt: Pick<Runtime, 'env'>, path: string, exp: number) => (await hmacHex(await getSecret(rt.env), `pdfr|${path}|${exp}`)).slice(0, 24);

/** The ?pdf= value that lets the renderer open `path` (a pathname) for the next five minutes. */
export async function pdfRenderToken(rt: Pick<Runtime, 'env'>, path: string, now = Date.now()) {
  const exp = now + PDF_RENDER_TTL_MS;
  return `${exp}.${await tokenSig(rt, path, exp)}`;
}
export async function checkPdfRenderToken(rt: Pick<Runtime, 'env'>, path: string, token: string | undefined | null, now = Date.now()) {
  const m = /^(\d{10,16})\.([0-9a-f]{24})$/.exec(token ?? '');
  if (!m || Number(m[1]) < now || Number(m[1]) > now + PDF_RENDER_TTL_MS + 60_000) return false;
  return safeEqual(await tokenSig(rt, path, Number(m[1])), m[2]);
}
/** True when this request is our own renderer (the page then hides its PDF / print buttons). */
export async function isPdfRender(c: Context<AppEnv>) {
  const t = c.req.query('pdf');
  return t ? checkPdfRenderToken({ env: c.env }, c.req.path, t) : false;
}

/** Renders `path` on this site to a PDF. null when no browser is available or the page didn't load. */
export async function renderPdf(rt: Runtime, path: string): Promise<Uint8Array | null> {
  const url = `${rt.origin}${path}${path.includes('?') ? '&' : '?'}pdf=${await pdfRenderToken(rt, path.split('?')[0])}`;
  return withBrowser(rt.env, async (b) => {
    const page = await b.newPage();
    try {
      await blockTrackers(page);
      const res = await page.goto(url, { waitUntil: 'networkidle0', timeout: 30_000 });
      if (!res || res.status() >= 400) throw new Error(`The page answered ${res ? res.status() : 'nothing'}`);
      await page.emulateMediaType?.('print');
      return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '16mm', bottom: '16mm', left: '14mm', right: '14mm' } });
    } finally {
      await page.close().catch(() => null);
    }
  });
}

/** The stored PDF at `key`, rendering `path` first when it isn't there yet. Returns a signed download link. */
export async function pdfLink(rt: Runtime, o: { key: string; path: string; name: string; ip?: string | null }) {
  const bucket = rt.env.RECORDINGS;
  if (!bucket) return null;
  const have = await bucket.head(o.key).catch(() => null);
  if (!have) {
    if (await overLimit(rt.env, `pdf:${o.ip ?? 'unknown'}`, PDF_RENDERS_PER_HOUR)) return null;
    const bytes = await renderPdf(rt, o.path);
    if (!bytes || !bytes.byteLength) return null;
    await bucket.put(o.key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  }
  return signedFileUrl(rt, o.key, PDF_LINK_TTL_MS, { name: o.name });
}

const fileName = (s: string) => s.replace(/[^A-Za-z0-9 ._-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document';

async function serve(c: Context<AppEnv>, back: string, o: { key: string; path: string; name: string }) {
  const rt = runtimeFrom(c);
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex, nofollow');
  if (!pdfEnabled(rt)) return c.redirect(back, 302);
  try {
    const link = await pdfLink(rt, { ...o, ip: c.req.header('cf-connecting-ip') ?? null });
    return c.redirect(link ?? back, 302);
  } catch (e) {
    await recordError(c.env, e, { kind: 'request', source: 'Download PDF', rt });
    return c.redirect(back, 302);
  }
}

/** GET /rooms/plan/:id/:ref/pdf: the attendee's Deal Plan as a PDF (same signed link as the page). */
export async function planPdfRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const { isRoomId } = await import('../rooms/rooms');
  const { checkPlanLink, getPlan } = await import('../rooms/engage-db');
  const id = c.req.param('id') ?? '';
  const ref = decodeURIComponent(c.req.param('ref') ?? '');
  const who = isRoomId(id) ? await checkPlanLink(rt, id, ref) : null;
  const plan = who ? await getPlan(rt, id, who) : null;
  if (!who || !plan) return c.notFound();
  const page = `/rooms/plan/${id}/${encodeURIComponent(ref)}`;
  const fp = (await sha256(`${who}|${JSON.stringify(plan.data)}|${plan.updatedAt}`)).slice(0, 24);
  return serve(c, page, { key: `pdf/plan/${id}/${fp}.pdf`, path: page, name: 'Deal Plan.pdf' });
}

/** GET /sign/:token/pdf: the signed agreement with its signing record, as a PDF. */
export async function contractPdfRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const token = c.req.param('token') ?? '';
  const { contractByToken } = await import('../sales/contracts');
  const k = /^[0-9a-f]{40}$/.test(token) ? await contractByToken(rt, token) : null;
  if (!k || k.status !== 'signed' || !k.body_html) return c.redirect(k ? `/sign/${k.token}` : '/', 302);
  const page = `/sign/${k.token}/copy`;
  const fp = (await sha256(`${k.id}|${k.doc_hash ?? ''}|${k.signed_at ?? ''}|${k.paid_at ? 1 : 0}`)).slice(0, 24);
  return serve(c, page, { key: `pdf/contracts/${k.id}/${fp}.pdf`, path: page, name: `${fileName(k.title)} (signed).pdf` });
}
