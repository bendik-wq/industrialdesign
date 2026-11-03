/**
 * The Deal Plan's two paths (overnight loop round 4, research item 34): a conservative path (one small bolt-on now)
 * and an ambitious one (a 3-target roll-up), both built from the two numbers the person typed into their own Deal
 * Plan: the target's yearly cash flow before loan payments, and the yearly loan payments in their structure.
 *
 *  - Each path runs the 1.5x debt service coverage test on those numbers.
 *  - What we assume is labelled "illustrative": targets two and three the same size and structure as the first, a
 *    one-fifth fall in one business's cash flow as the stress case, and the 3-5x vs 8-12x multiple ranges.
 *  - Funding is described with commercial debt, seller finance and seller rollover named together.
 *  - Pure: the summary email (engage.ts) and the plan page (routes.ts) render it; auditCopy checks every line.
 */

export interface PathFigures {
  label: string; deals: number; cashFlow: number; debtService: number; ratio: number; passes: boolean;
  maxDebtService: number; leftAfter: number; stressRatio: number; stressPasses: boolean;
}
export interface TwoPaths { conservative: PathFigures; ambitious: PathFigures; perDealMax: number }

const STRESS = 0.2; // one business's cash flow falls by a fifth (illustrative)
const round2 = (x: number) => Math.round(x * 100) / 100;
export const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const x2 = (r: number) => `${r.toFixed(2)}x`;

/** Both paths from the person's two numbers, or null when either is missing. */
export function twoPaths(cashFlow: number | null, debtService: number | null): TwoPaths | null {
  if (cashFlow == null || debtService == null || !(cashFlow > 0) || !(debtService > 0)) return null;
  const path = (label: string, deals: number): PathFigures => {
    const cf = cashFlow * deals, ds = debtService * deals;
    const ratio = round2(cf / ds);
    const stressRatio = round2((cf - cashFlow * STRESS) / ds); // one of the businesses down a fifth
    return { label, deals, cashFlow: cf, debtService: ds, ratio, passes: ratio >= 1.5, maxDebtService: Math.round(cf / 1.5), leftAfter: Math.round(cf - ds), stressRatio, stressPasses: stressRatio >= 1.5 };
  };
  return { conservative: path('One small bolt-on now', 1), ambitious: path('A 3-target roll-up', 3), perDealMax: Math.round(cashFlow / 1.5) };
}

export const PATHS_COPY = {
  heading: 'Two paths from your numbers',
  intro: 'Both paths start from the two numbers in your Deal Plan. Each one runs the 1.5x test: cash flow before loan payments divided by the yearly loan payments.',
  conservativeName: 'Conservative: one small bolt-on now',
  conservativeWhat: 'Buy one business like the one in your plan, fold it into what you already run, and learn the process on one deal.',
  ambitiousName: 'Ambitious: a 3-target roll-up',
  ambitiousWhat: 'Buy three businesses like the one in your plan, one after another, each tested on its own before the next. The second and third targets are assumed to be the same size and structure as the first (illustrative).',
  funding: 'Funding in both paths: commercial debt against the target’s cash flow, seller finance and seller rollover. Agree the shape with the seller first, then take it to the lender.',
  multiple: 'Why the roll-up: a single owner-run business trades at around 3 to 5 times profit and a group of them at 8 to 12 times (illustrative ranges, not a forecast for your group).',
  note: 'Your two numbers are the only inputs. The extra targets, the one-fifth fall and the multiples are illustrative assumptions.',
  disclaimer: 'Education only, not legal, tax or financial advice.',
  rows: {
    cashFlow: 'Cash flow before loan payments, a year',
    debt: 'Loan payments, a year',
    test: 'The 1.5x test',
    max: 'Loan payments that pass at 1.5x',
    left: 'Left after loan payments, a year',
    stress: 'If one business’s cash flow falls by a fifth (illustrative)',
  },
  result: (r: number, ok: boolean) => (ok ? `${x2(r)}, passes` : `${x2(r)}, below 1.5x`),
  fails: (max: string) => `Below 1.5x the structure changes before a lender sees it: a longer seller note or more seller rollover, so payments come down to ${max} a year or less per deal.`,
};

/** The plain lines for the summary email. */
export function twoPathsText(cashFlow: number | null, debtService: number | null): string[] {
  const p = twoPaths(cashFlow, debtService);
  if (!p) return [];
  const C = PATHS_COPY;
  const line = (name: string, f: PathFigures) =>
    `${name}: ${usd(f.cashFlow)} of cash flow against ${usd(f.debtService)} of loan payments a year, ${C.result(f.ratio, f.passes)} on the 1.5x test, ${usd(f.leftAfter)} left after the payments; with one business’s cash flow down a fifth (illustrative), ${C.result(f.stressRatio, f.stressPasses)}.`;
  return [
    `${C.heading}. ${C.intro}`,
    line(C.conservativeName, p.conservative),
    line(`${C.ambitiousName} (targets two and three illustrative)`, p.ambitious),
    ...(p.conservative.passes ? [] : [C.fails(usd(p.perDealMax))]),
    C.funding,
    C.multiple,
    `${C.note} ${C.disclaimer}`,
  ];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The block on the plan page (room.css classes plus a few of its own, inline so room.css stays untouched). */
export function twoPathsHtml(cashFlow: number | null, debtService: number | null): string {
  const p = twoPaths(cashFlow, debtService);
  if (!p) return '';
  const C = PATHS_COPY, R = C.rows;
  const cell = (f: PathFigures) => [
    usd(f.cashFlow), usd(f.debtService),
    `<span class="${f.passes ? 'rm-ok' : 'rm-err'}">${esc(C.result(f.ratio, f.passes))}</span>`,
    usd(f.maxDebtService), usd(f.leftAfter),
    `<span class="${f.stressPasses ? 'rm-ok' : 'rm-err'}">${esc(C.result(f.stressRatio, f.stressPasses))}</span>`,
  ];
  const a = cell(p.conservative), b = cell(p.ambitious);
  const labels = [R.cashFlow, R.debt, R.test, R.max, R.left, R.stress];
  return `<section class="pp" aria-labelledby="pp-h">
<style>.pp{margin:28px 0 8px}.pp-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pp-col{padding:16px 0;border-top:1px solid #d2d2d7}.pp-col h3{margin:0 0 6px;font-size:16px}.pp-col p{margin:0 0 10px;font-size:14px;line-height:1.45}.pp table{width:100%;border-collapse:collapse;font-size:14px}.pp th{text-align:left;font-weight:400;color:#6e6e73;padding:6px 8px 6px 0;vertical-align:top}.pp td{text-align:right;padding:6px 0;font-variant-numeric:tabular-nums;white-space:nowrap}.pp tr+tr th,.pp tr+tr td{border-top:1px solid #e8e8ed}.pp-note{font-size:13px;color:#6e6e73;line-height:1.45}@media (max-width:640px){.pp-grid{grid-template-columns:1fr}}@media print{.pp-grid{grid-template-columns:1fr 1fr}}</style>
<h2 class="rm-h3" id="pp-h">${esc(C.heading)}</h2>
<p>${esc(C.intro)}</p>
<div class="pp-grid">
  <div class="pp-col"><h3>${esc(C.conservativeName)}</h3><p>${esc(C.conservativeWhat)}</p><table>${labels.map((l, i) => `<tr><th>${esc(l)}</th><td>${a[i]}</td></tr>`).join('')}</table></div>
  <div class="pp-col"><h3>${esc(C.ambitiousName)}</h3><p>${esc(C.ambitiousWhat)}</p><table>${labels.map((l, i) => `<tr><th>${esc(l)}</th><td>${b[i]}</td></tr>`).join('')}</table></div>
</div>
${p.conservative.passes ? '' : `<p class="rm-err">${esc(C.fails(usd(p.perDealMax)))}</p>`}
<p>${esc(C.funding)}</p>
<p>${esc(C.multiple)}</p>
<p class="pp-note">${esc(C.note)}</p>
</section>`;
}
