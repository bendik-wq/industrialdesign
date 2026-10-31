// Buyers directory: lower-middle and middle-market private equity firms, the same list in every workspace. Filter
// by segment, country and sector, open each firm's own site and criteria, and shop a business to them with a bot.
import { $, $$, esc, api, view, stale, session, skeleton } from "../core.js";

const NAMES = { AU: "Australia", NZ: "New Zealand", US: "United States", CA: "Canada", GB: "United Kingdom", IE: "Ireland", NO: "Norway", SE: "Sweden", DK: "Denmark", FI: "Finland", DE: "Germany", NL: "Netherlands", FR: "France" };
const SEG = { lmm: "Lower middle market", mm: "Middle market" };

export async function renderBuyers(seq, params) {
  view().innerHTML = skeleton(4);
  const q = { segment: params.get("segment") || "", country: params.get("country") || "", q: params.get("q") || "" };
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  const d = await api(`/api/buyers${qs ? `?${qs}` : ""}`);
  if (stale(seq)) return;
  const owner = !!session.me?.isOwner;
  const shop = new URLSearchParams({ new: "sell" });
  if (q.segment) shop.append("segment", q.segment);
  if (q.country) shop.append("country", q.country);
  if (q.q) shop.set("q", q.q);
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow">Deals · Exit</p><h1>Buyers directory</h1>
        <p class="lede">${d.total} private equity firms that buy lower-middle and middle-market businesses, each checked against its own website. Selling a business? Pick the buyers and let a bot shop it to them for the best price.</p></div>
      ${owner ? `<div class="head-actions"><a class="primary" href="#/bots?${shop}">Shop my business to these buyers</a></div>` : ""}
    </header>
    <form class="toolbar" id="bf">
      <input type="search" name="q" placeholder="Search name, city or sector (e.g. healthcare)" value="${esc(q.q)}" aria-label="Search buyers">
      <select name="segment" aria-label="Segment"><option value="">All segments</option>${Object.entries(SEG).map(([k, l]) => `<option value="${k}" ${k === q.segment ? "selected" : ""}>${l}</option>`).join("")}</select>
      <select name="country" aria-label="Country"><option value="">All countries</option>${d.countries.map((c) => `<option value="${c}" ${c === q.country ? "selected" : ""}>${esc(NAMES[c] || c)}</option>`).join("")}</select>
      <span class="spacer"></span><span class="muted small">${d.funds.length} shown</span>
    </form>
    ${!d.funds.length ? `<div class="empty"><h2>No buyers match</h2><p class="muted">${d.total ? "Try another country or a broader sector." : "The directory is being filled. Check back shortly."}</p></div>` : `
    <div class="table-wrap panel flush"><table class="ttable buyers-table"><thead><tr><th>Firm</th><th>Segment</th><th>Size they buy</th><th>Sectors</th><th></th></tr></thead><tbody>
      ${d.funds.map((f) => `<tr>
        <td><a href="${esc(f.website)}" target="_blank" rel="noopener noreferrer"><b>${esc(f.name)}</b></a><small class="muted block">${esc([f.hq_city, NAMES[f.hq_country] || f.hq_country].filter(Boolean).join(", "))}${(f.regions || []).length > 1 ? ` · invests in ${esc(f.regions.map((r) => NAMES[r] || r).join(", "))}` : ""}</small></td>
        <td><span class="chip">${SEG[f.segment]}</span></td>
        <td class="small">${esc(f.size || "Not published")}</td>
        <td class="small">${esc((f.sectors || []).join(", "))}${(f.deal_types || []).length ? `<small class="muted block">${esc(f.deal_types.join(", "))}</small>` : ""}</td>
        <td class="small">${f.contacted ? `<span class="chip st-active">Contacted · ${f.contacted.step} email${f.contacted.step === 1 ? "" : "s"}</span>` : ""}${f.criteria_url ? `<a href="${esc(f.criteria_url)}" target="_blank" rel="noopener noreferrer">Criteria</a> ` : ""}${f.contact_url ? `<a href="${esc(f.contact_url)}" target="_blank" rel="noopener noreferrer">Contact</a>` : ""}</td>
      </tr>`).join("")}</tbody></table></div>`}
    <p class="muted small">Size ranges and sectors are what each firm publishes. Contact details come from each firm's own website when a bot emails them.</p>`;
  let t;
  const go = () => { const v = Object.fromEntries(new FormData($("#bf"))); const p = new URLSearchParams(Object.entries(v).filter(([, x]) => x)); history.replaceState(null, "", `#/buyers${p.toString() ? `?${p}` : ""}`); renderBuyers(++session.seq, p); };
  $("#bf").addEventListener("submit", (e) => { e.preventDefault(); go(); });
  $$("#bf select").forEach((s) => s.addEventListener("change", go));
  $("#bf input[name=q]").addEventListener("input", () => { clearTimeout(t); t = setTimeout(go, 350); });
}
