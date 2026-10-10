// Research dossier: everything public about a target, read by the AI into a seller-readiness score.
//   Google Business Profile (DataForSEO)  category, rating, review count, claimed, hours, services     ~$0.005
//   Latest Google reviews (DataForSEO)     what customers say, how (and who) answers them               ~$0.003
//   Website                                about/team/history pages, read directly (free); falls back to
//                                          context.dev's renderer when the site blocks us                ~$0.003
//   News (context.dev)                     coverage by domain                                           ~$0.001
//   Web search (context.dev)               "<company> <city> owner": LinkedIn, BBB, Yelp owner replies    ~$0.005
// The AI turns it into: readiness 0-100, size estimate, ownership, owner and succession signals, red flags,
// strengths and conversation hooks. Saved as a dossier document, a timeline note and the target's intel row.
import { getTarget } from "./pipeline.js";
import { run } from "./monid.js";
import { fetchPage } from "./enrich.js";
import { chatJson } from "./ai.js";
import { webSearch } from "./webtools.js";

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });
const STATES = { AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia" };
export const STATE_NAMES = STATES;
export const RESEARCH_PRICE = "about $0.01–0.02 a company";

// DataForSEO wants its own location names: "Boise,Idaho,United States" for the US; elsewhere the country is
// enough when the suburb or city goes in the keyword ("Tooth Heaven Kensington" + "Australia").
const COUNTRY_NAMES = { australia: "Australia", au: "Australia", "united kingdom": "United Kingdom", uk: "United Kingdom", england: "United Kingdom", scotland: "United Kingdom", wales: "United Kingdom", canada: "Canada", "new zealand": "New Zealand", nz: "New Zealand", ireland: "Ireland", germany: "Germany", netherlands: "Netherlands", usa: "United States", "united states": "United States" };
const AU_STATES = /\b(VIC|NSW|QLD|WA|SA|TAS|ACT|NT)\b/;
const CA_PROV = /\b(ON|QC|BC|AB|MB|SK|NS|NB|NL|PE)\b/;
export function googlePlace(loc) {
  const raw = String(loc || "").trim();
  const us = raw.match(/^\s*([^,]+),\s*([A-Z]{2})\b/);
  if (us && STATES[us[2]]) return { location_name: `${us[1].trim()},${STATES[us[2]]},United States`, city: "" };
  const parts = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || "").toLowerCase();
  const country = COUNTRY_NAMES[last] || (AU_STATES.test(raw) ? "Australia" : CA_PROV.test(raw) && parts.length > 1 ? "Canada" : null);
  // The suburb/city: the first part, without postcodes or state codes.
  const city = (parts[0] || "").replace(AU_STATES, "").replace(/\b\d{3,5}\b/g, "").replace(/\s+/g, " ").trim();
  return { location_name: country, city };
}
const text = (html) => String(html || "").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/\s+/g, " ").trim();
const domainOf = (site) => { try { return new URL(/^https?:/i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, ""); } catch { return ""; } };

async function websiteText(env, ctx, t, step) {
  if (!t.website) return { text: "", pages: [] };
  const base = /^https?:/i.test(t.website) ? t.website : `https://${t.website}`;
  const home = await fetchPage(base);
  const pages = [], parts = [];
  if (home) {
    pages.push(home.url || base); parts.push(text(home.html).slice(0, 5000));
    // The pages that say who owns it and how long it has been going.
    const links = [...home.html.matchAll(/href=["']([^"'#]+)["']/gi)].map((m) => { try { return new URL(m[1], home.url || base).href; } catch { return null; } })
      .filter((u) => u && domainOf(u) === domainOf(base) && /about|team|history|our-story|who-we-are|meet|staff|family|leadership|om-oss/i.test(u));
    for (const u of [...new Set(links)].slice(0, 2)) { const p = await fetchPage(u); if (p) { pages.push(u); parts.push(text(p.html).slice(0, 5000)); } }
  } else {
    const out = await step("Website (rendered)", { provider: "context.dev", endpoint: "/web/scrape/markdown", input: { queryParams: { url: base, useMainContentOnly: true } } });
    if (out?.markdown) { pages.push(base); parts.push(String(out.markdown).slice(0, 8000)); }
  }
  return { text: parts.join("\n\n---\n\n").slice(0, 12000), pages };
}

const SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["readiness_score", "readiness_reason", "summary", "ownership", "years_in_business", "employees_estimate", "revenue_estimate", "owner_signals", "succession_signals", "strengths", "red_flags", "customer_sentiment", "conversation_hooks", "owner_name_guess"],
  properties: {
    readiness_score: { type: "integer", description: "0-100: how likely the owner would talk about selling in the next 1-3 years" },
    readiness_reason: { type: "string" }, summary: { type: "string", description: "3-4 sentences for a buyer" },
    ownership: { type: "string", enum: ["founder-owned", "family-owned", "second-generation", "partnership", "franchise", "private-equity", "corporate", "unknown"] },
    years_in_business: { type: ["integer", "null"] }, employees_estimate: { type: ["integer", "null"] },
    revenue_estimate: { type: "string", description: "A range with the basis, e.g. '$2-4M (≈20 staff, residential HVAC)'; 'unknown' if no basis" },
    owner_signals: { type: "array", items: { type: "string" } }, succession_signals: { type: "array", items: { type: "string" } },
    strengths: { type: "array", items: { type: "string" } }, red_flags: { type: "array", items: { type: "string" } },
    customer_sentiment: { type: "string" }, conversation_hooks: { type: "array", items: { type: "string" }, description: "Specific, warm openers for a first call or letter (no price talk)" },
    owner_name_guess: { type: ["string", "null"], description: "Owner's name only if the sources state it (e.g. signs review replies, About page)" },
  },
};
const SYSTEM = `You are an acquisitions analyst for a buyer of small, well-run private companies (who keeps the team and the name). From the public sources given, judge the business and how ready its owner may be to sell. Be specific and cite what you saw ("About page: founded 1987 by Jim Ellis"). Never invent facts: if the sources don't say, say unknown. Readiness rises with: long-tenured founder (20+ years), owner nearing retirement, no visible next generation, owner doing everything personally (answering reviews, on every page), stalled website/marketing, reduced hours; it falls with: PE/corporate ownership, recent acquisitions, a young or second-generation team clearly taking over, rapid expansion, franchise. Calibrate: with little direct evidence about the owner (no name, age, tenure or succession facts), keep the score between 35 and 60 and say the evidence is thin; above 75 needs at least two concrete, cited signals. Hooks must reference something specific from the sources.`;

export async function researchTarget(env, ctx, targetId, ai) {
  const t = await getTarget(env, ctx, targetId);
  let spent = 0;
  const steps = [];
  const step = async (label, spec) => {
    try {
      const r = await run(env, ctx, spec, { purpose: `Research ${t.name}: ${label}`, targetId: t.id, maxWaitMs: 28000 });
      spent += r.cost_usd; steps.push({ step: label, status: r.status, cost_usd: r.cost_usd });
      return r.status === "COMPLETED" ? r.output : null;
    } catch (e) {
      if (e.status === 402) throw e;
      steps.push({ step: label, status: e.status === 404 ? "none found" : "failed", error: e.message }); return null;
    }
  };
  const place = googlePlace(t.location);
  const where = place.location_name ? { location_name: place.location_name } : {};
  const keyword = place.city ? `${t.name} ${place.city}` : place.location_name ? t.name : `${t.name} ${t.location || ""}`.trim();
  const domain = domainOf(t.website);
  const city = (t.location || "").split(",")[0].trim();
  const [info, reviews, site, news, web] = await Promise.all([
    step("Google profile", { provider: "dataforseo", endpoint: "/google-business/info", input: { body: { keyword, language_code: "en", ...where } } }),
    step("Google reviews", { provider: "dataforseo", endpoint: "/google-business/reviews", input: { body: { keyword, language_code: "en", depth: 20, sort_by: "newest", ...where } } }),
    websiteText(env, ctx, t, step),
    domain ? step("News", { provider: "context.dev", endpoint: "/news/search", input: { body: { searchBy: { type: "entity", entity: { type: "domain", domain } }, limit: 5 } } }) : null,
    webSearch(env, ctx, { query: `"${t.name}"${city ? ` ${city}` : ""} owner founder` }).then((r) => { spent += r.cost_usd; steps.push({ step: "Web search", status: "COMPLETED", cost_usd: r.cost_usd }); return r.results; }).catch((e) => { steps.push({ step: "Web search", status: "failed", error: e.message }); return []; }),
  ]);
  const g = info?.[0]?.items?.[0] || null;
  const rv = reviews?.[0] || null;
  const items = (rv?.items || []).slice(0, 20);
  const articles = (news?.data || []).slice(0, 5);
  if (!g && !items.length && !site.text) throw err(404, `Couldn't find ${t.name} on Google or its website. Check the name, location and website, then try again.`);

  const sources = [
    `COMPANY ON FILE: ${t.name}; ${t.industry || ""}; ${t.location || ""}; website ${t.website || "none"}; owner ${t.owner_name || "unknown"}${t.owner_age ? ` (${t.owner_age})` : ""}; staff ${t.employees ?? "unknown"}; revenue ${t.revenue ?? "unknown"}.`,
    g && `GOOGLE PROFILE: ${g.title}; category ${g.category}${g.additional_categories?.length ? ` (+${g.additional_categories.join(", ")})` : ""}; rating ${g.rating?.value ?? "?"} from ${g.rating?.votes_count ?? 0} reviews; claimed ${g.is_claimed}; ${g.total_photos ?? 0} photos; address ${g.address || ""}; hours ${g.work_time?.work_hours?.current_status || "?"}; description: ${String(g.description || "").slice(0, 800)}`,
    items.length && `LATEST GOOGLE REVIEWS (${rv.reviews_count ?? items.length} total):\n${items.map((x) => `- ${x.rating?.value}★ ${x.time_ago || ""}: ${String(x.review_text || "").slice(0, 300)}${x.owner_answer ? `\n  OWNER REPLY: ${String(x.owner_answer).slice(0, 250)}` : ""}`).join("\n")}`,
    site.text && `WEBSITE (${site.pages.join(", ")}):\n${site.text}`,
    web.length && `WEB SEARCH ("${t.name} owner"):\n${web.slice(0, 6).map((x) => `- ${x.title} (${x.url}): ${String(x.snippet || "").slice(0, 250)} ${String(x.text || "").replace(/\s+/g, " ").slice(0, 500)}`).join("\n")}`,
    articles.length && `NEWS:\n${articles.map((a) => `- ${a.published_at || a.date || ""} ${a.headline || a.title}: ${String(a.description || "").slice(0, 200)}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");

  const { data } = await chatJson(ai, SYSTEM, `Assess this company for acquisition.\n\n${sources}`, SCHEMA, 2500, "medium");
  const score = Math.max(0, Math.min(100, Math.round(+data.readiness_score || 0)));
  const intel = {
    ...data, readiness_score: score,
    google: g ? { rating: g.rating?.value ?? null, reviews: g.rating?.votes_count ?? null, category: g.category, claimed: g.is_claimed, url: g.check_url || null } : null,
    owner_replies: items.filter((x) => x.owner_answer).length, reviews_read: items.length, pages: [...site.pages, ...web.slice(0, 3).map((x) => x.url)], news: articles.map((a) => ({ title: a.headline || a.title, url: a.url })),
    steps,
  };
  const md = dossierMarkdown(t, intel);
  const stamp = now();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO target_intel (target_id, account_id, score, data, cost, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT (target_id) DO UPDATE SET score = ?3, data = ?4, cost = cost + ?5, updated_at = ?6`).bind(t.id, ctx.accountId, score, JSON.stringify(intel), spent, stamp),
    env.DB.prepare("INSERT INTO documents (account_id, target_id, kind, title, content, meta, created_by, created_at, updated_at) VALUES (?1, ?2, 'dossier', ?3, ?4, ?5, ?6, ?7, ?7)")
      .bind(ctx.accountId, t.id, `Dossier: ${t.name}`, md, JSON.stringify({ score, cost: spent }), ctx.user.id || null, stamp),
    env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'doc', ?5, ?6)")
      .bind(ctx.accountId, t.id, ctx.user.id || null, ctx.user.name || ctx.user.email || "Agent", `Research dossier: seller readiness ${score}/100. ${data.readiness_reason} (data cost $${spent.toFixed(3)})`, stamp),
    // Fill gaps only: never overwrite what someone typed.
    env.DB.prepare(`UPDATE targets SET owner_name = CASE WHEN owner_name = '' AND ?3 IS NOT NULL THEN ?3 ELSE owner_name END,
      phone = CASE WHEN phone = '' AND ?4 IS NOT NULL THEN ?4 ELSE phone END, updated_at = ?5 WHERE id = ?1 AND account_id = ?2`)
      .bind(t.id, ctx.accountId, data.owner_name_guess || null, g?.phone || null, stamp),
  ]);
  return { target_id: t.id, readiness: score, reason: data.readiness_reason, summary: data.summary, hooks: data.conversation_hooks, red_flags: data.red_flags, cost_usd: +spent.toFixed(4), receipt: `Researched ${t.name}: seller readiness ${score}/100 ($${spent.toFixed(3)})` };
}

export async function getIntel(env, ctx, targetId) {
  const r = await env.DB.prepare("SELECT score, data, updated_at FROM target_intel WHERE target_id = ?1 AND account_id = ?2").bind(targetId, ctx.accountId).first();
  return r ? { score: r.score, updated_at: r.updated_at, ...JSON.parse(r.data) } : null;
}

function dossierMarkdown(t, d) {
  const list = (title, xs) => (xs?.length ? `\n## ${title}\n${xs.map((x) => `- ${x}`).join("\n")}\n` : "");
  return `# ${t.name}: research dossier

**Seller readiness: ${d.readiness_score}/100.** ${d.readiness_reason}

${d.summary}

| | |
|---|---|
| Ownership | ${d.ownership} |
| Years in business | ${d.years_in_business ?? "unknown"} |
| Staff (estimate) | ${d.employees_estimate ?? "unknown"} |
| Revenue (estimate) | ${d.revenue_estimate} |
| Google | ${d.google ? `${d.google.rating ?? "?"}★ from ${d.google.reviews ?? 0} reviews · ${d.google.category || ""}${d.google.claimed === false ? " · profile not claimed" : ""}` : "not found"} |
| Owner replies to reviews | ${d.owner_replies} of the last ${d.reviews_read} |
${list("Owner signals", d.owner_signals)}${list("Succession signals", d.succession_signals)}${list("Strengths", d.strengths)}${list("Red flags", d.red_flags)}
## What customers say
${d.customer_sentiment}
${list("Conversation hooks", d.conversation_hooks)}
## Sources
${[...(d.pages || []).map((p) => `- Website: ${p}`), d.google?.url ? `- Google: ${d.google.url}` : "", ...(d.news || []).map((n) => `- News: ${n.title} ${n.url || ""}`)].filter(Boolean).join("\n") || "- (none)"}
`;
}
