// The agent toolbelt: one definition of everything an agent can do in Warplan. Used by Josh (agent loop), the MCP
// server (Claude, ChatGPT, Cursor and any MCP client), the REST agent endpoint and the autopilot.
// Every tool runs as the calling user, inside their workspace, through the same code paths as the UI.
import { listTargets, getTarget, createTarget, updateTarget, addEvent, targetFacts } from "./pipeline.js";
import { createDocument } from "./documents.js";
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
  asking: { type: "number" }, currency: { type: "string", enum: ["$", "€", "£", "NOK "] },
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
export async function runTool(env, ctx, ai, hooks, name, input) {
  const tool = toolByName(name);
  if (!tool) return { ok: false, result: { error: `Unknown tool ${name}` } };
  if (input == null || typeof input !== "object" || Array.isArray(input)) return { ok: false, result: { error: "Tool input must be a JSON object" } };
  for (const req of tool.input_schema.required || []) if (input[req] == null || input[req] === "") return { ok: false, result: { error: `Missing ${req}` } };
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
