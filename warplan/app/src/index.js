// Warplan: an AI acquisition team for owners of $1M+ businesses who grow by buying competitors with no money down.
//   Agents: Josh (advisor, voice), Seller Simulator, Deal Desk (LOI, memo), Outreach, Diligence, AI Board, Integrator.
//   Tools: Deal Builder, Value Ladder, Pipeline. Platform: teams, bring-your-own AI keys, API tokens, webhooks, usage.
import { transcribe } from "./ai.js";
import { publicAgents } from "./agents.js";
import { getContext, findUserForLogin, verifyPassword, hashPassword, passwordProblem, sessionCookie, clearCookie, sha256, randomToken } from "./auth.js";
import { json, fail, body, now, slow, cleanEmail, displayName, needOwner } from "./http.js";
import { listThreads, getThread, createThread, updateThread, deleteThread, send, sendStream, debrief, simulatorInfo, speakCached } from "./conversations.js";
import { listTargets, getTarget, createTarget, updateTarget, deleteTarget, addEvent, deleteEvent, importTargets, exportCsv, hookEmitter, listHooks, createHook, testHook, deleteHook, rowToTarget } from "./pipeline.js";
import { deskAgents } from "./desk.js";
import { createDocument, getProfile } from "./documents.js";
import { listKeys, saveKey, deleteKey, aiEnv, dataKeys, MODELS } from "./keys.js";
import { checkLimits, record, summary } from "./usage.js";
import { STAGES } from "../public/js/deal.js";
import { handleMcp } from "./mcp.js";
import { listInbox, decide, propose, autopilotRun, autopilotAll, getSetting, setSetting } from "./autopilot.js";
import { TOOLS } from "./tools.js";
import { scoutInfo, scoutSearch, toTarget } from "./scout.js";
import { listContacts, enrichTarget, addContact, deleteContact } from "./contacts.js";
import { balance as monidBalance, budget as monidBudget, setBudget as setMonidBudget, recentRuns, discover as monidDiscover, describe as monidDescribe, run as monidRun, compact } from "./monid.js";
import { deepEnrich } from "./waterfall.js";
import { connectedSequencers, listCampaigns, pushToCampaign, replyHookInfo, rotateReplyHook, accountForReplyHook, handleReply, SEQUENCERS } from "./sequencers.js";
import { queue as callQueue, logCall, callHistory, startBridge, bridgeStatus, hangup } from "./dialer.js";
import { refreshNumbers } from "./phone.js";
import { phoneStatus, setupPhone, setIncoming, removePhone, phoneToken, lookup as phoneLookup, sendSms, threads as smsThreads, recentCalls, twilioHook } from "./phone.js";
import { getMailbox, saveMailbox, deleteMailbox, sendEmail, listSent, suppress, listSuppressions, unsuppress, PRESETS } from "./mailer.js";

const INVITE_DAYS = 7;
// Reachable without signing in. Everything else (the app shell, its scripts) needs a session.
const PUBLIC_PATHS = new Set(["/login", "/login.html", "/login.js", "/join", "/join.html", "/join.js", "/style.css", "/favicon.svg", "/robots.txt", "/404", "/404.html", "/manifest.webmanifest", "/og.png", "/apple-touch-icon.png"]);
const STATE_KEYS = new Set(["deal", "ladder", "profile", "prefs"]);

export default {
  async fetch(request, env, exec) {
    return secure(await handle(request, env, exec));
  },
  // Cron Trigger (wrangler.jsonc): the morning autopilot run for every workspace.
  async scheduled(event, env, exec) {
    exec.waitUntil(autopilotAll(env, exec));
  },
};

// Browser hardening on every response: no framing, no MIME sniffing, a strict content policy (own scripts only,
// Google Fonts, audio from blob: for voice playback), and microphone access limited to this site.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob: https://sdk.twilio.com https://media.twiliocdn.com; connect-src 'self' https://*.twilio.com wss://*.twilio.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), interest-cohort=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Cross-Origin-Opener-Policy": "same-origin",
};
function secure(res) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  const type = out.headers.get("Content-Type") || "";
  if (type.includes("application/json") || type.includes("text/html")) out.headers.set("Cache-Control", "no-store");
  return out;
}

async function handle(request, env, exec) {
  const url = new URL(request.url), p = url.pathname;
  try {
    if (p.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method)) checkOrigin(request, url);
    if (p === "/api/auth/state" || p === "/api/setup" || p === "/api/login" || p === "/api/logout" || p.startsWith("/api/invites/")) return await authRoute(request, env, url);
    if (PUBLIC_PATHS.has(p)) return asset(request, env, p);
    if (p.startsWith("/hooks/replies/")) return await replyHook(request, env, url, exec);
    if (p.startsWith("/hooks/twilio/")) return await twilioHook(request, env, url, (accountId) => hookEmitter(env, accountId, (pr) => exec.waitUntil(pr)));
    if (p === "/mcp" || p.startsWith("/mcp/")) return await mcpRoute(request, env, url, exec);
    const ctx = await getContext(request, env);
    if (p === "/api" || p.startsWith("/api/")) {
      if (!ctx) return json({ error: "Not signed in. Use your session cookie or an API token: Authorization: Bearer wp_..." }, 401);
      return await route(request, env, url, ctx, exec);
    }
    if (!ctx) {
      if (p === "/" || p === "/index.html") return Response.redirect(`${url.origin}/login`, 302);
      return (await exists(env, url, p)) ? Response.redirect(`${url.origin}/login`, 302) : notFound(request, env);
    }
    return asset(request, env, p);
  } catch (err) {
    if (!err.status) console.error(err);
    return json({ error: err.status ? err.message : "Something went wrong on our side. Try again." }, err.status || 500);
  }
}

// MCP clients authenticate with an API token: in the Authorization header, or in the path (/mcp/wp_...) for clients
// that can only take a URL. Browser-origin requests from other sites are refused.
async function mcpRoute(request, env, url, exec) {
  const pathToken = url.pathname.match(/^\/mcp\/(wp_[\w-]{20,})$/)?.[1];
  if (url.pathname !== "/mcp" && !pathToken) return json({ error: "Not found" }, 404);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return json({ error: "Cross-site request blocked" }, 403);
  const headers = new Headers(request.headers);
  if (pathToken) headers.set("Authorization", `Bearer ${pathToken}`);
  const authed = new Request(request, { headers });
  const ctx = (headers.get("Authorization") || "").startsWith("Bearer ") ? await getContext(authed, env) : null;
  if (!ctx) return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: create an API token in Warplan (Settings → Connect) and send it as Authorization: Bearer wp_..." } }, 401, { "WWW-Authenticate": 'Bearer realm="warplan"' });
  return handleMcp(authed, env, ctx, exec);
}

// Sequencer reply webhooks (Instantly, Smartlead, EmailBison, or anything that POSTs JSON): the secret token in the
// path identifies the workspace. Triage runs after we answer, so the sequencer never times out waiting on the AI.
async function replyHook(request, env, url, exec) {
  if (request.method !== "POST") return json({ error: "POST the reply as JSON" }, 405);
  const token = url.pathname.slice("/hooks/replies/".length);
  const account = await accountForReplyHook(env, token);
  if (!account) { await slow(); return json({ error: "Unknown webhook" }, 404); }
  const raw = await request.text();
  if (raw.length > 200000) return json({ error: "Too large" }, 413);
  let payload; try { payload = JSON.parse(raw); } catch { return json({ error: "Send JSON" }, 400); }
  const provider = SEQUENCERS.find((s) => url.searchParams.get("from") === s) || (request.headers.get("User-Agent") || "").toLowerCase().match(/instantly|smartlead|emailbison/)?.[0] || "";
  const ctx = { accountId: account.account_id };
  const hooks = hookEmitter(env, account.account_id, (pr) => exec.waitUntil(pr));
  exec.waitUntil((async () => { try { await handleReply(env, account, payload, await aiEnv(env, ctx), hooks, provider); } catch (e) { console.error("reply hook", e); } })());
  return json({ ok: true });
}

// Cookie-authenticated writes must come from this site (defence in depth on top of SameSite=Lax).
function checkOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin && !request.headers.get("Authorization")) fail(403, "Cross-site request blocked");
}

async function exists(env, url, p) {
  const r = await env.ASSETS.fetch(new Request(new URL(p, url.origin), { method: "HEAD" }));
  return r.ok;
}
async function asset(request, env, path) {
  if (/(^|\/)\.|\.(map|sql|md|jsonc|toml)$/i.test(path)) return notFound(request, env);
  const res = await env.ASSETS.fetch(new Request(new URL(path, request.url), request));
  if (res.status === 404) return notFound(request, env);
  return res;
}
async function notFound(request, env) {
  const page = await env.ASSETS.fetch(new Request(new URL("/404", request.url)));
  return new Response(page.body, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ------------------------------------------------------------------ sign-in, setup, invites
async function authRoute(request, env, url) {
  const p = url.pathname, m = request.method;
  if (p === "/api/auth/state" && m === "GET") return json({ needsSetup: !(await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n });
  if (p === "/api/setup" && m === "POST") {
    // First run only: whoever holds DASHBOARD_PASSWORD becomes the admin of account 1.
    const b = await body(request);
    if ((await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first()).n) fail(409, "Already set up. Sign in instead.");
    if (!env.DASHBOARD_PASSWORD || b.setupKey !== env.DASHBOARD_PASSWORD) { await slow(); fail(401, "Wrong setup key"); }
    const email = cleanEmail(b.email);
    if (!email) fail(400, "Enter a valid email");
    const problem = passwordProblem(b.password);
    if (problem) fail(400, problem);
    const u = await env.DB.prepare("INSERT INTO users (account_id, email, name, role, is_admin, password_hash, created_at) VALUES (1, ?1, ?2, 'owner', 1, ?3, ?4) RETURNING *")
      .bind(email, String(b.name || "").trim().slice(0, 80), await hashPassword(b.password), now()).first();
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/login" && m === "POST") {
    const b = await body(request);
    const u = await findUserForLogin(env, b.email);
    if (!u || !(await verifyPassword(String(b.password || ""), u.password_hash))) { await slow(); fail(401, "Wrong email or password"); }
    if (!u.account_active) fail(403, "This account is paused");
    await env.DB.prepare("UPDATE users SET last_login_at = ?2 WHERE id = ?1").bind(u.id, now()).run();
    return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, u) });
  }
  if (p === "/api/logout" && m === "POST") return json({ ok: true }, 200, { "Set-Cookie": clearCookie });
  const r = p.match(/^\/api\/invites\/([\w-]{20,})$/);
  if (r) {
    const inv = await env.DB.prepare(
      `SELECT i.*, a.name AS account_name, u.name AS inviter FROM invites i JOIN accounts a ON a.id = i.account_id LEFT JOIN users u ON u.id = i.created_by
       WHERE i.token_hash = ?1 AND i.accepted_at IS NULL AND i.expires_at > ?2`
    ).bind(await sha256(r[1]), now()).first();
    if (!inv) fail(404, "This invite link has expired or was already used. Ask for a new one.");
    if (m === "GET") return json({ account: inv.account_name, email: inv.email, role: inv.role, inviter: inv.inviter || "" });
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

// ------------------------------------------------------------------ routes
async function route(request, env, url, ctx, exec) {
  const p = url.pathname, m = request.method, q = url.searchParams;
  const hooks = hookEmitter(env, ctx.accountId, (pr) => exec.waitUntil(pr));
  if (p === "/api" || p === "/api/") return json(API_DOCS);

  // You
  if (p === "/api/me" && m === "GET") return json(await me(env, ctx));
  if (p === "/api/me" && m === "PATCH") return json(await updateMe(env, ctx, await body(request)));
  if (p === "/api/me/password" && m === "POST") return changePassword(env, ctx, await body(request));
  let r;
  if ((r = p.match(/^\/api\/state\/(\w+)$/))) {
    if (!STATE_KEYS.has(r[1])) fail(404, "Unknown state key");
    if (!ctx.user.id) fail(400, "Saved state belongs to a signed-in user");
    if (m === "GET") { const row = await env.DB.prepare("SELECT data, updated_at FROM user_state WHERE user_id = ?1 AND key = ?2").bind(ctx.user.id, r[1]).first(); return json(row ? { data: JSON.parse(row.data), updated_at: row.updated_at } : { data: null }); }
    if (m === "PUT") {
      const raw = await request.text();
      if (raw.length > 20000) fail(413, "Too much to save");
      let data; try { data = JSON.parse(raw); } catch { fail(400, "Invalid JSON"); }
      if (!data || typeof data !== "object") fail(400, "Send a JSON object");
      await env.DB.prepare("INSERT INTO user_state (user_id, key, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, key) DO UPDATE SET data = ?3, updated_at = ?4").bind(ctx.user.id, r[1], JSON.stringify(data), now()).run();
      return json({ ok: true });
    }
  }

  // Overview, search
  if (p === "/api/home" && m === "GET") return json(await home(env, ctx));
  if (p === "/api/search" && m === "GET") return json(await search(env, ctx, q.get("q")));
  if (p === "/api/agents" && m === "GET") {
    const ai = await aiEnv(env, ctx);
    return json({ agents: publicAgents(), ...simulatorInfo(), desk: deskAgents(), stages: STAGES, brain: ai.ANTHROPIC_API_KEY ? { kind: "claude", model: ai.CLAUDE_MODEL, own: ai.ownKey } : { kind: "workers-ai", own: false }, voice: ai.ELEVENLABS_API_KEY ? (ai.ownVoice ? "own" : "platform") : "workers-ai" });
  }

  // Conversations
  if (p === "/api/threads" && m === "GET") return json(await listThreads(env, ctx, q));
  if (p === "/api/threads" && m === "POST") return json(await createThread(env, ctx, await body(request)), 201);
  if ((r = p.match(/^\/api\/threads\/(\d+)$/))) {
    if (m === "GET") return json(await getThread(env, ctx, +r[1]));
    if (m === "PATCH") return json(await updateThread(env, ctx, +r[1], await body(request)));
    if (m === "DELETE") return json(await deleteThread(env, ctx, +r[1]));
  }
  if ((r = p.match(/^\/api\/threads\/(\d+)\/messages$/)) && m === "POST") {
    const b = await body(request);
    return (request.headers.get("Accept") || "").includes("text/event-stream") || q.get("stream") === "1" ? sendStream(env, ctx, +r[1], b, exec, hooks) : send(env, ctx, +r[1], b, hooks);
  }
  if ((r = p.match(/^\/api\/threads\/(\d+)\/debrief$/)) && m === "POST") return json(await debrief(env, ctx, +r[1], hooks), 201);

  // Voice
  if (p === "/api/voice/transcribe" && m === "POST") {
    const buf = await request.arrayBuffer();
    if (!buf.byteLength) fail(400, "No audio received");
    if (buf.byteLength > 12e6) fail(413, "Recording too long; keep it under about 5 minutes");
    return json(await transcribe(env, buf, q.get("hint") || ""));
  }
  if (p === "/api/voice/speak" && m === "POST") {
    const b = await body(request);
    if (!String(b.text || "").trim()) fail(400, "Nothing to say");
    return speakCached(request, env, ctx, String(b.text).slice(0, 1900), String(b.speaker || ""));
  }

  // Pipeline
  if (p === "/api/targets" && m === "GET") return json(await listTargets(env, ctx, q));
  if (p === "/api/targets" && m === "POST") return json(await createTarget(env, ctx, await body(request), hooks), 201);
  if (p === "/api/targets/import" && m === "POST") return json(await importTargets(env, ctx, await body(request), hooks), 201);
  if (p === "/api/targets.csv" && m === "GET") return exportCsv(env, ctx);
  if ((r = p.match(/^\/api\/targets\/(\d+)$/))) {
    if (m === "GET") {
      const t = await getTarget(env, ctx, +r[1]);
      const [contacts, emails, calls, campaigns] = await Promise.all([
        listContacts(env, ctx, t.id), listSent(env, ctx, t.id),
        env.DB.prepare("SELECT id, disposition, notes, duration, phone, created_at FROM calls WHERE account_id = ?1 AND target_id = ?2 ORDER BY id DESC LIMIT 20").bind(ctx.accountId, t.id).all().then((x) => x.results),
        env.DB.prepare("SELECT provider, campaign_name, email, status, created_at FROM campaign_leads WHERE account_id = ?1 AND target_id = ?2 ORDER BY id DESC").bind(ctx.accountId, t.id).all().then((x) => x.results),
      ]);
      return json({ ...t, contacts, emails, calls, campaigns });
    }
    if (m === "PATCH") return json(await updateTarget(env, ctx, +r[1], await body(request), hooks));
    if (m === "DELETE") return json(await deleteTarget(env, ctx, +r[1], hooks));
  }
  if ((r = p.match(/^\/api\/targets\/(\d+)\/events$/)) && m === "POST") return json(await addEvent(env, ctx, +r[1], await body(request), hooks), 201);
  if ((r = p.match(/^\/api\/targets\/(\d+)\/events\/(\d+)$/)) && m === "DELETE") return json(await deleteEvent(env, ctx, +r[1], +r[2]));

  // Contacts
  if ((r = p.match(/^\/api\/targets\/(\d+)\/contacts$/))) {
    if (m === "GET") return json(await listContacts(env, ctx, +r[1]));
    if (m === "POST") return json(await addContact(env, ctx, +r[1], await body(request)), 201);
  }
  if ((r = p.match(/^\/api\/targets\/(\d+)\/contacts\/find$/)) && m === "POST") return json(await enrichTarget(env, ctx, +r[1], await dataKeys(env, ctx)));
  if ((r = p.match(/^\/api\/targets\/(\d+)\/enrich$/)) && m === "POST") { const b = await body(request); return json(await deepEnrich(env, ctx, +r[1], { mobile: !!b.mobile, linkedin: b.linkedin !== false })); }
  if ((r = p.match(/^\/api\/targets\/(\d+)\/contacts\/(\d+)$/)) && m === "DELETE") return json(await deleteContact(env, ctx, +r[1], +r[2]));

  // Scout: find companies in registries and maps, import them
  if (p === "/api/scout" && m === "GET") return json(scoutInfo(await dataKeys(env, ctx)));
  if (p === "/api/scout/search" && m === "POST") return json(await scoutSearch(env, ctx, await body(request), await dataKeys(env, ctx)));
  if (p === "/api/scout/import" && m === "POST") {
    const b = await body(request);
    const rows = (Array.isArray(b.companies) ? b.companies : []).filter((c) => c?.name).slice(0, 100).map((c) => toTarget(c, b.currency));
    if (!rows.length) fail(400, "Pick at least one company");
    const out = await importTargets(env, ctx, { rows }, hooks);
    hooks.emit("scout.imported", { count: out.imported });
    // Optionally run the contact finder on the new targets (in the background; it reads their websites).
    // The free website scan runs in the background. Deep enrich (paid, slower) is driven by the browser one target
    // at a time through /api/targets/:id/enrich, so it never runs into the background time limit.
    if (b.find_contacts && out.imported) {
      const names = rows.map((x) => x.name);
      exec.waitUntil((async () => {
        const keys = await dataKeys(env, ctx);
        const { results } = await env.DB.prepare(`SELECT id FROM targets WHERE account_id = ?1 AND name IN (${names.map((_, i) => `?${i + 2}`).join(",")}) ORDER BY id DESC LIMIT ?${names.length + 2}`).bind(ctx.accountId, ...names, names.length).all();
        for (const t of results.slice(0, 25)) {
          try { await enrichTarget(env, ctx, t.id, keys); } catch (e) { console.warn("enrich", t.id, e.message); }
        }
      })());
    }
    return json(out, 201);
  }

  // Monid data marketplace: wallet, budget, spend log, and a console to search and run any endpoint
  if (p === "/api/monid" && m === "GET") {
    const [bal, bud, runs] = await Promise.all([monidBalance(env, ctx).catch((e) => ({ connected: true, error: e.message })), monidBudget(env, ctx), recentRuns(env, ctx)]);
    return json({ ...bal, budget: bud, runs, canEdit: ctx.isOwner });
  }
  if (p === "/api/monid/budget" && m === "PUT") { needOwner(ctx); return json(await setMonidBudget(env, ctx, await body(request))); }
  if (p === "/api/monid/discover" && m === "POST") { const b = await body(request); if (!String(b.query || "").trim()) fail(400, "Describe the data you need"); return json({ endpoints: await monidDiscover(env, ctx, b.query, b.limit || 10) }); }
  if (p === "/api/monid/inspect" && m === "POST") { const b = await body(request); return json(await monidDescribe(env, ctx, String(b.provider || ""), String(b.endpoint || ""))); }
  if (p === "/api/monid/run" && m === "POST") {
    const b = await body(request);
    const out = await monidRun(env, ctx, { provider: String(b.provider || ""), endpoint: String(b.endpoint || ""), input: b.input || {} }, { purpose: String(b.reason || "Data console"), targetId: b.target_id ? +b.target_id : null });
    return json({ ...out, output: b.full ? out.output : compact(out.output) });
  }

  // Cold-email sequencers (Instantly, Smartlead, EmailBison) and the replies coming back
  if (p === "/api/sequencers" && m === "GET") return json({ sequencers: await connectedSequencers(env, ctx), replies: await replyHookInfo(env, ctx) });
  if ((r = p.match(/^\/api\/sequencers\/(\w+)\/campaigns$/)) && m === "GET") return json(await listCampaigns(env, ctx, r[1]));
  if (p === "/api/sequencers/push" && m === "POST") return json(await pushToCampaign(env, ctx, await body(request), hooks, await aiEnv(env, ctx)));
  if (p === "/api/replies/hook" && m === "POST") { needOwner(ctx); return json(await rotateReplyHook(env, ctx, url.origin), 201); }

  // Browser phone (calls and texts on the workspace's Twilio)
  if (p === "/api/phone" && m === "GET") return json(await phoneStatus(env, ctx));
  if (p === "/api/phone" && m === "DELETE") { needOwner(ctx); return json(await removePhone(env, ctx)); }
  if (p === "/api/phone/setup" && m === "POST") { needOwner(ctx); return json(await setupPhone(env, ctx, url.origin)); }
  if (p === "/api/phone/incoming" && m === "PUT") { needOwner(ctx); return json(await setIncoming(env, ctx, !!(await body(request)).on, url.origin)); }
  if (p === "/api/phone/numbers" && m === "POST") { needOwner(ctx); return json(await refreshNumbers(env, ctx)); }
  if (p === "/api/phone/token" && m === "GET") return json(await phoneToken(env, ctx));
  if (p === "/api/phone/lookup" && m === "GET") return json(await phoneLookup(env, ctx, String(q.get("number") || "")));
  if (p === "/api/phone/sms" && m === "POST") return json(await sendSms(env, ctx, await body(request), hooks), 201);
  if (p === "/api/phone/messages" && m === "GET") return json(await smsThreads(env, ctx));
  if (p === "/api/phone/calls" && m === "GET") return json(await recentCalls(env, ctx));

  // Power dialer
  if (p === "/api/dialer/queue" && m === "GET") return json(await callQueue(env, ctx, q));
  if (p === "/api/calls" && m === "GET") return json(await callHistory(env, ctx, q));
  if (p === "/api/calls" && m === "POST") return json(await logCall(env, ctx, await body(request), hooks), 201);
  if (p === "/api/dialer/bridge" && m === "POST") return json(await startBridge(env, ctx, await body(request)));
  if ((r = p.match(/^\/api\/dialer\/bridge\/(\w+)$/))) {
    if (m === "GET") return json(await bridgeStatus(env, ctx, r[1]));
    if (m === "DELETE") return json(await hangup(env, ctx, r[1]));
  }

  // Email from the user's own mailbox
  if (p === "/api/mailbox" && m === "GET") return json(await getMailbox(env, ctx));
  if (p === "/api/mailbox" && m === "PUT") return json(await saveMailbox(env, ctx, await body(request)));
  if (p === "/api/mailbox" && m === "DELETE") return json(await deleteMailbox(env, ctx));
  if (p === "/api/mailbox/test" && m === "POST") {
    const box = await getMailbox(env, ctx);
    if (!box.connected) fail(400, "Connect your mailbox first");
    return json(await sendEmail(env, ctx, { to: box.email, subject: "Warplan test email", body: "This is a test from Warplan. If you can read it, sending from your mailbox works." }, hooks));
  }
  if (p === "/api/email/send" && m === "POST") return json(await sendEmail(env, ctx, await body(request), hooks));
  if (p === "/api/email/sent" && m === "GET") return json(await listSent(env, ctx, q.get("target") ? +q.get("target") : null));
  if (p === "/api/suppressions" && m === "GET") return json(await listSuppressions(env, ctx));
  if (p === "/api/suppressions" && m === "POST") { const b = await body(request); return json(await suppress(env, ctx, b.email, b.reason), 201); }
  if (p === "/api/suppressions" && m === "DELETE") return json(await unsuppress(env, ctx, q.get("email")));

  // Documents (the agents' work)
  if (p === "/api/documents" && m === "GET") return json(await listDocs(env, ctx, q));
  if (p === "/api/documents/generate" && m === "POST") return json(await generateDoc(env, ctx, await body(request), hooks), 201);
  if ((r = p.match(/^\/api\/documents\/(\d+)$/))) {
    if (m === "GET") return json(await getDoc(env, ctx, +r[1]));
    if (m === "PATCH") return json(await updateDoc(env, ctx, +r[1], await body(request)));
    if (m === "DELETE") { await env.DB.prepare("DELETE FROM documents WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId).run(); return json({ ok: true }); }
  }

  // Team, tokens
  if (p === "/api/team" && m === "GET") return json(await team(env, ctx));
  if (p === "/api/team/invites" && m === "POST") return json(await invite(env, ctx, await body(request), url.origin), 201);
  if ((r = p.match(/^\/api\/team\/invites\/(\d+)$/)) && m === "DELETE") {
    needOwner(ctx);
    await env.DB.prepare("DELETE FROM invites WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId).run();
    return json({ ok: true });
  }
  if ((r = p.match(/^\/api\/team\/members\/(\d+)$/))) {
    needOwner(ctx);
    if (+r[1] === ctx.user.id) fail(400, "You can't change your own access here");
    if (m === "DELETE") {
      const gone = await env.DB.prepare("SELECT id FROM users WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId).first();
      if (!gone) fail(404, "That person isn't in this workspace");
      // Their private conversations go with them; targets and documents belong to the workspace and stay.
      await env.DB.batch([
        env.DB.prepare("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE user_id = ?1)").bind(gone.id),
        env.DB.prepare("DELETE FROM threads WHERE user_id = ?1").bind(gone.id),
        env.DB.prepare("DELETE FROM user_state WHERE user_id = ?1").bind(gone.id),
        env.DB.prepare("DELETE FROM api_tokens WHERE user_id = ?1").bind(gone.id),
        env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(gone.id),
      ]);
      return json({ ok: true });
    }
    if (m === "PATCH") {
      const role = (await body(request)).role === "owner" ? "owner" : "member";
      await env.DB.prepare("UPDATE users SET role = ?3, session_epoch = session_epoch + 1 WHERE id = ?1 AND account_id = ?2").bind(+r[1], ctx.accountId, role).run();
      return json({ ok: true, role });
    }
  }
  if (p === "/api/tokens" && m === "POST") return json(await createToken(env, ctx, await body(request)), 201);
  if ((r = p.match(/^\/api\/tokens\/(\d+)$/)) && m === "DELETE") {
    await env.DB.prepare("DELETE FROM api_tokens WHERE id = ?1 AND account_id = ?2 AND (?4 = 1 OR user_id = ?3)").bind(+r[1], ctx.accountId, ctx.user.id, ctx.isOwner ? 1 : 0).run();
    return json({ ok: true });
  }

  // Integrations: bring-your-own keys and webhooks (owners only)
  if (p === "/api/integrations" && m === "GET") return json({ keys: await listKeys(env, ctx.accountId), models: MODELS, ...(await listHooks(env, ctx)), canEdit: ctx.isOwner });
  if ((r = p.match(/^\/api\/integrations\/(\w+)$/))) {
    needOwner(ctx);
    if (m === "PUT") return json(await saveKey(env, ctx, r[1], await body(request)));
    if (m === "DELETE") return json(await deleteKey(env, ctx, r[1]));
  }
  if (p === "/api/webhooks" && m === "POST") { needOwner(ctx); return json(await createHook(env, ctx, await body(request)), 201); }
  if ((r = p.match(/^\/api\/webhooks\/(\d+)\/test$/)) && m === "POST") { needOwner(ctx); return json(await testHook(env, ctx, +r[1])); }
  if ((r = p.match(/^\/api\/webhooks\/(\d+)$/)) && m === "DELETE") { needOwner(ctx); return json(await deleteHook(env, ctx, +r[1])); }
  // Agents: run Josh headless (Zapier, Slack bots, n8n), the approval inbox, autopilot settings, the tool catalogue
  if (p === "/api/agent" && m === "POST") {
    const b = await body(request);
    let threadId = +b.thread_id || null;
    if (!threadId) threadId = (await createThread(env, ctx, { agent: "josh", target: b.target_id })).id;
    return send(env, ctx, threadId, b, hooks);
  }
  if (p === "/api/agent/tools" && m === "GET") return json({ tools: TOOLS.map(({ name, description, input_schema, write }) => ({ name, description, input_schema, write })) });
  if (p === "/api/inbox" && m === "GET") return json(await listInbox(env, ctx, ["pending", "done", "dismissed", "failed", "all"].includes(q.get("status")) ? q.get("status") : "pending"));
  if (p === "/api/inbox" && m === "POST") {
    // External agents (your own scripts, n8n, an MCP client) can queue an action for a person to approve.
    const b = await body(request);
    const id = await propose(env, ctx.accountId, { tool: b.tool, input: b.input, title: b.title || `Run ${b.tool}`, reason: b.reason, target_id: b.target_id, source: b.source || (ctx.viaToken ? "api" : "user") });
    if (id) hooks.emit("action.proposed", { id, tool: b.tool, title: b.title });
    return json({ id, queued: !!id }, id ? 201 : 200);
  }
  if ((r = p.match(/^\/api\/inbox\/(\d+)\/(approve|dismiss)$/)) && m === "POST") return json(await decide(env, ctx, +r[1], r[2] === "approve", hooks));
  if (p === "/api/autopilot" && m === "GET") return json({ settings: await getSetting(env, ctx.accountId, "autopilot", { enabled: true }), schedule: "Every morning at 06:00 UTC" });
  if (p === "/api/autopilot" && m === "PUT") { needOwner(ctx); const b = await body(request); await setSetting(env, ctx.accountId, "autopilot", { enabled: !!b.enabled }); return json({ ok: true, enabled: !!b.enabled }); }
  if (p === "/api/autopilot/run" && m === "POST") { needOwner(ctx); return json(await autopilotRun(env, ctx.accountId, exec)); }

  if (p === "/api/usage" && m === "GET") return json(await summary(env, ctx, Math.min(90, Math.max(1, +q.get("days") || 30))));

  return json({ error: "Not found" }, 404);
}

// ------------------------------------------------------------------ you
async function me(env, ctx) {
  return { user: ctx.user, account: ctx.account, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner, profile: await getProfile(env, ctx) };
}
async function updateMe(env, ctx, b) {
  if (!ctx.user.id) fail(400, "Signed-in users only");
  const name = String(b.name ?? ctx.user.name).trim().slice(0, 80);
  if (!name) fail(400, "Enter your name");
  await env.DB.prepare("UPDATE users SET name = ?2 WHERE id = ?1").bind(ctx.user.id, name).run();
  if (ctx.isOwner && b.workspace) await env.DB.prepare("UPDATE accounts SET name = ?2 WHERE id = ?1").bind(ctx.accountId, String(b.workspace).trim().slice(0, 80) || ctx.account.name).run();
  return { ok: true, name };
}
async function changePassword(env, ctx, b) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(ctx.user.id).first();
  if (!u || !(await verifyPassword(String(b.current || ""), u.password_hash))) { await slow(); fail(401, "Your current password isn't right"); }
  const problem = passwordProblem(b.next);
  if (problem) fail(400, problem);
  // Bumping the epoch signs out every other session.
  const nu = await env.DB.prepare("UPDATE users SET password_hash = ?2, session_epoch = session_epoch + 1 WHERE id = ?1 RETURNING *").bind(u.id, await hashPassword(b.next)).first();
  return json({ ok: true }, 200, { "Set-Cookie": await sessionCookie(env, nu) });
}

// ------------------------------------------------------------------ overview
async function home(env, ctx) {
  const today = now().slice(0, 10), week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
  const [stages, due, events, docs, calls] = await env.DB.batch([
    env.DB.prepare("SELECT stage, COUNT(*) AS n, SUM(COALESCE(ebitda, 0)) AS ebitda, SUM(COALESCE(asking, ebitda * 3, 0)) AS value FROM targets WHERE account_id = ?1 GROUP BY stage").bind(ctx.accountId),
    env.DB.prepare("SELECT id, name, stage, next_action, next_date, priority FROM targets WHERE account_id = ?1 AND stage NOT IN ('closed', 'lost') AND next_date IS NOT NULL AND next_date <= ?2 ORDER BY next_date, priority LIMIT 12").bind(ctx.accountId, week),
    env.DB.prepare("SELECT e.id, e.kind, e.body, e.user_name, e.created_at, t.id AS target_id, t.name FROM target_events e JOIN targets t ON t.id = e.target_id WHERE e.account_id = ?1 ORDER BY e.id DESC LIMIT 10").bind(ctx.accountId),
    env.DB.prepare("SELECT id, kind, title, target_id, created_at FROM documents WHERE account_id = ?1 ORDER BY id DESC LIMIT 6").bind(ctx.accountId),
    env.DB.prepare("SELECT meta, created_at FROM threads WHERE user_id = ?1 AND agent = 'simulator' ORDER BY id DESC LIMIT 20").bind(ctx.user.id || 0),
  ]);
  const byStage = Object.fromEntries(stages.results.map((s) => [s.stage, s]));
  const weighted = STAGES.reduce((t, s) => t + (byStage[s.id]?.value || 0) * (s.id === "closed" ? 0 : s.p), 0);
  const scores = calls.results.map((c) => ({ score: JSON.parse(c.meta).score, at: c.created_at })).filter((c) => c.score != null).reverse();
  return {
    stages: STAGES.map((s) => ({ ...s, n: byStage[s.id]?.n || 0, ebitda: byStage[s.id]?.ebitda || 0 })),
    total: stages.results.reduce((t, s) => t + (s.stage === "lost" ? 0 : s.n), 0),
    weighted,
    due: due.results.map((d) => ({ ...d, overdue: d.next_date < today })),
    events: events.results, documents: docs.results,
    practice: { calls: calls.results.length, thisWeek: calls.results.filter((c) => c.created_at >= weekAgo).length, scores },
  };
}

async function search(env, ctx, term) {
  const s = String(term || "").trim().slice(0, 80);
  if (s.length < 2) return { targets: [], threads: [], documents: [] };
  const like = `%${s}%`;
  const [t, th, d] = await env.DB.batch([
    env.DB.prepare("SELECT id, name, stage, industry, location FROM targets WHERE account_id = ?1 AND (name LIKE ?2 OR owner_name LIKE ?2 OR industry LIKE ?2 OR location LIKE ?2 OR tags LIKE ?2) ORDER BY updated_at DESC LIMIT 8").bind(ctx.accountId, like),
    env.DB.prepare("SELECT id, agent, title FROM threads WHERE user_id = ?1 AND title LIKE ?2 ORDER BY updated_at DESC LIMIT 6").bind(ctx.user.id || 0, like),
    env.DB.prepare("SELECT id, kind, title, target_id FROM documents WHERE account_id = ?1 AND (title LIKE ?2 OR content LIKE ?2) ORDER BY id DESC LIMIT 6").bind(ctx.accountId, like),
  ]);
  return { targets: t.results, threads: th.results, documents: d.results };
}

// ------------------------------------------------------------------ documents
async function listDocs(env, ctx, q) {
  const target = q.get("target"), kind = q.get("kind");
  const { results } = await env.DB.prepare(`SELECT d.id, d.kind, d.title, d.target_id, d.created_at, d.updated_at, t.name AS target_name FROM documents d LEFT JOIN targets t ON t.id = d.target_id
    WHERE d.account_id = ?1 AND (?2 IS NULL OR d.target_id = ?2) AND (?3 IS NULL OR d.kind = ?3) ORDER BY d.id DESC LIMIT 200`).bind(ctx.accountId, target ? +target : null, kind || null).all();
  return results;
}
async function getDoc(env, ctx, id) {
  const d = await env.DB.prepare("SELECT d.*, t.name AS target_name FROM documents d LEFT JOIN targets t ON t.id = d.target_id WHERE d.id = ?1 AND d.account_id = ?2").bind(id, ctx.accountId).first();
  if (!d) fail(404, "Document not found");
  return { ...d, meta: JSON.parse(d.meta) };
}
async function updateDoc(env, ctx, id, b) {
  await getDoc(env, ctx, id);
  const title = b.title != null ? String(b.title).trim().slice(0, 200) : null, content = b.content != null ? String(b.content).slice(0, 100000) : null;
  await env.DB.prepare("UPDATE documents SET title = COALESCE(?3, title), content = COALESCE(?4, content), updated_at = ?5 WHERE id = ?1 AND account_id = ?2").bind(id, ctx.accountId, title || null, content, now()).run();
  return { ok: true };
}
async function generateDoc(env, ctx, b, hooks) {
  return createDocument(env, ctx, await aiEnv(env, ctx), b, hooks);
}

// ------------------------------------------------------------------ team & tokens
async function team(env, ctx) {
  const [members, invites, tokens] = await env.DB.batch([
    env.DB.prepare("SELECT id, email, name, role, is_admin, created_at, last_login_at FROM users WHERE account_id = ?1 ORDER BY id").bind(ctx.accountId),
    env.DB.prepare("SELECT id, email, role, expires_at FROM invites WHERE account_id = ?1 AND accepted_at IS NULL AND expires_at > ?2 ORDER BY id DESC").bind(ctx.accountId, now()),
    env.DB.prepare(`SELECT t.id, t.label, t.created_at, t.last_used_at, u.email FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.account_id = ?1 AND (?3 = 1 OR t.user_id = ?2) ORDER BY t.id DESC`).bind(ctx.accountId, ctx.user.id, ctx.isOwner ? 1 : 0),
  ]);
  return { workspace: ctx.account.name, members: members.results, invites: ctx.isOwner ? invites.results : [], tokens: tokens.results, isOwner: ctx.isOwner, me: ctx.user.id };
}
async function invite(env, ctx, b, origin) {
  needOwner(ctx);
  const email = b.email ? cleanEmail(b.email) : "";
  if (b.email && !email) fail(400, "That email doesn't look right");
  if (email && (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?1").bind(email).first())) fail(409, "That email already has a login");
  const token = randomToken();
  const role = b.role === "owner" ? "owner" : "member";
  await env.DB.prepare("INSERT INTO invites (account_id, email, role, token_hash, expires_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(ctx.accountId, email || null, role, await sha256(token), new Date(Date.now() + INVITE_DAYS * 864e5).toISOString(), ctx.user.id || null).run();
  return { link: `${origin}/join?t=${token}`, email, role, expiresInDays: INVITE_DAYS };
}
async function createToken(env, ctx, b) {
  if (!ctx.user.id) fail(400, "Create tokens from a signed-in user");
  if (ctx.viaToken) fail(403, "API tokens can't create more tokens");
  const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?1").bind(ctx.user.id).first()).n;
  if (n >= 20) fail(400, "Twenty tokens is the limit; revoke one first");
  const token = randomToken("wp_");
  const label = String(b.label || "").trim().slice(0, 60) || "API token";
  const row = await env.DB.prepare("INSERT INTO api_tokens (account_id, user_id, label, token_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id, label, created_at")
    .bind(ctx.accountId, ctx.user.id, label, await sha256(token), now()).first();
  return { ...row, token }; // shown once
}

// ------------------------------------------------------------------ API reference (GET /api)
const API_DOCS = {
  name: "Warplan API",
  auth: "Send Authorization: Bearer <token>. Create tokens under Settings → API. Tokens act as the user who made them.",
  base: "/api",
  endpoints: [
    ["GET", "/api/me", "You, your workspace and profile"],
    ["GET", "/api/home", "Pipeline by stage, due next actions, recent activity, practice scores"],
    ["GET", "/api/search?q=", "Search targets, conversations and documents"],
    ["GET", "/api/targets?stage=&q=", "List targets"],
    ["POST", "/api/targets", "Create a target {name, industry, location, website, owner_name, owner_age, phone, email, employees, revenue, ebitda, asking, currency, stage, priority, source, motivation, next_action, next_date, tags, deal}"],
    ["POST", "/api/targets/import", "Bulk create {rows: [target, ...]} (up to 500)"],
    ["GET", "/api/targets.csv", "Export the pipeline as CSV"],
    ["GET", "/api/targets/:id", "A target with its timeline, documents and conversations"],
    ["PATCH", "/api/targets/:id", "Update any target fields; changing stage logs it and fires target.stage_changed"],
    ["DELETE", "/api/targets/:id", "Delete a target and its timeline and documents"],
    ["POST", "/api/targets/:id/events", "Add to the timeline {kind: note|call|email|meeting, body}"],
    ["POST", "/api/documents/generate", "Have an agent write a document {kind: loi|memo|lender|outreach|diligence|board|plan100, target_id, channel?: letter|email|call|linkedin|voicemail, language?, financials? (diligence)}"],
    ["GET", "/api/documents?target=&kind=", "List documents"],
    ["GET", "/api/documents/:id", "A document"],
    ["PATCH", "/api/documents/:id", "Edit {title, content}"],
    ["GET", "/api/threads?agent=josh|simulator&q=&target=", "Your conversations"],
    ["POST", "/api/threads", "Start one {agent: josh, target?} or {agent: simulator, seller | target, difficulty, stage: first|deal}"],
    ["POST", "/api/threads/:id/messages", "Send {text} → {reply}. Add Accept: text/event-stream to stream"],
    ["POST", "/api/threads/:id/debrief", "Score a practice call; returns Josh's debrief"],
    ["POST", "/api/voice/transcribe", "Raw audio body → {text}"],
    ["POST", "/api/voice/speak", "{text, speaker} → audio/mpeg"],
    ["POST", "/api/agent", "Run Josh as an agent, headless {text, thread_id?, target_id?} → {reply, actions, thread}. He uses the same tools as in the app"],
    ["GET", "/api/agent/tools", "The agent tool catalogue (also served over MCP at /mcp)"],
    ["GET", "/api/inbox?status=pending", "Actions agents proposed, waiting for approval"],
    ["POST", "/api/inbox", "Queue an action for approval {tool, input, title, reason, target_id}"],
    ["POST", "/api/inbox/:id/approve", "Approve (runs it as you) · /dismiss to drop it"],
    ["POST", "/api/autopilot/run", "Run the morning autopilot now (owners)"],
    ["POST", "/mcp", "MCP server (Streamable HTTP): tools/list, tools/call. Auth: Bearer token or /mcp/<token>"],
    ["POST", "/api/scout/search", "Find companies {source: no|fr|uk|places|osm, industry, region, min_staff, page}"],
    ["POST", "/api/scout/import", "Add found companies to the pipeline {companies, currency, find_contacts?}"],
    ["POST", "/api/targets/:id/contacts/find", "Run the contact finder (website emails/phones, owner address guesses, Hunter)"],
    ["POST", "/api/email/send", "Send from your connected mailbox {to, subject, body, target_id}"],
    ["GET", "/api/email/sent?target=", "Emails sent"],
    ["POST", "/api/targets/:id/enrich", "Deep enrich via Monid {mobile?, linkedin?}: owner email (verified), all domain emails, LinkedIn, optional mobile"],
    ["GET", "/api/monid", "Monid wallet balance, this month's data budget and spend, recent runs"],
    ["POST", "/api/monid/discover", "Search 2,500+ data APIs {query}"],
    ["POST", "/api/monid/inspect", "An endpoint's input schema and price {provider, endpoint}"],
    ["POST", "/api/monid/run", "Run an endpoint {provider, endpoint, input: {body, queryParams, pathParams}, reason}"],
    ["GET", "/api/sequencers", "Connected sequencers and recent replies"],
    ["GET", "/api/sequencers/:provider/campaigns", "Campaigns in instantly | smartlead | emailbison"],
    ["POST", "/api/sequencers/push", "Add targets to a campaign {provider, campaign_id, campaign_name, target_ids, personalize?}"],
    ["POST", "/hooks/replies/<secret>", "Reply webhook for your sequencer (create the URL in Settings → Outreach). AI triages each reply"],
    ["GET", "/api/dialer/queue?stage=&q=&fresh=1", "Power dialer call list"],
    ["POST", "/api/phone/sms", "Text from your Twilio number {to, body, target_id?}"],
    ["GET", "/api/phone/messages", "Text conversations (from Twilio), matched to targets"],
    ["GET", "/api/phone/calls", "Recent calls on your Twilio number"],
    ["POST", "/api/calls", "Log a call {target_id, disposition, notes, duration, next_date}"],
    ["POST", "/api/dialer/bridge", "Click-to-call via your Twilio {target_id, phone}: rings you, then connects them"],
    ["GET", "/api/usage?days=30", "AI usage and estimated cost"],
    ["GET", "/api/integrations", "Connected AI providers and webhooks"],
  ],
  webhooks: "POST JSON {type, created_at, data} to your URL. Verify X-Warplan-Signature: sha256=HMAC_SHA256(secret, `${X-Warplan-Timestamp}.${raw body}`).",
};
