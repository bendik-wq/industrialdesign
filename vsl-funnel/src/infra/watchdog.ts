import type { Runtime } from '../app';
import type { Env } from '../env';
import type { RoomRow } from '../rooms/rooms';
import { flag } from '../settings';
import { type BrowserLike, blockTrackers, browserAvailable, withBrowser } from './browser';
import { recordError } from './errors';

/**
 * The funnel watchdog (Cloudflare round, builder D; setting WATCHDOG, off by default).
 *
 * Once an hour (from the 5-minute cron, claimed through kv_state so two ticks can't both run it) a real browser
 * (Browser Rendering) opens the key public pages: the home page, the application's first step, the live landing
 * page, the masterclass page and the join page of the next room that has general admission on. Each page passes
 * when it answers below 400, throws no uncaught page error, and shows its main call to action. Nothing is
 * submitted, trackers are blocked, and the headless browser's user agent marks every view as a bot, so analytics
 * and leads are untouched.
 *
 * Every run is a row in watchdog_runs (kept 30 days; Funnel HQ → Errors & cron shows the last 24). Each failing
 * page goes to the error log (kind "cron", source "funnel watchdog"). When the Command Slack channel is connected,
 * one message goes out when the funnel starts failing and one when it recovers (never every hour).
 * Without the BROWSER binding (local dev) the run is recorded with every page skipped.
 */
export const WATCHDOG_EVERY_MS = 60 * 60_000;
export const WATCHDOG_RETENTION_DAYS = 30;
export const WATCHDOG_PAGE_TIMEOUT_MS = 20_000;
const CLAIM_KEY = 'watchdog:last';

export interface WatchTarget {
  name: string;
  path: string;
  /** The main call to action; the page fails without it. */
  cta: string;
  /** Also a pass, with this note, when present instead of the CTA (e.g. the live page with no session scheduled). */
  alt?: { selector: string; note: string };
}
export type CheckStatus = 'ok' | 'failed' | 'skipped';
export interface CheckResult { name: string; path: string; status: CheckStatus; ms: number; error?: string; note?: string }

export const WATCH_TARGETS: WatchTarget[] = [
  { name: 'Home page', path: '/', cta: '[data-app] input[name=first_name]' },
  { name: 'Application, first step', path: '/apply', cta: '[data-app] input[name=first_name]' },
  { name: 'Live landing page', path: '/live', cta: 'form[data-live-register]', alt: { selector: '.lv-link', note: 'no live session scheduled' } },
  { name: 'Masterclass', path: '/webinar', cta: 'form input[name=first_name]' },
];
export const ROOM_TARGET_NAME = 'Room join page';

export const watchdogOn = (rt: Pick<Runtime, 'settings'>) => flag(rt.settings.WATCHDOG);

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

/** Checks one page in the browser. Never throws. */
export async function checkPage(browser: BrowserLike, origin: string, t: WatchTarget, clock: () => number = Date.now): Promise<CheckResult> {
  const started = clock();
  const errors: string[] = [];
  let page: Awaited<ReturnType<BrowserLike['newPage']>> | null = null;
  try {
    page = await browser.newPage();
    page.on('pageerror', (e: unknown) => { errors.push(short(e)); });
    await blockTrackers(page);
    await page.setViewport?.({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
    const res = await page.goto(origin + t.path, { waitUntil: 'load', timeout: WATCHDOG_PAGE_TIMEOUT_MS });
    const status = res ? res.status() : 0;
    if (!res || status >= 400) return { name: t.name, path: t.path, status: 'failed', ms: clock() - started, error: `The page answered ${status || 'nothing'}` };
    let note: string | undefined;
    const sel = t.alt ? `${t.cta}, ${t.alt.selector}` : t.cta;
    const found = await page.waitForSelector(sel, { visible: true, timeout: 8000 }).then(() => true, () => false);
    if (!found) return { name: t.name, path: t.path, status: 'failed', ms: clock() - started, error: `The main button or form is missing (${t.cta})` };
    if (t.alt) {
      const main = await page.waitForSelector(t.cta, { visible: true, timeout: 1500 }).then(() => true, () => false);
      if (!main) note = t.alt.note;
    }
    // Errors thrown while the page finished loading are caught by the listener above.
    if (errors.length) return { name: t.name, path: t.path, status: 'failed', ms: clock() - started, error: `Page error: ${errors[0]}`, ...(note ? { note } : {}) };
    return { name: t.name, path: t.path, status: 'ok', ms: clock() - started, ...(note ? { note } : {}) };
  } catch (e) {
    return { name: t.name, path: t.path, status: 'failed', ms: clock() - started, error: short(e) };
  } finally {
    if (page) await page.close().catch(() => null);
  }
}

/** The join page of the next room (webinar mode, scheduled or live) with general admission on, or null. */
export async function roomTarget(rt: Runtime, now = Date.now()): Promise<WatchTarget | null> {
  const { admissionOf, joinUrl } = await import('../rooms/admission');
  const { results } = await rt.env.DB.prepare(
    "SELECT id, engage, mode, status FROM rooms WHERE mode = 'webinar' AND status IN ('scheduled', 'live') AND (starts_at IS NULL OR starts_at > ?) ORDER BY COALESCE(starts_at, created_at) LIMIT 10",
  ).bind(now - 12 * 3_600_000).all<Pick<RoomRow, 'id' | 'engage' | 'mode' | 'status'>>();
  const room = results.find((r) => admissionOf(r).on);
  if (!room) return null;
  const url = new URL(await joinUrl(rt, room));
  return { name: ROOM_TARGET_NAME, path: url.pathname, cta: 'form button.rm-primary' };
}

/** Runs every check and records the run. */
export async function runWatchdog(rt: Runtime, o: { trigger?: 'cron' | 'manual'; now?: () => number } = {}) {
  const clock = o.now ?? Date.now;
  const started = clock();
  const room = await roomTarget(rt, started).catch(() => null);
  const targets = room ? [...WATCH_TARGETS, room] : WATCH_TARGETS;
  let results: CheckResult[];
  if (!browserAvailable(rt.env)) {
    results = targets.map((t) => ({ name: t.name, path: t.path, status: 'skipped', ms: 0, error: 'Browser Rendering isn’t available here (local dev or the BROWSER binding is missing).' }));
  } else {
    const ran = await withBrowser(rt.env, async (b) => {
      const out: CheckResult[] = [];
      for (const t of targets) out.push(await checkPage(b, rt.origin, t, clock)); // one tab at a time: lighter on the browser
      return out;
    }).catch((e) => { console.error('watchdog browser failed', short(e)); return null; });
    results = ran ?? targets.map((t) => ({ name: t.name, path: t.path, status: 'skipped', ms: 0, error: 'The browser couldn’t be started.' }));
  }
  if (!room) results.push({ name: ROOM_TARGET_NAME, path: '/rooms/…/join', status: 'skipped', ms: 0, note: 'no upcoming room with general admission on' });
  const failed = results.filter((r) => r.status === 'failed');
  const checked = results.filter((r) => r.status !== 'skipped').length;
  const run = { started_at: started, ms: clock() - started, ok: failed.length === 0 && checked > 0, checked, failed: failed.length, skipped: results.length - checked, trigger: o.trigger ?? 'cron', results };
  const prev = await rt.env.DB.prepare('SELECT ok, checked FROM watchdog_runs WHERE checked > 0 ORDER BY started_at DESC LIMIT 1').first<{ ok: number; checked: number }>().catch(() => null);
  await rt.env.DB.prepare('INSERT INTO watchdog_runs (started_at, ms, ok, checked, failed, skipped, trigger, results) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(run.started_at, Math.round(run.ms), run.ok ? 1 : 0, run.checked, run.failed, run.skipped, run.trigger, JSON.stringify(results)).run();
  for (const f of failed) await recordError(rt.env, new Error(`${f.name} (${f.path}): ${f.error ?? 'failed'}`), { kind: 'cron', source: 'funnel watchdog', rt });
  if (checked > 0) await maybePing(rt, prev ? prev.ok === 1 : true, run.ok, failed);
  return run;
}

/** One Slack / Discord message when the funnel starts failing and one when it recovers, only when Command's channel is connected. */
async function maybePing(rt: Runtime, wasOk: boolean, isOk: boolean, failed: CheckResult[]) {
  if (wasOk === isOk) return;
  try {
    const { opsSlackConfigured, postOps } = await import('../ops/slack');
    if (!opsSlackConfigured(rt)) return;
    await postOps(rt, isOk
      ? { title: 'Funnel watchdog: every page passes again', lines: ['The key public pages render with their main button and no page errors.'], path: '/admin#errors', linkText: 'Open Errors & cron' }
      : { title: `Funnel watchdog: ${failed.length} page${failed.length === 1 ? '' : 's'} failing`, lines: failed.slice(0, 5).map((f) => `${f.name} (${f.path}): ${f.error ?? 'failed'}`), path: '/admin#errors', linkText: 'Open Errors & cron' });
  } catch (e) {
    console.error('watchdog ping failed', short(e));
  }
}

/** Cron (every 5 minutes): runs the watchdog once an hour when WATCHDOG is on. */
export async function maybeRunWatchdog(rt: Runtime, now = Date.now()) {
  if (!watchdogOn(rt)) return { skipped: 'off' as const };
  // The cron has no request to learn the site's address from: without PUBLIC_URL there is nothing to check.
  if (!rt.settings.PUBLIC_URL) return { skipped: 'no PUBLIC_URL' as const };
  // Claim the hour: only the tick that moves the marker runs it.
  const claimed = await rt.env.DB.prepare(
    `INSERT INTO kv_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value
       WHERE CAST(kv_state.value AS INTEGER) <= ? RETURNING value`,
  ).bind(CLAIM_KEY, String(now), now - WATCHDOG_EVERY_MS + 2 * 60_000).first<{ value: string }>();
  if (!claimed) return { skipped: 'not due' as const };
  await rt.env.DB.prepare('DELETE FROM watchdog_runs WHERE started_at < ?').bind(now - WATCHDOG_RETENTION_DAYS * 86_400_000).run();
  const run = await runWatchdog(rt, { trigger: 'cron' });
  return { ok: run.ok, checked: run.checked, failed: run.failed };
}

export interface WatchdogRunRow { id: number; started_at: number; ms: number; ok: number; checked: number; failed: number; skipped: number; trigger: string; results: string }

/** Funnel HQ → Errors & cron: the last 24 runs. */
export async function watchdogReport(rt: Pick<Runtime, 'env' | 'settings'>) {
  const { results } = await rt.env.DB.prepare('SELECT * FROM watchdog_runs ORDER BY started_at DESC LIMIT 24').all<WatchdogRunRow>();
  return {
    on: watchdogOn(rt),
    browser: browserAvailable(rt.env as Env),
    everyMinutes: WATCHDOG_EVERY_MS / 60_000,
    runs: results.map((r) => {
      let checks: CheckResult[] = [];
      try { checks = JSON.parse(r.results); } catch { checks = []; }
      return { id: r.id, at: r.started_at, ms: r.ms, ok: r.ok === 1, checked: r.checked, failed: r.failed, skipped: r.skipped, trigger: r.trigger, checks };
    }),
  };
}
