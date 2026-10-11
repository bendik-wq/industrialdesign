// The seller's private link: accept the NDA, upload what the buyer asked for. No account; the token in the URL is
// the key. Only the lines the buyer marked for the seller are shown, never the buyer's notes.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const token = location.pathname.split("/").pop();
const base = `/hooks/room/${encodeURIComponent(token)}`;
const kb = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const app = $("#app");

async function load() {
  const res = await fetch(base);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { app.innerHTML = `<h1>Link not available</h1><p class="muted">${esc(d.error || "This link isn't valid.")}</p>`; return; }
  document.title = `${d.business} · documents for ${d.buyer}`;
  const ndaItem = d.items.find((i) => /^NDA/i.test(i.title));
  const others = d.items.filter((i) => i !== ndaItem);
  const done = others.filter((i) => ["received", "done"].includes(i.status)).length;
  app.innerHTML = `
    <p class="eyebrow">${esc(d.buyer)}</p>
    <h1>${esc(d.business)}</h1>
    <p>Thanks for taking the time. This page is private to you. Accept the NDA first, then add each document below whenever it suits. Everything you send stays confidential under the NDA.</p>
    ${ndaItem ? `<section class="panel"><h2 class="h3">1. Non-disclosure agreement</h2>
      ${ndaItem.files.filter((f) => !f.mine).map((f) => `<p><a href="${base}/files/${f.id}" download>Download the NDA (${esc(f.name)})</a></p>`).join("")}
      ${d.nda ? `<p class="tone-ok">Accepted by ${esc(d.nda.name)} on ${new Date(d.nda.at).toLocaleDateString()}.</p>` : `<form id="nda" class="stack">
        <label>Your full name<input name="name" required minlength="3" maxlength="120" autocomplete="name"></label>
        <label class="check"><input type="checkbox" name="agree" required> I have read the NDA and agree to its terms</label>
        <button class="primary" type="submit">Accept the NDA</button><p class="error" hidden></p></form>
        <p class="muted small">Prefer to sign a copy? Upload the signed NDA here instead.</p>${ndaItem.upload ? uploader(ndaItem) : ""}`}</section>` : ""}
    <section class="panel"><div class="panel-head"><h2 class="h3">${ndaItem ? "2. " : ""}Documents</h2><span class="muted small">${done} of ${others.length} sent</span></div>
      ${!d.nda && ndaItem ? `<p class="muted">Accept the NDA above to upload documents.</p>` : ""}
      <ul class="seller-items">${others.map((i) => `<li class="${["received", "done"].includes(i.status) ? "got" : ""}"><div><b>${["received", "done"].includes(i.status) ? "✓ " : ""}${esc(i.title)}</b>
        ${i.files.map((f) => f.mine ? `<small class="muted">Sent: ${esc(f.name)} · ${kb(f.size)}</small>` : `<small><a href="${base}/files/${f.id}" download>${esc(f.name)}</a></small>`).join("")}</div>
        ${i.upload && (d.nda || !ndaItem) ? uploader(i) : ""}</li>`).join("")}</ul>
      <p class="muted small">PDF, Excel, CSV, Word or photos, up to ${d.maxMb} MB each. Three years of statements can go up one year at a time.</p></section>`;
  $("#nda")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target, err = $(".error", f);
    const res = await fetch(`${base}/nda`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: f.name.value, agree: f.agree.checked }) });
    if (res.ok) return load();
    err.hidden = false; err.textContent = (await res.json().catch(() => ({}))).error || "That didn't work. Try again.";
  });
  app.querySelectorAll("input[type=file][data-item]").forEach((inp) => inp.addEventListener("change", () => send(inp)));
}

const uploader = (i) => `<label class="ghost upl">Add file<input type="file" data-item="${i.id}" accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.png,.jpg,.jpeg,.txt" multiple hidden></label>`;

async function send(inp) {
  const label = inp.closest("label");
  for (const file of inp.files) {
    label.firstChild.textContent = `Uploading ${file.name}…`;
    const fd = new FormData(); fd.append("item", inp.dataset.item); fd.append("file", file);
    const res = await fetch(`${base}/upload`, { method: "POST", body: fd });
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error || `Couldn't upload ${file.name}`); break; }
  }
  load();
}

load();
