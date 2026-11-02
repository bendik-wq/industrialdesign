/**
 * Calendar entries (pure, builder E "lifecycle"): RFC 5545 .ics files with a real VTIMEZONE (the event's own zone,
 * with every daylight-saving change in the years around it, read from the runtime's time zone data), a stable
 * UID per person and event, a SEQUENCE that goes up on every reschedule or cancel (so Apple Calendar and Outlook
 * update the entry they already hold instead of adding a second one), METHOD:CANCEL for a cancelled event, and
 * the Google and Outlook "add" links. Every entry carries the person's own room link.
 */

const MIN = 60_000;

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string, t: number) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(tz, f);
  }
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(t)) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour === 24 ? 0 : o.hour, mi: o.minute, s: o.second };
}

/** The zone's UTC offset at an instant, in minutes (east positive). */
export function tzOffsetMin(tz: string, t: number) {
  const p = parts(tz, t);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(t / 1000) * 1000) / MIN);
}
export function validTz(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

const p2 = (n: number) => String(n).padStart(2, '0');
/** 20261112T190000 in the zone (local wall time). */
export function localStamp(tz: string, t: number) {
  const p = parts(tz, t);
  return `${p.y}${p2(p.mo)}${p2(p.d)}T${p2(p.h)}${p2(p.mi)}${p2(p.s)}`;
}
/** 20261112T080000Z */
export const utcStamp = (t: number) => new Date(Math.floor(t / 1000) * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const offStr = (m: number) => `${m < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(m) / 60))}${p2(Math.abs(m) % 60)}`;
function tzName(tz: string, t: number) {
  try {
    const n = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(t).find((x) => x.type === 'timeZoneName')?.value;
    return (n ?? '').replace(/[^A-Za-z0-9+\-:]/g, '') || offStr(tzOffsetMin(tz, t));
  } catch { return offStr(tzOffsetMin(tz, t)); }
}

/** Every offset change between two instants (to the minute). */
export function transitions(tz: string, from: number, to: number) {
  const out: { at: number; from: number; to: number }[] = [];
  const STEP = 6 * 60 * MIN;
  let prevT = from, prev = tzOffsetMin(tz, from);
  for (let t = from + STEP; t <= to + STEP; t += STEP) {
    const cur = tzOffsetMin(tz, t);
    if (cur !== prev) {
      let lo = prevT, hi = t; // offset(lo) = prev, offset(hi) = cur
      while (hi - lo > MIN) { const mid = lo + Math.max(MIN, Math.floor((hi - lo) / 2 / MIN) * MIN); if (tzOffsetMin(tz, mid) === prev) lo = mid; else hi = mid; }
      out.push({ at: hi, from: prev, to: cur });
      prev = cur;
    }
    prevT = t;
  }
  return out;
}

/** A VTIMEZONE covering the year before the first instant to the year after the last (explicit DTSTARTs, no RRULE). */
export function vtimezone(tz: string, first: number, last: number) {
  if (tz === 'UTC' || tz === 'Etc/UTC') return ['BEGIN:VTIMEZONE', `TZID:${tz}`, 'BEGIN:STANDARD', 'DTSTART:19700101T000000', 'TZOFFSETFROM:+0000', 'TZOFFSETTO:+0000', 'TZNAME:UTC', 'END:STANDARD', 'END:VTIMEZONE'];
  const y0 = new Date(first).getUTCFullYear() - 1, y1 = new Date(last).getUTCFullYear() + 1;
  const from = Date.UTC(y0, 0, 1), to = Date.UTC(y1, 11, 31, 23, 59);
  const ts = transitions(tz, from, to);
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`];
  const base = tzOffsetMin(tz, from);
  const block = (type: 'STANDARD' | 'DAYLIGHT', start: string, f: number, t: number, name: string) => lines.push(`BEGIN:${type}`, `DTSTART:${start}`, `TZOFFSETFROM:${offStr(f)}`, `TZOFFSETTO:${offStr(t)}`, `TZNAME:${name}`, `END:${type}`);
  if (!ts.length) { block('STANDARD', '19700101T000000', base, base, tzName(tz, from)); }
  else {
    // The zone's state at the start of the range, then each change. A change to the larger offset is daylight time.
    block(ts[0].to > base ? 'STANDARD' : 'DAYLIGHT', localStamp(tz, from), base, base, tzName(tz, from));
    for (const x of ts) {
      // DTSTART is the wall-clock moment of the change in the offset in force before it.
      const wall = new Date(x.at + x.from * MIN);
      const start = `${wall.getUTCFullYear()}${p2(wall.getUTCMonth() + 1)}${p2(wall.getUTCDate())}T${p2(wall.getUTCHours())}${p2(wall.getUTCMinutes())}00`;
      block(x.to > x.from ? 'DAYLIGHT' : 'STANDARD', start, x.from, x.to, tzName(tz, x.at + MIN));
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}

const escText = (s: string) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** Folds a content line at 75 octets (UTF-8), never inside a character. */
export function fold(line: string) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let cur = '', n = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (n + b > limit) { out.push(cur); cur = ''; n = 0; limit = 74; }
    cur += ch; n += b;
  }
  if (cur) out.push(cur);
  return out.join('\r\n ');
}

export interface IcsEvent {
  uid: string; seq: number; start: number; end: number; tz: string; title: string; description: string; url: string;
  cancelled?: boolean; alarmMin?: number; stamp?: number; organizer?: { name: string; email: string } | null;
}
/** One calendar file for one event (or several, sharing the zone). */
export function buildIcs(events: IcsEvent[], o: { prodId?: string } = {}) {
  const tz = validTz(events[0]?.tz) ?? 'UTC';
  const cancelled = events.every((e) => e.cancelled);
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${o.prodId ?? '-//GL Advisory//Live//EN'}`, 'CALSCALE:GREGORIAN', `METHOD:${cancelled ? 'CANCEL' : 'PUBLISH'}`,
    ...vtimezone(tz, Math.min(...events.map((e) => e.start)), Math.max(...events.map((e) => e.end)))];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SEQUENCE:${Math.max(0, Math.floor(e.seq))}`, `DTSTAMP:${utcStamp(e.stamp ?? Date.now())}`,
      `DTSTART;TZID=${tz}:${localStamp(tz, e.start)}`, `DTEND;TZID=${tz}:${localStamp(tz, e.end)}`,
      `SUMMARY:${escText(e.title)}`, `DESCRIPTION:${escText(e.description)}`, `URL:${e.url}`, `LOCATION:${escText(e.url)}`,
      `STATUS:${e.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE');
    if (e.organizer?.email) lines.push(`ORGANIZER;CN=${escText(e.organizer.name).replace(/:/g, '')}:mailto:${e.organizer.email}`);
    if (!e.cancelled && e.alarmMin !== 0) lines.push('BEGIN:VALARM', `TRIGGER:-PT${e.alarmMin ?? 15}M`, 'ACTION:DISPLAY', `DESCRIPTION:${escText(e.title)}`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

/** Google Calendar's "add event" link (UTC times plus the zone for display). */
export function googleUrl(e: Pick<IcsEvent, 'start' | 'end' | 'tz' | 'title' | 'description' | 'url'>) {
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', e.title);
  u.searchParams.set('dates', `${utcStamp(e.start)}/${utcStamp(e.end)}`);
  u.searchParams.set('details', e.description);
  u.searchParams.set('location', e.url);
  if (validTz(e.tz)) u.searchParams.set('ctz', e.tz);
  return u.toString();
}
/** Outlook on the web (Microsoft 365 work accounts; outlook.com accounts are sent on by Microsoft). */
export function outlookUrl(e: Pick<IcsEvent, 'start' | 'end' | 'title' | 'description' | 'url'>, host = 'outlook.office.com') {
  const u = new URL(`https://${host}/calendar/0/action/compose`);
  u.searchParams.set('rru', 'addevent');
  u.searchParams.set('path', '/calendar/action/compose');
  u.searchParams.set('subject', e.title);
  u.searchParams.set('startdt', new Date(e.start).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  u.searchParams.set('enddt', new Date(e.end).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  u.searchParams.set('body', e.description);
  u.searchParams.set('location', e.url);
  return u.toString();
}

/** Minimal checks a calendar app relies on (used by the tests and the Funnel HQ preview). */
export function icsProblems(ics: string): string[] {
  const out: string[] = [];
  const lines = ics.split('\r\n');
  if (!ics.endsWith('\r\n')) out.push('no final CRLF');
  for (const l of lines) if (new TextEncoder().encode(l).length > 75) out.push(`line over 75 octets: ${l.slice(0, 30)}`);
  const un = ics.replace(/\r\n /g, '');
  const opens = (un.match(/^BEGIN:(\w+)/gm) ?? []).length, closes = (un.match(/^END:(\w+)/gm) ?? []).length;
  if (opens !== closes) out.push('BEGIN/END mismatch');
  for (const k of ['VERSION:2.0', 'PRODID:', 'BEGIN:VTIMEZONE', 'UID:', 'DTSTAMP:', 'SEQUENCE:']) if (!un.includes(k)) out.push(`missing ${k}`);
  const tzid = /^TZID:(.+)$/m.exec(un)?.[1];
  for (const m of un.matchAll(/^DT(?:START|END);TZID=([^:]+):/gm)) if (m[1] !== tzid) out.push(`TZID ${m[1]} has no VTIMEZONE`);
  return out;
}
