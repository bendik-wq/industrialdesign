/**
 * Funnel HQ → Studio → Deck (/admin/deck): the masterclass as a presented deck for Josh to present and record.
 * The app is public/assets/deck/ (deck.js, deck.css, qr.js: code only, no content); the slides, the words Josh says on
 * each one and the NLP levers are src/admin/deck-data.ts, generated from scripts/ai-webinar/script-ai-josh.md by
 * scripts/ai-webinar/present/build_deck.py, and only this admin route serves them.
 * Views: /admin/deck (audience: share or record this window), /admin/deck?view=presenter (notes, next build, timer),
 * /admin/deck?view=print (every final build, one page each). Studio's Record view opens it, and its auto layout
 * follows the deck's slides over BroadcastChannel "gl-deck".
 */
import type { Context } from 'hono';
import type { AppEnv } from '../app';
import { publicOrigin } from '../app';
import { buildId } from '../infra/build';

export interface DeckSlide {
  n: number; chapter: number; title: string; sub: string; layout: string; scene: string | null;
  onscreen: string[]; data: string[][]; caption: string | null; kicker: string | null;
  image: { id: string; what: string; slide: number; fit: string; credit: string; needsConsent: boolean; src: string | null } | null;
  notes: { text: string; aiOnly: boolean }[]; levers: string[]; cues: { id: string; label: string }[];
  poll: { id: string; q: string; options: string[] } | null;
  at: number; words: number; cam: 'orbit' | 'split' | 'spotlight' | 'stage' | 'vertical' | 'cinema';
}
export interface DeckData {
  title: string; brand: string; presenter: string;
  chapters: { n: number; title: string; part: string; at: number }[];
  slides: DeckSlide[]; plannedSec: number; wpm: number; applyPath: string; script: string;
}

/** Only the page's own scripts; Google Fonts for Newsreader and Inter; the QR code is drawn in the page. */
export const DECK_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page around the data. The data block is JSON inside a non-executing script tag, with "</" escaped. */
export function deckPage(data: DeckData, applyOrigin: string, version = '') {
  const v = version ? `?v=${encodeURIComponent(version)}` : '';
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(data.title)} · Deck</title><meta name="robots" content="noindex"><link rel="icon" href="/assets/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=Inter:opsz,wght@14..32,300..700&display=block">
<link rel="stylesheet" href="/assets/deck/deck.css${v}"></head><body class="dk" data-apply-origin="${esc(applyOrigin)}"><div id="deck" class="dk-root"></div>
<script type="application/json" id="deck-data">${json}</script>
<script src="/assets/deck/qr.js${v}"></script><script src="/assets/deck/deck.js${v}"></script></body></html>`;
}

/** GET /admin/deck (behind requireAdmin). The QR code on the apply slides points at the public /apply. */
export async function deckRoute(c: Context<AppEnv>) {
  const { DECK_DATA } = await import('./deck-data');
  const origin = publicOrigin(c.get('settings'), new URL(c.req.url).origin);
  c.header('content-security-policy', DECK_CSP);
  c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  c.header('cache-control', 'no-store');
  c.header('x-robots-tag', 'noindex');
  return c.html(deckPage(DECK_DATA, origin, buildId(c.env)));
}
