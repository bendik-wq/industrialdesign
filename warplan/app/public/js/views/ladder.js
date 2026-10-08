import { $, esc, view, synced } from "../core.js";
import { ELEMENTS, LADDER_DEFAULTS, ladderModel, multipleFor, money, structureSummary } from "../deal.js";
import { loadDeal } from "./builder.js";
import { askJoshAbout } from "./josh.js";

export function renderLadder() {
  const x = { ...LADDER_DEFAULTS, ...synced.get("ladder", {}) };
  const d = loadDeal();
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Value Ladder</p><h1>What your company becomes.</h1>
      <p class="lede">Small companies sell for 3–4× profit. Groups sell for 6–8×. Buy competitors with no money down, combine them, and the difference is equity you created, paid for by the businesses themselves.</p></header>
    <div class="ladder">
      <form class="panel inputs" id="lf" novalidate>
        <label>Your yearly profit (EBITDA)<input name="myEbitda" type="number" inputmode="decimal" min="0" step="50000" value="${x.myEbitda}"></label>
        <label>Competitors you buy <output>${x.deals}</output><input name="deals" type="range" min="1" max="12" value="${x.deals}"></label>
        <label>Profit per competitor (EBITDA)<input name="targetEbitda" type="number" inputmode="decimal" min="0" step="50000" value="${x.targetEbitda}"></label>
        <label>Price you pay <output>${x.buyMultiple}× profit</output><input name="buyMultiple" type="range" min="2" max="7" step="0.25" value="${x.buyMultiple}"></label>
        <label>Savings from combining <output>${x.synergy}%</output><input name="synergy" type="range" min="0" max="30" step="5" value="${x.synergy}"></label>
        <div class="struct-note"><b>Structure for every deal</b><br>${esc(ELEMENTS.filter((e) => d[e.k].pct > 0).map((e) => `${e.label} ${d[e.k].pct}%`).join(" · "))}<br><a href="#/builder">Change it in the Deal Builder →</a></div>
        <p class="muted small">Group multiples by size: 3.5× under 1M profit, 4.5×, 5.5×, 7×, 8× above 10M. Indicative, not a valuation.</p>
      </form>
      <div class="results" id="lr" aria-live="polite"></div>
    </div>`;
  const draw = () => {
    synced.set("ladder", x);
    const L = ladderModel(x, d), f = L.final, c = L.cur, per = L.per;
    const created = f.equity3 - L.todayValue;
    const ok = per.minDscr == null || per.minDscr >= 1.5, warn = per.minDscr != null && per.minDscr >= 1.2 && per.minDscr < 1.5;
    const max = Math.max(...L.steps.map((s) => s.value));
    $("#lr").innerHTML = `
      <div class="kpis">
        <div class="kpi"><span>Your company today</span><b>${money(L.todayValue, c)}</b><small>${multipleFor(x.myEbitda, c)}× ${money(x.myEbitda, c)} profit</small></div>
        <div class="kpi accent"><span>After ${x.deals} acquisitions</span><b>${money(f.value, c)}</b><small>${f.multiple}× ${money(f.ebitda, c)} profit</small></div>
        <div class="kpi"><span>Your equity in 3 years</span><b>${money(f.equity3, c)}</b><small>${created >= 0 ? "+" : ""}${money(created, c)} vs. today</small></div>
      </div>
      <div class="dscr-line ${ok ? "good" : warn ? "warn" : "bad"}">
        <b>${ok ? "✓ Bankable" : warn ? "! Tight" : "✕ Not bankable"}</b>
        <span>Each company you buy covers its own repayments ${per.minDscr == null ? "fully (no debt)" : per.minDscr.toFixed(2) + "× in its weakest year"} (lenders want 1.5×). Total price ${money(f.price, c)}; your cash in ${money(per.cashFromYou * x.deals, c)}${f.outsideStake ? `; sellers and investors end up with ~${Math.round(f.outsideStake * 100)}% of the group` : ""}.</span>
      </div>
      <div class="panel ladder-chart">
        <h2 class="h3">Group value after each acquisition</h2>
        <div class="table-wrap"><table><thead><tr><th>Deals</th><th>Profit</th><th>Multiple</th><th class="bar-col">Value</th></tr></thead>
        <tbody>${L.steps.map((s) => `<tr title="${s.n} deals: ${money(s.value, c)} value, ${money(s.price, c)} paid">
          <td>${s.n === 0 ? "Today" : s.n}</td><td>${money(s.ebitda, c)}</td><td>${s.multiple}×</td>
          <td class="bar-col"><div class="bar-cell"><div class="bar"><span style="width:${(100 * s.value) / max}%"></span></div><b>${money(s.value, c)}</b></div></td></tr>`).join("")}</tbody></table></div>
      </div>
      <div class="ask-josh"><p>Want Josh to pressure-test this plan?</p><button class="primary" id="askLadder" type="button">Ask Josh about these numbers →</button></div>`;
    $("#askLadder").addEventListener("click", () => askJoshAbout(`Pressure-test my roll-up plan. My company makes ${money(x.myEbitda, c)} EBITDA. I want to buy ${x.deals} competitors making about ${money(x.targetEbitda, c)} EBITDA each at ${x.buyMultiple}x. Each deal: ${structureSummary({ ...d, ebitda: x.targetEbitda, multiple: x.buyMultiple }, per)} The model says the group could be worth ${money(f.value, c)} with my equity at ${money(f.equity3, c)} after 3 years. What am I missing and what would you change?`));
  };
  $("#lf").addEventListener("input", (e) => {
    const el = e.target; if (!el.name || el.value === "") return;
    x[el.name] = Number(el.value);
    const out = el.parentElement.querySelector("output");
    if (out) out.textContent = el.name === "buyMultiple" ? `${el.value}× profit` : el.name === "deals" ? el.value : `${el.value}%`;
    draw();
  });
  draw();
}
