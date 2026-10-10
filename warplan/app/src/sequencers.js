// Cold-email sequencers: push pipeline targets into an Instantly, Smartlead or EmailBison campaign, and bring the
// replies back. A reply webhook (one secret URL per workspace, pasted into the sequencer) lands every reply on the
// target's timeline, has the AI read it (interested, meeting, later, out of office, not interested, unsubscribe,
// wrong person), moves the target on, suppresses opt-outs and queues a drafted answer in the Inbox for approval.
// ListKit has no public API: export a list from ListKit as CSV and import it on the Pipeline page (headers map).
import { providerKeys } from "./keys.js";
import { listContacts } from "./contacts.js";
import { updateTarget, getTarget } from "./pipeline.js";
import { chatJson } from "./ai.js";
import { propose } from "./approvals.js";
import { sha256, randomToken } from "./auth.js";
import { STAGES } from "../public/js/deal.js";

export const SEQUENCERS = ["instantly", "smartlead", "emailbison"];
const LABEL = { instantly: "Instantly", smartlead: "Smartlead", emailbison: "EmailBison" };
const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const MAX_PUSH = 200;

async function req(name, url, init = {}) {
  const res = await fetch(url, { ...init, headers: { Accept: "application/json", ...(init.body && { "Content-Type": "application/json" }), ...(init.headers || {}) } });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 200) }; }
  if (res.status === 401 || res.status === 403) throw err(400, `${name} rejected the API key`);
  if (!res.ok) throw err(res.status === 404 ? 404 : res.status === 422 || res.status === 400 ? 400 : 502, `${name}: ${data?.message || data?.error || (data?.errors && JSON.stringify(data.errors).slice(0, 200)) || `answered ${res.status}`}`);
  return data;
}

// One adapter per sequencer: list campaigns, add leads to one.
const ADAPTERS = {
  instantly: {
    async campaigns({ key }) {
      const d = await req("Instantly", "https://api.instantly.ai/api/v2/campaigns?limit=100", { headers: { Authorization: `Bearer ${key}` } });
      return (d.items || d.data || []).map((c) => ({ id: c.id, name: c.name, status: ({ 0: "draft", 1: "active", 2: "paused", 3: "completed" })[c.status] ?? String(c.status ?? "") }));
    },
    async push({ key }, campaignId, leads) {
      const toLead = (l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company_name: l.company, phone: l.phone, website: l.website, personalization: l.personalization, custom_variables: l.custom });
      try {
        const d = await req("Instantly", "https://api.instantly.ai/api/v2/leads/add", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ campaign_id: campaignId, leads: leads.map(toLead), skip_if_in_campaign: true }) });
        return { ok: leads.map((l) => l.email), failed: [], note: d.leads_uploaded != null ? `${d.leads_uploaded} uploaded` : "" };
      } catch (e) {
        if (e.status !== 404) throw e;
        // Older accounts: one lead at a time.
        const ok = [], failed = [];
        for (const l of leads) {
          try { await req("Instantly", "https://api.instantly.ai/api/v2/leads", { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ campaign: campaignId, ...toLead(l) }) }); ok.push(l.email); }
          catch (x) { failed.push({ email: l.email, error: x.message }); }
        }
        return { ok, failed };
      }
    },
  },
  smartlead: {
    async campaigns({ key }) {
      const d = await req("Smartlead", `https://server.smartlead.ai/api/v1/campaigns?api_key=${encodeURIComponent(key)}`);
      return (Array.isArray(d) ? d : d.data || []).map((c) => ({ id: String(c.id), name: c.name, status: String(c.status || "").toLowerCase() }));
    },
    async push({ key }, campaignId, leads) {
      const out = { ok: [], failed: [] };
      for (let i = 0; i < leads.length; i += 100) {
        const chunk = leads.slice(i, i + 100);
        const d = await req("Smartlead", `https://server.smartlead.ai/api/v1/campaigns/${encodeURIComponent(campaignId)}/leads?api_key=${encodeURIComponent(key)}`, {
          method: "POST",
          body: JSON.stringify({
            lead_list: chunk.map((l) => ({ email: l.email, first_name: l.first_name, last_name: l.last_name, company_name: l.company, phone_number: l.phone, website: l.website, location: l.location, linkedin_profile: l.linkedin, custom_fields: { ...l.custom, ...(l.personalization && { personalization: l.personalization }) } })),
            settings: { ignore_global_block_list: false, ignore_unsubscribe_list: false, ignore_duplicate_leads_in_other_campaign: false },
          }),
        });
        out.ok.push(...chunk.map((l) => l.email));
        if (d.invalid_email_count) out.note = `${d.invalid_email_count} rejected as invalid`;
      }
      return out;
    },
  },
  emailbison: {
    async campaigns({ key, meta }) {
      const d = await req("EmailBison", `${meta.baseUrl}/api/campaigns`, { headers: { Authorization: `Bearer ${key}` } });
      return (d.data || d || []).map((c) => ({ id: String(c.id), name: c.name, status: String(c.status || "").toLowerCase() }));
    },
    async push({ key, meta }, campaignId, leads) {
      const ids = [], ok = [], failed = [];
      for (const l of leads) {
        try {
          const d = await req("EmailBison", `${meta.baseUrl}/api/leads`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ first_name: l.first_name || "there", last_name: l.last_name || "-", email: l.email, company: l.company, title: l.title || undefined, notes: l.personalization || undefined }) });
          const id = d.data?.id ?? d.id;
          if (id != null) { ids.push(id); ok.push(l.email); } else failed.push({ email: l.email, error: "No lead id returned" });
        } catch (e) { failed.push({ email: l.email, error: e.message }); }
      }
      if (ids.length) await req("EmailBison", `${meta.baseUrl}/api/campaigns/${encodeURIComponent(campaignId)}/leads/attach-leads`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ lead_ids: ids }) });
      return { ok, failed };
    },
  },
};

async function keysFor(env, ctx, provider) {
  if (!SEQUENCERS.includes(provider)) throw err(400, "Pick Instantly, Smartlead or EmailBison");
  const k = (await providerKeys(env, ctx, [provider]))[provider];
  if (!k) throw err(400, `Connect ${LABEL[provider]} under Settings → Integrations first`);
  return k;
}

export async function connectedSequencers(env, ctx) {
  const keys = await providerKeys(env, ctx, SEQUENCERS);
  return SEQUENCERS.map((id) => ({ id, label: LABEL[id], connected: !!keys[id] }));
}

export async function listCampaigns(env, ctx, provider) {
  return { provider, campaigns: await ADAPTERS[provider].campaigns(await keysFor(env, ctx, provider)) };
}

// Target → lead: the owner's best real email (never a guess), their name split, and the facts a sequence can merge.
async function leadFor(env, ctx, t) {
  const contacts = await listContacts(env, ctx, t.id);
  const real = (c) => c.kind === "email" && c.confidence !== "guess";
  const email = (contacts.find((c) => real(c) && /\(owner\)/.test(c.label)) || contacts.find((c) => real(c) && /\(decision maker\)/.test(c.label)))?.value || (t.email || "").toLowerCase() || contacts.find(real)?.value;
  if (!email) return null;
  const parts = String(t.owner_name || "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter(Boolean);
  const titleCase = (s) => (s && s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);
  return {
    target_id: t.id, email, first_name: titleCase(parts[0] || ""), last_name: titleCase(parts.length > 1 ? parts[parts.length - 1] : ""), company: t.name, phone: t.phone || undefined, website: t.website || undefined, location: t.location || undefined,
    linkedin: contacts.find((c) => c.kind === "linkedin")?.value,
    custom: { industry: t.industry || "", city: (t.location || "").split(",")[0], ...(t.owner_age && { owner_age: String(t.owner_age) }), ...(t.employees && { employees: String(t.employees) }) },
  };
}

// One short, specific opening line per lead, written from what's on file (no numbers, no price talk).
async function personalize(ai, leads, targets) {
  const facts = leads.map((l) => { const t = targets.find((x) => x.id === l.target_id); return `${l.target_id}: ${t.name} · ${t.industry || ""} · ${t.location || ""} · owner ${t.owner_name || "unknown"}${t.owner_age ? `, ${t.owner_age}` : ""} · ${(t.motivation || "").slice(0, 200)}`; }).join("\n");
  try {
    const { data: r } = await chatJson(ai, "You write the first line of a cold email from someone who buys and keeps well-run local businesses to the owner. One sentence, under 25 words, specific to the company (its town, trade, how long it has run), warm, no flattery clichés, no numbers, no mention of buying, price or valuation. Same language as the company's country.",
      `Write one opening line for each company. Return {"lines":[{"id":<id>,"line":"..."}]}.\n${facts}`,
      { type: "object", properties: { lines: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, line: { type: "string" } }, required: ["id", "line"], additionalProperties: false } } }, required: ["lines"], additionalProperties: false }, 2500, "low");
    for (const x of r.lines || []) { const l = leads.find((y) => y.target_id === +x.id); if (l) l.personalization = String(x.line).slice(0, 300); }
  } catch (e) { console.warn("personalize", e.message); }
}

export async function pushToCampaign(env, ctx, b, hooks, ai) {
  const provider = String(b.provider || "");
  const k = await keysFor(env, ctx, provider);
  const campaignId = String(b.campaign_id || "").trim();
  if (!campaignId) throw err(400, "Pick a campaign");
  const ids = [...new Set((Array.isArray(b.target_ids) ? b.target_ids : [b.target_id]).map(Number).filter(Boolean))].slice(0, MAX_PUSH);
  if (!ids.length) throw err(400, "Pick at least one target");
  const { results: targets } = await env.DB.prepare(`SELECT * FROM targets WHERE account_id = ?1 AND id IN (${ids.map((_, i) => `?${i + 2}`).join(",")})`).bind(ctx.accountId, ...ids).all();
  const { results: blocked } = await env.DB.prepare("SELECT email FROM suppressions WHERE account_id = ?1").bind(ctx.accountId).all();
  const suppressed = new Set(blocked.map((x) => x.email));
  const leads = [], skipped = [];
  for (const t of targets) {
    const l = await leadFor(env, ctx, t);
    if (!l) skipped.push({ target_id: t.id, name: t.name, why: "no email on file (run Find contacts or Deep enrich)" });
    else if (suppressed.has(l.email)) skipped.push({ target_id: t.id, name: t.name, why: "opted out" });
    else leads.push(l);
  }
  if (!leads.length) return { pushed: 0, skipped, receipt: "Nothing pushed: none of those targets has a usable email yet" };
  if (b.personalize !== false && ai) await personalize(ai, leads, targets);
  const campaignName = String(b.campaign_name || "").slice(0, 120);
  const r = await ADAPTERS[provider].push(k, campaignId, leads);
  const stamp = now(), okSet = new Set(r.ok), stmts = [];
  for (const l of leads) {
    const ok = okSet.has(l.email), fail = r.failed.find((f) => f.email === l.email);
    stmts.push(env.DB.prepare(`INSERT INTO campaign_leads (account_id, target_id, provider, campaign_id, campaign_name, email, status, error, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
      ON CONFLICT (account_id, provider, campaign_id, email) DO UPDATE SET status = ?7, error = ?8`).bind(ctx.accountId, l.target_id, provider, campaignId, campaignName, l.email, ok ? "pushed" : "failed", fail?.error || null, stamp));
    if (ok) stmts.push(env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'email', ?5, ?6)").bind(ctx.accountId, l.target_id, ctx.user.id || null, ctx.user.name || ctx.user.email || "Agent", `Added to ${LABEL[provider]} campaign${campaignName ? ` “${campaignName}”` : ""} as ${l.email}.${l.personalization ? ` Opening line: “${l.personalization}”` : ""}`, stamp));
  }
  stmts.push(env.DB.prepare(`UPDATE targets SET stage = 'contacted', stage_at = ?2, updated_at = ?2 WHERE account_id = ?1 AND stage = 'sourced' AND id IN (${leads.filter((l) => okSet.has(l.email)).map((l) => +l.target_id).join(",") || "0"})`).bind(ctx.accountId, stamp));
  await env.DB.batch(stmts);
  hooks?.emit("campaign.pushed", { provider, campaign_id: campaignId, count: r.ok.length });
  return { pushed: r.ok.length, failed: r.failed, skipped, note: r.note || undefined, receipt: `Pushed ${r.ok.length} lead${r.ok.length === 1 ? "" : "s"} to ${LABEL[provider]}${campaignName ? ` · ${campaignName}` : ""}${skipped.length ? ` (${skipped.length} skipped: no email or opted out)` : ""}` };
}

// ------------------------------------------------------------------ replies
export async function replyHookInfo(env, ctx) {
  const row = await env.DB.prepare("SELECT data, updated_at FROM settings WHERE account_id = ?1 AND key = 'reply_hook'").bind(ctx.accountId).first();
  const { results } = await env.DB.prepare("SELECT r.id, r.target_id, r.provider, r.from_email, r.subject, r.category, r.summary, r.created_at, t.name AS target_name FROM replies r LEFT JOIN targets t ON t.id = r.target_id AND t.account_id = r.account_id WHERE r.account_id = ?1 ORDER BY r.id DESC LIMIT 30").bind(ctx.accountId).all();
  return { configured: !!row, created_at: row?.updated_at || null, replies: results };
}
// A new secret URL (shown once). Making a new one retires the old.
export async function rotateReplyHook(env, ctx, origin) {
  const token = randomToken("rh_");
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'reply_hook', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(ctx.accountId, JSON.stringify({ hash: await sha256(token) }), now()).run();
  return { url: `${origin}/hooks/replies/${token}` };
}
export async function accountForReplyHook(env, token) {
  if (!/^rh_[\w-]{20,}$/.test(token)) return null;
  return env.DB.prepare("SELECT s.account_id, a.name AS account_name FROM settings s JOIN accounts a ON a.id = s.account_id WHERE s.key = 'reply_hook' AND json_extract(s.data, '$.hash') = ?1 AND a.active = 1").bind(await sha256(token)).first();
}

// Every sequencer shapes its webhook differently; pull out who replied, the subject and the text.
export function parseReply(payload) {
  const strings = [];
  const walk = (v, key = "", depth = 0) => {
    if (depth > 6 || v == null) return;
    if (typeof v === "string") strings.push([key.toLowerCase(), v]);
    else if (Array.isArray(v)) v.slice(0, 20).forEach((x) => walk(x, key, depth + 1));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k, depth + 1);
  };
  walk(payload);
  const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
  const pref = ["lead_email", "lead.email", "sl_lead_email", "data.lead.email", "from_email", "reply.from_email_address", "from_email_address", "from", "email", "to_email"];
  const emails = strings.filter(([, v]) => EMAIL.test(v.trim())).sort((a, b) => {
    const rank = (k) => { const i = pref.findIndex((p) => k === p || k.endsWith(`.${p}`)); return i < 0 ? 99 : i; };
    return rank(a[0]) - rank(b[0]);
  }).map(([, v]) => v.trim().toLowerCase());
  const text = strings.filter(([k]) => /(reply_text|text_body|reply_message|reply_body|reply\.text|message\.text|body|text|snippet|content)$/.test(k)).map(([, v]) => v.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).sort((a, b) => b.length - a.length)[0] || "";
  const subject = strings.find(([k]) => /subject$/.test(k))?.[1] || "";
  const event = strings.find(([k]) => /(^|\.)(event_type|event|type)$/.test(k))?.[1] || "";
  return { emails: [...new Set(emails)], text: text.slice(0, 8000), subject: subject.slice(0, 300), event };
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["interested", "meeting", "later", "ooo", "not_interested", "unsubscribe", "wrong_person", "question", "other"] },
    summary: { type: "string" }, next_action: { type: "string" }, days_until_next: { type: "integer" },
    draft_reply: { type: "string", description: "Empty if no reply should be sent" },
  },
  required: ["category", "summary", "next_action", "days_until_next", "draft_reply"], additionalProperties: false,
};
const TRIAGE_SYSTEM = `You read replies to cold emails sent by a buyer of small, well-run private companies to their owners. Classify the reply:
interested (open to talking), meeting (proposes or accepts a time), question (asks who we are / what this is about), later (not now, try again at a stated time), ooo (auto-reply / out of office), not_interested (no thanks), unsubscribe (asks to be removed or not contacted), wrong_person (not the owner / forward to someone), other.
summary: one line on what they said. next_action: the buyer's next move, short and concrete. days_until_next: when to do it (0 today; ooo = the day after they return or 7; later = when they said, or 90).
draft_reply: for interested, meeting, question and wrong_person, a short, warm reply in the same language they wrote in, from the buyer, that moves to a phone call (suggest two times or ask for theirs). Never mention price, multiples or numbers. Sign off with just "Best," and nothing after. Otherwise empty.`;

export async function handleReply(env, account, payload, ai, hooks, provider = "") {
  const ctx = { accountId: account.account_id, user: { id: null, name: "Reply triage", email: "" }, account: { id: account.account_id, name: account.account_name }, isOwner: false };
  const p = parseReply(payload);
  if (!p.text && !p.emails.length) return { ok: true, ignored: "no reply in payload" };
  const today = (await env.DB.prepare("SELECT COUNT(*) AS n FROM replies WHERE account_id = ?1 AND created_at >= ?2").bind(ctx.accountId, now().slice(0, 10)).first()).n;
  if (today >= 500) return { ok: false, ignored: "daily reply limit" };
  // Match a target by any email in the payload: contacts, the target's own email, or what was pushed to a campaign.
  let target = null, from = p.emails[0] || "";
  for (const e of p.emails) {
    const row = await env.DB.prepare(`SELECT id FROM targets WHERE account_id = ?1 AND (lower(email) = ?2 OR id IN (SELECT target_id FROM contacts WHERE account_id = ?1 AND value = ?2) OR id IN (SELECT target_id FROM campaign_leads WHERE account_id = ?1 AND email = ?2)) LIMIT 1`).bind(ctx.accountId, e).first();
    if (row) { target = await getTarget(env, ctx, row.id); from = e; break; }
  }
  let tri;
  try { ({ data: tri } = await chatJson(ai, TRIAGE_SYSTEM, `Company: ${target ? `${target.name} (${target.industry || ""}, ${target.location || ""}), owner ${target.owner_name || "unknown"}` : "unknown"}\nSubject: ${p.subject}\nReply:\n${p.text || "(empty)"}`, TRIAGE_SCHEMA, 1200, "low")); }
  catch (e) { console.warn("triage", e.message); tri = { category: "other", summary: p.text.slice(0, 160), next_action: "Read the reply and answer", days_until_next: 0, draft_reply: "" }; }
  const cat = TRIAGE_SCHEMA.properties.category.enum.includes(tri.category) ? tri.category : "other";
  const stamp = now();
  await env.DB.prepare("INSERT INTO replies (account_id, target_id, provider, from_email, subject, body, category, summary, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(ctx.accountId, target?.id || null, provider, from, p.subject, p.text, cat, String(tri.summary || "").slice(0, 400), stamp).run();
  if (from) await env.DB.prepare("UPDATE campaign_leads SET status = 'replied' WHERE account_id = ?1 AND email = ?2").bind(ctx.accountId, from).run();
  if (from && cat === "unsubscribe") await env.DB.prepare("INSERT OR IGNORE INTO suppressions (account_id, email, reason, created_at) VALUES (?1, ?2, 'Asked to be removed (reply)', ?3)").bind(ctx.accountId, from, stamp).run();
  if (!target) { hooks?.emit("reply.received", { from, category: cat, summary: tri.summary, target_id: null }); return { ok: true, matched: false, category: cat }; }

  const label = { interested: "Interested", meeting: "Wants to meet", question: "Asked a question", later: "Later", ooo: "Out of office", not_interested: "Not interested", unsubscribe: "Unsubscribed", wrong_person: "Wrong person", other: "Reply" }[cat];
  await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, ?3, 'email', ?4, ?5)")
    .bind(ctx.accountId, target.id, `${provider ? LABEL[provider] || provider : "Email"} reply`, `Reply from ${from} · ${label}: ${tri.summary}\n\n> ${p.text.slice(0, 1500).replace(/\n/g, "\n> ")}`, stamp).run();
  const due = new Date(Date.now() + Math.max(0, Math.min(365, +tri.days_until_next || 0)) * 864e5).toISOString().slice(0, 10);
  const idx = (id) => STAGES.findIndex((s) => s.id === id);
  const fields = { next_action: String(tri.next_action || "").slice(0, 300), next_date: due };
  if (["interested", "meeting", "question"].includes(cat)) { fields.priority = 1; if (idx(target.stage) < idx("contacted")) fields.stage = "contacted"; }
  if (cat === "meeting" && idx(target.stage) < idx("first_call")) fields.stage = "first_call";
  if (cat === "not_interested") { fields.priority = 3; fields.next_date = new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10); }
  // An email opt-out covers that address (suppressed above), not the company: a call or letter to the owner can still be fine.
  if (cat === "unsubscribe") { fields.next_action = `No more email to ${from} (opted out)`; fields.next_date = null; fields.priority = 3; }
  await updateTarget(env, ctx, target.id, fields, hooks);
  let inbox = null;
  if (tri.draft_reply && from && cat !== "unsubscribe") {
    inbox = await propose(env, ctx.accountId, { tool: "send_email", input: { to: from, subject: p.subject ? (/^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`) : `Re: ${target.name}`, body: tri.draft_reply, target_id: target.id }, target_id: target.id, title: `Answer ${target.owner_name || from} (${label.toLowerCase()})`, reason: `${tri.summary}\n\nTheir words: “${p.text.slice(0, 250)}”`, source: "reply", dedupe: `reply:${target.id}:${stamp.slice(0, 13)}` });
    if (inbox) hooks?.emit("action.proposed", { id: inbox, tool: "send_email", title: `Answer ${from}` });
  }
  hooks?.emit("reply.received", { from, category: cat, summary: tri.summary, target_id: target.id, target: target.name });
  return { ok: true, matched: true, target_id: target.id, category: cat, inbox_id: inbox };
}
