import type { Env } from '../env';

/**
 * Cloudflare Browser Rendering (binding BROWSER, @cloudflare/puppeteer), Cloudflare round builder D.
 * Used for Download PDF (src/infra/pdf.ts) and the funnel watchdog (src/infra/watchdog.ts).
 *
 * The binding is missing in `wrangler dev --local` and in tests: launchBrowser then answers null and every caller
 * falls back (no crash). Tests swap in a fake browser with setBrowserLauncher. Only the small part of the
 * puppeteer API the app uses is typed here, so a fake is easy to write.
 */
export interface PageResponse { status(): number }
export interface InterceptedRequest { url(): string; abort(): Promise<void> | void; continue(): Promise<void> | void; isInterceptResolutionHandled?(): boolean }
export interface PageLike {
  goto(url: string, o?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'; timeout?: number }): Promise<PageResponse | null>;
  pdf(o?: Record<string, unknown>): Promise<Uint8Array>;
  on(event: 'pageerror', fn: (e: unknown) => void): unknown;
  on(event: 'request', fn: (r: InterceptedRequest) => void): unknown;
  waitForSelector(selector: string, o?: { visible?: boolean; timeout?: number }): Promise<unknown>;
  setRequestInterception?(on: boolean): Promise<void>;
  setViewport?(v: { width: number; height: number; isMobile?: boolean; deviceScaleFactor?: number }): Promise<void>;
  setUserAgent?(ua: string): Promise<void>;
  emulateMediaType?(t: string | null): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserLike { newPage(): Promise<PageLike>; close(): Promise<void>; userAgent?(): Promise<string> }
export type BrowserLauncher = (env: Env) => Promise<BrowserLike | null>;

let override: BrowserLauncher | null = null;
/** Tests only: replace the real launcher (null restores it). */
export function setBrowserLauncher(fn: BrowserLauncher | null) { override = fn; }

/** Whether a browser can be launched here (the binding is bound, or a test launcher is set). */
export const browserAvailable = (env: Pick<Env, 'BROWSER'>) => Boolean(override || env.BROWSER);

/** A browser session, or null when Browser Rendering isn't available (local dev, tests, launch failure). */
export async function launchBrowser(env: Env): Promise<BrowserLike | null> {
  if (override) return override(env);
  if (!env.BROWSER) return null;
  try {
    const puppeteer = (await import('@cloudflare/puppeteer')).default;
    return (await puppeteer.launch(env.BROWSER as never)) as unknown as BrowserLike;
  } catch (e) {
    console.error('Browser Rendering launch failed', e instanceof Error ? e.message.slice(0, 200) : 'error');
    return null;
  }
}

/** Runs fn with a fresh browser and always closes it. null when no browser could be launched. */
export async function withBrowser<T>(env: Env, fn: (b: BrowserLike) => Promise<T>): Promise<T | null> {
  const b = await launchBrowser(env);
  if (!b) return null;
  try { return await fn(b); } finally { await b.close().catch(() => null); }
}

/** Third-party trackers never load in our own browser sessions (no pixels or analytics from a robot). */
export const TRACKER_RE = /facebook\.(net|com)|fbcdn|google-analytics|googletagmanager|doubleclick|posthog|clarity\.ms|tiktok|hotjar|cloudflareinsights/i;

export async function blockTrackers(page: PageLike) {
  if (!page.setRequestInterception) return;
  await page.setRequestInterception(true);
  page.on('request', (r: InterceptedRequest) => {
    if (r.isInterceptResolutionHandled?.()) return;
    void (TRACKER_RE.test(r.url()) ? r.abort() : r.continue());
  });
}
