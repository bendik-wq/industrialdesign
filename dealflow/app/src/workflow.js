// Runs one search in the background: plan → fetch pages → score → save. Each page batch is its own durable
// step, so a slow registry or a transient error retries that batch instead of the whole search.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { PROVIDERS } from "./providers.js";
import { industryById } from "./data/industries.js";
import { saveCompanies } from "./store.js";

const RETRY = { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };

export class SearchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { searchId } = event.payload;
    const db = this.env.DB;
    const search = await step.do("load search", async () => db.prepare("SELECT * FROM searches WHERE id = ?1").bind(searchId).first());
    if (!search) return;
    const provider = PROVIDERS[search.country];
    const industry = industryById(search.industry);
    const params = { codes: industry[search.country] || [], industry, region: search.region, minStaff: search.min_staff };

    try {
      const plan = await step.do("plan", RETRY, async () => {
        const p = await provider.plan(this.env, params);
        await db.prepare("UPDATE searches SET status = 'running', total = ?2, pages = ?3 WHERE id = ?1").bind(searchId, p.total, p.pages).run();
        return p;
      });

      const state = {}; // carries Google's nextPageToken between pages
      // Resume after the last saved page when a failed search is retried.
      const start = (search.status === "failed" ? search.pages_done : 0) + 1;
      for (let first = start; first <= plan.pages; first += provider.pagesPerStep) {
        // Sleeping hands the instance back to the engine, so the next batch runs in a fresh invocation with a
        // fresh subrequest budget (50 on the Workers Free plan).
        if (first > start) await step.sleep(`pause before page ${first}`, "1 second");
        const last = Math.min(plan.pages, first + provider.pagesPerStep - 1);
        const res = await step.do(`pages ${first}-${last}`, RETRY, async () => {
          let saved = 0, empty = false;
          for (let page = first; page <= last; page++) {
            const companies = await provider.fetchPage(this.env, params, page, state);
            saved += await saveCompanies(db, searchId, companies);
            if (!companies.length && provider.id === "us") { empty = true; break; }
            if (provider.id === "fr") await new Promise((r) => setTimeout(r, 400)); // ~2.5 req/s, under the 7/s cap
          }
          await db.prepare(
            "UPDATE searches SET pages_done = ?2, found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1) WHERE id = ?1"
          ).bind(searchId, last).run();
          return { saved, empty, nextPageToken: state.nextPageToken ?? null };
        });
        state.nextPageToken = res.nextPageToken;
        if (res.empty) break;
      }

      await step.do("finish", async () => {
        await db.prepare(
          "UPDATE searches SET status = 'done', finished_at = ?2, found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1) WHERE id = ?1"
        ).bind(searchId, new Date().toISOString()).run();
      });
    } catch (err) {
      await step.do("mark failed", async () => {
        await db.prepare("UPDATE searches SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1")
          .bind(searchId, String(err?.message || err).slice(0, 500), new Date().toISOString()).run();
      });
      throw err;
    }
  }
}
