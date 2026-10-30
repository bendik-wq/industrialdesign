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

// Is this IPv4/IPv6 address private, loopback, link-local, carrier-grade NAT, multicast or otherwise not public?
export function privateIp(ip) {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [+v4[1], +v4[2]];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === "::" || x === "::1" || /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || /^::ffff:/.test(x) || /^64:ff9b:/.test(x);
}
// Names like 127.0.0.1.nip.io pass a text check but point inside. Resolve the name (DNS over HTTPS) and refuse it if
// any address it resolves to isn't public. (Workers can't reach private networks anyway; this is defence in depth.)
export async function resolvesPublic(host, resolver = dohResolve) {
  const addrs = await resolver(host);
  return addrs.length > 0 && !addrs.some(privateIp);
}
async function dohResolve(host) {
  const out = [];
  for (const type of ["A", "AAAA"]) {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" } }).then((x) => x.json()).catch(() => ({}));
    for (const a of r.Answer || []) if (a.type === 1 || a.type === 28) out.push(String(a.data));
  }
  return out;
}

export async function safeFetch(raw, init = {}, { httpsOnly = false, hops = 4 } = {}) {
  let url = publicUrl(raw, { httpsOnly });
  for (let i = 0; i <= hops; i++) {
    if (!url) throw err(400, "That address isn't a public web address");
    if (!(await resolvesPublic(url.hostname))) throw err(400, "That address doesn't point to a public website");
    const res = await fetch(url.toString(), { ...init, redirect: "manual" });
    if (res.status < 300 || res.status >= 400 || !res.headers.get("Location")) return res;
    const next = publicUrl(new URL(res.headers.get("Location"), url).toString(), { httpsOnly });
    if (next && url && next.host !== url.host) init = { method: "GET", headers: Object.fromEntries(Object.entries(Object.fromEntries(new Headers(init.headers || {}))).filter(([k]) => !/^(authorization|cookie|x-warplan-signature|x-api-key)$/i.test(k))) };
    url = next;
  }
  throw err(502, "Too many redirects");
}
