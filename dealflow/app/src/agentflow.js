// Executes one agent run: source → shortlist → per-company work → report. Every unit of work is a durable step,
// so a slow model call or registry hiccup retries just that piece, and progress is logged for the UI.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { brief, letter } from "./ai.js";
import { recommend } from "../public/deal.js";
import { createSearch, company, saveAi, accountContext } from "./index.js"; // circular import is fine: used at run time only

const RETRY = { retries: { limit: 3, delay: "20 seconds", backoff: "exponential" }, timeout: "5 minutes" };
const FRESH_DAYS = 7;

export class AgentWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { runId } = event.payload;
    const db = this.env.DB;
    const log = (text, kind = "info") => db.prepare(
      `UPDATE agent_runs SET log = json_insert(log, '$[#]', json_object('at', ?2, 'kind', ?3, 'text', ?4)) WHERE id = ?1`
    ).bind(runId, new Date().toISOString(), kind, text).run();

    const { run, agent } = await step.do("load", async () => {
      const r = await db.prepare("SELECT * FROM agent_runs WHERE id = ?1").bind(runId).first();
      const a = await db.prepare("SELECT * FROM agents WHERE id = ?1").bind(r.agent_id).first();
      await db.prepare("UPDATE agent_runs SET status = 'running' WHERE id = ?1").bind(runId).run();
      return { run: r, agent: a };
    });
    const cfg = JSON.parse(agent.config);
    const ctx = await accountContext(this.env, agent.account_id);

    try {
      // 1. Source: reuse a recent finished search with the same parameters, otherwise start one and wait.
      const searchId = await step.do("source", RETRY, async () => {
        const fresh = await db.prepare(
          `SELECT id FROM searches WHERE country = ?1 AND industry = ?2 AND IFNULL(region, '') = IFNULL(?3, '') AND min_staff = ?4
             AND status = 'done' AND created_at > ?5 AND account_id = ?6 ORDER BY id DESC LIMIT 1`
        ).bind(cfg.country, cfg.industry, cfg.region, cfg.minStaff, new Date(Date.now() - FRESH_DAYS * 864e5).toISOString(), agent.account_id).first();
        if (fresh) { await log(`Using search #${fresh.id} from the last ${FRESH_DAYS} days.`); return fresh.id; }
        const s = await createSearch(this.env, { country: cfg.country, industry: cfg.industry, region: cfg.region, minStaff: cfg.minStaff }, ctx);
        await log(`Started a fresh registry search (#${s.id}): ${s.label}.`);
        return s.id;
      });
      await db.prepare("UPDATE agent_runs SET search_id = ?2 WHERE id = ?1").bind(runId, searchId).run();
      for (let i = 0; i < 90; i++) {
        const s = await step.do(`check search ${i}`, async () => db.prepare("SELECT status, found, pages_done, pages FROM searches WHERE id = ?1").bind(searchId).first());
        if (s.status === "done") { if (i) await step.do("log search done", () => log(`Search finished: ${s.found} companies.`)); break; }
        if (s.status === "failed") throw new Error("The registry search failed. Open the search to re-run it.");
        if (i === 89) throw new Error("The registry search is taking too long. The agent will pick it up on the next run.");
        await step.sleep(`wait for search ${i}`, "30 seconds");
      }

      // 2. Shortlist.
      const picks = await step.do("shortlist", async () => {
        const where = ["c.excluded = 0", "NOT EXISTS (SELECT 1 FROM agent_targets t WHERE t.agent_id = ?2 AND t.company_id = c.id)"];
        const binds = [searchId, agent.id];
        if (cfg.minOwnerAge) { binds.push(cfg.minOwnerAge); where.push(`c.owner_age >= ?${binds.length}`); }
        if (cfg.minValue) { binds.push(cfg.minValue); where.push(`c.valuation_mid >= ?${binds.length}`); }
        if (cfg.maxValue) { binds.push(cfg.maxValue); where.push(`c.valuation_mid <= ?${binds.length}`); }
        binds.push(cfg.topN);
        const { results } = await db.prepare(
          `SELECT c.id, c.name FROM companies c JOIN search_results r ON r.company_id = c.id AND r.search_id = ?1
           WHERE ${where.join(" AND ")} ORDER BY c.fit_score DESC, c.id LIMIT ?${binds.length}`
        ).bind(...binds).all();
        await log(results.length ? `Shortlisted ${results.length}: ${results.slice(0, 5).map((r) => r.name).join(", ")}${results.length > 5 ? "…" : ""}` : "No new companies match the criteria this time.");
        return results;
      });

      // 3. Work each company.
      const me = JSON.parse(agent.buyer || "{}");
      for (const pick of picks) {
        await step.do(`work ${pick.id}`, RETRY, async () => {
          const c = await company(this.env, pick.id, ctx);
          const deal = recommend(c);
          const done = [];
          if (cfg.brief) {
            const b = await brief(this.env, c);
            await saveAi(db, agent.account_id, c.id, "brief", b);
            done.push("brief");
          }
          if (cfg.letter) {
            const l = await letter(this.env, c, me, cfg.voice);
            await saveAi(db, agent.account_id, c.id, "letter", l);
            done.push("letter");
          }
          if (cfg.stage) {
            await db.prepare(
              `INSERT INTO pipeline (account_id, company_id, status, notes, updated_at) VALUES (?5, ?1, ?2, ?3, ?4)
               ON CONFLICT (account_id, company_id) DO UPDATE SET status = CASE WHEN status IN ('New', 'Researching') THEN ?2 ELSE status END, updated_at = ?4`
            ).bind(c.id, cfg.stage, `Added by agent “${agent.name}”.`, new Date().toISOString(), agent.account_id).run();
          }
          await db.prepare("INSERT OR IGNORE INTO agent_targets (agent_id, company_id, run_id, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(agent.id, c.id, runId, new Date().toISOString()).run();
          await log(`${c.name}: ${c.summary || "scored"}${deal ? `; self-funding price ${Math.round(deal.fundablePrice).toLocaleString()} ${c.currency}` : ""}${done.length ? `; wrote ${done.join(" + ")}` : ""}.`, "target");
        });
      }

      // 4. Report.
      await step.do("report", async () => {
        const summary = picks.length
          ? `Worked ${picks.length} ${picks.length === 1 ? "company" : "companies"} from search #${searchId}.${cfg.stage ? ` Moved to ${cfg.stage}.` : ""}`
          : "Nothing new this time. The agent will look again on its next run.";
        await db.batch([
          db.prepare("UPDATE agent_runs SET status = 'done', finished_at = ?2, summary = ?3, targets = ?4 WHERE id = ?1").bind(runId, new Date().toISOString(), summary, picks.length),
          db.prepare("UPDATE agents SET last_run_at = ?2 WHERE id = ?1").bind(agent.id, new Date().toISOString()),
        ]);
        await log(summary, "done");
      });
    } catch (err) {
      await step.do("fail", async () => {
        const msg = String(err?.message || err).slice(0, 400);
        await db.prepare("UPDATE agent_runs SET status = 'failed', finished_at = ?2, summary = ?3 WHERE id = ?1").bind(runId, new Date().toISOString(), msg).run();
        await log(msg, "error");
      });
    }
  }
}

