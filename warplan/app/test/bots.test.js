import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderEmail, templateIndex, buyingFor, cleanTemplates, DEFAULT_TEMPLATES, MAX_TOUCHES } from "../public/js/bot-emails.js";
import { localParts, scoreOf } from "../src/bots.js";

const V = { first: "Sarah", company: "Westside Physio", sender: "Bendik", group: "XYZ Group", buying: "physio clinics", area: "Melton", phone: "0400 111 222", signals: { reviews: 200, rating: 4.8 }, touches: 6, gapDays: 1 };

test("first email is the direct opener; follow-ups thread as Re:", () => {
  const e1 = renderEmail({}, 1, V);
  assert.equal(e1.subject, "Buying physio clinics in Melton");
  assert.match(e1.body, /My name is Bendik, I run XYZ Group\. We're looking to buy physio clinics in Melton\./);
  assert.match(e1.body, /Have you ever thought about selling Westside Physio\? Probably not, right\?/);
  const e2 = renderEmail({}, 2, V);
  assert.equal(e2.subject, "Re: Buying physio clinics in Melton");
  assert.match(e2.body, /We sent you a note yesterday/);
  assert.match(renderEmail({}, 4, V).body, /I've been trying to reach you.*0400 111 222/s);
});

test("the last email is always the final template, and middle ones rotate", () => {
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => templateIndex(i + 1, 10, 6)), [0, 1, 2, 3, 4, 1, 2, 3, 4, 5]);
  assert.equal(templateIndex(3, 3, 6), 5);
  assert.match(renderEmail({}, 3, { ...V, touches: 3 }).body, /This is my last email for now/);
});

test("no phone or group still reads cleanly, unknown name says 'there'", () => {
  const e = renderEmail({}, 1, { ...V, first: "", group: "", phone: "" });
  assert.match(e.body, /^Hi there,/);
  assert.match(e.body, /My name is Bendik\. We're looking/);
  assert.doesNotMatch(renderEmail({}, 4, { ...V, phone: "" }).body, /\{phone\}/);
});

test("templates are capped and cleaned", () => {
  const t = cleanTemplates({ subject: "  Hi  ", steps: Array(15).fill("x"), extra: 1 });
  assert.equal(t.steps.length, MAX_TOUCHES);
  assert.equal(t.subject, "Hi");
  assert.deepEqual(cleanTemplates({ steps: ["", "  "] }), {});
  assert.equal(buyingFor("plumbing"), "plumbing businesses");
  assert.equal(DEFAULT_TEMPLATES.steps.length, 6);
});

test("local time: weekend detection and date per time zone", () => {
  const sat = localParts("Australia/Melbourne", new Date("2026-10-31T01:00:00Z")); // Sat noon in Melbourne
  assert.equal(sat.date, "2026-10-31"); assert.equal(sat.weekend, true);
  const mon = localParts("Australia/Melbourne", new Date("2026-11-01T22:00:00Z")); // Mon 9am in Melbourne
  assert.equal(mon.date, "2026-11-02"); assert.equal(mon.weekend, false); assert.equal(mon.hour, 9);
});

test("ranking favours size, a website and tuck-ins; penalises chains", () => {
  const site = [{ lat: -37.68, lng: 144.57, radius_km: 15 }];
  const big = scoreOf({ name: "Melton Physio", reviews: 300, rating: 4.8, website: "x", phone: "1", lat: -37.69, lng: 144.58 }, site);
  const small = scoreOf({ name: "Tiny Physio", reviews: 3, rating: 4, website: "", phone: "", lat: -37.0, lng: 145.5 }, site);
  const chain = scoreOf({ name: "National Physio Group", reviews: 300, rating: 4.8, website: "x", phone: "1" }, []);
  assert.ok(big.score > chain.score && chain.score > small.score);
  assert.ok(big.signals.some((s) => s.k === "tuckin"));
});

test("guardrails in the engine: owner-only setup, autopilot opt-in, stop on reply/opt-out, capped emails", () => {
  const src = readFileSync(new URL("../src/bots.js", import.meta.url), "utf8");
  assert.match(src, /function needOwnerHuman\(ctx\)/);
  assert.match(src, /Tick the box to confirm emails go out without your review/);
  assert.match(src, /FROM replies r WHERE r\.account_id = p\.account_id AND r\.target_id = p\.target_id/);
  assert.match(src, /FROM suppressions s WHERE s\.account_id = p\.account_id AND s\.email = p\.email/);
  assert.match(src, /int\(b\.touches, 1, MAX_TOUCHES, 6\)/);
  assert.match(src, /p\.step >= bot\.touches/);
  assert.match(src, /!l\.weekend && l\.hour >= b\.send_hour/);
  assert.match(src, /lock_until IS NULL OR lock_until < \?6/);
  for (const q of src.match(/FROM bot_prospects[^"`]*|UPDATE bot_prospects[^"`]*/g)) assert.match(q, /account_id|bot_id = \?1 AND|WHERE id = \?1/, q.slice(0, 80));
});

test("emails carry the sender's name and an opt-out line, and threading only accepts a Message-ID", () => {
  const mail = readFileSync(new URL("../src/mailer.js", import.meta.url), "utf8");
  assert.match(mail, /If you'd rather not hear from me again/);
  assert.match(mail, /\/\^<\[\^<>\\s\]\{3,200\}>\$\/\.test/);
});
