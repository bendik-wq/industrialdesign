// Covenant Sentinel: watches every business you own for a debt-cover breach before the bank does.
// Research: 36.5% of companies in Lincoln's private-market index had fixed-charge cover below 1.0x (Q3 2024); DSO
// roll-ups (Affordable Care, Dental Care Alliance) were handed to lenders after coverage collapsed; lenders warn
// 10-15% above the covenant. The skill's own floor is 1.5x DSCR.
import { registerAgent, lastDone } from "../runs.js";
import { targetDeal } from "../../public/js/deal.js";
import { listActuals, saveActuals } from "../actuals.js";
import { debtSchedule, covenantMetrics, cashForecast, JL_DSCR } from "./maths.js";
import { mergeFindings, FINDINGS_RULE, crewSystem, targetSheets, extract, FINDINGS_SCHEMA, verifyFindings, money, round } from "./common.js";

const period = (iso) => String(iso || new Date().toISOString()).slice(0, 7);

const ACTUALS_SCHEMA = {
  type: "object",
  properties: {
    months: { type: "array", items: { type: "object", properties: {
      period: { type: "string" }, revenue: { type: ["number", "null"] }, gross_profit: { type: ["number", "null"] }, wages: { type: ["number", "null"] },
      ebitda: { type: ["number", "null"], description: "EBITDA or, if not shown, the operating profit line before interest, tax, depreciation and amortisation as printed" },
      cash: { type: ["number", "null"] }, receivables: { type: ["number", "null"] }, payables: { type: ["number", "null"] }, debt_service: { type: ["number", "null"] },
    }, required: ["period"], additionalProperties: false } },
  },
  required: ["months"], additionalProperties: false,
};

registerAgent({
  id: "covenant", name: "Covenant Sentinel", icon: "shield", monitor: true, needsTarget: true, stages: ["closed"],
  describe: "Watches each business you own for a debt-cover (DSCR) breach months before it happens: imports monthly P&Ls, recomputes cover on actuals against the real debt schedule, projects the trend, stress-tests a bad year and a rate rise, runs 13-week cash, and drafts the conversation with your lender while you still have headroom.",
  layers: [
    {
      id: "gather", title: "Pull the debt, the covenant and the actuals", kind: "gather",
      async run(L) {
        const { env, ctx, target } = L;
        const room = await env.DB.prepare("SELECT settled_at FROM deal_rooms WHERE target_id = ?1 AND account_id = ?2").bind(target.id, ctx.accountId).first();
        const closed = period(room?.settled_at || target.stage_at || target.updated_at);
        const lender = await env.DB.prepare(`SELECT r.name, r.terms, f.terms AS deal_terms FROM financing f JOIN relationships r ON r.id = f.relationship_id AND r.account_id = f.account_id
          WHERE f.target_id = ?1 AND f.account_id = ?2 AND f.stage != 'declined' ORDER BY (f.stage = 'approved') DESC, f.id DESC LIMIT 1`).bind(target.id, ctx.accountId).first();
        const parse = (j) => { try { return JSON.parse(j || "{}"); } catch { return {}; } };
        const terms = { ...parse(lender?.terms), ...parse(lender?.deal_terms) };
        const covenant = Number(terms.dscr) > 0 ? Number(terms.dscr) : Number(terms.min_dscr) > 0 ? Number(terms.min_dscr) : JL_DSCR;
        const actuals = await listActuals(env, ctx, target.id, 36);
        const imported = new Set(actuals.map((a) => a.source).filter((s) => s.startsWith("file:")).map((s) => +s.slice(5)));
        const { sheets, skipped } = await targetSheets(env, ctx.accountId, target.id);
        const financial = (s) => /p&l|pnl|profit|loss|bank|statement|management|accounts|financ|monthly|ebitda/i.test(`${s.name} ${s.item || ""} ${s.book.sheets.map((x) => `${x.name} ${x.rows.slice(0, 6).flat().join(" ")}`).join(" ")}`) && !/staff|payroll|employee|customer|client list/i.test(s.name);
        const fresh = sheets.filter((s) => !imported.has(s.id) && financial(s) && Date.parse(s.uploaded) >= Date.parse(`${closed}-01`) - 400 * 864e5);
        if (L.input.scheduled && !fresh.length) {
          const since = await lastDone(env, ctx.accountId, "covenant", target.id);
          const changed = actuals.some((a) => !since || a.updated_at > since);
          if (since && !changed) return { stop: "No new actuals or files since the last check.", summary: "Nothing new", data: { months: actuals.length } };
        }
        return { summary: `${actuals.length} months of actuals, ${fresh.length} new file(s) to import, covenant ${covenant}x${lender ? ` (${lender.name})` : " (the 1.5x floor)"}`, data: { closed, covenant, lender: lender?.name || null, deal: targetDeal(target), months: actuals.length, fresh: fresh.map((s) => s.id), skipped } };
      },
    },
    {
      id: "import", title: "Read new P&Ls and bank exports into monthly actuals", kind: "extract",
      async run(L) {
        const g = L.state.gather;
        if (!g.fresh.length) return { summary: "Nothing new to import", data: { imported: 0 } };
        const { sheets } = await targetSheets(L.env, L.ctx.accountId, L.target.id);
        const pick = sheets.filter((s) => g.fresh.includes(s.id));
        let total = 0, dropped = 0;
        for (const s of pick) {
          const { data, dropped: d } = await extract(L, [s], ACTUALS_SCHEMA, "From this file, list the monthly figures for the business: revenue, gross profit, wages, EBITDA (or operating profit before interest, tax, depreciation and amortisation), closing cash, receivables, payables and loan repayments, one row per month. Skip anything that isn't a month.");
          dropped += d;
          const rows = (data.months || []).filter((m) => /^\d{4}-\d{2}$/.test(m.period));
          if (rows.length) { await saveActuals(L.env, L.ctx, L.target.id, rows, `file:${s.id}`); total += rows.length; }
        }
        return { summary: `Imported ${total} month(s) from ${pick.length} file(s)${dropped ? `; ${dropped} number(s) dropped because they weren't in the files` : ""}`, data: { imported: total, dropped } };
      },
    },
    {
      id: "compute", title: "Recompute cover on actuals, trend, stress and 13-week cash", kind: "compute",
      async run(L) {
        const g = L.state.gather;
        const actuals = await listActuals(L.env, L.ctx, L.target.id, 36);
        const withEbitda = actuals.filter((a) => Number.isFinite(a.ebitda));
        if (withEbitda.length < 2) return { stop: "Needs at least two months of EBITDA: add them under Actuals or upload monthly P&Ls to the deal room.", summary: "Not enough actuals yet", data: { months: withEbitda.length } };
        const schedule = debtSchedule(g.deal, g.closed, 120);
        const base = covenantMetrics(withEbitda, schedule, { covenant: g.covenant });
        const rate = covenantMetrics(withEbitda, debtSchedule(g.deal, g.closed, 120, { rateBump: 2 }), { covenant: g.covenant });
        const last = actuals.at(-1), recent = withEbitda.slice(-3);
        const monthlyEbitda = recent.reduce((t, a) => t + a.ebitda, 0) / recent.length;
        const nextService = schedule.byPeriod[last.period] ? Object.entries(schedule.byPeriod).filter(([p]) => p > last.period).slice(0, 3).reduce((t, [, v]) => t + v.total, 0) / 3 : base.forward.next12_service / 12;
        const cash = cashForecast({ cash: Number.isFinite(last.cash) ? last.cash : NaN, monthlyEbitda, monthlyService: nextService });
        const revenue = withEbitda.filter((a) => Number.isFinite(a.revenue));
        const margin = revenue.length ? round((revenue.slice(-3).reduce((t, a) => t + a.ebitda, 0) / revenue.slice(-3).reduce((t, a) => t + a.revenue, 0)) * 100, 1) : null;
        const data = { ...base, rate_plus_2: { dscr: rate.dscr, forward: rate.forward.dscr }, cash, ebitda_margin_3m_pct: margin, debt: { price: Math.round(schedule.price), bank: Math.round(schedule.amounts.bank), vendor_note: Math.round(schedule.amounts.vf) } };
        return { summary: `DSCR ${base.dscr}x on ${base.months} months (covenant ${g.covenant}x, warn at ${base.warn_at}x): ${base.status}${base.months_to_breach != null ? `, ${base.months_to_breach} month(s) to breach on trend` : ""}`, data };
      },
    },
    {
      id: "reason", title: "Explain the drivers and draft the lender conversation", kind: "reason",
      async run(L) {
        const c = L.state.compute, g = L.state.gather;
        const schema = { ...FINDINGS_SCHEMA, properties: { ...FINDINGS_SCHEMA.properties, lender_note: { type: "string", description: "A short, plain message to the lender (or the board) the owner could send now, if action is needed; empty if all is fine" } }, required: [...FINDINGS_SCHEMA.required, "lender_note"] };
        const out = await L.ask(crewSystem("Bank Relationship Playbook DSCR ICR covenant financial modeling base bear bull working capital"),
          `Business: ${L.target.name} (${L.target.industry || "industry not set"}). Lender: ${g.lender || "not recorded"}. Covenant: ${g.covenant}x DSCR.
${FINDINGS_RULE}
<numbers>\n${JSON.stringify(c)}\n</numbers>
Explain what is driving debt cover (trend, margin, cash) and what the owner should do this month. Raise a finding only where the numbers support it, quoting them exactly. Use the 3C model's Capital rules (1.5x DSCR, covenant headroom, debt service holidays aligned to integration, approaching banks early as a partner).`, schema, 3000, "medium");
        return { summary: out.headline, data: out };
      },
    },
    {
      id: "verify", title: "Check every claim against the computed numbers", kind: "verify",
      async run(L) {
        const c = L.state.compute, g = L.state.gather, r = L.state.reason;
        const { kept, dropped } = verifyFindings(r.findings, { c, covenant: g.covenant });
        // Code-made alerts that never depend on the model.
        const hard = [];
        if (c.status === "breach") hard.push({ key: "dscr_breach", severity: "high", title: `Debt cover ${c.dscr}x is below the ${g.covenant}x covenant`, detail: `Trailing EBITDA ${money(c.ttm_ebitda)} against ${money(c.ttm_service)} of debt service.`, evidence: "Recomputed from actuals and the deal's debt schedule", action: "Talk to the lender now, before the next test date." });
        else if (c.status === "warning") hard.push({ key: "dscr_warning", severity: "high", title: `Debt cover ${c.rolling_dscr ?? c.dscr}x is inside the warning zone (${c.warn_at}x)${c.months_to_breach != null ? `; on trend it breaches in ${c.months_to_breach} month(s)` : ""}`, detail: `Trend ${c.trend_per_month} per month. Forward 12-month cover at run-rate EBITDA: ${c.forward.dscr}x.`, evidence: "Rolling 3-month DSCR series", action: "Find the margin leak and line up the lender conversation while you still have headroom." });
        if (c.forward?.stress?.minus20 != null && c.forward.stress.minus20 < g.covenant) hard.push({ key: "stress_20", severity: "medium", title: `A 20% EBITDA drop would take cover to ${c.forward.stress.minus20}x`, detail: `Below the ${g.covenant}x covenant.`, evidence: "Forward stress test", action: "Build a cash buffer or negotiate a repayment holiday before you need it." });
        if (c.cash?.low != null && c.cash.low < 0) hard.push({ key: "cash_negative", severity: "high", title: `13-week cash goes negative (low ${money(c.cash.low)})`, detail: `Opening ${money(c.cash.opening)}, weekly net ${money(c.cash.weekly_net)}.`, evidence: "13-week cash forecast", action: "Draw the working-capital line or move a repayment date now." });
        const findings = mergeFindings(hard, kept);
        return { summary: `${findings.length} finding(s) kept${dropped.length ? `, ${dropped.length} dropped for unsupported numbers` : ""}`, data: { findings, dropped } };
      },
    },
    {
      id: "act", title: "Raise alerts, write the covenant report, queue next steps", kind: "act",
      async run(L) {
        const c = L.state.compute, g = L.state.gather, r = L.state.reason, v = { data: L.state.verify };
        const t = L.target;
        const lines = [
          `# Covenant watch: ${t.name} (${c.last_period})`, "", `**${r.headline}**`, "",
          "| Measure | Value |", "|---|---|",
          `| Debt cover (trailing${c.annualised ? ", annualised" : " 12 months"}) | ${c.dscr}x |`, `| Rolling 3-month cover | ${c.rolling_dscr}x |`, `| Covenant / warning line | ${g.covenant}x / ${c.warn_at}x |`,
          `| Trend per month | ${c.trend_per_month ?? "n/a"} |`, `| Months to breach on trend | ${c.months_to_breach ?? "none projected"} |`,
          `| Trailing EBITDA / debt service | ${money(c.ttm_ebitda)} / ${money(c.ttm_service)} |`, `| Service headroom at the covenant | ${money(c.service_headroom)} a year |`,
          `| Forward 12 months at run-rate | ${c.forward.dscr}x (EBITDA −10%: ${c.forward.stress?.minus10}x, −20%: ${c.forward.stress?.minus20}x) |`,
          `| Bank rate +2% | ${c.rate_plus_2.forward}x forward |`,
          ...(c.cash ? [`| 13-week cash | opens ${money(c.cash.opening)}, low ${money(c.cash.low)}, week 13 ${money(c.cash.week13)} |`] : []),
          "", "## Findings", ...v.data.findings.map((f) => `- **${f.title}** (${f.severity}). ${f.detail} *Do:* ${f.action}`),
          ...(r.lender_note ? ["", "## Draft note to your lender", "", r.lender_note] : []),
          "", `_Recomputed from ${c.months} month(s) of actuals against the deal's own debt schedule. The model explains; code does the maths._`,
        ];
        const urgent = v.data.findings.some((f) => f.severity === "high");
        const proposals = urgent ? [{ tool: "update_target", input: { target_id: t.id, next_action: `Call ${g.lender || "the lender"} about debt-cover headroom (${c.rolling_dscr ?? c.dscr}x vs ${g.covenant}x)`, next_date: new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10) }, title: `Put a lender call on ${t.name}'s next action`, reason: r.headline, dedupe: `lendercall:${t.id}:${c.last_period}` }] : [];
        return { summary: `${v.data.findings.length} alert(s), report written${proposals.length ? ", lender call queued for approval" : ""}`, headline: r.headline, findings: v.data.findings.map((f) => ({ ...f, dedupe: f.key, metric: { dscr: c.dscr, covenant: g.covenant, period: c.last_period } })), document: { kind: "covenant", title: `Covenant watch: ${t.name} ${c.last_period}`, content: lines.join("\n") }, proposals, data: { urgent } };
      },
    },
  ],
});
