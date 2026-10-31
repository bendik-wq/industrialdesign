// Prospecting bots. Each bot works one patch: every weekday morning (in its time zone) it
//   1. stops anyone who replied, opted out, bounced or that you moved forward by hand,
//   2. sends the follow-ups that are due, threaded under the first email,
//   3. finds new businesses of the kind you buy in its areas, ranks them (size signals, a website to email, close
//      to your sites), adds the best to the pipeline, finds the owner's email (else the front desk) and sends the
//      first, direct email.
// After the last email a prospect moves to the call list with their number and signals, for you to ring.
//
// Guardrails: review mode (default) queues every email in the Inbox for approval; autopilot is an owner's choice.
// Every email carries the sender's name and an opt-out line, opt-outs are never emailed again, a reply stops the
// sequence, emails per prospect are capped (max 10), and the mailbox's daily sending cap applies.
import { now } from "./http.js";
import { toCtx } from "./auth.js";
import { dataKeys } from "./keys.js";
import { scoutSearch, toTarget } from "./scout.js";
import { industryById, INDUSTRIES } from "./data/industries.js";
import { createTarget, updateTarget } from "./pipeline.js";
import { enrichTarget } from "./contacts.js";
import { deepEnrich } from "./waterfall.js";
import { sendEmail } from "./mailer.js";
import { propose } from "./approvals.js";
import { safeFetch } from "./net.js";
import { renderEmail, cleanTemplates, buyingFor, MAX_TOUCHES } from "../public/js/bot-emails.js";
import { km } from "../public/js/territory.js";
import { runSell, listSellProspects, matchFunds } from "./sellbots.js";
import { rotation } from "./rotation.js";
import { instantlyKey, ensureCampaign, pushLead, leadStats } from "./instantly.js";
import { providerKeys } from "./keys.js";
import { FUNDS } from "./data/funds.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max) => String(v ?? "").trim().slice(0, max);
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const MAX_BOTS = 10;
const LOCK_MS = 14 * 60_000;
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };

// ------------------------------------------------------------------ time zones
export function localParts(tz, at = new Date()) {
  let f;
  try { f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }); }
  catch { f = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }); }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, weekend: p.weekday === "Sat" || p.weekday === "Sun" };
}
const validTz = (tz) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

// ------------------------------------------------------------------ config
function clean(b, cur = {}) {
  const o = {};
  if ("name" in b || !cur.name) { o.name = text(b.name, 80); if (!o.name) throw err(400, "Give the bot a name"); }
  const sell = (b.kind || cur.kind) === "sell";
  if (!cur.id) o.kind = sell ? "sell" : "buy";
  if (sell) {
    if (!cur.id) { o.industry = "sell"; o.areas = "[]"; }
    if ("sell" in b || !cur.id) {
      const x = b.sell || {};
      const money = (v) => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
      const sv = { business: text(x.business, 120), name: text(x.name, 120), sector: text(x.sector, 60), location: text(x.location, 80), revenue: money(x.revenue), ebitda: money(x.ebitda), currency: ["$", "A$", "NZ$", "C$", "£", "€", "kr"].includes(x.currency) ? x.currency : "$" };
      if (!sv.business) throw err(400, "Describe the business the way buyers should read it, e.g. “a physio group in Melbourne's west”");
      o.sell = JSON.stringify(sv);
    }
    if ("buyers" in b || !cur.id) {
      const y = b.buyers || {};
      const st = y.strategic || {};
      const strategic = { on: !!st.on, industry: industryById(st.industry) ? st.industry : "", areas: (Array.isArray(st.areas) ? st.areas : String(st.areas || "").split(/[;\n]/)).map((a) => text(a, 80)).filter(Boolean).slice(0, 6) };
      if (strategic.on && (!strategic.industry || !strategic.areas.length)) throw err(400, "For strategic buyers, pick their industry and at least one area");
      if (y.funds === false && !strategic.on) throw err(400, "Pick funds, strategic buyers or both");
      o.buyers = JSON.stringify({ funds: y.funds !== false, segments: (Array.isArray(y.segments) ? y.segments : []).filter((v) => v === "lmm" || v === "mm"), countries: (Array.isArray(y.countries) ? y.countries : []).map((c) => text(c, 2).toUpperCase()).filter((c) => /^[A-Z]{2}$/.test(c)).slice(0, 12), sectors: text(y.sectors, 160), strategic });
    }
  }
  if (!sell && ("industry" in b || !cur.industry)) { if (!industryById(b.industry)) throw err(400, "Pick the kind of business it looks for"); o.industry = b.industry; }
  if (sell) {} else if ("areas" in b) {
    const list = (Array.isArray(b.areas) ? b.areas : String(b.areas || "").split(/[;\n]/)).map((a) => text(a, 80)).filter(Boolean).slice(0, 8);
    if (!list.length) throw err(400, "Add at least one area, e.g. “Melton, Victoria”");
    o.areas = JSON.stringify(list);
  } else if (!cur.areas) throw err(400, "Add at least one area, e.g. “Melton, Victoria”");
  for (const [k, n] of [["buying", 120], ["sender_name", 80], ["group_name", 80], ["phone", 40]]) if (k in b) o[k] = text(b[k], n);
  if ("daily_new" in b) o.daily_new = int(b.daily_new, 1, 30, 10);
  if ("touches" in b) o.touches = int(b.touches, 1, MAX_TOUCHES, 30);
  if ("gap_days" in b) o.gap_days = int(b.gap_days, 1, 14, 1);
  if ("send_hour" in b) o.send_hour = int(b.send_hour, 6, 18, 9);
  if ("timezone" in b) { if (!validTz(b.timezone)) throw err(400, "Pick a time zone"); o.timezone = text(b.timezone, 60); }
  if ("owner_emails" in b) o.owner_emails = b.owner_emails ? 1 : 0;
  if ("templates" in b) o.templates = JSON.stringify(cleanTemplates(b.templates));
  if ("status" in b) o.status = b.status === "active" ? "active" : "paused";
  if ("mode" in b) o.mode = b.mode === "autopilot" ? "autopilot" : "review";
  if ("delivery" in b) {
    o.delivery = b.delivery === "instantly" ? "instantly" : "direct";
    if (o.delivery === "instantly" && cur.delivery !== "instantly" && !b.confirm_instantly) throw err(400, "Tick the box to confirm Instantly sends the flow without per-email review");
  }
  if ("track_opens" in b) o.track_opens = b.track_opens ? 1 : 0;
  if ("track_clicks" in b) o.track_clicks = b.track_clicks ? 1 : 0;
  if ("mailboxes" in b) {
    const list = [...new Set((Array.isArray(b.mailboxes) ? b.mailboxes : []).map(String).filter((k) => k === "main" || /^\d{1,9}$/.test(k)))].slice(0, 21);
    if (!list.length) throw err(400, "Pick at least one mailbox to send from");
    o.mailboxes = JSON.stringify(list);
  }
  return o;
}
const botOut = (r) => ({ ...r, ext_campaign: json(r.ext_campaign, {}), mailboxes: json(r.mailboxes, ["main"]), areas: json(r.areas, []), templates: json(r.templates, {}), sell: json(r.sell, {}), buyers: json(r.buyers, {}), cursor: undefined, lock_until: undefined, running: !!(r.lock_until && r.lock_until > now()) });

function needOwnerHuman(ctx) {
  if (!ctx.isOwner) throw err(403, "Only workspace owners can set up or change prospecting bots");
  if (ctx.viaToken) throw err(403, "Set up prospecting bots in the app, signed in");
}

export async function createBot(env, ctx, b) {
  needOwnerHuman(ctx);
  const o = clean(b);
  if (o.mode === "autopilot" && !b.confirm_autopilot) throw err(400, "Tick the box to confirm emails go out without your review");
  const stamp = now();
  const cols = { account_id: ctx.accountId, user_id: ctx.user.id, created_at: stamp, updated_at: stamp, ...o };
  const keys = Object.keys(cols);
  const row = await env.DB.prepare(`INSERT INTO bots (${keys.join(", ")}) SELECT ${keys.map((_, i) => `?${i + 1}`).join(", ")} WHERE (SELECT COUNT(*) FROM bots WHERE account_id = ?${keys.indexOf("account_id") + 1}) < ${MAX_BOTS} RETURNING *`)
    .bind(...keys.map((k) => cols[k])).first();
  if (!row) throw err(400, `That's ${MAX_BOTS} bots; remove one first`);
  return botOut(row);
}

export async function updateBot(env, ctx, id, b) {
  needOwnerHuman(ctx);
  const cur = await own(env, ctx, id);
  const o = clean(b, cur);
  if (o.mode === "autopilot" && cur.mode !== "autopilot" && !b.confirm_autopilot) throw err(400, "Tick the box to confirm emails go out without your review");
  const keys = Object.keys(o);
  if (!keys.length) return botOut(cur);
  const row = await env.DB.prepare(`UPDATE bots SET ${keys.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${keys.length + 3} WHERE id = ?1 AND account_id = ?2 RETURNING *`)
    .bind(cur.id, ctx.accountId, ...keys.map((k) => o[k]), now()).first();
  return botOut(row);
}

export async function deleteBot(env, ctx, id) {
  needOwnerHuman(ctx);
  const cur = await own(env, ctx, id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM bot_prospects WHERE bot_id = ?1 AND account_id = ?2").bind(cur.id, ctx.accountId),
    env.DB.prepare("DELETE FROM bot_log WHERE bot_id = ?1 AND account_id = ?2").bind(cur.id, ctx.accountId),
    env.DB.prepare("DELETE FROM bots WHERE id = ?1 AND account_id = ?2").bind(cur.id, ctx.accountId),
  ]);
  return { ok: true };
}

async function own(env, ctx, id) {
  const r = await env.DB.prepare("SELECT * FROM bots WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!r) throw err(404, "Bot not found");
  return r;
}

// ------------------------------------------------------------------ reading
export async function listBots(env, ctx) {
  const [bots, stats, box, keys, suggest] = await Promise.all([
    env.DB.prepare("SELECT * FROM bots WHERE account_id = ?1 ORDER BY id").bind(ctx.accountId).all(),
    env.DB.prepare(`SELECT bot_id, status, COUNT(*) AS n, SUM(step) AS emails FROM bot_prospects WHERE account_id = ?1 GROUP BY bot_id, status
      UNION ALL SELECT bot_id, status, COUNT(*) AS n, SUM(step) AS emails FROM sell_prospects WHERE account_id = ?1 GROUP BY bot_id, status`).bind(ctx.accountId).all(),
    env.DB.prepare("SELECT email, daily_limit FROM mailboxes WHERE user_id = ?1").bind(ctx.user.id || 0).first(),
    dataKeys(env, ctx).catch(() => ({})),
    suggestions(env, ctx),
  ]);
  const by = {};
  for (const s of stats.results) { const o = (by[s.bot_id] ||= { emails: 0 }); o[s.status] = s.n; o.emails += s.emails || 0; }
  return {
    bots: bots.results.map((r) => ({ ...botOut(r), stats: by[r.id] || { emails: 0 } })),
    mailbox: box ? { email: box.email, daily_limit: box.daily_limit } : null,
    data_ready: !!keys.monid, suggest, max_touches: MAX_TOUCHES, funds: FUNDS.length,
    instantly: !!(await providerKeys(env, ctx, ["instantly"]).catch(() => ({}))).instantly,
  };
}

export async function listProspects(env, ctx, id, status) {
  const bot = await own(env, ctx, id);
  if (bot.kind === "sell") return (await listSellProspects(env, bot)).filter((p) => !status || p.status === status);
  const { results } = await env.DB.prepare(`SELECT p.id, p.target_id, p.email, p.email_kind, p.status, p.step, p.next_at, p.score, p.signals, p.created_at, p.updated_at, p.opens, p.clicks, p.last_open, p.mailbox,
      t.name, t.location, t.phone, t.owner_name, t.website, t.stage
    FROM bot_prospects p JOIN targets t ON t.id = p.target_id AND t.account_id = p.account_id
    WHERE p.bot_id = ?1 AND p.account_id = ?2 AND (?3 IS NULL OR p.status = ?3) ORDER BY CASE p.status WHEN 'call' THEN 0 WHEN 'replied' THEN 1 WHEN 'active' THEN 2 ELSE 3 END, p.opens DESC, p.updated_at DESC LIMIT 300`)
    .bind(bot.id, ctx.accountId, status || null).all();
  return results.map((r) => ({ ...r, signals: json(r.signals, []) }));
}

export async function botLog(env, ctx, id) {
  const bot = await own(env, ctx, id);
  return (await env.DB.prepare("SELECT id, target_id, kind, text, created_at FROM bot_log WHERE bot_id = ?1 AND account_id = ?2 ORDER BY id DESC LIMIT 150").bind(bot.id, ctx.accountId).all()).results;
}

export async function setProspect(env, ctx, botId, pid, action) {
  if (ctx.viaToken) throw err(403, "Change bot prospects in the app, signed in");
  const bot = await own(env, ctx, botId);
  const status = { stop: "removed", called: "called", resume: "active" }[action];
  if (!status) throw err(400, "Unknown action");
  if (bot.kind === "sell") {
    const r = await env.DB.prepare("UPDATE sell_prospects SET status = ?4, updated_at = ?5 WHERE id = ?1 AND bot_id = ?2 AND account_id = ?3 AND ?4 = 'removed' RETURNING fund_id").bind(+pid, bot.id, ctx.accountId, status, now()).first();
    if (!r) throw err(404, "Buyer not found");
    await log(env, bot, null, "skipped", "Stopped by hand");
    return { ok: true, status };
  }
  const r = await env.DB.prepare(`UPDATE bot_prospects SET status = ?4, next_at = CASE WHEN ?4 = 'active' THEN ?5 ELSE next_at END, updated_at = ?5 WHERE id = ?1 AND bot_id = ?2 AND account_id = ?3
    AND (?4 != 'active' OR (status IN ('removed', 'call', 'called') AND step < ?6)) RETURNING target_id`).bind(+pid, bot.id, ctx.accountId, status, now(), bot.touches).first();
  if (!r) throw err(404, "Prospect not found, or it can't be resumed");
  await log(env, bot, r.target_id, status === "called" ? "call" : "skipped", status === "called" ? "Marked as called" : status === "removed" ? "Stopped by hand" : "Resumed by hand");
  return { ok: true, status };
}

// What the setup form starts from: your profile, your territory, and what your pipeline already holds.
async function suggestions(env, ctx) {
  const [profile, inds, sites] = await Promise.all([
    env.DB.prepare("SELECT data FROM user_state WHERE user_id = ?1 AND key = 'profile'").bind(ctx.user.id || 0).first(),
    env.DB.prepare("SELECT lower(industry) AS i, COUNT(*) AS n FROM targets WHERE account_id = ?1 AND industry != '' GROUP BY lower(industry) ORDER BY n DESC LIMIT 5").bind(ctx.accountId).all(),
    env.DB.prepare("SELECT name, address, lat, lng FROM territory_sites WHERE account_id = ?1 ORDER BY id LIMIT 8").bind(ctx.accountId).all().catch(() => ({ results: [] })),
  ]);
  const p = json(profile?.data, {}) || {};
  let industry = null;
  for (const r of inds.results) {
    const hit = INDUSTRIES.find((x) => x.id === r.i || r.i.includes(x.id) || r.i.includes(x.label.split(/[\s/&,]/)[0].toLowerCase()) || x.places.split(" ")[0] === r.i.split(" ")[0]);
    if (hit) { industry = hit.id; break; }
  }
  const ind = industryById(industry || "physio");
  return {
    name: p.name || ctx.user.name || "", company: p.company || "", phone: p.phone || "",
    industry: industry || null, buying: buyingFor(ind.id, ind.places),
    sites: sites.results.map((s) => ({ name: s.name, address: s.address, lat: s.lat, lng: s.lng })),
    timezone: "Australia/Melbourne",
  };
}

// Area names for the territory sites (nearest town or suburb), so a bot can work "around my sites".
export async function siteAreas(env, ctx) {
  const { results } = await env.DB.prepare("SELECT id, name, address, lat, lng FROM territory_sites WHERE account_id = ?1 ORDER BY id LIMIT 8").bind(ctx.accountId).all();
  const out = [];
  for (const s of results) {
    if (s.address && s.address.split(",").length >= 3) { out.push(s.address.split(",").slice(0, 3).map((x) => x.trim()).join(", ")); continue; }
    const key = `rev:${s.lat.toFixed(3)},${s.lng.toFixed(3)}`;
    const hit = await env.DB.prepare("SELECT results FROM geocode_cache WHERE q = ?1").bind(key).first();
    let label = hit ? json(hit.results, [])[0]?.label : null;
    if (!label && !hit) {
      const recent = (await env.DB.prepare("SELECT COUNT(*) AS n FROM geocode_log WHERE account_id = ?1 AND at > ?2").bind(ctx.accountId, new Date(Date.now() - 60_000).toISOString()).first()).n;
      if (recent < 20) {
        await env.DB.prepare("INSERT INTO geocode_log (account_id, at) VALUES (?1, ?2)").bind(ctx.accountId, now()).run();
        if (out.length) await new Promise((ok) => setTimeout(ok, 1100));
        const res = await safeFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=${s.lat}&lon=${s.lng}`, { headers: { "User-Agent": "Warplan/1.0 (territory map; https://warplan.bendik-50e.workers.dev)", "Accept-Language": "en" } }, { httpsOnly: true, hops: 0 }).catch(() => null);
        const j = res?.ok ? await res.json().catch(() => null) : null;
        const a = j?.address || {};
        const place = a.suburb || a.town || a.city_district || a.city || a.village || "";
        label = place ? [place, a.state, a.country].filter(Boolean).join(", ") : null;
        await env.DB.prepare("INSERT INTO geocode_cache (q, results, at) VALUES (?1, ?2, ?3) ON CONFLICT (q) DO UPDATE SET results = excluded.results, at = excluded.at").bind(key, JSON.stringify(label ? [{ label, lat: s.lat, lng: s.lng }] : []), now()).run();
      }
    }
    if (label) out.push(label);
  }
  return { areas: [...new Set(out)] };
}

// ------------------------------------------------------------------ the daily run
async function log(env, bot, targetId, kind, msg) {
  await env.DB.prepare("INSERT INTO bot_log (account_id, bot_id, target_id, kind, text, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(bot.account_id, bot.id, targetId || null, kind, String(msg).slice(0, 500), now()).run();
}

async function senderCtx(env, bot) {
  const u = await env.DB.prepare(`SELECT u.id, u.account_id, u.email, u.name, u.role, u.is_admin, a.name AS account_name, a.plan, a.max_territories
    FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = ?1 AND u.account_id = ?2 AND a.active = 1`).bind(bot.user_id, bot.account_id).first();
  return u ? toCtx(u) : null;
}

// Every 10 minutes: queue the bots whose morning it is (weekdays, at or after their send hour, not yet run today).
export async function queueBots(env, exec, runNow) {
  const { results } = await env.DB.prepare("SELECT id, account_id, timezone, send_hour, last_run_on FROM bots WHERE status = 'active'").all();
  const due = results.filter((b) => { const l = localParts(b.timezone); return !l.weekend && l.hour >= b.send_hour && l.hour < 19 && b.last_run_on !== l.date; });
  if (!due.length) return 0;
  if (env.WORK) for (let i = 0; i < due.length; i += 100) await env.WORK.sendBatch(due.slice(i, i + 100).map((b) => ({ body: { type: "bot", accountId: b.account_id, botId: b.id }, delaySeconds: Math.floor(Math.random() * 3000) })));
  else for (const b of due) exec.waitUntil(runNow(b.account_id, b.id).catch((e) => console.error("bot", e)));
  return due.length;
}

// One bot's run. manual: "Run now" from the app (skips the once-a-day claim, still can't overlap another run).
export async function runBot(env, accountId, botId, hooks, { manual = false } = {}) {
  const t0 = new Date();
  const lockUntil = new Date(t0.getTime() + LOCK_MS).toISOString();
  const pre = await env.DB.prepare("SELECT * FROM bots WHERE id = ?1 AND account_id = ?2").bind(+botId, accountId).first();
  if (!pre) return { ok: false, reason: "gone" };
  const today = localParts(pre.timezone, t0).date;
  const bot = await env.DB.prepare(`UPDATE bots SET lock_until = ?3, last_run_on = CASE WHEN ?5 THEN last_run_on ELSE ?4 END WHERE id = ?1 AND account_id = ?2
    AND (lock_until IS NULL OR lock_until < ?6) AND (?5 OR status = 'active') AND (?5 OR last_run_on IS NULL OR last_run_on != ?4) RETURNING *`)
    .bind(pre.id, accountId, lockUntil, today, manual ? 1 : 0, t0.toISOString()).first();
  if (!bot) return { ok: false, reason: manual ? "This bot is already running" : "already ran today" };
  const sum = { stopped: 0, followups: 0, found: 0, first: 0, queued: 0, calls: 0, no_email: 0, notes: [] };
  try {
    const ctx = await senderCtx(env, bot);
    if (!ctx) { await env.DB.prepare("UPDATE bots SET status = 'paused' WHERE id = ?1").bind(bot.id).run(); await log(env, bot, null, "error", "Paused: the person it sends as is no longer in the workspace"); return { ok: false, reason: "no sender" }; }
    sum.rot = await rotation(env, bot, ctx);
    if (bot.delivery === "instantly") { try { sum.ikey = await instantlyKey(env, ctx); } catch (e) { await log(env, bot, null, "error", e.message); return { ok: false, reason: e.message }; } }
    else if (bot.mode === "autopilot" && !sum.rot.size) {
      await log(env, bot, null, "error", "No mailbox to send from: connect one in Settings → Email, or pick a sending mailbox on the bot"); return { ok: false, reason: "no mailbox" };
    }
    if (bot.kind === "sell") await runSell(env, bot, ctx, hooks, sum, log);
    else if (bot.delivery === "instantly") {
      await refresh(env, bot, sum);
      await syncBuy(env, bot, ctx, hooks, sum);
      await findNew(env, bot, ctx, hooks, sum);
    } else {
      await refresh(env, bot, sum);
      await hotCalls(env, bot, ctx, hooks, sum);
      const capped = await followUps(env, bot, ctx, hooks, sum);
      if (!capped) await findNew(env, bot, ctx, hooks, sum);
    }
    const parts = [sum.first && `${sum.first} first email${sum.first === 1 ? "" : "s"}`, sum.followups && `${sum.followups} follow-up${sum.followups === 1 ? "" : "s"}`, sum.queued && `${sum.queued} queued for review`,
      sum.calls && `${sum.calls} to call`, sum.stopped && `${sum.stopped} stopped (replied or opted out)`, sum.no_email && `${sum.no_email} without an email (call list)`].filter(Boolean);
    await log(env, bot, null, "run", `${manual ? "Run now" : "Morning run"}: ${parts.join(" · ") || "nothing due"}${sum.notes.length ? `. ${sum.notes.join(" ")}` : ""}`);
    delete sum.rot; delete sum.ikey;
    hooks?.emit("bot.run", { bot_id: bot.id, bot: bot.name, ...sum, notes: undefined });
    return { ok: true, ...sum };
  } catch (e) {
    delete sum.rot; delete sum.ikey;
    console.error("bot run", e);
    await log(env, bot, null, "error", e.status ? e.message : "The run stopped on an error; it tries again tomorrow");
    return { ok: false, reason: e.message };
  } finally {
    await env.DB.prepare("UPDATE bots SET lock_until = NULL WHERE id = ?1").bind(bot.id).run();
  }
}

// 1. Stop the ones that answered, opted out, were moved on by hand, or were removed from the pipeline.
async function refresh(env, bot, sum) {
  const stamp = now();
  // Out of office: pause a week instead of stopping.
  const { results: away } = await env.DB.prepare(`UPDATE bot_prospects AS p SET next_at = ?3, updated_at = ?4 WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status = 'active'
    AND EXISTS (SELECT 1 FROM replies r WHERE r.account_id = p.account_id AND r.target_id = p.target_id AND r.category = 'ooo' AND r.created_at > p.updated_at) RETURNING target_id`)
    .bind(bot.id, bot.account_id, new Date(Date.now() + 7 * 864e5).toISOString(), stamp).all();
  for (const r of away) await log(env, bot, r.target_id, "skipped", "Out of office: paused for a week");
  const stops = [
    ["replied", "Replied: the bot stopped emailing", `EXISTS (SELECT 1 FROM replies r WHERE r.account_id = p.account_id AND r.target_id = p.target_id AND r.category != 'ooo' AND r.created_at > p.created_at)`],
    ["opted_out", "Opted out: never emailed again", `EXISTS (SELECT 1 FROM suppressions s WHERE s.account_id = p.account_id AND s.email = p.email)`],
    ["replied", "Moved on in the pipeline by hand: the bot stepped back", `EXISTS (SELECT 1 FROM targets t WHERE t.id = p.target_id AND t.stage NOT IN ('sourced', 'contacted'))`],
    ["removed", "Removed from the pipeline", `NOT EXISTS (SELECT 1 FROM targets t WHERE t.id = p.target_id AND t.account_id = p.account_id)`],
  ];
  for (const [status, why, cond] of stops) {
    const { results } = await env.DB.prepare(`UPDATE bot_prospects AS p SET status = ?3, updated_at = ?4 WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status IN ('active', 'call', 'no_email') AND ${cond} RETURNING target_id`)
      .bind(bot.id, bot.account_id, status, stamp).all();
    for (const r of results) { sum.stopped++; if (status !== "removed") await log(env, bot, r.target_id, status === "opted_out" ? "skipped" : "replied", why); }
  }
}

function varsFor(bot, t, p) {
  const area = (json(bot.areas, [])[0] || "").split(",")[0];
  // "Hoppers Crossing VIC 3029" → "Hoppers Crossing" (no state or postcode in a personal email)
  const loc = String(t.location || "").split(",")[0].trim().replace(/\s+\d{3,6}$/, "").replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|NT|ACT|[A-Z]{2})$/, "").trim();
  return {
    first: String(t.owner_name || "").trim().split(/\s+/)[0] || "", company: t.name, sender: bot.sender_name, group: bot.group_name, buying: bot.buying || buyingFor(bot.industry, industryById(bot.industry)?.places),
    area: loc || area, phone: bot.phone, signals: Object.fromEntries((json(p.signals, []) || []).map((s) => [s.k, s.v])), touches: bot.touches, gapDays: bot.gap_days,
  };
}

// Send (autopilot) or queue for approval (review) email number `step` to one prospect.
// Returns "sent" | "queued" | "cap" (mailbox daily cap reached: stop sending today) | "stop".
async function deliver(env, bot, ctx, hooks, p, t, step, sum) {
  const { subject, body } = renderEmail(json(bot.templates, {}), step, varsFor(bot, t, p));
  const next = new Date(Date.now() + bot.gap_days * 864e5 - 30 * 60_000).toISOString();
  // Thread under the first email that actually went out to this address.
  const first = step > 1 ? await env.DB.prepare("SELECT message_id FROM sent_emails WHERE account_id = ?1 AND target_id = ?2 AND to_email = ?3 AND status = 'sent' ORDER BY id LIMIT 1").bind(bot.account_id, t.id, p.email).first() : null;
  // Which mailbox: the prospect's own (same thread) or the one with most room today.
  const mb = sum.rot?.size ? sum.rot.pick(p.mailbox || null) : null;
  if (mb === "wait") return "wait";
  if (sum.rot?.size && !mb) { if (!sum.notes.includes(CAP_NOTE)) sum.notes.push(CAP_NOTE); return "cap"; }
  if (mb && !p.mailbox) await env.DB.prepare("UPDATE bot_prospects SET mailbox = ?2 WHERE id = ?1").bind(p.id, mb.key).run();
  if (bot.mode !== "autopilot") {
    sum.rot?.used(mb);
    const id = await propose(env, bot.account_id, { tool: "send_email", target_id: t.id, input: { to: p.email, subject, body, target_id: t.id, ...(mb?.pool_id && { pool_id: mb.pool_id }), ...(first?.message_id && { in_reply_to: first.message_id }) },
      title: `${bot.name}: ${step === 1 ? "first email" : `follow-up ${step - 1}`} to ${t.name}`, reason: body.slice(0, 400), source: "bot", dedupe: `bot:${p.id}:${step}` });
    await env.DB.prepare("UPDATE bot_prospects SET step = ?2, next_at = ?3, subject = CASE WHEN subject = '' THEN ?4 ELSE subject END, action_id = ?5, updated_at = ?6 WHERE id = ?1").bind(p.id, step, next, subject, id, now()).run();
    await log(env, bot, t.id, "queued", `${step === 1 ? "First email" : `Follow-up ${step - 1}`} to ${t.name} (${p.email}) is waiting for your review in the Inbox`);
    sum.queued++;
    return "queued";
  }
  try {
    const r = await sendEmail(env, ctx, { to: p.email, subject, body, target_id: t.id, in_reply_to: first?.message_id || null, pool_id: mb?.pool_id || null,
      ...((bot.track_opens || bot.track_clicks) && { track: { kind: "b", id: p.id, opens: !!bot.track_opens, clicks: !!bot.track_clicks } }) }, hooks);
    sum.rot?.used(mb);
    await env.DB.prepare("UPDATE bot_prospects SET step = ?2, next_at = ?3, subject = CASE WHEN subject = '' THEN ?4 ELSE subject END, thread_id = CASE WHEN thread_id = '' THEN ?5 ELSE thread_id END, updated_at = ?6 WHERE id = ?1")
      .bind(p.id, step, next, subject, r.message_id || "", now()).run();
    await log(env, bot, t.id, step === 1 ? "sent" : "follow_up", `${step === 1 ? `Sent the first email to ${t.name} (${p.email})` : `Sent follow-up ${step - 1} to ${t.name} (${p.email}): email ${step} of ${bot.touches}`}${sum.rot?.size > 1 ? ` from ${r.from}` : ""}`);
    hooks?.emit("bot.email_sent", { bot_id: bot.id, target_id: t.id, target: t.name, to: p.email, step, of: bot.touches });
    if (step === 1) sum.first++; else sum.followups++;
    return "sent";
  } catch (e) {
    if (e.status === 429) { sum.rot?.full(mb); if (sum.rot?.left() > 0) return "wait"; if (!sum.notes.includes(CAP_NOTE)) sum.notes.push(CAP_NOTE); return "cap"; }
    const status = e.status === 409 ? "opted_out" : "bounced";
    await env.DB.prepare("UPDATE bot_prospects SET status = ?2, updated_at = ?3 WHERE id = ?1").bind(p.id, status, now()).run();
    await log(env, bot, t.id, status === "opted_out" ? "skipped" : "error", status === "opted_out" ? `${p.email} is on the do-not-contact list` : `Couldn't send to ${p.email}: ${e.message}`);
    sum.stopped++;
    return "stop";
  }
}

const CAP_NOTE = "Every sending mailbox reached today's cap; the rest go tomorrow.";

// 2. Follow-ups that are due. After the last email, hand the prospect over to call.
async function followUps(env, bot, ctx, hooks, sum) {
  const { results } = await env.DB.prepare(`SELECT p.*, t.name, t.owner_name, t.location, t.phone AS t_phone, t.priority FROM bot_prospects p JOIN targets t ON t.id = p.target_id AND t.account_id = p.account_id
    WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status = 'active' AND p.next_at <= ?3 ORDER BY p.next_at LIMIT 150`).bind(bot.id, bot.account_id, now()).all();
  for (const p of results) {
    const t = { id: p.target_id, name: p.name, owner_name: p.owner_name, location: p.location };
    if (bot.mode !== "autopilot" && p.action_id) {
      const a = await env.DB.prepare("SELECT status FROM agent_actions WHERE id = ?1 AND account_id = ?2").bind(p.action_id, bot.account_id).first();
      if (a && (a.status === "pending" || a.status === "running")) continue; // waiting for your review
      if (a && a.status === "dismissed") {
        await env.DB.prepare("UPDATE bot_prospects SET status = 'removed', updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run();
        await log(env, bot, t.id, "skipped", `You skipped the email to ${t.name}, so the bot stopped`); sum.stopped++; continue;
      }
    }
    if (p.step >= bot.touches) {
      await env.DB.prepare("UPDATE bot_prospects SET status = 'call', updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run();
      const sig = (json(p.signals, []) || []).map((s) => s.label).filter(Boolean).slice(0, 3).join(", ");
      await updateTarget(env, ctx, t.id, { next_action: `Call ${p.owner_name || "the owner"}: ${p.step} emails, no reply${p.t_phone ? ` · ${p.t_phone}` : ""}`, next_date: localParts(bot.timezone).date, priority: 1 }, hooks).catch(() => {});
      await log(env, bot, t.id, "call", `No reply after ${p.step} emails: call ${t.name}${p.t_phone ? ` on ${p.t_phone}` : ""}${sig ? ` (${sig})` : ""}`);
      hooks?.emit("bot.call_due", { bot_id: bot.id, target_id: t.id, target: t.name, phone: p.t_phone || null, emails: p.step });
      sum.calls++;
      continue;
    }
    const r = await deliver(env, bot, ctx, hooks, p, t, p.step + 1, sum);
    if (r === "cap") return true;
    // Every 7th email, a call task too: email alone isn't enough for owners who never read it.
    if ((r === "sent" || r === "queued") && (p.step + 1) % 7 === 0 && p.t_phone) {
      await updateTarget(env, ctx, t.id, { next_action: `Call ${p.owner_name || "the owner"}: email ${p.step + 1} of ${bot.touches}, no reply yet · ${p.t_phone}`, next_date: localParts(bot.timezone).date }, hooks).catch(() => {});
      await log(env, bot, t.id, "call", `Call task: ring ${t.name} on ${p.t_phone} (email ${p.step + 1} of ${bot.touches}, no reply)`);
      sum.calls++;
    }
  }
  return false;
}

// ------------------------------------------------------------------ Instantly delivery and tracking
async function toInstantly(env, bot, p, t, signals, sum) {
  try {
    const base = varsFor(bot, { name: "", location: "" }, { signals: "[]" });
    const cid = await ensureCampaign(env, bot, sum.ikey, "buy", base, log);
    const v = varsFor(bot, t, { signals: JSON.stringify(signals) });
    const sig = renderEmail({ steps: ["{signal}"] }, 1, { ...v, kind: "buy" }).body.trim();
    await pushLead(sum.ikey, cid, { email: p.email, first_name: v.first || undefined, company_name: t.name, website: t.website || undefined, phone: t.phone || undefined,
      custom_variables: { wp_first: v.first || "there", wp_company: t.name, wp_area: v.area || "your area", wp_signal: sig ? ` ${sig}` : "" } });
    await env.DB.prepare("UPDATE bot_prospects SET step = 1, mailbox = 'instantly', next_at = NULL, updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run();
    await log(env, bot, t.id, "sent", `Added ${t.name} (${p.email}) to the Instantly campaign: the ${bot.touches}-day flow starts there`);
    sum.first++;
  } catch (e) {
    await env.DB.prepare("UPDATE bot_prospects SET status = 'bounced', updated_at = ?2 WHERE id = ?1").bind(p.id, now()).run();
    await log(env, bot, t.id, "error", `Couldn't add ${t.name} to Instantly: ${e.message}`);
  }
}

// Read opens, clicks, replies, bounces and unsubscribes back from Instantly.
async function syncBuy(env, bot, ctx, hooks, sum) {
  const cid = (json(bot.ext_campaign, {}) || {}).buy;
  if (!cid) return;
  let stats;
  try { stats = await leadStats(sum.ikey, cid); } catch (e) { sum.notes.push(`Couldn't read Instantly stats: ${e.message}`); return; }
  const by = new Map(stats.map((x) => [x.email, x]));
  const { results } = await env.DB.prepare(`SELECT p.*, t.name, t.owner_name, t.phone AS t_phone FROM bot_prospects p JOIN targets t ON t.id = p.target_id AND t.account_id = p.account_id
    WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.mailbox = 'instantly' AND p.status = 'active'`).bind(bot.id, bot.account_id).all();
  for (const p of results) {
    const x = by.get(p.email);
    if (!x) continue;
    const status = x.replies > 0 ? "replied" : x.status === -1 ? "bounced" : x.status === -2 ? "opted_out" : x.status === 3 ? "call" : "active";
    await env.DB.prepare("UPDATE bot_prospects SET opens = ?2, clicks = ?3, last_open = COALESCE(?4, last_open), status = ?5, step = CASE WHEN ?5 = 'call' THEN ?6 ELSE step END, updated_at = ?7 WHERE id = ?1")
      .bind(p.id, x.opens, x.clicks, x.last_open, status, bot.touches, now()).run();
    if (status === "opted_out") await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, 'Unsubscribed (Instantly)', ?3)").bind(bot.account_id, p.email, now()).run();
    if (status === "replied") { sum.stopped++; await log(env, bot, p.target_id, "replied", `${p.name} replied in Instantly: the flow stopped`); }
    if (status === "call") {
      await updateTarget(env, ctx, p.target_id, { next_action: `Call ${p.owner_name || "the owner"}: the ${bot.touches}-day flow finished with no reply${p.t_phone ? ` · ${p.t_phone}` : ""}`, next_date: localParts(bot.timezone).date, priority: 1 }, hooks).catch(() => {});
      await log(env, bot, p.target_id, "call", `No reply after the ${bot.touches}-day flow: call ${p.name}${p.t_phone ? ` on ${p.t_phone}` : ""}${x.opens ? ` (opened ${x.opens} times)` : ""}`);
      sum.calls++;
    }
  }
  await hotCalls(env, bot, ctx, hooks, sum);
}

// Opened 3+ times with no reply: they're reading. Raise a call task once.
async function hotCalls(env, bot, ctx, hooks, sum) {
  const { results } = await env.DB.prepare(`UPDATE bot_prospects AS p SET hot = 1 WHERE p.bot_id = ?1 AND p.account_id = ?2 AND p.status = 'active' AND p.hot = 0 AND p.opens >= 3 RETURNING p.target_id, p.opens, p.clicks`)
    .bind(bot.id, bot.account_id).all();
  for (const r of results) {
    const t = await env.DB.prepare("SELECT name, owner_name, phone FROM targets WHERE id = ?1 AND account_id = ?2").bind(r.target_id, bot.account_id).first();
    if (!t) continue;
    if (t.phone) await updateTarget(env, ctx, r.target_id, { next_action: `Call ${t.owner_name || "the owner"} now: opened your emails ${r.opens} times · ${t.phone}`, next_date: localParts(bot.timezone).date, priority: 1 }, hooks).catch(() => {});
    await log(env, bot, r.target_id, "call", `${t.name} opened your emails ${r.opens} times${r.clicks ? ` and clicked ${r.clicks}` : ""}: call ${t.phone || "them"} while it's warm`);
    hooks?.emit("bot.hot", { bot_id: bot.id, target_id: r.target_id, target: t.name, opens: r.opens, clicks: r.clicks, phone: t.phone || null });
    sum.calls++;
  }
}

// Rank what the search found: size (reviews), quality (rating), a website to email, a phone, and how close it is to
// your sites (a tuck-in builds the local monopoly).
export function scoreOf(r, sites) {
  const signals = [];
  let s = 0;
  if (r.reviews > 0) { s += Math.min(45, Math.log10(r.reviews + 1) * 18); signals.push({ k: "reviews", v: r.reviews, label: `${r.reviews} reviews` }); }
  if (r.rating) { if (r.rating >= 4.5) s += 10; signals.push({ k: "rating", v: r.rating, label: `${r.rating}★` }); }
  if (r.website) s += 15; else s -= 20;
  if (r.phone) s += 5;
  if (Number.isFinite(r.lat) && sites.length) {
    const near = Math.min(...sites.map((x) => km(x, r) - x.radius_km));
    if (near <= 0) { s += 25; signals.push({ k: "tuckin", v: 1, label: "inside your service area" }); }
    else if (near <= 15) { s += 12; signals.push({ k: "near", v: Math.round(near), label: `${Math.round(near)} km past your service area` }); }
  }
  if (/\b(group|holdings|pty|franchise|national|hospital)\b/i.test(r.name)) s -= 10; // chains and corporates rarely sell to a local buyer
  return { score: Math.max(0, Math.round(s)), signals };
}

// 3. New prospects: search, rank, add, find the email, send the first one.
async function findNew(env, bot, ctx, hooks, sum) {
  // New businesses per day is a daily total: a second "Run now" the same day doesn't add another batch.
  const since = new Date(Date.now() - 20 * 3600_000).toISOString();
  const c = await env.DB.prepare("SELECT SUM(status = 'active') AS active, SUM(created_at > ?2) AS today FROM bot_prospects WHERE bot_id = ?1 AND account_id = ?3").bind(bot.id, since, bot.account_id).first();
  const want = Math.min(bot.daily_new - (c.today || 0), Math.max(0, 400 - (c.active || 0)));
  if (want <= 0) { sum.notes.push("Today's new businesses are already found."); return; }
  const keys = await dataKeys(env, ctx);
  if (!keys.monid) { sum.notes.push("Business search isn't connected for this workspace yet."); return; }
  const areas = json(bot.areas, []);
  const cursor = json(bot.cursor, {}) || {};
  const day = Math.floor(Date.now() / 864e5);
  const area = areas[day % areas.length];
  const sites = (await env.DB.prepare("SELECT lat, lng, radius_km FROM territory_sites WHERE account_id = ?1").bind(bot.account_id).all().catch(() => ({ results: [] }))).results;
  const suppressed = new Set((await env.DB.prepare("SELECT email FROM suppressions WHERE account_id = ?1").bind(bot.account_id).all()).results.map((r) => r.email));
  let pool = [], page = cursor[area] || 1;
  for (let i = 0; i < 3 && pool.length < want * 2; i++) {
    let out;
    try { out = await scoutSearch(env, ctx, { source: "maps", industry: bot.industry, region: area, page }, keys); }
    catch (e) { sum.notes.push(e.status === 402 ? "The data budget is used up for this month." : `Search in ${area} failed: ${e.message}`); break; }
    pool.push(...out.results.filter((r) => !r.in_pipeline));
    if (!out.more) { page = 1; break; } // reached the end of this area: start over next time (new businesses appear)
    page++;
  }
  cursor[area] = page;
  await env.DB.prepare("UPDATE bots SET cursor = ?2 WHERE id = ?1").bind(bot.id, JSON.stringify(cursor)).run();
  const ranked = pool.map((r) => ({ r, ...scoreOf(r, sites) })).sort((a, b) => b.score - a.score).slice(0, want);
  let paid = !!bot.owner_emails;
  for (const { r, score, signals } of ranked) {
    const t = await createTarget(env, ctx, { ...toTarget(r, "$"), source: `Prospecting bot · ${bot.name}`, tags: "bot" }, hooks).catch(() => null);
    if (!t) continue;
    sum.found++;
    // Email: the owner's own address first (paid lookup), else what the website lists (front desk).
    let email = "", kind = "";
    const site = await enrichTarget(env, ctx, t.id, keys).catch(() => null);
    const listed = (site?.found || []).filter((c) => c.kind === "email" && c.confidence !== "guess");
    const ownerListed = listed.find((c) => c.owner);
    if (ownerListed) { email = ownerListed.value; kind = "owner"; }
    if (!email && paid && r.website) {
      try { const d = await deepEnrich(env, ctx, t.id, { linkedin: false }); if (d.owner_email) { email = d.owner_email; kind = "owner"; } else if (d.decision_maker_email) { email = d.decision_maker_email; kind = "decision_maker"; } }
      catch (e) { if (e.status === 402) { paid = false; sum.notes.push("The data budget ran out, so the rest use the front-desk email."); } }
    }
    if (!email) { const front = listed.find((c) => /general/i.test(c.label || "")) || listed[0]; if (front) { email = front.value; kind = "front_desk"; } }
    if (email && suppressed.has(email)) email = "";
    const stamp = now();
    const p = await env.DB.prepare(`INSERT INTO bot_prospects (account_id, bot_id, target_id, email, email_kind, status, step, next_at, score, signals, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?7, ?7) ON CONFLICT (bot_id, target_id) DO NOTHING RETURNING *`)
      .bind(bot.account_id, bot.id, t.id, email, kind, email ? "active" : "no_email", stamp, score, JSON.stringify(signals)).first();
    if (!p) continue;
    if (!email) { sum.no_email++; await log(env, bot, t.id, "found", `Found ${t.name} (${signals.map((s) => s.label).join(", ") || "no signals"}) but no email: on the call list${r.phone ? ` · ${r.phone}` : ""}`); continue; }
    await log(env, bot, t.id, "found", `Found ${t.name}: score ${score}${signals.length ? ` (${signals.map((s) => s.label).join(", ")})` : ""}, emailing the ${kind === "owner" ? "owner" : kind === "decision_maker" ? "decision maker" : "front desk"}`);
    if (bot.delivery === "instantly") { await toInstantly(env, bot, p, { ...t, phone: r.phone, website: r.website }, signals, sum); continue; }
    const res = await deliver(env, bot, ctx, hooks, p, { id: t.id, name: t.name, owner_name: t.owner_name, location: t.location }, 1, sum);
    if (res === "cap") break;
  }
}

// The buyers directory: every workspace sees the same list, with which funds its own sell bots have contacted.
export async function buyersDirectory(env, ctx, q) {
  const seg = q.get("segment"), country = (q.get("country") || "").toUpperCase(), words = String(q.get("q") || "").toLowerCase().trim();
  const { results } = await env.DB.prepare("SELECT fund_id, status, step FROM sell_prospects WHERE account_id = ?1").bind(ctx.accountId).all().catch(() => ({ results: [] }));
  const touched = new Map(results.map((r) => [r.fund_id, r]));
  const list = FUNDS.filter((f) => (!seg || f.segment === seg) && (!country || f.hq_country === country || (f.regions || []).includes(country))
    && (!words || `${f.name} ${f.hq_city} ${(f.sectors || []).join(" ")}`.toLowerCase().includes(words)));
  const countries = [...new Set(FUNDS.map((f) => f.hq_country).filter(Boolean))].sort();
  return { total: FUNDS.length, countries, funds: list.map((f) => ({ ...f, contacted: touched.get(f.id) || null })) };
}

export async function botsRoute(request, env, ctx, url, body, hooks) {
  const p = url.pathname, m = request.method;
  let r;
  if (p === "/api/bots" && m === "GET") return listBots(env, ctx);
  if (p === "/api/bots" && m === "POST") return createBot(env, ctx, await body(request));
  if (p === "/api/bots/areas" && m === "GET") return siteAreas(env, ctx);
  if (p === "/api/buyers" && m === "GET") return buyersDirectory(env, ctx, url.searchParams);
  if ((r = p.match(/^\/api\/bots\/(\d+)$/))) {
    if (m === "PATCH") return updateBot(env, ctx, +r[1], await body(request));
    if (m === "DELETE") return deleteBot(env, ctx, +r[1]);
  }
  if ((r = p.match(/^\/api\/bots\/(\d+)\/run$/)) && m === "POST") {
    needOwnerHuman(ctx);
    const bot = await own(env, ctx, +r[1]);
    const out = await runBot(env, ctx.accountId, bot.id, hooks, { manual: true });
    if (!out.ok && out.reason) throw err(409, out.reason);
    return out;
  }
  if ((r = p.match(/^\/api\/bots\/(\d+)\/prospects$/)) && m === "GET") return listProspects(env, ctx, +r[1], url.searchParams.get("status"));
  if ((r = p.match(/^\/api\/bots\/(\d+)\/log$/)) && m === "GET") return botLog(env, ctx, +r[1]);
  if ((r = p.match(/^\/api\/bots\/(\d+)\/prospects\/(\d+)\/(stop|called|resume)$/)) && m === "POST") return setProspect(env, ctx, +r[1], +r[2], r[3]);
  return undefined;
}
