import type { Context, Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { render } from '../funnel/pages';
import { getLead } from '../funnel/leads';
import { formatCallTime } from '../integrations/email';
import { type LiveEvent, type LiveReg, getEvent, getLiveReg, liveBase } from './events';
import { LC_COPY, MIN, WAITING_ROOM_MIN } from './lifecycle';
import { calLinks, calendarFor, ensureLcReg, lcEvent, lcSettings, referralStats, referralTarget, saveQuestion, saveTz, saveWorksheet, smsOptIn, lifecycleReport, saveLcEvent, touch } from './lifecycle-db';

/**
 * Builder E "lifecycle" pages and routes:
 *  - the confirmation / pre-show page (what a registrant sees on their room link until the waiting room opens
 *    15 minutes before the start): calendar buttons, one-tap text reminders, the "watch this before" video,
 *    "what's your biggest question", the pre-session worksheet (seeds the Deal Plan), the referral panel;
 *  - /live/cal/:token/:kind (Google, Outlook, Apple, .ics) and /live/i/:code (a registrant's referral link);
 *  - /api/live/lc/* (the page's saves) and /admin/api/live-events/:id/lifecycle (Funnel HQ).
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ICON = {
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
  msg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/** "Watch this before": YouTube and Vimeo as privacy-friendly embeds, anything else as a plain video. */
export function videoEmbed(url: string | null) {
  if (!url) return '';
  const yt = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/.exec(url);
  if (yt) return `<div class="lc-video"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0" title="${esc(LC_COPY.videoHeading)}" loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  const vm = /^https:\/\/(?:www\.)?vimeo\.com\/(\d{5,12})/.exec(url);
  if (vm) return `<div class="lc-video"><iframe src="https://player.vimeo.com/video/${vm[1]}?dnt=1" title="${esc(LC_COPY.videoHeading)}" loading="lazy" allow="fullscreen; picture-in-picture" allowfullscreen></iframe></div>`;
  return `<div class="lc-video"><video controls playsinline preload="metadata" src="${esc(url)}"></video></div>`;
}

/** The confirmation / pre-show page. Called from pages.ts liveRoom while the waiting room isn't open yet. */
export async function preShowPage(c: Context<AppEnv>, rt: Runtime, ev: LiveEvent, reg: LiveReg) {
  const lead = await getLead(rt.env, reg.lead_id);
  const row = await ensureLcReg(rt, reg);
  const lc = await lcEvent(rt, ev.id);
  const C = LC_COPY;
  const tz = row.tz || c.get('visitor').geo.timezone || lead?.timezone || ev.tz;
  const opensAt = ev.starts_at - WAITING_ROOM_MIN * MIN;
  const links = calLinks(rt, reg.token);
  const { safeFirstName } = await import('../lib/text');
  const name = safeFirstName(lead?.first_name) ?? '';
  const stopped = Boolean(lead?.sms_opt_out_at);
  const smsOn = Boolean(reg.sms_ok && lead?.sms_consent_at && !stopped);
  const settings = lcSettings(rt);
  const refUrl = row.ref_code && settings.referralsOn ? `${liveBase(rt)}/live/i/${row.ref_code}` : null;
  const ref = refUrl ? await referralStats(rt, reg.id) : null;
  let ws: Record<string, string> = {};
  try { ws = JSON.parse(row.worksheet ?? '{}') ?? {}; } catch { ws = {}; }
  const val = (k: string) => esc(String(ws[k] ?? ''));
  if (!row.preshow_at) await rt.env.DB.prepare('UPDATE lc_regs SET preshow_at = ? WHERE reg_id = ?').bind(Date.now(), reg.id).run();
  // Round 4 lifecycle2: the lead-in parts with their real dates (empty unless switched on for this event).
  const leadin = await (await import('./lifecycle2-db')).leadinBlock(rt, ev, reg, row, tz, { video: Boolean(lc.video_url) }).catch((e) => { console.error('lead-in block', e); return ''; });
  const field = (k: string, label: string, o: { mode?: string } = {}) => `<label class="lv-field"><span>${esc(label)}</span><input name="${k}" maxlength="${k === 'action_1' ? 200 : 120}" value="${val(k)}"${o.mode ? ` inputmode="${o.mode}"` : ''} autocomplete="off"></label>`;
  const main = `<section class="lc-pre"><div class="wrap narrow">
    <header class="lc-head">
      <p class="lv-eyebrow">${esc(C.eyebrow)}</p>
      <h1 class="lv-h1 lv-h1-s">${esc(C.heading(name))}</h1>
      <p class="lc-title">${esc(ev.title)}</p>
      <p class="lv-when"><span data-local-time="${ev.starts_at}">${esc(formatCallTime(ev.starts_at, tz))}</span></p>
      <div class="lv-count lc-count" data-countdown="${opensAt}" data-lc-opens="${opensAt}"><span class="lv-count-l">${esc(C.opensIn)}</span> <span class="lv-count-v" data-countdown-v></span></div>
      <a class="buy-btn lc-enter" data-lc-enter href="${esc(`${liveBase(rt)}/live/room/${reg.token}`)}" hidden>${esc(C.enterRoom)} ${ICON.arrow}</a>
      <p class="lv-fine">${esc(C.opensAt)}</p>
      <p class="lc-lede">${esc(C.lede)}</p>
    </header>

    ${leadin}

    <section class="lc-block lc-cal" aria-labelledby="lc-cal-h">
      <h2 class="lc-h" id="lc-cal-h">${ICON.cal} ${esc(C.calHeading)}</h2>
      <p class="lc-p">${esc(C.calBody)}</p>
      <div class="lc-calbtns" role="group" aria-label="${esc(C.calHeading)}">
        <a class="lc-calbtn" data-lc-cal="google" href="${esc(links.google)}" target="_blank" rel="noopener">${esc(C.calGoogle)}</a>
        <a class="lc-calbtn" data-lc-cal="outlook" href="${esc(links.outlook)}" target="_blank" rel="noopener">${esc(C.calOutlook)}</a>
        <a class="lc-calbtn" data-lc-cal="apple" href="${esc(links.apple)}">${esc(C.calApple)}</a>
      </div>
      <p class="lv-fine"><a class="lv-link" data-lc-cal="ics" href="${esc(links.ics)}" download="session.ics">${esc(C.calOther)}</a></p>
      <p class="lc-ok" data-lc-cal-done${row.cal_added_at ? '' : ' hidden'}>${esc(C.calDone)}</p>
    </section>

    ${stopped ? `<section class="lc-block"><h2 class="lc-h">${ICON.msg} ${esc(C.smsHeading)}</h2><p class="lc-p">${esc(C.smsStopped)}</p></section>` : `<section class="lc-block lc-sms" aria-labelledby="lc-sms-h">
      <h2 class="lc-h" id="lc-sms-h">${ICON.msg} ${esc(C.smsHeading)}</h2>
      <div data-lc-sms-form${smsOn ? ' hidden' : ''}>
        <p class="lc-p">${esc(C.smsBody)}</p>
        ${lead?.phone ? '' : `<label class="lv-field"><span>${esc(C.smsPhone)}</span><input name="phone" type="tel" autocomplete="tel" inputmode="tel" data-lc-phone></label>`}
        <button type="button" class="lv-btn-2 lc-wide" data-lc-sms>${esc(C.smsButton)}</button>
        <p class="lv-fine">${esc(C.smsConsent)}</p>
        <p class="lv-err" role="alert" data-lc-sms-err hidden></p>
      </div>
      <p class="lc-ok" data-lc-sms-on${smsOn ? '' : ' hidden'}>${esc(C.smsOn)}</p>
    </section>`}

    ${lc.video_url ? `<section class="lc-block" aria-labelledby="lc-v-h"><h2 class="lc-h" id="lc-v-h">${esc(C.videoHeading)}</h2><p class="lc-p">${esc(C.videoBody)}</p>${videoEmbed(lc.video_url)}</section>` : ''}

    <section class="lc-block" aria-labelledby="lc-q-h">
      <h2 class="lc-h" id="lc-q-h">${esc(C.questionHeading)}</h2>
      <p class="lc-p">${esc(C.questionBody)}</p>
      <form data-lc-question novalidate>
        <label class="lv-field"><span class="lc-sr">${esc(C.questionHeading)}</span><textarea name="text" rows="3" maxlength="400" placeholder="${esc(C.questionPlaceholder)}">${esc(row.question ?? '')}</textarea></label>
        <button type="submit" class="lv-btn-2">${esc(C.questionButton)}</button>
        <p class="lc-ok" data-lc-ok${row.question ? '' : ' hidden'} role="status">${esc(C.questionSaved)}</p>
        <p class="lv-err" role="alert" data-lc-err hidden></p>
      </form>
    </section>

    <section class="lc-block" aria-labelledby="lc-w-h">
      <h2 class="lc-h" id="lc-w-h">${esc(C.worksheetHeading)}</h2>
      <p class="lc-p">${esc(C.worksheetBody)}</p>
      <form class="lc-ws" data-lc-worksheet novalidate>
        <div class="lv-row">${field('industry', C.wsIndustry)}${field('size', C.wsSize)}</div>
        <div class="lv-row">${field('geography', C.wsGeography)}${field('owners_per_week', C.wsOwners, { mode: 'numeric' })}</div>
        ${field('action_1', C.wsAction)}
        <button type="submit" class="lv-btn-2">${esc(C.worksheetButton)}</button>
        <p class="lc-ok" data-lc-ok${row.worksheet_at ? '' : ' hidden'} role="status">${esc(C.worksheetSaved)}</p>
        <p class="lv-err" role="alert" data-lc-err hidden></p>
      </form>
    </section>

    ${refUrl ? `<section class="lc-block lc-ref" aria-labelledby="lc-r-h">
      <h2 class="lc-h" id="lc-r-h">${esc(C.referralHeading)}</h2>
      <p class="lc-p">${esc(ev.platform === 'room' ? C.referralBody : C.referralZoomBody)}</p>
      <div class="lc-refrow"><input class="lc-reflink" readonly value="${esc(refUrl)}" aria-label="${esc(C.referralHeading)}" data-lc-reflink><button type="button" class="lv-btn-2" data-lc-copy>${esc(C.referralCopy)}</button><button type="button" class="lv-btn-2" data-lc-share hidden>${esc(C.referralShare)}</button></div>
      <p class="lv-fine" data-lc-refcount>${esc(ref && ref.registered ? C.referralCount(ref.registered, ref.attended) : C.referralNone)}</p>
    </section>` : ''}
  </div></section>`;
  return render(c, '/live.html', {
    title: C.eyebrow,
    blocks: { main, navmeta: '' },
    config: {
      live: { page: 'preshow', serverNow: Date.now() },
      lc: {
        token: reg.token, opensAt, api: '/api/live/lc', shareText: C.shareText(ev.title), refUrl,
        copy: { saved: C.questionSaved, failed: C.saveFailed, copied: C.referralCopied, copy: C.referralCopy, smsStopped: C.smsStopped, calDone: C.calDone },
      },
    },
  });
}

// ───────────── routes ─────────────

/** GET /live/cal/:token/:kind */
export async function calRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const reg = await getLiveReg(rt, c.req.param('token') ?? '');
  const ev = reg ? await getEvent(rt, reg.event_id) : null;
  if (!reg || !ev) return c.text('Not found', 404);
  const r = await calendarFor(rt, ev, reg, c.req.param('kind') ?? '');
  if (!r) return c.text('Not found', 404);
  if ('redirect' in r && r.redirect) return c.redirect(r.redirect, 302);
  return new Response(r.ics, { headers: { 'content-type': 'text/calendar; charset=utf-8; method=' + (ev.status === 'cancelled' ? 'CANCEL' : 'PUBLISH'), 'content-disposition': `${r.inline ? 'inline' : 'attachment'}; filename="session.ics"`, 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
/** GET /live/i/:code */
export async function referralRoute(c: Context<AppEnv>) {
  const rt = runtimeFrom(c);
  const url = await referralTarget(rt, c.req.param('code') ?? '');
  return c.redirect(url ?? `${liveBase(rt)}/live`, 302);
}
/** The landing's referral line: the referrer's first name (they shared the link), and the code for the form. */
export async function landingReferral(rt: Runtime, code: string | undefined) {
  if (!code || !/^[a-z2-9]{6,12}$/.test(code)) return null;
  const row = await rt.env.DB.prepare('SELECT l.first_name FROM lc_regs c JOIN leads l ON l.id = c.lead_id WHERE c.ref_code = ?').bind(code).first<{ first_name: string | null }>();
  if (!row) return null;
  const { safeFirstName } = await import('../lib/text');
  const n = safeFirstName(row.first_name);
  return { code, line: n ? `${n} invited you to this session.` : 'An owner invited you to this session.' };
}

const body = async (c: Context<AppEnv>) => {
  const t = await c.req.text().catch(() => '');
  if (!t || t.length > 16_000) return {} as Record<string, unknown>;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}; } catch { return {}; }
};

/** /api/live/lc/* (mounted inside mountLiveApi, so same-origin and visitor guards apply). */
export function mountLifecycleApi(api: Hono<AppEnv>) {
  const withReg = (fn: (rt: Runtime, reg: LiveReg, b: Record<string, unknown>, c: Context<AppEnv>) => Promise<unknown>) => async (c: Context<AppEnv>) => {
    const rt = runtimeFrom(c);
    const b = await body(c);
    const reg = typeof b.token === 'string' ? await getLiveReg(rt, b.token) : null;
    if (!reg) return c.json({ ok: false, error: 'Registration not found' }, 404);
    try { return c.json(await fn(rt, reg, b, c)); } catch (e) { console.error('lifecycle api', e); return c.json({ ok: false, error: LC_COPY.saveFailed }, 500); }
  };
  api.post('/live/lc/tz', withReg((rt, reg, b) => saveTz(rt, reg, b.tz)));
  api.post('/live/lc/question', withReg((rt, reg, b) => saveQuestion(rt, reg, b.text)));
  api.post('/live/lc/worksheet', withReg((rt, reg, b) => saveWorksheet(rt, reg, b)));
  api.post('/live/lc/sms', withReg((rt, reg, b, c) => smsOptIn(rt, reg, b, c.get('visitor').geo.country)));
  api.post('/live/lc/ref', withReg(async (rt, reg) => ({ ok: true, ...(await referralStats(rt, reg.id)) })));
}
/** /admin/api/live-events/:id/lifecycle (mounted inside mountLiveAdmin: admin session required). */
export function mountLifecycleAdmin(admin: Hono<AppEnv>) {
  admin.get('/live-events/:id/lifecycle', async (c) => { const r = await lifecycleReport(runtimeFrom(c), c.req.param('id')); return r ? c.json(r) : c.json({ error: 'Event not found' }, 404); });
  admin.get('/live-events/:id/lifecycle2', async (c) => { const r = await (await import('./lifecycle2-db')).lc2Report(runtimeFrom(c), c.req.param('id')); return r ? c.json(r) : c.json({ error: 'Event not found' }, 404); });
  admin.patch('/live-events/:id/lifecycle2', async (c) => { const r = await (await import('./lifecycle2-db')).saveLc2(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });
  admin.patch('/live-events/:id/lifecycle', async (c) => { const r = await saveLcEvent(runtimeFrom(c), c.req.param('id'), await body(c)); return c.json(r, r.ok ? 200 : 400); });
}

/** pages.ts liveRoom: record a tracked return, and show the pre-show page until the waiting room opens. */
export async function beforeRoom(c: Context<AppEnv>, rt: Runtime, ev: LiveEvent, reg: LiveReg, stage: string) {
  const via = c.req.query('via');
  if (via) await touch(rt, reg, via).catch(() => null);
  if (stage === 'waiting' && Date.now() < ev.starts_at - WAITING_ROOM_MIN * MIN) return preShowPage(c, rt, ev, reg);
  return null;
}
