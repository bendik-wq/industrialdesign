/**
 * Sales department: bulk follow-up actions, chat-friendly.
 *
 *  - quiet:   "follow up with every lead who went quiet": leads at a chosen stage with no page visit, click or reply
 *             in SALES_QUIET_DAYS days (default 5);
 *  - no_show: "re-engage no-shows": no-shows from the last 30 days who haven't rebooked;
 *  - unpaid:  "chase unpaid tickets and deposits": a checkout started (Masterclass seat, live ticket, challenge
 *             ticket, engagement deposit) and never paid.
 *
 * Each play drafts one message per lead and channel (email written from the lead's own data with the existing
 * personalisation; a short SMS) and queues ONE bulk proposal with a preview of every message. Nothing is sent
 * until it's approved (or the owner sets `sales.bulk_followup` to auto). On approval the messages go through the
 * existing rails (Resend, Twilio) with their checks re-run at send time: unsubscribes and the suppression list for
 * email, SMS consent, STOP, imported contacts and countries for texts, 8am–8pm their time for texts, 7am–9pm for
 * email, at most 3 texts a day, and nothing to someone who became active, rebooked or paid since the draft.
 */
import type { Runtime } from '../app';
import { BRAND } from '../config';
import { type Lead, getLead } from '../funnel/leads';
import { isSuppressed } from '../integrations/bounces';
import { emailConfigured, sendViaResend, unsubscribeSig } from '../integrations/email';
import { callingZones } from '../integrations/elevenlabs';
import { inTextingHours, nextTextingTime, sendSmsNow, smsBlock, smsConfigured } from '../integrations/sms';
import { type EmailContent, renderEmail } from '../integrations/templates';
import { newId } from '../lib/ids';
import { safeFirstName } from '../lib/text';
import { proposeAction, registerActionHandler } from '../ops/actions';
import { personalizeEmail } from '../personalize/personalize';
import { buildProfile } from '../personalize/profile';
import { webinarBase } from '../webinar/webinar';

const DAY = 86_400_000, HOUR = 3_600_000;
export const MAX_PER_BATCH = 60;

export type Play = 'quiet' | 'no_show' | 'unpaid';
export type Channel = 'email' | 'sms';
export const QUIET_STAGES = ['partial', 'applied', 'booked', 'showed', 'nurture'] as const;

/** For the chat (Chief of Staff) and the Follow-up actions tab: what each play is, and phrases that ask for it. */
export const SALES_PLAYS: Record<Play, { label: string; describe: string; phrases: RegExp }> = {
  quiet: { label: 'Follow up with every lead who went quiet', describe: 'Leads at the chosen stages with no visit, click or reply in N days.', phrases: /\b(went|gone|go(ne)?|are|is) quiet\b|\bquiet leads?\b|\bghost(ed)?\b|\bno (reply|response)\b/i },
  no_show: { label: 'Re-engage no-shows', describe: 'No-shows from the last 30 days who haven\'t rebooked.', phrases: /\bno[- ]?shows?\b|\bmissed (their|the) call\b|\bdidn'?t show\b/i },
  unpaid: { label: 'Chase unpaid tickets and deposits', describe: 'Checkouts started (tickets, deposits) and never paid.', phrases: /\b(unpaid|abandoned|unfinished)\b.*\b(tickets?|deposits?|checkouts?|payments?)\b|\bchase\b.*\b(tickets?|deposits?|payments?)\b/i },
};

/** "follow up with every lead who went quiet for 7 days" → { play: 'quiet', days: 7 }. */
export function matchSalesCommand(text: string): { play: Play; days?: number } | null {
  const t = String(text ?? '');
  const play = (Object.keys(SALES_PLAYS) as Play[]).find((p) => SALES_PLAYS[p].phrases.test(t));
  if (!play) return null;
  const d = t.match(/\b(\d{1,3})\s*(days?|d)\b/i) ?? (/\b(a|one) week\b/i.test(t) ? ['', '7'] : /\b(two|2) weeks\b/i.test(t) ? ['', '14'] : null);
  return d ? { play, days: Number(d[1]) } : { play };
}

// ───────────── quiet hours ─────────────

const localHour = (t: number, tz: string) => { try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(t)); } catch { return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', hourCycle: 'h23' }).format(t)); } };
export const inEmailHours = (t: number, tz: string) => { const h = localHour(t, tz); return h >= 7 && h < 21; };
export function nextEmailTime(t: number, tz: string) {
  for (let i = 0, x = t; i < 2 * 96; i++, x = Math.ceil((x + 1) / 900_000) * 900_000) if (inEmailHours(x, tz)) return x;
  return t;
}
const leadTz = (rt: Runtime, l: Pick<Lead, 'timezone' | 'phone'>) => l.timezone || callingZones(l.phone)?.slice(-1)[0] || rt.settings.SALES_TIMEZONE || 'UTC';
/** When a message on this channel may go: now if inside the window, else the next opening. */
export function sendTimeFor(rt: Runtime, l: Pick<Lead, 'timezone' | 'phone'>, channel: Channel, now = Date.now()) {
  if (channel === 'sms') { const zones = callingZones(l.phone) ?? []; return inTextingHours(now, zones) ? now : nextTextingTime(now, zones); }
  const tz = leadTz(rt, l);
  return inEmailHours(now, tz) ? now : nextEmailTime(now, tz);
}

// ───────────── consent: why a lead can't get a message on a channel (null = OK) ─────────────

const smsConsent = (l: Lead) => Boolean(l.call_consent_at || l.sms_consent_at);
export async function emailBlock(rt: Runtime, l: Lead) {
  if (!l.email) return 'no email';
  if (l.unsubscribed_at) return 'unsubscribed';
  const s = await isSuppressed(rt, l.email);
  return s ? `email ${s}` : null;
}
export function textBlock(l: Lead) {
  const b = smsBlock(l);
  if (b) return b;
  if (!smsConsent(l)) return 'no consent to SMS';
  return null;
}

// ───────────── who: candidates per play ─────────────

export interface Candidate { lead: Lead; play: Play; reason: string; link: string | null; what?: string; kind?: string }
export interface Excluded { lead_id: string; name: string; why: string }

const nameOf = (l: Pick<Lead, 'first_name' | 'last_name' | 'email'>) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || 'Lead';
const NEVER = ['won', 'disqualified'];

export async function findCandidates(rt: Runtime, play: Play, o: { days?: number; stages?: string[]; now?: number } = {}): Promise<{ candidates: Candidate[]; excluded: Excluded[] }> {
  const now = o.now ?? Date.now();
  const db = rt.env.DB;
  const excluded: Excluded[] = [];
  const recentlyChased = `(SELECT MAX(COALESCE(f.sent_at, f.created_at)) FROM ops_followup_messages f WHERE f.lead_id = l.id AND f.status IN ('queued', 'sending', 'sent', 'simulated'))`;
  if (play === 'quiet') {
    const days = Math.max(1, Math.min(365, Math.round(o.days ?? (Number(rt.settings.SALES_QUIET_DAYS) || 5))));
    const stages = (o.stages?.length ? o.stages : ['applied', 'showed', 'nurture']).filter((s) => (QUIET_STAGES as readonly string[]).includes(s));
    if (!stages.length) return { candidates: [], excluded };
    const cutoff = now - days * DAY;
    const { results } = await db.prepare(
      // Not l.*: leads is at D1's 100-column limit, so extra columns would overflow the result set. Full rows are loaded per candidate.
      `SELECT l.id, l.first_name, l.last_name, l.email, l.status, l.created_at, l.app_completed_at, l.showed_at,
         (SELECT MAX(e.ts) FROM events e WHERE e.lead_id = l.id AND e.source NOT IN ('cron', 'admin') AND e.name NOT IN ('email_sent', 'sms_sent', 'whatsapp_sent')) AS last_event,
         (SELECT MAX(s.created_at) FROM sms_messages s WHERE s.lead_id = l.id AND s.direction = 'in') AS last_reply,
         (SELECT MAX(m.clicked_at) FROM emails m WHERE m.lead_id = l.id) AS last_click,
         ${recentlyChased} AS chased
       FROM leads l WHERE l.status IN (${stages.map(() => '?').join(',')}) AND l.created_at < ? ORDER BY l.created_at DESC LIMIT 500`,
    ).bind(...stages, cutoff).all<Pick<Lead, 'id' | 'first_name' | 'last_name' | 'email' | 'status' | 'created_at' | 'app_completed_at' | 'showed_at'> & { last_event: number | null; last_reply: number | null; last_click: number | null; chased: number | null }>();
    const candidates: Candidate[] = [];
    for (const l of results) {
      const last = Math.max(l.created_at, l.last_event ?? 0, l.last_reply ?? 0, l.last_click ?? 0, l.app_completed_at ?? 0, l.showed_at ?? 0);
      if (last >= cutoff) continue; // active recently: not quiet
      if (l.chased && l.chased >= cutoff) { excluded.push({ lead_id: l.id, name: nameOf(l), why: `followed up ${Math.round((now - l.chased) / DAY)} days ago` }); continue; }
      const lead = await getLead(rt.env, l.id);
      if (lead) candidates.push({ lead, play, reason: `${l.status}, quiet ${Math.floor((now - last) / DAY)} days`, link: null });
    }
    return { candidates, excluded };
  }
  if (play === 'no_show') {
    const { results } = await db.prepare(`SELECT l.id, l.first_name, l.last_name, l.email, ${recentlyChased} AS chased FROM leads l WHERE l.status = 'no_show' AND l.call_at BETWEEN ? AND ? ORDER BY l.call_at DESC LIMIT 500`)
      .bind(now - 30 * DAY, now).all<Pick<Lead, 'id' | 'first_name' | 'last_name' | 'email'> & { chased: number | null }>();
    const candidates: Candidate[] = [];
    for (const row of results) {
      if (row.chased && row.chased >= now - 3 * DAY) { excluded.push({ lead_id: row.id, name: nameOf(row), why: 'followed up in the last 3 days' }); continue; }
      const l = await getLead(rt.env, row.id);
      if (!l) continue;
      const link = l.booking_reschedule_url && /^https:\/\//.test(l.booking_reschedule_url) ? l.booking_reschedule_url : `${rt.origin}/book`;
      candidates.push({ lead: l, play, reason: `missed the call ${Math.max(0, Math.floor((now - (l.call_at ?? now)) / DAY))} days ago`, link });
    }
    return { candidates, excluded };
  }
  // unpaid: the most relevant open checkout per lead, newest first.
  const from = now - 14 * DAY, settle = now - HOUR;
  const base = webinarBase(rt);
  const [seats, deposits, live, challenge] = await Promise.all([
    db.prepare(`SELECT p.lead_id, p.created_at FROM webinar_passes p WHERE p.kind = 'seat' AND p.status IN ('pending', 'expired') AND p.created_at BETWEEN ? AND ?
                 AND NOT EXISTS (SELECT 1 FROM webinar_passes q WHERE q.lead_id = p.lead_id AND q.kind = 'seat' AND q.status = 'paid')`).bind(from, settle).all<{ lead_id: string; created_at: number }>(),
    db.prepare(`SELECT p.lead_id, p.created_at, p.return_url FROM webinar_passes p WHERE p.kind = 'deposit' AND p.status IN ('pending', 'expired') AND p.created_at BETWEEN ? AND ?
                 AND NOT EXISTS (SELECT 1 FROM webinar_passes q WHERE q.lead_id = p.lead_id AND q.kind = 'deposit' AND q.status = 'paid')`).bind(from, settle).all<{ lead_id: string; created_at: number; return_url: string | null }>(),
    db.prepare(`SELECT g.lead_id, g.token, g.created_at FROM live_webinar_regs g JOIN live_webinars w ON w.id = g.event_id
                 WHERE g.ticket_required = 1 AND w.status = 'scheduled' AND w.starts_at > ? AND g.created_at < ?
                 AND NOT EXISTS (SELECT 1 FROM webinar_passes q WHERE q.lead_id = g.lead_id AND q.kind = 'live_ticket' AND q.status = 'paid')`).bind(now, settle).all<{ lead_id: string; token: string; created_at: number }>(),
    db.prepare(`SELECT r.lead_id, r.token, r.created_at FROM challenge_registrations r WHERE r.status = 'pending' AND r.created_at BETWEEN ? AND ?
                 AND NOT EXISTS (SELECT 1 FROM challenge_registrations x WHERE x.lead_id = r.lead_id AND x.status = 'paid')`).bind(from, settle).all<{ lead_id: string; token: string; created_at: number }>(),
  ]);
  const sameOrigin = (u: string | null) => (u && u.startsWith(`${rt.origin}/`) ? u : null);
  type Item = { lead_id: string; at: number; what: string; kind: string; link: string | null; prio: number };
  const items: Item[] = [
    ...deposits.results.map((d) => ({ lead_id: d.lead_id, at: d.created_at, what: 'your engagement deposit', kind: 'deposit', link: sameOrigin(d.return_url), prio: 0 })),
    ...live.results.map((d) => ({ lead_id: d.lead_id, at: d.created_at, what: 'your live webinar ticket', kind: 'live_ticket', link: `${rt.origin}/live/ticket/${d.token}`, prio: 1 })),
    ...challenge.results.map((d) => ({ lead_id: d.lead_id, at: d.created_at, what: 'your First Deal Challenge ticket', kind: 'challenge', link: `${rt.origin}/challenge/pay/${d.token}`, prio: 1 })),
    ...seats.results.map((d) => ({ lead_id: d.lead_id, at: d.created_at, what: 'your Masterclass ticket', kind: 'seat', link: null, prio: 2 })),
  ].sort((a, b) => a.prio - b.prio || b.at - a.at);
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  for (const it of items) {
    if (seen.has(it.lead_id)) continue;
    seen.add(it.lead_id);
    const l = await getLead(rt.env, it.lead_id);
    if (!l) continue;
    if (NEVER.includes(l.status) || l.refunded_at) { excluded.push({ lead_id: l.id, name: nameOf(l), why: l.refunded_at ? 'refunded' : l.status }); continue; }
    const chased = await db.prepare("SELECT MAX(COALESCE(sent_at, created_at)) AS t FROM ops_followup_messages WHERE lead_id = ? AND play = 'unpaid' AND status IN ('queued', 'sending', 'sent', 'simulated')").bind(l.id).first<{ t: number | null }>();
    if (chased?.t && chased.t >= now - 2 * DAY) { excluded.push({ lead_id: l.id, name: nameOf(l), why: 'chased in the last 2 days' }); continue; }
    const link = it.kind === 'seat' && l.webinar_token ? `${base}/ticket/${l.webinar_token}` : it.link;
    candidates.push({ lead: l, play, reason: `${it.what.replace(/^your /, '')} not paid`, link, what: it.what, kind: it.kind });
  }
  return { candidates, excluded };
}

// ───────────── what: the messages ─────────────

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const STAGE_LINE: Record<string, string> = {
  partial: 'You started an application with us and didn\'t finish it.',
  applied: 'You applied to work with us and we haven\'t heard back from you since.',
  booked: 'You booked a call with us and we haven\'t heard from you since.',
  showed: 'We spoke on a call and the conversation stopped there.',
  nurture: 'You were in touch with us a while back about buying a business.',
};

/** The base email for a candidate (personalised afterwards). Every string here passes auditEmail. */
export function baseEmail(c: Candidate): EmailContent {
  const name = safeFirstName(c.lead.first_name) ?? 'there';
  const hi = `Hi ${escHtml(name)},`;
  if (c.play === 'quiet') return {
    subject: 'Where your first acquisition stands',
    preheader: 'One question from Josh\'s team.',
    body: [hi, STAGE_LINE[c.lead.status] ?? STAGE_LINE.nurture, 'Is buying a competitor still on your list this year? Reply with a yes or a no and where things stand.', 'A yes gets you the next step from the team. A no means we stop following up.'],
  };
  if (c.play === 'no_show') return {
    subject: 'Your call time didn\'t work out',
    preheader: 'Pick a new time that suits you.',
    body: [hi, 'We had a call booked and it didn\'t happen. Plans change, and the call is still worth having if buying a competitor is on your list.', 'Pick a new time with the button below, or reply and the team will find one with you.'],
    ...(c.link ? { cta: { label: 'Pick a new time', href: c.link } } : {}),
  };
  const what = c.what ?? 'your order';
  return {
    subject: `Your ${what.replace(/^your /, '')} payment didn't go through`,
    preheader: 'Pick up where you left off.',
    body: [hi, `You started paying for ${escHtml(what)} and the payment didn't complete.`, c.link ? 'The button below takes you back to it. If something went wrong with the card, reply and the team will sort it out.' : 'Reply to this email and the team will send you a fresh link.'],
    ...(c.link ? { cta: { label: 'Finish the payment', href: c.link } } : {}),
  };
}

/** The text for a candidate: plain characters, who it's from, one link at most, the STOP line. */
export function baseSms(rt: Runtime, c: Candidate) {
  const name = safeFirstName(c.lead.first_name) ?? 'there';
  const from = `it's Josh's team at ${rt.settings.SITE_NAME || BRAND.name}`;
  const body = c.play === 'quiet'
    ? `Hi ${name}, ${from}. Is buying a competitor still on your list this year? Reply yes or no and we'll take it from there.`
    : c.play === 'no_show'
      ? `Hi ${name}, ${from}. We missed you on the call. Pick a new time here: ${c.link ?? `${rt.origin}/book`}`
      : `Hi ${name}, ${from}. The payment for ${c.what ?? 'your order'} didn't complete. ${c.link ? `Pick it up here: ${c.link}` : 'Answer this text and we\'ll send a fresh link.'}`;
  return `${body.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-')}\nReply STOP to opt out.`;
}

const PURPOSE: Record<Play, string> = {
  quiet: 'A short check-in to a lead who went quiet: ask whether buying a competitor is still on their list and invite a one-line reply. No pressure, no deadline.',
  no_show: 'They missed their booked call. Invite them to pick a new time, no guilt.',
  unpaid: 'Their checkout did not complete. Help them finish it or get a fresh link. Never invent a deadline.',
};

export interface Preview { id: string; lead_id: string; name: string; channel: Channel; to: string; subject: string | null; text: string; reason: string; send_at: number }
const htmlToText = (h: string) => h.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
export const emailPreviewText = (c: EmailContent) => [...c.body.map(htmlToText), c.cta ? `[${htmlToText(c.cta.label)}] ${c.cta.href}` : '', c.ps ? `P.S. ${htmlToText(c.ps)}` : ''].filter(Boolean).join('\n\n');

/**
 * Drafts the messages for a play and queues ONE proposal with a preview of each. Returns the batch and the
 * proposal id (null when nobody qualifies).
 */
export async function proposeFollowups(rt: Runtime, play: Play, o: { days?: number; stages?: string[]; channels?: Channel[]; now?: number } = {}) {
  const now = o.now ?? Date.now();
  const channels = (o.channels?.length ? o.channels : ['email', 'sms']).filter((c): c is Channel => c === 'email' || c === 'sms');
  const { candidates, excluded } = await findCandidates(rt, play, o);
  const batchId = newId('fb');
  const previews: Preview[] = [];
  const stmts: D1PreparedStatement[] = [];
  let leads = 0;
  for (const c of candidates) {
    if (leads >= MAX_PER_BATCH) { excluded.push({ lead_id: c.lead.id, name: nameOf(c.lead), why: `over the ${MAX_PER_BATCH} per batch limit (next batch)` }); continue; }
    if (NEVER.includes(c.lead.status)) { excluded.push({ lead_id: c.lead.id, name: nameOf(c.lead), why: c.lead.status }); continue; }
    const blocks: string[] = [];
    let any = false;
    for (const ch of channels) {
      const why = ch === 'email' ? await emailBlock(rt, c.lead) : textBlock(c.lead);
      if (why) { blocks.push(`${ch}: ${why}`); continue; }
      any = true;
      const id = newId('fm');
      const sendAt = sendTimeFor(rt, c.lead, ch, now) ?? now;
      if (ch === 'email') {
        const profile = await buildProfile(rt.env, c.lead).catch(() => null);
        const base = baseEmail(c);
        const p = profile ? await personalizeEmail(rt.settings, base, `ops_${play}`, profile, new Set(), { purpose: PURPOSE[play], callTime: null }) : { content: base };
        // Links never go to the model: the button is put back exactly as drafted.
        const content: EmailContent = { ...p.content, ...(base.cta ? { cta: base.cta } : {}) };
        stmts.push(rt.env.DB.prepare('INSERT INTO ops_followup_messages (id, batch_id, play, lead_id, channel, to_addr, subject, body, link, status, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, batchId, play, c.lead.id, 'email', c.lead.email, content.subject, JSON.stringify(content), c.link, 'draft', sendAt, now));
        previews.push({ id, lead_id: c.lead.id, name: nameOf(c.lead), channel: 'email', to: c.lead.email!, subject: content.subject, text: emailPreviewText(content), reason: c.reason, send_at: sendAt });
      } else {
        const text = baseSms(rt, c);
        stmts.push(rt.env.DB.prepare('INSERT INTO ops_followup_messages (id, batch_id, play, lead_id, channel, to_addr, subject, body, link, status, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(id, batchId, play, c.lead.id, 'sms', c.lead.phone, null, text, c.link, 'draft', sendAt, now));
        previews.push({ id, lead_id: c.lead.id, name: nameOf(c.lead), channel: 'sms', to: c.lead.phone!, subject: null, text, reason: c.reason, send_at: sendAt });
      }
    }
    if (any) leads++;
    if (blocks.length) excluded.push({ lead_id: c.lead.id, name: nameOf(c.lead), why: blocks.join('; ') });
  }
  for (let i = 0; i < stmts.length; i += 50) await rt.env.DB.batch(stmts.slice(i, i + 50));
  if (!previews.length) return { batchId, actionId: null, previews, excluded, leads: 0 };
  const emails = previews.filter((p) => p.channel === 'email').length, texts = previews.length - emails;
  const later = previews.filter((p) => p.send_at > now + 5 * 60_000).length;
  const detail = [
    `${leads} lead${leads === 1 ? '' : 's'}: ${emails} email${emails === 1 ? '' : 's'}, ${texts} text${texts === 1 ? '' : 's'}.${later ? ` ${later} wait for the recipient's sending hours.` : ''}`,
    excluded.length ? `${excluded.length} left out (consent, suppression, recent follow-up or limit): ${excluded.slice(0, 8).map((x) => `${x.name} (${x.why})`).join(', ')}${excluded.length > 8 ? ', …' : ''}.` : '',
    '',
    ...previews.slice(0, 12).map((p) => `${p.name} · ${p.channel} · ${p.reason}\n${p.subject ? `Subject: ${p.subject}\n` : ''}${p.text}`),
    previews.length > 12 ? `…and ${previews.length - 12} more in Funnel HQ → Follow-up actions.` : '',
    '',
    'Source: Funnel HQ → Follow-up actions (leads, events, emails, texts and payments in our database).',
  ].filter((l) => l !== '').join('\n\n');
  const actionId = await proposeAction(rt, { dept: 'sales', kind: 'sales.bulk_followup', summary: `${SALES_PLAYS[play].label}: ${leads} lead${leads === 1 ? '' : 's'}`, detail, risk: 'medium',
    payload: { batch_id: batchId, play, leads, emails, texts } });
  await rt.env.DB.prepare('UPDATE ops_followup_messages SET action_id = ? WHERE batch_id = ?').bind(actionId, batchId).run();
  return { batchId, actionId, previews, excluded, leads };
}

// ───────────── sending (approval, then the cron for anything waiting for sending hours) ─────────────

interface MsgRow { id: string; batch_id: string; play: Play; lead_id: string; channel: Channel; to_addr: string; subject: string | null; body: string; link: string | null; status: string; send_at: number; created_at: number }

/** Approves a batch: every draft still in it is queued for its sending time, then whatever is due goes now. */
export async function approveBatch(rt: Runtime, batchId: string, now = Date.now()) {
  await rt.env.DB.prepare("UPDATE ops_followup_messages SET status = 'queued' WHERE batch_id = ? AND status = 'draft'").bind(batchId).run();
  const r = await processFollowupQueue(rt, { batchId, now });
  const { results } = await rt.env.DB.prepare('SELECT status, COUNT(*) AS n FROM ops_followup_messages WHERE batch_id = ? GROUP BY 1').bind(batchId).all<{ status: string; n: number }>();
  const by = Object.fromEntries(results.map((x) => [x.status, x.n])) as Record<string, number>;
  return { ...r, counts: by };
}

/** Why a message must not go any more (null = send). */
async function stillOk(rt: Runtime, m: MsgRow, lead: Lead | null) {
  if (!lead) return 'lead deleted';
  if (NEVER.includes(lead.status)) return lead.status;
  if (m.channel === 'email') { if (lead.email !== m.to_addr) return 'email changed'; const b = await emailBlock(rt, lead); if (b) return b; }
  else { if (lead.phone !== m.to_addr) return 'number changed'; const b = textBlock(lead); if (b) return b; }
  if (m.play === 'no_show' && lead.status !== 'no_show') return 'rebooked or moved on';
  if (m.play === 'quiet') {
    const act = await rt.env.DB.prepare("SELECT 1 FROM events WHERE lead_id = ? AND ts > ? AND source NOT IN ('cron', 'admin') AND name NOT IN ('email_sent', 'sms_sent', 'whatsapp_sent') LIMIT 1").bind(lead.id, m.created_at).first();
    const reply = await rt.env.DB.prepare("SELECT 1 FROM sms_messages WHERE lead_id = ? AND direction = 'in' AND created_at > ? LIMIT 1").bind(lead.id, m.created_at).first();
    if (act || reply) return 'active again since the draft';
  }
  if (m.play === 'unpaid') {
    const paid = await rt.env.DB.prepare(`SELECT 1 FROM webinar_passes WHERE lead_id = ? AND status = 'paid' AND paid_at > ?
      UNION SELECT 1 FROM challenge_registrations WHERE lead_id = ? AND status = 'paid' AND paid_at > ? LIMIT 1`).bind(lead.id, m.created_at, lead.id, m.created_at).first();
    if (paid) return 'paid since the draft';
  }
  // One follow-up per lead per channel per batch window: never two of ours within a day.
  const dup = await rt.env.DB.prepare("SELECT 1 FROM ops_followup_messages WHERE lead_id = ? AND channel = ? AND id <> ? AND status IN ('sent', 'simulated') AND sent_at > ? LIMIT 1").bind(lead.id, m.channel, m.id, Date.now() - DAY).first();
  if (dup) return 'already followed up today';
  if (m.channel === 'sms') {
    const today = await rt.env.DB.prepare("SELECT COUNT(*) AS n FROM sms_messages WHERE lead_id = ? AND direction = 'out' AND status IN ('sent', 'simulated') AND sent_at > ?").bind(lead.id, Date.now() - DAY).first<{ n: number }>();
    if ((today?.n ?? 0) >= 3) return 'daily text cap (3)';
  }
  return null;
}

export async function processFollowupQueue(rt: Runtime, o: { batchId?: string; now?: number; limit?: number } = {}) {
  const now = o.now ?? Date.now();
  const db = rt.env.DB;
  const { results } = await db.prepare(`SELECT * FROM ops_followup_messages WHERE status = 'queued' AND send_at <= ? ${o.batchId ? 'AND batch_id = ?' : ''} ORDER BY send_at LIMIT ?`)
    .bind(...(o.batchId ? [now, o.batchId] : [now]), o.limit ?? 40).all<MsgRow>();
  let sent = 0, skipped = 0, deferred = 0, failed = 0;
  for (const m of results) {
    const claim = await db.prepare("UPDATE ops_followup_messages SET status = 'sending' WHERE id = ? AND status = 'queued'").bind(m.id).run();
    if (!claim.meta.changes) continue;
    const lead = await getLead(rt.env, m.lead_id);
    const why = await stillOk(rt, m, lead);
    if (why) { await db.prepare("UPDATE ops_followup_messages SET status = 'skipped', error = ? WHERE id = ?").bind(why, m.id).run(); skipped++; continue; }
    // Sending hours, checked again at the moment of sending.
    const at = sendTimeFor(rt, lead!, m.channel, now);
    if (at == null || at > now + 60_000) {
      await db.prepare("UPDATE ops_followup_messages SET status = ?, send_at = ?, error = ? WHERE id = ?").bind(at == null ? 'skipped' : 'queued', at ?? now, at == null ? 'no sending hours found' : null, m.id).run();
      if (at == null) skipped++; else deferred++;
      continue;
    }
    try {
      const status = m.channel === 'email' ? await sendEmail(rt, m, lead!, now) : await sendText(rt, m, lead!, now);
      await db.prepare('UPDATE ops_followup_messages SET status = ?, sent_at = ?, error = NULL WHERE id = ?').bind(status, Date.now(), m.id).run();
      sent++;
    } catch (e) {
      await db.prepare("UPDATE ops_followup_messages SET status = 'failed', error = ? WHERE id = ?").bind(String(e instanceof Error ? e.message : e).slice(0, 300), m.id).run();
      failed++;
    }
  }
  return { due: results.length, sent, skipped, deferred, failed };
}

/** Through Resend (recorded in emails, with the open pixel and the one-click unsubscribe); simulated without a key. */
async function sendEmail(rt: Runtime, m: MsgRow, lead: Lead, now: number) {
  const content = JSON.parse(m.body) as EmailContent;
  const emailId = newId('m');
  const unsubscribeUrl = `${rt.origin}/u/${lead.id}/${await unsubscribeSig(rt, lead.id)}`;
  const { html, text } = renderEmail(content, { openPixel: `${rt.origin}/o/${emailId}.gif`, unsubscribeUrl, signature: rt.settings.EMAIL_SIGNATURE || 'Josh', address: rt.settings.BUSINESS_ADDRESS || rt.settings.SITE_NAME || BRAND.name });
  const step = Math.floor(now / 1000) % 2_000_000_000;
  await rt.env.DB.prepare("INSERT INTO emails (id, lead_id, sequence, step, template, to_email, subject, send_at, status, created_at) VALUES (?, ?, 'ops_followup', ?, ?, ?, ?, ?, 'sending', ?)")
    .bind(emailId, lead.id, step, `ops_${m.play}`, m.to_addr, content.subject, now, now).run();
  let status = 'simulated', providerId: string | null = null;
  if (emailConfigured(rt)) { providerId = await sendViaResend(rt, { to: m.to_addr, subject: content.subject, html, text, unsubscribeUrl, tags: { sequence: 'ops_followup', template: `ops_${m.play}` } }); status = 'sent'; }
  await rt.env.DB.prepare('UPDATE emails SET status = ?, sent_at = ?, provider_id = ? WHERE id = ?').bind(status, Date.now(), providerId, emailId).run();
  return status;
}

/** Through Twilio (recorded in sms_messages, so replies and STOP thread with it); simulated without Twilio. */
async function sendText(rt: Runtime, m: MsgRow, lead: Lead, now: number) {
  let status = 'simulated', providerId: string | null = null;
  if (smsConfigured(rt)) { providerId = await sendSmsNow(rt, m.to_addr, m.body); status = 'sent'; }
  const step = Math.floor(now / 1000) % 2_000_000_000;
  await rt.env.DB.prepare("INSERT INTO sms_messages (id, lead_id, direction, sequence, step, template, to_phone, body, send_at, status, sent_at, provider_id, channel, created_at) VALUES (?, ?, 'out', 'ops_followup', ?, ?, ?, ?, ?, ?, ?, ?, 'sms', ?)")
    .bind(newId('sm'), lead.id, step, `ops_${m.play}`, m.to_addr, m.body, now, status, Date.now(), providerId, now).run();
  return status;
}

registerActionHandler('sales.bulk_followup', async (rt, p) => {
  const batchId = typeof p.batch_id === 'string' ? p.batch_id : '';
  if (!/^fb[a-z0-9]{8,}$/.test(batchId)) return { ok: false, summary: 'No batch in the proposal.' };
  const r = await approveBatch(rt, batchId);
  const c = r.counts;
  const parts = [`${(c.sent ?? 0) + (c.simulated ?? 0)} sent${c.simulated ? ` (${c.simulated} simulated: connect Resend / Twilio to send for real)` : ''}`, c.queued ? `${c.queued} waiting for sending hours` : '', c.skipped ? `${c.skipped} skipped at send time` : '', c.failed ? `${c.failed} failed` : ''].filter(Boolean);
  return { ok: (c.failed ?? 0) === 0, summary: `Follow-up batch: ${parts.join(', ')}.` };
});
