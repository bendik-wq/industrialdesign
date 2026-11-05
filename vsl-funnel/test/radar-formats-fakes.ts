// Shared fakes for the Radar v2 format tests (test/radar-formats*.test.ts): seeded top performers across platforms and
// niches, and one fake model that answers each prompt kind (extract, name, adapt, judge, Studio script) by its shape.
import type { Runtime } from '../src/app';
import { SETTINGS, type Settings } from '../src/settings';
import { type SqlDb, d1 } from './studio-fakes';

export const NOW = Date.parse('2026-11-05T12:00:00Z');
export const blankSettings = () => Object.fromEntries(SETTINGS.map((s) => [s.key, ''])) as Settings;
export function rtFor(db: SqlDb, over: Partial<Settings> = {}, env: Record<string, unknown> = {}): Runtime & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { env: { DB: d1(db), ...env } as never, settings: { ...blankSettings(), ...over }, reps: [], origin: 'https://apply.test', waitUntil: (p) => { pending.push(p); }, pending };
}

export interface SeedItem { id: string; platform: string; title: string; niche: 'in' | 'out'; score: number; duration_s?: number | null; caption?: string; published_at?: string }
export const ITEMS: SeedItem[] = [
  { id: 'youtube:deal1', platform: 'youtube', title: 'Deal teardown: buying an HVAC business with seller financing', niche: 'in', score: 82, duration_s: 640 },
  { id: 'tiktok:deal2', platform: 'tiktok', title: 'Business breakdown of a laundromat deal', niche: 'out', score: 74, duration_s: 50 },
  { id: 'instagram:street1', platform: 'instagram', title: 'Street interview: what business do you own', niche: 'out', score: 91, duration_s: 40 },
  { id: 'tiktok:street2', platform: 'tiktok', title: 'Street interview with a millionaire business owner', niche: 'out', score: 68, duration_s: 35 },
  { id: 'x:bought1', platform: 'x', title: 'I bought a business. Here is what it made in year one (thread)', niche: 'out', score: 60, duration_s: null },
  { id: 'youtube:pe1', platform: 'youtube', title: 'Private equity is wrong about small business', niche: 'in', score: 40, duration_s: 420 },
];

export async function seedItems(db: SqlDb, items: SeedItem[] = ITEMS) {
  const ts = new Date(NOW - 86400_000).toISOString();
  for (const it of items) {
    db.prepare(`INSERT INTO radar_items (id, platform, external_id, url, author, title, caption, published_at, duration_s, views, likes, comments, shares, followers, niche, radar_ids, score, score_json, transcript, transcript_source, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`).run(
      it.id, it.platform, it.id.split(':')[1], `https://example.com/${it.id}`, 'creator', it.title, it.caption ?? it.title, it.published_at ?? ts, it.duration_s ?? null,
      100_000, 5000, 300, 200, 20_000, it.niche, it.score, JSON.stringify({ ratio: 5, ratio_basis: 'author', engagement: 0.05 }),
      it.platform === 'x' ? null : `[0:00] ${it.title}. [0:05] Here is the number.`, it.platform === 'x' ? 'missing' : 'captions', ts, ts,
    );
  }
}

/** What the fake extractor returns for each seeded title. */
export function extractionFor(title: string) {
  const t = title.toLowerCase();
  if (t.includes('teardown') || t.includes('breakdown')) return { format_name: t.includes('teardown') ? 'Deal teardown with live scorecard' : 'Deal breakdown with live scorecard', hook: { text: 'This deal made 2 million.', type: 'result-first', why_it_works: 'Leads with the result.' }, beats: [{ at: '0:00', role: 'hook', summary: 'The result.' }, { at: '0:20', role: 'proof', summary: 'The scorecard.' }, { at: '0:45', role: 'cta', summary: 'Follow.' }], devices: ['scorecard', 'on_screen_numbers'], length_bucket: 'short', retention_risks: [{ at: '0:30', why: 'Dense numbers.' }], cta: 'Follow for part 2', audience: ['aspiring_buyer', 'owner_1m'], emotional_driver: 'greed', why_viral: '5x the creator\'s typical views.' };
  if (t.includes('street interview')) return { format_name: t.includes('millionaire') ? 'Street wealth interviews' : 'Street wealth interview', hook: { text: 'What do you do for a living?', type: 'question', why_it_works: 'Curiosity about a stranger.' }, beats: [{ at: '0:00', role: 'hook', summary: 'The question.' }, { at: '0:10', role: 'turn', summary: 'The answer surprises.' }], devices: ['street_interview', 'text_overlay'], length_bucket: 'short', retention_risks: [], cta: '', audience: ['general', 'owner_1m'], emotional_driver: 'envy', why_viral: 'High shares against views.' };
  if (t.includes('i bought')) return { format_name: 'I bought X, here\'s what it made', hook: { text: 'I bought a business.', type: 'story-cold-open', why_it_works: 'A first-person result.' }, beats: [{ at: 'tweet 1', role: 'hook', summary: 'The buy.' }, { at: 'tweet 5', role: 'payoff', summary: 'The profit.' }], devices: ['thread', 'on_screen_numbers'], length_bucket: 'thread', retention_risks: [], cta: 'Follow', audience: ['aspiring_buyer'], emotional_driver: 'hope', why_viral: 'Bookmarks high.' };
  return { format_name: 'Contrarian PE explainer', hook: { text: 'Private equity is wrong.', type: 'contrarian', why_it_works: 'Picks a fight.' }, beats: [{ at: '0:00', role: 'hook', summary: 'The claim.' }], devices: ['talking_head', 'chart', 'hologram'], length_bucket: 'long', retention_risks: [], cta: 'Subscribe', audience: ['investor'], emotional_driver: 'anger', why_viral: 'Comments high.' };
}

export const ADAPTATION = {
  topic: 'Buying a competitor with its own cash flow',
  angle: 'The scorecard every owner should run before an offer: the 1.5x test.',
  icp: 'ceiling',
  original_skeleton: [{ role: 'hook', summary: 'The result.' }, { role: 'proof', summary: 'The scorecard.' }, { role: 'cta', summary: 'Follow.' }],
  beats: [
    { role: 'hook', original: 'This deal made 2 million', ours: 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.', why: 'Proof swap to Josh\'s real facts.', legend: 'Gary Halbert', legend_note: 'Specific and true.' },
    { role: 'proof', original: 'The scorecard', ours: 'Here is the scorecard: the 1.5x test, commercial debt, seller finance and seller rollover.', why: 'Mechanism.', legend: 'Eugene Schwartz', legend_note: 'Name the mechanism.' },
    { role: 'cta', original: 'Follow', ours: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.', why: 'Our CTA.', legend: 'Dan Kennedy', legend_note: 'One next step.' },
  ],
  hooks: ['Banks don\'t reject buyers. They reject structures.', 'Run this scorecard before you make an offer.', 'Both sellers financed 100% of the price.', 'The 1.5x test decides what the bank will fund.', 'Agree the shape with the seller first.'],
};
export const SCRIPT = {
  hooks: ['Banks don\'t reject buyers. They reject structures.', 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.', 'The reason your offer went nowhere had nothing to do with price.'],
  hook_index: 1,
  beats: [{ layout: 'vertical', text: 'I bought my clinics in two acquisitions. Both sellers financed 100% of the price.', cue: 'Calm', on_screen: 'Two acquisitions', screen: '' }, { layout: 'vertical', text: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.', cue: '', on_screen: 'Apply below', screen: '' }],
  titles: ['How Owners Buy a Competitor', 'Seller First', 'The Order That Works'], thumbnail: 'Seller first', description: 'Apply: {APPLY_LINK}\nNot legal, tax or financial advice.', cta: 'Apply through the link below. If it\'s a fit, the team books a strategy call to look at your numbers.',
};

/** One fake model for every prompt kind, decided by the system prompt; counts its calls per kind. */
export function fakeModel(o: { judge?: (n: number) => Record<string, number>; adaptation?: (n: number) => unknown } = {}) {
  const calls = { extract: 0, name: 0, adapt: 0, judge: 0, script: 0 };
  const ask = async (system: string, messages: { role: string; content: string }[]) => {
    const user = messages[0].content;
    if (system.startsWith('You are a content analyst')) { calls.extract++; const title = /Title: (.*)/.exec(user)?.[1] ?? ''; return JSON.stringify(extractionFor(title)); }
    if (system.startsWith('You name content formats')) { calls.name++; return JSON.stringify({ name: 'Named — format!', definition: 'Line one.\nLine two.\nLine three.' }); }
    if (system.startsWith('You adapt viral')) { calls.adapt++; return JSON.stringify(o.adaptation ? o.adaptation(calls.adapt) : ADAPTATION); }
    if (system.startsWith('You are a blind judge')) { calls.judge++; return JSON.stringify({ scores: o.judge ? o.judge(calls.judge) : { hook: 8, specificity: 8, mechanism: 9, proof_honesty: 9, cta: 8 }, notes: ['Make the hook more specific.'], verdict: 'Good.' }); }
    calls.script++; return JSON.stringify(SCRIPT);
  };
  return { ask, calls };
}
