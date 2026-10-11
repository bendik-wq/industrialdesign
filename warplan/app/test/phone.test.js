import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { twilioJwt, validSignature } from "../src/phone.js";
import { e164 } from "../src/dialer.js";

test("Twilio webhook signature: accepts Twilio's, rejects tampering", async () => {
  const token = "12345", url = "https://warplan.example/hooks/twilio/tw_x/voice";
  const params = new URLSearchParams({ To: "+4791234567", From: "client:u1", AccountSid: "AC1", CallSid: "CA1" });
  const data = url + [...params.keys()].sort().map((k) => k + params.get(k)).join("");
  const sig = createHmac("sha1", token).update(data).digest("base64");
  assert.equal(await validSignature(token, url, params, sig), true);
  params.set("To", "+19005550000");
  assert.equal(await validSignature(token, url, params, sig), false);
  assert.equal(await validSignature(token, url, params, ""), false);
});

test("Twilio access token is a valid HS256 JWT with the voice grant", async () => {
  const jwt = await twilioJwt({ keySid: "SK1", secret: "s3cret", accountSid: "AC1", appSid: "AP1", identity: "u7", iat: 1000 });
  const [h, p, s] = jwt.split(".");
  const expect = createHmac("sha256", "s3cret").update(`${h}.${p}`).digest("base64url");
  assert.equal(s, expect);
  const payload = JSON.parse(Buffer.from(p, "base64url").toString());
  assert.equal(payload.iss, "SK1"); assert.equal(payload.sub, "AC1"); assert.equal(payload.exp, 4600);
  assert.deepEqual(payload.grants, { identity: "u7", voice: { incoming: { allow: true }, outgoing: { application_sid: "AP1" } } });
  assert.equal(JSON.parse(Buffer.from(h, "base64url").toString()).cty, "twilio-fpa;v=1");
});

test("phone numbers normalise to E.164", () => {
  assert.equal(e164("+47 912 34 567"), "+4791234567");
  assert.equal(e164("0047 91234567"), "+4791234567");
  assert.equal(e164("0412 345 678", "A$"), "+61412345678");
  assert.equal(e164("(208) 345-4115", "$"), "+12083454115");
  assert.equal(e164("020 7946 0958", "£"), "+442079460958");
  assert.equal(e164("12345", "$"), null);
});

import { pickCallerId, countryCode } from "../src/numbers.js";
test("local presence picks the owner's country, then area code", () => {
  const mine = ["+15125550100", "+12085550100", "+447700900123", "+61291234567", "+4930123456"];
  assert.equal(pickCallerId(mine, "+447911123456", "+15125550100"), "+447700900123");
  assert.equal(pickCallerId(mine, "+61412345678", "+15125550100"), "+61291234567");
  assert.equal(pickCallerId(mine, "+12083454115", "+15125550100"), "+12085550100"); // same area code (208)
  assert.equal(pickCallerId(mine, "+13035550199", "+15125550100"), "+15125550100"); // any US number
  assert.equal(pickCallerId(mine, "+33612345678", "+15125550100"), "+15125550100"); // no French number: default
  assert.equal(countryCode("+353861234567"), "353"); // Ireland, not +35
});

import { verifyKey } from "../src/keys.js";
test("Twilio connect needs only SID + token: finds the number, flags trial accounts", async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (/Accounts\/AC[0-9a-f]+\.json$/.test(url)) return new Response(JSON.stringify({ status: "active", type: "Trial" }), { status: 200 });
    if (/IncomingPhoneNumbers/.test(url)) return new Response(JSON.stringify({ incoming_phone_numbers: [{ phone_number: "+61390001234", capabilities: { voice: true } }] }), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  try {
    const meta = { sid: "AC" + "a".repeat(32), from: "", agentPhone: "" };
    assert.equal(await verifyKey("twilio", "b".repeat(32), meta), true);
    assert.equal(meta.from, "+61390001234"); assert.equal(meta.trial, true);
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(verifyKey("twilio", "b".repeat(32), { sid: "AC" + "a".repeat(32) }), /rejected/);
  } finally { globalThis.fetch = real; }
});
