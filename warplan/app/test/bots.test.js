import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderEmail, templateIndex, buyingFor, cleanTemplates, defaultTemplates, MAX_TOUCHES } from "../public/js/bot-emails.js";
import { fundFit } from "../src/sellbots.js";
import { localParts, scoreOf } from "../src/bots.js";

const V = { first: "Sarah", company: "Westside Physio", sender: "Bendik", group: "XYZ Group", buying: "physio clinics", area: "Melton", phone: "0400 111 222", signals: { reviews: 200, rating: 4.8 }, touches: 30, gapDays: 1 };

test("first email is direct: who I am, what we buy, would you sell", () => {
  const e1 = renderEmail({}, 1, V);
  assert.equal(e1.subject, "Buying physio clinics in Melton");
  assert.match(e1.body, /My name is Bendik, I run XYZ Group\. We buy physio clinics in Melton\./);
  assert.match(e1.body, /Would you consider selling Westside Physio\?/);
  const e2 = renderEmail({}, 2, V);
  assert.equal(e2.subject, "Re: Buying physio clinics in Melton");
  assert.match(e2.body, /Following up on my email yesterday\..*Your 200 reviews at 4\.8 stars stood out\./s);
});

test("no softeners anywhere in the default copy", () => {
  for (const kind of ["buy", "sell"]) for (const days of [10, 30, 60]) for (const t of defaultTemplates(kind, days).steps) {
    assert.doesNotMatch(t, /probably not|right\?|no worries|just checking|hope (this|you)|sorry to bother/i, t.slice(0, 60));
    assert.ok(t.length < 400, "short emails");
  }
});

test("30 and 60 day flows: one template per day, the last email is the final one", () => {
  for (const kind of ["buy", "sell"]) { assert.equal(defaultTemplates(kind, 30).steps.length, 30); assert.equal(defaultTemplates(kind, 60).steps.length, 60); assert.equal(defaultTemplates(kind, 10).steps.length, 10); }
  assert.deepEqual(Array.from({ length: 10 }, (_, i) => templateIndex(i + 1, 10, 6)), [0, 1, 2, 3, 4, 1, 2, 3, 4, 5]);
  assert.match(renderEmail({}, 30, V).body, /Last email for now/);
  assert.match(renderEmail({}, 60, { ...V, touches: 60 }).body, /Final email/);
  assert.doesNotMatch(renderEmail({}, 29, { ...V, touches: 60 }).body, /Last email|Final email/);
});

test("no phone or group still reads cleanly, unknown name says 'there'", () => {
  const e = renderEmail({}, 1, { ...V, first: "", group: "", phone: "" });
  assert.match(e.body, /^Hi there,/);
  assert.match(e.body, /My name is Bendik\. We buy/);
  assert.doesNotMatch(renderEmail({}, 7, { ...V, phone: "" }).body, /\{phone\}/);
});

test("sell emails: business, numbers and the ask", () => {
  const sv = { kind: "sell", fund: "Example Capital", sender: "Bendik", business: "a physio group in Melbourne", sector: "allied health", area: "Melbourne", revenue: 4200000, ebitda: 900000, currency: "A$", phone: "0400 111 222", touches: 30 };
  const e = renderEmail({}, 1, sv);
  assert.equal(e.subject, "For sale: a physio group in Melbourne");
  assert.match(e.body, /I'm selling a physio group in Melbourne: A\$4\.2M revenue, A\$900k EBITDA\.\n\nDo you want the teaser\?/);
  for (let i = 1; i <= 60; i++) assert.doesNotMatch(renderEmail({}, i, { ...sv, touches: 60 }).body, /\n\na physio/, `day ${i} starts lower case`);
});

test("templates are capped and cleaned", () => {
  const t = cleanTemplates({ subject: "  Hi  ", steps: Array(80).fill("x"), extra: 1 });
  assert.equal(t.steps.length, MAX_TOUCHES);
  assert.equal(MAX_TOUCHES, 60);
  assert.equal(t.subject, "Hi");
  assert.deepEqual(cleanTemplates({ steps: ["", "  "] }), {});
  assert.equal(buyingFor("plumbing"), "plumbing businesses");
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
  assert.match(src, /int\(b\.touches, 1, MAX_TOUCHES, 30\)/);
  assert.match(src, /r\.category != 'ooo'/);
  assert.match(src, /\(p\.step \+ 1\) % 7 === 0/);
  assert.match(src, /delaySeconds: Math\.floor\(Math\.random\(\) \* 3000\)/);
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

test("buyer matching: country, segment, sector and EBITDA range", () => {
  const f = { id: "x", segment: "lmm", hq_country: "AU", regions: ["AU", "NZ"], sectors: ["healthcare", "business services"], ebitda_min_usd: 1.3, ebitda_max_usd: 13 };
  const sell = { sector: "healthcare", ebitda: 2000000, currency: "A$" };
  assert.ok(fundFit(f, sell, { countries: ["AU"], segments: ["lmm"] }).score >= 90);
  assert.equal(fundFit(f, sell, { countries: ["US"] }).skip, true);
  assert.equal(fundFit(f, sell, { segments: ["mm"] }).skip, true);
  assert.equal(fundFit(f, { ...sell, ebitda: 300000 }, {}).skip, true, "too small");
  assert.equal(fundFit(f, { ...sell, ebitda: 60000000 }, {}).skip, true, "too big");
});

test("sell bots: same guardrails (reply/opt-out stop, OOO pause, review mode, workspace-scoped)", () => {
  const src = readFileSync(new URL("../src/sellbots.js", import.meta.url), "utf8");
  assert.match(src, /r\.category = 'ooo'/);
  assert.match(src, /FROM suppressions s WHERE s\.account_id = p\.account_id AND s\.email = p\.email/);
  assert.match(src, /bot\.mode !== "autopilot"/);
  for (const q of src.match(/(FROM|UPDATE) sell_prospects[^"`]*/g)) assert.match(q, /account_id|WHERE id = \?1/, q.slice(0, 80));
});
