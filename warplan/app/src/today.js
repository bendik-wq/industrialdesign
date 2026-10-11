// Today: one ordered list of what to do now, and the 3C scorecard. Everything comes from data Warplan already has
// (callbacks, the JL follow-up sequence on each target, seller signals, deal-room clocks and gate items, board and
// lender relationships going stale, approvals waiting) ordered by the skill's daily cadence: calls in the morning,
// follow-ups in the afternoon, LinkedIn late afternoon, CRM in the evening. The scorecard is the skill's KPIs.
import { STALE_DAYS, BOARD_ROLES, LENDER_TARGET, CALL_LEVELS, DAILY_CADENCE } from "../public/js/jl.js";
import { clocks } from "./dealroom.js";
import { c1c2Summary } from "./capabilities.js";
import { now } from "./http.js";

const CALL_GOAL = 1000;
const channelOf = (s) => (/linkedin/i.test(s) ? "linkedin" : /e-?mail/i.test(s) ? "email" : /\btext|sms\b/i.test(s) ? "text" : "call");

export async function today(env, ctx, tz = "UTC") {
  const stamp = now(), day = localYmd(tz), a = ctx.accountId;
  const r = await env.DB.batch([
    env.DB.prepare("SELECT c.id, c.due_at, c.note, t.id AS target_id, t.name, t.owner_name FROM callbacks c JOIN targets t ON t.id = c.target_id WHERE c.account_id = ?1 AND c.done_at IS NULL AND c.due_at <= ?2 ORDER BY c.due_at LIMIT 30").bind(a, `${day}T23:59:59Z`),
    env.DB.prepare("SELECT id, name, owner_name, stage, next_action, next_date, priority FROM targets WHERE account_id = ?1 AND stage NOT IN ('closed', 'lost') AND next_date IS NOT NULL AND next_date <= ?2 ORDER BY next_date, priority LIMIT 60").bind(a, day),
    env.DB.prepare("SELECT s.id, s.kind, s.strength, s.title, s.target_id, t.name FROM signals s JOIN targets t ON t.id = s.target_id WHERE s.account_id = ?1 AND s.seen_at IS NULL AND s.strength >= 2 ORDER BY s.strength DESC, s.id DESC LIMIT 10").bind(a),
    env.DB.prepare("SELECT d.*, t.name, t.stage FROM deal_rooms d JOIN targets t ON t.id = d.target_id WHERE d.account_id = ?1").bind(a),
    env.DB.prepare("SELECT i.id, i.target_id, i.list, i.title, i.status, i.due_date, i.severity, i.updated_at, t.name FROM deal_items i JOIN targets t ON t.id = i.target_id WHERE i.account_id = ?1 AND t.stage NOT IN ('lost') AND ((i.status IN ('open', 'requested', 'issue') AND i.due_date IS NOT NULL AND i.due_date <= ?2) OR (i.list = 'gate' AND i.status = 'requested') OR (i.status = 'issue' AND i.severity = 'high')) ORDER BY i.due_date LIMIT 60").bind(a, day),
    env.DB.prepare("SELECT * FROM relationships WHERE account_id = ?1").bind(a),
    env.DB.prepare("SELECT COUNT(*) AS n FROM agent_actions WHERE account_id = ?1 AND status = 'pending'").bind(a),
    env.DB.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN created_at >= ?2 THEN 1 ELSE 0 END) AS today, SUM(CASE WHEN disposition IN ('connected', 'interested', 'meeting', 'callback', 'not_interested', 'gatekeeper') THEN 1 ELSE 0 END) AS reached FROM calls WHERE account_id = ?1").bind(a, `${day}T00:00:00Z`),
    env.DB.prepare("SELECT stage, COUNT(*) AS n FROM targets WHERE account_id = ?1 GROUP BY stage").bind(a),
    env.DB.prepare("SELECT target_id, stage FROM financing WHERE account_id = ?1").bind(a),
  ]);
  const [callbacks, due, sig, rooms, items, rels, inbox, calls, stages, fin] = r.map((x) => x.results);
  const tasks = [];
  const add = (t) => tasks.push(t);

  for (const c of callbacks) add({ kind: "callback", block: "calls", urgent: c.due_at < stamp, title: `Call back ${c.owner_name || c.name}`, detail: `${c.name}${c.note ? ` · ${c.note}` : ""}`, at: c.due_at, href: `#/dialer?target=${c.target_id}`, target_id: c.target_id });
  for (const s of sig) add({ kind: "signal", block: "calls", urgent: s.strength >= 3, title: `${s.name}: ${s.title}`, detail: "Seller signal: call while it's fresh.", href: `#/targets/${s.target_id}`, target_id: s.target_id });
  const hasCallback = new Set(callbacks.map((c) => c.target_id));
  for (const t of due) {
    if (hasCallback.has(t.id) || /opted out|do not call|wrong number/i.test(t.next_action || "")) continue;
    const ch = channelOf(t.next_action || "");
    add({ kind: "sequence", block: ch === "call" ? "calls" : ch === "linkedin" ? "linkedin" : "followups", channel: ch, urgent: t.next_date < day, title: `${t.next_action || "Next step"}: ${t.owner_name || t.name}`, detail: `${t.name}${t.next_date < day ? ` · overdue since ${t.next_date}` : ""}`, href: ch === "call" ? `#/dialer?target=${t.id}` : `#/targets/${t.id}`, target_id: t.id });
  }
  for (const room of rooms) {
    const c = clocks(room, stamp);
    for (const w of c.warnings) add({ kind: "deadline", block: "deals", urgent: w.level === "high", title: `${room.name}: ${w.text}`, href: `#/room/${room.target_id}`, target_id: room.target_id });
  }
  const chase = new Map();
  for (const i of items) {
    if (i.list === "gate" && i.status === "requested" && !i.due_date) { (chase.get(i.target_id) || chase.set(i.target_id, { name: i.name, items: [], since: i.updated_at }).get(i.target_id)).items.push(i.title); continue; }
    add({ kind: i.status === "issue" ? "issue" : "item", block: "deals", urgent: i.severity === "high" || (i.due_date && i.due_date < day), title: `${i.name}: ${i.title}`, detail: i.status === "issue" ? `${i.severity || ""} diligence issue`.trim() : `Due ${i.due_date}`, href: `#/room/${i.target_id}`, target_id: i.target_id });
  }
  for (const [tid, c] of chase) {
    const waited = Math.floor((Date.parse(stamp) - Date.parse(c.since)) / 864e5);
    if (waited >= 2) add({ kind: "chase", block: "followups", urgent: waited >= 7, title: `Chase ${c.name} for the gate documents`, detail: `${c.items.length} outstanding for ${waited} days: ${c.items.join(", ")}`, href: `#/room/${tid}`, target_id: tid });
  }
  const relRows = rels.map((x) => ({ ...x, terms: JSON.parse(x.terms || "{}") }));
  for (const x of relRows) {
    if (x.status === "passed") continue;
    const since = x.last_contact ? Math.floor((Date.parse(stamp) - Date.parse(`${x.last_contact}T12:00:00Z`)) / 864e5) : null;
    const dueNext = x.next_date && x.next_date <= day;
    const stale = since != null && since > STALE_DAYS[x.kind] && ["agreed", "signed", "engaged", "interviewed", "relationship"].includes(x.status);
    if (!dueNext && !stale) continue;
    const why = dueNext ? `Follow-up due ${x.next_date}` : x.kind === "lender" ? `${since} days since you spoke. The skill: send quarterly email updates on pipeline.` : x.kind === "board" ? `${since} days since you spoke. The skill: 2-4 hours monthly board meetings.` : `${since} days since you spoke.`;
    add({ kind: x.kind, block: "relationships", urgent: dueNext && x.next_date < day, title: `${x.kind === "lender" ? "Lender" : x.kind === "board" ? "Board" : "Bench"}: ${x.name}${x.firm ? ` (${x.firm})` : ""}`, detail: why, href: `#/capital?focus=${x.id}` });
  }
  if (inbox[0].n) add({ kind: "approvals", block: "followups", urgent: false, title: `${inbox[0].n} agent action${inbox[0].n === 1 ? "" : "s"} waiting for your approval`, href: "#/inbox" });

  const order = ["calls", "followups", "linkedin", "deals", "relationships"];
  tasks.sort((x, y) => Number(y.urgent) - Number(x.urgent) || order.indexOf(x.block) - order.indexOf(y.block));
  const total = calls[0].n || 0;
  return {
    day, tasks,
    blocks: { calls: "Calls", followups: "Follow-ups", linkedin: "LinkedIn", deals: "Deals in play", relationships: "Board, bench & lenders" },
    cadence: DAILY_CADENCE,
    calls: { total, today: calls[0].today || 0, reached: calls[0].reached || 0, goal: CALL_GOAL, level: CALL_LEVELS.find((l) => total < l.upTo) || CALL_LEVELS[CALL_LEVELS.length - 1], dailyTarget: [40, 50] },
    scorecard: scorecard({ rels: relRows, rooms, stages, fin, stamp }),
  };
}

// The skill's KPIs (Capabilities, Capital, Closing), from the workspace's own data.
export function scorecard({ rels, rooms, stages, fin, stamp = now() }) {
  const s = c1c2Summary(rels.map((x) => ({ ...x, terms: typeof x.terms === "string" ? JSON.parse(x.terms || "{}") : x.terms, stale: false })));
  const byStage = Object.fromEntries(stages.map((x) => [x.stage, x.n]));
  const loiRooms = rooms.filter((x) => x.loi_signed_at || x.offer_at), signed = rooms.filter((x) => x.contract_start || x.settled_at);
  const variances = rooms.map((x) => clocks(x, stamp).ddVariance).filter((v) => v != null);
  const c2c = rooms.map((x) => clocks(x, stamp).contactToClose).filter((v) => v != null);
  const fees = rooms.filter((x) => x.budget_fees && x.spent_fees != null);
  return {
    capabilities: [
      { label: "Board seats filled", value: `${s.board.filled}/${BOARD_ROLES.length}`, ok: s.board.filled >= BOARD_ROLES.length, note: s.board.seats.filter((x) => !x.filled.length).map((x) => x.label).join(", ") ? `Open: ${s.board.seats.filter((x) => !x.filled.length).map((x) => x.label).join(", ")}` : "All four seats filled" },
      { label: "Engagement letters with rolled fees", value: String(s.bench.engaged), ok: s.bench.roles.filter((r) => r.id !== "sme").every((r) => r.engaged), note: s.bench.roles.map((r) => `${r.label} ${r.engaged ? "✓" : "—"}`).join(" · ") },
    ],
    capital: [
      { label: "Lenders interviewed", value: `${s.lenders.interviewed}/${LENDER_TARGET.min}`, ok: s.lenders.interviewed >= LENDER_TARGET.min, note: LENDER_TARGET.note },
      { label: "Lenders in the matrix", value: String(s.lenders.inMatrix), ok: s.lenders.inMatrix >= LENDER_TARGET.min, note: `${s.lenders.total} lenders tracked` },
      { label: "Financing approvals", value: String(fin.filter((f) => f.stage === "approved").length), ok: null, note: `${fin.filter((f) => f.stage === "term_sheet").length} term sheets in hand` },
    ],
    closing: [
      { label: "LOI-to-SPA conversion", value: loiRooms.length ? `${Math.round((signed.length / loiRooms.length) * 100)}%` : "—", ok: null, note: `${signed.length} of ${loiRooms.length} offers reached contract` },
      { label: "DD variance", value: variances.length ? `${(variances.reduce((t, v) => t + v, 0) / variances.length).toFixed(1)}%` : "—", ok: null, note: "% price adjustment vs. initial offer" },
      { label: "Legal/accounting spend vs. budget", value: fees.length ? `${Math.round(fees.reduce((t, x) => t + x.spent_fees, 0) / fees.reduce((t, x) => t + x.budget_fees, 0) * 100)}%` : "—", ok: fees.length ? fees.every((x) => x.spent_fees <= x.budget_fees) : null, note: "Set a budget in each deal room" },
      { label: "Days from first contact to close", value: c2c.length ? String(Math.round(c2c.reduce((t, v) => t + v, 0) / c2c.length)) : "—", ok: null, note: `${byStage.closed || 0} closed` },
    ],
  };
}

// Today's date in the user's time zone (the browser sends it), so "today" flips at their midnight.
function localYmd(tz) {
  try { return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
  catch { return now().slice(0, 10); }
}
