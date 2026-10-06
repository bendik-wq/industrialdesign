// Runs searches in the background.
//
// A "plan" instance asks the registry how many pages match, then fans out one child instance per batch of pages.
// Every instance is its own Worker invocation, so each batch gets a fresh subrequest budget (50 on the Workers
// Free plan), and children start staggered so the registries' rate limits are respected. Google Places needs
// page tokens in order, so it runs sequentially inside the plan instance (3 requests total).
import { WorkflowEntrypoint } from "cloudflare:workers";
import { PROVIDERS } from "./providers.js";
import { industryById } from "./data/industries.js";
import { saveCompanies } from "./store.js";

const RETRY = { retries: { limit: 5, delay: "15 seconds", backoff: "exponential" }, timeout: "5 minutes" };
// Page batches don't retry in place: a retry would share the failed invocation's subrequest budget. Instead a
// failed batch re-spawns itself as a new instance (fresh budget), up to MAX_ATTEMPTS times.
const ONCE = { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" };
const MAX_ATTEMPTS = 6;

export class SearchWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const { searchId, first, last, delaySeconds = 0, attempt = 1 } = event.payload;
    const db = this.env.DB;
    const search = await step.do("load search", async () => db.prepare("SELECT * FROM searches WHERE id = ?1").bind(searchId).first());
    if (!search) return;
    const provider = PROVIDERS[search.country];
    const industry = industryById(search.industry);
    const params = { codes: industry[search.country] || [], industry, region: search.region, minStaff: search.min_staff };

    if (first) return this.batch(step, search, provider, params, { first, last, delaySeconds, attempt });

    try {
      const plan = await step.do("plan", RETRY, async () => {
        const p = await provider.plan(this.env, params);
        await db.prepare("UPDATE searches SET status = 'running', total = ?2, pages = ?3, pages_done = 0, found = 0, error = NULL WHERE id = ?1")
          .bind(searchId, p.total, p.pages).run();
        return p;
      });
      if (!plan.pages) return this.finish(step, searchId);

      if (provider.sequential) {
        let token = null;
        for (let page = 1; page <= plan.pages; page++) {
          const res = await step.do(`page ${page}`, RETRY, async () => {
            const state = { nextPageToken: token };
            const saved = await saveCompanies(db, searchId, await provider.fetchPage(this.env, params, page, state), search.industry);
            await this.progress(searchId, 1);
            return { saved, nextPageToken: state.nextPageToken || null };
          });
          token = res.nextPageToken;
          if (!token) break;
        }
        return this.finish(step, searchId);
      }

      await step.do("fan out", async () => {
        const batches = [];
        for (let f = 1, i = 0; f <= plan.pages; f += provider.pagesPerStep, i++) {
          batches.push({
            id: `search-${searchId}-p${f}-${Date.now()}`,
            params: { searchId, first: f, last: Math.min(plan.pages, f + provider.pagesPerStep - 1), delaySeconds: i * provider.staggerSeconds },
          });
        }
        for (let i = 0; i < batches.length; i += 100) await this.env.SEARCH.createBatch(batches.slice(i, i + 100));
        return batches.length;
      });
    } catch (err) {
      await this.fail(step, searchId, err);
      throw err;
    }
  }

  async batch(step, search, provider, params, { first, last, delaySeconds, attempt }) {
    if (delaySeconds) await step.sleep("wait for turn", `${delaySeconds} seconds`);
    let error = null;
    try {
      await step.do(`pages ${first}-${last}`, ONCE, async () => {
        let saved = 0;
        for (let page = first; page <= last; page++) {
          saved += await saveCompanies(this.env.DB, search.id, await provider.fetchPage(this.env, params, page), search.industry);
          if (page < last && provider.pauseMs) await new Promise((r) => setTimeout(r, provider.pauseMs));
        }
        return saved;
      });
    } catch (err) {
      error = String(err?.message || err).slice(0, 300);
      if (/D1_ERROR: .*(limit|exceeded)/i.test(error)) attempt = MAX_ATTEMPTS; // retrying can't help until the quota resets
    }
    if (error && attempt < MAX_ATTEMPTS) {
      await step.do("try again in a fresh instance", async () => {
        await this.env.SEARCH.create({
          id: `search-${search.id}-p${first}-a${attempt + 1}-${Date.now()}`,
          params: { searchId: search.id, first, last, delaySeconds: 45 * attempt, attempt: attempt + 1 },
        });
      });
      return;
    }
    await step.do("report", async () => {
      if (error) await this.env.DB.prepare("UPDATE searches SET error = ?2 WHERE id = ?1").bind(search.id, `Pages ${first}–${last} failed: ${error}`).run();
      const s = await this.progress(search.id, last - first + 1);
      if (s.pages_done >= s.pages) await this.markDone(search.id);
    });
  }

  async progress(searchId, n) {
    return this.env.DB.prepare(
      `UPDATE searches SET pages_done = pages_done + ?2, found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1)
       WHERE id = ?1 RETURNING pages_done, pages`
    ).bind(searchId, n).first();
  }

  async markDone(searchId) {
    await this.env.DB.prepare(
      `UPDATE searches SET status = 'done', finished_at = ?2, found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1)
       WHERE id = ?1 AND status != 'done'`
    ).bind(searchId, new Date().toISOString()).run();
  }

  async finish(step, searchId) {
    await step.do("finish", () => this.markDone(searchId));
  }

  async fail(step, searchId, err) {
    await step.do("mark failed", async () => {
      await this.env.DB.prepare("UPDATE searches SET status = 'failed', error = ?2, finished_at = ?3 WHERE id = ?1")
        .bind(searchId, String(err?.message || err).slice(0, 500), new Date().toISOString()).run();
    });
  }
}
