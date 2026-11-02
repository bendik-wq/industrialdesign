/**
 * Versioned asset URLs (cache-busting). Every HTML response the Worker sends has its `/assets/*.js` and
 * `/assets/*.css` references rewritten to `/assets/x.js?v=<build id>`, so a new deploy always makes browsers and
 * the edge fetch the new files instead of a stale copy. `/assets/*` itself is still served straight from static
 * assets (wrangler.jsonc run_worker_first excludes it); the query string only changes the cache key.
 *
 * The build id, in order of preference:
 *  1. `__BUILD_ID__`, substituted at build time by `npm run deploy` (scripts/deploy.mjs: git hash + UTC time);
 *  2. the deployed Worker version id (the CF_VERSION_METADATA binding), so a plain `wrangler deploy` is busted too;
 *  3. the time this isolate started (local dev and tests).
 */
declare const __BUILD_ID__: string | undefined;

const BOOT = Date.now().toString(36);

export interface VersionMetadata { id?: string; tag?: string; timestamp?: string }

export function buildId(env?: { CF_VERSION_METADATA?: VersionMetadata } | null): string {
  const defined = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : '';
  if (defined && /^[\w.-]{1,64}$/.test(defined)) return defined;
  const v = env?.CF_VERSION_METADATA?.id;
  if (v && /^[\w-]{4,64}$/.test(v)) return v.replace(/-/g, '').slice(0, 12);
  return BOOT;
}

/** `/assets/app.js` → `/assets/app.js?v=<build>`. Anything else (other paths, other file types, already versioned) is left alone. */
export function versionedAssetUrl(url: string, build: string): string {
  if (!url || !build) return url;
  const m = /^(\/assets\/[^?#]+\.(?:js|mjs|css))(\?[^#]*)?(#.*)?$/.exec(url);
  if (!m) return url;
  const [, path, query = '', hash = ''] = m;
  if (/[?&]v=/.test(query)) return url;
  return `${path}${query ? `${query}&` : '?'}v=${encodeURIComponent(build)}${hash}`;
}

/**
 * Rewrites the asset references of an HTML response. Streams (HTMLRewriter), so nothing is buffered.
 * Non-HTML responses, and runtimes without HTMLRewriter (unit tests), pass through unchanged.
 */
export function versionAssets(res: Response, build: string): Response {
  if (typeof HTMLRewriter === 'undefined' || !res.body) return res;
  if (!/^text\/html/i.test(res.headers.get('content-type') ?? '')) return res;
  const attr = (name: string) => ({
    element: (el: Element) => {
      const v = el.getAttribute(name);
      if (!v) return;
      const next = versionedAssetUrl(v, build);
      if (next !== v) el.setAttribute(name, next);
    },
  });
  return new HTMLRewriter()
    .on('script[src^="/assets/"]', attr('src'))
    .on('link[href^="/assets/"]', attr('href'))
    .transform(res);
}
