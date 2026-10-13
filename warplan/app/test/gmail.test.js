import { test } from "node:test";
import assert from "node:assert/strict";
import { gmailAuthUrl, gmailCallback, gmailConfigured } from "../src/gmail.js";

const env = { GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "x", SESSION_SECRET: "s".repeat(40) };
const ctx = { user: { id: 7 }, accountId: 1 };

test("Connect Gmail: signed state, right scopes, offline access", async () => {
  assert.equal(gmailConfigured({}), false);
  await assert.rejects(gmailAuthUrl({}, ctx, "https://w.dev"), /isn't set up/);
  await assert.rejects(gmailAuthUrl(env, { ...ctx, viaToken: true }, "https://w.dev"), /signed in/);
  const u = new URL(await gmailAuthUrl(env, ctx, "https://w.dev"));
  assert.equal(u.searchParams.get("redirect_uri"), "https://w.dev/api/google/callback");
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.match(u.searchParams.get("scope"), /gmail\.send.*gmail\.readonly/);
  assert.match(u.searchParams.get("state"), /^7\.\d+\.[\w-]+$/);
});

test("Connect Gmail: a forged, expired or other user's state is refused before any token exchange", async () => {
  const u = new URL(await gmailAuthUrl(env, ctx, "https://w.dev"));
  const state = u.searchParams.get("state");
  const loc = async (s, c = ctx) => (await gmailCallback(env, c, new URL(`https://w.dev/api/google/callback?code=abc&state=${encodeURIComponent(s)}`))).headers.get("Location");
  assert.match(await loc(state.replace(/\.[^.]+$/, ".forged")), /expired/);
  assert.match(await loc(state, { ...ctx, user: { id: 8 } }), /expired/);
  assert.match(await loc(`7.${Date.now() - 1000}.${state.split(".")[2]}`), /expired/);
  const denied = (await gmailCallback(env, ctx, new URL("https://w.dev/api/google/callback?error=access_denied"))).headers.get("Location");
  assert.match(decodeURIComponent(denied), /cancelled/);
});
