/**
 * Radar: what each tool returns, normalised into one item shape, and the outlier score.
 * Field names follow what Monid's tools return: AnyAPI /youtube.search ({data: {videos: [{id, title, url, channel,
 * authorId, createdUtc, image, lengthText, views}]}}), AnyAPI /tiktok.search_keyword ({data: {videos: [{id, author,
 * authorFollowers, caption, views, likes, comments, shares, createdUtc, durationSeconds, image}]}}), Apify
 * starvibe/youtube-video-transcript ([{video_id, view_count, like_count, comment_count, subscriber_count, transcript}]),
 * Apify curious_coder/facebook-ads-library-scraper ([{ad_archive_id, collation_count, start_date, snapshot}]), plus the
 * usual Apify actors' variants; anything unknown is ignored, never trusted.
 * Platform video files are never downloaded or re-hosted: we keep the platform's own URL, embed URL and thumbnail.
 */
import type { Platform } from './sources';

export interface RadarItem {
  id: string; platform: Platform; external_id: string; url: string | null; author: string | null; author_id: string | null;
  title: string | null; caption: string | null; published_at: string | null; duration_s: number | null;
  views: number | null; likes: number | null; comments: number | null; shares: number | null; followers: number | null;
  thumbnail_url: string | null; embed_url: string | null; media_url: string | null; media_kind: 'image' | 'video' | null;
  ad_start: string | null; ad_end: string | null; ad_active: number | null; ad_active_days: number | null; ad_variants: number | null;
  ad_cta: string | null; ad_link: string | null; ad_platforms: string | null;
  captions: string | null; // a transcript or subtitles found in the scraper output
  /** Radar v2. Text posts (X, LinkedIn, Reddit, Substack): the full text, which is also their transcript. */
  body_text: string | null;
  bookmarks: number | null; saves: number | null; reposts: number | null;
  /** Reddit: the subreddit. Substack: the publication host. */
  source_ref: string | null;
  raw: Record<string, unknown>;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown, n = 2000): string | null => {
  if (typeof v === 'string') { const t = v.trim(); return t ? t.slice(0, n) : null; }
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return null;
};
/** "1.2M", "12,345", "3.4K views" or a number. */
export function count(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').trim().match(/^([\d.]+)\s*([kmb])?/i);
  if (!m) return null;
  const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase() as 'k'] ?? 1);
  return isFinite(n) ? Math.round(n) : null;
}
const first = (...v: unknown[]) => { for (const x of v) if (x !== undefined && x !== null && x !== '') return x; return null; };
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((a, k) => (isObj(a) ? a[k] : Array.isArray(a) && /^\d+$/.test(k) ? a[Number(k)] : undefined), o);
/** A time from ISO text, a date, or unix seconds / milliseconds. */
export function isoTime(v: unknown): string | null {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}$/.test(v))) {
    const n = Number(v);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof v === 'string') { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
  return null;
}
/** "PT12M3S", "12:03", "1:02:03" or seconds. */
export function seconds(v: unknown): number | null {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const iso = v.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/i);
  if (iso) return (Number(iso[1] || 0) * 3600) + (Number(iso[2] || 0) * 60) + Number(iso[3] || 0);
  if (/^\d+(:\d{1,2}){1,2}$/.test(v.trim())) return v.trim().split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
  return isFinite(Number(v)) ? Number(v) : null;
}
const safeUrl = (v: unknown): string | null => { const u = s(v, 2000); return u && /^https:\/\//i.test(u) ? u : null; };

export const youtubeId = (url: string | null): string | null => {
  if (!url) return null;
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
};
export const youtubeEmbed = (id: string) => `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?rel=0&modestbranding=1`;
export const tiktokEmbed = (id: string) => `https://www.tiktok.com/embed/v2/${encodeURIComponent(id)}`;

/** Subtitles or a transcript carried in a scraper's output, as plain text. */
export function captionsFrom(raw: Record<string, unknown>): string | null {
  const t = first(raw.transcript, raw.transcriptText, raw.captions, raw.subtitles, raw.subtitlesText);
  if (typeof t === 'string') return t.trim().slice(0, 60_000) || null;
  if (Array.isArray(t)) {
    const parts = t.map((x) => (typeof x === 'string' ? x : isObj(x) ? s(x.srt, 60_000) ?? s(x.text, 4000) ?? s(x.plaintext, 60_000) : null)).filter(Boolean) as string[];
    const txt = parts.join('\n').replace(/^\d+\s*$/gm, '').replace(/^\d\d:\d\d:\d\d[,.]\d+ --> .*$/gm, '').replace(/\n{2,}/g, '\n').trim();
    return txt ? txt.slice(0, 60_000) : null;
  }
  return null;
}

function base(platform: Platform, id: string, raw: Record<string, unknown>): RadarItem {
  return {
    id: `${platform}:${id}`, platform, external_id: id, url: null, author: null, author_id: null, title: null, caption: null, published_at: null,
    duration_s: null, views: null, likes: null, comments: null, shares: null, followers: null, thumbnail_url: null, embed_url: null,
    media_url: null, media_kind: null, ad_start: null, ad_end: null, ad_active: null, ad_active_days: null, ad_variants: null,
    ad_cta: null, ad_link: null, ad_platforms: null, captions: null, body_text: null, bookmarks: null, saves: null, reposts: null, source_ref: null, raw,
  };
}

/** The longest body_text kept (a long Substack essay fits; D1 rows stay well under their limit). */
export const BODY_MAX = 200_000;
const body = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  return t ? t.slice(0, BODY_MAX) : null;
};
const firstLine = (t: string | null, n = 200) => (t ? t.split('\n').map((x) => x.trim()).find(Boolean)?.slice(0, n) ?? null : null);

/**
 * X (AnyAPI /twitter.search): {id, url, text, likeCount, retweetCount, replyCount, quoteCount, bookmarkCount, viewCount,
 * authorUsername, authorName, authorId, authorFollowers, createdUtc, isReply, media: [{type, url}]}. Replies are left
 * out (the search asks for top posts; a reply is no format). Reposts count retweets and quotes.
 */
export function normaliseX(r: Record<string, unknown>): RadarItem | null {
  const id = s(first(r.id, r.tweetId, r.rest_id), 30);
  if (!id || !/^\d{5,25}$/.test(id)) return null;
  if (r.isReply === true || r.isRetweet === true) return null;
  const it = base('x', id, r);
  const user = s(first(r.authorUsername, r.username, get(r, 'author.username')), 60);
  it.url = safeUrl(r.url) ?? (user ? `https://x.com/${user}/status/${id}` : `https://x.com/i/web/status/${id}`);
  it.body_text = body(first(r.text, r.fullText, r.full_text));
  it.caption = it.body_text ? it.body_text.slice(0, 4000) : null;
  it.title = firstLine(it.body_text);
  it.author = user ?? s(r.authorName, 100);
  it.author_id = s(first(r.authorId, get(r, 'author.id')), 40);
  it.published_at = isoTime(first(r.createdUtc, r.createdAt, r.created_at));
  it.views = count(first(r.viewCount, r.views));
  it.likes = count(first(r.likeCount, r.favoriteCount, r.likes));
  it.comments = count(first(r.replyCount, r.replies));
  const rt = count(first(r.retweetCount, r.retweets)); const qt = count(first(r.quoteCount, r.quotes));
  it.reposts = rt == null && qt == null ? null : (rt ?? 0) + (qt ?? 0);
  it.bookmarks = count(first(r.bookmarkCount, r.bookmarks));
  it.followers = count(first(r.authorFollowers, get(r, 'author.followers')));
  const media = Array.isArray(r.media) ? r.media.filter(isObj) : [];
  const m0 = media[0];
  if (m0) {
    const video = /video|gif/i.test(String(m0.type ?? ''));
    // The image (or a video's preview image) only; never the video file.
    const image = (v: unknown) => { const u = safeUrl(v); return u && (/\.(jpe?g|png|webp)(\?|$)/i.test(u) || /thumb/i.test(u)) ? u : null; };
    it.thumbnail_url = video ? image(first(m0.previewUrl, m0.thumbnailUrl, m0.preview_image_url)) ?? image(m0.url) : safeUrl(first(m0.url, m0.mediaUrl));
    it.media_kind = video ? 'video' : 'image';
    it.media_url = video ? null : it.thumbnail_url;
    it.duration_s = video ? seconds(first(m0.durationSeconds, m0.duration_ms != null ? Number(m0.duration_ms) / 1000 : null)) : null;
  }
  return it;
}

/** LinkedIn (AnyAPI /linkedin.search_posts): {id, url, text, authorName, authorUrl, reactionCount, commentCount, createdUtc}. */
export function normaliseLinkedIn(r: Record<string, unknown>): RadarItem | null {
  const id = s(first(r.id, r.urn, r.activityId), 60)?.replace(/^urn:li:activity:/, '') ?? null;
  if (!id || !/^[\w:-]{5,60}$/.test(id)) return null;
  const it = base('linkedin', id, r);
  it.url = safeUrl(first(r.url, r.postUrl)) ?? `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;
  it.body_text = body(first(r.text, r.commentary, r.content));
  it.caption = it.body_text ? it.body_text.slice(0, 4000) : null;
  it.title = firstLine(it.body_text);
  it.author = s(first(r.authorName, get(r, 'author.name')), 200);
  it.author_id = s(first(r.authorUrl, get(r, 'author.url'), r.authorId), 300);
  it.published_at = isoTime(first(r.createdUtc, r.postedAt, r.createdAt));
  it.likes = count(first(r.reactionCount, r.reactions, r.likeCount));
  it.comments = count(first(r.commentCount, r.comments));
  it.reposts = count(first(r.repostCount, r.shareCount, r.reposts));
  it.followers = count(first(r.authorFollowers, get(r, 'author.followers')));
  return it;
}

/**
 * Reddit (AnyAPI /reddit.search and subreddit posts): {id, title, selftext, author, authorId, subreddit, score,
 * numComments, permalink, url, createdUtc, nsfw}. NSFW posts are left out. The score (upvotes) counts as likes.
 */
export function normaliseReddit(r: Record<string, unknown>): RadarItem | null {
  const id = s(first(r.id, r.name), 20)?.replace(/^t3_/, '') ?? null;
  if (!id || !/^[a-z0-9]{4,12}$/i.test(id)) return null;
  if (r.nsfw === true || r.over_18 === true) return null;
  const it = base('reddit', id, r);
  const perma = s(r.permalink, 600);
  it.url = perma && perma.startsWith('/r/') ? `https://www.reddit.com${perma}` : safeUrl(r.url);
  it.title = s(r.title, 300);
  const self = body(first(r.selftext, r.body, r.text));
  it.body_text = body([it.title, self].filter(Boolean).join('\n\n'));
  it.caption = self ? self.slice(0, 4000) : null;
  it.author = s(r.author, 100);
  it.author_id = s(first(r.authorId, r.author_fullname), 60);
  it.source_ref = s(first(r.subreddit, r.subredditName), 40);
  it.published_at = isoTime(first(r.createdUtc, r.created_utc, r.created));
  it.likes = count(first(r.score, r.ups, r.upvotes));
  it.comments = count(first(r.numComments, r.num_comments, r.comments));
  it.followers = count(first(r.subredditSubscribers, r.subreddit_subscribers));
  const thumb = safeUrl(first(r.thumbnail, r.previewImage));
  it.thumbnail_url = thumb;
  return it;
}

/**
 * Substack (AnyAPI /substack.posts): {postId, title, subtitle, description, text, markdown, url, reactionCount,
 * commentCount, restackCount, wordcount, createdUtc, image, isPaid, contentStatus, publication: {name, subdomain,
 * customDomain, url}, authorName}. The author is the publication (posts rank against their publication's median).
 */
export function normaliseSubstack(r: Record<string, unknown>): RadarItem | null {
  const id = s(first(r.postId, r.id), 30);
  if (!id || !/^[\w-]{2,30}$/.test(id)) return null;
  const it = base('substack', id, r);
  const pub = isObj(r.publication) ? r.publication : {};
  it.url = safeUrl(r.url);
  it.title = s(r.title, 300);
  it.caption = s(first(r.subtitle, r.description), 1000);
  it.body_text = body(first(r.text, r.markdown, r.bodyText));
  const pubUrl = safeUrl(first(pub.url, pub.customDomain ? `https://${String(pub.customDomain)}` : null, pub.subdomain ? `https://${String(pub.subdomain)}.substack.com` : null, it.url));
  it.source_ref = pubUrl ? new URL(pubUrl).hostname.toLowerCase() : null;
  it.author = s(first(pub.name, r.authorName), 200);
  it.author_id = it.source_ref ?? s(first(pub.subdomain, r.authorHandle), 100);
  it.published_at = isoTime(first(r.createdUtc, r.postDate, r.post_date));
  it.likes = count(first(r.reactionCount, r.reactions, r.likes));
  it.comments = count(first(r.commentCount, r.comments));
  it.reposts = count(first(r.restackCount, r.restacks));
  it.thumbnail_url = safeUrl(first(r.image, r.coverImage, r.cover_image));
  return it;
}

/** The next page's cursor in a run's output (AnyAPI: data.nextCursor), or null on the last page. */
export function nextCursorOf(output: unknown): string | null {
  const o = isObj(output) ? output : null;
  if (!o) return null;
  const c = first(get(o, 'data.nextCursor'), o.nextCursor, get(o, 'data.next_cursor'), o.next_cursor);
  return typeof c === 'string' && c.trim() ? c.trim().slice(0, 400) : null;
}

export function normaliseYouTube(r: Record<string, unknown>): RadarItem | null {
  const url = safeUrl(first(r.url, r.videoUrl, r.link));
  const id = s(first(r.id, r.videoId, r.video_id), 40) ?? youtubeId(url);
  if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return null;
  const it = base('youtube', id, r);
  it.url = url ?? `https://www.youtube.com/watch?v=${id}`;
  it.title = s(r.title, 300);
  it.caption = s(first(r.text, r.description), 4000);
  it.author = s(first(r.channelName, r.channelTitle, r.channel_name, typeof r.channel === 'string' ? r.channel : get(r, 'channel.name'), typeof r.author === 'string' ? r.author : null), 200);
  it.author_id = s(first(r.channelId, r.channel_id, r.authorId, r.channelUrl, get(r, 'channel.id')), 200);
  it.published_at = isoTime(first(r.createdUtc, r.date, r.uploadDate, r.publishedAt, r.published_at, r.publishDate, r.timestamp));
  it.duration_s = seconds(first(r.duration, r.lengthSeconds, r.durationSeconds, r.duration_seconds, r.lengthText));
  it.views = count(first(r.viewCount, r.views, r.view_count));
  it.likes = count(first(r.likes, r.likeCount, r.like_count));
  it.comments = count(first(r.commentsCount, r.commentCount, r.comment_count, r.comments));
  it.followers = count(first(r.numberOfSubscribers, r.subscriberCount, r.subscriber_count, r.channelSubscribers, get(r, 'channel.subscribers')));
  it.thumbnail_url = safeUrl(first(r.thumbnailUrl, r.thumbnail, r.image, get(r, 'thumbnails.0.url'))) ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  it.embed_url = youtubeEmbed(id);
  it.captions = captionsFrom(r);
  return it;
}

export function normaliseTikTok(r: Record<string, unknown>): RadarItem | null {
  const id = s(first(r.id, r.videoId, r.aweme_id), 40);
  if (!id || !/^\d{6,25}$/.test(id)) return null;
  const it = base('tiktok', id, r);
  const author = isObj(r.authorMeta) ? r.authorMeta : isObj(r.author) ? r.author : {};
  const video = isObj(r.videoMeta) ? r.videoMeta : isObj(r.video) ? r.video : {};
  const stats = isObj(r.stats) ? r.stats : {};
  // AnyAPI: author is the handle (the one in the URL) and authorName the display name.
  const handle = s(first(typeof r.author === 'string' ? r.author : null, author.name, author.uniqueId, author.username), 100);
  it.url = safeUrl(first(r.webVideoUrl, r.url, r.shareUrl)) ?? (handle ? `https://www.tiktok.com/@${handle}/video/${id}` : null);
  it.caption = s(first(r.text, r.caption, r.desc, r.description), 4000);
  it.title = it.caption ? it.caption.split('\n')[0].slice(0, 200) : null;
  it.author = handle ?? s(first(author.nickName, r.authorName), 100);
  it.author_id = s(first(author.id, author.secUid, r.authorUserId), 100);
  it.published_at = isoTime(first(r.createTimeISO, r.createdUtc, r.createTime, r.create_time));
  it.duration_s = seconds(first(video.duration, r.durationSeconds, r.duration));
  it.views = count(first(r.playCount, stats.playCount, r.plays, r.views));
  it.likes = count(first(r.diggCount, stats.diggCount, r.likes));
  it.comments = count(first(r.commentCount, stats.commentCount, r.comments));
  it.shares = count(first(r.shareCount, stats.shareCount, r.shares));
  it.followers = count(first(author.fans, author.followerCount, get(r, 'authorStats.followerCount'), r.authorFollowers));
  // Never the video file itself (videoUrl): only the cover.
  it.thumbnail_url = safeUrl(first(video.coverUrl, video.originalCoverUrl, video.cover, r.cover, r.image));
  it.embed_url = tiktokEmbed(id);
  it.captions = captionsFrom(r);
  return it;
}

export function normaliseInstagram(r: Record<string, unknown>): RadarItem | null {
  const code = s(first(r.shortCode, r.shortcode, r.code), 40);
  const id = s(first(r.id, r.pk), 40) ?? code;
  if (!id) return null;
  const it = base('instagram', id, r);
  it.url = safeUrl(r.url) ?? (code ? `https://www.instagram.com/reel/${code}/` : null);
  it.caption = s(r.caption, 4000);
  it.title = it.caption ? it.caption.split('\n')[0].slice(0, 200) : null;
  // AnyAPI reels: username, userId, views, likes, comments, reshares, createdUtc, durationSeconds, thumbnail (never videoUrl).
  it.author = s(first(r.ownerUsername, r.username, get(r, 'owner.username')), 100);
  it.author_id = s(first(r.ownerId, r.userId, get(r, 'owner.id')), 100);
  it.published_at = isoTime(first(r.timestamp, r.createdUtc, r.takenAt, r.taken_at));
  it.duration_s = seconds(first(r.videoDuration, r.durationSeconds));
  it.views = count(first(r.videoPlayCount, r.videoViewCount, r.playCount, r.plays, r.views));
  it.likes = count(first(r.likesCount, r.likeCount, r.likes));
  it.comments = count(first(r.commentsCount, r.comments));
  it.shares = count(first(r.reshares, r.sharesCount, r.shares));
  it.followers = count(first(r.ownerFollowersCount, get(r, 'owner.followersCount'), r.followers));
  it.thumbnail_url = safeUrl(first(r.displayUrl, r.thumbnailUrl, r.thumbnail));
  it.captions = captionsFrom(r);
  return it;
}

const DAY = 86400_000;
export function normaliseMetaAd(r: Record<string, unknown>, now = Date.now()): RadarItem | null {
  const id = s(first(r.ad_archive_id, r.adArchiveID, r.adArchiveId, r.adId, r.id), 40);
  if (!id || !/^\d{5,25}$/.test(id)) return null;
  const it = base('meta_ads', id, r);
  const snap = isObj(r.snapshot) ? r.snapshot : {};
  // Dynamic (catalogue) ads carry placeholders like {{product.name}}: those are no copy, so the cards' text is used.
  const real = (v: string | null) => (v && !/\{\{[^}]+\}\}/.test(v) ? v : null);
  const body = real(isObj(snap.body) ? s(snap.body.text, 4000) : s(first(snap.body, r.adText, r.body), 4000));
  const cards = Array.isArray(snap.cards) ? snap.cards.filter(isObj) : [];
  const videos = Array.isArray(snap.videos) ? snap.videos.filter(isObj) : [];
  const images = Array.isArray(snap.images) ? snap.images.filter(isObj) : [];
  const c0 = cards[0] ?? {};
  it.url = safeUrl(r.ad_library_url) ?? `https://www.facebook.com/ads/library/?id=${id}`;
  it.author = s(first(r.page_name, r.pageName, snap.page_name, get(r, 'pageInfo.name')), 200);
  it.author_id = s(first(r.page_id, r.pageId, snap.page_id), 60);
  it.caption = body ?? real(cards.map((c) => s(c.body, 4000)).find((x) => real(x)) ?? null) ?? real(s(snap.link_description, 4000));
  it.title = [snap.title, c0.title, snap.link_description].map((x) => real(s(x, 300))).find(Boolean) ?? (it.caption ? it.caption.split('\n')[0].slice(0, 200) : null);
  const vid = videos[0] ?? (cards.find((c) => c.video_hd_url || c.video_sd_url) as Record<string, unknown> | undefined);
  const img = images[0] ?? (cards.find((c) => c.original_image_url || c.resized_image_url) as Record<string, unknown> | undefined);
  if (vid) {
    it.media_url = safeUrl(first(vid.video_hd_url, vid.video_sd_url, vid.videoHdUrl, vid.videoSdUrl));
    it.media_kind = it.media_url ? 'video' : null;
    it.thumbnail_url = safeUrl(first(vid.video_preview_image_url, vid.videoPreviewImageUrl));
  }
  if (!it.media_url && img) {
    it.media_url = safeUrl(first(img.original_image_url, img.resized_image_url, img.originalImageUrl, img.resizedImageUrl));
    it.media_kind = it.media_url ? 'image' : null;
  }
  it.thumbnail_url = it.thumbnail_url ?? (it.media_kind === 'image' ? it.media_url : null) ?? safeUrl(first(snap.page_profile_picture_url, r.pageProfilePictureUrl));
  it.ad_start = isoTime(first(r.start_date, r.startDate, r.startDateFormatted, r.ad_delivery_start_time));
  // For an ad still running, end_date is the last day Meta saw it deliver (about yesterday), not a stop.
  it.ad_end = isoTime(first(r.end_date, r.endDate, r.endDateFormatted, r.ad_delivery_stop_time));
  const active = first(r.is_active, r.isActive);
  it.ad_active = active == null ? null : active ? 1 : 0;
  if (it.ad_start) {
    const end = it.ad_active === 0 && it.ad_end ? Date.parse(it.ad_end) : now;
    it.ad_active_days = Math.max(0, Math.round((end - Date.parse(it.ad_start)) / DAY));
  }
  it.ad_variants = count(first(r.collation_count, r.collationCount, r.ads_count, r.adsCount)) ?? 1;
  it.ad_cta = s(first(snap.cta_text, c0.cta_text, r.ctaText), 80);
  it.ad_link = safeUrl(first(snap.link_url, c0.link_url, r.linkUrl));
  const pubs = first(r.publisher_platform, r.publisherPlatform, r.publisher_platforms);
  it.ad_platforms = Array.isArray(pubs) ? pubs.map(String).join(', ').toLowerCase() : s(pubs, 200);
  it.followers = count(first(snap.page_like_count, r.pageLikeCount, get(r, 'pageInfo.likes')));
  it.published_at = it.ad_start;
  return it;
}

/** The array of results inside a run's output, whatever the wrapper. */
export function outputRows(output: unknown): Record<string, unknown>[] {
  if (Array.isArray(output)) return output.filter(isObj);
  if (isObj(output)) {
    for (const k of ['items', 'results', 'data', 'output', 'dataset', 'ads', 'videos', 'reels', 'posts']) {
      const v = output[k];
      if (Array.isArray(v)) return v.filter(isObj);
      if (isObj(v)) { const inner = outputRows(v); if (inner.length) return inner; }
    }
    return [output];
  }
  return [];
}

export function normalise(platform: Platform, output: unknown, now = Date.now()): RadarItem[] {
  const fn = {
    youtube: normaliseYouTube, tiktok: normaliseTikTok, instagram: normaliseInstagram, meta_ads: (r: Record<string, unknown>) => normaliseMetaAd(r, now),
    x: normaliseX, linkedin: normaliseLinkedIn, reddit: normaliseReddit, substack: normaliseSubstack,
  }[platform];
  const out = new Map<string, RadarItem>();
  for (const r of outputRows(output)) {
    try { const it = fn(r); if (it && !out.has(it.id)) out.set(it.id, it); } catch { /* one bad row never stops the rest */ }
  }
  return [...out.values()];
}

/** WebVTT or SRT subtitles as plain text (cue numbers, timings and the header dropped); other text unchanged. */
export function subtitleText(t: string): string {
  if (!/-->/.test(t)) return t.trim();
  return t.replace(/^WEBVTT.*$/m, '').replace(/^(NOTE|STYLE|Kind:|Language:).*$/gm, '').replace(/^\d+\s*$/gm, '')
    .replace(/^[\d:.,]+ --> .*$/gm, '').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim();
}

/** The longest transcript kept (the full text of a long video). */
export const TRANSCRIPT_MAX = 400_000;
export interface Segment { start: number; end: number | null; text: string }
/** A transcript run's timed segments ({start, end, text}), when the tool gave timings; [] otherwise. */
export function transcriptSegments(output: unknown): Segment[] {
  const out: Segment[] = [];
  for (const r of outputRows(output)) {
    const arr = first(r.transcript, r.segments, r.captions, r.subtitles);
    const list = Array.isArray(arr) ? arr : 'text' in r && 'start' in r ? [r] : [];
    for (const x of list) {
      if (!isObj(x)) continue;
      const text = s(first(x.text, x.snippet, x.caption), 2000);
      const st = seconds(first(x.start, x.offset, x.startTime, x.start_time, x.startMs != null ? Number(x.startMs) / 1000 : null));
      if (!text || st == null) continue;
      const dur = seconds(first(x.duration, x.dur));
      const en = seconds(first(x.end, x.endTime, x.end_time, x.endMs != null ? Number(x.endMs) / 1000 : null)) ?? (dur != null ? st + dur : null);
      out.push({ start: Math.round(st * 100) / 100, end: en == null ? null : Math.round(en * 100) / 100, text });
      if (out.length >= 5000) return out;
    }
  }
  return out;
}

/** A transcript run's output as text, with [m:ss] marks when the tool gave timings. */
export function transcriptText(output: unknown): string | null {
  const rows = outputRows(output);
  const lines: string[] = [];
  const mark = (t: number) => `[${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}]`;
  const segs = (arr: unknown[]) => {
    for (const x of arr) {
      if (!isObj(x)) { if (typeof x === 'string') lines.push(x); continue; }
      const text = s(first(x.text, x.snippet, x.caption), 2000);
      if (!text) continue;
      const st = seconds(first(x.start, x.offset, x.startTime, x.start_time, x.startMs != null ? Number(x.startMs) / 1000 : null));
      lines.push(st != null ? `${mark(st)} ${text}` : text);
    }
  };
  for (const r of rows) {
    const arr = first(r.transcript, r.segments, r.captions, r.data, r.subtitles);
    if (Array.isArray(arr)) segs(arr);
    else if (typeof arr === 'string') lines.push(subtitleText(arr));
    else if ('text' in r && 'start' in r) segs([r]);
    else { const c = captionsFrom(r); if (c) lines.push(c); else if (typeof r.text === 'string') lines.push(r.text); }
  }
  const txt = lines.join('\n').trim();
  return txt ? txt.slice(0, TRANSCRIPT_MAX) : null;
}

// ───────────── scoring ─────────────

export interface ScoreParts {
  ratio: number | null; ratio_basis: 'followers' | 'source' | 'author' | 'platform' | null; velocity: number | null; engagement: number | null;
  days_active: number | null; variants: number | null; score: number;
  /** Radar v2: what the ratio and velocity count (views on video platforms, weighted interactions on text ones). */
  metric?: 'views' | 'interactions'; interactions?: number | null;
}
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const median = (xs: number[]) => { if (!xs.length) return 0; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

/** Platforms whose ratio is on interactions: their reach is not public (or, on X, the feed follows followers). */
export const INTERACTION_PLATFORMS = new Set(['x', 'linkedin', 'reddit', 'substack']);
/** Platforms ranked against their source (the subreddit, the publication) before anything else. */
export const SOURCE_PLATFORMS = new Set(['reddit', 'substack']);
/** X: the share of followers a typical post engages (1%), so a ratio of 1 is an ordinary post. */
export const X_ENGAGEMENT_RATE = 0.01;

type Scorable = Pick<RadarItem, 'platform' | 'views' | 'likes' | 'comments' | 'shares' | 'followers' | 'published_at' | 'author' | 'ad_active_days' | 'ad_variants'>
  & Partial<Pick<RadarItem, 'bookmarks' | 'saves' | 'reposts'>>;

/**
 * Weighted interactions: likes + 2 comments + 3 (shares + reposts) + 3 bookmarks + 2 saves. A comment, a share or a
 * save costs the viewer more than a like, so it says more about the post. Null when the source gives no counts.
 */
export function interactions(it: Partial<Pick<RadarItem, 'likes' | 'comments' | 'shares' | 'reposts' | 'bookmarks' | 'saves'>>): number | null {
  const parts = [it.likes, it.comments, it.shares, it.reposts, it.bookmarks, it.saves];
  if (parts.every((x) => x == null)) return null;
  return (it.likes ?? 0) + 2 * (it.comments ?? 0) + 3 * ((it.shares ?? 0) + (it.reposts ?? 0)) + 3 * (it.bookmarks ?? 0) + 2 * (it.saves ?? 0);
}

/** The number an item's ratio and velocity count: views on video platforms, weighted interactions on text ones. */
export function metricOf(it: Scorable): number | null {
  return INTERACTION_PLATFORMS.has(it.platform) ? interactions(it) : it.views;
}

/**
 * The outlier score, 0 to 100, on one scale for every platform so formats can be compared across platforms.
 *
 *   I (interactions) = likes + 2·comments + 3·(shares + reposts) + 3·bookmarks + 2·saves
 *   M (metric)       = views on YouTube, TikTok and Instagram; I on X, LinkedIn, Reddit and Substack (their reach is
 *                      not public; X gives views, but its feed follows followers, so X is judged on I against followers)
 *   R (ratio)        = M against a baseline, the first that exists:
 *                        Reddit and Substack: the median M of the same subreddit or publication (2+ other posts);
 *                        followers (videos: views / followers; X: I / (1% of followers), so R = 1 is an ordinary post);
 *                        the author's median M here (2+ other items); the platform's median M here (3+ items)
 *   V (velocity)     = M per day since publishing (at least one day)
 *   E (engagement)   = I / views, when both are known
 *
 *   score = 50·clamp(log10(R + 1) / log10(11))     ten times the baseline gives the full 50
 *         + 30·clamp(log10(V + 1) / vmax)          vmax = 6 for views (1M a day), 4 for interactions (10k a day)
 *         + 20·clamp(E / 0.1)                      10% engagement gives the full 20
 *   With no E (no views, or a search that gives no likes, comments or shares) the first two parts are scaled to 100.
 *
 * Meta ads: 70·clamp(days active / 90) + 30·clamp(log2(variants) / 4) (Meta shows no spend for commercial ads).
 * `authorViews`, `platformViews` and `sourceValues` hold the M of the other items (views or interactions).
 */
export function scoreItem(it: Scorable, ctx: { authorViews?: number[]; platformViews?: number[]; sourceValues?: number[]; now?: number } = {}): ScoreParts {
  const now = ctx.now ?? Date.now();
  if (it.platform === 'meta_ads') {
    const days = it.ad_active_days ?? 0;
    const variants = Math.max(1, it.ad_variants ?? 1);
    const score = 70 * clamp01(days / 90) + 30 * clamp01(Math.log2(variants) / 4);
    return { ratio: null, ratio_basis: null, velocity: null, engagement: null, days_active: it.ad_active_days, variants, score: Math.round(score * 10) / 10 };
  }
  const byInteractions = INTERACTION_PLATFORMS.has(it.platform);
  const inter = interactions(it);
  const m = (byInteractions ? inter : it.views) ?? 0;
  let ratio: number | null = null; let basis: ScoreParts['ratio_basis'] = null;
  const med = (xs: number[] | undefined, n: number) => ((xs?.length ?? 0) >= n && median(xs!) > 0 ? median(xs!) : null);
  const src = SOURCE_PLATFORMS.has(it.platform) ? med(ctx.sourceValues, 2) : null;
  const auth = med(ctx.authorViews, 2);
  const plat = med(ctx.platformViews, 3);
  if (src) { ratio = m / src; basis = 'source'; }
  else if (it.followers && it.followers > 0 && (it.platform === 'x' || !byInteractions)) { ratio = m / (it.platform === 'x' ? Math.max(1, it.followers * X_ENGAGEMENT_RATE) : it.followers); basis = 'followers'; }
  else if (auth) { ratio = m / auth; basis = 'author'; }
  else if (plat) { ratio = m / plat; basis = 'platform'; }
  const ageDays = it.published_at ? Math.max(1, (now - Date.parse(it.published_at)) / DAY) : null;
  const velocity = ageDays && m ? m / ageDays : null;
  const views = it.views ?? 0;
  const engagement = views > 0 && inter != null ? inter / views : null;
  const reach = 50 * clamp01(Math.log10((ratio ?? 0) + 1) / Math.log10(11)) + 30 * clamp01(Math.log10((velocity ?? 0) + 1) / (byInteractions ? 4 : 6));
  const score = engagement != null ? reach + 20 * clamp01(engagement / 0.1) : reach / 0.8;
  const r3 = (x: number | null) => (x == null ? null : Math.round(x * 1000) / 1000);
  return {
    ratio: r3(ratio), ratio_basis: basis, velocity: velocity == null ? null : Math.round(velocity), engagement: r3(engagement), days_active: null, variants: null,
    score: Math.round(Math.min(100, score) * 10) / 10, metric: byInteractions ? 'interactions' : 'views', interactions: inter,
  };
}

