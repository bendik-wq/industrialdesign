import { describe, expect, it, vi } from 'vitest';
import { SMS_SKIP, handleReplyWords, plainSms, smsSegments, staleBeforeAnchor, textingZones } from '../src/integrations/sms';
import { blockReason, callingZones } from '../src/integrations/elevenlabs';
import type { Lead } from '../src/funnel/leads';
import type { Runtime } from '../src/app';

const MIN = 60_000;
const lead = (x: Partial<Lead> = {}) => ({
  id: 'l1', first_name: 'Dana', phone: '+61412345678', email: 'dana@example.com', call_consent_at: 1, sms_consent_at: 1, sms_opt_out_at: null, do_not_call_at: null, unsubscribed_at: null,
  status: 'booked', booked_at: 1, booking_cancelled_at: null, timezone: 'Australia/Brisbane', tier: 'A', tier_override: null, ...x,
}) as Lead;

describe('contact fixes', () => {
  it('1. a no-show still gets the no-show texts (the missed booking is not "booked")', () => {
    expect(SMS_SKIP.booked(lead({ status: 'no_show' }), false)).toBe(false);
    expect(SMS_SKIP.booked(lead({ status: 'booked' }), false)).toBe(true);
  });

  it('2. texting hours use the person’s own zone; a pushed "before the call" text is dropped once it’s past half its lead time', () => {
    expect(textingZones(lead())).toEqual(['Australia/Brisbane']);
    expect(textingZones(lead({ timezone: null }))).toEqual(callingZones('+61412345678'));
    expect(textingZones(lead({ timezone: 'Europe/Oslo' }))).toEqual(callingZones('+61412345678')); // doesn't fit the number: all its zones
    const call = Date.parse('2026-11-10T00:00:00Z');
    expect(staleBeforeAnchor(call - 150 * MIN, call, -180)).toBe(false); // 3h text moved 30 min later: still useful
    expect(staleBeforeAnchor(call, call, -180)).toBe(true);              // would land at the call time: dropped
    expect(staleBeforeAnchor(call - 20 * MIN, call, -60)).toBe(true);    // 1h text squeezed to 20 min before: dropped
    expect(staleBeforeAnchor(null, call, -60)).toBe(true);
  });

  it('3. STOP stops everything: texts, every AI call (queued ones cancelled) and emails', async () => {
    const sql: string[] = [];
    const stmt = (q: string) => ({ bind: () => stmt(q), first: async () => null, all: async () => ({ results: [] }), run: async () => { sql.push(q); return { meta: { changes: 1 } }; } });
    const rt = { env: { DB: { prepare: (q: string) => stmt(q), batch: async () => [] } }, settings: {}, origin: 'https://apply.test', waitUntil: () => {} } as unknown as Runtime;
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const r = await handleReplyWords(rt, lead(), 'STOP', 'sms');
    vi.unstubAllGlobals();
    expect(r.kind).toBe('stop');
    const upd = sql.find((q) => /UPDATE leads SET/.test(q))!;
    for (const col of ['sms_opt_out_at', 'do_not_call_at', 'unsubscribed_at']) expect(upd).toContain(col);
    expect(sql.some((q) => /UPDATE outbound_calls SET status = 'cancelled'.*status = 'queued'/.test(q))).toBe(true);
    // Someone who replied STOP before this fix: the AI calls skip them too.
    for (const k of ['confirm', 'speed_to_lead', 'rebook'] as const) expect(blockReason(lead({ sms_opt_out_at: 5, status: k === 'rebook' ? 'no_show' : 'booked' }), k)).toBe('replied STOP to a text');
  });

  it('5. outgoing texts use plain characters (GSM, 160-character segments)', () => {
    const curly = 'Dana, we’re live now: “Buy your first competitor” – join here… ' + 'x'.repeat(60);
    expect(smsSegments(curly)).toBeGreaterThan(1);
    expect(plainSms(curly)).toBe('Dana, we\'re live now: "Buy your first competitor" - join here... ' + 'x'.repeat(60));
    expect(smsSegments(plainSms(curly))).toBe(1);
  });
});
