// Sell-side bots: shop a business to the buyers directory (lower-middle and middle-market private equity) for the
// best price. Same daily rhythm and guardrails as the buying bots: the business is described the way the owner
// chooses (it can stay anonymous), each fund gets one email a weekday up to the flow length, and a reply, opt-out
// or bounce stops it. The fund's address comes from its own website (cached for everyone: it's public).
import { now } from "./http.js";
import { FUNDS, fundById, usdOf } from "./data/funds.js";
import { findContacts } from "./enrich.js";
import { sendEmail } from "./mailer.js";
import { propose } from "./approvals.js";
import { renderEmail } from "../public/js/bot-emails.js";
import { dataKeys } from "./keys.js";
import { scoutSearch } from "./scout.js";
import { industryById } from "./data/industries.js";

const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const FX = { "$": 1, "US$": 1, "A$": 0.65, "NZ$": 0.6, "C$": 0.73, "£": 1.27, "€": 1.08, "kr": 0.093 };

// How well a fund fits the business: where it invests, its sectors, and whether the EBITDA is in its range.
export function fundFit(f, sell = {}, buyers = {}) {
  const why = [];
  let s = 0;
  const countries = (buyers.countries || []).filter(Boolean);
  const inRegion = !countries.length || countries.some((c) => f.hq_country === c || (f.regions || []).includes(c));
  if (!inRegion) return { score: 0, why: ["outside the countries you picked"], skip: true };
  if (countries.length) { s += 35; why.push(`invests in ${countries.filter((c) => f.hq_country === c || (f.regions || []).includes(c)).join(", ")}`); } else s += 15;
  const segs = (buyers.segments || []).filter(Boolean);
  if (segs.length && !segs.includes(f.segment)) return { score: 0, why: ["not the market segment you picked"], skip: true };
  const words = String(buyers.sectors || sell.sector || "").toLowerCase().split(/[,;/]+/).map((w) => w.trim()).filter((w) => w.length > 2);
  const fs = (f.sectors || []).join(" ").toLowerCase();
  const hit = words.find((w) => fs.includes(w) || w.split(/\s+/).some((x) => x.length > 3 && fs.includes(x)));
  if (hit) { s += 30; why.push(`invests in ${hit}`); } else if (/generalist|diversified|multi|business services/.test(fs)) { s += 10; why.push("generalist"); }
  const usd = sell.ebitda ? +sell.ebitda * (FX[sell.currency] ?? 1) / 1e6 : null;
  if (usd != null && (f.ebitda_min_usd != null || f.ebitda_max_usd != null)) {
    if (f.ebitda_min_usd != null && usd < f.ebitda_min_usd * 0.6) return { score: 0, why: ["too small for its range"], skip: true };
    if (f.ebitda_max_usd != null && usd > f.ebitda_max_usd * 1.6) return { score: 0, why: ["too big for its range"], skip: true };
    s += 30; why.push("EBITDA in its range");
  } else s += 8;
  return { score: Math.min(100, s), why };
}

export function matchFunds(sell, buyers, exclude = new Set()) {
  return FUNDS.filter((f) => !exclude.has(f.id)).map((f) => ({ f, ...fundFit(f, sell, buyers) })).filter((x) => !x.skip).sort((a, b) => b.score - a.score);
}

// The best address a fund publishes for deals: deal/origination/investment inboxes first, then the general one.
// Named people's addresses are never used (they may not handle new deals); without a shared inbox, the bot lists
// the fund's contact page for you instead.
async function fundEmail(env, f) {
  const hit = await env.DB.prepare("SELECT emails, checked_at FROM fund_contacts WHERE fund_id = ?1").bind(f.id).first();
  let emails = hit && Date.now() - Date.parse(hit.checked_at) < 90 * 864e5 ? json(hit.emails, []) : null;
  if (!emails) {
    const r = await findContacts({ website: f.website, name: f.name }).catch(() => ({ contacts: [] }));
    const host = String(f.website).replace(/^https?:\/\/(www\.)?/, "").split("/")[0];
    emails = (r.contacts || []).filter((c) => c.kind === "email" && c.confidence !== "guess" && c.value.endsWith(host.split(".").slice(-2).join("."))).map((c) => c.value);
    await env.DB.prepare("INSERT INTO fund_contacts (fund_id, emails, checked_at) VALUES (?1, ?2, ?3) ON CONFLICT (fund_id) DO UPDATE SET emails = excluded.emails, checked_at = excluded.checked_at").bind(f.id, JSON.stringify(emails.slice(0, 10)), now()).run();
  }
  const rank = (e) => (/^(deals?|dealflow|origination|opportunit|newdeals|investments?|bd|business|proposals?)@/.test(e) ? 0 : /^(info|enquir|inquir|contact|hello|office|mail|admin)@/.test(e) ? 1 : 2);
  // Only the fund's own shared inboxes: a named person found on the site may not handle new deals.
  return [...emails].filter((e) => rank(e) <= 1).sort((a, b) => rank(a) - rank(b))[0] || "";
}

// A prospect's buyer: a fund from the directory, or a strategic buyer stored on the row.
const buyerOf = (p) => (p.buyer_kind === "strategic" ? { ...json(p.buyer, {}), id: p.fund_id, strategic: true } : fundById(p.fund_id));

function sellVars(bot, f) {
  const s = json(bot.sell, {}) || {};
  return { kind: f.strategic ? "strategic" : "sell", first: "", fund: f.name, buyer: f.name, sender: bot.sender_name, business: s.business || "my business", sector: s.sector || "", area: s.location || "",
    revenue: s.revenue || null, ebitda: s.ebitda || null, currency: s.currency || "$", phone: bot.phone, touches: bot.touches, gapDays: bot.gap_days };
}

async function send(env, bot, ctx, hooks, p, f, step, sum, log) {
  const tpl = json(bot.templates, {}) || {};
  const { subject, body } = renderEmail(f.strategic ? tpl.strategic || {} : tpl, step, sellVars(bot, f));
  const next = new Date(Date.now() + bot.gap_days * 864e5 - 30 * 60_000).toISOString();
  const first = step > 1 ? await env.DB.prepare("SELECT message_id FROM sent_emails WHERE account_id = ?1 AND target_id IS NULL AND to_email = ?2 AND status = 'sent' AND subject = ?3 ORDER BY id LIMIT 1").bind(bot.account_id, p.email, subject.replace(/^Re: /, "")).first() : null;
  const mb = sum.rot?.size ? sum.rot.pick(p.mailbox || null) : null;
  if (mb === "wait") return "wait";
  if (sum.rot?.size && !mb) { sum.notes.push("Every sending mailbox reached today's cap; the rest go tomorrow."); return "cap"; }
  if (mb && !p.mailbox) await env.DB.prepare("UPDATE sell_prospects SET mailbox = ?2 WHERE id = ?1").bind(p.id, mb.key).run();
  if (bot.mode !== "autopilot") {
    sum.rot?.used(mb);
    const id = await propose(env, bot.account_id, { tool: "send_email", input: { to: p.email, subject, body, ...(mb?.pool_id && { pool_id: mb.pool_id }), ...(first?.message_id && { in_reply_to: first.message_id }) },
      title: `${bot.name}: ${step === 1 ? "first email" : `follow-up ${step - 1}`} to ${f.name}`, reason: body.slice(0, 400), source: "bot", dedupe: `sellbot:${p.id}:${step}` });
    await env.DB.prepare("UPDATE sell_prospects SET step = ?2, next_at = ?3, subject = CASE WHEN subject = '' THEN ?4 ELSE subject END, action_id = ?5, updated_at = ?6 WHERE id = ?1").bind(p.id, step, next, subject, id, now()).run();
    await log(env, bot, null, "queued", `${step === 1 ? "First email" : `Follow-up ${step - 1}`} to ${f.name} (${p.email}) is waiting for your review in the Inbox`);
    sum.queued++; return "queued";
  }
  try {
    await sendEmail(env, ctx, { to: p.email, subject, body, in_reply_to: first?.message_id || null, pool_id: mb?.pool_id || null }, hooks);
    sum.rot?.used(mb);
    await env.DB.prepare("UPDATE sell_prospects SET step = ?2, next_at = ?3, subject = CASE WHEN subject = '' THEN ?4 ELSE subject END, updated_at = ?5 WHERE id = ?1").bind(p.id, step, next, subject, now()).run();
    await log(env, bot, null, step === 1 ? "sent" : "follow_up", step === 1 ? `Sent the first email to ${f.name} (${p.email})` : `Sent follow-up ${step - 1} to ${f.name}: email ${step} of ${bot.touches}`);
    hooks?.emit("bot.email_sent", { bot_id: bot.id, fund: f.name, to: p.email, step, of: bot.touches });
    if (step === 1) sum.first++; else sum.followups++;
    return "sent";
  } catch (e) {
    if (e.status === 429) { sum.rot?.full(mb); if (sum.rot?.left() > 0) return "wait"; sum.notes.push("Every sending mailbox reached today's cap; the rest go tomorrow."); return "cap"; }
    const status = e.status === 409 ? "opted_out" : "bounced";
    await env.DB.prepare("UPDATE sell_prospects SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(p.id, status, now()).run();
    await log(env, bot, null, status === "opted_out" ? "skipped" : "error", status === "opted_out" ? `${p.email} is on the do-not-contact list` : `Couldn't send to ${p.email}: ${e.message}`);
    sum.stopped++; return "stop";
  }
}

export async function runSell(env, bot, ctx, hooks, sum, log) {
  const stamp = now();
  // 1. Out of office: pause a week. Any other reply, or an opt-out: stop.
  const { results: ooo } = await env.DB.prepare(`UPDATE sell_prospects AS p SET next_at = ?3, updated_at = ?4 WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status = 'active'
    AND EXISTS (SELECT 1 FROM replies r WHERE r.account_id = p.account_id AND lower(r.from_email) = p.email AND r.category = 'ooo' AND r.created_at > p.updated_at) RETURNING fund_id`)
    .bind(bot.id, bot.account_id, new Date(Date.now() + 7 * 864e5).toISOString(), stamp).all();
  for (const r of ooo) await log(env, bot, null, "skipped", `${fundById(r.fund_id)?.name || "A fund"} is out of office: paused for a week`);
  for (const [status, why, cond] of [
    ["replied", "replied: the bot stopped emailing them", "EXISTS (SELECT 1 FROM replies r WHERE r.account_id = p.account_id AND lower(r.from_email) = p.email AND r.category != 'ooo' AND r.created_at > p.created_at)"],
    ["opted_out", "opted out: never emailed again", "EXISTS (SELECT 1 FROM suppressions s WHERE s.account_id = p.account_id AND s.email = p.email)"],
  ]) {
    const { results } = await env.DB.prepare(`UPDATE sell_prospects AS p SET status = ?3, updated_at = ?4 WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status = 'active' AND ${cond} RETURNING fund_id`).bind(bot.id, bot.account_id, status, stamp).all();
    for (const r of results) { sum.stopped++; await log(env, bot, null, status === "replied" ? "replied" : "skipped", `${fundById(r.fund_id)?.name || "A fund"} ${why}`); }
  }
  // 2. Follow-ups.
  const { results: due } = await env.DB.prepare("SELECT * FROM sell_prospects WHERE bot_id = ?1 AND account_id = ?2 AND status = 'active' AND next_at <= ?3 ORDER BY next_at LIMIT 150").bind(bot.id, bot.account_id, stamp).all();
  for (const p of due) {
    const f = buyerOf(p);
    if (!f?.name) continue;
    if (bot.mode !== "autopilot" && p.action_id) {
      const a = await env.DB.prepare("SELECT status FROM agent_actions WHERE id = ?1 AND account_id = ?2").bind(p.action_id, bot.account_id).first();
      if (a && (a.status === "pending" || a.status === "running")) continue;
      if (a && a.status === "dismissed") { await env.DB.prepare("UPDATE sell_prospects SET status = 'removed', updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run(); await log(env, bot, null, "skipped", `You skipped the email to ${f.name}, so the bot stopped`); sum.stopped++; continue; }
    }
    if (p.step >= bot.touches) { await env.DB.prepare("UPDATE sell_prospects SET status = 'finished', updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run(); continue; }
    if ((await send(env, bot, ctx, hooks, p, f, p.step + 1, sum, log)) === "cap") return;
  }
  // 3. New buyers: funds from the directory and, if switched on, strategic buyers (bigger operators nearby).
  const buyers = json(bot.buyers, {}) || {};
  const since0 = new Date(Date.now() - 20 * 3600_000).toISOString();
  const done = (await env.DB.prepare("SELECT SUM(buyer_kind = 'strategic') AS s, SUM(buyer_kind != 'strategic') AS f FROM sell_prospects WHERE bot_id = ?1 AND account_id = ?2 AND created_at > ?3").bind(bot.id, bot.account_id, since0).first());
  const fundsOn = buyers.funds !== false, stratOn = !!buyers.strategic?.on;
  const stratWant = stratOn ? (fundsOn ? Math.ceil(bot.daily_new / 2) : bot.daily_new) - (done.s || 0) : 0;
  if (stratWant > 0 && (await strategicNew(env, bot, ctx, hooks, sum, log, stratWant)) === "cap") return;
  if (!fundsOn) return;
  // Funds: the best-fitting ones this workspace hasn't contacted from any bot.: the best-fitting funds this workspace hasn't contacted from any bot.
  let want = (stratOn ? bot.daily_new - Math.ceil(bot.daily_new / 2) : bot.daily_new) - (done.f || 0);
  if (want <= 0) { sum.notes.push("Today's new buyers are already contacted."); return; }
  const taken = new Set((await env.DB.prepare("SELECT fund_id FROM sell_prospects WHERE account_id = ?1").bind(bot.account_id).all()).results.map((r) => r.fund_id));
  const picks = matchFunds(json(bot.sell, {}), json(bot.buyers, {}), taken);
  if (!picks.length) { sum.notes.push("No more buyers in the directory match this bot's filters. Widen the countries or sectors."); return; }
  const suppressed = new Set((await env.DB.prepare("SELECT email FROM suppressions WHERE account_id = ?1").bind(bot.account_id).all()).results.map((r) => r.email));
  for (const { f, score, why } of picks) {
    if (want <= 0) break;
    const email = await fundEmail(env, f);
    const ok = email && !suppressed.has(email);
    const p = await env.DB.prepare(`INSERT INTO sell_prospects (account_id, bot_id, fund_id, email, status, step, next_at, score, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?6, ?6)
      ON CONFLICT (bot_id, fund_id) DO NOTHING RETURNING *`).bind(bot.account_id, bot.id, f.id, ok ? email : "", ok ? "active" : "no_email", now(), score).first();
    if (!p) continue;
    sum.found++; want--;
    if (!ok) { sum.no_email++; await log(env, bot, null, "found", `Matched ${f.name} (${why.join(", ")}) but its website lists no email: reach them via ${f.contact_url || f.website}`); continue; }
    await log(env, bot, null, "found", `Matched ${f.name}: fit ${score} (${why.join(", ")}), emailing ${email}`);
    if ((await send(env, bot, ctx, hooks, p, f, 1, sum, log)) === "cap") return;
  }
}

export async function listSellProspects(env, bot) {
  const { results } = await env.DB.prepare("SELECT * FROM sell_prospects WHERE bot_id = ?1 AND account_id = ?2 ORDER BY CASE status WHEN 'replied' THEN 0 WHEN 'active' THEN 1 WHEN 'no_email' THEN 2 ELSE 3 END, updated_at DESC LIMIT 300").bind(bot.id, bot.account_id).all();
  return results.map((p) => {
    if (p.buyer_kind === "strategic") { const b = json(p.buyer, {}) || {}; return { ...p, buyer: undefined, name: b.name || "Strategic buyer", location: b.location || "", website: b.website || "", phone: b.phone || "", strategic: true, size: [b.locations > 1 && `${b.locations} locations`, b.reviews && `${b.reviews} reviews`].filter(Boolean).join(" · ") }; }
    const f = fundById(p.fund_id) || {};
    return { ...p, buyer: undefined, name: f.name || p.fund_id, location: [f.hq_city, f.hq_country].filter(Boolean).join(", "), website: f.website, contact_url: f.contact_url, segment: f.segment, size: f.size, sectors: f.sectors || [] };
  });
}

// ------------------------------------------------------------------ strategic buyers
// Bigger operators in the same field and area: the ones with several locations and lots of reviews are the
// consolidators most likely to pay up for a business that adds a patch to their footprint.
const STOP = new Set(["the", "and", "of", "pty", "ltd", "limited", "inc", "llc", "co", "company", "group", "&", "-", "clinic", "centre", "center"]);
export const brandKey = (name) => String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w)).slice(0, 2).join(" ");

export function rankStrategics(rows, ownName = "") {
  const own = brandKey(ownName);
  const by = new Map();
  for (const r of rows) {
    const k = brandKey(r.name);
    if (!k || (own && k === own)) continue;
    const g = by.get(k) || { key: k, name: r.name, website: r.website || "", phone: r.phone || "", location: r.location || "", locations: 0, reviews: 0 };
    g.locations++; g.reviews += +r.reviews || 0;
    if (!g.website && r.website) g.website = r.website;
    if (!g.phone && r.phone) g.phone = r.phone;
    if (r.name.length < g.name.length) g.name = r.name; // the plain brand name, not "X – Suburb"
    by.set(k, g);
  }
  return [...by.values()].filter((g) => g.locations >= 2 || g.reviews >= 150)
    .map((g) => ({ ...g, score: Math.round(Math.min(50, (g.locations - 1) * 15) + Math.min(40, Math.log10(g.reviews + 1) * 14) + (g.website ? 10 : 0)) }))
    .sort((a, b) => b.score - a.score);
}

async function strategicNew(env, bot, ctx, hooks, sum, log, want) {
  const st = (json(bot.buyers, {}) || {}).strategic || {};
  const sell = json(bot.sell, {}) || {};
  if (!industryById(st.industry)) { sum.notes.push("Pick the industry for strategic buyers on the bot."); return; }
  const areas = (st.areas || []).filter(Boolean);
  if (!areas.length) { sum.notes.push("Add an area for strategic buyers on the bot."); return; }
  const keys = await dataKeys(env, ctx);
  if (!keys.monid) { sum.notes.push("Business search isn't connected for this workspace yet, so strategic buyers were skipped."); return; }
  const cursor = json(bot.cursor, {}) || {};
  const sc = (cursor.strategic ||= {});
  const area = areas[Math.floor(Date.now() / 864e5) % areas.length];
  const rows = [];
  let page = sc[area] || 1;
  for (let i = 0; i < 3; i++) {
    let out;
    try { out = await scoutSearch(env, ctx, { source: "maps", industry: st.industry, region: area, page }, keys); }
    catch (e) { sum.notes.push(e.status === 402 ? "The data budget is used up for this month." : `Strategic search in ${area} failed: ${e.message}`); break; }
    rows.push(...out.results);
    if (!out.more) { page = 1; break; }
    page++;
  }
  sc[area] = page;
  await env.DB.prepare("UPDATE bots SET cursor = ?2 WHERE id = ?1").bind(bot.id, JSON.stringify(cursor)).run();
  const taken = new Set((await env.DB.prepare("SELECT fund_id FROM sell_prospects WHERE account_id = ?1").bind(bot.account_id).all()).results.map((r) => r.fund_id));
  const suppressed = new Set((await env.DB.prepare("SELECT email FROM suppressions WHERE account_id = ?1").bind(bot.account_id).all()).results.map((r) => r.email));
  const ranked = rankStrategics(rows, sell.name).filter((g) => !taken.has(`s:${g.key}`));
  if (!ranked.length) { sum.notes.push(`No new strategic buyers found in ${area} today.`); return; }
  for (const g of ranked) {
    if (want <= 0) break;
    let email = "";
    if (g.website) {
      const r = await findContacts({ website: g.website, name: g.name }).catch(() => ({ contacts: [] }));
      const list = (r.contacts || []).filter((c) => c.kind === "email" && c.confidence !== "guess").map((c) => c.value);
      const rank = (e) => (/^(ceo|md|owner|director|acquisitions?|partnerships?|growth|bd|business)@/.test(e) ? 0 : /^(info|enquir|inquir|contact|hello|office|admin|reception|mail)@/.test(e) ? 1 : 2);
      email = list.filter((e) => rank(e) <= 1).sort((a, b) => rank(a) - rank(b))[0] || "";
    }
    const ok = email && !suppressed.has(email);
    const buyer = { name: g.name.slice(0, 100), website: g.website, phone: g.phone, location: g.location, locations: g.locations, reviews: g.reviews };
    const p = await env.DB.prepare(`INSERT INTO sell_prospects (account_id, bot_id, fund_id, email, status, step, next_at, score, created_at, updated_at, buyer_kind, buyer) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, ?6, ?6, 'strategic', ?8)
      ON CONFLICT (bot_id, fund_id) DO NOTHING RETURNING *`).bind(bot.account_id, bot.id, `s:${g.key}`, ok ? email : "", ok ? "active" : "no_email", now(), g.score, JSON.stringify(buyer)).first();
    if (!p) continue;
    sum.found++; want--;
    const sig = [g.locations > 1 && `${g.locations} locations`, g.reviews && `${g.reviews} reviews`].filter(Boolean).join(", ");
    if (!ok) { sum.no_email++; await log(env, bot, null, "found", `Strategic buyer ${g.name} (${sig}) lists no email: call ${g.phone || "them"}`); continue; }
    await log(env, bot, null, "found", `Strategic buyer ${g.name}: score ${g.score} (${sig}), emailing ${email}`);
    if ((await send(env, bot, ctx, hooks, p, { ...buyer, id: p.fund_id, strategic: true }, 1, sum, log)) === "cap") return "cap";
  }
}

export { usdOf };
