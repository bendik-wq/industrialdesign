/**
 * The offer pack (round 4): the studio's pitch scenes and the room's offer surfaces, built only from real terms.
 *
 *  - Pre-pitch transition ("bridge" scene): Josh on camera, no slides, one short line the host writes, and a run of
 *    show cue (PRE-PITCH). Entering it starts the pitch clock the directors see (server time).
 *  - The stack ("stack" scene): the engagement's parts appear one at a time, each with the objection it answers;
 *    the host advances with a key. Prices shown are only real prices of things we sell, resolved here from
 *    settings and product config (the deposit, the engagement fee by size, the First Deal Sprint, the ticket).
 *    The host picks which real price a line shows; nobody types a figure, and a line that carries a money figure
 *    or a "value" claim is refused. There is no "total value".
 *  - Price anchoring ("anchor" scene): honest alternatives, every figure labelled illustrative on screen and
 *    editable in Funnel HQ, next to our real price.
 *  - Two paths: the engagement deposit and the First Deal Sprint side by side as the pushed offer (per room).
 *  - Generosity rationale: one plain line on every offer surface saying why the terms are what they are, built
 *    from the real terms in code (deposit credit, ticket credit, the refund before signing, the 7-day money-back).
 *
 * Pure (no I/O). The real prices and terms are read in studio-pack-terms.ts. Checked by test/offer-pack.test.ts.
 */

import { auditCopy } from '../content/copy-rules';
import type { ApplyResult } from './state';

// ───────────── Funnel HQ settings (rooms.studio JSON, key "pack") ─────────────

export type PriceKey = 'none' | 'engagement' | 'deposit' | 'sprint' | 'ticket';
export const PRICE_KEYS: PriceKey[] = ['none', 'engagement', 'deposit', 'sprint', 'ticket'];
export type OfferCard = 'deposit' | 'paths';
export interface StackItem { objection: string; title: string; price: PriceKey }
export interface AnchorRow { label: string; figure: string; note: string }
export interface PackSettings {
  /** What the room pushes as its offer: the deposit card, or the deposit and the Sprint side by side. */
  offerCard: OfferCard;
  /** The host's own line on the transition scene (blank: Josh on camera with no words on screen). */
  bridgeLine: string;
  stackHeading: string;
  stack: StackItem[];
  anchorHeading: string;
  anchor: AnchorRow[];
}

export const DEFAULT_PACK: PackSettings = {
  offerCard: 'deposit',
  bridgeLine: '',
  stackHeading: 'What the engagement includes, and why each part is there',
  stack: [
    { objection: 'I don’t know where to start.', title: 'Ninety days done with you: the 3C model applied to your business', price: 'engagement' },
    { objection: 'I don’t know where the businesses are.', title: 'Your buy box and the owner outreach to off-market owners with no successor, with the scripts', price: 'none' },
    { objection: 'I don’t have the cash.', title: 'The deal structure: commercial debt, seller finance and seller rollover, tested at 1.5x', price: 'none' },
    { objection: 'Lenders won’t take me seriously.', title: 'Lender introductions once your structure passes the 1.5x test', price: 'none' },
    { objection: 'What if it doesn’t work for me?', title: 'The guarantee, with its conditions in full, and 7 days money-back after you sign', price: 'none' },
  ],
  anchorHeading: 'The honest alternatives',
  anchor: [
    { label: 'An M&A adviser on a retainer and a success fee', figure: '$10K a month plus 3% of the price', note: 'A retainer while they search, then a share of the price when the deal closes.' },
    { label: 'Doing it alone, and overpaying on the first deal', figure: '$300K', note: 'One extra turn of EBITDA paid for a business making $300K a year.' },
    { label: 'Waiting a year', figure: '$400K', note: 'A year of profit from a business making $400K a year that someone else bought.' },
  ],
};

export const LIMITS_PACK = { stackMax: 7, anchorMax: 4, objectionMax: 90, titleMax: 120, headingMax: 90, figureMax: 48, noteMax: 140, labelMax: 70, lineMax: 140 };

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** A money figure or a "value" claim: the stack shows real prices from settings only, never typed ones. */
export const MONEY_CLAIM = /[$€£]\s?\d|\b\d[\d,.]*\s?(k|m|bn|million|thousand)\b|\b\d{1,3}(,\d{3})+\b|\bvalue[ds]?\b|\bworth\b/i;

const lines = (v: unknown) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split('\n') : []);
const cells = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : x && typeof x === 'object' ? Object.values(x as Record<string, unknown>).map(String) : String(x ?? '').split('|'));

/** Stack lines: "objection | part | price key" (text) or objects. Lines with a typed money figure are dropped and reported. */
export function cleanStack(raw: unknown, issues: string[] = []): StackItem[] {
  const out: StackItem[] = [];
  for (const x of lines(raw)) {
    const o = x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    const c = o ? [o.objection, o.title, o.price] : cells(x);
    const objection = clean(c[0], LIMITS_PACK.objectionMax), title = clean(c[1], LIMITS_PACK.titleMax);
    const pk = clean(c[2], 20).toLowerCase() as PriceKey;
    if (!title) continue;
    if (MONEY_CLAIM.test(`${objection} ${title}`)) { issues.push(`Left out "${title}": the stack shows real prices from settings only. Pick a price key instead of typing a figure or a value.`); continue; }
    out.push({ objection, title, price: PRICE_KEYS.includes(pk) ? pk : 'none' });
    if (out.length >= LIMITS_PACK.stackMax) break;
  }
  return out;
}
/** Anchor rows: "label | figure | note". Every figure is shown as illustrative. */
export function cleanAnchor(raw: unknown): AnchorRow[] {
  const out: AnchorRow[] = [];
  for (const x of lines(raw)) {
    const o = x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
    const c = o ? [o.label, o.figure, o.note] : cells(x);
    const label = clean(c[0], LIMITS_PACK.labelMax), figure = clean(c[1], LIMITS_PACK.figureMax).replace(/^illustrative:?\s*/i, '');
    if (!label || !figure) continue;
    out.push({ label, figure, note: clean(c[2], LIMITS_PACK.noteMax) });
    if (out.length >= LIMITS_PACK.anchorMax) break;
  }
  return out;
}

export function cleanPack(raw: unknown, base: PackSettings = DEFAULT_PACK, issues: string[] = []): PackSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const str = (k: 'bridgeLine' | 'stackHeading' | 'anchorHeading', max: number) => (typeof r[k] === 'string' ? clean(r[k], max) : base[k]);
  return {
    offerCard: r.offerCard === 'paths' || r.offerCard === 'deposit' ? r.offerCard : base.offerCard,
    bridgeLine: str('bridgeLine', LIMITS_PACK.lineMax),
    stackHeading: str('stackHeading', LIMITS_PACK.headingMax) || DEFAULT_PACK.stackHeading,
    stack: r.stack !== undefined ? cleanStack(r.stack, issues) : base.stack.map((x) => ({ ...x })),
    anchorHeading: str('anchorHeading', LIMITS_PACK.headingMax) || DEFAULT_PACK.anchorHeading,
    anchor: r.anchor !== undefined ? cleanAnchor(r.anchor) : base.anchor.map((x) => ({ ...x })),
  };
}

/** Copy warnings for Funnel HQ (the house rules): every on-screen line the owner wrote, through auditCopy. */
export function packIssues(p: PackSettings): string[] {
  const out: string[] = [];
  const check = (where: string, s: string) => { for (const i of auditCopy(s)) out.push(`${where}: ${i.rule} ("${i.excerpt}")`); if (/[!—]/.test(s)) out.push(`${where}: no exclamation marks or em dashes ("${s.slice(0, 60)}")`); };
  check('Transition line', p.bridgeLine);
  check('Stack heading', p.stackHeading);
  p.stack.forEach((x, i) => { check(`Stack ${i + 1}`, x.objection); check(`Stack ${i + 1}`, x.title); });
  check('Comparison heading', p.anchorHeading);
  p.anchor.forEach((x, i) => { check(`Comparison ${i + 1}`, x.label); check(`Comparison ${i + 1}`, x.note); });
  return out.filter((x) => !/\(""\)$/.test(x));
}

// ───────────── the live part: the stack's step, the host's line, the pitch clock ─────────────

export interface PackState { step: number; steps: number; line: string; lineSet: boolean; pitchAt: number | null; offerCard: OfferCard }
/** Per-room defaults the Durable Object gets with every request (part of StudioDefaults). */
export interface PackDefaults { steps: number; offerCard: OfferCard; line: string }
export const PITCH_SCENES = ['bridge', 'stack', 'anchor', 'offer'] as const;

export const newPack = (d: Partial<PackDefaults> = {}): PackState => ({ step: 0, steps: d.steps ?? DEFAULT_PACK.stack.length + 1, line: d.line ?? '', lineSet: false, pitchAt: null, offerCard: d.offerCard ?? 'deposit' });
export const packDefaults = (p: PackSettings): PackDefaults => ({ steps: p.stack.length + 1, offerCard: p.offerCard, line: p.bridgeLine });

type WithPack = { pack?: PackState };
export const packOf = (s: object): PackState => ((s as WithPack).pack ??= newPack());
export function configurePack(s: object, d: Partial<PackDefaults> | undefined) {
  if (!d) return;
  const p = packOf(s);
  if (typeof d.steps === 'number' && d.steps >= 1 && d.steps <= LIMITS_PACK.stackMax + 1) { p.steps = d.steps; p.step = Math.min(p.step, p.steps); }
  if (d.offerCard === 'paths' || d.offerCard === 'deposit') p.offerCard = d.offerCard;
  // The host's live edit wins over Funnel HQ's line for the rest of the session.
  if (typeof d.line === 'string' && !p.lineSet) p.line = clean(d.line, LIMITS_PACK.lineMax);
}
/** A scene switch: the first pitch scene starts the pitch clock (server time). */
export function packOnScene(s: object, scene: string, now: number) {
  const p = packOf(s);
  if (p.pitchAt == null && (PITCH_SCENES as readonly string[]).includes(scene)) p.pitchAt = now;
}

const fail = (error: string): ApplyResult => ({ ok: false, error, out: [], effects: [], changed: false });
const done = (o: Partial<ApplyResult> = {}): ApplyResult => ({ ok: true, out: [], effects: [], changed: true, ...o });

/** studio_pack: { op: 'step', delta | n } moves the stack; { op: 'line', text } sets the transition line; { op: 'clock' } restarts the pitch clock. */
export function packApply(s: object, direct: boolean, msg: Record<string, unknown>, now: number): ApplyResult {
  if (!direct) return fail('forbidden');
  const p = packOf(s);
  if (msg.op === 'step') {
    const n = msg.delta !== undefined ? p.step + Math.round(Number(msg.delta)) : Math.round(Number(msg.n));
    if (!Number.isFinite(n)) return fail('bad_value');
    const step = Math.max(0, Math.min(p.steps, n));
    if (step === p.step) return done({ changed: false });
    p.step = step;
    return done();
  }
  if (msg.op === 'line') { p.line = clean(msg.text, LIMITS_PACK.lineMax); p.lineSet = true; return done(); }
  if (msg.op === 'clock') { p.pitchAt = msg.on === false ? null : now; return done(); }
  return fail('bad_value');
}

export function packView(s: object, backstage: boolean) {
  const p = packOf(s);
  return { step: p.step, steps: p.steps, line: p.line, offerCard: p.offerCard, ...(backstage ? { pitchAt: p.pitchAt } : {}) };
}

/** Run-of-show lines for the offer pack ([HOST: PRE-PITCH] and friends), or null when the line isn't one of them. */
export function classifyPackCue(a: string): { label: string; cue: string } | null {
  if (/^(PRE-?PITCH|TRANSITION|BRIDGE)$/i.test(a)) return { label: PACK_COPY.cueBridge, cue: 'scene:bridge' };
  if (/^SHOW STACK$/i.test(a)) return { label: PACK_COPY.cueStack, cue: 'scene:stack' };
  if (/^STACK NEXT$/i.test(a)) return { label: PACK_COPY.cueStackNext, cue: 'pack:next' };
  if (/^SHOW (ANCHOR|COMPARISON|ALTERNATIVES)$/i.test(a)) return { label: PACK_COPY.cueAnchor, cue: 'scene:anchor' };
  if (/^PUSH (PATHS|BOTH PATHS)$/i.test(a)) return { label: PACK_COPY.cuePaths, cue: 'push:paths' };
  if (/^PUSH SPRINT$/i.test(a)) return { label: PACK_COPY.cueSprint, cue: 'push:sprint' };
  return null;
}

/** The pushes a cue makes: both paths for "push:paths", and for "push:deposit" when the room's offer is the two paths. */
export function pathsSteps(s: object, cue: string): Record<string, unknown>[] | null {
  if (cue === 'push:paths' || (cue === 'push:deposit' && packOf(s).offerCard === 'paths')) return [{ t: 'push', kind: 'deposit' }, { t: 'push', kind: 'sprint' }];
  return null;
}

// ───────────── copy (checked by auditCopy in test/offer-pack.test.ts) ─────────────

export const PACK_COPY = {
  scenes: { bridge: 'Transition', stack: 'Stack', anchor: 'Compare' },
  pitchGroup: 'Pitch',
  pitchClock: 'Pitch',
  pitchClockReset: 'Restart the pitch clock',
  stackStep: (a: string, b: string) => `Part ${a} of ${b}`,
  stackReveal: 'The price',
  stackNext: 'Next part',
  stackPrev: 'Previous part',
  stackKeys: 'Right arrow or space shows the next part. Left arrow goes back.',
  objection: 'The objection',
  included: 'Included',
  todayLabel: 'Today',
  feesHeading: 'The engagement fee follows the size of your business',
  feeRow: (a: string, b: string) => `${a} revenue: ${b}`,
  illustrative: 'Illustrative',
  ourPrice: 'Our price',
  anchorFoot: 'Illustrative figures to compare options, not quotes or predictions. Education, not financial advice.',
  bridgeEyebrow: 'Before the offer',
  bridgeHeading: 'Transition line',
  bridgeHelp: 'Josh on camera, no slides. One short line in your own words shows under the camera.',
  bridgeSave: 'Save the line',
  bridgeSaved: 'Line saved.',
  pushPaths: 'Push both paths',
  pushPathsHelp: 'Pushes the deposit and the First Deal Sprint as one card. The deposit needs the offer open.',
  offerCardDeposit: 'This room pushes the deposit card.',
  offerCardPaths: 'This room pushes both paths: the deposit and the First Deal Sprint side by side.',
  cueBridge: 'Switch to the pitch transition',
  cueStack: 'Show the stack',
  cueStackNext: 'Next part of the stack',
  cueAnchor: 'Show the comparison',
  cuePaths: 'Push both paths',
  cueSprint: 'Push the Sprint card',
  // the two paths card (attendees)
  pathsEyebrow: 'Two ways to start',
  pathsHeading: 'Pick the path that fits',
  pathA: 'Done with you',
  pathAName: 'The 90-day engagement',
  pathABody: 'Josh’s team works your first deal with you, from the buy box to a signed letter of intent.',
  pathADeposit: (a: string) => `${a} deposit today`,
  pathAButton: 'Secure my place',
  pathB: 'Start smaller',
  pathBBody: 'Your first deal mapped out in writing with Josh’s team in seven days.',
  pathBButton: 'Start the Sprint',
  pathBCredit: 'Credited in full against the engagement if you continue.',
  pathPaid: 'Yours already.',
  pathUnavailable: 'Not open to you in this session.',
  pathUnderMillion: 'For owners doing $1M or more a year.',
  closesIn: 'Closes in',
  ticketOff: (a: string) => `Your ${a} ticket credit is applied.`,
  guaranteeLink: 'The guarantee and its conditions',
  loading: 'Loading your prices',
};
