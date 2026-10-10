// Deep enrich: the Monid waterfall that turns a company into the owner's verified email, LinkedIn and (optionally)
// mobile number. Each step runs only if the earlier ones didn't already answer it, so a target costs a few cents:
//   1. No website?  Google Maps (litescrape) finds the website and main phone.          ~$0.0002
//   2. Hunter domain search: every published address on the domain, names and titles.  ~$0.025 per 10
//   3. Owner unknown? Apollo people search (free) for the owner/founder, then Apollo match reveals the verified
//      email, full name and LinkedIn.                                                     ~$0.026
//      Owner known but no address? Hunter email finder from the owner's name + domain.     ~$0.025, only if found
//   4. Hunter verifier on the owner's address (valid / accept-all / invalid).           ~$0.012
//   5. LinkedIn profile by name + company (Apify).                                       ~$0.01
//   6. Mobile (Clay phone cascade), only when asked: it's ~$0.57 and needs the LinkedIn. not billed on a miss
// Findings land in contacts (with source and confidence) and a timeline note lists what was spent.
import { getTarget } from "./pipeline.js";
import { run } from "./monid.js";

const now = () => new Date().toISOString();
const err = (status, message) => Object.assign(new Error(message), { status });
const OWNER_TITLE = /\b(owner|co-?owner|founder|co-?founder|proprietor|ceo|chief executive|president|eier|daglig leder|g[ée]rant|inhaber|geschäftsführender gesellschafter)\b/i;
const LEADER_TITLE = /\b(general manager|managing director|managing partner|executive director|operations director|director of operations|geschäftsführer|directeur g[ée]n[ée]ral|administrerende direkt[øo]r)\b/i;
export const DEEP_ENRICH_PRICE = "about $0.05–0.08 a company (+$0.57 if you ask for a mobile and one is found)";

const domainOf = (site) => { try { return new URL(/^https?:/i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const splitName = (full) => {
  const parts = String(full || "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] || "", last: parts.length > 1 ? parts[parts.length - 1] : "" };
};
const sameName = (a, b) => {
  const x = splitName(a), y = splitName(b), n = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return !!x.first && !!y.first && n(x.first) === n(y.first) && (!x.last || !y.last || n(x.last) === n(y.last));
};
const dataOf = (o) => o?.data ?? o ?? {};

export async function deepEnrich(env, ctx, targetId, { mobile = false, linkedin = true } = {}) {
  const t = await getTarget(env, ctx, targetId);
  const found = [], steps = [];
  let spent = 0, website = t.website, ownerEmail = null, ownerLinkedIn = null, ownerName = t.owner_name || "";
  const step = async (label, spec) => {
    try {
      const r = await run(env, ctx, spec, { purpose: `Deep enrich ${t.name}: ${label}`, targetId: t.id, maxWaitMs: 25000 });
      spent += r.cost_usd;
      steps.push({ step: label, status: r.status, cost_usd: r.cost_usd });
      return r.status === "COMPLETED" ? r.output : null;
    } catch (e) {
      if (e.status === 402) throw e; // out of budget or wallet: stop the whole waterfall
      steps.push({ step: label, status: "failed", error: e.message });
      return null;
    }
  };
  const add = (c) => { if (c.value && !found.some((f) => f.kind === c.kind && f.value === c.value)) found.push(c); };

  // 1. Website and phone from Google Maps.
  if (!website) {
    const out = await step("Google Maps lookup", { provider: "litescrape", endpoint: "/google/maps", input: { queryParams: { q: `${t.name} ${t.location || ""}`.trim(), type: "search", ...(t.location && { location: t.location, z: 12 }) } } });
    const hit = (out?.local_results || []).find((x) => x.title && x.title.toLowerCase().includes(t.name.toLowerCase().split(/\s+/)[0])) || out?.place_results;
    if (hit?.website) website = hit.website;
    if (hit?.phone) add({ kind: "phone", value: hit.phone, label: "Main line (Google Maps)", source: "Monid · Google Maps", confidence: "high" });
  }
  const domain = domainOf(website);
  if (!domain) throw err(400, `No website for ${t.name}, so there's no domain to search. Add the website (or try Scout's Google Maps source) and run it again.`);

  // 2. Everyone published on the domain.
  const ds = dataOf(await step("Hunter domain search", { provider: "hunterio", endpoint: "/domain-search", input: { body: { domain, limit: 10 } } }));
  let leader = null; // a general manager / MD: the best contact when no owner turns up
  for (const e of ds.emails || []) {
    const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
    const value = String(e.value).toLowerCase();
    const isOwner = ownerName ? !!name && sameName(name, ownerName) : OWNER_TITLE.test(e.position || "");
    const isLeader = !isOwner && LEADER_TITLE.test(e.position || "");
    if (isOwner && !ownerName && name) ownerName = name;
    add({ kind: "email", value, label: `${name || (e.type === "generic" ? "General inbox" : "Person")}${e.position ? `, ${e.position}` : ""}${isOwner ? " (owner)" : isLeader ? " (decision maker)" : ""}`, source: "Monid · Hunter", confidence: (e.confidence || 0) >= 80 ? "high" : "medium", owner: isOwner });
    if (e.phone_number) add({ kind: "phone", value: e.phone_number, label: `${name || "Office"} (Hunter)`, source: "Monid · Hunter", confidence: "medium" });
    if (isOwner) { ownerEmail ||= value; if (e.linkedin) ownerLinkedIn ||= /^https?:/.test(e.linkedin) ? e.linkedin : `https://www.linkedin.com/in/${e.linkedin}`; }
    if (isLeader && !leader) leader = { email: value, name };
  }

  // 3a. Who owns it? Apollo's people search is free; the match that reveals the email is the paid step.
  if (!ownerEmail && !ownerName) {
    const words = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9æøåäöüéè ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !/^(inc|llc|ltd|the|and|company|services|service|group)$/.test(w));
    const mine = words(t.name);
    let person = null;
    // Apollo's keyword search wants a short name: "Right Now Heating", not the full legal name.
    const short = t.name.replace(/\(.*?\)|,.*$/g, "").split(/\s+/).filter((w) => !/^(&|and|og|et|und|inc\.?|llc|ltd\.?|as|ab)$/i.test(w)).slice(0, 3).join(" ");
    for (const queryParams of [{ "q_organization_domains_list[]": [domain] }, { q_keywords: short }]) {
      const out = await step("Apollo owner search", { provider: "apollo", endpoint: "/mixed_people/api_search", input: { queryParams: { ...queryParams, "person_seniorities[]": ["owner", "founder", "c_suite"], per_page: 5 } } });
      person = (out?.people || []).find((p) => { const org = words(p.organization?.name); return queryParams.q_organization_domains_list || mine.filter((w) => org.includes(w)).length >= Math.min(2, mine.length); });
      if (person) break;
    }
    if (person?.id) {
      const m = await step("Apollo match", { provider: "apollo", endpoint: "/people/match", input: { queryParams: { id: person.id } } });
      const pp = m?.person || m;
      // Similar names are common (franchises, "Smith Plumbing" in every town): keep the match only if the
      // person's employer is on our domain.
      const theirs = [pp?.organization?.primary_domain, domainOf(pp?.organization?.website_url || ""), String(pp?.email || "").split("@")[1]].filter(Boolean).map((x) => x.toLowerCase().replace(/^www\./, ""));
      const same = theirs.includes(domain);
      if (!same) steps.push({ step: "Apollo match", status: "discarded", error: `Matched someone at ${theirs[0] || "another company"}, not ${domain}` });
      const name = same ? [pp?.first_name, pp?.last_name].filter(Boolean).join(" ") : "";
      if (name) ownerName = name;
      if (same && pp?.linkedin_url) ownerLinkedIn = pp.linkedin_url;
      if (same && pp?.email && !/^email_not_unlocked/.test(pp.email)) {
        ownerEmail = String(pp.email).toLowerCase();
        add({ kind: "email", value: ownerEmail, label: `${name || "Owner"}${pp.title ? `, ${pp.title}` : ""} (owner)`, source: "Monid · Apollo", confidence: pp.email_status === "verified" ? "high" : "medium", owner: true });
      }
    }
  }

  // 3b. Owner's address from their name.
  if (!ownerEmail && ownerName) {
    const ef = dataOf(await step("Hunter email finder", { provider: "hunterio", endpoint: "/email-finder", input: { queryParams: { domain, full_name: splitName(ownerName).first + (splitName(ownerName).last ? ` ${splitName(ownerName).last}` : "") } } }));
    if (ef.email) {
      ownerEmail = String(ef.email).toLowerCase();
      add({ kind: "email", value: ownerEmail, label: `${ownerName}${ef.position ? `, ${ef.position}` : ""} (owner)`, source: "Monid · Hunter finder", confidence: (ef.score || 0) >= 80 ? "high" : "medium", owner: true });
      if (ef.linkedin_url || ef.linkedin) ownerLinkedIn ||= ef.linkedin_url || `https://www.linkedin.com/in/${ef.linkedin}`;
      if (ef.phone_number) add({ kind: "phone", value: ef.phone_number, label: `${ownerName} (Hunter)`, source: "Monid · Hunter finder", confidence: "medium" });
    }
  }

  // No owner anywhere: the general manager / MD is the best person to write to.
  let decisionMaker = false;
  if (!ownerEmail && leader) { ownerEmail = leader.email; decisionMaker = true; }

  // 4. Will it bounce?
  let verdict = null;
  if (ownerEmail) {
    const v = dataOf(await step("Hunter verifier", { provider: "hunterio", endpoint: "/email-verifier", input: { queryParams: { email: ownerEmail } } }));
    verdict = v.status || v.result || null;
    const c = found.find((f) => f.value === ownerEmail);
    if (c && verdict === "valid") c.confidence = "high";
    if (c && verdict === "invalid") { c.confidence = "guess"; c.label += " — bounces"; ownerEmail = null; }
    if (c && verdict === "accept_all") c.label += " — server accepts all";
  }

  // 5. LinkedIn.
  if (linkedin && !ownerLinkedIn && ownerName) {
    const { first, last } = splitName(ownerName);
    const out = await step("LinkedIn profile", { provider: "apify", endpoint: "/harvestapi/linkedin-profile-search-by-name", input: { body: { profileScraperMode: "Short", firstName: first, lastName: last, currentCompanies: [t.name], maxItems: 1 } } });
    const items = Array.isArray(out) ? out : out?.items || out?.results || out?.data || [];
    const p = items[0];
    const url = p?.linkedinUrl || p?.profileUrl || p?.url || (p?.publicIdentifier && `https://www.linkedin.com/in/${p.publicIdentifier}`);
    if (url) ownerLinkedIn = url;
  }
  if (ownerLinkedIn) add({ kind: "linkedin", value: ownerLinkedIn, label: `${ownerName || "Owner"} (owner)`, source: "Monid · LinkedIn", confidence: "medium" });

  // 6. Mobile, only on request.
  if (mobile) {
    if (!ownerLinkedIn || !ownerName) steps.push({ step: "Mobile number", status: "skipped", error: "Needs the owner's name and LinkedIn first" });
    else {
      const out = await step("Mobile number (Clay)", { provider: "clay", endpoint: "/enrichment/mobile-phone", input: { body: { "Social Profile URL": ownerLinkedIn, "Full Name": ownerName, "Company Name": t.name, ...(domain && { "Company Domain": domain }) } } });
      const m = out?.["Mobile Phone"] || out?.mobile_phone;
      if (m) add({ kind: "phone", value: m, label: `${ownerName} mobile (owner)`, source: "Monid · Clay", confidence: "high", owner: true });
    }
  }

  // Save.
  const stamp = now();
  const stmts = found.map((c) => env.DB.prepare(`INSERT INTO contacts (account_id, target_id, kind, value, label, source, confidence, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (target_id, kind, value) DO UPDATE SET label = ?5, source = ?6, confidence = ?7`).bind(ctx.accountId, t.id, c.kind, c.value, c.label.slice(0, 200), c.source, c.confidence, stamp));
  const bestPhone = found.find((c) => c.kind === "phone" && c.owner)?.value || found.find((c) => c.kind === "phone")?.value || null;
  stmts.push(env.DB.prepare(`UPDATE targets SET email = CASE WHEN ?3 IS NOT NULL THEN ?3 ELSE email END, phone = CASE WHEN phone = '' AND ?4 IS NOT NULL THEN ?4 ELSE phone END,
    website = CASE WHEN website = '' THEN ?5 ELSE website END, owner_name = CASE WHEN owner_name = '' THEN ?6 ELSE owner_name END, updated_at = ?7 WHERE id = ?1 AND account_id = ?2`)
    .bind(t.id, ctx.accountId, ownerEmail, bestPhone, website || "", ownerName || "", stamp));
  const emails = found.filter((c) => c.kind === "email").length;
  const summary = `Deep enrich (${domain}): ${ownerEmail ? `${decisionMaker ? `no owner found; decision maker ${leader.name || ""} at` : "owner email"} ${ownerEmail}${verdict ? ` (${verdict.replace("_", "-")})` : ""}` : "no owner email found"}, ${emails} address${emails === 1 ? "" : "es"} on the domain, ${found.filter((c) => c.kind === "phone").length} phone${found.filter((c) => c.kind === "phone").length === 1 ? "" : "s"}${ownerLinkedIn ? ", LinkedIn" : ""}. Data cost $${spent.toFixed(3)}.`;
  stmts.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'note', ?5, ?6)").bind(ctx.accountId, t.id, ctx.user.id || null, ctx.user.name || ctx.user.email || "Agent", summary, stamp));
  await env.DB.batch(stmts);
  return { target_id: t.id, domain, owner: ownerName || null, owner_email: decisionMaker ? null : ownerEmail, decision_maker_email: decisionMaker ? ownerEmail : null, verification: verdict, linkedin: ownerLinkedIn, found: found.map(({ owner, linkedin: _l, ...c }) => c), steps, cost_usd: +spent.toFixed(4), receipt: summary };
}
