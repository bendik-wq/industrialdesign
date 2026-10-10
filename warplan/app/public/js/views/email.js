import { $, esc, api, post, toast, fail, dialog } from "../core.js";

// Split "Subject: ...\n\nbody" (how the Outreach agent writes emails) into its parts.
export function splitEmail(text) {
  const m = String(text || "").match(/^\s*\**subject\**\s*:\s*(.+)\n+([\s\S]*)$/i);
  return m ? { subject: m[1].replace(/\*+/g, "").trim(), body: m[2].trim() } : { subject: "", body: String(text || "").trim() };
}

// Compose and send from the user's own mailbox. Resolves true when sent.
export async function composeEmail({ target = null, contacts = [], to = "", subject = "", body = "" } = {}) {
  const box = await api("/api/mailbox").catch(() => ({ connected: false }));
  if (!box.connected) {
    await dialog({ title: "Connect your mailbox first", submit: "", html: `<p>Emails go out from your own address, so they land in your Sent folder and replies come straight back to you.</p><p><a class="primary" href="#/settings/email">Connect your mailbox →</a></p>` });
    return false;
  }
  const emails = contacts.filter((c) => c.kind === "email");
  const best = to || emails.find((c) => c.label?.includes("(owner)") && c.confidence !== "guess")?.value || target?.email || emails[0]?.value || "";
  const r = await dialog({
    title: target ? `Email ${target.owner_name || target.name}` : "New email", submit: "Send", wide: true,
    html: `<div class="two"><label class="field">From<input value="${esc(box.from_name ? `${box.from_name} <${box.email}>` : box.email)}" disabled></label>
        <label class="field">To<input name="to" type="email" required value="${esc(best)}" list="toList" autocomplete="off"></label></div>
      <datalist id="toList">${emails.map((c) => `<option value="${esc(c.value)}">${esc(c.label)}${c.confidence === "guess" ? " · guess" : ""}</option>`).join("")}</datalist>
      ${emails.some((c) => c.value === best && c.confidence === "guess") ? `<p class="notice small">That address is a guess from the owner's name. It may bounce: a verified one (Hunter, or the website) is safer.</p>` : ""}
      <label class="field">Subject<input name="subject" required maxlength="200" value="${esc(subject)}"></label>
      <label class="field">Message<textarea name="body" rows="12" required>${esc(body)}</textarea></label>
      <div class="row compose-tools">${target ? `<button type="button" class="ghost" data-write>✎ Write it for me</button>` : ""}<span class="muted small">Your signature${box.postal_address ? ", postal address" : ""} and a one-line opt-out are added automatically. ${box.sentToday}/${box.daily_limit} sent today.</span></div>`,
    onOpen: (d) => {
      d.querySelector("[data-write]")?.addEventListener("click", async (e) => {
        const b = e.currentTarget;
        b.disabled = true; b.textContent = "Writing…";
        try {
          const doc = await post("/api/documents/generate", { kind: "outreach", channel: "email", target_id: target.id });
          const parts = splitEmail(doc.content);
          if (parts.subject) d.querySelector("[name=subject]").value = parts.subject;
          d.querySelector("[name=body]").value = parts.body;
        } catch (err) { fail(err); }
        b.disabled = false; b.textContent = "✎ Rewrite";
      });
    },
  });
  if (!r) return false;
  try {
    const out = await post("/api/email/send", { to: r.to, subject: r.subject, body: r.body, target_id: target?.id });
    toast(out.receipt || "Sent");
    return true;
  } catch (e) { fail(e); return false; }
}
