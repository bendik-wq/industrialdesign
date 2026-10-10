import { $, esc, api, post, toast, fail, dialog } from "../core.js";
import { STAGES } from "../deal.js";

// Push targets into an Instantly / Smartlead / EmailBison campaign. `targets` = candidates (one or many).
export async function pushDialog(targets) {
  let seq;
  try { seq = await api("/api/sequencers"); } catch (e) { fail(e); return; }
  const connected = seq.sequencers.filter((s) => s.connected);
  if (!connected.length) {
    await dialog({ title: "Connect a sequencer", html: `<p>Connect Instantly, Smartlead or EmailBison under <a href="#/settings/integrations">Settings → Integrations</a>, then push targets straight into a campaign. Replies come back onto each target's timeline, read and sorted by the AI.</p>`, submit: "" });
    return;
  }
  const many = targets.length > 1;
  const stages = [...new Set(targets.map((t) => t.stage))];
  const names = {};
  const result = await dialog({
    title: many ? "Push targets to a campaign" : `Push ${targets[0].name} to a campaign`, wide: true, submit: "Push",
    html: `<div class="form-grid">
      <label class="field">Sequencer<select name="provider">${connected.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join("")}</select></label>
      <label class="field">Campaign<select name="campaign_id" required><option value="">Loading…</option></select></label>
      ${many ? `<label class="field">Which targets<select name="stage"><option value="">All ${targets.length} shown</option>${STAGES.filter((s) => stages.includes(s.id)).map((s) => `<option value="${s.id}">${s.label} (${targets.filter((t) => t.stage === s.id).length})</option>`).join("")}</select></label>` : ""}
      </div>
      <label class="check"><input type="checkbox" name="personalize" checked> Write a personal opening line for each owner (merge field <code>{{personalization}}</code>)</label>
      <p class="muted small">Uses each target's best real owner email (never a guessed one) and skips anyone who opted out. Targets without an email are skipped: run <b>Find contacts</b> or <b>Deep enrich</b> first. Sourced targets move to Contacted.</p>`,
    onOpen: (d) => {
      const prov = $("[name=provider]", d), camp = $("[name=campaign_id]", d);
      const load = async () => {
        camp.innerHTML = `<option value="">Loading…</option>`;
        try {
          const r = await api(`/api/sequencers/${prov.value}/campaigns`);
          r.campaigns.forEach((c) => { names[c.id] = c.name; });
          camp.innerHTML = r.campaigns.length ? r.campaigns.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.status ? ` · ${esc(c.status)}` : ""}</option>`).join("") : `<option value="">No campaigns: create one in the sequencer first</option>`;
        } catch (e) { camp.innerHTML = `<option value="">${esc(e.message)}</option>`; }
      };
      prov.addEventListener("change", load); load();
    },
  });
  if (!result?.campaign_id) return;
  const picked = targets.filter((t) => !result.stage || t.stage === result.stage);
  toast(`Pushing ${picked.length} target${picked.length === 1 ? "" : "s"}…`);
  try {
    const r = await post("/api/sequencers/push", { provider: result.provider, campaign_id: result.campaign_id, campaign_name: names[result.campaign_id] || "", target_ids: picked.map((t) => t.id).slice(0, 200), personalize: result.personalize });
    toast(r.receipt);
    if (r.failed?.length) toast(`${r.failed.length} failed: ${r.failed[0].error}`, "error");
    return r;
  } catch (e) { fail(e); }
}

// Run the paid Monid waterfall on one target, with the price up front.
export async function deepEnrichDialog(t) {
  const r = await dialog({
    title: `Deep enrich ${t.name}`, submit: "Run it",
    html: `<p>Finds the owner's email (and checks it won't bounce), every published address on the domain with names and titles, and the owner's LinkedIn, through the Monid data marketplace.</p>
      <p class="muted small">Typically $0.05–0.08 from your Monid wallet, charged only for what's found. ${t.website ? "" : "No website on file: it looks the company up on Google Maps first."}</p>
      <label class="check"><input type="checkbox" name="mobile"> Also find the owner's mobile number (about $0.57, only charged if one is found)</label>`,
  });
  if (!r) return null;
  toast("Enriching… this takes 10–40 seconds");
  try { const out = await post(`/api/targets/${t.id}/enrich`, { mobile: r.mobile }); toast(out.receipt); return out; }
  catch (e) { fail(e); return null; }
}
