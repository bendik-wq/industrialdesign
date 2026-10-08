import { esc, view, session } from "../core.js";

const BETS = [
  { t: "Josh knows your deals", s: "live", d: "Josh sees your pipeline, your profile and the target you're talking about, so his push is about your real owners, your real numbers and the next action you're avoiding." },
  { t: "Practise the real owner", s: "live", d: "Turn any target into a practice call: the AI plays that owner, with hidden motives built from what you know about them. Rehearse the call before you dial." },
  { t: "Your own AI, no limits", s: "live", d: "Connect your own Anthropic and ElevenLabs keys and every agent runs on them: Claude with all of Josh's videos in context, your chosen voice, no daily cap." },
  { t: "Plugs into your stack", s: "live", d: "API tokens and signed webhooks: push targets in from your CRM or scraper, send stage changes to Zapier, Make or Slack." },
  { t: "Josh on the live call", s: "next", d: "With everyone's consent, Josh listens to real seller calls and whispers the next question on screen, then writes the notes and next steps automatically." },
  { t: "Sellers come to you", s: "next", d: "A 'what is my business worth' page for your territory. Local owners value their company and land in your pipeline: off-market deals on autopilot." },
];

export function renderAgents() {
  const live = session.team.agents.filter((a) => a.status === "live").length;
  view().innerHTML = `
    <header class="page-head"><p class="eyebrow">Units</p><h1>One team, from first call to the 100-day plan.</h1>
      <p class="lede">${live} units are active. The rest are being built in the order the 3C model needs them: Capabilities, Capital, Closing.</p></header>
    <div class="agent-grid">${session.team.agents.map((a) => `
      <article class="agent ${a.status}">
        <header><span class="ico" aria-hidden="true">${esc(a.icon)}</span><div><h2 class="h3">${esc(a.name)}</h2><small>${esc(a.tag)}</small></div><span class="badge ${a.status}">${a.status === "live" ? "Active" : "Training"}</span></header>
        <p>${esc(a.blurb)}</p>
        <ul>${a.jobs.map((j) => `<li>${esc(j)}</li>`).join("")}</ul>
        ${a.status === "live" ? `<a class="primary" href="#/${a.route || a.id}">${a.route === "pipeline" ? "Use it on a target" : "Open"}</a>` : ""}
      </article>`).join("")}</div>
    <h2 class="sub">What makes this different</h2>
    <div class="bets">${BETS.map((b) => `<div class="bet"><span class="badge ${b.s === "live" ? "live" : "soon"}">${b.s === "live" ? "Live" : "Next"}</span><h3>${esc(b.t)}</h3><p>${esc(b.d)}</p></div>`).join("")}</div>`;
}
