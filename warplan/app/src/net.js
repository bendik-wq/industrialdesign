// Outbound requests to addresses users control (webhooks, company websites): public hosts on standard ports only,
// and every redirect hop is checked again.
const err = (status, message) => Object.assign(new Error(message), { status });

export function publicUrl(raw, { httpsOnly = false } = {}) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return null; }
  if (!(u.protocol === "https:" || (!httpsOnly && u.protocol === "http:"))) return null;
  if (u.username || u.password) return null;
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) return null;
  const h = u.hostname.toLowerCase().replace(/\.$/, "");
  // No IP literals at all (covers private ranges, IPv6, and decimal/hex forms like 2130706433 or 0x7f.1), and no
  // single-label or internal names.
  if (h.startsWith("[") || /^[\d.]+$/.test(h) || /^0x/i.test(h) || /^\d+$/.test(h.split(".").pop())) return null;
  if (!h.includes(".") || /(^|\.)(localhost|local|internal|intranet|lan|home|corp)$/.test(h)) return null;
  return u;
}

export async function safeFetch(raw, init = {}, { httpsOnly = false, hops = 4 } = {}) {
  let url = publicUrl(raw, { httpsOnly });
  for (let i = 0; i <= hops; i++) {
    if (!url) throw err(400, "That address isn't a public web address");
    const res = await fetch(url.toString(), { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("Location")) return res;
    url = publicUrl(new URL(res.headers.get("Location"), url).toString(), { httpsOnly });
  }
  throw err(502, "Too many redirects");
}
