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
  const h = pickHeadline(c.get('visitor').visitorId, c.req.query('h'));
  const fill = (t: string) => t.replace(/\{partner\}/g, esc(d.partner)).replace(/\{fund\}/g, esc(d.fund));
  return render(c, '/data.html', {
    title: `Get paid for your operational data`,
    slots: { partner: esc(d.partner), fund: esc(d.fund), headline: fill(h.h1), lede: fill(h.lede) },
    trackProps: { headline: h.id },
    blocks: { video: videoEmbed(d.video) },
    show: { has_video: Boolean(d.video) },
    config: { data: { claim: '/api/data/claim', headline: h.id } },
    trackPath: '/data',
  });
}

/**
 * Headline test: each visitor sees one (stable per browser), claims are credited to it, and the
 * Data page tab shows which converts. Trusted copy only; {partner} and {fund} are filled escaped.
 */
export const DATA_HEADLINES: { id: string; h1: string; lede: string }[] = [
  {
    id: 'paid',
    h1: 'Get paid up to <em>$2,000,000</em> for data your business <span class="nw">already creates.</span>',
    lede: '<strong>{partner} just had {fund} committed to buying it.</strong> Not customer data. Anonymised <em>operational</em> data: how your business actually runs. Deals typically land between $200,000 and $2 million. No equity. Nothing changes day to day.',
  },
  {
    id: 'recap',
    h1: 'Recapitalise your business with up to <em>$2,000,000</em> for data it <span class="nw">already creates.</span>',
    lede: '<strong>No new investors. No dilution. No loan.</strong> {partner} has {fund} committed to buying anonymised operational data from established businesses, and deals typically land between $200,000 and $2 million. You keep every share.',
  },
  {
    id: 'debt',
    h1: 'Pay down your debt with up to <em>$2,000,000</em> for data your business <span class="nw">already creates.</span>',
    lede: '<strong>Clear the expensive loans without selling a share or borrowing another cent.</strong> {partner} has {fund} committed to buying anonymised operational data, typically $200,000 to $2 million a deal. Not customer data. Nothing changes day to day.',
  },
  {
    id: 'revenue',
    h1: 'Unlock up to <em>$2,000,000</em> in new revenue from data your business <span class="nw">already creates.</span>',
    lede: '<strong>A new product you’ve been making for years without selling it.</strong> {partner} has {fund} committed to buying anonymised operational data, typically $200,000 to $2 million a deal. No new staff, no new customers, no equity.',
  },
];

export function pickHeadline(visitorId: string, forced?: string | null) {
  const f = DATA_HEADLINES.find((h) => h.id === forced);
  if (f) return f;
  let x = 2166136261;
  for (let i = 0; i < visitorId.length; i++) x = Math.imul(x ^ visitorId.charCodeAt(i), 16777619);
  return DATA_HEADLINES[(x >>> 0) % DATA_HEADLINES.length];
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
    `INSERT INTO data_referrals (id, created_at, first_name, email, company, website, phone, revenue, visitor_id, session_id, channel, utm_source, utm_campaign, country, redirected, headline)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(id, Date.now(), firstName, emailCheck.email, company, site || null, phone, revenue, v.visitorId, v.sessionId, last?.channel ?? 'Direct', last?.utm_source ?? null, last?.utm_campaign ?? null, v.geo.country, d.referral ? 1 : 0, headline).run();

  await track(rt, identityFromVisitor(v, null, null), { name: 'data_claim', source: 'server', path: '/data', props: { revenue, headline, redirected: Boolean(d.referral) }, localOnly: true });
  rt.waitUntil(notify(rt, {
    kind: 'hot_lead',
    title: `💾 Data valuation claim — ${firstName} (${company})`,
    lines: [`${emailCheck.email}${phone ? ` · ${phone}` : ''}`, site ? `Website: ${site}` : '', revenue ? `Revenue: ${revenue}` : '', d.referral ? `Sent on to ${d.partner}.` : 'No referral link set yet — follow up by hand.'],
  }).then(() => undefined, () => undefined));
  return { id, next: d.referral || null };
}

export async function dataReport(rt: Runtime, from: number, to: number) {
  const db = rt.env.DB;
  const [views, ev, claims, list] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS views, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE name = 'page_view' AND path = '/data' AND is_bot = 0 AND ts BETWEEN ? AND ?").bind(from, to).first<{ views: number; visitors: number }>(),
    db.prepare("SELECT name, COUNT(DISTINCT visitor_id) AS n FROM events WHERE path = '/data' AND name IN ('data_video_play', 'data_cta_click', 'data_form_start') AND ts BETWEEN ? AND ? GROUP BY name").bind(from, to).all<{ name: string; n: number }>(),
    db.prepare('SELECT COUNT(*) AS n FROM data_referrals WHERE created_at BETWEEN ? AND ?').bind(from, to).first<{ n: number }>(),
    db.prepare('SELECT id, created_at, first_name, email, company, website, phone, revenue, headline, channel, utm_source, utm_campaign, country, redirected FROM data_referrals WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 200').bind(from, to).all(),
  ]);
  const by = Object.fromEntries(ev.results.map((r) => [r.name, r.n]));
  const [hv, hc] = await Promise.all([
    db.prepare("SELECT json_extract(props, '$.headline') AS id, COUNT(DISTINCT visitor_id) AS visitors FROM events WHERE name = 'page_view' AND path = '/data' AND is_bot = 0 AND ts BETWEEN ? AND ? GROUP BY id").bind(from, to).all<{ id: string | null; visitors: number }>(),
    db.prepare('SELECT headline AS id, COUNT(*) AS claims FROM data_referrals WHERE created_at BETWEEN ? AND ? GROUP BY headline').bind(from, to).all<{ id: string | null; claims: number }>(),
  ]);
  const headlines = DATA_HEADLINES.map((h) => {
    const visitors = hv.results.find((r) => r.id === h.id)?.visitors ?? 0, claims = hc.results.find((r) => r.id === h.id)?.claims ?? 0;
    return { id: h.id, text: h.h1.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\{fund\}/g, dataSettings(rt).fund), visitors, claims, rate: visitors ? claims / visitors : null };
  });
  const d = dataSettings(rt);
  return {
    url: (rt.settings.DATA_URL || `${rt.origin}/data`).replace(/\/+$/, ''),
    partner: d.partner, referral: d.referral, video: d.video,
    funnel: { visitors: views?.visitors ?? 0, views: views?.views ?? 0, played: by.data_video_play ?? 0, cta: by.data_cta_click ?? 0, started: by.data_form_start ?? 0, claims: claims?.n ?? 0 },
    claims: list.results,
    headlines,
  };
}
