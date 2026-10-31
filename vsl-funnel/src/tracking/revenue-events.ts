import type { Runtime } from '../app';
import { ECONOMICS } from '../config';
import { isMillionPlus } from '../sales/qualify';
import { type TrackIdentity, track } from './track';

/**
 * Revenue-qualified conversions for ad audiences and bidding. Each band is its own Meta event
 * (build an audience or lookalike per band), plus "$1M+" overall and per funnel, plus "$10M+".
 * Under $1M gets its own event too, so it can be excluded from audiences.
 */
export const BAND_EVENT: Record<string, string> = {
  '<1m': 'RevenueUnder1M',
  '1m-3m': 'Revenue1to3M',
  '3m-10m': 'Revenue3to10M',
  '10m+': 'Revenue10MPlus',
  '10m-25m': 'Revenue10to25M',
  '25m-50m': 'Revenue25to50M',
  '50m-100m': 'Revenue50to100M',
  '100m+': 'Revenue100MPlus',
};
const TEN_PLUS = new Set(['10m+', '10m-25m', '25m-50m', '50m-100m', '100m+']);

/** Estimated value per band (a share of the programme price), so value-based bidding favours bigger owners. */
const BAND_VALUE: Record<string, number> = { '<1m': 0, '1m-3m': 0.03, '3m-10m': 0.06, '10m+': 0.1, '10m-25m': 0.1, '25m-50m': 0.12, '50m-100m': 0.12, '100m+': 0.12 };
export const bandValue = (band: unknown) => Math.round(ECONOMICS.programPrice * (BAND_VALUE[String(band)] ?? 0));

/** Meta event for one of our revenue events (null = not sent to Meta). */
export function revenueMetaName(name: string, props: Record<string, unknown>): string | undefined {
  if (name === 'revenue_band') return BAND_EVENT[String(props.band)];
  if (name === 'qualified_1m_plus') return props.funnel === 'webinar' ? 'WebinarQualified1MPlus' : props.funnel === 'application' ? 'ApplicationQualified1MPlus' : 'Qualified1MPlus';
  if (name === 'qualified_any_1m_plus') return 'Qualified1MPlus';
  if (name === 'qualified_10m_plus') return 'Qualified10MPlus';
  return undefined;
}

export const REVENUE_EVENT_NAMES = new Set(['revenue_band', 'qualified_1m_plus', 'qualified_any_1m_plus', 'qualified_10m_plus']);

/** Fire the band event, then the $1M+ events (overall and for this funnel) and $10M+ when they apply. */
export async function trackRevenueEvents(rt: Runtime, who: TrackIdentity, band: string | null, funnel: 'webinar' | 'application' | 'challenge', path: string) {
  if (!band || !BAND_EVENT[band]) return;
  const props = { band, funnel };
  await track(rt, who, { name: 'revenue_band', source: 'server', path, props });
  if (!isMillionPlus(band)) return;
  await track(rt, who, { name: 'qualified_any_1m_plus', source: 'server', path, props });
  await track(rt, who, { name: 'qualified_1m_plus', source: 'server', path, props });
  if (TEN_PLUS.has(band)) await track(rt, who, { name: 'qualified_10m_plus', source: 'server', path, props });
}
