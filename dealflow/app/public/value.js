import { money } from "/deal.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
let current = null;

const PH = { no: "Organisation number (9 digits)", fr: "SIREN (9 digits)" };
document.querySelectorAll('input[name="country"]').forEach((r) => r.addEventListener("change", () => ($("#number").placeholder = PH[r.value])));

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong. Please try again.");
  return data;
}

$("#lookup").addEventListener("submit", async (e) => {
  e.preventDefault();
  const country = new FormData(e.target).get("country");
  const number = $("#number").value;
  $("#err").textContent = "";
  $("#go").disabled = true;
  $("#go").textContent = "Reading your accounts…";
  try {
    const v = await post("/api/public/valuation", { country, number });
    current = { country, number };
    show(v);
  } catch (err) {
    $("#err").textContent = err.message;
  } finally {
    $("#go").disabled = false;
    $("#go").textContent = "Value my company";
  }
});

function show(v) {
  $("#rCompany").textContent = [v.name, v.city].filter(Boolean).join(" · ");
  if (v.valuation) {
    $("#rRange").textContent = `${money(v.valuation.low, v.currency)} – ${money(v.valuation.high, v.currency)}`;
    $("#rBand").style.width = "100%";
    $("#rBasis").textContent = `Based on ${v.valuation.basis.toLowerCase()}, at ${v.valuation.multiple.join("–")}× earnings for ${v.industry ? v.industry.toLowerCase() : "comparable"} companies.`;
  } else {
    $("#rRange").textContent = "We need a little more information";
    $("#rBand").style.width = "0";
    $("#rBasis").textContent = "Your latest accounts aren't public yet, so we can't compute a range automatically. Leave your details and we'll do it with you.";
  }
  const facts = [
    ["Founded", v.founded], ["Staff", v.staff],
    ["Revenue", v.revenue ? `${money(v.revenue, v.currency)} (${v.revenueYear})` : null],
    ["Operating profit", v.ebit != null ? money(v.ebit, v.currency) : null],
  ].filter(([, x]) => x != null && x !== "");
  $("#rFacts").innerHTML = facts.map(([k, x]) => `<div><dt>${esc(k)}</dt><dd>${esc(x)}</dd></div>`).join("");
  $("#step1").hidden = true;
  $("#result").hidden = false;
  $("#lead").hidden = false;
  $("#thanks").hidden = true;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$("#lead").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#leadErr").textContent = "";
  const f = Object.fromEntries(new FormData(e.target));
  try {
    await post("/api/public/lead", { ...current, ...f });
    $("#lead").hidden = true;
    $("#thanks").hidden = false;
  } catch (err) {
    $("#leadErr").textContent = err.message;
  }
});

$("#again").addEventListener("click", () => {
  $("#result").hidden = true;
  $("#step1").hidden = false;
  $("#number").value = "";
  $("#number").focus();
});
