import { $, esc, api, view, session, stale, synced, micButton, MIC, when, dateLabel, skeleton } from "../core.js";
import { dealModel, ladderModel, LADDER_DEFAULTS, money } from "../deal.js";
import { loadDeal } from "./builder.js";
import { askJoshAbout } from "./josh.js";
import { addTarget } from "./pipeline.js";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export async function renderHome(seq) {
  view().innerHTML = skeleton(6);
  const h = await api("/api/home");
  if (stale(seq)) return;
  const me = session.me, brain = session.team.brain;
  const first = (me.user.name || "").split(" ")[0];
  const profile = synced.get("profile", {}) || {};
  const deal = dealModel(loadDeal());
  const L = ladderModel({ ...LADDER_DEFAULTS, ...synced.get("ladder", {}) }, loadDeal());
  const steps = [
    { done: !!(profile.company || profile.about), label: "Tell the agents who you are", href: "#/settings/profile" },
    { done: h.total > 0, label: "Add your first targets (aim for ten)", action: "add" },
    { done: h.practice.calls > 0, label: "Practise a first call with an AI owner", href: "#/simulator" },
    { done: !!synced.get("deal", null), label: "Structure a deal that passes both rules", href: "#/builder" },
    ...(me.isOwner ? [{ done: brain.kind === "claude", label: "Connect Claude for Josh's full brain", href: "#/settings/integrations" }] : []),
  ];
  const left = steps.filter((s) => !s.done).length;
  const live = h.stages.filter((s) => s.id !== "lost" && s.id !== "closed");
  const maxN = Math.max(1, ...live.map((s) => s.n));
  const scores = h.practice.scores;
  view().innerHTML = `
    <section class="hero">
      <p class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p>
      <h1>${greeting()}${first ? `, ${esc(first)}` : ""}.<br><em>${h.due.some((d) => d.overdue) ? "You've got calls to make." : h.total ? "Keep the pipeline moving." : "Let's find your first deal."}</em></h1>
      <div class="ask">
        <button class="mic big" id="homeMic" type="button" aria-label="Talk to Josh">${MIC}</button>
        <input id="homeAsk" placeholder="Ask Josh anything, e.g. “Which target should I push this week?”" autocomplete="off" aria-label="Ask Josh">
        <button class="primary" id="homeGo" type="button">Ask</button>
      </div>
    </section>

    ${left ? `<section class="panel onboarding">
      <div class="panel-head"><h2 class="h3">Get set up</h2><span class="muted small">${steps.length - left} of ${steps.length} done</span></div>
      <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${steps.length}" aria-valuenow="${steps.length - left}"><span style="width:${(100 * (steps.length - left)) / steps.length}%"></span></div>
      <ol class="checklist">${steps.map((s, i) => `<li class="${s.done ? "done" : ""}">${s.done ? `<span class="tick">✓</span>${esc(s.label)}` : s.action ? `<span class="num">${i + 1}</span><button class="link-btn" data-act="${s.action}" type="button">${esc(s.label)} →</button>` : `<span class="num">${i + 1}</span><a href="${s.href}">${esc(s.label)} →</a>`}</li>`).join("")}</ol>
    </section>` : ""}

    <div class="home-grid">
      <section class="panel">
        <div class="panel-head"><h2 class="h3">Next actions</h2><a class="small" href="#/pipeline">Pipeline →</a></div>
        ${h.due.length ? `<ul class="due-list">${h.due.map((d) => `<li class="${d.overdue ? "late" : ""}"><a href="#/targets/${d.id}"><b>${esc(d.next_action || "Next step")}</b><small>${esc(d.name)} · ${d.overdue ? "overdue · " : ""}${dateLabel(d.next_date)}</small></a></li>`).join("")}</ul>`
          : `<p class="muted small">${h.total ? "Nothing due this week. Every live target should have a next action with a date: open one and set it." : "Add a target and give it a next action. This list becomes your day."}</p>`}
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="h3">Pipeline</h2><span class="muted small">${h.total} live · weighted ${money(h.weighted)}</span></div>
        <div class="funnel">${live.map((s) => `<a href="#/pipeline" class="frow"><span>${s.label}</span><i style="width:${Math.max(2, (100 * s.n) / maxN)}%"></i><b>${s.n}</b></a>`).join("")}</div>
        ${h.total < 20 ? `<p class="muted small">${h.total ? `${20 - h.total} more targets to reach 20 at the top. Volume wins.` : "Start with ten names: competitors, suppliers, the business next door."} <button class="link-btn" data-act="add" type="button">Add a target →</button></p>` : ""}
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="h3">Call practice</h2><a class="small" href="#/simulator">Practise →</a></div>
        ${scores.length ? `<div class="practice"><b>${scores[scores.length - 1].score}<small>/100 last call</small></b><div class="spark" aria-label="Recent scores">${scores.map((s) => `<i style="height:${Math.max(6, s.score)}%" title="${s.score}/100"></i>`).join("")}</div></div><p class="muted small">${h.practice.thisWeek} practice call${h.practice.thisWeek === 1 ? "" : "s"} this week.</p>`
          : `<p class="muted small">${h.practice.calls ? "Finish a call and get Josh's debrief to see your score." : "Nobody's good on the first call by luck. Ten practice calls and you'll hear the difference."}</p>`}
      </section>

      <section class="panel">
        <div class="panel-head"><h2 class="h3">Your numbers</h2><a class="small" href="#/builder">Deal Builder →</a></div>
        <div class="mini-verdict ${deal.works ? "ok" : "no"}">${deal.works ? "✓ Your deal works" : "✕ Your deal needs work"} · ${deal.minDscr ? deal.minDscr.toFixed(2) + "× DSCR" : "no debt"}</div>
        <div class="mini-ladder"><span>${money(L.todayValue, L.cur)}</span><i>→</i><b>${money(L.final.value, L.cur)}</b></div>
        <p class="muted small">Your company today, and after ${L.final.n} acquisitions. <a href="#/ladder">Value Ladder →</a></p>
      </section>
    </div>

    <div class="home-grid two-col">
      <section class="panel">
        <h2 class="h3">Recent activity</h2>
        ${h.events.length ? `<ul class="activity">${h.events.map((e) => `<li><a href="#/targets/${e.target_id}"><b>${esc(e.name)}</b></a> <span class="muted">· ${esc(e.body.length > 120 ? e.body.slice(0, 120) + "…" : e.body)}</span><small>${esc(e.user_name)} · ${when(e.created_at)}</small></li>`).join("")}</ul>` : `<p class="muted small">Calls, notes and stage changes across the team show up here.</p>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2 class="h3">Latest documents</h2><a class="small" href="#/desk">Desk →</a></div>
        ${h.documents.length ? `<ul class="link-list">${h.documents.map((d) => `<li><a href="#/desk/${d.id}">${esc(d.title)}</a><small>${when(d.created_at)}</small></li>`).join("")}</ul>` : `<p class="muted small">Letters, LOIs, memos and board packs the agents write for you.</p>`}
      </section>
    </div>`;
  const ask = (text) => { if (text.trim()) askJoshAbout(text.trim()); };
  $("#homeGo").addEventListener("click", () => ask($("#homeAsk").value));
  $("#homeAsk").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(e.target.value); });
  micButton($("#homeMic"), ask);
  document.querySelectorAll("[data-act=add]").forEach((b) => b.addEventListener("click", () => addTarget()));
}
