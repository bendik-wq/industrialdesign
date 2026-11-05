// Real Monid replies (test/fixtures/monid/*.json, saved from production runs, trimmed to a few items, the caller and
// owner ids replaced and CDN query strings dropped), plus the inspect and failed-input shapes Monid documents.
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const fs = node.getBuiltinModule('node:fs') as { readFileSync(p: string, enc: string): string };
const load = <T = Record<string, unknown>>(name: string): T => JSON.parse(fs.readFileSync(`${node.cwd()}/test/fixtures/monid/${name}`, 'utf8')) as T;

/** POST /v1/run → 202-style {runId, provider, endpoint, status: 'RUNNING', price (matrix), createdAt}. */
export const RUN_STARTED = load('run-started.json');
/** GET /v1/runs/:id, anyapi /youtube.search {query, sortBy: 'popular', route: 'giraffe'}: 4 videos. */
export const YT_SEARCH_RUN = load<{ output: { data: { videos: Record<string, unknown>[] } }; cost: { value: number } } & Record<string, unknown>>('youtube-search.json');
/** GET /v1/runs/:id, anyapi /tiktok.search_keyword {query}: 3 videos. */
export const TT_SEARCH_RUN = load<{ output: { data: { videos: Record<string, unknown>[] } } } & Record<string, unknown>>('tiktok-search.json');
/** GET /v1/runs/:id, apify /starvibe/youtube-video-transcript {youtube_url}: one row, 8 transcript segments. */
export const YT_TRANSCRIPT_RUN = load<{ output: Record<string, unknown>[] } & Record<string, unknown>>('youtube-transcript.json');
/** GET /v1/runs/:id, apify /curious_coder/facebook-ads-library-scraper: a video ad, a dynamic (catalogue) ad, an image ad. */
export const META_ADS_RUN = load<{ output: Record<string, unknown>[] } & Record<string, unknown>>('meta-ads.json');

/** GET /v1/runs/:id, anyapi /instagram.reels_search {query}: 3 reels. */
export const IG_SEARCH_RUN = load<{ output: { data: { reels: Record<string, unknown>[] } } } & Record<string, unknown>>('instagram-search.json');
/** GET /v1/runs/:id, anyapi /instagram.reel_transcript {url}: TIERED price, billed 65 units ($0.008), 6 segments. */
export const IG_TRANSCRIPT_RUN = load<{ output: { data: { items: Record<string, unknown>[] } }; price: unknown } & Record<string, unknown>>('instagram-transcript.json');

/** POST /v1/inspect in Monid's documented shape: the body schema under input.body, a route-priced matrix. */
export const INSPECT_ANYAPI_YT = {
  provider: 'anyapi', providerName: 'AnyAPI', endpoint: '/youtube.search', description: 'Search YouTube videos by keyword.', summary: 'YouTube search',
  method: 'POST', docUrl: 'https://docs.example/youtube.search', notes: ['sortBy popular needs the giraffe or badger route.'], tags: ['youtube'], categories: ['social'], metrics: {}, hints: {},
  input: { bodyType: 'json', body: { type: 'object', required: ['query'], properties: {
    query: { type: 'string' }, sortBy: { type: 'string', enum: ['relevance', 'popular'] }, uploadDate: { type: 'string', enum: ['today', 'this_week', 'this_month', 'this_year'] },
    route: { type: 'string', enum: ['lynx', 'badger', 'giraffe'] },
  } } },
  price: RUN_STARTED.price,
};
export const INSPECT_FB_ADS = {
  provider: 'apify', providerName: 'Apify', endpoint: '/curious_coder/facebook-ads-library-scraper', description: 'Facebook Ad Library scraper',
  input: { bodyType: 'json', body: { type: 'object', required: ['urls'], properties: { urls: { type: 'array', items: { type: 'object' } }, count: { type: 'integer' }, limitPerSource: { type: 'integer' } } } },
  price: { type: 'PER_RESULT', amount: { value: 0.00075, currency: 'USD' }, notes: ['Per-result price applies per query in the input.'] },
};

/** A run whose input the provider refused: COMPLETED, cost 0, providerResponse 400. */
export const FAILED_INPUT_RUN = {
  runId: 'run_bad', provider: 'anyapi', endpoint: '/youtube.search', status: 'COMPLETED', input: { body: { query: 'x', sortBy: 'popular' } },
  providerResponse: { httpStatus: 400, error: { error: 'source_unknown: sortBy popular is not available on route lynx', code: 'invalid_input' } },
  cost: { value: 0, currency: 'USD' }, resultCount: 0, billedUnits: 0, output: null,
};
