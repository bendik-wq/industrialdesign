// The open web for agents, through Monid: search (with each result's text inline), read any page (JavaScript
// rendered, anti-bot handled), and read any document by URL (PDF, Word, Excel, PowerPoint, images with OCR) into
// Markdown, e.g. a CIM, a P&L or a lease for the diligence agent.
import { run, compact } from "./monid.js";
import { safeFetch, publicUrl } from "./net.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n) => (String(s || "").length > n ? `${String(s).slice(0, n)}…` : String(s || ""));

export async function webSearch(env, ctx, { query, freshness, site, read = true }) {
  if (!String(query || "").trim()) throw err(400, "Say what to search for");
  const r = await run(env, ctx, { provider: "context.dev", endpoint: "/web/search", input: { body: {
    query: `${query}${site ? ` site:${site}` : ""}`, numResults: 10, ...(freshness && { freshness }), ...(read && { markdownOptions: { enabled: true, useMainContentOnly: true, includeLinks: false } }),
  } } }, { purpose: `Web search: ${clip(query, 80)}` });
  const list = r.output?.results || r.output?.data || [];
  return { query, cost_usd: r.cost_usd, results: list.slice(0, 10).map((x) => ({ title: x.title, url: x.url, snippet: clip(x.description || x.snippet, 300), text: read ? clip(typeof x.markdown === "string" ? x.markdown : x.markdown?.markdown || (Array.isArray(x.highlights) ? x.highlights.map((h) => (typeof h === "string" ? h : h?.text || "")).join(" … ") : ""), 1500) : undefined })) };
}

export async function readPage(env, ctx, { url }) {
  if (!publicUrl(url)) throw err(400, "Give a public http(s) link");
  const r = await run(env, ctx, { provider: "context.dev", endpoint: "/web/scrape/markdown", input: { queryParams: { url, useMainContentOnly: true } } }, { purpose: `Read page: ${clip(url, 80)}` });
  return { url, title: r.output?.metadata?.title || null, text: clip(r.output?.markdown, 15000), cost_usd: r.cost_usd };
}

export async function readDocument(env, ctx, { url, ocr = false }) {
  if (!publicUrl(url, { httpsOnly: true })) throw err(400, "Give a public https:// link to the file (PDF, Word, Excel, PowerPoint, image)");
  const r = await run(env, ctx, { provider: "context.dev", endpoint: "/parse", input: { body: { file_url: url, ...(ocr && { ocr: true }) } } }, { purpose: `Read document: ${clip(url, 80)}` });
  const link = r.output?.document?.download_link;
  if (!link) throw err(502, "The document couldn't be read");
  const res = await safeFetch(link, {}, { httpsOnly: true });
  if (!res.ok) throw err(502, "The parsed document couldn't be downloaded");
  const md = await res.text();
  return { url, type: r.output?.type || null, text: clip(md, 60000), length: md.length, cost_usd: r.cost_usd };
}
