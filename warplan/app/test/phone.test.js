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
  assert.equal(e164("91234567", "NOK "), "+4791234567");
  assert.equal(e164("(208) 345-4115", "$"), "+12083454115");
  assert.equal(e164("020 7946 0958", "£"), "+442079460958");
  assert.equal(e164("12345", "$"), null);
});
