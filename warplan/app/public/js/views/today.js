// Today: what to do now, in the JL skill's daily cadence (calls 9-12, follow-ups 1-3, LinkedIn 3-5, CRM in the
// evening), with the 1,000-call meter and the 3C scorecard (the skill's Capabilities, Capital and Closing KPIs).
import { $, esc, api, view, stale, skeleton } from "../core.js";
import { JL_SOURCE } from "../jl.js";

const ICON = { callback: "☎", signal: "◉", sequence: "→", deadline: "⏱", item: "☐", issue: "⚠", chase: "⇪", board: "♟", bench: "⚖", lender: "$", approvals: "✓" };

export async function renderToday(seq) {
  view().innerHTML = skeleton(6);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const T = await api(`/api/today?tz=${encodeURIComponent(tz)}`);
  if (stale(seq)) return;
  const h = new Date().getHours();
  const now = T.cadence.find((c) => h >= c.from && h < c.to);
  const k = T.calls, pct = Math.min(100, (k.total / k.goal) * 100);
  const byBlock = Object.keys(T.blocks).map((b) => [b, T.tasks.filter((t) => t.block === b)]).filter(([, l]) => l.length);
  const urgent = T.tasks.filter((t) => t.urgent).length;
  view().innerHTML = `
    <header class="page-head with-actions">
      <div><p class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}</p><h1>Today</h1>
        <p class="lede muted">${now ? `Right now: <b>${esc(now.text)}</b>` : "Before 9am: plan the day, then start calling at 9."}</p></div>
      <div class="row"><a class="primary" href="#/dialer">Start calling</a></div>
    </header>
    <section class="panel meter">
      <div class="panel-head"><h2 class="h3">The 1,000-call framework</h2><span class="muted small">${esc(JL_SOURCE)}</span></div>
      <div class="meter-row"><b class="meter-n">${k.total.toLocaleString()}</b><span class="muted">/ ${k.goal.toLocaleString()} calls</span><span class="spacer"></span><span class="${k.today >= k.dailyTarget[0] ? "tone-ok" : ""}">${k.today} today · target ${k.dailyTarget[0]}-${k.dailyTarget[1]} each morning</span></div>
      <div class="progress big"><span style="width:${pct}%"></span></div>
      <p class="small">${esc(k.level.text)}${k.total ? ` · ${k.reached} reached a person` : ""}</p>
      <p class="muted small">“1,000 reps creates mastery.”</p>
    </section>
    <div class="today-grid">
      <section class="panel">
        <div class="panel-head"><h2 class="h3">Do now</h2><span class="muted small">${T.tasks.length} item${T.tasks.length === 1 ? "" : "s"}${urgent ? ` · <span class="tone-bad">${urgent} overdue or urgent</span>` : ""}</span></div>
        ${byBlock.length ? byBlock.map(([b, list]) => `<h3 class="h4 rsec">${esc(T.blocks[b])}</h3><ul class="todo">${list.map((t) => `<li class="${t.urgent ? "urgent" : ""}"><span class="ti" aria-hidden="true">${ICON[t.kind] || "•"}</span><a href="${esc(t.href)}"><b>${esc(t.title)}</b>${t.detail ? `<small>${esc(t.detail)}</small>` : ""}</a></li>`).join("")}</ul>`).join("")
          : `<div class="empty"><h2>Nothing due.</h2><p class="muted">“Stop researching and start calling.” Open the dialer and work the list.</p><a class="primary" href="#/dialer">Open the dialer</a></div>`}
      </section>
      <aside class="score">
        ${scoreBlock("C1 · Capabilities", T.scorecard.capabilities, "#/capital?tab=board")}
        ${scoreBlock("C2 · Capital", T.scorecard.capital, "#/capital?tab=lender")}
        ${scoreBlock("C3 · Closing", T.scorecard.closing, "#/pipeline")}
        <section class="panel"><h2 class="h3">Daily cadence</h2><ul class="cadence">${T.cadence.map((c) => `<li class="${c === now ? "on" : ""}">${esc(c.text)}</li>`).join("")}</ul></section>
      </aside>
    </div>`;
}

function scoreBlock(title, rows, href) {
  return `<section class="panel"><div class="panel-head"><h2 class="h3">${esc(title)}</h2><a class="small" href="${href}">Open →</a></div>
    <dl class="sc">${rows.map((r) => `<div><dt>${esc(r.label)}</dt><dd class="${r.ok === true ? "tone-ok" : r.ok === false ? "tone-warn" : ""}">${esc(r.value)}</dd>${r.note ? `<small class="muted">${esc(r.note)}</small>` : ""}</div>`).join("")}</dl></section>`;
}
