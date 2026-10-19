import { describe, expect, it } from 'vitest';
import { handleResendEvent, verifyResend } from '../src/integrations/bounces';
import type { Runtime } from '../src/app';

const SECRET = 'whsec_' + btoa('test-signing-key-123456');
async function sign(id: string, ts: string, body: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-signing-key-123456'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return 'v1,' + btoa(String.fromCharCode(...new Uint8Array(mac)));
}

// Minimal D1 stand-in that records what the handler runs.
function fakeRt() {
  const ran: { sql: string; args: unknown[] }[] = [];
  const prepare = (sql: string) => ({ bind: (...args: unknown[]) => { ran.push({ sql, args }); return { sql }; } });
  const DB = { prepare, batch: async (stmts: unknown[]) => stmts.map(() => ({ meta: { changes: 3 } })) };
  return { rt: { env: { DB }, settings: {}, origin: 'https://apply.test' } as unknown as Runtime, ran };
}

describe('Resend bounce webhook', () => {
  it('accepts a correctly signed, fresh payload and rejects anything else', async () => {
    const body = JSON.stringify({ type: 'email.bounced' });
    const now = Date.now();
    const ts = String(Math.floor(now / 1000));
    const sig = await sign('msg_1', ts, body);
    expect(await verifyResend(SECRET, body, { id: 'msg_1', timestamp: ts, signature: `v1,bogus ${sig}` }, now)).toBe(true);
    expect(await verifyResend(SECRET, body + ' ', { id: 'msg_1', timestamp: ts, signature: sig }, now)).toBe(false);
    expect(await verifyResend(SECRET, body, { id: 'msg_2', timestamp: ts, signature: sig }, now)).toBe(false);
    expect(await verifyResend(SECRET, body, { id: 'msg_1', timestamp: ts, signature: sig }, now + 10 * 60_000)).toBe(false);
    expect(await verifyResend(SECRET, body, { id: 'msg_1', timestamp: ts, signature: null }, now)).toBe(false);
  });

  it('blocks hard bounces and spam complaints, cancels the queue, leaves soft bounces alone', async () => {
    const { rt, ran } = fakeRt();
    const r = await handleResendEvent(rt, { type: 'email.bounced', data: { email_id: 'e1', to: ['Giovanni@Sourci.com.au'], bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' } } });
    expect(r).toEqual({ blocked: [{ email: 'giovanni@sourci.com.au', cancelled: 3 }] });
    expect(ran.some((x) => /INSERT INTO email_suppressions/.test(x.sql) && x.args[0] === 'giovanni@sourci.com.au' && x.args[1] === 'bounced')).toBe(true);
    expect(ran.some((x) => /UPDATE emails SET status = 'cancelled'/.test(x.sql))).toBe(true);
    expect(ran.some((x) => /UPDATE leads SET unsubscribed_at/.test(x.sql))).toBe(true);

    const c = await handleResendEvent(rt, { type: 'email.complained', data: { to: ['a@b.com'] } });
    expect(c).toEqual({ blocked: [{ email: 'a@b.com', cancelled: 3 }] });

    expect(await handleResendEvent(rt, { type: 'email.bounced', data: { to: ['x@y.com'], bounce: { type: 'Transient' } } })).toEqual({ ignored: 'transient bounce' });
    expect(await handleResendEvent(rt, { type: 'email.delivered', data: { to: ['x@y.com'] } })).toEqual({ ignored: 'email.delivered' });
  });
});
