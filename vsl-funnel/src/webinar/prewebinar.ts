import type { PW, PwOrder } from './prewebinar-kit';
import { PW_A, PW_A_ORDER } from './prewebinar-a';
import { PW_B, PW_B_ORDER } from './prewebinar-b';
import { PW_C, PW_C_ORDER } from './prewebinar-c';
import { PW_D, PW_D_ORDER } from './prewebinar-d';
import { PW_E, PW_E_ORDER } from './prewebinar-e';

/**
 * The pre-webinar run: from registration until the session, up to 15 emails a day for 14 days.
 *  Days 1–3   why this session, why you (prewebinar-a)
 *  Days 4–6   how the money works: Capital and Capabilities (-b)
 *  Days 7–9   finding and closing the deal, and what it builds (-c)
 *  Days 10–12 the doubts (-d)
 *  Days 13–14 show up ready (-e)
 * Someone who registers closer to the session gets fewer: the highest-priority emails that fit,
 * still in story order, with the show-up-ready emails last.
 */
export const PREWEBINAR_TEMPLATES: Record<string, PW> = { ...PW_A, ...PW_B, ...PW_C, ...PW_D, ...PW_E };
export const PREWEBINAR_ORDER: PwOrder = [...PW_A_ORDER, ...PW_B_ORDER, ...PW_C_ORDER, ...PW_D_ORDER, ...PW_E_ORDER];
export const PREWEBINAR_IDS = PREWEBINAR_ORDER.map(([t]) => t);
/** The closing block always lands at the end of whatever run there's room for. */
const CLOSING = new Set(PW_E_ORDER.map(([t]) => t));

/** Emails for a run with `slots` send times, skipping ones this person already got (an earlier registration). */
export function prewebinarPlan(slots: number, alreadySent: Set<string> = new Set()): string[] {
  const all = PREWEBINAR_ORDER.map(([t, priority], i) => ({ t, priority, i })).filter((x) => !alreadySent.has(x.t));
  if (slots >= all.length) return all.map((x) => x.t);
  // Reserve a share for the closing block so a short run still ends on "show up ready".
  const closing = all.filter((x) => CLOSING.has(x.t));
  const body = all.filter((x) => !CLOSING.has(x.t));
  const nClose = Math.min(closing.length, Math.max(1, Math.round(slots * 0.25)));
  const pick = (xs: typeof all, n: number) => [...xs].sort((a, b) => a.priority - b.priority || a.i - b.i).slice(0, Math.max(0, n));
  // The latest closing emails are the most time-specific ("tomorrow", "tonight"): keep them first among equals.
  const close = [...closing].sort((a, b) => a.priority - b.priority || b.i - a.i).slice(0, nClose);
  return [...pick(body, slots - close.length), ...close].sort((a, b) => a.i - b.i).map((x) => x.t);
}
