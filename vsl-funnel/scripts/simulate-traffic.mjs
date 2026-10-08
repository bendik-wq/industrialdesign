#!/usr/bin/env node
/**
 * Drives synthetic visitors through the real funnel endpoints of a LOCAL dev
 * server (`npm run dev`), so the dashboard has realistic data to look at and
 * every flow is exercised end to end.
 *
 *   node scripts/simulate-traffic.mjs [count=150] [baseUrl=http://127.0.0.1:8787]
 *
 * Never point this at production — it creates fake leads.
 */
const COUNT = Number(process.argv[2] ?? 150);
const BASE = process.argv[3] ?? 'http://127.0.0.1:8787';
if (!/localhost|127\.0\.0\.1/.test(BASE)) {
  console.error('Refusing to simulate against a non-local URL.');
  process.exit(1);
}

const SOURCES = [
  { w: 45, q: 'utm_source=facebook&utm_medium=paid&utm_campaign=cold-vsl-1&utm_content=hook-two-paths&ad_id=120001&fbclid=IwAR', quality: 0.55 },
  { w: 20, q: 'utm_source=facebook&utm_medium=paid&utm_campaign=cold-vsl-1&utm_content=hook-no-deposit&ad_id=120002&fbclid=IwAR', quality: 0.4 },
  { w: 12, q: 'utm_source=youtube&utm_medium=paid&utm_campaign=yt-instream&gclid=Cj0', quality: 0.65 },
  { w: 10, q: 'utm_source=instagram&utm_medium=social&utm_campaign=organic-reels', quality: 0.35 },
  { w: 8, q: '', ref: 'https://www.google.com/', quality: 0.6 },
  { w: 5, q: 'utm_source=newsletter&utm_medium=email&utm_campaign=weekly-deal', quality: 0.8 },
];
const UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0',
];
const NAMES = ['Alex', 'Jordan', 'Priya', 'Liam', 'Mei', 'Noah', 'Sofia', 'Ethan', 'Aisha', 'Lucas', 'Chloe', 'Mateo', 'Hannah', 'Ravi', 'Grace'];
const SURNAMES = ['Nguyen', 'Smith', 'Patel', 'Brown', 'Chen', 'Wilson', 'Kumar', 'Taylor', 'Lee', 'Martin'];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const weighted = (arr) => { let r = Math.random() * arr.reduce((s, x) => s + x.w, 0); for (const x of arr) if ((r -= x.w) < 0) return x; return arr[0]; };
const chance = (p) => Math.random() < p;

class Browser {
  constructor(ua) { this.ua = ua; this.cookies = new Map(); }
  async req(path, { method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(BASE + path, {
      method,
      redirect: 'manual',
      headers: { 'user-agent': this.ua, 'accept-language': 'en-AU,en;q=0.9', cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const i = kv.indexOf('='); this.cookies.set(kv.slice(0, i), kv.slice(i + 1)); }
    const text = await res.text();
    try { return { status: res.status, json: JSON.parse(text), text }; } catch { return { status: res.status, text }; }
  }
  beacon(path, body) { return this.req(path, { method: 'POST', body, headers: { 'content-type': 'text/plain' } }); }
}

async function watch(b, video, duration, fraction, opts = {}) {
  const view = 'sim' + Math.random().toString(36).slice(2, 12);
  const buckets = Array(100).fill('0');
  const reach = Math.min(duration, duration * fraction);
  for (let t = 10; t <= reach + 10; t += 30) {
    const pos = Math.min(t, reach);
    for (let i = 0; i < Math.floor((pos / duration) * 100); i++) buckets[i] = '1';
    await b.beacon('/api/v', { view, video, pos, dur: duration, buckets: buckets.join(''), watched: 30, unmuted: true, revealed: pos >= (opts.revealAt ?? 420), cta: false, ended: pos >= duration - 1, path: opts.path ?? '/' });
    if (pos >= reach) break;
  }
  return reach;
}

async function visitor(i) {
  const src = weighted(SOURCES);
  const b = new Browser(pick(UAS));
  const q = src.q ? `?${src.q}${src.q.endsWith('IwAR') || src.q.endsWith('Cj0') ? Math.random().toString(36).slice(2, 12) : ''}` : '';
  const landing = await b.req(`/${q}`, { headers: src.ref ? { referer: src.ref } : {} });
  const variant = /"variant":"(\w)"/.exec(landing.text)?.[1] ?? 'a';
  await b.beacon('/api/e', { path: '/', meta: { lang: 'en-AU', tz: 'Australia/Sydney', screen: '390x844', viewport: '390x700', dpr: 3 }, events: [{ n: 'scroll_depth', p: { pct: 25 } }] });

  // Variant B's hook is a little stronger in this simulation, so the A/B test has something to find.
  const hook = variant === 'b' ? 1.15 : 1;
  if (!chance(0.62 * hook)) return 'bounced';
  const fraction = Math.min(1, Math.pow(Math.random(), 1.6 / (src.quality + 0.3)) * 1.1 * hook);
  const reached = await watch(b, 'vsl-main', 900, fraction);
  if (reached < 420 || !chance(0.45 * src.quality + 0.15)) return 'watched';

  await b.beacon('/api/e', { path: '/', events: [{ n: 'cta_click', p: { id: 'landing_primary' } }] });
  await b.req('/apply');
  const first = pick(NAMES), last = pick(SURNAMES);
  const email = `${first}.${last}.${i}.${Date.now() % 100000}@example.com`.toLowerCase();
  const contact = await b.req('/api/apply/contact', { method: 'POST', body: { first_name: first, last_name: last, email, phone: `04${Math.floor(10000000 + Math.random() * 89999999)}`, whatsapp_opt_in: chance(0.6) } });
  if (!contact.json?.ok) return 'contact-failed';

  const good = chance(src.quality);
  const answers = [
    ['situation', good ? pick(['corporate_senior', 'owner_one', 'investor', 'owner_multi']) : pick(['employee', 'student', 'corporate_senior'])],
    ['income', good ? pick(['150_300', 'gt300', '75_150']) : pick(['lt75', '75_150'])],
    ['capital', good ? pick(['25_100', 'gt100', '5_25']) : pick(['lt5', '5_25'])],
    ['timeline', good ? pick(['0_3', '3_6']) : pick(['6_12', 'exploring', '3_6'])],
    ['blockers', [pick(['capital', 'deal_flow', 'credibility']), pick(['structure', 'time'])]],
    ['readiness', good ? pick(['yes', 'yes', 'partner']) : pick(['partner', 'not_now'])],
    ['why_now', good ? 'I want to stop trading time for money and build a portfolio of cash-flowing businesses that give my family security and freedom over the next few years.' : 'Curious about how it works.'],
  ];
  const quitAt = chance(0.22) ? 1 + Math.floor(Math.random() * 5) : 99;
  for (let s = 0; s < answers.length; s++) {
    if (s >= quitAt) return 'abandoned';
    await b.req('/api/apply/answer', { method: 'POST', body: { question: answers[s][0], value: answers[s][1] } });
  }
  const sub = await b.req('/api/apply/submit', { method: 'POST', body: {} });
  const tier = sub.json?.tier;
  if (tier !== 'C') await watch(b, 'vsl-breakout', 600, Math.random(), { revealAt: 180, path: '/breakout' });
  if (chance(0.35)) await b.req('/go/wa?src=breakout');
  if (tier === 'A' && chance(0.7)) {
    await b.req('/api/booking/client', { method: 'POST', body: { provider: 'calendly', event_uri: `https://api.calendly.com/scheduled_events/SIM${i}` } });
    return 'booked';
  }
  return `applied-${tier}`;
}

const tally = {};
const started = Date.now();
for (let i = 0; i < COUNT; i += 6) {
  const batch = await Promise.all(Array.from({ length: Math.min(6, COUNT - i) }, (_, k) => visitor(i + k).catch((e) => `error: ${e.message}`)));
  for (const r of batch) tally[r] = (tally[r] ?? 0) + 1;
  process.stdout.write(`\r${Math.min(i + 6, COUNT)}/${COUNT} visitors`);
}
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`, tally);
