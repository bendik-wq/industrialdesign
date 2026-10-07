// Scans company websites (found by enrich-places.mjs) for succession and size signals:
//   founded / "since 19xx" / "family owned for N years", stale copyright year, retirement mentions,
//   truck & technician counts, and published contact emails.
// Respects robots.txt, fetches at most the homepage plus one about page, 4 sites at a time.
//
//   node ingest/enrich-web.mjs --limit 500
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const UA = "DealflowResearchBot/1.0 (+business research; contact via site owner)";
const YEAR = new Date().getFullYear();
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

export function extractSignals(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&copy;|&#169;/g, "©")
    .replace(/\s+/g, " ");
  const found = {};
  const years = [];
  for (const m of text.matchAll(/\b(?:since|est\.?|established|founded|serving[^.]{0,40}since|in business since)\s*(?:in\s*)?(19[5-9]\d|20[0-2]\d)\b/gi)) years.push(+m[1]);
  for (const m of text.matchAll(/\b(\d{2,3})\s*\+?\s*years?\s+(?:of\s+)?(?:experience|in business|serving|family[- ]owned)/gi)) {
    const n = +m[1];
    if (n >= 10 && n <= 90) years.push(YEAR - n);
  }
  if (years.length) found.foundedYear = Math.min(...years);
  const copy = [...text.matchAll(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => +m[1]);
  if (copy.length) found.copyrightYear = Math.max(...copy);
  if (/\bfamily[- ]owned\b/i.test(text)) found.familyOwned = true;
  if (/\b(second|third|2nd|3rd)[- ]generation\b/i.test(text)) found.multiGeneration = true;
  if (/\bretir(e|ed|ing|ement)\b/i.test(text)) found.mentionsRetirement = true;
  const trucks = text.match(/\b(\d{1,3})\s+(?:service\s+)?(?:trucks|vans|vehicles)\b/i);
  if (trucks) found.trucks = +trucks[1];
  const techs = text.match(/\b(\d{1,3})\s+(?:certified\s+|licensed\s+|nate[- ]certified\s+)?(?:technicians|techs|employees|team members)\b/i);
  if (techs) found.technicians = +techs[1];
  const emails = [...new Set([...html.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((m) => m[0].toLowerCase()))]
    .filter((e) => !/\.(png|jpg|jpeg|gif|webp|svg)$/.test(e) && !/(example|sentry|wixpress|godaddy|domain)\./.test(e));
  if (emails.length) found.emails = emails.slice(0, 5);
  return found;
}

async function get(url, ms = 10000) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { url: res.url, html: (await res.text()).slice(0, 1_500_000) };
}

async function allowedByRobots(origin) {
  try {
    const { html } = await get(`${origin}/robots.txt`, 5000);
    let applies = false;
    for (const line of html.split(/\r?\n/)) {
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k.trim())) applies = v === "*" || /dealflow/i.test(v);
      else if (applies && /^disallow$/i.test(k.trim()) && v === "/") return false;
    }
  } catch { /* no robots.txt → allowed */ }
  return true;
}

async function scan(website) {
  const origin = new URL(website).origin;
  if (!(await allowedByRobots(origin))) return { blocked: true };
  const home = await get(website);
  const signals = extractSignals(home.html);
  const about = home.html.match(/href=["']([^"']*(?:about|our-story|history|who-we-are)[^"']*)["']/i);
  if (about) {
    try {
      const page = await get(new URL(about[1], home.url).toString());
      const more = extractSignals(page.html);
      for (const [k, v] of Object.entries(more)) {
        if (k === "foundedYear") signals.foundedYear = Math.min(signals.foundedYear ?? v, v);
        else if (k === "emails") signals.emails = [...new Set([...(signals.emails || []), ...v])].slice(0, 5);
        else signals[k] ??= v;
      }
    } catch { /* about page optional */ }
  }
  return signals;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cachePath = join(DATA, "enrichment.json");
  const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};
  const queue = Object.entries(cache).filter(([, e]) => e.places?.website && !e.web).slice(0, Number(arg("limit", 500)));
  console.log(`scanning ${queue.length} websites`);
  let i = 0, ok = 0;
  async function worker() {
    while (i < queue.length) {
      const [key, e] = queue[i++];
      try {
        e.web = { ...(await scan(e.places.website)), checked: new Date().toISOString() };
        ok++;
      } catch (err) {
        e.web = { error: err.message, checked: new Date().toISOString() };
      }
      cache[key] = e;
    }
  }
  await Promise.all(Array.from({ length: 4 }, worker));
  writeFileSync(cachePath, JSON.stringify(cache));
  console.log(`done: ${ok}/${queue.length} scanned. Re-run ingest/build.mjs to apply.`);
}
