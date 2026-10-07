const token = new URLSearchParams(location.search).get("t") || "";
const $ = (id) => document.getElementById(id);
fetch(`/api/invites/${encodeURIComponent(token)}`).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { $("title").textContent = "This invite doesn't work."; $("sub").textContent = d.error || "Ask for a new link."; return; }
  $("title").textContent = `Join ${d.account} on Dealflow.`;
  $("sub").textContent = d.role === "owner" ? "You'll be an owner of this account: you can claim territories and invite your team." : "You'll share the account's territories, pipeline and agents.";
  if (d.email) { $("email").value = d.email; $("email").readOnly = true; }
  $("f").hidden = false;
  $("name").focus();
});
$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("err").hidden = true;
  const r = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("name").value, email: $("email").value, password: $("pw").value }),
  });
  if (r.ok) { location.href = "/#/territories"; return; }
  const d = await r.json().catch(() => ({}));
  $("err").textContent = d.error || "That didn't work."; $("err").hidden = false;
});
