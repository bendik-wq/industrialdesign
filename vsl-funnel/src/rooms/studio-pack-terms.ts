/**
 * The offer pack's real prices and terms (see studio-pack.ts): read from settings and product config only, so
 * the stack, the comparison, the two paths and the generosity line can't show a price we don't charge.
 */

import type { Runtime } from '../app';
import { FEE_BY_REVENUE } from '../sales/contracts';
import { DEPOSIT_REFUND_TERMS, depositConfig } from '../sales/deposit';
import { GUARANTEE_HEADLINE, MONEY_BACK_HEADLINE } from '../sales/guarantee';
import { challengeConfig } from '../challenge/cohorts';
import { liveSettings } from '../live/events';
import { passConfig } from '../webinar/pass';
import { PACK_COPY, type PackSettings, type PriceKey } from './studio-pack';

// ───────────── real prices and real terms ─────────────

const k = (n: number) => (n % 1000 === 0 ? `$${n / 1000}K` : `$${n.toLocaleString('en-US')}`);
/** The engagement fee by size (contracts.ts), for the bands the live funnels sell to ($1M to $50M). */
export const feeBands = () => [
  { band: '1_3m', range: '$1M to $3M' }, { band: '3_10m', range: '$3M to $10M' }, { band: '10_25m', range: '$10M to $25M' }, { band: '25_50m', range: '$25M to $50M' },
].map((b) => ({ ...b, fee: FEE_BY_REVENUE[b.band], label: k(FEE_BY_REVENUE[b.band]) }));

export interface PackPrices {
  deposit: string; depositCap: number | null;
  engagement: string; fees: { range: string; label: string }[];
  sprint: { name: string; label: string } | null;
  ticket: string | null;
}
/** Only prices of things we sell, read from settings and product config. A product that isn't on sale has no price here. */
export function packPrices(rt: Pick<Runtime, 'settings' | 'origin'>, roomKind: string | null): PackPrices {
  const s = rt.settings as unknown as Partial<Record<string, string>>;
  const dep = depositConfig(rt as Runtime);
  const pass = passConfig(rt.settings);
  const sprintOn = String(s.WEBINAR_PASS ?? '').trim().toLowerCase() !== 'off' && Boolean(String(s.WHOP_API_KEY ?? '').trim());
  const bands = feeBands(), lo = bands[0].fee, hi = bands[bands.length - 1].fee;
  let ticket: string | null = null;
  if (roomKind === 'live') ticket = liveSettings(rt).ticket?.label ?? null;
  else if (roomKind === 'challenge') { const c = challengeConfig(s); ticket = c.ticket > 0 ? c.ticketLabel : null; }
  return {
    deposit: dep.label, depositCap: dep.cap,
    engagement: `${k(lo)} to ${k(hi)}`, fees: bands.map((b) => ({ range: b.range, label: b.label })),
    sprint: sprintOn ? { name: pass.offerName, label: pass.priceLabel } : null,
    ticket,
  };
}
/** The text a stack line's price key shows (null: no price on that line). */
export function priceText(p: PackPrices, key: PriceKey): string | null {
  if (key === 'engagement') return `${p.engagement} by size`;
  if (key === 'deposit') return `${p.deposit} deposit`;
  if (key === 'sprint') return p.sprint ? `${p.sprint.name} ${p.sprint.label}` : null;
  if (key === 'ticket') return p.ticket ? `${p.ticket} ticket` : null;
  return null;
}

/** Days in a term, read from the term's own wording (so the line can't drift from the real term). */
const daysIn = (s: string, re: RegExp, dflt: number) => Number(re.exec(s)?.[1] ?? dflt);
export const moneyBackDays = () => daysIn(MONEY_BACK_HEADLINE, /(\d+)-day/, 7);
export const refundDays = () => daysIn(DEPOSIT_REFUND_TERMS, /within (\d+) days/, 14);

/** Why the terms are this generous, in plain words, built from the real terms. */
export function generosity(p: PackPrices) {
  const terms = [
    `the ${p.deposit} deposit is credited in full against the fee`,
    p.ticket ? `your ${p.ticket} ticket comes off it` : null,
    'it is refunded if you decide not to sign',
    `you have ${moneyBackDays()} days money-back after signing`,
  ].filter(Boolean) as string[];
  const list = terms.length > 1 ? `${terms.slice(0, -1).join(', ')}, and ${terms[terms.length - 1]}` : terms[0];
  return {
    short: `Why the terms are this generous: ${list}.`,
    reason: 'Josh’s team would rather you decide after the onboarding call, with your money still refundable, than under pressure in this session.',
    lines: [
      `The ${p.deposit} deposit is credited in full against the engagement fee.`,
      ...(p.ticket ? [`Your ${p.ticket} ticket comes off the deposit.`] : []),
      `Refundable in full if you decide not to sign: tell the team within ${refundDays()} days of your onboarding call.`,
      `After you sign, the ${MONEY_BACK_HEADLINE.toLowerCase()}, then ${GUARANTEE_HEADLINE.charAt(0).toLowerCase() + GUARANTEE_HEADLINE.slice(1)}, with its conditions.`,
      ...(p.sprint ? [`The ${p.sprint.name} (${p.sprint.label}) is credited in full against the engagement if you continue.`] : []),
      ...(p.depositCap ? [`Places are capped at ${p.depositCap} a week because the same team works on every deal.`] : []),
    ],
  };
}

/** What room-studio.js and room-offer.js need in the page config (static per page; the step comes with the room's view). */
export function packConfig(rt: Pick<Runtime, 'settings' | 'origin'>, room: { ref_type: string }, pack: PackSettings) {
  const prices = packPrices(rt, room.ref_type);
  const stack = pack.stack.map((x) => ({ objection: x.objection, title: x.title, price: priceText(prices, x.price) }));
  return {
    copy: PACK_COPY,
    offerCard: pack.offerCard,
    bridgeLine: pack.bridgeLine,
    stack: {
      heading: pack.stackHeading, items: stack,
      reveal: {
        today: `${prices.deposit} deposit today`,
        credit: 'Credited in full against the engagement fee.',
        fees: prices.fees,
        balance: 'The balance is due when you sign the engagement agreement, after a short onboarding call.',
        ticket: prices.ticket ? `Your ${prices.ticket} ticket comes off the deposit.` : null,
      },
    },
    anchor: {
      heading: pack.anchorHeading, rows: pack.anchor,
      ours: { label: 'The engagement with Josh’s team', figure: `${prices.engagement} by size`, note: `${prices.deposit} deposit today, credited in full, and refunded if you decide not to sign.` },
    },
    why: generosity(prices),
    prices,
  };
}
