// Instantly delivery for bots. The bot still finds the businesses (or buyers), finds the email and writes the copy;
// Instantly sends: warmed mailboxes, inbox rotation, bounce protection. Each bot gets its own campaign per email set
// (buying, funds, strategic buyers) with the bot's 30/60-day flow as the sequence: anything that's the same for every
// lead (your name, the business for sale, the figures) is written into the emails, and per-lead details go in as
// Instantly variables ({{wp_first}}, {{wp_company}} …). Each run reads opens, clicks, replies, bounces and
// unsubscribes back, stops the ones that replied, and raises a call task for anyone opening again and again.
import { providerKeys } from "./keys.js";
import { renderEmail } from "../public/js/bot-emails.js";

const API = "https://api.instantly.ai/api/v2";
const err = (status, message) => Object.assign(new Error(message), { status });
const json = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Instantly accepts a fixed list of time zones: use the bot's own, or one with the same clock.
const TZ_OK = new Set(["Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Darwin", "Pacific/Auckland", "America/Chicago", "America/Detroit", "America/Boise", "America/Anchorage", "Europe/Helsinki", "Europe/Belgrade", "Europe/Isle_of_Man", "Etc/GMT"]);
const TZ_MAP = { "Australia/Sydney": "Australia/Melbourne", "Australia/Hobart": "Australia/Melbourne", "Australia/Canberra": "Australia/Melbourne", "America/New_York": "America/Detroit", "America/Toronto": "America/Detroit",
  "America/Denver": "America/Boise", "America/Los_Angeles": "America/Dawson", "America/Vancouver": "America/Dawson", "Europe/London": "Europe/Isle_of_Man", "Europe/Dublin": "Europe/Isle_of_Man",
  "Europe/Oslo": "Europe/Belgrade", "Europe/Stockholm": "Europe/Belgrade", "Europe/Copenhagen": "Europe/Belgrade", "Europe/Berlin": "Europe/Belgrade", "Europe/Amsterdam": "Europe/Belgrade", "Europe/Paris": "Europe/Belgrade" };
export const instantlyTz = (tz) => (TZ_OK.has(tz) ? tz : TZ_MAP[tz] || "Etc/GMT");

async function call(key, path, init = {}) {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const text = await res.text();
  const data = json(text, null);
  if (!res.ok) throw err(res.status === 401 || res.status === 403 ? 400 : 502, `Instantly: ${data?.message || data?.error || text.slice(0, 160) || res.status}`);
  return data;
}
export async function instantlyKey(env, ctx) {
  const k = (await providerKeys(env, ctx, ["instantly"])).instantly;
  if (!k?.key) throw err(400, "Connect Instantly under Settings → Integrations first");
  return k.key;
}

// The per-lead placeholders for each email set.
const LEAD_VARS = {
  buy: { first: "{{wp_first}}", company: "{{wp_company}}", area: "{{wp_area}}", signal: "{{wp_signal}}" },
  sell: { first: "{{wp_first}}", fund: "{{wp_buyer}}", buyer: "{{wp_buyer}}" },
  strategic: { first: "{{wp_first}}", fund: "{{wp_buyer}}", buyer: "{{wp_buyer}}" },
};
const toHtml = (text) => text.split(/\n{2,}/).map((p) => `<div>${esc(p).replace(/\n/g, "<br>")}</div>`).join("<div><br></div>");

// The sequence: one step per email in the flow, a day (or the bot's gap) apart. Follow-ups have no subject so they
// go out as replies in the same thread.
export function buildSequence(bot, kind, base) {
  const tpl = json(bot.templates, {}) || {};
  const templates = kind === "strategic" ? tpl.strategic || {} : tpl;
  const steps = [];
  for (let i = 1; i <= bot.touches; i++) {
    const e = renderEmail(templates, i, { ...base, kind, touches: bot.touches, gapDays: bot.gap_days, overrides: LEAD_VARS[kind] });
    steps.push({ type: "email", delay: bot.gap_days, delay_unit: "days", variants: [{ subject: i === 1 ? e.subject : "", body: toHtml(e.body) }] });
  }
  return [{ steps }];
}

export function campaignBody(bot, kind, base) {
  const days = { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false };
  return {
    name: `Warplan · ${bot.name}${kind === "strategic" ? " · strategic" : ""}`.slice(0, 120),
    campaign_schedule: { schedules: [{ name: "Weekdays", timing: { from: `${String(bot.send_hour).padStart(2, "0")}:00`, to: "17:00" }, days, timezone: instantlyTz(bot.timezone) }] },
    sequences: buildSequence(bot, kind, base),
    stop_on_reply: true, stop_on_auto_reply: false, open_tracking: !!bot.track_opens, link_tracking: !!bot.track_clicks,
    text_only: !bot.track_opens && !bot.track_clicks, insert_unsubscribe_header: true, prioritize_new_leads: false, daily_max_leads: bot.daily_new,
  };
}

// Make sure the bot's campaign for this email set exists and is running; returns its id.
export async function ensureCampaign(env, bot, key, kind, base, log) {
  const ids = json(bot.ext_campaign, {}) || {};
  if (ids[kind]) return ids[kind];
  const c = await call(key, "/campaigns", { method: "POST", body: JSON.stringify(campaignBody(bot, kind, base)) });
  ids[kind] = c.id;
  bot.ext_campaign = JSON.stringify(ids);
  await env.DB.prepare("UPDATE bots SET ext_campaign = ?2 WHERE id = ?1").bind(bot.id, bot.ext_campaign).run();
  try { await call(key, `/campaigns/${c.id}/activate`, { method: "POST", body: "{}" }); }
  catch (e) { await log(env, bot, null, "error", `Created the Instantly campaign “${c.name || bot.name}” but couldn't start it: ${e.message}. Add sending accounts to it in Instantly, then start it there.`); }
  await log(env, bot, null, "run", `Created the Instantly campaign “${c.name || bot.name}” with the ${bot.touches}-day flow`);
  return c.id;
}

export async function pushLead(key, campaignId, lead) {
  const r = await call(key, "/leads", { method: "POST", body: JSON.stringify({ campaign: campaignId, skip_if_in_campaign: true, ...lead }) });
  return r?.id || null;
}

// Read lead activity back. Returns [{ email, opens, clicks, replies, status }] (status: 1 active, 2 paused,
// 3 completed, -1 bounced, -2 unsubscribed, -3 skipped).
export async function leadStats(key, campaignId, max = 2000) {
  const out = [];
  let after;
  for (let i = 0; i < Math.ceil(max / 100); i++) {
    const r = await call(key, "/leads/list", { method: "POST", body: JSON.stringify({ campaign: campaignId, limit: 100, ...(after && { starting_after: after }) }) });
    for (const l of r?.items || []) out.push({ email: String(l.email || "").toLowerCase(), opens: +l.email_open_count || 0, clicks: +l.email_click_count || 0, replies: +l.email_reply_count || 0, status: +l.status || 0, last_open: l.timestamp_last_open || null });
    after = r?.next_starting_after;
    if (!after || !(r?.items || []).length) break;
  }
  return out;
}
