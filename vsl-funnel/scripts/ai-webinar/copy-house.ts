// The house rules auditCopy doesn't cover on its own, shared by the script audit (audit-script.ts) and the presented
// deck's audit (present/audit-deck.ts): no dashes, no exclamation marks, no "free", no liveness or invented scarcity,
// no promised results, example numbers labelled illustrative on the same slide, seller rollover named with funding.
// Facts from the approved list that carry a number without being an example (see WEBINAR-NOTES.md).
export const FACTS = [
  /\b(a|one) million (dollars )?a year( in revenue)?/gi, /\bunder a million\b/gi, /\$1M\+?( a year)?/g, /\bmore than a million\b/gi, /\bover a million\b/gi,
  /five (to|or) six million/gi, /5-6m/gi, /five and a half million dollar radiology deal/gi, /\$5\.5M( radiology)?/g, /over five million/gi, /over \$5M/gi, /\bmillion or more\b/gi, /\b(a|one) million (dollars )?(or more )?a year/gi,
  /\bninety owners\b/gi, /\b90 owners\b/gi,
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
  if (MONEY.test(bare) && !/illustrat/i.test(ctx)) out.push(`${where}: number without "illustrative" on the slide: ${bare.match(MONEY)?.[0]}`);
  // Whenever funding is described, seller rollover is named on the same slide.
  if (FUNDING.test(t) && !/rollover/i.test(ctx)) out.push(`${where}: funding described without seller rollover on the slide`);
  return out;
};

