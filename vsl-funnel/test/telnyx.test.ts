import { describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { smsConfigured, smsProvider, verifyTelnyx } from '../src/integrations/sms';

const rt = (s: Record<string, string>) => ({ settings: s }) as unknown as Runtime;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

describe('Telnyx texting', () => {
  it('picks the provider: explicit setting, else Twilio when connected, else Telnyx', () => {
    expect(smsProvider(rt({ TELNYX_API_KEY: 'KEY1' }))).toBe('telnyx');
    expect(smsProvider(rt({ TELNYX_API_KEY: 'KEY1', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't' }))).toBe('twilio');
    expect(smsProvider(rt({ TELNYX_API_KEY: 'KEY1', TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', SMS_PROVIDER: 'telnyx' }))).toBe('telnyx');
    expect(smsProvider(rt({ SMS_PROVIDER: 'telnyx' }))).toBeNull();
    expect(smsProvider(rt({}))).toBeNull();
    expect(smsConfigured(rt({ TELNYX_API_KEY: 'KEY1' }))).toBe(false); // no number yet
    expect(smsConfigured(rt({ TELNYX_API_KEY: 'KEY1', SMS_FROM: '+15550001111' }))).toBe(true);
  });

  it('accepts a correctly signed webhook and refuses a tampered, unsigned or stale one', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = b64(new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer));
    const now = 1_790_000_000_000, ts = String(now / 1000);
    const raw = JSON.stringify({ data: { id: 'e1', event_type: 'message.received' } });
    const sig = b64(new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, new TextEncoder().encode(`${ts}|${raw}`))));
    const r = rt({ TELNYX_API_KEY: 'KEY1' }), key = async () => pub;
    expect(await verifyTelnyx(r, raw, sig, ts, now, key)).toBe(true);
    expect(await verifyTelnyx(r, raw + ' ', sig, ts, now, key)).toBe(false);
    expect(await verifyTelnyx(r, raw, null, ts, now, key)).toBe(false);
    expect(await verifyTelnyx(r, raw, sig, ts, now + 10 * 60_000, key)).toBe(false);
    expect(await verifyTelnyx(r, raw, sig, ts, now, async () => null)).toBe(false);
  });
});
