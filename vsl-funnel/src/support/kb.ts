import type { Runtime } from '../app';
import { FAQS } from '../config';
import { MATERIAL_IDS } from '../admin/materials';
import { DEPOSIT_REFUND_TERMS, depositConfig } from '../sales/deposit';
import { GUARANTEE_DEFINITIONS, guarantee } from '../sales/guarantee';
import { GUIDES } from '../seo/guides';
import { DEAL_SPRINT_COPY, DEAL_SPRINT_DELIVERABLES } from '../webinar/deal-sprint';

/**
 * The support knowledge base, built only from our own content: the guides (src/seo/guides), the scripts and
 * decks (public/materials/*.md, read from static assets at run time), the guarantee with its conditions, the
 * FAQ and the offer terms. Passages are retrieved by plain keyword scoring (no external service), and every
 * draft cites the passages it used.
 */

export interface Passage { id: string; title: string; url: string | null; internal: boolean; text: string; /** Policy passages (the guarantee, offer terms) outrank guides that mention the same words. */ weight?: number }

const strip = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\*\*|__|`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[ \t]+/g, ' ').trim();

/** Split markdown into heading-led chunks of at most ~1,400 characters. */
export function chunkMarkdown(md: string, max = 1400): { heading: string; text: string }[] {
  const out: { heading: string; text: string }[] = [];
  let heading = '';
  let buf: string[] = [];
  const flush = () => {
    const text = strip(buf.join('\n')).replace(/\n{3,}/g, '\n\n');
    for (let i = 0; i < text.length; i += max) if (text.slice(i, i + max).trim().length > 40) out.push({ heading, text: text.slice(i, i + max) });
    buf = [];
  };
  for (const line of md.split('\n')) {
    const h = /^#{1,3}\s+(.+)/.exec(line);
    if (h) { flush(); heading = strip(h[1]); continue; }
    buf.push(line);
  }
  flush();
  return out;
}

/** Everything that doesn't need a network fetch (guides, guarantee, FAQ, offer terms). */
export function staticPassages(rt: Pick<Runtime, 'settings' | 'origin'>): Passage[] {
  const out: Passage[] = [];
  const g = guarantee(rt);
  out.push({ id: 'guarantee', weight: 1.6, title: `The guarantee: ${g.headline}`, url: g.url, internal: false, text: [g.body, 'Conditions:', ...g.conditions, ...GUARANTEE_DEFINITIONS, `${g.moneyBack.headline}: ${g.moneyBack.body}`, 'Both guarantees cover the engagement and do not conflict: the 7-day money-back guarantee applies first, then the LOI guarantee.'].join('\n') });
  const dep = depositConfig(rt as Runtime);
  out.push({
    id: 'offer-deposit', weight: 1.4, title: 'Engagement deposit terms', url: g.url, internal: false,
    text: `The engagement deposit is ${dep.label}. It locks the buyer's engagement place for this intake and is credited in full against the engagement fee; the balance is due on signing the engagement agreement after a short onboarding call. ${DEPOSIT_REFUND_TERMS}`,
  });
  out.push({
    id: 'offer-sprint', weight: 1.4, title: 'First Deal Sprint: what is delivered', url: null, internal: false,
    text: [`The First Deal Sprint runs for 7 days.`, ...DEAL_SPRINT_DELIVERABLES.map((d) => `Day ${d.day}: ${d.title}. ${d.body}`), ...Object.values(DEAL_SPRINT_COPY).filter((v): v is string => typeof v === 'string').map(strip)].join('\n'),
  });
  out.push({
    id: 'offer-engagement', weight: 1.4, title: 'Advisory engagement terms', url: null, internal: false,
    text: 'The advisory engagement is done with you over 90 days on the 3C model: capabilities, capital and closing. The fee depends on the size of the business and is set in the engagement agreement. Deals are funded with commercial debt, seller finance and seller rollover, and tested at about 1.5x debt service coverage.',
  });
  FAQS.forEach((f, i) => out.push({ id: `faq-${i + 1}`, title: `FAQ: ${strip(f.q)}`, url: null, internal: false, text: `${strip(f.q)}\n${strip(f.a)}` }));
  for (const gd of GUIDES) {
    const url = `${rt.origin}/guides/${gd.slug}`;
    out.push({ id: `guide-${gd.slug}`, title: gd.title, url, internal: false, text: [gd.answer, ...gd.keyPoints, ...gd.faqs.map((f) => `${f.q} ${f.a}`)].map(strip).join('\n') });
    chunkMarkdown(gd.body).forEach((c, i) => out.push({ id: `guide-${gd.slug}-${i + 1}`, title: `${gd.title}${c.heading ? `: ${c.heading}` : ''}`, url, internal: false, text: c.text }));
  }
  return out;
}

/** The scripts and decks (admin-only files), read through the static assets binding. Missing binding = none. */
export async function materialPassages(rt: Runtime): Promise<Passage[]> {
  const assets = rt.env.ASSETS;
  if (!assets) return [];
  const out: Passage[] = [];
  await Promise.all(MATERIAL_IDS.map(async (id) => {
    const res = await assets.fetch(new Request(`${rt.origin}/materials/${id}.md`)).catch(() => null);
    if (!res?.ok) return;
    chunkMarkdown(await res.text()).forEach((c, i) => out.push({ id: `material-${id}-${i + 1}`, title: `Material ${id}${c.heading ? `: ${c.heading}` : ''}`, url: `/materials/${id}.md`, internal: true, text: c.text }));
  }));
  return out;
}

let cache: { at: number; origin: string; passages: Passage[] } | null = null;
export async function knowledgeBase(rt: Runtime): Promise<Passage[]> {
  if (cache && cache.origin === rt.origin && Date.now() - cache.at < 10 * 60_000) return cache.passages;
  const passages = [...staticPassages(rt), ...(await materialPassages(rt))];
  cache = { at: Date.now(), origin: rt.origin, passages };
  return passages;
}

const STOP = new Set('the and for are but not you your yours with this that from have has was were will what when where which who how why can could would should about into than then them they their there here our out all any its it’s also just get got does did doing been being more most some such only own same very too off over under again once each few both other a an of to in on is it be as at by or if so do no up we i me my'.split(' '));
export const terms = (s: string) => (s.toLowerCase().normalize('NFKD').match(/[a-z0-9$.]+/g) ?? []).map((w) => w.replace(/\.+$/, '')).filter((w) => w.length >= 3 && !STOP.has(w));

/** Top passages for a question: TF-IDF over the passages, with a bump for title matches. */
export function retrieve(passages: Passage[], question: string, k = 6): (Passage & { score: number })[] {
  const q = [...new Set(terms(question))];
  if (!q.length) return [];
  const docs = passages.map((p) => ({ p, words: terms(`${p.title} ${p.text}`), title: new Set(terms(p.title)) }));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of new Set(d.words)) df.set(w, (df.get(w) ?? 0) + 1);
  const N = docs.length;
  return docs.map((d) => {
    let score = 0;
    for (const w of q) {
      const tf = d.words.filter((x) => x === w).length;
      if (!tf) continue;
      const idf = Math.log(1 + N / (df.get(w) ?? 1));
      score += (1 + Math.log(tf)) * idf + (d.title.has(w) ? idf : 0);
    }
    return { ...d.p, score: (score * (d.p.weight ?? 1)) / Math.sqrt(1 + d.words.length / 200) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}
