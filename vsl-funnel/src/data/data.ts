import type { Context } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { ApplicationError, attributionFor, verifyTurnstile } from '../funnel/application';
import { cleanName, normalisePhone, validateEmail } from '../funnel/leads';
import { notify } from '../integrations/notify';
import { newId } from '../lib/ids';
import type { VisitorCtx } from '../lib/identity';
import { defang } from '../lib/text';
import { identityFromVisitor, track } from '../tracking/track';
import { betaSample } from '../landers/bandit';

/**
 * Data-buyer referral page (data.yourdomain.com, or /data on the main domain). Owners claim a data
 * valuation; we keep their details, then send them on to the partner's referral link.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function dataSettings(rt: Runtime) {
  const s = rt.settings;
  return {
    partner: s.DATA_PARTNER.trim() || 'micro1',
    fund: s.DATA_FUND_LINE.trim() || '$1 billion',
    referral: /^https:\/\//.test(s.DATA_REFERRAL_URL.trim()) ? s.DATA_REFERRAL_URL.trim() : '',
    video: /^https:\/\//.test(s.DATA_VIDEO_SRC.trim()) || s.DATA_VIDEO_SRC.trim().startsWith('/') ? s.DATA_VIDEO_SRC.trim() : '',
  };
}

export function isDataHost(c: Context<AppEnv>) {
  const host = new URL(c.req.url).host;
  const configured = c.get('settings').DATA_URL;
  if (configured) { try { return new URL(configured).host === host; } catch { /* fall through */ } }
  return host.startsWith('data.');
}

/** YouTube / Vimeo / Loom links become an embed; anything else plays in a <video>. */
export function videoEmbed(src: string) {
  if (!src) return '';
  let m = src.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,20})/);
  if (m) return `<iframe src="https://www.youtube-nocookie.com/embed/${m[1]}?rel=0&modestbranding=1&playsinline=1" title="Video" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe>`;
  m = src.match(/vimeo\.com\/(?:video\/)?(\d{6,12})/);
  if (m) return `<iframe src="https://player.vimeo.com/video/${m[1]}?dnt=1" title="Video" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
  m = src.match(/loom\.com\/(?:share|embed)\/([0-9a-f]{20,40})/);
  if (m) return `<iframe src="https://www.loom.com/embed/${m[1]}?hide_owner=true&hide_share=true" title="Video" allow="fullscreen" allowfullscreen loading="lazy"></iframe>`;
  return `<video src="${esc(src)}" controls playsinline preload="metadata" data-data-video></video>`;
}

export async function dataLanding(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const d = dataSettings(rt);
  const { h, preview } = await pickHeadline(rt, c.get('visitor').visitorId, c.req.query('h'));
  const fill = (t: string) => t.replace(/\{partner\}/g, esc(d.partner)).replace(/\{fund\}/g, esc(d.fund));
  return render(c, '/data.html', {
    title: `Get paid for your operational data`,
    slots: { partner: esc(d.partner), fund: esc(d.fund), headline: fill(h.h1), lede: fill(h.lede), defunct: DEFUNCT_LINE },
    // Previews (?h=) don't count towards the test.
    trackProps: preview ? { headline_preview: h.id } : { headline: h.id },
    blocks: { video: videoEmbed(d.video) },
    show: { has_video: Boolean(d.video) },
    config: { data: { claim: '/api/data/claim', headline: h.id } },
    trackPath: '/data',
  });
}

/**
 * Headline test: 20 headlines, each new visitor gets one (and keeps it on return visits). Traffic is
 * shared by Thompson sampling: every headline gets its first 30 visitors, then traffic shifts to what
 * converts. Success = claims once there are 20+ in total, before that "clicked claim / started the form".
 * DATA_HEADLINE_TEST: "auto" (default), "even" (equal split), or a headline id to pin it for everyone.
 * Trusted copy only; {partner} and {fund} are filled escaped.
 */
const LEDE = {
  cash: '<strong>{partner} just had {fund} committed to buying it.</strong> Not customer data. Anonymised <em>operational</em> data: how your business actually runs. Deals typically land between $200,000 and $2 million. No equity. Nothing changes day to day.',
  recap: '<strong>No new investors. No dilution. No loan.</strong> {partner} has {fund} committed to buying anonymised operational data from established businesses (trading or closed), and deals typically land between $200,000 and $2 million. You keep every share.',
  debt: '<strong>Clear the expensive loans without selling a share or borrowing another cent.</strong> {partner} has {fund} committed to buying anonymised operational data, typically $200,000 to $2 million a deal. Not customer data. Nothing changes day to day.',
  revenue: '<strong>A product you’ve been making for years without selling it.</strong> {partner} has {fund} committed to buying anonymised operational data, typically $200,000 to $2 million a deal. No new staff, no new customers, no equity.',
  curious: '<strong>It’s your operational data, and {partner} has {fund} committed to buying it.</strong> Not customer data, not equity: anonymised records of how your business runs. Deals typically land between $200,000 and $2 million.',
};
type Angle = keyof typeof LEDE;
const H = (id: string, angle: Angle, h1: string) => ({ id, angle, h1, lede: LEDE[angle] });
const TAIL = '<span class="nw">already creates.</span>';

export const DATA_HEADLINES: { id: string; angle: Angle; h1: string; lede: string }[] = [
  // The control and its angle variants ("get paid up to $2M for data your business already creates").
  H('paid', 'cash', `Get paid up to <em>$2,000,000</em> for data your business ${TAIL}`),
  H('recap', 'recap', `Recapitalise your business with up to <em>$2,000,000</em> for data it ${TAIL}`),
  H('debt', 'debt', `Pay down your debt with up to <em>$2,000,000</em> for data your business ${TAIL}`),
  H('revenue', 'revenue', `Unlock up to <em>$2,000,000</em> in new revenue from data your business ${TAIL}`),
  // Recapitalise
  H('noshare', 'recap', 'Raise up to <em>$2,000,000</em> without giving up a single share.'),
  H('noloan', 'recap', 'Up to <em>$2,000,000</em> into your business. <span class="nw">No loan.</span> <span class="nw">No investor.</span> <span class="nw">No repayments.</span>'),
  H('balance', 'recap', 'Strengthen your balance sheet by up to <em>$2,000,000</em>, without debt or dilution.'),
  // Pay down debt
  H('overdraft', 'debt', 'Wipe out the overdraft. Clear the equipment loans. <em>Up to $2,000,000</em> from data you already have.'),
  H('borrow', 'debt', 'What would you do with <em>$2,000,000</em> you didn’t have to borrow?'),
  // New revenue
  H('product', 'revenue', 'Your next product is already built: <em>the data your business creates.</em> Sell it for up to $2M.'),
  H('years', 'revenue', 'Every year you’ve run your business just became worth more. <em>Up to $2,000,000 more.</em>'),
  // Cash / keep the business
  H('keep', 'cash', 'Sell your data. <em>Keep your business.</em> Bank up to $2M.'),
  H('offtable', 'cash', 'Take up to <em>$2,000,000</em> off the table, without selling your business.'),
  H('fund', 'cash', 'A company with {fund} to spend wants to buy your data. <em>Not your business. Just the data.</em>'),
  // Curiosity / secret / market has moved / X opener / how-come
  H('asset', 'curious', 'Your business is sitting on an asset worth up to <em>$2&nbsp;million</em> that you’ve never sold.'),
  H('balsheet', 'curious', 'The most valuable thing your business owns <em>isn’t on your balance sheet.</em>'),
  H('howcome', 'curious', 'How come AI companies are paying owners up to <em>$2,000,000</em> for records they already keep?'),
  H('secret', 'curious', 'The {fund} data deal <em>most business owners haven’t heard about yet.</em>'),
  H('aiboom', 'curious', 'The AI boom just put a price on your business’s data: <em>up to $2,000,000.</em>'),
  H('notstartups', 'curious', 'Not for start-ups. Established owners are getting paid up to <em>$2,000,000</em> for their operational data.'),
];
export const DATA_HEADLINE_MIN = 30;
/** Shown under every headline: closed businesses qualify too. */
export const DEFUNCT_LINE = '<strong>Closed or sold a business?</strong> If you still have its records, they could be worth up to $2 million too.';
export const BUSINESS_STATUS = ['Trading', 'Closed', 'Sold', 'Dormant'];

export interface HeadlineStats { visitors: number; clicked: number; claims: number }
let hcache: { at: number; stats: Map<string, HeadlineStats> } | null = null;

export async function headlineStats(rt: Runtime, from = 0, to = Date.now(), cached = true): Promise<Map<string, HeadlineStats>> {
  if (cached && hcache && Date.now() - hcache.at < 60_000) return hcache.stats;
  const db = rt.env.DB;
  // Each visitor's headline = the one on their first view of the page.
  const seen = `SELECT visitor_id, json_extract(props, '$.headline') AS h, MIN(ts) AS t FROM events WHERE name = 'page_view' AND path = '/data' AND is_bot = 0 AND ts BETWEEN ?1 AND ?2 GROUP BY visitor_id`;
  const [v, k, c] = await Promise.all([
    db.prepare(`SELECT h, COUNT(*) AS n FROM (${seen}) GROUP BY h`).bind(from, to).all<{ h: string | null; n: number }>(),
    db.prepare(`SELECT s.h, COUNT(DISTINCT e.visitor_id) AS n FROM events e JOIN (${seen}) s ON s.visitor_id = e.visitor_id
                 WHERE e.path = '/data' AND e.name IN ('data_cta_click', 'data_form_start') AND e.ts BETWEEN ?1 AND ?2 GROUP BY s.h`).bind(from, to).all<{ h: string | null; n: number }>(),
    db.prepare('SELECT headline AS h, COUNT(*) AS n FROM data_referrals WHERE created_at BETWEEN ?1 AND ?2 GROUP BY headline').bind(from, to).all<{ h: string | null; n: number }>(),
  ]);
  const stats = new Map<string, HeadlineStats>(DATA_HEADLINES.map((h) => [h.id, { visitors: 0, clicked: 0, claims: 0 }]));
  for (const r of v.results) if (r.h && stats.has(r.h)) stats.get(r.h)!.visitors = r.n;
  for (const r of k.results) if (r.h && stats.has(r.h)) stats.get(r.h)!.clicked = r.n;
  for (const r of c.results) if (r.h && stats.has(r.h)) stats.get(r.h)!.claims = r.n;
  if (cached) hcache = { at: Date.now(), stats };
  return stats;
}

/** Thompson sampling over the 20 headlines (see above). */
export function chooseHeadline(stats: Map<string, HeadlineStats>, rnd: () => number = Math.random) {
  const arms = DATA_HEADLINES.map((h) => ({ id: h.id, s: stats.get(h.id) ?? { visitors: 0, clicked: 0, claims: 0 } }));
  const cold = arms.filter((x) => x.s.visitors < DATA_HEADLINE_MIN);
  if (cold.length) return cold[Math.floor(rnd() * cold.length)].id;
  const useClaims = arms.reduce((t, x) => t + x.s.claims, 0) >= 20;
  let best = { id: arms[0].id, draw: -1 };
  for (const x of arms) {
    const wins = Math.min(x.s.visitors, useClaims ? x.s.claims : x.s.clicked);
    const draw = betaSample(wins + 1, Math.max(0, x.s.visitors - wins) + 1, rnd);
    if (draw > best.draw) best = { id: x.id, draw };
  }
  return best.id;
}

/** Share of new visitors each headline would get right now, and its chance of being the best (simulated). */
export function headlineOdds(stats: Map<string, HeadlineStats>, runs = 2000) {
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const share: Record<string, number> = {}, best: Record<string, number> = {};
  const useClaims = [...stats.values()].reduce((t, x) => t + x.claims, 0) >= 20;
  for (let i = 0; i < runs; i++) {
    const pick = chooseHeadline(stats, rnd);
    share[pick] = (share[pick] ?? 0) + 1 / runs;
    let top = { id: '', draw: -1 };
    for (const h of DATA_HEADLINES) {
      const s = stats.get(h.id)!, wins = Math.min(s.visitors, useClaims ? s.claims : s.clicked);
      const d = betaSample(wins + 1, Math.max(0, s.visitors - wins) + 1, rnd);
      if (d > top.draw) top = { id: h.id, draw: d };
    }
    best[top.id] = (best[top.id] ?? 0) + 1 / runs;
  }
  return { share, best, metric: useClaims ? 'claims' : 'clicked claim / started the form' };
}

/** Which headline this visitor sees: a forced preview (?h=), a pinned one, the one they saw before, or the bandit's pick. */
export async function pickHeadline(rt: Runtime, visitorId: string, forced?: string | null) {
  const byId = (id: string | null | undefined) => DATA_HEADLINES.find((h) => h.id === id);
  if (byId(forced)) return { h: byId(forced)!, preview: true };
  const mode = (rt.settings.DATA_HEADLINE_TEST || 'auto').trim();
  if (byId(mode)) return { h: byId(mode)!, preview: false };
  const prev = await rt.env.DB.prepare("SELECT json_extract(props, '$.headline') AS h FROM events WHERE name = 'page_view' AND path = '/data' AND visitor_id = ? ORDER BY ts LIMIT 1").bind(visitorId).first<{ h: string | null }>();
  if (byId(prev?.h)) return { h: byId(prev!.h)!, preview: false };
  if (mode === 'even') return { h: DATA_HEADLINES[Math.floor(Math.random() * DATA_HEADLINES.length)], preview: false };
  return { h: byId(chooseHeadline(await headlineStats(rt)))!, preview: false };
}

const REVENUES = ['Under $1M', '$1M–$5M', '$5M–$20M', '$20M–$100M', '$100M+'];

/** Stores the claim, pings the team, and returns where to send them (the partner's referral link). */
export async function claimData(rt: Runtime, v: VisitorCtx, body: Record<string, unknown>) {
  const firstName = cleanName(body.first_name);
  const emailCheck = validateEmail(body.email);
  if (!firstName) throw new ApplicationError('Please enter your first name', 'first_name');
  if (!emailCheck) throw new ApplicationError('Please enter a valid email address', 'email');
  if (emailCheck.disposable) throw new ApplicationError('Please use your business email', 'email');
  const company = typeof body.company === 'string' ? defang(body.company.trim()).slice(0, 120) : '';
  if (!company) throw new ApplicationError('Please enter your company name', 'company');
  const website = typeof body.website === 'string' ? body.website.trim().slice(0, 200) : '';
  const site = website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : '';
  if (site) { try { new URL(site); } catch { throw new ApplicationError('That website doesn’t look right — or leave it blank', 'website'); } }
  const phone = typeof body.phone === 'string' && body.phone.trim() ? normalisePhone(body.phone, v.geo.country) : null;
  if (typeof body.phone === 'string' && body.phone.trim() && !phone) throw new ApplicationError('Please enter a valid phone number, including area code — or leave it blank', 'phone');
  const status = BUSINESS_STATUS.includes(String(body.business_status)) ? String(body.business_status) : null;
  const headline = DATA_HEADLINES.some((h) => h.id === body.headline) ? String(body.headline) : null;
  const revenue = REVENUES.includes(String(body.revenue)) ? String(body.revenue) : null;
  if (!(await verifyTurnstile(rt, body.turnstile, v.ip))) throw new ApplicationError('Security check failed — please refresh and try again', undefined, 403);

  // A few claims per IP per hour (each one pings the team).
  const ipKey = `dclaim:${v.ip ?? 'unknown'}`;
  const row = await rt.env.DB.prepare('SELECT value FROM kv_state WHERE key = ?').bind(ipKey).first<{ value: string }>();
  const rate = (() => { try { const r = JSON.parse(row?.value ?? '{}') as { n?: number; t?: number }; return r.t && Date.now() - r.t < 3_600_000 ? { n: r.n ?? 0, t: r.t } : { n: 0, t: Date.now() }; } catch { return { n: 0, t: Date.now() }; } })();
  if (rate.n >= 6) throw new ApplicationError('Too many requests from this connection. Please try again in an hour.', undefined, 429);
  await rt.env.DB.prepare('INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(ipKey, JSON.stringify({ n: rate.n + 1, t: rate.t })).run();

  const d = dataSettings(rt);
  const { last } = await attributionFor(rt, v);
  const id = newId('dr');
  await rt.env.DB.prepare(
    `INSERT INTO data_referrals (id, created_at, first_name, email, company, website, phone, revenue, visitor_id, session_id, channel, utm_source, utm_campaign, country, redirected, headline, business_status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, Date.now(), firstName, emailCheck.email, company, site || null, phone, revenue, v.visitorId, v.sessionId, last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_campaign ?? null, v.geo.country, d.referral ? 1 : 0, headline, status).run();

  await track(rt, identityFromVisitor(v, null, null), { name: 'data_claim', source: 'server', path: '/data', props: { revenue, headline, status, redirected: Boolean(d.referral) }, localOnly: true });
  rt.waitUntil(notify(rt, {
    kind: 'hot_lead',
    title: `💾 Data valuation claim — ${firstName} (${company})`,
    lines: [`${emailCheck.email}${phone ? ` · ${phone}` : ''}`, site ? `Website: ${site}` : '', revenue ? `Revenue: ${revenue}` : '', status ? `Business: ${status}` : '', d.referral ? `Sent on to ${d.partner}.` : 'No referral link set yet — follow up by hand.'],
  }).then(() => undefined, () => undefined));
  return { id, next: d.referral || null };
}

export async function dataReport(rt: Runtime, from: number, to: number) {
  const db = rt.env.DB;
  const [views, ev, claims, list] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE name = 'page_view' AND path = '/data' AND is_bot = 0 AND ts BETWEEN ? AND ?").bind(from, to).first<{ views: number; visitors: number }>(),
    db.prepare("SELECT name, COUNT(DISTINCT visitor_id) AS n FROM events WHERE path = '/data' AND name IN ('data_video_play', 'data_cta_click', 'data_form_start') AND ts BETWEEN ? AND ? GROUP BY name").bind(from, to).all<{ name: string; n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM data_referrals WHERE created_at BETWEEN ? AND ?').bind(from, to).first<{ n: number }>(),
    db.prepare('SELECT id, created_at, first_name, email, company, website, phone, revenue, headline, business_status, channel, utm_source, utm_campaign, country, redirected FROM data_referrals WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 200').bind(from, to).all(),
  ]);
  const by = Object.fromEntries(ev.results.map((r) => [r.name, r.n]));
  const hs = await headlineStats(rt, from, to, false);
  const odds = headlineOdds(await headlineStats(rt, 0, Date.now(), false));
  const d = dataSettings(rt), fund = d.fund;
  const headlines = DATA_HEADLINES.map((h) => {
    const x = hs.get(h.id)!;
    return {
      id: h.id, angle: h.angle, text: h.h1.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\{fund\}/g, fund),
      ...x, rate: x.visitors ? x.claims / x.visitors : null, clickRate: x.visitors ? x.clicked / x.visitors : null,
      share: odds.share[h.id] ?? 0, best: odds.best[h.id] ?? 0,
    };
  });
  return {
    url: (rt.settings.DATA_URL || `${rt.origin}/data`).replace(/\/+$/, ''),
    partner: d.partner, referral: d.referral, video: d.video,
    funnel: { visitors: views?.visitors ?? 0, views: views?.views ?? 0, played: by.data_video_play ?? 0, cta: by.data_cta_click ?? 0, started: by.data_form_start ?? 0, claims: claims?.n ?? 0 },
    claims: list.results,
    headlines,
    test: { mode: (rt.settings.DATA_HEADLINE_TEST || 'auto').trim(), metric: odds.metric, min: DATA_HEADLINE_MIN },
  };
}
