// Earnings X-Ray: a pre-LOI quality-of-earnings pass on the seller's own files.
// Research: QoE gaps are a leading reason LOIs die (FOCUS: 17% of 2023 dead deals; Axial's dead-deal sample: about a
// fifth); add-backs ran at 26-32% of management EBITDA (S&P via secondary); Slater & Gordon wrote off ~A$814-876M on
// earnings that weren't. The skill's red flags: financials ≠ tax returns (walk away), concentration (1-2 entities >30%;
// >50% walk or heavily discount), underfunded working capital, slipping margin.
import { registerAgent } from "../runs.js";
import { xray } from "./maths.js";
import { mergeFindings, FINDINGS_RULE, crewSystem, targetSheets, extract, FINDINGS_SCHEMA, verifyFindings, money } from "./common.js";

const n = { type: ["number", "null"] };
const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    gst_registered: { type: ["boolean", "null"], description: "true if the files show GST/VAT/sales tax collected on sales" },
    pnl: { type: "array", description: "Profit and loss, one row per month (YYYY-MM) if monthly figures exist, otherwise per financial year (YYYY = year it ends)", items: { type: "object", properties: { period: { type: "string" }, revenue: n, ebitda: { ...n, description: "EBITDA, or net profit before interest, tax, depreciation and amortisation as printed" }, wages: n, owner_pay: n }, required: ["period"], additionalProperties: false } },
    bank: { type: "array", description: "Bank statement totals: deposits per month or year", items: { type: "object", properties: { period: { type: "string" }, deposits: n }, required: ["period"], additionalProperties: false } },
    tax: { type: "array", description: "Tax return figures by year", items: { type: "object", properties: { year: { type: "string" }, revenue: n, net_profit: n }, required: ["year"], additionalProperties: false } },
    customers: { type: "array", description: "Revenue by customer for the latest year", items: { type: "object", properties: { name: { type: "string" }, revenue: n }, required: ["name"], additionalProperties: false } },
    addbacks: { type: "array", description: "Add-backs or normalisations the seller claims", items: { type: "object", properties: { label: { type: "string" }, amount: n, reason_given: { type: "string" } }, required: ["label"], additionalProperties: false } },
    nwc: { type: "array", description: "Balance sheet working capital by date", items: { type: "object", properties: { period: { type: "string" }, receivables: n, inventory: n, payables: n }, required: ["period"], additionalProperties: false } },
  },
  required: ["pnl", "bank", "tax", "customers", "addbacks", "nwc"], additionalProperties: false,
};
const clean = (rows, need) => (rows || []).filter((r) => need.every((k) => r[k] != null && r[k] !== ""));

registerAgent({
  id: "xray", name: "Earnings X-Ray", icon: "scan", needsTarget: true, stages: ["meeting", "docs", "loi", "diligence"],
  describe: "A quality-of-earnings pass before you sign anything: reads the seller's P&Ls, bank statements, tax returns and customer lists from the deal room, ties bank deposits to revenue, checks the financials against the tax returns, grades every add-back, measures customer concentration and the working-capital peg, and gives you an adjusted EBITDA range and the questions to ask.",
  layers: [
    {
      id: "files", title: "Collect the seller's spreadsheets", kind: "gather",
      async run(L) {
        const { sheets, skipped } = await targetSheets(L.env, L.ctx.accountId, L.target.id);
        if (!sheets.length) return { stop: "Upload the seller's P&L, bank statements, tax returns or customer list (CSV or .xlsx) to the deal room first.", summary: `No spreadsheets yet${skipped.length ? ` (${skipped.length} other file(s))` : ""}`, data: { files: [], skipped } };
        return { summary: `${sheets.length} spreadsheet(s): ${sheets.map((s) => s.name).join(", ")}`, data: { files: sheets.map((s) => ({ id: s.id, name: s.name, item: s.item })), skipped } };
      },
    },
    {
      id: "extract", title: "Map every file into P&L, bank, tax, customers, add-backs and working capital", kind: "extract",
      async run(L) {
        const { sheets } = await targetSheets(L.env, L.ctx.accountId, L.target.id);
        const { data, dropped } = await extract(L, sheets, EXTRACT_SCHEMA, `These are the seller's files for ${L.target.name}. Pull out the profit and loss, bank deposits, tax return figures, revenue by customer, any add-backs the seller claims, and working capital (receivables, inventory, payables).`, 8000);
        const x = {
          gst: data.gst_registered === true,
          pnl: clean(data.pnl, ["period", "revenue", "ebitda"]), bank: clean(data.bank, ["period", "deposits"]), tax: clean(data.tax, ["year", "revenue"]),
          customers: clean(data.customers, ["name", "revenue"]), addbacks: clean(data.addbacks, ["label", "amount"]), nwc: clean(data.nwc, ["period"]),
        };
        return { summary: `${x.pnl.length} P&L period(s), ${x.bank.length} bank, ${x.tax.length} tax year(s), ${x.customers.length} customer(s), ${x.addbacks.length} add-back(s)${dropped ? `; ${dropped} number(s) dropped (not in the files)` : ""}`, data: { ...x, dropped } };
      },
    },
    {
      id: "grade", title: "Grade every add-back and read the business", kind: "reason",
      async run(L) {
        const e = L.state.extract;
        const pre = xray(e);
        const schema = { ...FINDINGS_SCHEMA, properties: { ...FINDINGS_SCHEMA.properties,
          addbacks: { type: "array", items: { type: "object", properties: { label: { type: "string" }, class: { type: "string", enum: ["documented", "recurring", "unsupported"] }, why: { type: "string" } }, required: ["label", "class", "why"], additionalProperties: false } },
          questions: { type: "array", items: { type: "string" }, description: "Specific questions to put to the seller, each tied to a number" },
        }, required: [...FINDINGS_SCHEMA.required, "addbacks", "questions"] };
        const out = await L.ask(crewSystem("Due Diligence Quality of Earnings EBITDA adjustments owner compensation normalization one-time expenses red flag decision matrix working capital"),
          `Target: ${L.target.name} (${L.target.industry || "industry not set"}). Asking price: ${L.target.asking ? money(L.target.asking) : "not set"}.
Add-backs claimed:\n${JSON.stringify(e.addbacks)}
${FINDINGS_RULE}
<numbers>\n${JSON.stringify(pre)}\n</numbers>
1) Grade each add-back: documented (one-off or personal, evidence plausible), recurring (a real ongoing cost dressed up as one-off), or unsupported (no basis in the files). 2) Raise findings using the skill's red flag matrix and due-diligence checklist: financials vs tax returns, proof of cash, concentration, margin trend, working capital. 3) Write the questions for the seller.`, schema, 5000, "high");
        return { summary: out.headline, data: out };
      },
    },
    {
      id: "compute", title: "Recompute adjusted EBITDA with the grades", kind: "compute",
      async run(L) {
        const e = L.state.extract, gr = L.state.grade;
        const cls = new Map(gr.addbacks.map((a) => [a.label.trim().toLowerCase(), a.class]));
        const graded = e.addbacks.map((a) => ({ ...a, class: cls.get(a.label.trim().toLowerCase()) || "unclassified" }));
        const x = xray({ ...e, addbacks: graded });
        const a = x.adjusted_ebitda;
        return { summary: a ? `Reported ${money(a.reported)}; seller says ${money(a.seller_adjusted)}; defensible ${money(a.base)} (range ${money(a.low)}–${money(a.high)})` : "No EBITDA found in the files", data: { ...x, addbacks: graded } };
      },
    },
    {
      id: "verify", title: "Check claims and apply the red-flag rules in code", kind: "verify",
      async run(L) {
        const x = L.state.compute, gr = L.state.grade;
        const { kept, dropped } = verifyFindings(gr.findings, x);
        const hard = [];
        for (const t of x.tax_check) if (t.revenue_gap_pct != null && Math.abs(t.revenue_gap_pct) > 5) hard.push({ key: `tax_gap_${t.year}`, severity: "high", title: `${t.year}: P&L revenue is ${t.revenue_gap_pct}% off the tax return`, detail: `P&L ${money(t.pnl_revenue)} vs tax return ${money(t.tax_revenue)}. The skill's matrix: financials ≠ tax returns → walk away unless explained.`, evidence: "Tax return vs P&L", action: "Ask for the reconciliation before going further." });
        for (const p of x.proof_of_cash) if (p.gap_pct != null && p.gap_pct < -5) hard.push({ key: `cash_gap_${p.year}`, severity: "high", title: `${p.year}: bank deposits are ${p.gap_pct}% below revenue`, detail: `Deposits ${money(p.deposits)} vs ${money(p.expected_deposits)} expected from ${money(p.revenue)} of revenue.`, evidence: "Proof of cash", action: "Ask where the missing receipts were banked." });
        const c = x.concentration;
        if (c && c.top1 >= 50) hard.push({ key: "concentration_50", severity: "high", title: `${c.top1_name} is ${c.top1}% of revenue`, detail: "The skill's matrix: customer concentration >50% → walk or heavily discount.", evidence: "Customer list", action: "Walk, or price the risk in (earn-out on that customer, bigger vendor note)." });
        else if (c && c.top2 > 30) hard.push({ key: "concentration_30", severity: "medium", title: `Top two customers are ${c.top2}% of revenue`, detail: "The skill's red flag: 1-2 entities over 30% of revenue.", evidence: "Customer list", action: "Check contract assignability and talk to those customers before settlement." });
        const a = x.adjusted_ebitda;
        if (a && a.addback_share_pct != null && a.addback_share_pct > 20) hard.push({ key: "addbacks_heavy", severity: "medium", title: `Add-backs are ${a.addback_share_pct}% of reported EBITDA`, detail: `Only ${money(a.by_class.documented)} of ${money(a.claimed_addbacks)} is documented.`, evidence: "Add-back grading", action: "Price on the defensible figure, not the seller's." });
        if (x.margin_change_pts != null && x.margin_change_pts < -3) hard.push({ key: "margin_slip", severity: "medium", title: `EBITDA margin slipped ${x.margin_change_pts} points`, detail: "The skill's red flag: slipping gross margin masked by accounting changes.", evidence: "P&L by year", action: "Find out why before you agree a price." });
        const findings = mergeFindings(hard, kept);
        return { summary: `${findings.length} finding(s)${dropped.length ? `, ${dropped.length} dropped for unsupported numbers` : ""}`, data: { findings, dropped } };
      },
    },
    {
      id: "act", title: "Write the X-Ray memo, log red flags, propose the defensible EBITDA", kind: "act",
      async run(L) {
        const x = L.state.compute, gr = L.state.grade, v = L.state.verify, t = L.target, a = x.adjusted_ebitda;
        const md = [
          `# Earnings X-Ray: ${t.name}`, "", `**${gr.headline}**`, "",
          ...(a ? ["| EBITDA | Amount |", "|---|---|", `| Reported (${x.latest_year}) | ${money(a.reported)} |`, `| Seller-adjusted | ${money(a.seller_adjusted)} |`, `| **Defensible (documented add-backs only)** | **${money(a.base)}** |`, `| Range | ${money(a.low)} – ${money(a.high)} |`, ""] : []),
          ...(x.years.length ? ["## Years", "| Year | Revenue | EBITDA | Margin |", "|---|---|---|---|", ...x.years.map((y) => `| ${y.year}${y.months < 12 ? ` (${y.months} mo)` : ""} | ${money(y.revenue)} | ${money(y.ebitda)} | ${y.margin ?? "–"}% |`), ""] : []),
          ...(x.proof_of_cash.length ? ["## Proof of cash", ...x.proof_of_cash.map((p) => `- ${p.year}: deposits ${money(p.deposits)} vs ${money(p.expected_deposits)} expected (${p.gap_pct}%)`), ""] : []),
          ...(x.concentration ? ["## Customers", `- ${x.concentration.customers} customers; top 1 ${x.concentration.top1}% (${x.concentration.top1_name}), top 2 ${x.concentration.top2}%, top 5 ${x.concentration.top5}%`, ""] : []),
          ...(x.working_capital_peg ? ["## Working capital peg", `- Average ${money(x.working_capital_peg.average)} over ${x.working_capital_peg.periods} period(s) (range ${money(x.working_capital_peg.min)} – ${money(x.working_capital_peg.max)})`, ""] : []),
          ...(x.addbacks.length ? ["## Add-backs", "| Add-back | Amount | Grade | Why |", "|---|---|---|---|", ...x.addbacks.map((b) => `| ${b.label} | ${money(b.amount)} | ${b.class} | ${(gr.addbacks.find((g) => g.label.trim().toLowerCase() === b.label.trim().toLowerCase())?.why || "").replace(/\|/g, "/")} |`), ""] : []),
          "## Findings", ...v.findings.map((f) => `- **${f.title}** (${f.severity}). ${f.detail} *Do:* ${f.action}`),
          "", "## Questions for the seller", ...gr.questions.map((q) => `- ${q}`),
          "", "_Numbers are read only from the seller's files and recomputed in code; anything the model reported that wasn't in a file was dropped._",
        ];
        const proposals = [];
        if (a && a.base > 0 && Math.abs(a.base - (t.ebitda || 0)) / Math.max(1, a.base) > 0.05) proposals.push({ tool: "update_target", input: { target_id: t.id, ebitda: a.base }, title: `Set ${t.name}'s EBITDA to the defensible ${money(a.base)}`, reason: `Seller-adjusted is ${money(a.seller_adjusted)}; documented add-backs support ${money(a.base)}. The deal model and price follow this number.`, dedupe: `ebitda:${t.id}:${a.base}` });
        const map = { tax: "Financials ≠ Tax Returns", concentration_50: "Customer concentration >50%" };
        for (const f of v.findings.filter((f) => f.severity === "high").slice(0, 3)) {
          const flag = f.key.startsWith("tax_gap") ? map.tax : f.key === "concentration_50" ? map.concentration_50 : null;
          proposals.push({ tool: "log_diligence_item", input: { target_id: t.id, list: "dd", title: flag || f.title.slice(0, 120), ...(flag ? {} : { status: "issue", severity: "high", section: "Earnings X-Ray" }), notes: f.detail.slice(0, 400) }, title: `Log in the diligence list: ${f.title.slice(0, 80)}`, reason: f.action, dedupe: `ddflag:${t.id}:${f.key}` });
        }
        return { summary: `Memo written, ${v.findings.length} finding(s), ${proposals.length} proposal(s)`, headline: gr.headline, findings: v.findings.map((f) => ({ ...f, dedupe: f.key })), document: { kind: "xray", title: `Earnings X-Ray: ${t.name}`, content: md.join("\n") }, proposals };
      },
    },
  ],
});
