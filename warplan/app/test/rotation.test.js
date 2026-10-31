import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { warmCap, buildMessage } from "../src/mailer.js";
import { rotation } from "../src/rotation.js";
import { rankStrategics, brandKey } from "../src/sellbots.js";
import { renderEmail, defaultTemplates, cleanTemplates } from "../public/js/bot-emails.js";

const ago = (d) => new Date(Date.now() - d * 864e5).toISOString();

test("warm-up: 5 a day, +3 a day, never above the cap", () => {
  assert.equal(warmCap({ warmup: 1, daily_limit: 30, created_at: ago(0) }), 5);
  assert.equal(warmCap({ warmup: 1, daily_limit: 30, created_at: ago(5) }), 20);
  assert.equal(warmCap({ warmup: 1, daily_limit: 30, created_at: ago(40) }), 30);
  assert.equal(warmCap({ warmup: 0, daily_limit: 30, created_at: ago(0) }), 30);
});

// A tiny stand-in for D1: answers the handful of queries rotation() makes.
function fakeEnv({ main, pool, sent }) {
  return { DB: { prepare: (sql) => ({ bind: (...a) => ({
    first: async () => (sql.includes("FROM mailboxes") ? main : sql.includes("pool_id IS NULL") ? { n: sent.main || 0 } : { n: sent[a[0]] || 0 }),
    all: async () => ({ results: pool }),
  }) }) } };
}

test("rotation: most room first, same mailbox for a prospect, wait when its mailbox is full, null when all are full", async () => {
  const env = fakeEnv({ main: { email: "me@a.com", daily_limit: 10 }, pool: [{ id: 7, email: "x@b.com", daily_limit: 30, warmup: 0, created_at: ago(1) }, { id: 8, email: "y@b.com", daily_limit: 30, warmup: 1, created_at: ago(0) }], sent: { main: 9, 7: 10, 8: 0 } });
  const rot = await rotation(env, { account_id: 1, mailboxes: JSON.stringify(["main", "7", "8"]) }, { user: { id: 1 } });
  assert.equal(rot.size, 3);
  assert.equal(rot.left(), 1 + 20 + 5);
  assert.equal(rot.pick(null).key, "7");          // 20 left
  assert.equal(rot.pick("8").key, "8");           // stays with its own mailbox
  rot.full({ key: "8" });
  assert.equal(rot.pick("8"), "wait");            // full today: wait, don't switch the thread
  assert.equal(rot.pick("99").key, "7");          // its mailbox was removed: pick another
  rot.full({ key: "7" }); rot.used({ key: "main" });
  assert.equal(rot.pick(null), null);             // everything full
});

test("rotated emails reply to the main mailbox", () => {
  const raw = buildMessage({ from: "x@b.com", to: "o@c.com", subject: "Hi", text: "Hello", messageId: "<1@b.com>", unsubscribe: "me@a.com", replyTo: "me@a.com" });
  assert.match(raw, /\r\nReply-To: me@a\.com\r\n/);
  assert.match(raw, /List-Unsubscribe: <mailto:me@a\.com\?subject=unsubscribe>/);
});

test("pool mailboxes: owners only, signed in, login checked, password sealed per workspace", () => {
  const src = readFileSync(new URL("../src/mailer.js", import.meta.url), "utf8");
  assert.match(src, /const poolOwner = \(ctx\) => \{ if \(!ctx\.isOwner\)/);
  assert.match(src, /if \(ctx\.viaToken\) throw err\(403, "Add sending mailboxes in the app, signed in"\)/);
  assert.match(src, /await session\(\{ email, host, port, username \}, password, async \(\) => true\)/);
  assert.match(src, /seal\(env, password, poolAad\(/);
  assert.match(src, /FROM mailbox_pool WHERE id = \?1 AND account_id = \?2 AND active = 1/);
});

test("strategic buyers: grouped by brand, ranked by locations and reviews, own business skipped", () => {
  assert.equal(brandKey("Back In Motion - Werribee"), "back in");
  const r = rankStrategics([
    { name: "Back In Motion Werribee", reviews: 300, website: "https://bim.com.au" }, { name: "Back In Motion Hoppers Crossing", reviews: 200 },
    { name: "Solo Physio", reviews: 12 }, { name: "Big Single Clinic", reviews: 500, website: "x" }, { name: "My Clinic", reviews: 900 },
  ], "My Clinic");
  assert.deepEqual(r.map((g) => g.name), ["Back In Motion Werribee", "Big Single Clinic"]);
  assert.equal(r[0].locations, 2);
});

test("strategic emails: footprint pitch, direct, 60 days", () => {
  const v = { kind: "strategic", buyer: "Big Physio Co", sender: "Bendik", business: "a physio group in Melbourne's west", area: "Melbourne's west", revenue: 4e6, ebitda: 9e5, currency: "A$", touches: 60 };
  assert.match(renderEmail({}, 1, v).body, /It would add Melbourne's west to Big Physio Co's footprint\.\n\nWant to talk\?/);
  assert.equal(defaultTemplates("strategic", 60).steps.length, 60);
  for (const t of defaultTemplates("strategic", 60).steps) assert.doesNotMatch(t, /probably not|right\?|hope you|just checking/i);
  const custom = cleanTemplates({ subject: "A", steps: ["x"], strategic: { subject: "B", steps: ["y"], strategic: { steps: ["deep"] } } });
  assert.deepEqual(custom, { strategic: { subject: "B", steps: ["y"] }, subject: "A", steps: ["x"] });
});
