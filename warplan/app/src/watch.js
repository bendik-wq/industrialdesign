// Seller-signal watch: every day Warplan re-reads each target's website (home page plus its about/team pages,
// through TinyFish's free browser fetch on Monid) and compares it with the last copy. New text that sounds like an
// owner getting ready to go (retiring, "after 32 years", a farewell, hiring a practice manager, a succession plan,
// the business for sale) becomes a signal; so does the owner's name disappearing from the site, and the opposite
// kind (new owners, "now part of X group") so you stop chasing businesses that already sold.
// Signals land on the target's timeline, in the Signals feed and as a signal.detected webhook. Free to run.
import { run } from "./monid.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const MAX_TEXT = 30000;
const PAGES_PER_TARGET = 3;

// What counts as a signal. strength 3 = act now, 2 = strong, 1 = worth a look; negative = probably not a target.
export const RULES = [
  { kind: "for_sale", strength: 3, title: "Business for sale / looking for a successor", re: /\b(business (is )?(for sale|on the market)|(practice|clinic|business) for sale|for sale by owner|seeking (a )?(buyer|successor|new owner)|expressions? of interest (to|in) (acquir|purchas|buy|tak)\w*|succession plan(ning)?|looking for (someone|the right person) to take over)\b/i },
  { kind: "retirement", strength: 3, title: "Owner talks about retiring", re: /\b(retir(e|es|ing|ement)|stepping (back|down) from|hang(ing)? up (the|my|his|her) (tools|boots|stethoscope)|winding down|semi-retire\w*)\b/i },
  { kind: "farewell", strength: 2, title: "Farewell / end-of-an-era message", re: /\b(farewell|end of an era|thank you for (\d{2}|many|so many) (wonderful |amazing |great )?years|after (\d{2}|many) (wonderful |amazing |great )?years)\b/i },
  { kind: "hiring_manager", strength: 2, title: "Hiring a manager or associate (owner may be stepping back)", re: /\b(hiring|seeking|looking for|vacanc(y|ies)|position available|join (our|the) team)\b[^.\n]{0,100}\b(practice manager|general manager|operations manager|clinic manager|associate (dentist|physio\w*|vet\w*)|principal (dentist|physio\w*)|managing director)\b/i },
  { kind: "reduced_hours", strength: 1, title: "Reduced or changed opening hours", re: /\b(reduced (opening |trading )?hours|new (opening |trading )?hours|now closed on (mondays?|fridays?|saturdays?|weekends)|by appointment only)\b/i },
  { kind: "closing", strength: 1, title: "Closing or moving", re: /\b(closing (down|our doors)|clos(ed|ing) permanently|final day of trading|last day of trading|we('| a)re moving|relocating to)\b/i },
  { kind: "new_owner", strength: -1, title: "New owners / now part of a group (probably already sold)", re: /\b(under new (ownership|management)|new owners?\b|(has been |was )?acquired by|now (a )?part of|(proud(ly)?|now a) (member|part) of the [A-Z][\w&' ]{2,40} (group|network|family)|joined the [A-Z][\w&' ]{2,40} (group|network|family))/i },
];

// Plain text lines worth comparing (no menus of one or two words, no copyright years).
export function lines(text) {
  return String(text || "").replace(/\r/g, "").split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map((l) => l.replace(/[#*_>`|]+/g, " ").replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 25 && !/^©|copyright|all rights reserved|cookie/i.test(l));
}
// New sentences that match a rule (on the first look, everything on the page counts as "new").
export function detect(oldText, newText, { ownerName = "" } = {}) {
  const before = new Set(lines(oldText));
  const fresh = lines(newText).filter((l) => !before.has(l));
  const out = [];
  for (const r of RULES) {
    const hit = fresh.find((l) => r.re.test(l));
    if (hit) out.push({ kind: r.kind, strength: r.strength, title: r.title, snippet: hit.slice(0, 280) });
  }
  // The owner's name used to be on the site and isn't any more.
  const last = String(ownerName || "").replace(/\(.*?\)/g, "").trim().split(/\s+/).filter((w) => w.length > 2).pop();
  if (oldText && last && new RegExp(`\\b${last.replace(/[^\w]/g, "")}\\b`, "i").test(oldText) && !new RegExp(`\\b${last.replace(/[^\w]/g, "")}\\b`, "i").test(newText)) {
    out.push({ kind: "owner_gone", strength: 3, title: `The owner's name (${ownerName}) is gone from the website`, snippet: "" });
  }
  return out;
}

const hash = async (s) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
const sameHost = (a, b) => { try { return new URL(a).hostname.replace(/^www\./, "") === new URL(b).hostname.replace(/^www\./, ""); } catch { return false; } };
const homeOf = (w) => { try { const u = new URL(/^https?:/.test(w) ? w : `https://${w}`); return u.protocol === "https:" || u.protocol === "http:" ? u.origin + "/" : null; } catch { return null; } };
// About / team / story pages from the home page's links.
export function pickPages(home, links) {
  const good = /\/(about|about-us|our-story|our-team|team|meet|staff|people|history|who-we-are|practitioners|our-dentists|our-physios|news|blog)(\/|$|-)/i;
  const seen = new Set([home.replace(/\/$/, "")]);
  const out = [home];
  for (const l of links || []) {
    const u = String(l).split("#")[0].replace(/\/$/, "");
    if (!u || seen.has(u) || !sameHost(u, home) || !good.test(new URL(u).pathname)) continue;
    seen.add(u); out.push(u);
    if (out.length >= PAGES_PER_TARGET) break;
  }
  return out;
}

// One free fetch call for up to 10 pages.
async function fetchPages(env, ctx, urls, { links = false } = {}) {
  const r = await run(env, ctx, { provider: "tinyfish", endpoint: "/fetch", input: { body: { urls, ttl: 0, ...(links && { links: true }), exclude_selectors: ["nav", "footer", "script", "style"] } } }, { purpose: "Seller-signal watch", maxWaitMs: 45000 });
  const by = new Map();
  for (const x of r.output?.results || []) by.set(x.url, x);
  return by;
}

// Watch these targets once: find their pages the first time, compare with the last copy, record signals.
export async function watchTargets(env, ctx, targets, hooks) {
  const found = [];
  const stamp = now();
  // First look: discover the pages from each home page.
  const fresh = [];
  for (const t of targets) {
    const { results } = await env.DB.prepare("SELECT url FROM watch_pages WHERE account_id = ?1 AND target_id = ?2").bind(ctx.accountId, t.id).all();
    if (!results.length && homeOf(t.website)) fresh.push(t); else t.pages = results.map((r) => r.url);
  }
  for (let i = 0; i < fresh.length; i += 10) {
    const chunk = fresh.slice(i, i + 10);
    const got = await fetchPages(env, ctx, chunk.map((t) => homeOf(t.website)), { links: true }).catch(() => new Map());
    for (const t of chunk) {
      const home = homeOf(t.website), page = got.get(home) || [...got.values()].find((x) => x.final_url && sameHost(x.final_url, home));
      t.pages = pickPages(page?.final_url || home, page?.links);
      for (const url of t.pages) await env.DB.prepare("INSERT OR IGNORE INTO watch_pages (account_id, target_id, url, created_at) VALUES (?1, ?2, ?3, ?4)").bind(ctx.accountId, t.id, url, stamp).run();
    }
  }
  // Every page, ten per call.
  const jobs = targets.flatMap((t) => (t.pages || []).map((url) => ({ t, url })));
  for (let i = 0; i < jobs.length; i += 10) {
    const chunk = jobs.slice(i, i + 10);
    let got;
    try { got = await fetchPages(env, ctx, chunk.map((j) => j.url)); } catch (e) { if (e.status === 402) throw e; continue; }
    for (const { t, url } of chunk) {
      const page = got.get(url);
      if (!page?.text) { await env.DB.prepare("UPDATE watch_pages SET checked_at = ?4, error = 'unreachable' WHERE account_id = ?1 AND target_id = ?2 AND url = ?3").bind(ctx.accountId, t.id, url, stamp).run(); continue; }
      const text = page.text.slice(0, MAX_TEXT), h = await hash(text);
      const prev = await env.DB.prepare("SELECT text, text_hash FROM watch_pages WHERE account_id = ?1 AND target_id = ?2 AND url = ?3").bind(ctx.accountId, t.id, url).first();
      if (prev?.text_hash === h) { await env.DB.prepare("UPDATE watch_pages SET checked_at = ?4, error = NULL WHERE account_id = ?1 AND target_id = ?2 AND url = ?3").bind(ctx.accountId, t.id, url, stamp).run(); continue; }
      const signals = detect(prev?.text || "", text, { ownerName: t.owner_name });
      await env.DB.prepare("UPDATE watch_pages SET text = ?4, text_hash = ?5, checked_at = ?6, changed_at = CASE WHEN text_hash IS NULL THEN changed_at ELSE ?6 END, error = NULL WHERE account_id = ?1 AND target_id = ?2 AND url = ?3")
        .bind(ctx.accountId, t.id, url, text, h, stamp).run();
      for (const s of signals) {
        // One signal of a kind per target per 60 days.
        const dup = await env.DB.prepare("SELECT 1 FROM signals WHERE account_id = ?1 AND target_id = ?2 AND kind = ?3 AND created_at >= ?4").bind(ctx.accountId, t.id, s.kind, new Date(Date.now() - 60 * 864e5).toISOString()).first();
        if (dup) continue;
        await env.DB.prepare("INSERT INTO signals (account_id, target_id, kind, strength, title, snippet, url, first_look, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
          .bind(ctx.accountId, t.id, s.kind, s.strength, s.title, s.snippet, url, prev?.text_hash ? 0 : 1, stamp).run();
        await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, NULL, 'Signal watch', 'note', ?3, ?4)")
          .bind(ctx.accountId, t.id, `Seller signal: ${s.title}.${s.snippet ? ` “${s.snippet}”` : ""} (${url})`, stamp).run();
        if (s.strength >= 3 && t.priority > 1) await env.DB.prepare("UPDATE targets SET priority = 1, updated_at = ?3 WHERE id = ?1 AND account_id = ?2").bind(t.id, ctx.accountId, stamp).run();
        hooks?.emit("signal.detected", { target_id: t.id, target: t.name, kind: s.kind, strength: s.strength, title: s.title, snippet: s.snippet, url });
        found.push({ target_id: t.id, target: t.name, ...s, url });
      }
    }
  }
  return found;
}

// The daily run for one workspace (queue message), or "Run the watch now".
export async function runWatch(env, ctx, hooks, { limit = 60, targetId = null } = {}) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.name, t.website, t.owner_name, t.priority FROM targets t
    WHERE t.account_id = ?1 AND t.website != '' AND t.stage NOT IN ('closed', 'lost') AND (?2 IS NULL OR t.id = ?2)
    ORDER BY (SELECT MIN(COALESCE(checked_at, '')) FROM watch_pages w WHERE w.target_id = t.id AND w.account_id = t.account_id), t.updated_at DESC LIMIT ?3`).bind(ctx.accountId, targetId, Math.min(limit, 150)).all();
  if (targetId && !results.length) throw err(400, "Add the target's website first (Edit details): the watch reads it");
  const found = await watchTargets(env, ctx, results, hooks);
  return { checked: results.length, signals: found, receipt: `Checked ${results.length} website${results.length === 1 ? "" : "s"}: ${found.length ? `${found.length} new signal${found.length === 1 ? "" : "s"}` : "nothing new"}` };
}

export async function listSignals(env, ctx, { targetId = null, limit = 30 } = {}) {
  const { results } = await env.DB.prepare(`SELECT s.id, s.target_id, t.name AS target_name, s.kind, s.strength, s.title, s.snippet, s.url, s.first_look, s.seen_at, s.created_at
    FROM signals s JOIN targets t ON t.id = s.target_id AND t.account_id = s.account_id WHERE s.account_id = ?1 AND (?2 IS NULL OR s.target_id = ?2) ORDER BY s.id DESC LIMIT ?3`).bind(ctx.accountId, targetId, Math.min(limit, 100)).all();
  const pages = targetId ? (await env.DB.prepare("SELECT url, checked_at, changed_at, error FROM watch_pages WHERE account_id = ?1 AND target_id = ?2").bind(ctx.accountId, targetId).all()).results : undefined;
  return { signals: results, unseen: results.filter((s) => !s.seen_at).length, ...(pages && { pages }) };
}
export async function markSeen(env, ctx) {
  await env.DB.prepare("UPDATE signals SET seen_at = ?2 WHERE account_id = ?1 AND seen_at IS NULL").bind(ctx.accountId, now()).run();
  return { ok: true };
}
