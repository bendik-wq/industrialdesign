import { describe, expect, it } from 'vitest';
import type { Runtime } from '../src/app';
import { sendsAsName, telnyxFrom } from '../src/integrations/sms';
import { CONSENT_ONE } from '../src/integrations/consent-gate';
import {
  applyFix, brandBody, campaignBody, fixBodies, mergeWhitelist, orderBody, profileStatus, sampleTexts, webhookUrl, type Fetcher,
} from '../src/integrations/telnyx-setup';

const rt = (s: Record<string, string>) => ({ settings: { TELNYX_API_KEY: 'KEY1', TELNYX_MESSAGING_PROFILE_ID: 'prof-1', SMS_FROM: '+17375371215', ...s }, origin: 'https://apply.example.com' }) as unknown as Runtime;

/** A fake Telnyx: answers by method + path prefix and records every call. */
function fakeTelnyx(routes: Record<string, unknown>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const f: Fetcher = async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body ?? null;
    calls.push({ method, url, body });
    const path = url.replace('https://api.telnyx.com/v2', '');
    const hit = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => `${method} ${path}`.startsWith(k));
    if (!hit) return new Response(JSON.stringify({ errors: [{ title: 'Not found', code: '404' }] }), { status: 404 });
    return new Response(JSON.stringify(routes[hit]), { status: 200 });
  };
  return { f, calls };
}

const PROFILE = { id: 'prof-1', name: 'GL', webhook_url: 'https://old.example.com/hook', webhook_api_version: '1', alpha_sender: 'GL Advisory', whitelisted_destinations: ['AU', 'us'] };

describe('Telnyx setup: messaging profile', () => {
  it('the webhook fix points inbound texts at /hooks/telnyx/sms on PUBLIC_URL (or the origin), API v2', async () => {
    expect(webhookUrl(rt({}))).toBe('https://apply.example.com/hooks/telnyx/sms');
    expect(webhookUrl(rt({ PUBLIC_URL: 'https://apply.grosfjeld-li.com/' }))).toBe('https://apply.grosfjeld-li.com/hooks/telnyx/sms');
    const t = fakeTelnyx({ 'PATCH /messaging_profiles/prof-1': { data: PROFILE } });
    const r = await applyFix(rt({ PUBLIC_URL: 'https://apply.grosfjeld-li.com' }), 'webhook', t.f);
    expect(r.ok).toBe(true);
    expect(t.calls[0]).toMatchObject({ method: 'PATCH', url: 'https://api.telnyx.com/v2/messaging_profiles/prof-1', body: { webhook_url: 'https://apply.grosfjeld-li.com/hooks/telnyx/sms', webhook_api_version: '2' } });
  });

  it('clearing the alpha sender sends alpha_sender: null to the profile', async () => {
    expect(fixBodies.alpha()).toEqual({ alpha_sender: null });
    const t = fakeTelnyx({ 'PATCH /messaging_profiles/prof-1': { data: { ...PROFILE, alpha_sender: null } } });
    await applyFix(rt({}), 'alpha', t.f);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].body).toEqual({ alpha_sender: null });
  });

  it('the whitelist fix keeps existing countries and adds ours plus NO, without duplicates', async () => {
    const merged = mergeWhitelist(['AU', 'us', 'DE']);
    expect(merged.slice(0, 3)).toEqual(['AU', 'US', 'DE']);
    for (const c of ['NZ', 'CA', 'GB', 'IE', 'SG', 'AE', 'NO']) expect(merged).toContain(c);
    expect(new Set(merged).size).toBe(merged.length);
    const t = fakeTelnyx({ 'GET /messaging_profiles/prof-1': { data: PROFILE }, 'PATCH /messaging_profiles/prof-1': { data: PROFILE } });
    await applyFix(rt({}), 'whitelist', t.f);
    const patch = t.calls.find((c) => c.method === 'PATCH')!;
    expect((patch.body as { whitelisted_destinations: string[] }).whitelisted_destinations).toEqual(mergeWhitelist(PROFILE.whitelisted_destinations));
  });

  it('assigns SMS_FROM to the profile through the number’s messaging settings', async () => {
    const t = fakeTelnyx({
      'GET /phone_numbers?filter': { data: [{ id: 'num-9', phone_number: '+17375371215', messaging_profile_id: 'other' }] },
      'PATCH /phone_numbers/num-9/messaging': { data: { messaging_profile_id: 'prof-1' } },
    });
    const r = await applyFix(rt({}), 'number', t.f);
    expect(r.ok).toBe(true);
    expect(t.calls.at(-1)).toMatchObject({ method: 'PATCH', url: 'https://api.telnyx.com/v2/phone_numbers/num-9/messaging', body: { messaging_profile_id: 'prof-1' } });
  });

  it('status lists every problem (webhook, sender name, countries, number) and Telnyx errors come back verbatim', async () => {
    const t = fakeTelnyx({
      'GET /messaging_profiles/prof-1': { data: PROFILE },
      'GET /phone_numbers?filter': { data: [{ id: 'num-9', phone_number: '+17375371215', messaging_profile_id: 'other' }] },
      'GET /phone_numbers/num-9/messaging': { data: { messaging_profile_id: 'other', type: 'long-code' } },
    });
    const s = await profileStatus(rt({}), t.f);
    expect(s.problems!.map((p) => p.key).sort()).toEqual(['alpha', 'number', 'webhook', 'whitelist']);
    expect(s.profile!.alpha_sender).toBe('GL Advisory');
    const bad = fakeTelnyx({});
    const r = await applyFix(rt({}), 'alpha', bad.f);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Telnyx 404: Not found');
    expect((await profileStatus(rt({ TELNYX_API_KEY: '' }), bad.f)).connected).toBe(false);
  });
});

describe('Telnyx setup: US 10DLC', () => {
  const full = {
    companyName: 'G&L M&A Advisory Pty Ltd', displayName: 'G&L M&A Advisory', ein: '12345678901', street: '1 Example St', city: 'Brisbane', state: 'QLD', postalCode: '4000',
    firstName: 'Josh', lastName: 'Li', email: 'ops@example.com', phone: '+61 412 345 678',
  };
  it('rejects blank required fields; only entity type, countries, website and vertical have defaults', () => {
    const empty = brandBody({});
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      for (const k of ['companyName', 'displayName', 'ein', 'street', 'city', 'state', 'postalCode', 'firstName', 'lastName', 'email', 'phone']) expect(empty.missing).toContain(k);
      for (const k of ['entityType', 'country', 'einIssuingCountry', 'website', 'vertical']) expect(empty.missing).not.toContain(k);
    }
    expect(brandBody({ ...full, city: '   ' }).ok).toBe(false);
    const ok = brandBody(full);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.body).toMatchObject({ entityType: 'PRIVATE_PROFIT', country: 'AU', einIssuingCountry: 'AU', vertical: 'PROFESSIONAL', website: 'https://apply.grosfjeld-li.com', phone: '+61412345678' });
  });

  it('the campaign is MIXED (customer care + marketing), quotes the real consent wording and uses real sample texts', () => {
    const c = campaignBody('BRAND1');
    expect(c).toMatchObject({ brandId: 'BRAND1', usecase: 'MIXED', subUsecases: ['CUSTOMER_CARE', 'MARKETING'], embeddedLink: true, numberPool: false, ageGated: false, directLending: false });
    expect(c.messageFlow).toContain(CONSENT_ONE.text);
    expect(c.messageFlow).toContain('https://apply.grosfjeld-li.com/apply');
    expect(c.description).toMatch(/AI assistant that says it is an AI/);
    expect(c.optoutKeywords).toContain('STOP');
    expect(c.helpKeywords).toContain('HELP');
    const s = sampleTexts();
    expect(s.length).toBeGreaterThanOrEqual(3);
    expect(s[0]).toContain('strategy call');
    expect(s.join(' ')).not.toMatch(/\{[a-z_]+\}/);
    expect(s.at(-1)).toMatch(/AI assistant/);
    expect(c.sample1).toBe(s[0]);
  });
});

describe('Telnyx setup: Australian number', () => {
  it('the order carries the requirements and the messaging profile', () => {
    const b = orderBody(rt({}), '+61412000111', [{ requirement_id: 'req-1', field_value: 'G&L Pty Ltd' }, { requirement_id: 'req-2', field_value: '  ' }, { requirement_id: '', field_value: 'x' }]);
    expect(b).toEqual({ phone_numbers: [{ phone_number: '+61412000111', regulatory_requirements: [{ requirement_id: 'req-1', field_value: 'G&L Pty Ltd' }] }], messaging_profile_id: 'prof-1' });
  });

  it('texts to +61 come from SMS_FROM_AU when set (repliable), else the sender name; other countries from SMS_FROM', () => {
    const withAu = rt({ SMS_SENDER_AU: 'GL Advisory', SMS_FROM_AU: '+61412000111' });
    expect(telnyxFrom(withAu, '+61498765432')).toEqual({ number: '+61412000111', alpha: false, au: true });
    expect(sendsAsName(withAu, '+61498765432')).toBeNull();
    expect(telnyxFrom(withAu, '+15125550100')).toEqual({ number: '+17375371215', alpha: false, au: false });
    const nameOnly = rt({ SMS_SENDER_AU: 'GL Advisory' });
    expect(telnyxFrom(nameOnly, '+61498765432')).toEqual({ number: 'GL Advisory', alpha: true, au: false });
    expect(telnyxFrom(rt({ SMS_SENDER_AU: 'GL Advisory', SMS_FROM_AU: 'not-a-number' }), '+61498765432').alpha).toBe(true);
  });
});
