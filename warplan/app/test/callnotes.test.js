import { test } from "node:test";
import assert from "node:assert/strict";
import { recordingTwiml, recordingReady } from "../src/callnotes.js";
import { seal } from "../src/keys.js";

const settingsDb = (data) => ({ prepare: () => ({ bind: () => ({ first: async () => (data ? { data: JSON.stringify(data) } : null) }) }) });

test("recording is off unless turned on; when on, the owner hears the notice and the callback is signed per call", async () => {
  assert.equal(await recordingTwiml({ DB: settingsDb(null) }, 1, "https://w.example/hooks/twilio/tw_x", "+61352781121", 3), null);
  const r = await recordingTwiml({ DB: settingsDb({ record: true }) }, 1, "https://w.example/hooks/twilio/tw_x", "+61352781121", 3);
  assert.match(r.dialAttrs, /record="record-from-answer-dual"/);
  assert.match(r.dialAttrs, /recordingStatusCallback="https:\/\/w\.example\/hooks\/twilio\/tw_x\/recording\?to=%2B61352781121&amp;uid=3"/);
  assert.equal(r.numberUrl, "https://w.example/hooks/twilio/tw_x/notice");
  assert.match(r.notice, /recorded/);
});

test("recording ready → transcribed → AI notes saved and put on the target's timeline", async () => {
  const env = { KEYS_SECRET: "test-secret-0123456789abcdef" };
  const tw = await seal(env, "a".repeat(32), "acct:1:twilio");
  const rows = new Map(); let nextId = 1; const events = [];
  env.DB = {
    prepare(sql) {
      return { bind: (...a) => ({
        all: async () => ({ results: /FROM account_keys/.test(sql) && a.includes("twilio") ? [{ provider: "twilio", ...tw, meta: JSON.stringify({ sid: "AC" + "b".repeat(32), from: "+61390001234" }) }] : [] }),
        first: async () => {
          if (/INSERT INTO call_recordings/.test(sql)) { const id = nextId++; rows.set(id, { id, account_id: a[0], user_id: a[1], target_id: a[2], call_sid: a[3], recording_url: a[5], duration: a[7] }); return { id }; }
          if (/SELECT \* FROM call_recordings/.test(sql)) return rows.get(a[0]);
          return null;
        },
        run: async () => {
          if (/UPDATE call_recordings SET status = 'done'/.test(sql)) Object.assign(rows.get(a[0]), { status: "done", transcript: a[2], summary: a[3] });
          if (/UPDATE call_recordings SET status = 'failed'/.test(sql)) Object.assign(rows.get(a[0]), { status: "failed", error: a[2] });
          if (/INSERT INTO target_events/.test(sql)) events.push(a);
          return {};
        },
      }) };
    },
  };
  const notes = { summary: "Spoke to Carey, the owner. Open to a coffee next week.", outcome: "interested", next_step: "Coffee Tuesday", callback_when: "Tuesday 10am", notes: "- Owner 61, two kids not in the business", owner_facts: ["Thinking about retiring in 3 years"], objections: [], sentiment: "warm" };
  env.AI = { run: async (model, input) => (input.audio ? { text: "Hi Carey, it's Bendik... yes, coffee Tuesday works." } : { response: JSON.stringify(notes) }) };
  const real = globalThis.fetch; let fetched = null;
  globalThis.fetch = async (url, init) => { fetched = { url, auth: init?.headers?.Authorization }; return new Response(new Uint8Array(4000), { status: 200 }); };
  const pending = [];
  try {
    const params = new URLSearchParams({ RecordingSid: "RE" + "1".repeat(32), CallSid: "CA" + "2".repeat(32), RecordingUrl: "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1", RecordingDuration: "184" });
    await recordingReady(env, 1, params, new URLSearchParams({ to: "+61352458679", uid: "3" }), (p) => pending.push(p), async () => ({ id: 42, name: "Geelong Physical Therapy Centre" }));
    await Promise.all(pending);
  } finally { globalThis.fetch = real; }
  assert.equal(fetched.url, "https://api.twilio.com/2010-04-01/Accounts/AC/Recordings/RE1.mp3");
  assert.match(fetched.auth, /^Basic /);
  const rec = rows.get(1);
  assert.equal(rec.status, "done", rec.error);
  assert.equal(JSON.parse(rec.summary).outcome, "interested");
  assert.equal(events.length, 1); assert.equal(events[0][1], 42);
  assert.match(events[0][3], /AI call notes \(3 min\): Spoke to Carey.*Next: Coffee Tuesday/s);
});
