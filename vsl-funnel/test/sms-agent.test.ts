import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Claude is mocked: each test queues what the model "answers" (text, or tool calls then text).
type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
const claude = vi.hoisted(() => ({ queue: [] as { content: Block[]; stop_reason: string }[], calls: [] as { system: string; messages: unknown[]; tools?: unknown[] }[] }));
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      create: async (req: { system: string; messages: unknown[]; tools?: unknown[] }) => {
        claude.calls.push(JSON.parse(JSON.stringify(req)));
        return claude.queue.shift() ?? { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Josh’s team will reply here.' }] };
      },
    };
  },
}));
// The voice agent's Calendly tools are tested on their own (calendly-tools tests); here we check the agent calls them right.
const cal = vi.hoisted(() => ({ calls: [] as { action: string; body: Record<string, unknown> }[], replies: [] as Record<string, unknown>[] }));
vi.mock('../src/integrations/calendly-tools', async (orig) => ({
  ...(await orig<typeof import('../src/integrations/calendly-tools')>()),
  handleBookingTool: async (_rt: unknown, action: string, _h: unknown, body: Record<string, unknown>) => { cal.calls.push({ action, body }); return { status: 200, body: cal.replies.shift() ?? { ok: false } }; },
}));
const slack = vi.hoisted(() => ({ pings: [] as { headline: string; extra: string[] }[] }));
vi.mock('../src/integrations/notify', async (orig) => ({
  ...(await orig<typeof import('../src/integrations/notify')>()),
  notifySlack: async (_rt: unknown, _lead: unknown, headline: string, extra: string[] = []) => { slack.pings.push({ headline, extra }); },
}));

import type { Runtime } from '../src/app';
import { SETTINGS } from '../src/settings';
import { handleInboundSms } from '../src/integrations/sms';
import { recordConsent } from '../src/integrations/consent-gate';
import { AI_TEXT_TEMPLATE, MAX_CHARS, agentState, leadTexts, setPaused, setTextAgentDebounce } from '../src/integrations/sms-agent';

// ───────────── A real SQLite database shaped like D1, every migration applied ─────────────
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } }
interface DatabaseSync { prepare(sql: string): Stmt; exec(sql: string): void }
const node = (globalThis as unknown as { process: { getBuiltinModule(id: string): unknown; cwd(): string } }).process;
const { DatabaseSync } = node.getBuiltinModule('node:sqlite') as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = node.getBuiltinModule('node:fs') as { readdirSync(p: string): string[]; readFileSync(p: string, enc: string): string };
function d1(db: DatabaseSync) {
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const norm = () => args.map((a) => (a === undefined ? null : typeof a === 'boolean' ? Number(a) : a)) as (string | number | null)[];
    const isRead = /^\s*(SELECT|WITH)\b/i.test(sql);
    const st = {
      bind: (...a: unknown[]) => { args = a; return st; },
      first: async <T>() => (db.prepare(sql).get(...norm()) as T | undefined) ?? null,
      all: async <T>() => ({ results: db.prepare(sql).all(...norm()) as T[] }),
      run: async () => {
        if (isRead) return { results: db.prepare(sql).all(...norm()), meta: { changes: 0 } };
        const r = db.prepare(sql).run(...norm());
        return { results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
      },
    };
    return st;
  };
  return { prepare, batch: async (stmts: { run: () => Promise<unknown> }[]) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
}
function freshDb() {
  const db = new DatabaseSync(':memory:');
  const dir = `${node.cwd()}/migrations`;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) db.exec(fs.readFileSync(`${dir}/${f}`, 'utf8'));
  return db;
}

const BASE = { ANTHROPIC_API_KEY: 'sk-ant-test', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 'tok', SMS_FROM: '+15005550006', SALES_TIMEZONE: 'America/New_York' };
let db: DatabaseSync;
let rt: Runtime;
const pending: Promise<unknown>[] = [];
const makeRt = (s: Record<string, string> = {}) =>
  ({ env: { DB: d1(db), SESSION_SECRET: 'test-secret' }, settings: { ...Object.fromEntries(SETTINGS.map((d) => [d.key, ''])), ...BASE, ...s }, reps: [], origin: 'https://apply.test', waitUntil: (p: Promise<unknown>) => { pending.push(p.catch((e) => { throw e; })); } }) as unknown as Runtime;
const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const q = <T = Record<string, unknown>>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...(a as (string | number | null)[])) as T[];
const x = (sql: string, ...a: unknown[]) => db.prepare(sql).run(...(a as (string | number | null)[]));

const PHONE = '+12025550143';
const T0 = Date.parse('2026-11-17T16:00:00Z'); // Tuesday, 11am New York
let sent: { to: string; body: string }[] = [];

async function seedLead(o: { texts?: boolean } = {}) {
  x(`INSERT INTO leads (id, ref_code, created_at, updated_at, first_name, email, phone, status, tier, booking_source, app_completed_at, timezone, answers)
     VALUES ('l1', 'R1XYZ', ?, ?, 'Dana', 'dana@co.com', ?, 'applied', 'A', 'funnel', ?, 'America/New_York', ?)`, T0 - 3600_000, T0 - 3600_000, PHONE, T0 - 60_000, JSON.stringify({ role: 'owner', revenue: '3_10m' }));
  if (o.texts !== false) await recordConsent(rt, 'l1', { phone: PHONE, call: true, texts: true, source: 'apply', page: '/apply' }, T0 - 60_000);
}
const text = (t: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text' as const, text: t }] });
const tool = (name: string, input: Record<string, unknown>, id = `tu_${name}`) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use' as const, id, name, input }] });
const inbound = (body: string, from = PHONE) => handleInboundSms(rt, { From: from, Body: body, MessageSid: `SM${Math.random().toString(36).slice(2, 8)}` });
const aiRows = () => q<{ body: string; status: string }>('SELECT body, status FROM sms_messages WHERE template = ? ORDER BY created_at, rowid', AI_TEXT_TEMPLATE);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  setTextAgentDebounce(0);
  db = freshDb();
  rt = makeRt();
  claude.queue = []; claude.calls = []; cal.calls = []; cal.replies = []; slack.pings = []; sent = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body?: URLSearchParams | string } = {}) => {
    if (String(url).includes('api.twilio.com')) {
      const p = new URLSearchParams(String(init.body));
      sent.push({ to: p.get('To')!, body: p.get('Body')! });
      return new Response(JSON.stringify({ sid: `SM${sent.length}` }), { status: 201 });
    }
    return new Response('{}', { status: 404 });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setTextAgentDebounce(4000); });

describe('the AI texting agent', () => {
  it('answers a question by text, and the first AI text says it is Josh’s AI assistant', async () => {
    await seedLead();
    claude.queue.push(text('The deal is funded by commercial debt, seller finance and seller rollover. Want to see open times for a call with Josh’s team?'));
    expect((await inbound('How does the funding work?')).kind).toBe('ai_reply');
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
    expect(sent[0].body).toMatch(/^Sam here, Josh's AI assistant at G&L\. The deal is funded by commercial debt, seller finance and seller rollover\./);
    expect(sent[0].body.length).toBeLessThanOrEqual(MAX_CHARS);
    expect(aiRows()).toEqual([{ body: sent[0].body, status: 'sent' }]);
    // The model saw the lead, their application, the facts and the thread, and that their texts are data.
    const c = claude.calls[0];
    expect(c.system).toMatch(/First name: Dana/);
    expect(c.system).toMatch(/Founder \/ majority owner/);
    expect(c.system).toMatch(/never say or imply you are Josh or a person/);
    expect(c.system).toMatch(/Never call the strategy call free/);
    expect(c.system).toMatch(/Do I really put no money down\?/);
    expect(JSON.stringify(c.messages)).toContain('THEM: How does the funding work?');
    // A second reply: no AI line again.
    claude.queue.push(text('Most calls run 30 minutes.'));
    await inbound('How long is the call?');
    await flush();
    expect(sent[1].body).toBe('Most calls run 30 minutes.');
    expect(JSON.stringify(claude.calls[1].messages)).toContain('YOU (AI): Sam here');
  });

  it('offers real open times and books the one they pick, through the voice agent’s Calendly tools', async () => {
    await seedLead();
    cal.replies.push({ ok: true, result: 'offered', timezone: 'New York time', slots: [{ slot_id: '2026-11-18T15:00:00.000Z', spoken: 'Wednesday 18 November at 10am' }] });
    claude.queue.push(tool('get_open_times', { preferred_day: 'tomorrow', part_of_day: 'morning' }), text('Tomorrow at 10am New York time is open. Does that work?'));
    await inbound('Can I book a call tomorrow morning?');
    await flush();
    expect(cal.calls[0]).toMatchObject({ action: 'availability', body: { preferred_day: 'tomorrow', part_of_day: 'morning' } });
    expect(typeof cal.calls[0].body.lead_token).toBe('string');
    expect(sent[0].body).toMatch(/Tomorrow at 10am New York time is open/);

    cal.replies.push({ ok: true, result: 'booked', booked_for: 'Wednesday 18 November at 10am, New York time' });
    claude.queue.push(tool('book_time', { slot_id: '2026-11-18T15:00:00.000Z' }), text('Done, you are booked for Wednesday 18 November at 10am New York time. The invite comes from Calendly by email.'));
    await inbound('Yes 10am works');
    await flush();
    expect(cal.calls[1]).toMatchObject({ action: 'book', body: { slot_id: '2026-11-18T15:00:00.000Z' } });
    expect(sent[1].body).toMatch(/^Done, you are booked/);
    // The tool result went back to the model with the text-specific note.
    expect(JSON.stringify(claude.calls.at(-1)!.messages)).toContain('This is a text conversation');
  });

  it('when booking fails, texts the booking link (a tracked short link), and no other link', async () => {
    await seedLead();
    claude.queue.push(text('Booking by text didn’t work this time. You can pick a time here: {book_link} See https://evil.example too.'));
    await inbound('book me in');
    await flush();
    const row = q<{ id: string; body: string; link_target: string }>('SELECT id, body, link_target FROM sms_messages WHERE template = ?', AI_TEXT_TEMPLATE)[0];
    expect(row.link_target).toBe('https://apply.test/book');
    expect(row.body).toContain(`https://apply.test/s/${row.id}`);
    expect(row.body).not.toContain('evil.example');
    expect(row.body).not.toContain('{book_link}');
  });

  it('hands over to the team: Slack ping with the thread, AI replies pause, the team can resume them', async () => {
    await seedLead();
    claude.queue.push(tool('handoff', { reason: 'asked for a person' }), text('Josh’s team will reply to you here shortly.'));
    await inbound('Can I talk to a real person?');
    await flush();
    expect(sent[0].body).toMatch(/Josh's team will reply to you here shortly/);
    expect((await agentState(rt, 'l1')).paused_at).toBe(T0);
    expect(slack.pings.at(-1)!.headline).toMatch(/handed to the team/);
    expect(slack.pings.at(-1)!.extra.join('\n')).toContain('Can I talk to a real person?');
    // Paused: the next text goes to the team, not the AI.
    const calls = claude.calls.length;
    expect((await inbound('Hello?')).kind).toBe('reply');
    await flush();
    expect(claude.calls.length).toBe(calls);
    expect(slack.pings.at(-1)!.headline).toMatch(/Text reply/);
    // Funnel HQ resumes it.
    await setPaused(rt, 'l1', false, 'team');
    expect((await leadTexts(rt, 'l1')).agent.paused_at).toBeNull();
    claude.queue.push(text('Happy to help.'));
    expect((await inbound('Any update?')).kind).toBe('ai_reply');
    await flush();
    expect(sent.at(-1)!.body).toBe('Happy to help.');
  });

  it('STOP, START and C still win over the AI', async () => {
    await seedLead();
    expect((await inbound('STOP')).kind).toBe('stop');
    await flush();
    expect(claude.calls).toHaveLength(0);
    expect(sent).toHaveLength(0);
    // Opted out: ordinary texts are not answered by the AI either.
    expect((await inbound('what is this')).kind).toBe('reply');
    await flush();
    expect(claude.calls).toHaveLength(0);
  });

  it('caps replies per person per day, then pauses and pings the team', async () => {
    rt = makeRt({ AI_TEXT_AGENT_MAX_PER_DAY: '1' });
    await seedLead();
    claude.queue.push(text('First answer.'));
    await inbound('q1');
    await flush();
    vi.setSystemTime(T0 + 60_000);
    await inbound('q2');
    await flush();
    expect(aiRows()).toHaveLength(1);
    expect((await agentState(rt, 'l1')).reason).toBe('daily AI reply limit reached');
    expect(slack.pings.at(-1)!.headline).toMatch(/needs a person/);
  });

  it('ignores numbers that are not leads, and needs consent to text', async () => {
    expect((await inbound('hi', '+12025559999')).kind).toBe('unknown');
    await flush();
    expect(claude.calls).toHaveLength(0);
    await seedLead({ texts: false });
    x("UPDATE leads SET call_consent_at = NULL, sms_consent_at = NULL WHERE id = 'l1'");
    await inbound('hi there');
    await flush();
    expect(sent).toHaveLength(0);
    expect(slack.pings.at(-1)!.extra[0]).toMatch(/can't text this person back/);
  });

  it('never sends a text that calls the call free or claims to be Josh; pauses instead', async () => {
    await seedLead();
    claude.queue.push(text('Hi, I’m Josh. Book your free strategy call.'));
    await inbound('who is this');
    await flush();
    expect(sent).toHaveLength(0);
    expect((await agentState(rt, 'l1')).paused_at).not.toBeNull();
  });

  it('is off when AI_TEXT_AGENT is off or there is no Anthropic key: the team is pinged as before', async () => {
    rt = makeRt({ AI_TEXT_AGENT: 'off' });
    await seedLead();
    expect((await inbound('hello')).kind).toBe('reply');
    await flush();
    expect(claude.calls).toHaveLength(0);
    expect(slack.pings.at(-1)!.headline).toMatch(/Text reply/);
  });

  it('AI replies do not use up the daily limit for sequence texts', async () => {
    const src = fs.readFileSync(`${node.cwd()}/src/integrations/sms.ts`, 'utf8');
    expect(src).toMatch(/AND sent_at > \? AND COALESCE\(template, ''\) != 'ai_agent'/);
  });
});
