// Retention Watchtower: who is about to walk out with the revenue, measured against the business you bought.
// Research: acquired employees leave at nearly three times the normal rate in year one (33% vs 12%, US Census matched
// data); ATI Physical Therapy cut guidance twice on therapist attrition; Healius took a A$587M impairment as GPs left;
// about half of the advisers CountPlus bought from Count Financial left. Customer revenue retention falls after
// ownership changes (BrightView below 80%). The skill: interview staff before close, retention bonuses in the
// structure, keep the seller in transition, a continuity plan for customers and staff.
import { registerAgent, lastDone } from "../runs.js";
import { saveSnapshot, snapshots } from "../actuals.js";
import { retention } from "./maths.js";
import { mergeFindings, FINDINGS_RULE, crewSystem, targetSheets, extract, FINDINGS_SCHEMA, verifyFindings, money } from "./common.js";

const n = { type: ["number", "null"] };
const SCHEMA = {
  type: "object",
  properties: {
    staff: { type: "array", description: "Every person on the payroll or staff list", items: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, start_date: { type: ["string", "null"], description: "YYYY-MM-DD" }, pay: { ...n, description: "Annual pay or package" }, revenue: { ...n, description: "Revenue they produced or billed in the period, if the files show it" } }, required: ["name"], additionalProperties: false } },
    customers: { type: "array", description: "Revenue by customer or client for the latest period", items: { type: "object", properties: { name: { type: "string" }, revenue: n }, required: ["name"], additionalProperties: false } },
  },
  required: ["staff", "customers"], additionalProperties: false,
};

registerAgent({
  id: "retention", name: "Retention Watchtower", icon: "users", monitor: true, needsTarget: true, stages: ["diligence", "closed"], monitorStages: ["closed"],
  describe: "Finds the people and customers about to walk out with the revenue: reads payroll, production and customer lists, compares them with the day you bought the business, scores each key person's flight risk (falling production, a pay cut, a lock-in or earn-out ending, a big share of revenue, short tenure), tracks lost and shrinking customers, and gives you a retention play for each one from the 3C model.",
  layers: [
    {
      id: "gather", title: "Find staff and customer files, earlier snapshots and cliff dates", kind: "gather",
      async run(L) {
        const { env, ctx, target } = L;
        const [staffSnaps, custSnaps] = await Promise.all([snapshots(env, ctx.accountId, target.id, "staff"), snapshots(env, ctx.accountId, target.id, "customers")]);
        const used = new Set([...staffSnaps, ...custSnaps].map((s) => s.source).filter((s) => s.startsWith("file:")).flatMap((s) => s.slice(5).split(",").map(Number)));
        const { sheets } = await targetSheets(env, ctx.accountId, target.id);
        const fresh = sheets.filter((s) => !used.has(s.id) && /staff|payroll|employee|team|wage|production|provider|clinician|tech|customer|client|debtor|revenue by|sales by/i.test(`${s.name} ${s.item || ""} ${s.book.sheets.map((x) => x.name).join(" ")}`));
        const cliffs = (Array.isArray(L.input.cliffs) ? L.input.cliffs : []).filter((c) => c && /^\d{4}-\d{2}-\d{2}$/.test(c.date)).slice(0, 30);
        if (L.input.scheduled && !fresh.length) {
          const since = await lastDone(env, ctx.accountId, "retention", target.id);
          if (since) return { stop: "No new staff or customer files since the last check.", summary: "Nothing new", data: {} };
        }
        if (!fresh.length && !staffSnaps.length && !custSnaps.length) return { stop: "Upload a staff or payroll list (with pay and, ideally, revenue per person) and a revenue-by-customer list to the deal room. The first one becomes the baseline.", summary: "No staff or customer data yet", data: {} };
        return { summary: `${fresh.length} new file(s); ${staffSnaps.length} staff and ${custSnaps.length} customer snapshot(s) on record; ${cliffs.length} cliff date(s)`, data: { fresh: fresh.map((s) => s.id), staffSnaps: staffSnaps.length, custSnaps: custSnaps.length, cliffs } };
      },
    },
    {
      id: "extract", title: "Read staff, pay, production and customer revenue", kind: "extract",
      async run(L) {
        const g = L.state.gather;
        if (!g.fresh?.length) return { summary: "No new files; using the latest snapshots", data: { fresh: false } };
        const { sheets } = await targetSheets(L.env, L.ctx.accountId, L.target.id);
        const pick = sheets.filter((s) => g.fresh.includes(s.id));
        const { data, dropped } = await extract(L, pick, SCHEMA, `Files for ${L.target.name}. List every staff member (name, role, start date, annual pay, revenue they produced if shown) and revenue by customer for the latest period.`, 8000);
        const staff = (data.staff || []).filter((s) => s.name), customers = (data.customers || []).filter((c) => c.name && c.revenue != null);
        const src = `file:${pick.map((s) => s.id).join(",")}`;
        if (staff.length) await saveSnapshot(L.env, L.ctx.accountId, L.target.id, "staff", staff, src);
        if (customers.length) await saveSnapshot(L.env, L.ctx.accountId, L.target.id, "customers", customers, src);
        return { summary: `${staff.length} staff, ${customers.length} customer(s) saved as a snapshot${dropped ? `; ${dropped} number(s) dropped (not in the files)` : ""}`, data: { fresh: true, staff: staff.length, customers: customers.length } };
      },
    },
    {
      id: "compute", title: "Compare with the baseline and score flight risk", kind: "compute",
      async run(L) {
        const [s, c] = await Promise.all([snapshots(L.env, L.ctx.accountId, L.target.id, "staff"), snapshots(L.env, L.ctx.accountId, L.target.id, "customers")]);
        const r = retention({ staff: s.at(-1)?.data || [], baseline: s.length > 1 ? s[0].data : null, customers: c.at(-1)?.data || [], baselineCustomers: c.length > 1 ? c[0].data : null, cliffs: L.state.gather.cliffs || [] });
        r.baseline_date = s[0]?.taken_at?.slice(0, 10) || c[0]?.taken_at?.slice(0, 10) || null;
        return { summary: `${r.at_risk.length} person(s) at risk; staff retention ${r.staff_retention_pct ?? "n/a (first snapshot)"}%; customer revenue retention ${r.customer_revenue_retention_pct ?? "n/a"}%`, data: r };
      },
    },
    {
      id: "reason", title: "Write a retention play for each risk", kind: "reason",
      async run(L) {
        const r = L.state.compute;
        const schema = { ...FINDINGS_SCHEMA, properties: { ...FINDINGS_SCHEMA.properties, plays: { type: "array", items: { type: "object", properties: { who: { type: "string" }, play: { type: "string", description: "The specific move, this week" }, by: { type: "string", description: "When, e.g. before the lock-in date" } }, required: ["who", "play", "by"], additionalProperties: false } } }, required: [...FINDINGS_SCHEMA.required, "plays"] };
        const out = await L.ask(crewSystem("staff retention seller transition interview staff before close retention bonuses continuity plan first 100 days customers employees"),
          `Business: ${L.target.name} (${L.target.industry || "industry not set"}). Stage: ${L.target.stage}.
${FINDINGS_RULE}
<numbers>\n${JSON.stringify(r)}\n</numbers>
Raise findings on people and customers at risk, quoting the numbers. For each person or customer at risk, give one concrete retention play from the 3C model (retention bonuses in the structure, the seller's transition and introductions, staff interviews, a continuity plan, Day-1 words), and when to do it.`, schema, 4000, "medium");
        return { summary: out.headline, data: out };
      },
    },
    {
      id: "verify", title: "Check claims; add the code-made alerts", kind: "verify",
      async run(L) {
        const r = L.state.compute, o = L.state.reason;
        const { kept, dropped } = verifyFindings(o.findings, r);
        const hard = [];
        for (const p of r.at_risk.slice(0, 8)) hard.push({ key: `person_${p.name.toLowerCase().replace(/\W+/g, "_")}`, severity: p.risk >= 60 ? "high" : "medium", title: `${p.name}${p.role ? ` (${p.role})` : ""}: flight risk ${p.risk}/100`, detail: `Why: ${p.why.join("; ")}.`, evidence: "Payroll and production vs the baseline snapshot", action: p.cliff ? `Sit down with them before ${p.cliff.date}.` : "Sit down with them this week." });
        if (r.departed.length) hard.push({ key: "staff_departed", severity: (r.departed_revenue_share_pct || 0) >= 15 ? "high" : "medium", title: `${r.departed.length} of ${r.baseline_staff} staff gone since the baseline${r.departed_revenue_share_pct ? ` (${r.departed_revenue_share_pct}% of production)` : ""}`, detail: `Left: ${r.departed.map((d) => `${d.name}${d.role ? ` (${d.role})` : ""}`).join(", ")}.`, evidence: "Staff snapshots", action: "Find out why each one left, and whether their customers followed them." });
        if (r.lost_customers.length) hard.push({ key: "customers_lost", severity: r.customer_revenue_retention_pct != null && r.customer_revenue_retention_pct < 90 ? "high" : "medium", title: `${r.lost_customers.length} customer(s) gone since the baseline; revenue retention ${r.customer_revenue_retention_pct}%`, detail: `Largest: ${r.lost_customers.slice(0, 3).map((c) => `${c.name} (${money(c.revenue_at_close)})`).join(", ")}.`, evidence: "Customer snapshots", action: "Call each one personally, with the seller if they're still in transition." });
        if (r.top1_share_pct != null && r.top1_share_pct >= 30) hard.push({ key: "customer_concentration", severity: r.top1_share_pct >= 50 ? "high" : "medium", title: `${r.top1_name} is ${r.top1_share_pct}% of customer revenue`, detail: "The skill's red flag: 1-2 entities over 30% of revenue.", evidence: "Latest customer snapshot", action: "Get that relationship off the seller and onto you." });
        const findings = mergeFindings(hard, kept);
        return { summary: `${findings.length} finding(s)${dropped.length ? `, ${dropped.length} dropped` : ""}`, data: { findings, dropped } };
      },
    },
    {
      id: "act", title: "Raise alerts, write the retention board, queue the sit-downs", kind: "act",
      async run(L) {
        const r = L.state.compute, o = L.state.reason, v = L.state.verify, t = L.target;
        const md = [
          `# Retention watch: ${t.name}`, "", `**${o.headline}**`, "",
          `Baseline: ${r.baseline_date || "this run"}. Staff ${r.staff_count}${r.baseline_staff != null ? ` (was ${r.baseline_staff}, retention ${r.staff_retention_pct}%)` : ""}. Customers ${r.customers}${r.baseline_customers != null ? ` (was ${r.baseline_customers}, revenue retention ${r.customer_revenue_retention_pct}%)` : ""}.`, "",
          "## Flight risk", "| Person | Risk | Share of revenue | Why |", "|---|---|---|---|",
          ...r.people.slice(0, 15).map((p) => `| ${p.name}${p.role ? ` (${p.role})` : ""} | ${p.risk} | ${p.revenue_share_pct}% | ${p.why.join("; ") || "–"} |`),
          ...(r.departed.length ? ["", "## Left since the baseline", ...r.departed.map((d) => `- ${d.name}${d.role ? ` (${d.role})` : ""}${d.revenue ? `: ${money(d.revenue)} of revenue` : ""}`)] : []),
          ...(r.lost_customers.length || r.shrinking_customers.length ? ["", "## Customers", ...r.lost_customers.map((c) => `- Lost: ${c.name} (${money(c.revenue_at_close)} at baseline)`), ...r.shrinking_customers.map((c) => `- Shrinking: ${c.name} ${c.change_pct}% (${money(c.at_close)} → ${money(c.now)})`)] : []),
          "", "## Plays", ...o.plays.map((p) => `- **${p.who}**: ${p.play} _(by ${p.by})_`),
          "", "## Findings", ...v.findings.map((f) => `- **${f.title}** (${f.severity}). ${f.detail} *Do:* ${f.action}`),
        ];
        const top = r.at_risk[0];
        const proposals = top ? [{ tool: "update_target", input: { target_id: t.id, next_action: `Retention sit-down with ${top.name}${top.cliff ? ` before ${top.cliff.label || "the cliff"} (${top.cliff.date})` : ""}`, next_date: new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10) }, title: `Book a retention sit-down with ${top.name}`, reason: `Flight risk ${top.risk}/100: ${top.why.join("; ")}.`, dedupe: `retain:${t.id}:${top.name}` }] : [];
        return { summary: `${v.findings.length} alert(s), board written`, headline: o.headline, findings: v.findings.map((f) => ({ ...f, dedupe: f.key })), document: { kind: "retention", title: `Retention watch: ${t.name}`, content: md.join("\n") }, proposals };
      },
    },
  ],
});
