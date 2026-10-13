/**
 * Text a stranger typed (application answers, booking answers, page beacons) that we quote back in our own
 * emails must not be able to carry a link, a domain or a phone number: otherwise anyone can make our
 * domain send "pay at evil-site.com / call +1 555…" to any inbox. Those parts are replaced with "[…]".
 */
const URLISH = /(https?:\/\/|www\.)\S+/gi;
const DOMAINISH = /\b[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|net|org|io|co|au|nz|uk|us|ca|ie|sg|ae|app|xyz|info|biz|me|ly|link|site|online|shop|store|dev|ai|gg|to|cc|ru|cn|tk|top|click|live|pro)\b(\/\S*)?/gi;
const PHONEISH = /\+?\d[\d\s().-]{6,}\d/g;
const EMAILISH = /\S+@\S+/g;

export function defang(s: string) {
  return s.replace(URLISH, '[…]').replace(EMAILISH, '[…]').replace(DOMAINISH, '[…]').replace(PHONEISH, '[…]');
}

/** True when text contains something that would work as a link, address or number to call. */
export function hasContactBait(s: string) {
  return new RegExp(URLISH.source, 'i').test(s) || new RegExp(EMAILISH.source).test(s) || new RegExp(DOMAINISH.source, 'i').test(s) || new RegExp(PHONEISH.source).test(s);
}

/** A first name safe to put in a greeting or subject: looks like a name and carries no link, domain or number. */
export function safeFirstName(raw: string | null | undefined) {
  const n = (raw ?? '').trim();
  return n && /^[\p{L}][\p{L}' .-]{0,29}$/u.test(n) && !hasContactBait(n) && !/\.\S/.test(n.replace(/^(\p{L})\. /u, '')) ? n : null;
}
