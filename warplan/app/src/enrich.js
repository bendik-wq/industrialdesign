// Contact finder: emails and phone numbers for a target, from its own website (homepage + contact/about pages),
// likely owner addresses built from the owner's name and the company domain (marked as guesses), and, when the
// workspace connects a Hunter.io key, Hunter's domain search and verified email finder.
import { safeFetch } from "./net.js";
const UA = "Mozilla/5.0 (compatible; WarplanBot/2; +https://warplan.bendik-50e.workers.dev)";
const err = (status, message) => Object.assign(new Error(message), { status });
const CONTACT_WORDS = /contact|kontakt|about|om-oss|om_oss|omoss|team|people|staff|ansatte|impressum|mentions|qui-sommes|equipe|who-we-are|ledelse/i;
const JUNK_EMAIL = /\.(png|jpe?g|gif|webp|svg|css|js)$|@(example|domain|email|sentry|wixpress|sentry-next)\.|^(no-?reply|noreply|donotreply)@|u003e|%/i;

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } }
function normUrl(u) { if (!u) return ""; return /^https?:\/\//i.test(u) ? u : `https://${u}`; }

async function fetchPage(url) {
  try {
    const res = await safeFetch(url, { headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok || !(res.headers.get("Content-Type") || "").includes("html")) return null;
    const text = await res.text();
    return { url: res.url, html: text.slice(0, 1_500_000) };
  } catch { return null; }
}

// Cloudflare's email obfuscation: <a data-cfemail="hex">.
function decodeCf(hex) {
  const key = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
  return out;
}

const decodeEntities = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&commat;/gi, "@").replace(/&period;/gi, ".").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")
  .replace(/\s*[\[(]\s*at\s*[\])]\s*/gi, "@").replace(/\s*[\[(]\s*dot\s*[\])]\s*/gi, ".");

export function extract(html, pageUrl) {
  const emails = new Map(), phones = new Map(), links = new Set();
  const addEmail = (e, how) => {
    e = decodeEntities(e).trim().replace(/^mailto:/i, "").split("?")[0].toLowerCase();
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e) || JUNK_EMAIL.test(e)) return;
    if (!emails.has(e)) emails.set(e, how);
  };
  const addPhone = (p, how) => {
    const clean = decodeEntities(p).replace(/^tel:/i, "").replace(/[^\d+]/g, "");
    const digits = clean.replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15 || /^(\d)\1+$/.test(digits)) return;
    const pretty = decodeEntities(p).replace(/^tel:/i, "").replace(/%20/g, " ").trim();
    if (![...phones.keys()].some((k) => k.replace(/\D/g, "").endsWith(digits.slice(-8)))) phones.set(pretty, how);
  };
  for (const m of html.matchAll(/href=["']mailto:([^"']+)["']/gi)) addEmail(decodeURIComponent(m[1]), "mailto link");
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) addEmail(decodeCf(m[1]), "protected email");
  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) addPhone(decodeURIComponent(m[1]), "tel link");
  const text = decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) addEmail(m[0], "on the page");
  for (const m of text.matchAll(/(?:tel|phone|telefon|tlf|t:|ph|call us|ring oss|téléphone)[.:\s]*((?:\+|00)?[\d][\d\s().-]{6,18}\d)/gi)) addPhone(m[1], "on the page");
  for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try { const u = new URL(m[1], pageUrl); if (u.protocol.startsWith("http") && hostOf(u.href) === hostOf(pageUrl) && CONTACT_WORDS.test(u.pathname)) links.add(u.href.split("#")[0]); } catch { /* bad href */ }
  }
  return { emails, phones, links: [...links] };
}

const ascii = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ø/g, "o").replace(/æ/g, "ae").replace(/å/g, "a").toLowerCase().replace(/[^a-z]/g, "");
const PATTERNS = { first: (f) => f, "first.last": (f, l) => `${f}.${l}`, firstlast: (f, l) => `${f}${l}`, flast: (f, l) => `${f[0]}${l}`, "f.last": (f, l) => `${f[0]}.${l}` };
// Likely owner addresses. `pattern` (detected from the company's real addresses) goes first when known.
export function ownerGuesses(ownerName, domain, pattern = null) {
  const parts = String(ownerName || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2 || !domain) return [];
  const f = ascii(parts[0]), l = ascii(parts[parts.length - 1]);
  if (!f || !l) return [];
  const order = pattern && PATTERNS[pattern] ? [pattern, ...Object.keys(PATTERNS).filter((k) => k !== pattern)] : Object.keys(PATTERNS);
  return [...new Set(order.map((k) => `${PATTERNS[k](f, l)}@${domain}`))];
}

// From addresses like "magnus.spone@x.no" work out the domain people use and the naming pattern.
export function companyPattern(emails) {
  const people = emails.filter((e) => !/^(post|info|kontakt|contact|hello|office|mail|admin|firmapost|sales|salg|service|regnskap|faktura|invoice|support|jobb|careers)@/.test(e));
  if (!people.length) return {};
  const domains = {};
  people.forEach((e) => { const d = e.split("@")[1]; domains[d] = (domains[d] || 0) + 1; });
  const domain = Object.entries(domains).sort((a, b) => b[1] - a[1])[0][0];
  const locals = people.filter((e) => e.endsWith(`@${domain}`)).map((e) => e.split("@")[0]);
  const counts = { "first.last": locals.filter((x) => /^[a-z]+\.[a-z]+$/.test(x) && x.split(".")[0].length > 1).length, "f.last": locals.filter((x) => /^[a-z]\.[a-z]+$/.test(x)).length, first: locals.filter((x) => /^[a-z]{3,}$/.test(x)).length };
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { domain, pattern: best[1] >= 2 ? best[0] : null };
}

async function hunter(key, domain, owner) {
  const out = [];
  const q = (path) => fetch(`https://api.hunter.io/v2/${path}&api_key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(10000) }).then((r) => (r.ok ? r.json() : r.status === 401 ? Promise.reject(err(400, "Hunter rejected the API key")) : null));
  const parts = String(owner || "").trim().split(/\s+/);
  if (parts.length >= 2) {
    const f = await q(`email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(parts[0])}&last_name=${encodeURIComponent(parts[parts.length - 1])}`);
    if (f?.data?.email) out.push({ kind: "email", value: f.data.email.toLowerCase(), label: `${owner} (owner)`, source: "Hunter", confidence: f.data.score >= 80 ? "high" : "medium" });
  }
  const d = await q(`domain-search?domain=${encodeURIComponent(domain)}&limit=10`);
  for (const e of d?.data?.emails || []) out.push({ kind: "email", value: e.value.toLowerCase(), label: [e.first_name, e.last_name].filter(Boolean).join(" ") + (e.position ? ` · ${e.position}` : "") || e.type, source: "Hunter", confidence: e.confidence >= 80 ? "high" : "medium" });
  if (d?.data?.pattern) out.push({ kind: "pattern", value: d.data.pattern, label: "Company email pattern", source: "Hunter", confidence: "medium" });
  return out;
}

// Find contacts for a target. Returns [{kind, value, label, source, confidence}] (best first).
export async function findContacts(target, keys = {}) {
  const site = normUrl(target.website);
  const found = [];
  const pagesRead = [];
  let domain = hostOf(site) || (target.email?.includes("@") ? target.email.split("@")[1] : "");
  if (site) {
    const home = await fetchPage(site);
    if (home) {
      domain = hostOf(home.url) || domain;
      pagesRead.push(home.url);
      const first = extract(home.html, home.url);
      const more = first.links.sort((a, b) => /contact|kontakt/i.test(b) - /contact|kontakt/i.test(a)).slice(0, 3);
      const pages = (await Promise.all(more.map(fetchPage))).filter(Boolean);
      const all = [first, ...pages.map((p) => { pagesRead.push(p.url); return extract(p.html, p.url); })];
      const emails = new Map(), phones = new Map();
      all.forEach((x) => { x.emails.forEach((how, e) => emails.has(e) || emails.set(e, how)); x.phones.forEach((how, p) => phones.has(p) || phones.set(p, how)); });
      for (const [e, how] of emails) {
        const same = domain && e.endsWith(`@${domain}`);
        found.push({ kind: "email", value: e, label: /^(post|info|kontakt|contact|hello|office|mail|admin|firmapost|sales|salg)@/.test(e) ? "General inbox" : "Person or team", source: `Website (${how})`, confidence: same ? "high" : "medium" });
      }
      for (const [p, how] of phones) found.push({ kind: "phone", value: p, label: "Phone", source: `Website (${how})`, confidence: how === "tel link" ? "high" : "medium" });
    }
  }
  // Recognise the owner's own address among what the website lists (first@, first.last@, initials...).
  const parts = String(target.owner_name || "").trim().split(/\s+/).filter(Boolean).map(ascii);
  let ownerFound = false;
  if (parts.length) {
    const f = parts[0], l = parts[parts.length - 1];
    for (const c of found) {
      if (c.kind !== "email") continue;
      const local = c.value.split("@")[0].replace(/[^a-z]/g, "");
      const hit = (l && (local === `${f}${l}` || local === `${f[0]}${l}` || local.includes(l) && local.startsWith(f[0]))) || (local === f);
      if (hit) { c.label = `${target.owner_name} (owner)`; c.confidence = "high"; c.owner = true; ownerFound = true; }
    }
  }
  if (keys.hunter && domain) { try { found.push(...(await hunter(keys.hunter, domain, target.owner_name))); } catch (e) { if (e.status) throw e; } }
  const haveOwnerEmail = ownerFound || found.some((c) => c.kind === "email" && c.label?.includes("(owner)"));
  const cp = companyPattern(found.filter((c) => c.kind === "email").map((c) => c.value));
  if (!haveOwnerEmail) for (const g of ownerGuesses(target.owner_name, cp.domain || domain, cp.pattern).slice(0, cp.pattern ? 3 : 5)) if (!found.some((c) => c.value === g)) found.push({ kind: "email", value: g, label: `${target.owner_name} (owner, guessed pattern)`, source: "Pattern guess", confidence: "guess" });
  const rank = { high: 0, medium: 1, guess: 2 };
  const uniq = [...new Map(found.map((c) => [`${c.kind}:${c.value}`, c])).values()].sort((a, b) => (a.kind === b.kind ? (b.owner ? 1 : 0) - (a.owner ? 1 : 0) || rank[a.confidence] - rank[b.confidence] : a.kind === "email" ? -1 : 1));
  // Keep it useful: every email, but only the first few phone numbers (office directories list dozens).
  const phones = uniq.filter((c) => c.kind === "phone").slice(0, 4);
  return { contacts: [...uniq.filter((c) => c.kind !== "phone").slice(0, 25), ...phones], domain: cp.domain || domain, pattern: cp.pattern || null, pages: pagesRead };
}
