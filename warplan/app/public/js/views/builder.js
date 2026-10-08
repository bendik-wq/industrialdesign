import { $, $$, esc, api, post, view, stale, synced, toast, fail, copy, skeleton } from "../core.js";
import { CURS, ELEMENTS, DEAL_DEFAULTS, PRESETS, normalizeDeal, dealModel, maxMultiple, money, pct, structureSummary, targetDeal } from "../deal.js";
import { askJoshAbout } from "./josh.js";

export const loadDeal = () => normalizeDeal(synced.get("deal", DEAL_DEFAULTS));

export async function renderBuilder(seq, params) {
  const targetId = params.get("target");
  let target = null;
  if (targetId) {
    view().innerHTML = skeleton(4);
    target = await api(`/api/targets/${targetId}`).catch(() => null);
    if (stale(seq)) return;
    if (!target) { toast("That target doesn't exist any more."); location.hash = "#/builder"; return; }
  }
  const d = target ? targetDeal(target, loadDeal()) : loadDeal();
  const num = (path, label, attrs = "") => { const [a, b] = path.split("."); const v = b ? d[a][b] : d[a]; return `<label>${label}<input data-p="${path}" type="number" inputmode="decimal" value="${v}" ${attrs}></label>`; };
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Deal Builder${target ? ` · <a href="#/targets/${target.id}">${esc(target.name)}</a>` : ""}</p><h1>${target ? `Structure ${esc(target.name)}.` : "Any structure. Two rules."}</h1>
      <p class="lede">Stack the capital however you like: vendor finance, commercial debt, seller rollover, investor capital, your own cash if you want to. The deal works when you keep majority control and the business covers every repayment at least 1.5 times, every year.</p>
      ${target ? `<p class="saved-note" id="savedNote">Saved to ${esc(target.name)} automatically.</p>` : ""}</header>
    <div class="presets">${Object.entries(PRESETS).map(([k, p]) => `<button type="button" class="preset" data-preset="${k}"><b>${esc(p.name)}</b><small>${esc(p.note)}</small></button>`).join("")}</div>
    <div class="builder">
      <form class="panel inputs" id="bf" novalidate>
        <div class="field-label">Currency<div class="seg" id="cur" role="group" aria-label="Currency">${CURS.map((c) => `<button type="button" data-c="${c}" class="${c === d.cur ? "on" : ""}" aria-pressed="${c === d.cur}">${c.trim()}</button>`).join("")}</div></div>
        <div class="two">${num("ebitda", "Target EBITDA", 'min="0" step="25000"')}${num("multiple", "Price (× EBITDA)", 'min="0.5" max="15" step="0.25"')}</div>
        ${num("fcfPct", "Free cash flow (% of EBITDA)", 'min="10" max="100" step="5"')}
        <div class="stack-in">
          ${ELEMENTS.map((e, i) => `<fieldset class="el" style="--c: var(--s${i + 1})">
            <legend><i></i>${e.label}<output data-o="${e.k}">${d[e.k].pct}%</output></legend>
            <input data-p="${e.k}.pct" type="range" min="0" max="100" step="5" value="${d[e.k].pct}" aria-label="${e.label} share of the price">
            ${e.k === "vf" ? `<div class="three">${num("vf.years", "Years", 'min="1" max="99"')}${num("vf.rate", "Rate %", 'min="0" max="20" step="0.25"')}${num("vf.holiday", "Holiday (mo)", 'min="0" max="24"')}</div>${num("vf.io", "Interest-only months after the holiday", 'min="0" max="120"')}` : ""}
            ${e.k === "bank" ? `<div class="two">${num("bank.years", "Years", 'min="1" max="25"')}${num("bank.rate", "Rate %", 'min="0" max="25" step="0.25"')}</div>` : ""}
            ${e.k === "inv" ? num("inv.stake", "Equity investors get (%)", 'min="0" max="100" step="1"') : ""}
          </fieldset>`).join("")}
        </div>
        <label class="check"><input type="checkbox" data-p="nonVoting" ${d.nonVoting ? "checked" : ""}> Rollover and investor shares are non-voting</label>
        <button type="button" class="ghost" id="fillGap">Fill the gap with vendor finance</button>
      </form>
      <div class="results" id="br" aria-live="polite"></div>
    </div>`;
  let saveT;
  const save = () => {
    if (!target) { synced.set("deal", d); return; }
    clearTimeout(saveT);
    saveT = setTimeout(async () => {
      try { await post(`/api/targets/${target.id}`, { deal: d, ...(d.ebitda && !target.ebitda ? { ebitda: d.ebitda } : {}) }, "PATCH"); const n = $("#savedNote"); if (n) { n.textContent = `Saved to ${target.name} · just now`; } } catch (e) { fail(e); }
    }, 700);
  };
  const draw = () => {
    save();
    const m = dealModel(d), c = d.cur;
    const stress = dealModel(d, d.ebitda * 0.8, d.multiple), maxX = maxMultiple(d);
    ELEMENTS.forEach((e) => { const o = $(`[data-o="${e.k}"]`); if (o) o.textContent = `${d[e.k].pct}%`; });
    const issues = [];
    if (!m.complete) issues.push(m.allocated < 100 ? `${100 - m.allocated}% of the price isn't funded yet` : `You've funded ${m.allocated}% of the price; bring it back to 100%`);
    if (!m.control) issues.push(`You'd hold ${pct(m.yourVotes)} of the votes; you need over 50%. Make the rollover/investor shares non-voting or give less equity away`);
    if (!m.bankable) issues.push(`The weakest year covers debt only ${m.minDscr.toFixed(2)}×. Stretch the terms, add a holiday, lower the price, or move some of it into rollover`);
    const maxRow = Math.max(...m.years.map((y) => y.service), 1);
    $("#br").innerHTML = `
      <div class="verdict ${m.works ? "ok" : "no"}"><b>${m.works ? "✓ This deal works" : "✕ Not yet"}</b>
        <span>${m.works ? `You keep control and the business carries every repayment with room to spare. ${m.cashFromYou ? `You put in ${money(m.cashFromYou, c)}.` : "No money down."}` : issues.join(". ") + "."}</span></div>
      <div class="kpis four">
        <div class="kpi"><span>Price</span><b>${money(m.price, c)}</b><small>${d.multiple}× ${money(d.ebitda, c)}</small></div>
        <div class="kpi ${m.control ? "" : "warnk"}"><span>Your control</span><b>${pct(m.yourVotes)}</b><small>of the votes · ${pct(m.yourEconomic)} of profits</small></div>
        <div class="kpi ${m.bankable ? "" : "warnk"}"><span>Weakest-year DSCR</span><b>${m.minDscr ? m.minDscr.toFixed(2) + "×" : "–"}</b><small>needs 1.5× or more</small></div>
        <div class="kpi accent"><span>Your cash in</span><b>${money(m.cashFromYou, c)}</b><small>${m.cashFromYou ? "by choice" : "no money down"}</small></div>
      </div>
      <div class="insights">
        <div><span>Bad year (EBITDA −20%)</span><b class="${!stress.minDscr || stress.minDscr >= 1.5 ? "tone-ok" : stress.minDscr >= 1.2 ? "tone-warn" : "tone-bad"}">${stress.minDscr ? stress.minDscr.toFixed(2) + "× DSCR" : "no debt"}</b><small>${!stress.minDscr || stress.minDscr >= 1.2 ? "still pays every lender" : "the debt would bite: build in a holiday or longer terms"}</small></div>
        <div><span>Most this stack can pay</span><b>${maxX ? `${maxX}× · ${money(maxX * d.ebitda, c)}` : "–"}</b><small>at 1.5× in the weakest year</small></div>
        <div><span>Seller at closing</span><b>${money(m.cashAtClose, c)}</b><small>${m.amt.vf ? `then ${money((m.years[1]?.vf ?? m.years[0].vf) / 12, c)}/month on the note` : "no note"}</small></div>
      </div>
      <div class="panel">
        <h2 class="h3">Capital stack</h2>
        <div class="stackbar" role="img" aria-label="Capital stack: ${ELEMENTS.filter((e) => m.amt[e.k] > 0).map((e) => `${e.label} ${d[e.k].pct}%`).join(", ")}">${ELEMENTS.map((e, i) => m.amt[e.k] > 0 ? `<span style="width:${(100 * m.amt[e.k]) / Math.max(m.price, 1)}%;background:var(--s${i + 1})" title="${e.label}: ${money(m.amt[e.k], c)}">${d[e.k].pct >= 12 ? `${e.short} ${d[e.k].pct}%` : ""}</span>` : "").join("")}</div>
        <div class="table-wrap"><table class="stack-table"><tbody>${ELEMENTS.map((e, i) => `<tr class="${m.amt[e.k] > 0 ? "" : "dim"}"><td><i style="background:var(--s${i + 1})"></i>${e.label}</td><td>${d[e.k].pct}%</td><td>${money(m.amt[e.k], c)}</td><td class="muted">${
          e.k === "vf" ? (m.amt.vf ? `paid to the seller over ${d.vf.years} yrs` : "")
          : e.k === "bank" ? (m.amt.bank ? "cash to seller at close" : "")
          : e.k === "roll" ? (m.amt.roll ? `seller keeps ${d.roll.pct}% of the company` : "")
          : e.k === "inv" ? (m.amt.inv ? `investors own ${d.inv.stake}%` : "") : (m.amt.own ? "from your pocket" : "")}</td></tr>`).join("")}</tbody></table></div>
      </div>
      <div class="panel">
        <h2 class="h3">Debt cover, year by year</h2>
        <div class="table-wrap"><table class="years"><thead><tr><th>Year</th><th>Seller note</th><th>Bank</th><th class="bar-col">Total debt service</th><th>DSCR</th></tr></thead>
        <tbody>${m.years.map((y) => `<tr title="Year ${y.y}: ${money(y.service, c)} debt service vs ${money(m.fcf, c)} free cash flow">
          <td>${y.y}</td><td>${money(y.vf, c)}</td><td>${money(y.bank, c)}</td>
          <td class="bar-col"><div class="bar-cell"><div class="bar"><span style="width:${(100 * y.service) / maxRow}%"></span></div><b>${money(y.service, c)}</b></div></td>
          <td>${y.dscr == null ? "–" : `<span class="${y.dscr >= 1.5 ? "tone-ok" : y.dscr >= 1.2 ? "tone-warn" : "tone-bad"}">${y.dscr.toFixed(2)}×</span>`}</td></tr>`).join("")}</tbody></table></div>
        <p class="muted small">Free cash flow ${money(m.fcf, c)} a year. Indicative, not advice: get your accountant and lender to check the real numbers.</p>
      </div>
      <div class="ask-josh"><p>${target ? `Ready to put this in front of ${esc(target.owner_name || "the owner")}?` : "Want Josh to pressure-test this structure?"}</p>
        <div class="row">
          <button class="ghost" id="copyDeal" type="button">Copy summary</button>
          ${target ? `<button class="ghost" id="writeLoi" type="button">Write the LOI →</button>` : ""}
          <button class="primary" id="askDeal" type="button">Ask Josh about this deal →</button>
        </div></div>`;
    $("#askDeal").addEventListener("click", () => askJoshAbout(`Pressure-test this deal structure${target ? ` for ${target.name}` : ""}. ${structureSummary(d, m)} What would you change, and how would you pitch it to the seller?`, target?.id));
    $("#copyDeal").addEventListener("click", () => copy(structureSummary(d, m), "Summary copied"));
    $("#writeLoi")?.addEventListener("click", async (e) => {
      e.currentTarget.disabled = true; e.currentTarget.textContent = "Writing the LOI…";
      try { clearTimeout(saveT); await post(`/api/targets/${target.id}`, { deal: d }, "PATCH"); const doc = await post("/api/documents/generate", { kind: "loi", target_id: target.id }); location.hash = `#/desk/${doc.id}`; }
      catch (err) { fail(err); e.currentTarget.disabled = false; e.currentTarget.textContent = "Write the LOI →"; }
    });
  };
  const set = (path, val) => { const [a, b] = path.split("."); if (b) d[a][b] = val; else d[a] = val; };
  $("#bf").addEventListener("input", (e) => {
    const el = e.target; if (!el.dataset.p) return;
    if (el.type !== "checkbox" && el.value === "") return; // let people clear a field while typing
    set(el.dataset.p, el.type === "checkbox" ? el.checked : Number(el.value));
    if (el.dataset.p === "inv.pct" && !d.inv.stake) d.inv.stake = d.inv.pct;
    draw();
  });
  $$("#cur button").forEach((b) => b.addEventListener("click", () => { d.cur = b.dataset.c; $$("#cur button").forEach((y) => { y.classList.toggle("on", y === b); y.setAttribute("aria-pressed", y === b); }); draw(); }));
  // Redraw the form (inputs change), saving first so the reload sees the new structure.
  const rerender = async () => {
    clearTimeout(saveT);
    if (target) { try { await post(`/api/targets/${target.id}`, { deal: d }, "PATCH"); } catch (e) { fail(e); return; } }
    else synced.set("deal", d);
    renderBuilder(seq, params);
  };
  $("#fillGap").addEventListener("click", () => {
    const other = ELEMENTS.filter((e) => e.k !== "vf").reduce((t, e) => t + d[e.k].pct, 0);
    d.vf.pct = Math.max(0, 100 - other); rerender();
  });
  $$("[data-preset]").forEach((b) => b.addEventListener("click", () => { Object.assign(d, JSON.parse(JSON.stringify(PRESETS[b.dataset.preset].set))); rerender(); toast(`${PRESETS[b.dataset.preset].name} loaded`); }));
  draw();
}
