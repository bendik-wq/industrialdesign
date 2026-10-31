// Add-on Gatekeeper: before you send an LOI, can the whole group carry this deal, and can you absorb it?
// Research: arbitrage-only buy-and-builds averaged 1.4x MOIC vs 2.2x with an operating thesis (Bain, 44 deals);
// financing costs roughly doubled for floating-rate platforms (Bain 2024); integration capacity is the bottleneck
// (ARS's dispatch software 5x over plan; BrightView paused M&A to rebuild; 44% of UK MSPs say integration delays hurt).
// The skill: 1.5x DSCR under the base case, structures from the library, walk-away criteria, parallel pipelines.
import { registerAgent } from "../runs.js";
import { targetDeal } from "../../public/js/deal.js";
import { gatekeeper, debtSchedule, JL_DSCR } from "./maths.js";
import { mergeFindings, FINDINGS_RULE, crewSystem, FINDINGS_SCHEMA, verifyFindings, money } from "./common.js";

registerAgent({
  id: "gatekeeper", name: "Add-on Gatekeeper", icon: "gate", needsTarget: true, stages: ["first_call", "meeting", "docs", "loi", "diligence"],
  describe: "Before you send an offer: stacks this deal on top of every business you already own and checks the whole group still covers its debt at 1.5x, that the structure is from the structure library, that you keep control, that you have the capacity to integrate it (businesses still mid-integration, overdue 100-day items, open high alerts), and how much of the value is real versus multiple arbitrage. Verdict: pursue, pause or restructure, with the maximum price that still works.",
  layers: [
    {
      id: "gather", title: "Load the portfolio, its real cash flow and the integration backlog", kind: "gather",
      async run(L) {
        const { env, ctx, target } = L;
        const { results: owned } = await env.DB.prepare(`SELECT t.id, t.name, t.ebitda, t.deal, t.stage_at, r.settled_at FROM targets t LEFT JOIN deal_rooms r ON r.target_id = t.id AND r.account_id = t.account_id
          WHERE t.account_id = ?1 AND t.stage = 'closed' AND t.id != ?2`).bind(ctx.accountId, target.id).all();
        const portfolio = [], backlog = [];
        for (const o of owned) {
          const deal = targetDeal({ ...o, deal: o.deal ? JSON.parse(o.deal) : null });
          const closed = String(o.settled_at || o.stage_at || new Date().toISOString()).slice(0, 7);
          const sched = debtSchedule(deal, closed, 120);
          const nowP = new Date().toISOString().slice(0, 7);
          const service = Object.entries(sched.byPeriod).filter(([p]) => p > nowP).slice(0, 12).reduce((t, [, v]) => t + v.total, 0);
          const { results: act } = await env.DB.prepare("SELECT ebitda FROM actuals WHERE account_id = ?1 AND target_id = ?2 AND ebitda IS NOT NULL ORDER BY period DESC LIMIT 12").bind(ctx.accountId, o.id).all();
          const ebitda = act.length >= 6 ? (act.reduce((t, a) => t + a.ebitda, 0) * 12) / act.length : deal.ebitda;
          portfolio.push({ name: o.name, ebitda: Math.round(ebitda), service: Math.round(service), source: act.length >= 6 ? `${act.length} months of actuals` : "deal model" });
          const items = await env.DB.prepare("SELECT COUNT(*) AS open, SUM(CASE WHEN due_date < ?3 THEN 1 ELSE 0 END) AS overdue FROM deal_items WHERE account_id = ?1 AND target_id = ?2 AND list = 'plan' AND status NOT IN ('done','na')")
            .bind(ctx.accountId, o.id, new Date().toISOString().slice(0, 10)).first();
          const days = Math.round((Date.now() - Date.parse(o.settled_at || o.stage_at || Date.now())) / 864e5);
          backlog.push({ name: o.name, days_since_close: days, open_plan: items?.open || 0, overdue_plan: items?.overdue || 0 });
        }
        const alerts = await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_findings f JOIN targets t ON t.id = f.target_id WHERE f.account_id = ?1 AND f.status = 'open' AND f.severity = 'high' AND t.stage = 'closed'").bind(ctx.accountId).first();
        return { summary: `${portfolio.length} business(es) owned; ${backlog.filter((b) => b.days_since_close <= 180 && b.open_plan).length} still integrating; ${alerts.n} open high alert(s)`, data: { portfolio, backlog, highAlerts: alerts.n, deal: targetDeal(target) } };
      },
    },
    {
      id: "compute", title: "Pro-forma the group, the value bridge and the capacity gate", kind: "compute",
      async run(L) {
        const g = L.state.gather;
        const synergyPct = Number.isFinite(+L.input.synergy_pct) ? +L.input.synergy_pct : 5;
        const growthPct = Number.isFinite(+L.input.growth_pct) ? +L.input.growth_pct : 3;
        const r = gatekeeper({ portfolio: g.portfolio, candidate: g.deal, backlog: g.backlog, highAlerts: g.highAlerts, synergyPct, growthPct, cur: g.deal.cur });
        return { summary: `Verdict: ${r.verdict}. Deal cover ${r.deal.min_dscr}x; group cover ${r.group.dscr}x; arbitrage ${r.value_bridge.arbitrage_share_pct}% of value`, data: r };
      },
    },
    {
      id: "reason", title: "Board-style verdict and the conditions to proceed", kind: "reason",
      async run(L) {
        const r = L.state.compute;
        const schema = { ...FINDINGS_SCHEMA, properties: { ...FINDINGS_SCHEMA.properties, conditions: { type: "array", items: { type: "string" }, description: "What must be true before sending the LOI (structure, price, capacity)" }, walk_away: { type: "string", description: "The walk-away point for this deal" } }, required: [...FINDINGS_SCHEMA.required, "conditions", "walk_away"] };
        const out = await L.ask(crewSystem("deal structure library DSCR 1.5x walk-away criteria parallel pipelines roll-up monopoly method integration board review"),
          `Candidate: ${L.target.name} (${L.target.industry || "industry not set"}), stage ${L.target.stage}.
${FINDINGS_RULE}
<numbers>\n${JSON.stringify(r)}\n</numbers>
Give the board's view: confirm or challenge the computed verdict (${r.verdict}), raise findings that the numbers support, the conditions before an LOI goes out, and the walk-away point. Use the 3C model: 1.5x DSCR, library structures, walk-away discipline, team and integration capacity before the next deal.`, schema, 3500, "medium");
        return { summary: out.headline, data: out };
      },
    },
    {
      id: "verify", title: "Keep only supported claims; turn failed checks into alerts", kind: "verify",
      async run(L) {
        const r = L.state.compute, o = L.state.reason;
        const { kept, dropped } = verifyFindings(o.findings, r);
        const sev = { deal_dscr: "high", group_dscr: "high", library: "high", control: "high", capacity: "medium", alerts: "medium", arbitrage: "medium" };
        const hard = r.checks.filter((c) => !c.pass).map((c) => ({ key: `gate_${c.id}`, severity: sev[c.id], title: `Failed: ${c.label}`, detail: `Value: ${c.value}.`, evidence: "Gatekeeper check", action: c.id === "deal_dscr" || c.id === "group_dscr" ? `Bring the price to ${money(r.deal.max_price_at_1_5x)} or lengthen the terms / add a payment holiday.` : c.id === "capacity" ? "Finish integrating what you own before signing another." : c.id === "arbitrage" ? "Write down the operating plan (synergies, pricing, growth) that earns the value." : "Fix this before the LOI." }));
        return { summary: `${hard.length} failed check(s); ${kept.length} model finding(s) kept${dropped.length ? `, ${dropped.length} dropped` : ""}`, data: { findings: mergeFindings(hard, kept), dropped } };
      },
    },
    {
      id: "act", title: "Write the verdict and queue the next move", kind: "act",
      async run(L) {
        const r = L.state.compute, o = L.state.reason, v = L.state.verify, t = L.target, g = L.state.gather;
        const md = [
          `# Gatekeeper: ${t.name} → **${r.verdict.toUpperCase()}**`, "", `**${o.headline}**`, "",
          "## Checks", ...r.checks.map((c) => `- ${c.pass ? "✅" : "❌"} ${c.label} (${c.value ?? "n/a"})`), "",
          "## This deal", `Price ${money(r.deal.price)} at ${r.deal.multiple}x on ${money(r.deal.ebitda)} EBITDA. Weakest-year cover ${r.deal.min_dscr}x. Highest price that still covers at ${JL_DSCR}x: ${money(r.deal.max_price_at_1_5x)}.`, "",
          "## The group after this deal", "| | Before | After |", "|---|---|---|",
          `| Businesses | ${r.group.businesses - 1} | ${r.group.businesses} |`, `| Debt cover | ${r.group.dscr_before ?? "–"}x | ${r.group.dscr}x |`,
          `| EBITDA / debt service | | ${money(r.group.ebitda)} / ${money(r.group.service)} |`, `| Room for more debt at 1.5x | | ${money(r.group.service_headroom)} a year |`, "",
          ...(g.portfolio.length ? ["Portfolio cash flow used:", ...g.portfolio.map((p) => `- ${p.name}: ${money(p.ebitda)} EBITDA (${p.source}), ${money(p.service)} service next 12 months`), ""] : []),
          "## Where the value comes from (5 years)", `Arbitrage (${r.value_bridge.buy_multiple}x in, ${r.value_bridge.platform_multiple}x group): ${money(r.value_bridge.arbitrage)} · synergy (${r.value_bridge.synergy_pct}%): ${money(r.value_bridge.synergy)} · organic (${r.value_bridge.growth_pct}%/yr): ${money(r.value_bridge.organic)}. Arbitrage share: ${r.value_bridge.arbitrage_share_pct}%.`, "",
          "## Integration capacity", r.integration.integrating.length ? `Still integrating: ${r.integration.integrating.join(", ")}. Overdue 100-day items: ${r.integration.overdue_items}.` : "Nothing mid-integration.", "",
          "## Before the LOI", ...o.conditions.map((c) => `- ${c}`), "", `**Walk away if:** ${o.walk_away}`, "",
          "## Findings", ...v.findings.map((f) => `- **${f.title}** (${f.severity}). ${f.detail} *Do:* ${f.action}`),
        ];
        const proposals = r.verdict === "pursue"
          ? [{ tool: "draft_document", input: { kind: "loi", target_id: t.id }, title: `Draft the LOI for ${t.name}`, reason: `The Gatekeeper passed every check: deal cover ${r.deal.min_dscr}x, group cover ${r.group.dscr}x.`, dedupe: `loi:${t.id}` }]
          : [{ tool: "update_target", input: { target_id: t.id, next_action: r.verdict === "restructure" ? `Restructure before any offer: max price ${money(r.deal.max_price_at_1_5x)} at 1.5x` : `Hold the LOI: ${v.findings[0]?.title || "clear the capacity gate"}`, next_date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) }, title: `${r.verdict === "restructure" ? "Restructure" : "Pause"} ${t.name} before an offer`, reason: o.headline, dedupe: `gate:${t.id}:${r.verdict}` }];
        return { summary: `Verdict ${r.verdict}; memo written`, headline: `${r.verdict.toUpperCase()}: ${o.headline}`, findings: v.findings.map((f) => ({ ...f, dedupe: f.key })), document: { kind: "gatekeeper", title: `Gatekeeper: ${t.name} (${r.verdict})`, content: md.join("\n") }, proposals };
      },
    },
  ],
});
