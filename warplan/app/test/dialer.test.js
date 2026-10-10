import { test } from "node:test";
import assert from "node:assert/strict";
import { zonesFor, callWindow } from "../public/js/calltime.js";
import { balancedCallerId, dialGuard, MAX_ATTEMPTS_24H } from "../src/dialer.js";

const MON_930_NY = new Date("2026-10-12T13:30:00Z"); // Mon 9:30 New York, 6:30 Los Angeles

test("time zones: location first, city decides split states, then area code", () => {
  assert.deepEqual(zonesFor({ location: "Austin, TX" }).zones, ["America/Chicago"]);
  assert.deepEqual(zonesFor({ location: "El Paso, TX" }).zones, ["America/Denver"]);
  assert.deepEqual(zonesFor({ location: "Texas" }).zones, ["America/Chicago", "America/Denver"]);
  assert.deepEqual(zonesFor({ location: "Perth WA 6000", currency: "A$" }).zones, ["Australia/Perth"]);
  assert.deepEqual(zonesFor({ location: "Seattle, WA" }).zones, ["America/Los_Angeles"]);
  assert.deepEqual(zonesFor({ location: "Charleston, West Virginia" }).zones, ["America/New_York"]);
  assert.deepEqual(zonesFor({ phone: "+19155550123" }).zones, ["America/Denver"]);
  assert.deepEqual(zonesFor({ phone: "+447700900123" }).zones, ["Europe/London"]);
  assert.equal(zonesFor({}), null);
});

test("calling window: 8am–9pm local (8pm in strict states), no Sundays, both zones in split states", () => {
  assert.equal(callWindow(zonesFor({ location: "New York, NY" }), MON_930_NY).callable, true);
  const la = callWindow(zonesFor({ location: "Los Angeles, CA" }), MON_930_NY);
  assert.equal(la.callable, false);
  assert.equal(la.opens_at, "2026-10-12T15:00:00.000Z"); // 8:00 LA
  assert.equal(callWindow(zonesFor({ location: "Miami, FL" }), new Date("2026-10-13T00:30:00Z")).callable, false); // 8:30pm FL
  assert.equal(callWindow(zonesFor({ location: "Boston, MA" }), new Date("2026-10-13T00:30:00Z")).callable, true); // 8:30pm MA
  assert.equal(callWindow(zonesFor({ location: "Texas" }), new Date("2026-10-12T13:30:00Z")).callable, false); // 7:30 in El Paso
  const sun = callWindow(zonesFor({ location: "Boston, MA" }), new Date("2026-10-11T15:00:00Z"));
  assert.equal(sun.callable, false); assert.match(sun.reason, /Sunday/);
  assert.equal(callWindow(zonesFor({ location: "Boston, MA" }), new Date("2026-10-11T15:00:00Z"), { sundays: true }).callable, true);
});

test("caller ID: local presence first, then the least-used number", () => {
  const nums = ["+12085550101", "+12085550102", "+13125550190", "+447700900111"];
  assert.equal(balancedCallerId(nums, "+12089394475", null, { "+12085550101": 40, "+12085550102": 3 }), "+12085550102");
  assert.equal(balancedCallerId(nums, "+12089394475", null, {}), "+12085550101");
  assert.equal(balancedCallerId(nums, "+447700900999", null, {}), "+447700900111");
  // Same country, different area code: spread across the US numbers.
  assert.equal(balancedCallerId(nums, "+16175550000", null, { "+12085550101": 9, "+12085550102": 9, "+13125550190": 1 }), "+13125550190");
});

function guardDb({ dnc = false, n = 0, last = null } = {}) {
  return { prepare: (sql) => ({ bind: () => ({ sql, first: async () => (/settings/.test(sql) ? null : null) }) }), batch: async (stmts) => [{ results: dnc ? [{ reason: "Asked not to be called" }] : [] }, { results: [{ n, last }] }] };
}
test("dial guard: hours, cap, spacing, do-not-call", async () => {
  // The guard reads the real clock, so use a number with no known time zone (hours always pass) to test the rest.
  const env = (o) => ({ DB: guardDb(o) });
  const base = { to: "+999123456789", sundays: true }; // unknown zone → allowed by hours
  assert.equal((await dialGuard(env(), 1, base)).attempts24h, 0);
  await assert.rejects(dialGuard(env({ n: MAX_ATTEMPTS_24H }), 1, base), /3 times in 24 hours/);
  await assert.rejects(dialGuard(env({ dnc: true }), 1, base), /do-not-call/);
  await assert.rejects(dialGuard(env({ n: 1, last: new Date(Date.now() - 20 * 60e3).toISOString() }), 1, base), /minutes ago/);
  assert.ok(await dialGuard(env({ n: 1, last: new Date(Date.now() - 20 * 60e3).toISOString() }), 1, { ...base, retry: true }));
  assert.ok(await dialGuard(env({ n: 1, last: new Date(Date.now() - 60e3).toISOString() }), 1, base)); // double dial right after
});
