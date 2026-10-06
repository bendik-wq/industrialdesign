let setup = false;
fetch("/api/auth/state").then((r) => r.json()).then((s) => {
  if (!s.needsSetup) return;
  setup = true;
  document.getElementById("setupFields").hidden = false;
  document.getElementById("key").required = true;
  document.getElementById("pw").autocomplete = "new-password";
  document.getElementById("go").textContent = "Create admin login";
}).catch(() => {});

document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = document.getElementById("err");
  const v = (id) => document.getElementById(id).value;
  err.hidden = true;
  const res = await fetch(setup ? "/api/setup" : "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(setup ? { setupKey: v("key"), name: v("name"), email: v("email"), password: v("pw") } : { email: v("email"), password: v("pw") }),
  });
  if (res.ok) { location.href = "/"; return; }
  const d = await res.json().catch(() => ({}));
  err.textContent = d.error || "That didn't work.";
  err.hidden = false;
});
