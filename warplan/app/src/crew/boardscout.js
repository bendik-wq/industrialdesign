// Board Scout: finds credible people in your area for the four board seats the 3C skill calls for, from LinkedIn.
// The skill (C1 Capabilities): "Assemble a board/advisory team with Chair (former executive or industry titan), Finance
// Lead (CFO/credit veteran who understands deal structures), Legal Lead (M&A attorney or former general counsel),
// Sector Operator (industry expert with operational experience)… Target recently retired executives looking for
// meaningful involvement. Use LinkedIn, direct outreach, and industry networks." Credibility is scored in code from
// each person's real work history; the model only explains it and fills in the skill's own recruitment script.
import { registerAgent } from "../runs.js";
import { run as monidRun } from "../monid.js";
import { getSetting, setSetting } from "../autopilot.js";
import { getProfile } from "../documents.js";
import { BOARD_ROLES, C1_SCRIPTS } from "../../public/js/jl.js";
import { scoreCandidate } from "./maths.js";
import { crewSystem, supported } from "./common.js";
import { now } from "../http.js";

// LinkedIn people search through Monid (anyapi /linkedin.search_profiles: full work histories, ~$0.09 + $0.0044 a profile).
const term = (s) => String(s || "business").split(/[,/|]+/)[0].trim() || "business";
// Each seat tries its queries in order until it has enough people.
const SEARCH = {
  chair: (s) => [{ query: "CEO managing director board", pastJobTitles: ["Chief Executive Officer", "Managing Director"] }],
  finance: (s) => [{ query: "CFO finance director", pastJobTitles: ["Chief Financial Officer", "Finance Director"] }],
  legal: (s) => [{ query: "general counsel", pastJobTitles: ["General Counsel"] }, { query: "M&A corporate lawyer partner", pastJobTitles: ["Partner"] }],
  sector: (s) => [{ query: term(s), pastJobTitles: ["Owner", "Founder", "Clinic Director", "Regional Director", "General Manager", "Chief Operating Officer"] }, { query: `${term(s)} executive` }],
};
const PER_SEAT = 15, SHORTLIST = 3;
const slim = (p) => ({
  firstName: p.firstName, lastName: p.lastName, headline: p.headline, city: p.city, state: p.state, country: p.country, location: p.location, url: p.url,
  connectionsCount: p.connectionsCount, openToWork: p.openToWork,
  experience: (p.experience || []).slice(0, 14).map((j) => ({ position: j.position, companyName: j.companyName, startDate: j.startDate, endDate: j.endDate, description: String(j.description || "").slice(0, 200) })),
});

async function defaults(env, ctx) {
  const saved = await getSetting(env, ctx.accountId, "boardscout", {});
  const top = async (col) => (await env.DB.prepare(`SELECT ${col} AS v, COUNT(*) AS n FROM targets WHERE account_id = ?1 AND ${col} IS NOT NULL AND ${col} != '' AND stage != 'lost' GROUP BY ${col} ORDER BY n DESC LIMIT 1`).bind(ctx.accountId).first())?.v || "";
  return { area: saved.area || (await top("location")), sector: saved.sector || (await top("industry")) };
}
export { defaults as boardScoutDefaults };

registerAgent({
  id: "boardscout", name: "Board Scout", icon: "users", needsTarget: false, ownerOnly: true,
  describe: "Finds credible people in your area for the four board seats the 3C model calls for (Chair, Finance Lead, Legal Lead, Sector Operator): searches LinkedIn, scores every person's real work history against each seat (years in the role, board seats, career length, your sector, whether they're now advisory or recently retired, local), explains the strongest three per seat, and writes the skill's recruitment message with their names filled in. Suggestions wait on Board & lenders for you to add or dismiss. About $0.60 of Monid data per run.",
  layers: [
    {
      id: "plan", title: "Work out the open seats, your area and your sector", kind: "gather",
      async run(L) {
        const { env, ctx, input } = L;
        const d = await defaults(env, ctx);
        const area = String(input.area || d.area || "").trim().slice(0, 80), sector = String(input.sector || d.sector || "").trim().slice(0, 80);
        if (!area) return { stop: "Tell Board Scout which city or region to search (Board & lenders → Find board candidates).", summary: "No area set", data: {} };
        if (input.area || input.sector) await setSetting(env, ctx.accountId, "boardscout", { area, sector });
        const { results: filled } = await env.DB.prepare("SELECT role, name FROM relationships WHERE account_id = ?1 AND kind = 'board' AND status IN ('agreed','signed')").bind(ctx.accountId).all();
        const known = (await env.DB.prepare("SELECT linkedin FROM relationships WHERE account_id = ?1 AND linkedin != ''").bind(ctx.accountId).all()).results.map((r) => r.linkedin);
        const wanted = Array.isArray(input.seats) && input.seats.length ? input.seats.filter((s) => SEARCH[s]) : BOARD_ROLES.map((r) => r.id);
        const seats = wanted.filter((s) => !filled.some((f) => f.role === s));
        if (!seats.length) return { stop: "Every board seat is filled (agreed or signed). Nothing to search for.", summary: "Board is full", data: {} };
        return { summary: `Searching ${seats.length} seat(s) in ${area}${sector ? ` · sector: ${sector}` : ""}`, data: { area, sector, seats, filled: filled.map((f) => f.role), known } };
      },
    },
    {
      id: "search", title: "Search LinkedIn for each seat", kind: "gather",
      async run(L) {
        const p = L.state.plan, found = {}, spent = [];
        let failures = 0;
        for (const seat of p.seats) {
          found[seat] = [];
          for (const q of SEARCH[seat](p.sector)) {
            if (found[seat].length >= 6) break;
            try {
              const r = await monidRun(L.env, L.ctx, { provider: "anyapi", endpoint: "/linkedin.search_profiles", input: { body: { ...q, location: p.area, yearsOfExperienceIds: ["5"], limit: PER_SEAT } } }, { purpose: `Board Scout: ${seat} in ${p.area}`, maxWaitMs: 60000 });
              const items = r.output?.data?.items || r.output?.items || [];
              const have = new Set(found[seat].map((x) => x.url));
              found[seat].push(...items.map(slim).filter((x) => !have.has(x.url)));
              spent.push(r.cost_usd || 0);
            } catch (e) { failures++; if (/budget|balance|402/i.test(e.message)) throw e; }
          }
        }
        const total = Object.values(found).reduce((t, l) => t + l.length, 0);
        if (!total) return { stop: `LinkedIn returned no one${failures ? " (the search failed; try again shortly)" : ""}. Try a wider area.`, summary: "No profiles found", data: { found } };
        return { summary: `${total} profile(s) across ${p.seats.length} seat(s) · data cost $${spent.reduce((a, b) => a + b, 0).toFixed(2)}`, data: { found, cost: spent.reduce((a, b) => a + b, 0) } };
      },
    },
    {
      id: "score", title: "Score every person's track record against the seat", kind: "compute",
      async run(L) {
        const p = L.state.plan, found = L.state.search.found;
        const known = new Set(p.known.map((u) => u.replace(/\/+$/, "").toLowerCase()));
        const seen = new Set(), shortlist = {};
        for (const seat of p.seats) {
          shortlist[seat] = (found[seat] || []).map((x) => scoreCandidate(x, seat, { area: p.area, sector: p.sector }))
            .filter((c) => c.url && c.name && !known.has(c.url.replace(/\/+$/, "").toLowerCase()) && c.score >= 35)
            .sort((a, b) => b.score - a.score)
            .filter((c) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
            .slice(0, SHORTLIST);
        }
        const n = Object.values(shortlist).flat().length;
        return { summary: `${n} credible candidate(s): ${p.seats.map((s) => `${s} ${shortlist[s].length}`).join(", ")}`, data: { shortlist } };
      },
    },
    {
      id: "reason", title: "Explain each one's credibility and write the recruitment message", kind: "reason",
      async run(L) {
        const p = L.state.plan, list = Object.values(L.state.score.shortlist).flat();
        if (!list.length) return { stop: "No one cleared the credibility bar (score 35+). Try a wider area or a different sector keyword.", summary: "Nobody credible enough", data: { notes: [] } };
        const profile = await getProfile(L.env, L.ctx);
        const schema = { type: "object", properties: { notes: { type: "array", items: { type: "object", properties: {
          url: { type: "string" }, credibility: { type: "string", description: "Two sentences: why this person would credibilise you with sellers and lenders, citing only roles in their record" },
          watch_out: { type: "string", description: "One honest concern (availability, fit, conflict), or empty" },
          pitch: { type: "string", description: "The skill's board recruitment script, word for word, with the brackets filled in" },
        }, required: ["url", "credibility", "watch_out", "pitch"], additionalProperties: false } } }, required: ["notes"], additionalProperties: false };
        const seatLabel = Object.fromEntries(BOARD_ROLES.map((r) => [r.id, `${r.label} (${r.text})`]));
        // The skill's script filled in by code, so every candidate gets a message even if the model is unavailable.
        const company = profile.company || "[Company Name]", industry = p.sector ? term(p.sector) : "[industry]";
        const scripted = Object.fromEntries(list.map((c) => [c.url, C1_SCRIPTS.board.text.replace("[Name]", c.name.split(" ")[0]).replace("[Company Name]", company).split("[industry]").join(industry)
          .replace("[Board Chair/Finance Lead/etc.]", BOARD_ROLES.find((r) => r.id === c.seat)?.label || "a board member").replace("[0.5-2.0]%", c.seat === "chair" ? "2%" : "1%")]));
        let out;
        try { out = await L.ask(crewSystem("board recruitment founders equity board advisory roster chair finance lead legal lead sector operator retired executives LinkedIn"),
          `The buyer: ${profile.name || L.ctx.user.name || "[Your name]"}${profile.company ? `, building ${profile.company}` : ""}. Area: ${p.area}. Industry to consolidate: ${p.sector ? term(p.sector) : "[industry]"}.
The skill's board recruitment script (fill the brackets; keep the wording; use 0.5-2.0% unless the seat clearly warrants the top of the range):
"""${C1_SCRIPTS.board.text}"""
Candidates (their real work history; cite nothing that isn't here):
<facts>\n${JSON.stringify(list.map((c) => ({ url: c.url, seat: seatLabel[c.seat], name: c.name, headline: c.headline, location: c.location, current: c.current, roles: c.roles, scored_reasons: c.why })))}\n</facts>
For every candidate: why they'd credibilise the buyer for that seat, one honest watch-out, and the filled-in script.`, schema, 6000, "medium"); }
        catch (e) { return { summary: `Model unavailable (${e.message}); using the scored reasons and the script filled in by code`, data: { notes: [], scripted, error: e.message } }; }
        return { summary: `${out.notes.length} profile note(s) written`, data: { ...out, scripted } };
      },
    },
    {
      id: "verify", title: "Check every note against the person's real record", kind: "verify",
      async run(L) {
        const list = Object.values(L.state.score.shortlist).flat();
        const byUrl = new Map(list.map((c) => [c.url, c]));
        const kept = [], dropped = [];
        for (const n of L.state.reason.notes || []) {
          const c = byUrl.get(n.url);
          if (!c) { dropped.push({ url: n.url, why: "not in the shortlist" }); continue; }
          const facts = [c.career_years, c.seat_years, c.board_roles, c.score, c.connections].filter(Number.isFinite);
          const check = supported(`${n.credibility} ${n.watch_out}`, facts);
          const first = c.name.split(" ")[0];
          if (!check.ok) { dropped.push({ url: n.url, why: `unsupported numbers: ${check.bad.join(", ")}` }); continue; }
          if (!n.pitch.includes(first)) { dropped.push({ url: n.url, why: "pitch doesn't address them by name" }); continue; }
          kept.push(n);
        }
        return { summary: `${kept.length} note(s) kept${dropped.length ? `, ${dropped.length} dropped` : ""}`, data: { kept, dropped } };
      },
    },
    {
      id: "act", title: "Add them to your suggested candidates", kind: "act",
      async run(L) {
        const p = L.state.plan, notes = new Map(L.state.verify.kept.map((n) => [n.url, n])), stamp = now();
        const list = Object.values(L.state.score.shortlist).flat();
        const stmts = list.map((c) => {
          const n = { pitch: L.state.reason?.scripted?.[c.url] || "", ...(notes.get(c.url) || {}) };
          const firm = (c.current[0] || "").split(" @ ")[1] || "";
          return L.env.DB.prepare(`INSERT INTO board_suggestions (account_id, url, seat, name, headline, location, firm, score, why, credibility, watch_out, pitch, roles, status, run_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'new', ?14, ?15, ?15)
            ON CONFLICT (account_id, url) DO UPDATE SET seat = ?3, headline = ?5, location = ?6, firm = ?7, score = ?8, why = ?9, credibility = ?10, watch_out = ?11, pitch = ?12, roles = ?13, run_id = ?14, updated_at = ?15`)
            .bind(L.ctx.accountId, c.url, c.seat, c.name, c.headline.slice(0, 200), c.location.slice(0, 120), firm.slice(0, 120), c.score, JSON.stringify(c.why), String(n.credibility || "").slice(0, 1000), String(n.watch_out || "").slice(0, 500), String(n.pitch || "").slice(0, 3000), JSON.stringify(c.roles), L.run.id, stamp);
        });
        if (stmts.length) await L.env.DB.batch(stmts);
        const label = Object.fromEntries(BOARD_ROLES.map((r) => [r.id, r.label]));
        const md = [`# Board shortlist: ${p.area}`, "", `Seats searched: ${p.seats.map((s) => label[s]).join(", ")}${p.sector ? ` · sector: ${p.sector}` : ""}. Scored from each person's LinkedIn work history against the 3C model's board seats.`, "",
          ...p.seats.flatMap((s) => [`## ${label[s]}`, ...(L.state.score.shortlist[s].length ? L.state.score.shortlist[s].map((c) => { const n = notes.get(c.url) || {}; return `### [${c.name}](${c.url}) · ${c.score}/100\n${c.headline}${c.location ? ` · ${c.location}` : ""}\n\n${n.credibility || c.why.join("; ")}${n.watch_out ? `\n\n*Watch out:* ${n.watch_out}` : ""}${n.pitch ? `\n\n> ${n.pitch.replace(/\n/g, "\n> ")}` : ""}\n`; }) : ["_No one cleared the bar for this seat._"]), ""])];
        return { summary: `${list.length} suggestion(s) saved to Board & lenders`, headline: `${list.length} board candidate(s) in ${p.area}: ${p.seats.map((s) => `${label[s]} ${L.state.score.shortlist[s].length}`).join(", ")}`, document: { kind: "board", title: `Board shortlist: ${p.area}`, content: md.join("\n") }, data: { saved: list.length } };
      },
    },
  ],
});

// ── suggestions API ─────────────────────────────────────────────────────────
export async function listSuggestions(env, ctx, status = "new") {
  const { results } = await env.DB.prepare("SELECT * FROM board_suggestions WHERE account_id = ?1 AND status = ?2 ORDER BY CASE seat WHEN 'chair' THEN 0 WHEN 'finance' THEN 1 WHEN 'legal' THEN 2 ELSE 3 END, score DESC LIMIT 60").bind(ctx.accountId, status).all();
  return results.map((r) => ({ ...r, why: JSON.parse(r.why || "[]"), roles: JSON.parse(r.roles || "[]") }));
}

export async function decideSuggestion(env, ctx, id, action) {
  const s = await env.DB.prepare("SELECT * FROM board_suggestions WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!s) throw Object.assign(new Error("Suggestion not found"), { status: 404 });
  if (action === "dismiss") { await env.DB.prepare("UPDATE board_suggestions SET status = 'dismissed', updated_at = ?2 WHERE id = ?1").bind(s.id, now()).run(); return { ok: true }; }
  if (s.status === "added") return { ok: true, relationship_id: s.relationship_id };
  const { createRelationship } = await import("../capabilities.js");
  const why = JSON.parse(s.why || "[]");
  const rel = await createRelationship(env, ctx, { kind: "board", role: s.seat, name: s.name, firm: s.firm, linkedin: s.url, status: "prospect",
    notes: [s.headline, s.credibility, why.length ? `Scored ${s.score}/100: ${why.join("; ")}` : "", s.watch_out ? `Watch out: ${s.watch_out}` : "", s.pitch ? `Message:\n${s.pitch}` : ""].filter(Boolean).join("\n\n") });
  await env.DB.prepare("UPDATE board_suggestions SET status = 'added', relationship_id = ?2, updated_at = ?3 WHERE id = ?1").bind(s.id, rel.id, now()).run();
  return { ok: true, relationship_id: rel.id };
}
