import { test } from "node:test";
import assert from "node:assert/strict";
import { bbReq, logIncoming } from "../src/imessage.js";

const withFetch = async (impl, fn) => { const real = globalThis.fetch; globalThis.fetch = impl; try { await fn(); } finally { globalThis.fetch = real; } };

test("BlueBubbles requests: password on the query, no redirects, public https only", async () => {
  let seen = null;
  await withFetch(async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ status: 200, data: "pong" }), { status: 200 }); }, async () => {
    assert.equal(await bbReq({ url: "https://abc.trycloudflare.com", password: "pw 1&x" }, "/api/v1/ping"), "pong");
  });
  const u = new URL(seen.url);
  assert.equal(u.origin, "https://abc.trycloudflare.com"); assert.equal(u.searchParams.get("password"), "pw 1&x"); assert.equal(seen.init.redirect, "manual");
  await withFetch(async () => new Response("", { status: 302, headers: { Location: "https://evil.example/" } }), async () => {
    await assert.rejects(bbReq({ url: "https://abc.trycloudflare.com", password: "x" }, "/api/v1/ping"), /redirected/);
  });
  await withFetch(async () => new Response("{}", { status: 401 }), async () => {
    await assert.rejects(bbReq({ url: "https://abc.trycloudflare.com", password: "x" }, "/api/v1/ping"), /rejected the password/);
  });
  for (const bad of ["http://abc.trycloudflare.com", "https://192.168.1.5", "https://mac.local", "https://localhost:1234"])
    await assert.rejects(bbReq({ url: bad, password: "x" }, "/api/v1/ping"), /public https/, bad);
});

function fakeDb(target) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return { bind: (...args) => ({
        first: async () => (/FROM targets/.test(sql) ? target : null),
        run: async () => { writes.push({ sql, args }); return {}; },
      }) };
    },
  };
}

test("incoming iMessage: logs to the target, STOP suppresses the number, group chats ignored", async () => {
  const env = { DB: fakeDb({ id: 7, name: "Acme HVAC" }) }, ctx = { accountId: 1 };
  const emitted = [];
  const hooks = { emit: (n, d) => emitted.push([n, d]) };
  const msg = (text, extra = {}) => ({ guid: "g1", text, isFromMe: false, handle: { address: "+15551234567" }, chats: [{ guid: "iMessage;-;+15551234567" }], ...extra });

  assert.deepEqual(await logIncoming(env, ctx, msg("Sounds good, call me Tuesday"), hooks), { logged: true });
  assert.match(env.DB.writes.at(-1).args[2], /iMessage from \+15551234567: Sounds good/);
  assert.equal(emitted.at(-1)[0], "sms.received");

  await logIncoming(env, ctx, msg("STOP"), hooks);
  const sup = env.DB.writes.find((w) => /suppressions/.test(w.sql));
  assert.equal(sup.args[1], "tel:+15551234567");

  const before = env.DB.writes.length;
  assert.deepEqual(await logIncoming(env, ctx, msg("hi all", { chats: [{ guid: "iMessage;+;chat123" }] }), hooks), { ignored: "group chat" });
  assert.equal(env.DB.writes.length, before);

  // Sent from your own phone: logged once as outgoing, never as a reply and never suppresses.
  assert.deepEqual(await logIncoming(env, ctx, msg("STOP", { isFromMe: true }), hooks), { logged: true, outgoing: true });
  assert.match(env.DB.writes.at(-1).args[2], /^iMessage to /);
  assert.equal(env.DB.writes.filter((w) => /suppressions/.test(w.sql)).length, 1);
});

import { seal } from "../src/keys.js";
import { sendText, blueBubblesHook } from "../src/imessage.js";
import { sha256 } from "../src/auth.js";

// A workspace with only the iMessage relay connected: texts route there, and the hook trusts only the server's copy.
async function relayEnv({ stopped = false } = {}) {
  const env = { KEYS_SECRET: "test-secret-0123456789abcdef" };
  const sealed = await seal(env, "bbpass", "acct:1:bluebubbles");
  const writes = [];
  env.DB = {
    writes,
    prepare(sql) {
      return { bind: (...args) => ({
        all: async () => ({ results: /FROM account_keys/.test(sql) && args.includes("bluebubbles") ? [{ provider: "bluebubbles", ...sealed, meta: JSON.stringify({ serverUrl: "https://mac.example.com" }) }] : [] }),
        first: async () => {
          if (/COUNT\(\*\) AS n FROM usage/.test(sql)) return { n: 0 };
          if (/FROM suppressions/.test(sql)) return stopped ? { 1: 1 } : null;
          if (/FROM settings s JOIN accounts/.test(sql)) return args[0] === (await sha256("bb_" + "x".repeat(24))) ? { account_id: 1 } : null;
          if (/FROM targets/.test(sql)) return { id: 7, name: "Acme HVAC", currency: "$" };
          return null;
        },
        run: async () => { writes.push({ sql, args }); return {}; },
      }) };
    },
  };
  return env;
}

test("sendText routes to iMessage when it's the only channel, with the guards", async () => {
  const env = await relayEnv(), ctx = { accountId: 1, user: { id: 3, name: "Bendik" } };
  let sent = null;
  await withFetch(async (url, init) => { sent = { url: new URL(url), body: JSON.parse(init.body) }; return new Response(JSON.stringify({ data: { guid: "m1" } }), { status: 200 }); }, async () => {
    const r = await sendText(env, ctx, { to: "(555) 123-4567", body: "Hi John", target_id: 7 });
    assert.equal(r.via, "imessage"); assert.equal(r.to, "+15551234567");
  });
  assert.equal(sent.url.pathname, "/api/v1/message/text"); assert.equal(sent.url.searchParams.get("password"), "bbpass");
  assert.equal(sent.body.chatGuid, "any;-;+15551234567"); assert.equal(sent.body.message, "Hi John");
  assert.ok(env.DB.writes.some((w) => /INSERT INTO usage/.test(w.sql) && w.args.includes("imessage")));
  await assert.rejects(sendText(env, ctx, { to: "+15551234567", body: "x", via: "twilio" }), /Twilio isn't connected/);
  await assert.rejects(sendText(await relayEnv({ stopped: true }), ctx, { to: "+15551234567", body: "x" }), /replied STOP/);
});

test("BlueBubbles hook: unknown token 404s, and the message is re-fetched from the server", async () => {
  const env = await relayEnv();
  const call = (token, body) => blueBubblesHook(new Request(`https://w.example/hooks/bluebubbles/${token}`, { method: "POST", body: JSON.stringify(body) }), env, new URL(`https://w.example/hooks/bluebubbles/${token}`), () => null);
  assert.equal((await call("bb_" + "y".repeat(24), { type: "new-message", data: { guid: "g1" } })).status, 404);
  let fetched = null;
  await withFetch(async (url) => { fetched = new URL(url); return new Response(JSON.stringify({ data: { guid: "4C1A-77B2-g1", text: "Real text", isFromMe: false, handle: { address: "+15551234567" }, chats: [{ guid: "iMessage;-;+15551234567" }] } }), { status: 200 }); }, async () => {
    const res = await call("bb_" + "x".repeat(24), { type: "new-message", data: { guid: "4C1A-77B2-g1", text: "FORGED", handle: { address: "+1999" } } });
    assert.equal(res.status, 200);
  });
  assert.equal(fetched.pathname, "/api/v1/message/4C1A-77B2-g1");
  const ev = env.DB.writes.find((w) => /target_events/.test(w.sql));
  assert.match(ev.args[2], /Real text/); assert.doesNotMatch(ev.args[2], /FORGED/);
});

import { foldMessages, tapback } from "../src/imessage.js";
test("tapbacks fold onto their message; removals and replacements apply", () => {
  const raw = [
    { guid: "A", text: "Coffee Tuesday?", isFromMe: true, dateCreated: 1, dateDelivered: 2, dateRead: 3 },
    { guid: "B", text: "", isFromMe: false, dateCreated: 4, associatedMessageGuid: "p:0/A", associatedMessageType: 2001 },
    { guid: "C", text: "", isFromMe: false, dateCreated: 5, associatedMessageGuid: "p:0/A", associatedMessageType: "love" },
    { guid: "D", text: "Sure", isFromMe: false, dateCreated: 6 },
    { guid: "E", text: "", isFromMe: true, dateCreated: 7, associatedMessageGuid: "bp:D", associatedMessageType: "laugh" },
    { guid: "F", text: "", isFromMe: true, dateCreated: 8, associatedMessageGuid: "bp:D", associatedMessageType: 3003 },
  ];
  const out = foldMessages(raw);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].reactions, [{ name: "love", mine: false }]); // their like replaced by love
  assert.ok(out[0].read_at && out[0].delivered_at);
  assert.deepEqual(out[1].reactions, []); // my laugh, then removed
  assert.equal(out[1].read_at, null);
  assert.equal(tapback({ text: "hi" }), null);
});
