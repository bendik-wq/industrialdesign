/**
 * 100 landers: 20 industries × 5 headline angles. Each one keeps the same VSL,
 * application and offer, and changes the words above the video so an owner
 * sees their own world in the first second.
 *
 * Copy rules (same as everywhere): no invented numbers or results, no promise
 * beyond the offer (signed LOI within 90 days on an acquisition that can double
 * or triple the business; no money down; over-financed; ~1.5x DSCR; 7-day
 * money-back guarantee; done with you). <em> renders in the accent colour.
 */
export interface Industry {
  id: string;
  /** Who: "clinic owners". */
  owners: string;
  /** One business: "clinic". */
  one: string;
  /** Several: "clinics". */
  many: string;
  /** What they'd buy: "the practice across town". */
  target: string;
  /** Words that identify the industry in Meta campaign / ad set / ad names. */
  keywords: string[];
  /** Label in the dashboard. */
  label: string;
}

export const INDUSTRIES: Industry[] = [
  { id: 'medical', label: 'Medical & GP clinics', owners: 'clinic owners', one: 'clinic', many: 'clinics', target: 'the practice across town', keywords: ['medical', 'gp', 'clinic', 'doctor', 'health'] },
  { id: 'dental', label: 'Dental', owners: 'dental practice owners', one: 'dental practice', many: 'dental practices', target: 'the practice two suburbs over', keywords: ['dental', 'dentist', 'ortho'] },
  { id: 'allied-health', label: 'Allied health', owners: 'allied health owners', one: 'allied health practice', many: 'physio and allied health practices', target: 'the physio or podiatry practice down the road', keywords: ['physio', 'podiat', 'allied', 'chiro', 'psych', 'optom'] },
  { id: 'veterinary', label: 'Veterinary', owners: 'vet clinic owners', one: 'vet clinic', many: 'vet clinics', target: 'the clinic the next town over', keywords: ['vet', 'animal', 'pet'] },
  { id: 'hvac', label: 'HVAC', owners: 'HVAC business owners', one: 'HVAC business', many: 'HVAC businesses', target: 'the HVAC company you keep bidding against', keywords: ['hvac', 'air con', 'aircon', 'heating', 'cooling', 'refrigeration'] },
  { id: 'plumbing', label: 'Plumbing', owners: 'plumbing business owners', one: 'plumbing business', many: 'plumbing businesses', target: 'the plumbing business whose owner wants out', keywords: ['plumb', 'drain', 'gas fitt'] },
  { id: 'electrical', label: 'Electrical', owners: 'electrical contractors', one: 'electrical business', many: 'electrical businesses', target: 'the electrical contractor down the road', keywords: ['electric', 'sparky', 'electrician'] },
  { id: 'roofing-solar', label: 'Roofing & solar', owners: 'roofing and solar owners', one: 'roofing business', many: 'roofing and solar businesses', target: 'the roofer whose owner is ready to retire', keywords: ['roofing', 'roofer', 'roof', 'solar', 'gutter'] },
  { id: 'landscaping', label: 'Landscaping', owners: 'landscaping business owners', one: 'landscaping business', many: 'landscaping businesses', target: 'the landscaping crew across the city', keywords: ['landscap', 'garden', 'lawn', 'turf'] },
  { id: 'cleaning', label: 'Commercial cleaning', owners: 'cleaning business owners', one: 'cleaning business', many: 'cleaning businesses', target: 'the cleaning company with the contracts you want', keywords: ['clean', 'janitor', 'facility'] },
  { id: 'security', label: 'Security', owners: 'security business owners', one: 'security business', many: 'security businesses', target: 'the security firm with the sites next to yours', keywords: ['security', 'guard', 'alarm', 'cctv'] },
  { id: 'accounting', label: 'Accounting', owners: 'accounting firm owners', one: 'firm', many: 'accounting firms', target: 'the retiring partner’s book of clients', keywords: ['account', 'bookkeep', 'cpa', 'tax'] },
  { id: 'insurance', label: 'Insurance brokerage', owners: 'insurance brokers', one: 'brokerage', many: 'brokerages', target: 'the book of a broker who wants out', keywords: ['insurance', 'broker'] },
  { id: 'it-services', label: 'IT & managed services', owners: 'IT services owners', one: 'MSP', many: 'IT and managed service businesses', target: 'the MSP with clients next to yours', keywords: ['msp', 'it services', 'managed service', 'tech support', 'cyber'] },
  { id: 'agencies', label: 'Marketing agencies', owners: 'agency owners', one: 'agency', many: 'agencies', target: 'the agency with the clients you want', keywords: ['agency', 'marketing', 'seo', 'media', 'creative'] },
  { id: 'recruitment', label: 'Recruitment & staffing', owners: 'recruitment agency owners', one: 'recruitment agency', many: 'recruitment and staffing agencies', target: 'the agency that owns your next niche', keywords: ['recruit', 'staffing', 'labour hire', 'labor hire', 'talent'] },
  { id: 'hospitality', label: 'Hospitality & restaurants', owners: 'hospitality owners', one: 'venue', many: 'venues and restaurants', target: 'the venue that’s been on your radar', keywords: ['hospitality', 'restaurant', 'cafe', 'venue', 'bar', 'food'] },
  { id: 'childcare', label: 'Childcare & education', owners: 'childcare centre owners', one: 'centre', many: 'childcare centres', target: 'the centre in the next suburb', keywords: ['childcare', 'early learning', 'daycare', 'tutoring', 'education'] },
  { id: 'logistics', label: 'Logistics & freight', owners: 'logistics business owners', one: 'logistics business', many: 'transport and logistics businesses', target: 'the carrier on the routes you want', keywords: ['logistic', 'freight', 'transport', 'trucking', 'courier', 'supply chain'] },
  { id: 'property', label: 'Property management', owners: 'property management owners', one: 'rent roll', many: 'rent rolls and property managers', target: 'the rent roll of an agency winding down', keywords: ['property', 'real estate', 'rent roll', 'strata'] },
];

export interface Angle {
  id: string;
  label: string;
  pre: (i: Industry) => string;
  headline: (i: Industry) => string;
  sub: (i: Industry) => string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const SUB_TAIL = 'Structured at a DSCR of around 1.5x, done with you, and backed by a 7-day money-back guarantee.';

export const ANGLES: Angle[] = [
  {
    id: 'loi',
    label: 'Signed LOI in 90 days',
    pre: (i) => `For <strong>${i.owners}</strong> doing $1M+`,
    headline: (i) => `Get a signed LOI in 90 days on a <em><span class="nw">no-money-down</span> acquisition</em> that doubles or triples your ${i.one}.`,
    sub: () => `Josh Li works with you to find the target and structure financing that covers the full price, with over-financing built in. ${SUB_TAIL}`,
  },
  {
    id: 'competitor',
    label: 'Buy the competitor',
    pre: (i) => `For <strong>${i.owners}</strong> doing $1M+`,
    headline: (i) => `Buy ${i.target} with <em>no money down</em>, and have a signed LOI within 90 days.`,
    sub: () => `Seller finance plus senior debt covers more than the purchase price, so none of your own cash goes in. ${SUB_TAIL}`,
  },
  {
    id: 'retiring',
    label: 'Retiring owners',
    pre: (i) => `${cap(i.owners)}: the next decade of growth is for sale`,
    headline: (i) => `Many ${i.owners} are looking for a way out. <em>Buy their ${i.many}</em> with seller finance and no money down.`,
    sub: () => `We help you find the owners ready to step back, structure a deal they say yes to, and line up the financing. Signed LOI in 90 days. ${SUB_TAIL}`,
  },
  {
    id: 'ceiling',
    label: 'Growth ceiling',
    pre: (i) => `For <strong>${i.owners}</strong> who’ve hit a ceiling`,
    headline: (i) => `Your ${i.one} has outgrown organic growth. <em>Double or triple it</em> by buying the next one, with no money down.`,
    sub: () => `Skip years of hiring and marketing: acquire revenue, customers and a trained team in one deal, with a signed LOI in 90 days. ${SUB_TAIL}`,
  },
  {
    id: 'overfinanced',
    label: 'Over-financed',
    pre: (i) => `For <strong>${i.owners}</strong> doing $1M+`,
    headline: (i) => `How ${i.owners} are buying ${i.many} <em>with no money down</em>, and walking away with working capital.`,
    sub: () => `Over-financed deals: the seller finance and senior debt cover more than the price, and the extra funds working capital and closing costs. Signed LOI in 90 days. ${SUB_TAIL}`,
  },
];

export interface Lander {
  id: string;            // "<industry>.<angle>"
  industry: Industry;
  angle: Angle;
  preHeadline: string;
  headline: string;
  subheadline: string;
}

export const landerId = (industryId: string, angleId: string) => `${industryId}.${angleId}`;

export function getLander(id: string | null | undefined): Lander | null {
  if (!id) return null;
  const [ind, ang] = id.split('.');
  const industry = INDUSTRIES.find((x) => x.id === ind);
  const angle = ANGLES.find((x) => x.id === ang);
  if (!industry || !angle) return null;
  return { id: landerId(industry.id, angle.id), industry, angle, preHeadline: angle.pre(industry), headline: angle.headline(industry), subheadline: angle.sub(industry) };
}

export const ALL_LANDERS: Lander[] = INDUSTRIES.flatMap((i) => ANGLES.map((a) => getLander(landerId(i.id, a.id))!));

/** Industry from an explicit param, or from Meta campaign / ad set / ad names. */
export function inferIndustry(...texts: (string | null | undefined)[]): Industry | null {
  const hay = texts.filter(Boolean).join(' ').toLowerCase();
  if (!hay) return null;
  const exact = INDUSTRIES.find((i) => hay.split(/[^a-z0-9-]+/).includes(i.id));
  if (exact) return exact;
  let best: { i: Industry; len: number } | null = null;
  // Short keywords must match a whole word ("pet" must not match "competitor"); longer ones can be prefixes ("plumb" → "plumbing").
  const hit = (k: string) => (k.length <= 4 ? new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?([^a-z]|$)`).test(hay) : hay.includes(k));
  for (const i of INDUSTRIES) for (const k of i.keywords) if (hit(k) && (!best || k.length > best.len)) best = { i, len: k.length };
  return best?.i ?? null;
}
