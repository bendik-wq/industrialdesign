const token = new URLSearchParams(location.search).get("t") || "";
const $ = (id) => document.getElementById(id);
let invite = null;
fetch(`/api/invites/${encodeURIComponent(token)}`).then(async (r) => {
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { $("h").textContent = "This link doesn't work."; $("sub").textContent = d.error || "Ask for a new invite."; return; }
  invite = d;
  $("sub").textContent = `${d.inviter ? `${d.inviter} invited you` : "You've been invited"} to ${d.account} as ${d.role === "owner" ? "an owner" : "a member"}.`;
  if (d.email) { $("email").value = d.email; $("email").readOnly = true; }
  $("f").hidden = false;
  $("name").focus();
}).catch(() => { $("sub").textContent = "Couldn't reach Warplan. Check your connection and reload."; });

$("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("err").hidden = true;
  $("go").disabled = true;
  const res = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: $("name").value, email: $("email").value, password: $("pw").value }),
  });
  if (res.ok) { location.href = "/"; return; }
  const d = await res.json().catch(() => ({}));
  $("err").textContent = d.error || "That didn't work.";
  $("err").hidden = false;
  $("go").disabled = false;
});
