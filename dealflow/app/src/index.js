// Dealflow API + app server. Multi-tenant: every buyer account sees only its own searches, pipeline, drafts and
// agents, and can only search inside the exclusive territories it holds.
//   Browser: sign in at /login (session cookie).   Scripts and MCP: Authorization: Bearer <personal API token>.
//   GET /api lists every endpoint.
import { PROVIDERS, providerInfo } from "./providers.js";
import { INDUSTRIES, industryById } from "./data/industries.js";
import { brief, letter, transcribe, speak, extractCallNotes, VOICES } from "./ai.js";
import { planFromGoal, validateConfig, describe, TEMPLATES } from "./agents.js";
import { lookup, publicView, captureLead } from "./seller.js";
import { saveCompanies } from "./store.js";
import { handleMcp } from "./mcp.js";
import { recommend } from "../public/deal.js";
import {
  getContext, findUserForLogin, verifyPassword, hashPassword, passwordProblem, sessionCookie, clearCookie,
  sha256, randomToken,
} from "./auth.js";
import { normalizeClaim, conflicts, ownerOf, myTerritories, scopeToTerritory, territoryLabel } from "./tenancy.js";
export { SearchWorkflow } from "./workflow.js";
export { AgentWorkflow } from "./agentflow.js";

const STATUSES = ["New", "Researching", "Contacted", "Conversation", "NDA signed", "Financials", "LOI", "Passed", "Not a fit"];
export const PLANS = {
  operator: { label: "Operator", price: 1000, territories: 1 },
  rollup: { label: "Roll-up", price: 2500, territories: 3 },
  platform: { label: "Platform", price: 6000, territories: 10 },
  admin: { label: "Platform admin", price: 0, territories: 999 },
};
const INVITE_DAYS = 7;
const PUBLIC_PATHS = new Set([
  "/login", "/login.html", "/login.js", "/join", "/join.html", "/join.js", "/style.css",
  "/value", "/value.html", "/value.js", "/value.css", "/deal.js",
]);

const API_DOCS = {
  auth: "Session cookie from POST /api/login, or header Authorization: Bearer <API token> (create one on the Team page)",
  endpoints: [
    "GET    /api/me                           you, your account, plan and territories",
    "GET    /api/sources                      countries (with readiness), regions, industries",
    "GET    /api/territories                  your exclusive territories and how many your plan allows",
    "POST   /api/territories/check            {country, industry, region?} → is it free?",
    "POST   /api/territories                  {country, industry, region?} claim a territory (account owners)",
    "DELETE /api/territories/:id              release a territory",
    "GET    /api/searches                     your searches with progress",
    "POST   /api/searches                     {country, industry, region?, minStaff?} → starts a background search inside your territories",
    "GET    /api/searches/:id                 one search",
    "DELETE /api/searches/:id                 remove a search",
    "POST   /api/searches/:id/retry           re-run a search (already-saved companies are updated, not duplicated)",
    "GET    /api/companies                    ?search=&country=&q=&verdict=&minFit=&minOwnerAge=&minStaff=&status=&sort=fit|size|succession|owner_age|founded|value|staff|name&page=&limit=",
    "GET    /api/companies/:id                full record: people, signals, your pipeline and drafts",
    "PUT    /api/companies/:id/pipeline       {status?, notes?}",
    "GET    /api/pipeline                     every company you are working, by stage",
    "GET    /api/stats                        ?search= counts by verdict",
    "GET    /api/export.csv                   same filters as /api/companies, &format=full|mail|email",
    "GET    /api/companies/:id/deal           ?price= valuation range + three seller-finance structures with DSCR",
    "POST   /api/companies/:id/ai             {kind: brief|letter, regenerate?, me?, voice?} AI brief or owner letter (cached per account)",
    "POST   /api/companies/add                {country: fr|no, number} add one company by registry number",
    "GET    /api/leads                        inbound sellers routed to you from the public valuation page",
    "GET    /api/home                         dashboard: totals, funnel, inbound, agent activity, newest strong targets",
    "GET    /api/agents                       agents with last run; templates",
    "POST   /api/agents/plan                  {goal} → editable plan (config + steps) from plain English",
    "POST   /api/agents                       {name, goal, config, buyer?, run?} create an agent (run: true starts it now)",
    "GET    /api/agents/:id                   agent, plan steps, runs with logs",
    "PATCH  /api/agents/:id                   {config?, name?, active?}",
    "POST   /api/agents/:id/run               start a run now",
    "DELETE /api/agents/:id                   delete an agent",
    "POST   /api/voice/transcribe             raw audio body → {text} (Whisper)",
    "POST   /api/companies/:id/voice-note     {text} → extracted call facts, saved to pipeline",
    "GET    /api/companies/:id/brief.mp3      the AI brief read aloud",
    "GET    /api/team                         members, pending invites, API tokens",
    "POST   /api/team/invites                 {email, role} → invite link (owners)",
    "POST   /api/tokens                       {label} → new API token, shown once",
    "POST   /mcp                              MCP server (Streamable HTTP) for Claude and other agents; Bearer <API token>",
    "PUBLIC /value                            seller-facing 'What is my business worth?' page; leads go to the territory holder",
  ],
};

export default {
  // Hourly: start any agent whose daily/weekly schedule is due.
  async scheduled(controller, env, ctx) {
    const { results } = await env.DB.prepare("SELECT a.* FROM agents a JOIN accounts x ON x.id = a.account_id WHERE a.active = 1 AND x.active = 1").all();
    const now = Date.now();
    for (const a of results) {
      const cfg = JSON.parse(a.config);
      const every = { daily: 864e5, weekly: 7 * 864e5 }[cfg.schedule];
      if (!every) continue;
      if (a.last_run_at && now - Date.parse(a.last_run_at) < every - 30 * 60e3) continue;
      const busy = await env.DB.prepare("SELECT 1 FROM agent_runs WHERE agent_id = ?1 AND status IN ('queued','running')").bind(a.id).first();
      if (!busy) ctx.waitUntil(startRun(env, null, a.id, "schedule"));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith("/api/auth/") || url.pathname === "/api/login" || url.pathname === "/api/logout" || url.pathname === "/api/setup" || url.pathname.startsWith("/api/invites/")) {
        return await authRoute(request, env, url);
      }
      if (url.pathname.startsWith("/api/public/")) return await publicRoute(request, env, url);
      if (PUBLIC_PATHS.has(url.pathname)) return env.ASSETS.fetch(request);
      const ctx = await getContext(request, env);
      if (!ctx) {
        return url.pathname.startsWith("/api/") || url.pathname === "/mcp" ? json({ error: "Not signed in" }, 401) : Response.redirect(`${url.origin}/login`, 302);
      }
      if (url.pathname === "/mcp") return handleMcp(request, mcpOps(env, ctx));
      if (!url.pathname.startsWith("/api")) return env.ASSETS.fetch(request);
      return await route(request, env, url, ctx);
    } catch (err) {
      console.error(err);
      if (/D1_ERROR: .*(limit|exceeded)/i.test(err?.message || "")) {
        return json({ error: "The database's free daily write allowance is used up. Saving resumes at midnight UTC, or immediately on the Workers Paid plan." }, 503);
      }
      return json({ error: err.status ? err.message : "Internal error" }, err.status || 500);
    }
  },
};

function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const body = (request) => request.json().catch(() => ({}));
const now = () => new Date().toISOString();
const slow = () => new Promise((r) => setTimeout(r, 600)); // blunt password guessing
const cleanEmail = (e) => { const s = String(e || "").trim().toLowerCase().slice(0, 200); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : null; };
const needOwner = (ctx) => { if (!ctx.isOwner) fail(403, "Only the account owner can do that"); };
const needAdmin = (ctx) => { if (!ctx.isAdmin) fail(403, "Platform admins only"); };

// ------------------------------------------------------------------ sign-in, setup, invites (no session needed)
async function authRoute(request, env, url) {
  const p = url.pathname, m = request.method;
  if (p === "/api/auth/state" && m === "GET") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
    return json({ needsSetup: !n.n });
  }
  if (p === "/api/setup" && m === "POST") {
    // First run only: the person holding DASHBOARD_PASSWORD becomes the platform admin of account 1.
    const b = await body(request);
    if ((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n) fail(409, "Already set up. Sign in instead.");
    if (!env.DASHBOARD_PASSWORD || b.setupKey !== env.DASHBOARD_PASSWORD) { await slow(); fail(401, "Wrong setup key"); }
    const email = cleanEmail(b.email);
    if (!email) fail(400, "Enter a valid email");
    const problem = passwordProblem(b.password);
    if (problem) fail(400, problem);
    const u = await env.DB.prepare(
      "INSERT INTO users (account_id, email, name, role, is_admin, password_hash, created_at) VALUES (1, ?1, ?2, 'owner', 1, ?3, ?4) RETURNING *"
    ).bind(email, String(b.name || "").trim().slice(0, 80), await hashPassword(b.password), now()).first();
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/login" && m === "POST") {
    const b = await body(request);
    const u = await findUserForLogin(env, b.email);
    if (!u || !(await verifyPassword(String(b.password || ""), u.password_hash))) { await slow(); fail(401, "Wrong email or password"); }
    if (!u.account_active) fail(403, "This account is paused. Contact us to reactivate it.");
    await env.DB.prepare("UPDATE users SET last_login_at = ?2 WHERE id = ?1").bind(u.id, now()).run();
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/logout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
  let r;
  if ((r = p.match(/^\/api\/invites\/([\w-]{20,})$/))) {
    const inv = await env.DB.prepare(
      `SELECT i.*, a.name AS account_name FROM invites i JOIN accounts a ON a.id = i.account_id
       WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.expires_at > ?2`
    ).bind(await sha256(r[1]), now()).first();
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    if (m === "GET") return json({ account: inv.account_name, email: inv.email, role: inv.role });
    if (m === "POST") {
      const b = await body(request);
      const email = inv.email || cleanEmail(b.email);
      if (!email) fail(400, "Enter a valid email");
      const problem = passwordProblem(b.password);
      if (problem) fail(400, problem);
      if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first()) fail(409, "That email already has a login. Sign in instead.");
      const [u] = (await env.DB.batch([
        env.DB.prepare("INSERT INTO users (account_id, email, name, role, password_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING *")
          .bind(inv.account_id, email, String(b.name || "").trim().slice(0, 80), inv.role, await hashPassword(b.password), now()),
        env.DB.prepare("UPDATE invites SET accepted_at = ?2 WHERE accepted_at IS NULL AND (id = ?1 OR lower(email) = ?3)").bind(inv.id, now(), email),
      ])).map((x) => x.results[0]);
      return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u) });
    }
  }
  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ routing
async function route(request, env, url, ctx) {
  const p = url.pathname, m = request.method;
  if (p === "/api" || p === "/api/") return json(API_DOCS);
  if (p === "/api/me" && m === "GET") return json(await me(env, ctx));
  if (p === "/api/me/password" && m === "POST") return changePassword(env, ctx, await body(request));
  if (p === "/api/sources" && m === "GET") return json({ countries: providerInfo(env), industries: INDUSTRIES.map(({ id, label, ...codes }) => ({ id, label, countries: Object.keys(codes).filter((k) => k !== "places" && codes[k].length).concat("us") })), statuses: STATUSES });

  // Territories, team, tokens, admin
  if (p === "/api/territories" && m === "GET") return json(await territories(env, ctx));
  if (p === "/api/territories/check" && m === "POST") return json(await checkTerritory(env, ctx, await body(request)));
  if (p === "/api/territories" && m === "POST") return json(await claimTerritory(env, ctx, await body(request)), 201);
  if (p === "/api/team" && m === "GET") return json(await team(env, ctx));
  if (p === "/api/team/invites" && m === "POST") return json(await invite(env, ctx, await body(request), url.origin), 201);
  if (p === "/api/tokens" && m === "POST") return json(await createToken(env, ctx, await body(request)), 201);
  if (p === "/api/admin" && m === "GET") return json(await adminOverview(env, ctx));
  if (p === "/api/admin/accounts" && m === "POST") return json(await adminCreateAccount(env, ctx, await body(request), url.origin), 201);
  if (p === "/api/admin/territories" && m === "POST") return json(await adminAssign(env, ctx, await body(request)), 201);

  if (p === "/api/searches" && m === "GET") return json(await listSearches(env, ctx));
  if (p === "/api/searches" && m === "POST") return json(await createSearch(env, await body(request), ctx), 201);
  if (p === "/api/leads" && m === "GET") return json((await env.DB.prepare("SELECT l.*, c.name AS company FROM leads l LEFT JOIN companies c ON c.id = l.company_id WHERE l.account_id = ?1 ORDER BY l.id DESC").bind(ctx.accountId).all()).results);
  if (p === "/api/companies/add" && m === "POST") return json(await addCompany(env, await body(request), ctx), 201);
  if (p === "/api/home" && m === "GET") return json(await home(env, ctx));
  if (p === "/api/agents" && m === "GET") return json(await listAgents(env, ctx));
  if (p === "/api/agents/plan" && m === "POST") return json(await planAgent(env, ctx, (await body(request)).goal));
  if (p === "/api/agents" && m === "POST") return json(await createAgent(env, await body(request), ctx), 201);
  if (p === "/api/voice/transcribe" && m === "POST") {
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) fail(400, "No audio received");
    if (buf.byteLength > 12e6) fail(413, "Recording too long; keep it under about 5 minutes");
    return json(await transcribe(env, buf, url.searchParams.get("hint") || ""));
  }
  if (p === "/api/companies" && m === "GET") return json(await listCompanies(env, url.searchParams, ctx));
  if (p === "/api/pipeline" && m === "GET") return json(await pipeline(env, ctx));
  if (p === "/api/stats" && m === "GET") return json(await stats(env, url.searchParams, ctx));
  if (p === "/api/export.csv" && m === "GET") return exportCsv(env, url.searchParams, ctx);
  let r;
  if ((r = p.match(/^\/api\/territories\/(\d+)$/)) && m === "DELETE") {
    needOwner(ctx);
    const done = await env.DB.prepare("DELETE FROM territories WHERE id = ?1 AND account_id = ?2 RETURNING id").bind(+r[1], ctx.accountId).first();
    return done ? json({ ok: true }) : fail(404, "Territory not found");
  }
  if ((r = p.match(/^\/api\/team\/invites\/(\d+)$/)) && m === "DELETE") {
    needOwner(ctx);
    await env.DB.prepare("DELETE FROM invites WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/team\/members\/(\d+)$/)) && m === "DELETE") {
    needOwner(ctx);
    if (+r[1] === ctx.user.id) fail(400, "You can't remove yourself");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId),
      env.DB.prepare("DELETE FROM users WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId),
    ]);
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/tokens\/(\d+)$/)) && m === "DELETE") {
    await env.DB.prepare("DELETE FROM api_tokens WHERE id = ?1 AND account_id = ?2 AND (?4 = 1 OR user_id = ?3)").bind(+r[1], ctx.accountId, ctx.user.id, ctx.isOwner ? 1 : 0).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/admin\/accounts\/(\d+)$/)) && m === "PATCH") return json(await adminUpdateAccount(env, ctx, +r[1], await body(request)));
  if ((r = p.match(/^\/api\/admin\/accounts\/(\d+)\/invite$/)) && m === "POST") {
    needAdmin(ctx);
    return json(await makeInvite(env, ctx, +r[1], cleanEmail((await body(request)).email), "owner", url.origin), 201);
  }
  if ((r = p.match(/^\/api\/admin\/territories\/(\d+)$/)) && m === "DELETE") {
    needAdmin(ctx);
    await env.DB.prepare("DELETE FROM territories WHERE id = ?1").bind(+r[1]).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/searches\/(\d+)$/))) {
    const s = await ownSearch(env, ctx, +r[1]);
    if (m === "GET") return json(s);
    if (m === "DELETE") {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM search_results WHERE search_id = ?1").bind(s.id),
        env.DB.prepare("DELETE FROM searches WHERE id = ?1").bind(s.id),
        // Drop companies no search or pipeline entry (of any account) refers to.
        env.DB.prepare("DELETE FROM companies WHERE id NOT IN (SELECT company_id FROM search_results) AND id NOT IN (SELECT company_id FROM pipeline)"),
      ]);
      return json({ ok: true });
    }
  }
  if ((r = p.match(/^\/api\/searches\/(\d+)\/retry$/)) && m === "POST") {
    const s = await ownSearch(env, ctx, +r[1]);
    if (s.country !== "all") await scopeToTerritory(env, ctx, s);
    const row = await env.DB.prepare("UPDATE searches SET status = 'queued', error = NULL WHERE id = ?1 AND status IN ('failed', 'done') AND country != 'all' RETURNING *").bind(s.id).first();
    if (!row) fail(400, "This search can't be re-run right now");
    await env.SEARCH.create({ id: `search-${row.id}-${Date.now()}`, params: { searchId: row.id } });
    return json(row);
  }
  if ((r = p.match(/^\/api\/companies\/(\d+)$/)) && m === "GET") return json(await company(env, +r[1], ctx));
  if ((r = p.match(/^\/api\/agents\/(\d+)$/))) {
    if (m === "GET") return json(await getAgent(env, +r[1], ctx));
    if (m === "PATCH") return json(await updateAgent(env, +r[1], await body(request), ctx));
    if (m === "DELETE") {
      await ownAgent(env, ctx, +r[1]);
      await env.DB.batch([env.DB.prepare("DELETE FROM agent_targets WHERE agent_id = ?1").bind(+r[1]), env.DB.prepare("DELETE FROM agent_runs WHERE agent_id = ?1").bind(+r[1]), env.DB.prepare("DELETE FROM agents WHERE id = ?1").bind(+r[1])]);
      return json({ ok: true });
    }
  }
  if ((r = p.match(/^\/api\/agents\/(\d+)\/run$/)) && m === "POST") return json(await startRun(env, ctx, +r[1], "manual"), 201);
  if ((r = p.match(/^\/api\/companies\/(\d+)\/voice-note$/)) && m === "POST") return json(await voiceNote(env, +r[1], await body(request), ctx));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/brief\.mp3$/)) && m === "GET") {
    await company(env, +r[1], ctx);
    const row = await env.DB.prepare("SELECT content FROM ai_outputs WHERE account_id = ?1 AND company_id = ?2 AND kind = 'brief'").bind(ctx.accountId, +r[1]).first();
    if (!row) fail(404, "Write the brief first");
    return new Response(await speak(env, row.content), { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" } });
  }
  if ((r = p.match(/^\/api\/companies\/(\d+)\/deal$/)) && m === "GET") return json(await deal(env, +r[1], url.searchParams.get("price"), ctx));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/ai$/)) && m === "POST") return json(await ai(env, +r[1], await body(request), ctx));
  if ((r = p.match(/^\/api\/companies\/(\d+)\/pipeline$/)) && m === "PUT") return json(await savePipeline(env, +r[1], await body(request), ctx));
  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ you, your team, your tokens
async function me(env, ctx) {
  const terr = await myTerritories(env, ctx.accountId);
  return {
    user: ctx.user, account: { ...ctx.account, planLabel: PLANS[ctx.account.plan]?.label || ctx.account.plan },
    isAdmin: ctx.isAdmin, isOwner: ctx.isOwner, territories: terr, plans: PLANS,
  };
}

async function changePassword(env, ctx, b) {
  if (ctx.viaToken) fail(400, "Change your password from the browser");
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(ctx.user.id).first();
  if (!(await verifyPassword(String(b.current || ""), u.password_hash))) { await slow(); fail(401, "Your current password is wrong"); }
  const problem = passwordProblem(b.next);
  if (problem) fail(400, problem);
  // Bumping the epoch signs out every other session.
  const nu = await env.DB.prepare("UPDATE users SET password_hash = ?2, session_epoch = session_epoch + 1 WHERE id = ?1 RETURNING *").bind(u.id, await hashPassword(b.next)).first();
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, nu) });
}

async function team(env, ctx) {
  const [members, invites, tokens] = await env.DB.batch([
    env.DB.prepare("SELECT id, email, name, role, is_admin, created_at, last_login_at FROM users WHERE account_id = ?1 ORDER BY id").bind(ctx.accountId),
    env.DB.prepare("SELECT id, email, role, expires_at FROM invites WHERE account_id = ?1 AND accepted_at IS NULL AND expires_at > ?2 ORDER BY id DESC").bind(ctx.accountId, now()),
    env.DB.prepare(`SELECT t.id, t.label, t.created_at, t.last_used_at, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.account_id = ?1 AND (?3 = 1 OR t.user_id = ?2) ORDER BY t.id DESC`).bind(ctx.accountId, ctx.user.id, ctx.isOwner ? 1 : 0),
  ]);
  return { members: members.results, invites: ctx.isOwner ? invites.results : [], tokens: tokens.results, isOwner: ctx.isOwner, me: ctx.user.id };
}

async function makeInvite(env, ctx, accountId, email, role, origin) {
  if (email && (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first())) fail(409, "That email already has a login");
  const token = randomToken();
  await env.DB.prepare("INSERT INTO invites (account_id, email, role, token_hash, expires_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(accountId, email, role, await sha256(token), new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), ctx.user.id || null).run();
  return { link: `${origin}/join?t=${token}`, email, role, expiresInDays: INVITE_DAYS };
}

async function invite(env, ctx, b, origin) {
  needOwner(ctx);
  return makeInvite(env, ctx, ctx.accountId, cleanEmail(b.email), b.role === "owner" ? "owner" : "member", origin);
}

async function createToken(env, ctx, b) {
  if (!ctx.user.id) fail(400, "Create tokens from a signed-in user");
  const token = randomToken("dft_");
  const label = String(b.label || "").trim().slice(0, 60) || "API token";
  const row = await env.DB.prepare("INSERT INTO api_tokens (account_id, user_id, label, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, label, created_at")
    .bind(ctx.accountId, ctx.user.id, label, await sha256(token), now()).first();
  return { ...row, token };
}

// ------------------------------------------------------------------ exclusive territories
async function territories(env, ctx) {
  const mine = await myTerritories(env, ctx.accountId);
  return { territories: mine, limit: ctx.account.maxTerritories, used: mine.length, canClaim: ctx.isOwner && mine.length < ctx.account.maxTerritories };
}

async function checkTerritory(env, ctx, b) {
  let claim;
  try { claim = normalizeClaim(b); } catch (e) { return { available: false, reason: e.message }; }
  const taken = await conflicts(env, claim, ctx.accountId);
  const mine = (await conflicts(env, claim)).filter((t) => t.account_id === ctx.accountId);
  if (taken.length) {
    // Members never learn who holds a territory; admins do.
    return { available: false, label: territoryLabel(claim), reason: ctx.isAdmin ? `Held by ${taken.map((t) => `${t.account_name} (${territoryLabel(t)})`).join(", ")}` : `Another buyer already holds ${territoryLabel(taken[0])}.` };
  }
  if (mine.length) return { available: false, label: territoryLabel(claim), reason: `You already hold ${mine.map(territoryLabel).join(", ")}.` };
  return { available: true, label: territoryLabel(claim) };
}

async function insertTerritory(env, accountId, claim) {
  const row = await env.DB.prepare("INSERT INTO territories (account_id, country, industry, region, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *")
    .bind(accountId, claim.country, claim.industry, claim.region, now()).first();
  // Two claims landing at the same moment: the earlier one wins, the later one is rolled back.
  const clash = (await conflicts(env, claim, accountId)).find((t) => t.id < row.id);
  if (clash) {
    await env.DB.prepare("DELETE FROM territories WHERE id = ?1").bind(row.id).run();
    fail(409, "Someone claimed that territory a moment ago.");
  }
  return { ...row, label: territoryLabel(row) };
}

async function claimTerritory(env, ctx, b) {
  needOwner(ctx);
  const claim = normalizeClaim(b);
  const used = (await env.DB.prepare("SELECT COUNT(*) AS n FROM territories WHERE account_id = ?1").bind(ctx.accountId).first()).n;
  if (used >= ctx.account.maxTerritories) fail(402, `Your plan includes ${ctx.account.maxTerritories} ${ctx.account.maxTerritories === 1 ? "territory" : "territories"}. Release one or upgrade to add more.`);
  const check = await checkTerritory(env, ctx, claim);
  if (!check.available) fail(409, check.reason);
  return insertTerritory(env, ctx.accountId, claim);
}

// ------------------------------------------------------------------ platform admin
async function adminOverview(env, ctx) {
  needAdmin(ctx);
  const [accounts, terr] = await env.DB.batch([
    env.DB.prepare(`SELECT a.*, (SELECT COUNT(*) FROM users u WHERE u.account_id = a.id) AS users,
        (SELECT group_concat(email, ', ') FROM users u WHERE u.account_id = a.id AND u.role = 'owner') AS owners,
        (SELECT COUNT(*) FROM territories t WHERE t.account_id = a.id) AS territories,
        (SELECT COUNT(*) FROM searches s WHERE s.account_id = a.id) AS searches,
        (SELECT COUNT(*) FROM pipeline p WHERE p.account_id = a.id AND p.status != 'New') AS pipeline,
        (SELECT COUNT(*) FROM invites i WHERE i.account_id = a.id AND i.accepted_at IS NULL AND i.expires_at > ?1) AS open_invites
      FROM accounts a ORDER BY a.id`).bind(now()),
    env.DB.prepare("SELECT t.*, a.name AS account_name FROM territories t JOIN accounts a ON a.id = t.account_id ORDER BY t.country, t.industry, t.region"),
  ]);
  const mrr = accounts.results.filter((a) => a.active).reduce((s, a) => s + (PLANS[a.plan]?.price || 0), 0);
  return { accounts: accounts.results, territories: terr.results.map((t) => ({ ...t, label: territoryLabel(t) })), plans: PLANS, mrr };
}

async function adminCreateAccount(env, ctx, b, origin) {
  needAdmin(ctx);
  const name = String(b.name || "").trim().slice(0, 80);
  if (!name) fail(400, "Give the account a name");
  const plan = PLANS[b.plan] && b.plan !== "admin" ? b.plan : "operator";
  const max = Math.max(0, Math.min(999, Number(b.maxTerritories) || PLANS[plan].territories));
  const email = cleanEmail(b.ownerEmail);
  if (!email) fail(400, "Enter the owner's email");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first()) fail(409, "That email already has a login");
  const acct = await env.DB.prepare("INSERT INTO accounts (name, plan, max_territories, created_at) VALUES (?1, ?2, ?3, ?4) RETURNING *").bind(name, plan, max, now()).first();
  const inv = await makeInvite(env, ctx, acct.id, email, "owner", origin);
  return { account: acct, invite: inv };
}

async function adminUpdateAccount(env, ctx, id, b) {
  needAdmin(ctx);
  const a = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first();
  if (!a) fail(404, "Account not found");
  if (id === 1 && b.active === false) fail(400, "The platform account can't be paused");
  const plan = b.plan && PLANS[b.plan] ? b.plan : a.plan;
  const row = await env.DB.prepare("UPDATE accounts SET name = ?2, plan = ?3, max_territories = ?4, active = ?5 WHERE id = ?1 RETURNING *").bind(
    id, String(b.name ?? a.name).trim().slice(0, 80) || a.name, plan,
    b.maxTerritories != null ? Math.max(0, Math.min(999, Number(b.maxTerritories) || 0)) : b.plan && b.plan !== a.plan ? PLANS[plan].territories : a.max_territories,
    b.active === undefined ? a.active : b.active ? 1 : 0,
  ).first();
  return row;
}

async function adminAssign(env, ctx, b) {
  needAdmin(ctx);
  const acct = await env.DB.prepare("SELECT id FROM accounts WHERE id = ?1").bind(Number(b.accountId)).first();
  if (!acct) fail(404, "Account not found");
  const claim = normalizeClaim(b);
  const taken = await conflicts(env, claim, acct.id);
  if (taken.length) fail(409, `Held by ${taken.map((t) => `${t.account_name} (${territoryLabel(t)})`).join(", ")}. Remove that first.`);
  return insertTerritory(env, acct.id, claim);
}

// ------------------------------------------------------------------ searches
async function ownSearch(env, ctx, id) {
  const s = await env.DB.prepare("SELECT * FROM searches WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId).first();
  if (!s) fail(404, "Search not found");
  return s;
}

export async function createSearch(env, body, ctx) {
  const provider = PROVIDERS[body.country];
  const industry = industryById(body.industry);
  if (!provider) fail(400, "Unknown country");
  if (!industry) fail(400, "Unknown industry");
  if (provider.needsKey && !env[provider.needsKey]) fail(400, `${provider.label} needs ${provider.needsKey}. ${provider.keyHelp}`);
  if (provider.id !== "us" && !(industry[provider.id] || []).length) fail(400, `${industry.label} has no official code in ${provider.label} yet`);
  let region = String(body.region || "").trim().slice(0, 80) || null;
  region = await scopeToTerritory(env, ctx, { country: provider.id, industry: industry.id, region });
  let regionLabel = region;
  if (Array.isArray(provider.regions) && region) {
    const match = provider.regions.find((x) => x.code === region);
    if (!match) fail(400, "Unknown region");
    regionLabel = match.name.replace(/^\d+[AB]? · /, "");
  }
  if (provider.id === "us" && !region) fail(400, "Type a city or area, e.g. “Austin, TX”");
  const minStaff = Math.max(0, Math.min(500, Number(body.minStaff) || 0));
  const label = `${industry.label} · ${regionLabel || `all of ${provider.label}`}${minStaff ? ` · ${minStaff}+ staff` : ""}`;
  const row = await env.DB.prepare(
    `INSERT INTO searches (account_id, country, industry, region, region_label, min_staff, label, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'queued', ?8) RETURNING *`
  ).bind(ctx.accountId, provider.id, industry.id, region, regionLabel, minStaff, label, now()).first();
  await env.SEARCH.create({ id: `search-${row.id}-${Date.now()}`, params: { searchId: row.id } });
  return row;
}

async function listSearches(env, ctx) {
  const { results } = await env.DB.prepare(
    `SELECT s.*, (SELECT COUNT(*) FROM search_results r JOIN companies c ON c.id = r.company_id
       WHERE r.search_id = s.id AND c.excluded = 0 AND c.fit_score >= 50) AS strong
     FROM searches s WHERE s.account_id = ?1 ORDER BY s.id DESC`
  ).bind(ctx.accountId).all();
  return results;
}

// A per-account bucket search ("Added by hand", "Inbound sellers") so hand-added companies show up in lists.
export async function bucketSearch(db, accountId, label) {
  const s = await db.prepare("SELECT id FROM searches WHERE label = ?1 AND account_id = ?2 AND country = 'all'").bind(label, accountId).first();
  if (s) return s;
  return db.prepare(
    `INSERT INTO searches (account_id, country, industry, label, status, total, found, pages, pages_done, created_at, finished_at)
     VALUES (?1, 'all', 'all', ?2, 'done', 0, 0, 1, 1, ?3, ?3) RETURNING id`
  ).bind(accountId, label, now()).first();
}

// ------------------------------------------------------------------ deals, AI, single-company add
async function deal(env, id, price, ctx) {
  const c = await company(env, id, ctx);
  const r = recommend(c, price ? Number(price) : undefined);
  if (!r) return { company: c.name, currency: c.currency, available: false, reason: "Not enough published financials to value this company" };
  return { company: c.name, currency: c.currency, available: true, ...r };
}

export async function saveAi(db, accountId, companyId, kind, out) {
  const row = { company_id: companyId, kind, model: out.model, content: out.text, created_at: now() };
  await db.prepare(
    `INSERT INTO ai_outputs (account_id, company_id, kind, model, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT (account_id, company_id, kind) DO UPDATE SET model = ?4, content = ?5, created_at = ?6`
  ).bind(accountId, companyId, kind, row.model, row.content, row.created_at).run();
  return row;
}

async function ai(env, id, body, ctx) {
  const kind = body.kind === "letter" ? "letter" : "brief";
  const c = await company(env, id, ctx);
  if (!body.regenerate && c.ai[kind]) return { company_id: id, ...c.ai[kind] };
  const out = kind === "brief" ? await brief(env, c) : await letter(env, c, body.me || {}, body.voice);
  return saveAi(env.DB, ctx.accountId, id, kind, out);
}

async function addCompany(env, body, ctx) {
  const c = await lookup(body.country, body.number);
  const holder = await ownerOf(env, c.country, c.industry, c.region);
  if (holder && holder.account_id !== ctx.accountId && !ctx.isAdmin) fail(403, "This company sits inside another buyer's exclusive territory.");
  const search = await bucketSearch(env.DB, ctx.accountId, "Added by hand");
  await saveCompanies(env.DB, search.id, [c], c.industry);
  await env.DB.prepare("UPDATE searches SET found = (SELECT COUNT(*) FROM search_results WHERE search_id = ?1) WHERE id = ?1").bind(search.id).run();
  const row = await env.DB.prepare("SELECT id FROM companies WHERE source = ?1 AND source_id = ?2").bind(c.source, String(c.sourceId)).first();
  return company(env, row.id, ctx);
}

// ------------------------------------------------------------------ public seller page
async function publicRoute(request, env, url) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const b = await body(request);
  if (url.pathname === "/api/public/valuation") return json(publicView(await lookup(b.country, b.number)));
  if (url.pathname === "/api/public/lead") {
    if (b.website) return json({ ok: true }); // honeypot: bots fill every field
    const name = String(b.name || "").trim().slice(0, 120), email = String(b.email || "").trim().slice(0, 200);
    if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "Please give your name and a valid email");
    const c = await lookup(b.country, b.number);
    await captureLead(env, c, {
      name, email,
      phone: String(b.phone || "").slice(0, 40),
      timeline: String(b.timeline || "").slice(0, 60),
      message: String(b.message || "").slice(0, 2000),
    });
    return json({ ok: true });
  }
  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ agents
async function ownAgent(env, ctx, id) {
  const a = await env.DB.prepare("SELECT * FROM agents WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId).first();
  if (!a) fail(404, "Agent not found");
  return a;
}

async function listAgents(env, ctx) {
  const { results } = await env.DB.prepare(
    `SELECT a.*, r.status AS last_status, r.summary AS last_summary, r.id AS last_run_id,
       (SELECT COUNT(*) FROM agent_targets t WHERE t.agent_id = a.id) AS total_targets
     FROM agents a LEFT JOIN agent_runs r ON r.id = (SELECT MAX(id) FROM agent_runs WHERE agent_id = a.id)
     WHERE a.account_id = ?1 ORDER BY a.id DESC`
  ).bind(ctx.accountId).all();
  return { agents: results.map((a) => ({ ...a, config: JSON.parse(a.config), buyer: undefined })), templates: TEMPLATES, voices: Object.entries(VOICES).map(([id, v]) => ({ id, label: v.label })) };
}

async function planAgent(env, ctx, goal) {
  const plan = await planFromGoal(env, goal);
  try {
    plan.config.region = await scopeToTerritory(env, ctx, plan.config);
  } catch (e) {
    plan.warnings = [...(plan.warnings || []), e.message];
  }
  return plan;
}

async function getAgent(env, id, ctx) {
  const a = await ownAgent(env, ctx, id);
  const { results: runs } = await env.DB.prepare("SELECT * FROM agent_runs WHERE agent_id = ?1 ORDER BY id DESC LIMIT 20").bind(id).all();
  const { results: targets } = await env.DB.prepare(
    `SELECT c.id, c.name, c.city, c.owner_name, c.owner_age, c.valuation_mid, c.currency, c.verdict, c.fit_score, COALESCE(p.status, 'New') AS status
     FROM agent_targets t JOIN companies c ON c.id = t.company_id LEFT JOIN pipeline p ON p.company_id = c.id AND p.account_id = ?2
     WHERE t.agent_id = ?1 ORDER BY t.created_at DESC LIMIT 100`
  ).bind(id, ctx.accountId).all();
  const config = JSON.parse(a.config);
  return { ...a, config, buyer: JSON.parse(a.buyer || "{}"), steps: describe(config), runs: runs.map((r) => ({ ...r, log: JSON.parse(r.log || "[]") })), targets };
}

async function createAgent(env, body, ctx) {
  const config = validateConfig(body.config || {});
  config.region = await scopeToTerritory(env, ctx, config);
  const name = String(body.name || "").trim().slice(0, 60) || "Agent";
  const row = await env.DB.prepare(
    "INSERT INTO agents (account_id, name, goal, config, buyer, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING id"
  ).bind(ctx.accountId, name, String(body.goal || "").slice(0, 1500), JSON.stringify(config), JSON.stringify(body.buyer || {}), now()).first();
  if (body.run !== false) await startRun(env, ctx, row.id, body.trigger || "manual");
  return getAgent(env, row.id, ctx);
}

async function updateAgent(env, id, body, ctx) {
  const a = await ownAgent(env, ctx, id);
  let config = JSON.parse(a.config);
  if (body.config) {
    config = validateConfig({ ...config, ...body.config });
    config.region = await scopeToTerritory(env, ctx, config);
  }
  await env.DB.prepare("UPDATE agents SET name = ?2, config = ?3, active = ?4, buyer = ?5 WHERE id = ?1")
    .bind(id, body.name ?? a.name, JSON.stringify(config), body.active === undefined ? a.active : body.active ? 1 : 0, body.buyer ? JSON.stringify(body.buyer) : a.buyer).run();
  return getAgent(env, id, ctx);
}

// ctx is null for scheduled runs (the cron has already filtered to active accounts).
async function startRun(env, ctx, agentId, trigger) {
  if (ctx) await ownAgent(env, ctx, agentId);
  const busy = await env.DB.prepare("SELECT id FROM agent_runs WHERE agent_id = ?1 AND status IN ('queued','running')").bind(agentId).first();
  if (busy) fail(409, "This agent is already running");
  const run = await env.DB.prepare(
    "INSERT INTO agent_runs (agent_id, status, trigger, log, started_at) VALUES (?1, 'queued', ?2, ?3, ?4) RETURNING *"
  ).bind(agentId, trigger, JSON.stringify([{ at: now(), kind: "info", text: `Run started (${trigger}).` }]), now()).first();
  await env.AGENT.create({ id: `agent-${agentId}-run-${run.id}`, params: { runId: run.id } });
  return run;
}

// Context for background work (agent runs) acting on behalf of an account.
export async function accountContext(env, accountId) {
  const a = await env.DB.prepare("SELECT * FROM accounts WHERE id = ?1").bind(accountId).first();
  if (!a) throw new Error("Account not found");
  return { user: { id: 0, email: "agent", name: "Agent", role: "member" }, accountId: a.id, account: { id: a.id, name: a.name, plan: a.plan, maxTerritories: a.max_territories }, isAdmin: a.plan === "admin", isOwner: false, active: !!a.active };
}

// ------------------------------------------------------------------ voice notes and home
async function voiceNote(env, id, body, ctx) {
  const text = String(body.text || "").trim();
  if (text.length < 5) fail(400, "The note is empty");
  const c = await company(env, id, ctx);
  const x = await extractCallNotes(env, c, text.slice(0, 8000));
  const lines = [
    `🎙 Voice note ${now().slice(0, 10)}: ${x.summary}`,
    x.intent && x.intent !== "unclear" ? `Intent: ${x.intent}` : null,
    x.timeline ? `Timeline: ${x.timeline}` : null,
    x.asking_price ? `Asking price: ${x.asking_price}` : null,
    x.revenue || x.profit ? `Numbers: ${[x.revenue && `revenue ${x.revenue}`, x.profit && `profit ${x.profit}`].filter(Boolean).join(", ")}` : null,
    x.concerns?.length ? `Concerns: ${x.concerns.join("; ")}` : null,
    x.next_step ? `Next: ${x.next_step}${x.next_step_date ? ` (${x.next_step_date})` : ""}` : null,
  ].filter(Boolean).join("\n");
  await env.DB.prepare(
    `INSERT INTO pipeline (account_id, company_id, status, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (account_id, company_id) DO UPDATE SET status = ?3, notes = ?4 || char(10) || char(10) || notes, updated_at = ?5`
  ).bind(ctx.accountId, id, STATUSES.includes(x.stage) ? x.stage : c.status, lines, now()).run();
  return { extracted: x, notes: lines, transcript: text };
}

// Companies an account can see: anything its searches found, plus anything in its pipeline.
const VISIBLE = `(EXISTS (SELECT 1 FROM search_results v JOIN searches vs ON vs.id = v.search_id WHERE v.company_id = c.id AND vs.account_id = ?1) OR p.company_id IS NOT NULL)`;

async function home(env, ctx) {
  const a = ctx.accountId;
  const [totals, funnel, inbound, runs, fresh] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS companies, SUM(c.fit_score >= 50) AS good, SUM(c.owner_age >= 60) AS owners60,
      SUM(c.valuation_mid IS NOT NULL) AS valued, COUNT(DISTINCT c.country) AS countries
      FROM companies c LEFT JOIN pipeline p ON p.company_id = c.id AND p.account_id = ?1 WHERE c.excluded = 0 AND ${VISIBLE}`).bind(a),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM pipeline WHERE account_id = ?1 AND status != 'New' GROUP BY status").bind(a),
    env.DB.prepare("SELECT l.id, l.name, l.timeline, l.created_at, l.valuation_low, l.valuation_high, l.currency, c.id AS company_id, c.name AS company FROM leads l LEFT JOIN companies c ON c.id = l.company_id WHERE l.account_id = ?1 ORDER BY l.id DESC LIMIT 5").bind(a),
    env.DB.prepare("SELECT r.id, r.status, r.summary, r.targets, r.started_at, a.id AS agent_id, a.name FROM agent_runs r JOIN agents a ON a.id = r.agent_id WHERE a.account_id = ?1 ORDER BY r.id DESC LIMIT 6").bind(a),
    env.DB.prepare(`SELECT c.id, c.name, c.city, c.country, c.owner_name, c.owner_age, c.valuation_mid, c.currency, c.verdict, c.fit_score, c.summary
      FROM companies c LEFT JOIN pipeline p ON p.company_id = c.id AND p.account_id = ?1
      WHERE c.excluded = 0 AND c.fit_score >= 60 AND ${VISIBLE} ORDER BY c.updated_at DESC, c.fit_score DESC LIMIT 6`).bind(a),
  ]);
  return { totals: totals.results[0], funnel: funnel.results, statuses: STATUSES, inbound: inbound.results, runs: runs.results, fresh: fresh.results };
}

// ------------------------------------------------------------------ MCP tool implementations
function mcpOps(env, ctx) {
  const slim = (r) => ({
    id: r.id, name: r.name, country: r.country, city: r.city, owner: r.owner_name, owner_age: r.owner_age, founded: r.founded,
    staff: r.employees_band, revenue: r.revenue, valuation_mid: r.valuation_mid, currency: r.currency,
    fit: r.fit_score, verdict: r.verdict, summary: r.summary, status: r.status,
  });
  return {
    list_sources: async () => ({
      countries: providerInfo(env).map(({ regions, ...c }) => ({ ...c, regions: Array.isArray(regions) ? regions : "free text" })),
      industries: INDUSTRIES.map(({ id, label }) => ({ id, label })),
      your_territories: (await myTerritories(env, ctx.accountId)).map(({ country, industry, region, label }) => ({ country, industry, region, label })),
    }),
    start_search: (a) => createSearch(env, a, ctx),
    list_searches: async () => (await listSearches(env, ctx)).map(({ id, label, status, pages_done, pages, found, strong, error }) => ({ id, label, status, progress: pages ? `${pages_done}/${pages}` : null, found, worth_a_call: strong, error })),
    find_targets: async (a) => {
      const q = new URLSearchParams();
      for (const k of ["search", "country", "q", "minOwnerAge", "minStaff", "minFit", "sort"]) if (a[k] != null) q.set(k, String(a[k]));
      q.set("limit", String(a.limit || 25));
      const d = await listCompanies(env, q, ctx);
      return { total: d.total, targets: d.rows.map(slim) };
    },
    get_company: async ({ id }) => {
      const c = await company(env, id, ctx);
      const { signals, people, notes, ...rest } = c;
      return { ...rest, people, notes, why: signals.map((s) => `${s.pts > 0 ? "+" : ""}${s.pts} ${s.label}: ${s.detail}`) };
    },
    value_deal: async ({ id, price }) => {
      const d = await deal(env, id, price, ctx);
      if (!d.available) return d;
      const m = (v) => Math.round(v);
      return {
        company: d.company, currency: d.currency,
        valuation: { basis: d.valuation.basis, confidence: d.valuation.confidence, ebitda: m(d.valuation.ebitda), multiple: d.valuation.multiple, equity_low: m(d.valuation.equity[0]), equity_mid: m(d.valuation.equity[1]), equity_high: m(d.valuation.equity[2]) },
        price_tested: m(d.price),
        recommended: d.best.label,
        structures: d.structures.map((s) => ({ name: s.label, how: s.blurb, min_dscr: s.minDscr && +s.minDscr.toFixed(2), bankable_at_1_5x: s.bankable, max_price_at_1_5x: s.maxPriceAt15 && m(s.maxPriceAt15), debt_service_by_year: s.debtService.map(m) })),
      };
    },
    update_pipeline: ({ id, ...rest }) => savePipeline(env, id, rest, ctx),
    write_brief: async ({ id }) => (await ai(env, id, { kind: "brief" }, ctx)).content,
    add_company: async ({ country, number }) => slim(await addCompany(env, { country, number }, ctx)),
    plan_agent: async ({ goal }) => planAgent(env, ctx, goal),
    launch_agent: async ({ goal }) => {
      const plan = await planAgent(env, ctx, goal);
      const a = await createAgent(env, { name: plan.name, goal: plan.goal, config: plan.config, trigger: "mcp" }, ctx);
      return { id: a.id, name: a.name, plan: a.steps.map((s) => `${s.title}: ${s.text}`), status: "running" };
    },
    agent_status: async ({ id }) => {
      const a = await getAgent(env, id, ctx);
      const r = a.runs[0];
      return { name: a.name, schedule: a.config.schedule, last_run: r && { status: r.status, summary: r.summary, log: r.log.map((l) => l.text) }, targets: a.targets.slice(0, 20) };
    },
  };
}

// ------------------------------------------------------------------ companies
const SORTS = {
  fit: "c.fit_score DESC", size: "c.size_score DESC", succession: "c.succession_score DESC",
  owner_age: "c.owner_age IS NULL, c.owner_age DESC", founded: "c.founded IS NULL, c.founded ASC",
  value: "c.valuation_mid IS NULL, c.valuation_mid DESC",
  staff: "c.employees_min IS NULL, c.employees_min DESC", name: "c.name ASC",
};
// ?1 is always the account id.
function filters(q, ctx) {
  const where = [], binds = [ctx.accountId];
  const bind = (v) => { binds.push(v); return `?${binds.length}`; };
  let from = "companies c";
  if (q.get("search")) from += ` JOIN search_results sr ON sr.company_id = c.id AND sr.search_id = ${bind(+q.get("search"))} JOIN searches ss ON ss.id = sr.search_id AND ss.account_id = ?1`;
  from += " LEFT JOIN pipeline p ON p.company_id = c.id AND p.account_id = ?1";
  where.push(VISIBLE);
  if (q.get("excluded") !== "1") where.push("c.excluded = 0");
  if (q.get("country")) where.push(`c.country = ${bind(q.get("country"))}`);
  if (q.get("q")) { const b = bind(`%${q.get("q").trim()}%`); where.push(`(c.name LIKE ${b} OR c.city LIKE ${b} OR c.owner_name LIKE ${b} OR c.postcode LIKE ${b})`); }
  const verdicts = q.getAll("verdict").filter(Boolean);
  if (verdicts.length) where.push(`c.verdict IN (${verdicts.map(bind).join(",")})`);
  for (const [k, col] of [["minFit", "c.fit_score"], ["minOwnerAge", "c.owner_age"], ["minStaff", "c.employees_min"]]) {
    if (Number(q.get(k)) > 0) where.push(`${col} >= ${bind(Number(q.get(k)))}`);
  }
  if (q.get("ownerKnown") === "1") where.push("c.owner_age IS NOT NULL");
  if (q.get("valued") === "1") where.push("c.valuation_mid IS NOT NULL");
  const status = q.get("status");
  if (status === "Any") where.push("p.status IS NOT NULL AND p.status != 'New'");
  else if (STATUSES.includes(status)) where.push(status === "New" ? "(p.status IS NULL OR p.status = 'New')" : `p.status = ${bind(status)}`);
  return { from, where: `WHERE ${where.join(" AND ")}`, binds, order: `ORDER BY ${SORTS[q.get("sort")] || SORTS.fit}, c.fit_score DESC, c.id` };
}
const LIST = `c.id, c.country, c.name, c.legal_form, c.city, c.region, c.founded, c.employees_min, c.employees_band, c.revenue, c.currency,
  c.owner_name, c.owner_age, c.size_score, c.succession_score, c.fit_score, c.verdict, c.summary, c.reviews, c.rating,
  c.valuation_mid, c.inbound,
  COALESCE(p.status, 'New') AS status`;

async function listCompanies(env, q, ctx) {
  const f = filters(q, ctx);
  const limit = Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const page = Math.max(1, Number(q.get("page")) || 1);
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(`SELECT ${LIST} FROM ${f.from} ${f.where} ${f.order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).bind(...f.binds),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${f.from} ${f.where}`).bind(...f.binds),
  ]);
  return { total: total.results[0].n, page, limit, rows: rows.results };
}

export async function company(env, id, ctx) {
  const c = await env.DB.prepare(
    `SELECT c.*, COALESCE(p.status, 'New') AS status, COALESCE(p.notes, '') AS notes, p.updated_at AS pipeline_updated
     FROM companies c LEFT JOIN pipeline p ON p.company_id = c.id AND p.account_id = ?1 WHERE c.id = ?2 AND ${VISIBLE}`
  ).bind(ctx.accountId, id).first();
  if (!c) fail(404, "Company not found");
  c.people = JSON.parse(c.people || "[]");
  c.signals = JSON.parse(c.signals || "[]");
  const { results } = await env.DB.prepare("SELECT kind, model, content, created_at FROM ai_outputs WHERE account_id = ?1 AND company_id = ?2").bind(ctx.accountId, id).all();
  c.ai = Object.fromEntries(results.map((r) => [r.kind, r]));
  return c;
}

async function savePipeline(env, id, body, ctx) {
  if (body.status != null && !STATUSES.includes(body.status)) fail(400, "Invalid status");
  await company(env, id, ctx);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO pipeline (account_id, company_id, status, notes, updated_at) VALUES (?1, ?2, COALESCE(?3, 'New'), COALESCE(?4, ''), ?5)
     ON CONFLICT (account_id, company_id) DO UPDATE SET status = COALESCE(?3, status), notes = COALESCE(?4, notes), updated_at = ?5`
  ).bind(ctx.accountId, id, body.status ?? null, typeof body.notes === "string" ? body.notes.slice(0, 20000) : null, t).run();
  return { ok: true, updated_at: t };
}

async function pipeline(env, ctx) {
  const { results } = await env.DB.prepare(
    `SELECT ${LIST}, p.notes, p.updated_at FROM pipeline p JOIN companies c ON c.id = p.company_id
     WHERE p.account_id = ?1 AND p.status != 'New' ORDER BY p.updated_at DESC`
  ).bind(ctx.accountId).all();
  return { statuses: STATUSES, rows: results };
}

async function stats(env, q, ctx) {
  const f = filters(new URLSearchParams(q.get("search") ? { search: q.get("search") } : {}), ctx);
  const { results } = await env.DB.prepare(
    `SELECT c.verdict, COUNT(*) AS n, SUM(c.owner_age >= 60) AS owner60 FROM ${f.from} ${f.where} GROUP BY c.verdict`
  ).bind(...f.binds).all();
  return results;
}

// ------------------------------------------------------------------ export
const CSV = {
  full: [["Company", "name"], ["Country", "country"], ["Verdict", "verdict"], ["Fit", "fit_score"], ["Succession", "succession_score"], ["Size", "size_score"],
    ["Owner", "owner_name"], ["Owner age", "owner_age"], ["Founded", "founded"], ["Staff", "employees_band"], ["Revenue", "revenue"], ["Currency", "currency"],
    ["Address", "address"], ["City", "city"], ["Postcode", "postcode"], ["Phone", "phone"], ["Website", "website"], ["Email", "email"],
    ["Legal form", "legal_form"], ["Registry", "registry_url"], ["Status", "status"], ["Summary", "summary"]],
  mail: [["name", "owner_name"], ["company", "name"], ["address", "address"], ["city", "city"], ["postcode", "postcode"], ["country", (r) => r.country.toUpperCase()]],
  email: [["email", "email"], ["first_name", (r) => (r.owner_name || "").split(" ")[0]], ["last_name", (r) => (r.owner_name || "").split(" ").slice(1).join(" ")],
    ["company_name", "name"], ["city", "city"], ["founded", "founded"], ["owner_age", "owner_age"]],
};
async function exportCsv(env, q, ctx) {
  const format = CSV[q.get("format")] ? q.get("format") : "full";
  const f = filters(q, ctx);
  const extra = { mail: "c.address IS NOT NULL AND c.owner_name IS NOT NULL", email: "c.email IS NOT NULL" }[format];
  const where = extra ? `${f.where} AND ${extra}` : f.where;
  const { results } = await env.DB.prepare(`SELECT c.*, COALESCE(p.status, 'New') AS status FROM ${f.from} ${where} ${f.order} LIMIT 10000`).bind(...f.binds).all();
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const cols = CSV[format];
  const out = [cols.map(([h]) => h).join(","), ...results.map((r) => cols.map(([, k]) => cell(typeof k === "function" ? k(r) : r[k])).join(","))].join("\n");
  return new Response(out + "\n", { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="dealflow-${format}.csv"` } });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
}
