import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pixelUrl, trackLinks, trackRoute } from "../src/tracking.js";
import { campaignBody, instantlyTz } from "../src/instantly.js";

const calls = [];
const env = { SESSION_SECRET: "test-secret-0123456789abcdef-0123456789", PUBLIC_URL: "https://app.test", DB: { prepare: (sql) => ({ bind: (...a) => ({ run: async () => { calls.push([sql, a]); return {}; } }) }) } };

test("open image: signed, counts the open, returns a gif; forged tokens count nothing", async () => {
  const u = await pixelUrl(env, "b", 42);
  assert.match(u, /^https:\/\/app\.test\/o\/[\w.-]+\.gif$/);
  calls.length = 0;
  const res = await trackRoute(new Request(u), env, new URL(u));
  assert.equal(res.headers.get("Content-Type"), "image/gif");
  assert.equal(calls.length, 1); assert.match(calls[0][0], /UPDATE bot_prospects SET opens = opens \+ 1/); assert.equal(calls[0][1][0], 42);
  calls.length = 0;
  const forged = u.replace(/\/o\/[^.]+/, `/o/${btoa("b:7").replace(/=+$/, "")}`);
  await trackRoute(new Request(forged), env, new URL(forged));
  assert.equal(calls.length, 0, "a forged token doesn't count");
});

test("click redirect: signed links only, so it can't be used as an open redirect", async () => {
  const html = await trackLinks(env, "s", 9, '<a href="https://example.com/teaser.pdf">teaser</a>');
  const link = html.match(/href="([^"]+)"/)[1];
  assert.match(link, /^https:\/\/app\.test\/c\//);
  const res = await trackRoute(new Request(link), env, new URL(link));
  assert.equal(res.status, 302); assert.equal(res.headers.get("Location"), "https://example.com/teaser.pdf");
  const evil = link.replace(/\/c\/[^.]+/, `/c/${btoa("s:9:https://evil.test").replace(/=+$/, "")}`);
  assert.equal((await trackRoute(new Request(evil), env, new URL(evil))).status, 404);
});

test("Instantly campaign: weekday schedule in an accepted time zone, the whole flow, threaded follow-ups, per-lead variables", () => {
  assert.equal(instantlyTz("Australia/Sydney"), "Australia/Melbourne");
  assert.equal(instantlyTz("Australia/Perth"), "Australia/Perth");
  const bot = { name: "Physio West", touches: 60, gap_days: 1, send_hour: 9, timezone: "Australia/Melbourne", daily_new: 10, templates: "{}", track_opens: 0, track_clicks: 0 };
  const b = campaignBody(bot, "buy", { sender: "Bendik", group: "XYZ Group", buying: "physio clinics", phone: "0400 111 222" });
  assert.equal(b.sequences[0].steps.length, 60);
  assert.deepEqual(b.campaign_schedule.schedules[0].days, { 0: false, 1: true, 2: true, 3: true, 4: true, 5: true, 6: false });
  assert.equal(b.campaign_schedule.schedules[0].timing.from, "09:00");
  assert.equal(b.stop_on_reply, true); assert.equal(b.open_tracking, false); assert.equal(b.text_only, true);
  assert.match(b.sequences[0].steps[0].variants[0].subject, /\{\{wp_area\}\}/);
  assert.equal(b.sequences[0].steps[1].variants[0].subject, "");
  assert.match(b.sequences[0].steps[0].variants[0].body, /Would you consider selling \{\{wp_company\}\}\?/);
  const sell = campaignBody({ ...bot, touches: 30 }, "strategic", { sender: "Bendik", business: "a physio group", revenue: 4e6, ebitda: 9e5, currency: "A$" });
  assert.match(sell.sequences[0].steps[0].variants[0].body, /A\$900k EBITDA.*\{\{wp_buyer\}\}/s);
});

test("tracking is opt-in per bot and wired through the mailer", () => {
  const mail = readFileSync(new URL("../src/mailer.js", import.meta.url), "utf8");
  assert.match(mail, /if \(tr && \(tr\.opens \|\| tr\.clicks\)\)/);
  const bots = readFileSync(new URL("../src/bots.js", import.meta.url), "utf8");
  assert.match(bots, /\.\.\.\(\(bot\.track_opens \|\| bot\.track_clicks\) && \{ track:/);
  assert.match(bots, /p\.opens >= 3/);
  assert.match(bots, /Tick the box to confirm Instantly sends the flow/);
});
