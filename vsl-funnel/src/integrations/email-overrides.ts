import type { Runtime } from '../app';
import type { Lead } from '../funnel/leads';
import { FOLLOWUP_TEMPLATES } from '../followup/templates';
import { type EmailContent, TEMPLATES, type TemplateCtx } from './templates';

/**
 * Email editor (Funnel HQ → Email editor). Built-in emails are code; an edit is stored as text with merge
 * tags and replaces the built-in version when the email is built. Deleting the edit restores the default.
 *
 * Editor text format: paragraphs separated by a blank line; a single line break stays a line break;
 * **bold**; [link text](url). URLs may be https://…, mailto:…, a path like /breakout, or a link tag.
 */

export const MERGE_TAGS = {
  first_name: 'Their first name (or “there”)',
  site_name: 'Your brand name',
  call_time: 'Their call time, in their time zone',
  booking_link: 'Their booking page (or the application if they haven’t qualified)',
  join_link: 'The meeting link for their call',
  reschedule_link: 'Their reschedule link',
  whatsapp_link: 'WhatsApp chat with Josh',
  webinar_title: 'Webinar title',
  webinar_time: 'Their webinar session time',
  webinar_room_link: 'Their personal webinar room link',
  webinar_replay_link: 'Their replay link',
  webinar_calendar_link: 'Add-to-calendar link',
  webinar_google_link: 'Google Calendar link',
  replay_hours: 'Hours the replay stays up',
  webinar_minutes: 'Webinar length in minutes',
} as const;

/** Written from each lead's own answers, or changes with the lead's progress: shown, not editable. */
const NOT_EDITABLE = new Set(['resume_link', 'voice_link', ...Object.keys(FOLLOWUP_TEMPLATES)]);
export const isEditable = (t: string) => Boolean(TEMPLATES[t]) && !NOT_EDITABLE.has(t);

export interface Override { template: string; subject: string; preheader: string | null; body: string; cta_label: string | null; cta_href: string | null; ps: string | null; updated_at: number }

// ───────── HTML ⇄ editor text ─────────
const decode = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
export function htmlToText(html: string) {
  return decode(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    .replace(/<[^>]+>/g, ''));
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const SAFE_URL = /^(https:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+|\/[\w\-/?=&.#%]*|\{(?:link:\/[\w\-/?=&.#%]*|[a-z_]+_link)\})$/;
export function textToHtml(text: string) {
  return esc(text)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => (SAFE_URL.test(decode(url)) ? `<a href="${url}">${label}</a>` : label))
    .replace(/\n/g, '<br>');
}

// ───────── The built-in email, with merge tags instead of a real lead ─────────
export function defaultEditable(template: string): { subject: string; preheader: string; body: string; cta_label: string; cta_href: string; ps: string } | null {
  const tpl = TEMPLATES[template];
  if (!tpl) return null;
  const ctx: TemplateCtx = {
    lead: { id: 'x', first_name: '{first_name}', status: 'booked', app_completed_at: 1, booked_at: 1, call_at: 1 } as unknown as Lead,
    name: '{first_name}',
    siteName: '{site_name}',
    link: (p: string) => (p.startsWith('{') ? p : /^https?:/.test(p) ? p : `{link:${p}}`),
    bookingUrl: '{booking_link}',
    whatsappUrl: '{whatsapp_link}',
    callTime: '{call_time}',
    joinUrl: '{join_link}',
    rescheduleUrl: '{reschedule_link}',
    webinar: { title: '{webinar_title}', when: '{webinar_time}', room: '{webinar_room_link}', replay: '{webinar_replay_link}', ics: '{webinar_calendar_link}', google: '{webinar_google_link}', replayHours: '{replay_hours}' as unknown as number, durationMin: '{webinar_minutes}' as unknown as number },
  };
  let c: EmailContent;
  try { c = tpl(ctx); } catch { return null; }
  return {
    subject: htmlToText(c.subject),
    preheader: htmlToText(c.preheader ?? ''),
    body: c.body.filter(Boolean).map(htmlToText).join('\n\n'),
    cta_label: c.cta ? htmlToText(c.cta.label) : '',
    cta_href: c.cta ? c.cta.href : '',
    ps: c.ps ? htmlToText(c.ps) : '',
  };
}

// ───────── Applying an edit to a real lead ─────────
export function fromOverride(o: Pick<Override, 'subject' | 'preheader' | 'body' | 'cta_label' | 'cta_href' | 'ps'>, c: TemplateCtx): EmailContent {
  const w = c.webinar;
  const vals: Record<string, string> = {
    first_name: esc(c.name),
    site_name: esc(c.siteName),
    call_time: esc(c.callTime ?? 'your booked time'),
    booking_link: c.bookingUrl ? c.link(c.bookingUrl) : c.link('/apply'),
    join_link: c.joinUrl ? c.link(c.joinUrl) : c.link('/breakout'),
    reschedule_link: c.rescheduleUrl ? c.link(c.rescheduleUrl) : c.bookingUrl ? c.link(c.bookingUrl) : c.link('/apply'),
    whatsapp_link: c.whatsappUrl ?? c.link('/breakout'),
    webinar_title: esc(w?.title ?? 'the masterclass'),
    webinar_time: esc(w?.when ?? 'your session time'),
    webinar_room_link: w?.room ?? c.link('/webinar'),
    webinar_replay_link: w?.replay ?? c.link('/webinar'),
    webinar_calendar_link: w?.ics ?? c.link('/webinar'),
    webinar_google_link: w?.google ?? c.link('/webinar'),
    replay_hours: String(w?.replayHours ?? 48),
    webinar_minutes: String(w?.durationMin ?? 60),
  };
  const fill = (s: string) => s
    .replace(/\{link:(\/[\w\-/?=&.#%;]*)\}/g, (_m, p: string) => c.link(p.replace(/&amp;/g, '&')))
    .replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in vals ? vals[k] : m));
  const href = (raw: string | null) => {
    const h = (raw ?? '').trim();
    if (!h) return null;
    if (/^\{[a-z_]+_link\}$/.test(h) || /^\{link:\//.test(h)) return fill(h);
    if (/^\//.test(h) || /^https:\/\//.test(h)) return c.link(h);
    return null;
  };
  // Subject / preheader / button: plain text (escaped later where it lands in HTML); link tags make no sense there.
  const raw: Record<string, string> = { first_name: c.name, site_name: c.siteName, call_time: c.callTime ?? 'your booked time', webinar_title: w?.title ?? 'the masterclass', webinar_time: w?.when ?? 'your session time', replay_hours: vals.replay_hours, webinar_minutes: vals.webinar_minutes };
  const plain = (s: string) => s.replace(/\{link:[^}]*\}/g, '').replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in raw ? raw[k] : k.endsWith('_link') ? '' : m)).replace(/[<>]/g, '').replace(/\s{2,}/g, ' ').trim();
  const ctaHref = href(o.cta_href);
  return {
    subject: plain(o.subject),
    preheader: o.preheader ? plain(o.preheader) : '',
    body: o.body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => fill(textToHtml(p))),
    cta: o.cta_label && ctaHref ? { label: esc(plain(o.cta_label)), href: ctaHref } : undefined, // the label lands in HTML as-is
    ps: o.ps ? fill(textToHtml(o.ps)) : undefined,
  } as EmailContent;
}

// ───────── Storage (cached briefly; cleared on save in this isolate) ─────────
let cache: { at: number; map: Map<string, Override> } | null = null;
export async function loadOverrides(rt: Runtime) {
  if (cache && Date.now() - cache.at < 30_000) return cache.map;
  const { results } = await rt.env.DB.prepare('SELECT * FROM email_overrides').all<Override>().catch(() => ({ results: [] as Override[] }));
  cache = { at: Date.now(), map: new Map(results.map((r) => [r.template, r])) };
  return cache.map;
}
export const clearOverrideCache = () => { cache = null; };

export function cleanOverride(raw: Record<string, unknown>) {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\r/g, '').slice(0, max) : '');
  const out = {
    subject: str(raw.subject, 200).replace(/\n/g, ' ').trim(),
    preheader: str(raw.preheader, 200).replace(/\n/g, ' ').trim() || null,
    body: str(raw.body, 8000).trim(),
    cta_label: str(raw.cta_label, 80).trim() || null,
    cta_href: str(raw.cta_href, 500).trim() || null,
    ps: str(raw.ps, 1000).trim() || null,
  };
  if (!out.subject) throw new Error('The subject can’t be empty.');
  if (!out.body) throw new Error('The email needs some text.');
  if (out.cta_href && !SAFE_URL.test(out.cta_href)) throw new Error('The button link must be https://…, a page like /breakout, or a link tag like {booking_link}.');
  if (out.cta_label && !out.cta_href) throw new Error('Add a link for the button, or remove its label.');
  return out;
}
