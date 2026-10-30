// Security regressions: each test pins a fix from the October 2026 audit (see warplan/security/SECURITY.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { userRunnable, forbidden } from "../src/monid.js";
import { exfilRisk, TOOLS } from "../src/tools.js";
import { HOUSE_RULES } from "../src/playbook.js";

const src = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("account-resource Monid providers can't be run by users or agents (cross-tenant inboxes, VMs, bots)", () => {
  for (const p of ["agentmail", "AgentMail", "smolmachine", "recall", "sfs", "monid"]) assert.ok(userRunnable(p), p);
  for (const p of ["context.dev", "apollo", "hunterio", "anyapi"]) assert.equal(userRunnable(p), null, p);
  assert.ok(forbidden("bland", "/call"));
});

test("API tokens can't send, spend or read iMessage directly", () => {
  const index = src("index.js");
  const re = new RegExp(index.match(/const TOKEN_VIA_INBOX = \/(.+)\/;/)[1]);
  for (const p of ["/api/email/send", "/api/phone/sms", "/api/imessage/send", "/api/sequencers/push", "/api/meetings/record", "/api/dialer/bridge", "/api/monid/run", "/api/runs", "/api/targets/12/enrich"]) assert.ok(re.test(p), p);
  for (const p of ["/api/targets", "/api/inbox", "/api/documents/generate"]) assert.equal(re.test(p), false, p);
  assert.match(index, /imessage\\\/\(threads\|messages\|live\|read\|typing\|react\|send\)\$\/\.test\(p\)\) \{ needOwner\(ctx\); if \(ctx\.viaToken\)/);
});

test("prompt-injection guards: risky links, data-like searches and contact changes need a person", async () => {
  assert.ok(exfilRisk("https://evil.example/collect?d=" + "x".repeat(120)));
  assert.ok(exfilRisk("https://evil.example/p?to=owner%40firm.com"));
  assert.equal(exfilRisk("https://www.smilesdental.com.au/about"), null);
  const upd = TOOLS.find((t) => t.name === "update_target");
  assert.ok(await upd.approval({}, {}, { target_id: 1, email: "x@evil.example" }));
  assert.equal(await upd.approval({}, {}, { target_id: 1, stage: "meeting" }), null);
  const web = TOOLS.find((t) => t.name === "web_search");
  assert.ok(await web.approval({}, {}, { query: "owner john@firm.com 4821930011" }));
  assert.match(HOUSE_RULES, /UNTRUSTED TEXT/);
});

test("login reserves attempts atomically, setup key is constant-time, password change revokes tokens", () => {
  const index = src("index.js");
  assert.match(index, /INSERT INTO login_attempts \(key, created_at\) VALUES \(\?1, \?4\), \(\?2, \?4\), \(\?3, \?4\)/);
  assert.match(index, /safeEqual\(String\(b\.setupKey/);
  assert.match(index, /DELETE FROM api_tokens WHERE user_id = \?1"\)\.bind\(u\.id\), \/\/ a stolen session/);
});

test("reply triage only spends AI on known senders, metered; Gmail needs DMARC/DKIM", () => {
  const seq = src("sequencers.js"), gm = src("gmail.js");
  assert.match(seq, /if \(!target\) tri = fallback\(\);/);
  assert.match(seq, /await record\(env, ai, ctx, "reply-triage", out\)/);
  assert.match(gm, /dmarc=pass\|dkim=pass/);
});

test("seller links: NDA recorded once, uploads need the NDA, a rate limit and a workspace quota", () => {
  const room = src("dealroom.js");
  assert.match(room, /WHERE target_id = \?1 AND nda_at IS NULL/);
  assert.match(room, /Accept the confidentiality agreement first/);
  assert.match(room, /WORKSPACE_BYTES/);
});

test("open items closed: per-session revocation, __Host- cookie, no legacy admin token, short cache", () => {
  const auth = src("auth.js");
  assert.match(auth, /export const COOKIE = "__Host-wp_s"/);
  assert.match(auth, /JOIN sessions s ON s\.user_id = u\.id AND s\.sid = \?2/);
  assert.doesNotMatch(auth, /env\.API_TOKEN/);
  assert.match(auth, /SESSION_TTL_MS = 5_000/);
  assert.match(auth, /const read = request\.method === "GET"/);
  assert.match(src("index.js"), /else await endUserSession\(env, request\)/);
});

test("open items closed: sealed webhook secrets, R2-ready files, expiring seller links, owner-only deletes", () => {
  assert.match(src("pipeline.js"), /sealed:v1:/);
  assert.match(src("dealroom.js"), /if \(r2\) await env\.FILES\.put/);
  assert.match(src("dealroom.js"), /link_expires_at < now\(\)\) throw err\(410/);
  const index = src("index.js");
  assert.match(index, /if \(m === "DELETE"\) \{ needOwner\(ctx\); if \(ctx\.viaToken\) fail\(403, "Delete targets/);
  assert.doesNotMatch(index, /fail\(409, "That email already has a login"\)/);
  assert.match(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"), /"invocation_logs": false/);
});

test("open items closed: AI calls and data runs are reserved before they happen", () => {
  assert.match(src("usage.js"), /'_hold'/);
  assert.match(src("monid.js"), /'RESERVED'/);
});
