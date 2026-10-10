// The agent toolbelt: one definition of everything an agent can do in Warplan. Used by Josh (agent loop), the MCP
// server (Claude, ChatGPT, Cursor and any MCP client), the REST agent endpoint and the autopilot.
// Every tool runs as the calling user, inside their workspace, through the same code paths as the UI.
import { listTargets, getTarget, createTarget, updateTarget, addEvent, targetFacts } from "./pipeline.js";
import { createDocument } from "./documents.js";
import { scoutSearch, toTarget, SOURCES } from "./scout.js";
import { INDUSTRIES } from "./data/industries.js";
import { enrichTarget, listContacts } from "./contacts.js";
import { sendEmail } from "./mailer.js";
import { dataKeys } from "./keys.js";
import { propose } from "./approvals.js";
import { importTargets } from "./pipeline.js";
import { discover, describe, run as monidRun, result as monidResult, needsApproval, compact, budget } from "./monid.js";
import { deepEnrich, DEEP_ENRICH_PRICE } from "./waterfall.js";
import { SEQUENCERS, listCampaigns, pushToCampaign } from "./sequencers.js";
import { queue as callQueue, logCall, DISPOSITIONS } from "./dialer.js";
import { sendSms } from "./phone.js";
import { STAGES, normalizeDeal, dealModel, maxMultiple, money, structureSummary, targetDeal, DEAL_DEFAULTS } from "../public/js/deal.js";

const STAGE_IDS = STAGES.map((s) => s.id);
const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || id;
const err = (message) => Object.assign(new Error(message), { status: 400, toolError: true });
const short = (t) => ({ id: t.id, name: t.name, stage: stageLabel(t.stage), industry: t.industry || undefined, location: t.location || undefined, owner: t.owner_name || undefined, owner_age: t.owner_age ?? undefined, revenue: t.revenue ?? undefined, ebitda: t.ebitda ?? undefined, currency: t.currency, next_action: t.next_action || undefined, next_date: t.next_date || undefined, priority: t.priority });

const TARGET_PROPS = {
  name: { type: "string", description: "Company name" },
  industry: { type: "string" }, location: { type: "string", description: "Town/region, country" }, website: { type: "string" },
  owner_name: { type: "string" }, owner_age: { type: "integer" }, phone: { type: "string" }, email: { type: "string" },
  employees: { type: "integer" }, revenue: { type: "number", description: "Annual revenue in plain units" }, ebitda: { type: "number", description: "Annual EBITDA in plain units" },
  asking: { type: "number" }, currency: { type: "string", enum: ["$", "€", "£", "A$", "C$"] },
  stage: { type: "string", enum: STAGE_IDS }, priority: { type: "integer", enum: [1, 2, 3], description: "1 high, 2 normal, 3 low" },
  source: { type: "string" }, motivation: { type: "string", description: "What the owner wants, fears, timing" },
  next_action: { type: "string" }, next_date: { type: "string", description: "YYYY-MM-DD" }, tags: { type: "string" },
};
const pick = (o, keys) => Object.fromEntries(Object.entries(o || {}).filter(([k]) => keys.includes(k)));

// `write: true` marks tools that change data (MCP clients show them as non-read-only; the autopilot asks first).
export const TOOLS = [
  {
    name: "search_pipeline", write: false,
    description: "List or search acquisition targets in the user's pipeline. Use before referring to a target by id. Returns id, name, stage, numbers and next action.",
    input_schema: { type: "object", properties: { query: { type: "string", description: "Name, owner, industry, place or tag (optional)" }, stage: { type: "string", enum: STAGE_IDS } } },
    run: async (env, ctx, i) => {
      const q = new URLSearchParams();
      if (i.query) q.set("q", String(i.query)); if (i.stage) q.set("stage", i.stage);
      const rows = await listTargets(env, ctx, q);
      return { count: rows.length, targets: rows.slice(0, 50).map(short) };
    },
  },
  {
    name: "get_target", write: false,
    description: "Full detail for one target: facts, motivation, saved deal structure, timeline of notes and calls, and its documents.",
    input_schema: { type: "object", properties: { target_id: { type: "integer" } }, required: ["target_id"] },
    run: async (env, ctx, i) => {
      const t = await getTarget(env, ctx, +i.target_id);
      return { facts: targetFacts(t), id: t.id, stage: stageLabel(t.stage), has_saved_deal: !!t.deal, timeline: t.events.slice(0, 15).map((e) => `${e.created_at.slice(0, 10)} ${e.kind}: ${e.body.slice(0, 400)}`), documents: t.documents.map((d) => ({ id: d.id, kind: d.kind, title: d.title })) };
    },
  },
  {
    name: "create_target", write: true,
    description: "Add a company to the pipeline. Only name is required; include anything else you know. Defaults to the Sourced stage.",
    input_schema: { type: "object", properties: TARGET_PROPS, required: ["name"] },
    run: async (env, ctx, i, hooks) => {
      const t = await createTarget(env, ctx, pick(i, Object.keys(TARGET_PROPS)), hooks);
      return { created: short(t), receipt: `Added ${t.name} to the pipeline` };
    },
  },
  {
    name: "update_target", write: true,
    description: "Change a target's fields: stage (move it through the pipeline), next_action + next_date, numbers, owner details, motivation, priority. Only send the fields that change.",
    input_schema: { type: "object", properties: { target_id: { type: "integer" }, ...TARGET_PROPS, lost_reason: { type: "string" } }, required: ["target_id"] },
    run: async (env, ctx, i, hooks) => {
      const fields = pick(i, [...Object.keys(TARGET_PROPS), "lost_reason"]);
      if (!Object.keys(fields).length) throw err("Nothing to change");
      const t = await updateTarget(env, ctx, +i.target_id, fields, hooks);
      const what = Object.keys(fields).map((k) => (k === "stage" ? `stage → ${stageLabel(fields.stage)}` : k === "next_action" ? `next action → “${fields.next_action}”` : k === "next_date" ? `due ${fields.next_date}` : k.replace(/_/g, " "))).join(", ");
      return { updated: short(t), receipt: `Updated ${t.name}: ${what}` };
    },
  },
  {
    name: "log_activity", write: true,
    description: "Add an entry to a target's timeline: a call, meeting, email or note. Use it to record what the user tells you happened.",
    input_schema: { type: "object", properties: { target_id: { type: "integer" }, kind: { type: "string", enum: ["note", "call", "email", "meeting"] }, body: { type: "string" } }, required: ["target_id", "body"] },
    run: async (env, ctx, i, hooks) => {
      const e = await addEvent(env, ctx, +i.target_id, { kind: i.kind || "note", body: i.body }, hooks);
      return { logged: e.id, receipt: `Logged a ${e.kind} on the timeline` };
    },
  },
  {
    name: "model_deal", write: false,
    description: "Run the deal engine: price, capital stack, control, DSCR every year, bad-year (EBITDA −20%) DSCR, and the highest multiple the stack can pay at 1.5×. Pass target_id to use that target's saved structure, or give the numbers. Percentages are of the purchase price and should add to 100.",
    input_schema: {
      type: "object",
      properties: {
        target_id: { type: "integer" }, ebitda: { type: "number" }, multiple: { type: "number" }, fcf_pct: { type: "number", description: "Free cash flow as % of EBITDA (default 80)" },
        vendor_pct: { type: "number" }, vendor_years: { type: "number" }, vendor_rate: { type: "number" }, vendor_holiday_months: { type: "number" }, vendor_interest_only_months: { type: "number" },
        bank_pct: { type: "number" }, bank_years: { type: "number" }, bank_rate: { type: "number" },
        rollover_pct: { type: "number" }, investor_pct: { type: "number" }, investor_equity_pct: { type: "number" }, own_cash_pct: { type: "number" },
        non_voting: { type: "boolean", description: "Rollover/investor shares are non-voting (default true)" },
        save_to_target: { type: "boolean", description: "Save this structure as the target's deal (needs target_id)" },
      },
    },
    run: async (env, ctx, i, hooks) => {
      let base = DEAL_DEFAULTS, t = null;
      if (i.target_id) { t = await getTarget(env, ctx, +i.target_id); base = targetDeal(t); }
      const has = (k) => i[k] != null;
      const d = normalizeDeal({
        ...base,
        ebitda: has("ebitda") ? i.ebitda : base.ebitda, multiple: has("multiple") ? i.multiple : base.multiple, fcfPct: has("fcf_pct") ? i.fcf_pct : base.fcfPct, nonVoting: has("non_voting") ? i.non_voting : base.nonVoting,
        vf: { ...base.vf, ...(has("vendor_pct") && { pct: i.vendor_pct }), ...(has("vendor_years") && { years: i.vendor_years }), ...(has("vendor_rate") && { rate: i.vendor_rate }), ...(has("vendor_holiday_months") && { holiday: i.vendor_holiday_months }), ...(has("vendor_interest_only_months") && { io: i.vendor_interest_only_months }) },
        bank: { ...base.bank, ...(has("bank_pct") && { pct: i.bank_pct }), ...(has("bank_years") && { years: i.bank_years }), ...(has("bank_rate") && { rate: i.bank_rate }) },
        roll: { pct: has("rollover_pct") ? i.rollover_pct : base.roll.pct }, inv: { pct: has("investor_pct") ? i.investor_pct : base.inv.pct, stake: has("investor_equity_pct") ? i.investor_equity_pct : base.inv.stake }, own: { pct: has("own_cash_pct") ? i.own_cash_pct : base.own.pct },
      });
      const m = dealModel(d), stress = dealModel(d, d.ebitda * 0.8, d.multiple), c = d.cur;
      let receipt;
      if (i.save_to_target && t) { await updateTarget(env, ctx, t.id, { deal: d }, hooks); receipt = `Saved the structure to ${t.name}`; }
      return {
        works: m.works, funded_pct: m.allocated, control: m.control, buyer_votes_pct: m.yourVotes, buyer_economic_pct: m.yourEconomic,
        price: money(m.price, c), cash_to_seller_at_close: money(m.cashAtClose, c), buyer_cash_in: money(m.cashFromYou, c),
        weakest_year_dscr: m.minDscr ? +m.minDscr.toFixed(2) : null, bad_year_dscr: stress.minDscr ? +stress.minDscr.toFixed(2) : null,
        max_multiple_at_1_5x: maxMultiple(d), years: m.years.map((y) => ({ year: y.y, debt_service: money(y.service, c), dscr: y.dscr ? +y.dscr.toFixed(2) : null })),
        summary: structureSummary(d, m), ...(receipt && { receipt }),
      };
    },
  },
  {
    name: "draft_document", write: true,
    description: "Have a specialist agent write and save a document for a target (board needs no target). kinds: outreach (channel: letter|email|call|voicemail|linkedin, optional language), loi, memo (investment memo), lender (lender pack), plan100 (100-day plan), board (AI board review of the whole pipeline). Takes 10-40 seconds.",
    input_schema: { type: "object", properties: { kind: { type: "string", enum: ["outreach", "loi", "memo", "lender", "plan100", "board"] }, target_id: { type: "integer" }, channel: { type: "string", enum: ["letter", "email", "call", "voicemail", "linkedin"] }, language: { type: "string" } }, required: ["kind"] },
    run: async (env, ctx, i, hooks, ai) => {
      if (i.kind !== "board" && !i.target_id) throw err("This document needs a target_id");
      const d = await createDocument(env, ctx, ai, { kind: i.kind, target_id: i.target_id, channel: i.channel, language: i.language }, hooks, { skipLimits: true });
      return { document_id: d.id, title: d.title, content: d.content.slice(0, 6000), link: `/#/desk/${d.id}`, receipt: `Wrote “${d.title}”` };
    },
  },
  {
    name: "list_documents", write: false,
    description: "List documents the agents have written (letters, LOIs, memos, board packs), optionally for one target.",
    input_schema: { type: "object", properties: { target_id: { type: "integer" } } },
    run: async (env, ctx, i) => {
      const { results } = await env.DB.prepare("SELECT id, kind, title, target_id, updated_at FROM documents WHERE account_id = ?1 AND (?2 IS NULL OR target_id = ?2) ORDER BY id DESC LIMIT 50").bind(ctx.accountId, i.target_id ? +i.target_id : null).all();
      return { documents: results };
    },
  },
  {
    name: "get_document", write: false,
    description: "Read one document in full.",
    input_schema: { type: "object", properties: { document_id: { type: "integer" } }, required: ["document_id"] },
    run: async (env, ctx, i) => {
      const d = await env.DB.prepare("SELECT id, kind, title, target_id, content, updated_at FROM documents WHERE id = ?1 AND account_id = ?2").bind(+i.document_id, ctx.accountId).first();
      if (!d) throw err("Document not found");
      return d;
    },
  },
  {
    name: "find_companies", write: false,
    description: "Scout: find companies to buy. Sources: maps (Google Maps anywhere via Monid: phone, website, rating; ~$0.0002 a page; the default), uk (UK Companies House: directors + birth year, needs a free key), places (Google Maps with your own Google key), osm (OpenStreetMap, free, patchier). Returns candidates; nothing is saved until import_companies",
    input_schema: { type: "object", properties: { source: { type: "string", enum: Object.keys(SOURCES) }, industry: { type: "string", enum: INDUSTRIES.map((i) => i.id) }, region: { type: "string", description: "A city or area, e.g. 'Austin, TX' or 'Manchester, UK'" }, min_staff: { type: "integer" }, page: { type: "integer" } }, required: ["source", "industry"] },
    run: async (env, ctx, i) => {
      const r = await scoutSearch(env, ctx, i, await dataKeys(env, ctx));
      return { total: r.total, more: r.more, currency: r.currency, results: r.results.map((x) => ({ ...x, people: (x.people || []).slice(0, 3) })) };
    },
  },
  {
    name: "import_companies", write: true,
    description: "Add companies returned by find_companies to the pipeline (pass the result objects back unchanged, up to 50). Skips ones already in the pipeline.",
    input_schema: { type: "object", properties: { companies: { type: "array", items: { type: "object" } }, currency: { type: "string" } }, required: ["companies"] },
    run: async (env, ctx, i, hooks) => {
      const rows = (Array.isArray(i.companies) ? i.companies : []).filter((c) => c?.name && !c.in_pipeline).slice(0, 50).map((c) => toTarget(c, i.currency));
      if (!rows.length) throw err("Nothing new to import");
      const r = await importTargets(env, ctx, { rows }, hooks);
      return { imported: r.imported, skipped: r.skipped.length, receipt: `Added ${r.imported} compan${r.imported === 1 ? "y" : "ies"} to the pipeline` };
    },
  },
  {
    name: "find_contacts", write: true,
    description: "Contact finder for one target: reads its website (homepage, contact and about pages) for emails and phone numbers, adds likely owner addresses from the owner's name (marked as guesses), and uses Hunter when connected. Saves what it finds on the target.",
    input_schema: { type: "object", properties: { target_id: { type: "integer" } }, required: ["target_id"] },
    run: async (env, ctx, i) => enrichTarget(env, ctx, +i.target_id, await dataKeys(env, ctx)),
  },
  {
    name: "list_contacts", write: false,
    description: "The emails and phone numbers on file for a target, best first, with where each came from and how sure it is (high, medium, guess).",
    input_schema: { type: "object", properties: { target_id: { type: "integer" } }, required: ["target_id"] },
    run: async (env, ctx, i) => ({ contacts: await listContacts(env, ctx, +i.target_id) }),
  },
  {
    name: "send_email", write: true, approval: true,
    description: "Email someone from the user's own connected mailbox. ALWAYS waits for the user's approval in the Inbox before it is sent, so write the final text. Keep first-contact emails short, personal, no numbers or price talk.",
    input_schema: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string", description: "Plain text. A signature and an opt-out line are added automatically." }, target_id: { type: "integer" } }, required: ["to", "subject", "body"] },
    run: async (env, ctx, i, hooks) => sendEmail(env, ctx, i, hooks),
  },
  {
    name: "deep_enrich", write: true, approval: (env, ctx, i) => (i.mobile ? "Mobile lookups cost about $0.57 each when a number is found" : null),
    title: (i) => `Deep enrich target ${i.target_id}${i.mobile ? " incl. mobile number" : ""}`,
    description: `Deep enrich one target through the Monid data marketplace: finds the website if missing (Google Maps), every published email on the domain with names and titles (Hunter), the owner's address from their name, verifies it won't bounce, and finds the owner's LinkedIn. mobile=true also looks up the owner's mobile (expensive; needs approval). Saves everything on the target. Cost: ${DEEP_ENRICH_PRICE}. Prefer find_contacts first (free); use this when that found no owner email.`,
    input_schema: { type: "object", properties: { target_id: { type: "integer" }, mobile: { type: "boolean" }, linkedin: { type: "boolean", description: "Default true" } }, required: ["target_id"] },
    run: async (env, ctx, i) => deepEnrich(env, ctx, +i.target_id, { mobile: !!i.mobile, linkedin: i.linkedin !== false }),
  },
  {
    name: "monid_discover", write: false,
    description: "Search the Monid marketplace of 2,500+ data, scraping and enrichment APIs (Google Maps, LinkedIn, Hunter, Apollo-style people data, company financials, reviews, job posts, social media, web scraping, phone validation...). Describe what you need in plain words. Returns provider + endpoint + price. Then monid_inspect for the input schema and monid_run to run it.",
    input_schema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    run: async (env, ctx, i) => ({ endpoints: await discover(env, ctx, i.query, i.limit || 8) }),
  },
  {
    name: "monid_inspect", write: false,
    description: "The input schema (body, queryParams, pathParams), price and notes for one Monid endpoint. Always inspect before the first monid_run of an endpoint.",
    input_schema: { type: "object", properties: { provider: { type: "string" }, endpoint: { type: "string" } }, required: ["provider", "endpoint"] },
    run: async (env, ctx, i) => describe(env, ctx, i.provider, i.endpoint),
  },
  {
    name: "monid_run", write: true,
    approval: (env, ctx, i) => needsApproval(env, ctx, i.provider, i.endpoint, i.input || {}),
    title: (i) => `Run ${i.provider} ${i.endpoint}${i.reason ? `: ${String(i.reason).slice(0, 80)}` : ""}`,
    description: "Run one Monid endpoint and get its data (costs money from the workspace's Monid wallet; runs within the monthly budget, and anything over the auto-approve limit or with an unknown total waits for approval in the Inbox). input = {body?, queryParams?, pathParams?} exactly as monid_inspect describes. Always set a result limit (max_results, maxItems, limit) when the endpoint charges per result. Long runs return status RUNNING and a run_id for monid_result.",
    input_schema: { type: "object", properties: { provider: { type: "string" }, endpoint: { type: "string" }, input: { type: "object", properties: { body: { type: "object" }, queryParams: { type: "object" }, pathParams: { type: "object" } } }, reason: { type: "string", description: "Why, in a few words (shown in the Inbox and the spend log)" }, target_id: { type: "integer" } }, required: ["provider", "endpoint"] },
    run: async (env, ctx, i) => {
      const r = await monidRun(env, ctx, { provider: i.provider, endpoint: i.endpoint, input: i.input || {} }, { purpose: i.reason || "Agent", targetId: i.target_id ? +i.target_id : null });
      return { ...r, output: compact(r.output), receipt: `Ran ${i.provider} ${i.endpoint} ($${r.cost_usd.toFixed(4)})` };
    },
  },
  {
    name: "monid_result", write: false,
    description: "Check a Monid run that came back RUNNING, and get its output when it's done.",
    input_schema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"] },
    run: async (env, ctx, i) => { const r = await monidResult(env, ctx, i.run_id); return { ...r, output: compact(r.output) }; },
  },
  {
    name: "data_budget", write: false,
    description: "This month's Monid data spend, the monthly cap, what's left and the auto-approve limit per run.",
    input_schema: { type: "object", properties: {} },
    run: async (env, ctx) => budget(env, ctx),
  },
  {
    name: "list_campaigns", write: false,
    description: "List the campaigns in a connected cold-email sequencer (instantly, smartlead or emailbison) so you can pick one for push_to_campaign.",
    input_schema: { type: "object", properties: { provider: { type: "string", enum: SEQUENCERS } }, required: ["provider"] },
    run: async (env, ctx, i) => listCampaigns(env, ctx, i.provider),
  },
  {
    name: "push_to_campaign", write: true, approval: true,
    title: (i) => `Add ${Array.isArray(i.target_ids) ? i.target_ids.length : 1} target(s) to ${i.provider}${i.campaign_name ? ` “${i.campaign_name}”` : ""}`,
    description: "Add targets as leads to a cold-email campaign in Instantly, Smartlead or EmailBison (the sequencer then emails them on its schedule). Uses each target's best real owner email (never a guess), skips opt-outs, and writes a personal opening line per lead ({{personalization}}). Waits for the user's approval in the Inbox. Sourced targets move to Contacted.",
    input_schema: { type: "object", properties: { provider: { type: "string", enum: SEQUENCERS }, campaign_id: { type: "string" }, campaign_name: { type: "string" }, target_ids: { type: "array", items: { type: "integer" } }, personalize: { type: "boolean", description: "Default true" } }, required: ["provider", "campaign_id", "target_ids"] },
    run: async (env, ctx, i, hooks, ai) => pushToCampaign(env, ctx, i, hooks, ai),
  },
  {
    name: "call_queue", write: false,
    description: "The power dialer's call list: live targets with a phone number, due callbacks first, then by priority and never-called. Includes every number on file per target.",
    input_schema: { type: "object", properties: { stage: { type: "string", enum: STAGE_IDS }, query: { type: "string" } } },
    run: async (env, ctx, i) => {
      const q = new URLSearchParams(); if (i.stage) q.set("stage", i.stage); if (i.query) q.set("q", i.query);
      const r = await callQueue(env, ctx, q);
      return { count: r.queue.length, queue: r.queue.slice(0, 40).map(({ motivation, ...x }) => x) };
    },
  },
  {
    name: "log_call", write: true,
    description: `Log a phone call with a target and move it on. disposition: ${Object.entries(DISPOSITIONS).map(([k, d]) => `${k} (${d.label})`).join(", ")}. Sets the next action and date (override with next_date), advances the stage for connected/interested/meeting.`,
    input_schema: { type: "object", properties: { target_id: { type: "integer" }, disposition: { type: "string", enum: Object.keys(DISPOSITIONS) }, notes: { type: "string" }, next_date: { type: "string", description: "YYYY-MM-DD" }, phone: { type: "string" }, duration: { type: "integer", description: "Seconds" } }, required: ["target_id", "disposition"] },
    run: async (env, ctx, i, hooks) => logCall(env, ctx, i, hooks),
  },
  {
    name: "send_sms", write: true, approval: true,
    title: (i) => `Text ${i.to}: “${String(i.body || "").slice(0, 60)}”`,
    description: "Send a text message from the workspace's Twilio number. ALWAYS waits for the user's approval in the Inbox. Keep it short and personal; never cold-text people who replied STOP.",
    input_schema: { type: "object", properties: { to: { type: "string", description: "+country format" }, body: { type: "string" }, target_id: { type: "integer" } }, required: ["to", "body"] },
    run: async (env, ctx, i, hooks) => sendSms(env, ctx, i, hooks),
  },
  {
    name: "pipeline_overview", write: false,
    description: "The state of the whole pipeline: counts by stage, EBITDA in play, overdue and upcoming next actions, targets with no activity for 14+ days.",
    input_schema: { type: "object", properties: {} },
    run: async (env, ctx) => overview(env, ctx),
  },
];

export async function overview(env, ctx) {
  const today = new Date().toISOString().slice(0, 10), stale = new Date(Date.now() - 14 * 864e5).toISOString();
  const [stages, due, cold] = await env.DB.batch([
    env.DB.prepare("SELECT stage, COUNT(*) AS n, SUM(COALESCE(ebitda, 0)) AS ebitda FROM targets WHERE account_id = ?1 GROUP BY stage").bind(ctx.accountId),
    env.DB.prepare("SELECT id, name, next_action, next_date FROM targets WHERE account_id = ?1 AND stage NOT IN ('closed','lost') AND next_date IS NOT NULL AND next_date <= date(?2, '+7 days') ORDER BY next_date LIMIT 20").bind(ctx.accountId, today),
    env.DB.prepare("SELECT id, name, stage, updated_at FROM targets WHERE account_id = ?1 AND stage NOT IN ('closed','lost') AND updated_at < ?2 ORDER BY updated_at LIMIT 20").bind(ctx.accountId, stale),
  ]);
  return {
    today,
    by_stage: STAGES.map((s) => ({ stage: s.label, count: stages.results.find((x) => x.stage === s.id)?.n || 0 })),
    live_targets: stages.results.filter((x) => !["closed", "lost"].includes(x.stage)).reduce((t, x) => t + x.n, 0),
    ebitda_in_play: stages.results.filter((x) => !["closed", "lost"].includes(x.stage)).reduce((t, x) => t + (x.ebitda || 0), 0),
    overdue: due.results.filter((d) => d.next_date < today), due_this_week: due.results.filter((d) => d.next_date >= today),
    no_activity_14_days: cold.results.map((x) => ({ ...x, stage: stageLabel(x.stage) })),
  };
}

export const toolByName = (name) => TOOLS.find((t) => t.name === name);

// Run one tool call. Never throws: failures come back as {error} so the model can recover.
export async function runTool(env, ctx, ai, hooks, name, input, { approved = false } = {}) {
  const tool = toolByName(name);
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` } };
  if (input == null || typeof input !== "object" || Array.isArray(input)) return { ok: false, result: { error: "Tool input must be a JSON object" } };
  for (const req of tool.input_schema.required || []) if (input[req] == null || input[req] === "") return { ok: false, result: { error: `Missing ${req}` } };
  // Outward, irreversible or costly actions (email, sequencer pushes, pricey data runs) go to the Inbox; a person
  // approves them with one click. `approval` is true, or a function returning a reason (or null to go ahead).
  let why = null;
  if (!approved && tool.approval) {
    try { why = typeof tool.approval === "function" ? await tool.approval(env, ctx, input) : "needs your OK"; }
    catch (e) { return { ok: false, result: { error: e.status ? e.message : "Couldn't check that action. Try again." } }; }
  }
  if (why) {
    const title = name === "send_email" ? `Send “${String(input.subject || "").slice(0, 80)}” to ${input.to}` : tool.title ? tool.title(input) : `Run ${name}`;
    const reason = ["send_email", "send_sms"].includes(name) ? String(input.body || "").slice(0, 400) : typeof why === "string" ? why : "";
    const id = await propose(env, ctx.accountId, { tool: name, input, target_id: input.target_id, title, reason, source: "agent" });
    return { ok: true, result: { queued: true, inbox_id: id, link: "/#/inbox", receipt: `Queued for your approval in the Inbox: ${name === "send_email" ? `email to ${input.to}` : title}` } };
  }
  try {
    return { ok: true, result: await tool.run(env, ctx, input, hooks, ai) };
  } catch (e) {
    if (!e.status) console.error(`tool ${name}`, e);
    return { ok: false, result: { error: e.status ? e.message : "The tool failed. Try again." } };
  }
}

// Shapes for each consumer.
export const anthropicTools = () => TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
export const mcpTools = () => TOOLS.map(({ name, description, input_schema, write }) => ({
  name, description, inputSchema: input_schema,
  annotations: { readOnlyHint: !write, destructiveHint: false, idempotentHint: !write, openWorldHint: false },
}));
export const llamaTools = () => TOOLS.map(({ name, description, input_schema }) => ({ type: "function", function: { name, description, parameters: input_schema } }));
