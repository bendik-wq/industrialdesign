    const v = document.getElementById("vsl"), play = document.getElementById("play");
    play.addEventListener("click", () => { v.muted = false; v.play(); });
    v.addEventListener("play", () => { play.hidden = true; });
    const f = document.getElementById("app"), err = document.getElementById("err"), btn = document.getElementById("submit");
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      err.hidden = true;
      if (!f.checkValidity()) { err.textContent = "Please fill in your name, business, email, mobile, trading status and tick the consent box."; err.hidden = false; return; }
      btn.disabled = true; btn.textContent = "Sending…";
      const data = Object.fromEntries(new FormData(f));
      data.watched = Math.round(v.currentTime || 0);
      data.turnstile = (f.querySelector("[name='cf-turnstile-response']") || {}).value || "";
      data.source = new URLSearchParams(location.search).get("utm_source") || document.referrer || "";
      try {
        const r = await fetch("/api/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Something went wrong. Please try again.");
        f.hidden = true; document.getElementById("done").hidden = false;
      } catch (x) {
        err.textContent = x.message; err.hidden = false; btn.disabled = false; btn.textContent = "Submit my application"; if (window.turnstile) window.turnstile.reset();
      }
    });
