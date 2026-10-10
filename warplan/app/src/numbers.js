// Phone numbers: country from an E.164 number, and local presence (call each owner from a number in their own
// country, and in North America from their own area code when you have one).

// Calling codes for the markets Warplan supports. Longest prefix wins, so +353 is Ireland, not +35.
export const COUNTRIES = {
  1: "US/Canada", 44: "United Kingdom", 61: "Australia", 64: "New Zealand", 353: "Ireland", 49: "Germany", 31: "Netherlands",
  32: "Belgium", 33: "France", 34: "Spain", 39: "Italy", 41: "Switzerland", 43: "Austria", 45: "Denmark", 46: "Sweden", 47: "Norway",
  351: "Portugal", 358: "Finland", 48: "Poland", 971: "UAE", 65: "Singapore", 852: "Hong Kong", 27: "South Africa", 52: "Mexico", 55: "Brazil",
};
const CODES = Object.keys(COUNTRIES).sort((a, b) => b.length - a.length);

export function countryCode(e164) {
  const d = String(e164 || "").replace(/^\+/, "");
  if (!/^\d{7,15}$/.test(d)) return null;
  return CODES.find((c) => d.startsWith(c)) || null;
}
export const countryName = (e164) => COUNTRIES[countryCode(e164)] || null;

// Pick the caller ID for a destination: same North American area code, then same country, then the default.
export function pickCallerId(numbers, to, fallback) {
  const list = [...new Set((numbers || []).filter((n) => /^\+\d{8,15}$/.test(n)))];
  const cc = countryCode(to);
  if (cc) {
    if (cc === "1") { const area = String(to).slice(2, 5); const same = list.find((n) => n.startsWith(`+1${area}`)); if (same) return same; }
    const local = list.find((n) => countryCode(n) === cc);
    if (local) return local;
  }
  return fallback || list[0] || null;
}

// Every number this workspace can call from: the default, extra numbers typed in Settings, and what setup found
// on the Twilio account (bought numbers and verified caller IDs).
export function callerNumbers(tw, cfg) {
  return [...new Set([tw?.from, ...(tw?.numbers || []), ...(cfg?.numbers || []).map((n) => n.number)].filter(Boolean))];
}
// Texting needs a number bought on Twilio with SMS; verified caller IDs can't send texts.
export function smsNumbers(tw, cfg) {
  const owned = (cfg?.numbers || []).filter((n) => n.sms).map((n) => n.number);
  return owned.length ? owned : [tw?.from].filter(Boolean);
}
