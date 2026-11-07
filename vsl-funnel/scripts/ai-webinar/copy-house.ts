// The house rules auditCopy doesn't cover on its own, shared by the script audit (audit-script.ts) and the presented
// deck's audit (present/audit-deck.ts): no dashes, no exclamation marks, no "free", no liveness or invented scarcity,
// no promised results, example numbers labelled illustrative on the same slide, seller rollover named with funding.
// Facts from the approved list that carry a number without being an example (see WEBINAR-NOTES.md).
export const FACTS = [
  /\b(a|one) million (dollars )?a year( in revenue)?/gi, /\bunder a million\b/gi, /\$1M\+?( a year)?/g, /\bmore than a million\b/gi, /\bover a million\b/gi,
  /five (to|or) six million/gi, /5-6m/gi, /five and a half million dollar radiology deal/gi, /\$5\.5M( radiology)?/g, /over five million/gi, /over \$5M/gi, /\bmillion or more\b/gi, /\b(a|one) million (dollars )?(or more )?a year/gi,
  /\bninety owners\b/gi, /\b90 owners\b/gi,
];
// The approved proof from Josh's Dealmaker deck (owner decision 2026-11-07): real, attributed numbers, never examples, so
// they need no "illustrative" label. Each line is allowed only in its exact wording, and a client's result only on a
// slide that also carries the typicality line ("not a promise of yours"); Josh's own claims are said by him or
// attributed to him. Any other number on those slides is still checked.
const TYPICAL = /not a promise of yours/i;
export const PROOF: { re: RegExp; needs?: RegExp }[] = [
  // Josh's own statements (deck slides 11, 12, 37)
  ...[/more than thirty million dollars of deals/gi, /more than a hundred million dollars in transactions/gi, /^\$100M\+$/g,
    /\$0 of his own money in/gi, /about \$150K out in year one/gi, /about a hundred and fifty thousand dollars/gi, /about thirteen thousand customers/gi, /about a thousand cold calls/gi].map((re) => ({ re })),
  // Clients' results (deck slides 13, 85 to 89, 91), each beside the typicality line
  ...[/his first deal was five and a half million dollars/gi, /two hundred million dollar exit/gi, /the \$200M radiology network exit/gi, /this LOI: a \$7M revenue business/gi, /on an \$850K purchase/gi,
    /eight hundred and fifty thousand dollars/gi, /about \$3\.8M turnover/gi, /turning over about three point eight million/gi, /\$508K combined EBITDA/gi,
    /about half a million a year in combined profit/gi, /a \$2\.4M deal/gi, /a two point four million dollar deal/gi, /a \$4\.4M acquisition/gi,
    /a four point four million dollar acquisition/gi, /on a \$23M business/gi, /on a twenty-three million dollar business/gi, /700K over 7 years/gi,
    /seven hundred thousand over seven years/gi].map((re) => ({ re, needs: TYPICAL })),
];
export const MONEY = /\$\s?\d|\b\d[\d,.]*\s?(k|m|million|thousand)\b|\b(million|thousand)\b/i;
export const FUNDING = /\b(seller finance|seller's note|commercial debt|a lender|the lender)\b[^.]*\b(pa(y|id|ys)|fund|price)\b|\bfunded\b|\bfunding\b|\bpays? (for itself|the price)\b|\bthe price (is|gets) paid\b/i;
export const extra = (t: string, where: string, ctx: string): string[] => {
  const out: string[] = [];
  if (/[—–]/.test(t)) out.push(`${where}: em or en dash`);
  if (/!/.test(t)) out.push(`${where}: exclamation mark`);
  if (/\bfree\b/i.test(t)) out.push(`${where}: "free"`);
  if (/\b(live|attendees right now|people watching|spots? left|seats? left|only \d+ left|today only|expires? (tonight|today))\b/i.test(t)) out.push(`${where}: liveness or scarcity word`);
  if (/\b(guaranteed|you will (close|own|sign|get funded|buy))\b/i.test(t)) out.push(`${where}: promised result`);
  if (/\btestimonial\b/i.test(t)) out.push(`${where}: testimonial`);
  // An example number needs "illustrative" on the same slide (spoken or on screen), unless it's an approved fact.
  let bare = t; for (const re of FACTS) bare = bare.replace(re, '');
  for (const p of PROOF) if (!p.needs || p.needs.test(ctx)) bare = bare.replace(p.re, '');
  if (MONEY.test(bare) && !/illustrat/i.test(ctx)) out.push(`${where}: number without "illustrative" on the slide: ${bare.match(MONEY)?.[0]}`);
  // Whenever funding is described, seller rollover is named on the same slide.
  if (FUNDING.test(t) && !/rollover/i.test(ctx)) out.push(`${where}: funding described without seller rollover on the slide`);
  return out;
};

