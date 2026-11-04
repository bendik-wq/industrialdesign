// Radar test fixtures: rows shaped like the usual Apify actors' dataset items (field names and value styles as those
// actors return them), Monid discover / inspect / run replies, and analysis replies. Nothing here is real data.

export const NOW = Date.parse('2026-11-04T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400_000).toISOString();

/** streamers/youtube-scraper style rows. */
export const YOUTUBE_ROWS = [
  {
    title: 'How I Bought a $3M Business With No Money Down', id: 'aBcDeFgHiJ1', url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1',
    thumbnailUrl: 'https://i.ytimg.com/vi/aBcDeFgHiJ1/maxresdefault.jpg', viewCount: 1_240_000, date: daysAgo(20), likes: 41_000, commentsCount: 2_300,
    channelName: 'Deal Desk', channelUrl: 'https://www.youtube.com/@dealdesk', numberOfSubscribers: 85_000, duration: '00:14:32',
    text: 'The exact structure, step by step.', subtitles: [{ srt: '1\n00:00:00,000 --> 00:00:03,000\nI bought this company without a dollar of my own.\n\n2\n00:00:03,000 --> 00:00:06,000\nHere is the structure.', type: 'auto_generated', language: 'en' }],
  },
  {
    title: 'Seller financing explained', id: 'ZyXwVuTsRq2', url: 'https://www.youtube.com/watch?v=ZyXwVuTsRq2', viewCount: '48K', date: daysAgo(200),
    likes: '1.2K', commentsCount: 90, channelName: 'Deal Desk', numberOfSubscribers: 85_000, duration: 'PT8M5S',
  },
  { title: 'broken row with no id', viewCount: 5 },
];

/** clockworks/tiktok-scraper style rows. */
export const TIKTOK_ROWS = [
  {
    id: '7301234567890123456', text: 'Buying a business with seller financing #acquisition #business', createTime: Math.floor((NOW - 3 * 86400_000) / 1000),
    createTimeISO: daysAgo(3), authorMeta: { id: '6800000000000000001', name: 'ownerplays', nickName: 'Owner Plays', fans: 12_000 },
    webVideoUrl: 'https://www.tiktok.com/@ownerplays/video/7301234567890123456', videoMeta: { duration: 47, coverUrl: 'https://p16-sign.tiktokcdn.com/obj/cover1.jpeg' },
    diggCount: 52_000, shareCount: 8_100, playCount: 910_000, commentCount: 1_400, collectCount: 9_000,
  },
  { id: 'not-a-number', text: 'bad' },
];

/** apify/instagram-reel-scraper style rows. */
export const INSTAGRAM_ROWS = [
  {
    id: '3200000000000000001', shortCode: 'C1a2B3c4D5e', caption: 'The roll-up playbook in 60 seconds', url: 'https://www.instagram.com/reel/C1a2B3c4D5e/',
    commentsCount: 310, likesCount: 22_000, videoPlayCount: 640_000, videoViewCount: 410_000, ownerUsername: 'rollupguy', timestamp: daysAgo(10),
    videoDuration: 58.2, displayUrl: 'https://scontent.cdninstagram.com/v/t51/123.jpg', videoUrl: 'https://scontent.cdninstagram.com/v/t50/123.mp4',
  },
];

/** curious_coder/facebook-ads-library-scraper style rows. */
export const META_AD_ROWS = [
  {
    ad_archive_id: '1234567890123456', page_id: '100200300', page_name: 'Acquire Academy', is_active: true, collation_count: 9, collation_id: '555',
    start_date: Math.floor((NOW - 140 * 86400_000) / 1000), end_date: Math.floor(NOW / 1000), publisher_platform: ['FACEBOOK', 'INSTAGRAM'],
    snapshot: {
      body: { text: 'Most owners never buy their first company. Here is the 3-step method.' }, title: 'Buy a business without your savings', cta_text: 'Learn more',
      link_url: 'https://example.com/webinar', display_format: 'VIDEO', page_like_count: 48_000,
      videos: [{ video_hd_url: 'https://video.xx.fbcdn.net/v/t42/hd.mp4', video_sd_url: 'https://video.xx.fbcdn.net/v/t42/sd.mp4', video_preview_image_url: 'https://scontent.xx.fbcdn.net/v/t39/preview.jpg' }],
      images: [], cards: [],
    },
  },
  {
    adArchiveID: '9876543210987654', pageName: 'Small Biz Buyers', isActive: false, collationCount: 1, startDateFormatted: daysAgo(30), endDateFormatted: daysAgo(10),
    snapshot: { body: { text: 'Free training for business owners' }, cta_text: 'Sign up', images: [{ original_image_url: 'https://scontent.xx.fbcdn.net/v/t39/img.jpg' }] },
  },
];

/** A transcript tool's output: segments with start times. */
export const TRANSCRIPT_OUTPUT = [{ url: 'https://www.youtube.com/watch?v=aBcDeFgHiJ1', transcript: [{ text: 'I bought this company without a dollar of my own.', start: 0.2, duration: 3 }, { text: 'Here is the structure.', start: 72.5, duration: 2 }] }];

/** Monid discover replies in two different wrappers. */
export const DISCOVER_A = { results: [
  { provider: 'apify', endpoint: '/streamers/youtube-scraper', description: 'Scrape YouTube search results', price: { type: 'PER_RESULT', amount: 0.005, currency: 'USD' } },
  { provider: 'apify', endpoint: '/someone/youtube-comments', description: 'Comments' },
] };
export const DISCOVER_B = { data: { tools: [{ tool: { provider: { id: 'apify' }, path: 'clockworks~tiktok-scraper', title: 'TikTok Scraper' }, pricing: { perResult: 0.004 } }] } };

export const INSPECT_YT = {
  id: 'tool_1', provider: 'apify', providerName: 'Apify', endpoint: '/streamers/youtube-scraper', description: 'YouTube scraper', summary: 'Search and video details',
  inputSchema: { type: 'object', required: ['searchQueries'], properties: {
    searchQueries: { type: 'array', items: { type: 'string' } }, maxResults: { type: 'integer', default: 10 }, maxResultsShorts: { type: 'integer' },
    dateFilter: { type: 'string', enum: ['hour', 'today', 'week', 'month', 'year'] }, sortingOrder: { type: 'string', enum: ['relevance', 'rating', 'date', 'views'] },
    downloadSubtitles: { type: 'boolean', default: false },
  } },
  docUrl: 'https://apify.com/streamers/youtube-scraper', price: { type: 'PER_RESULT', amount: 5000, flatFee: 0, currency: 'MICRO_DOLLAR' },
};
export const INSPECT_ADS = {
  provider: 'apify', endpoint: '/curious_coder/facebook-ads-library-scraper',
  inputSchema: { type: 'object', required: ['urls'], properties: { urls: { type: 'array', editor: 'requestListSources' }, count: { type: 'integer' }, 'scrapePageAds.activeStatus': { type: 'string' } } },
  price: { type: 'PER_RESULT', amount: 0.00075, currency: 'USD' },
};

const s = (x: string) => x;
/** A clean analysis reply for a video. */
export const ANALYSIS_VIDEO = {
  summary: 'A founder walks through buying a company with seller finance.',
  hook: { text: 'I bought this company without a dollar of my own.', why: 'A result first, stated plainly, with a gap the viewer wants closed.', type: 'result' },
  beats: [{ t: '0:00', label: 'Result first', what: 'States the outcome.' }, { t: '1:12', label: 'The structure', what: 'Draws the stack.' }],
  drop_offs: [{ t: '4:30', why: 'A long definition with no new tension.' }],
  cta: 'Subscribe for part two.',
  pattern: 'Outcome first, then the mechanism as a diagram, then the proof.',
  format: 'Talking head with a whiteboard',
  topic: 'seller financing',
  for_gl: {
    apply: s('Open on Josh\'s two acquisitions, both 100% seller financed, then draw the stack: commercial debt, seller finance and seller rollover, tested at 1.5x.'),
    hook: 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.',
    angles: ['The order that gets a deal funded: seller first, then the lender', 'Why banks reject structures, not buyers', 'The 1.5x test before any offer'],
    layouts: [{ beat: 'Hook', layout: 'cinema' }, { beat: 'The stack', layout: 'split' }, { beat: 'Close', layout: 'hologram' }],
  },
};
/** The same with a G&L part that breaks the copy rules (hedge, free call, funding without rollover). */
export const ANALYSIS_BAD = {
  ...ANALYSIS_VIDEO,
  for_gl: { ...ANALYSIS_VIDEO.for_gl, apply: 'This might work with seller finance and a free strategy call.', angles: ['You could potentially buy three companies'] },
};
export const ANALYSIS_AD = {
  summary: 'A webinar ad for first-time buyers.', hook: { text: 'Most owners never buy their first company.', why: 'Calls out the reader and names a gap.', type: 'problem' },
  offer: 'A free webinar', format: 'Video, talking head', angle: 'Fear of staying small', cta: 'Learn more', landing_promise: 'A 3-step method',
  pattern: 'Runs 140 days with 9 variants: the angle keeps working.', topic: 'first acquisition',
  for_gl: { how_we_run: 'A face-cam ad from Josh on buying a competitor with seller finance and seller rollover, sending owners to the masterclass.', hook: 'Banks don\'t reject buyers. They reject structures.', angles: ['Buyer, not the add-on', 'Seller first, lender second', 'The 1.5x test'], layouts: [{ beat: 'Hook', layout: 'vertical' }] },
};
