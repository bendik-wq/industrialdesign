import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/app';
import { closersFor, pickWeighted } from '../src/funnel/routing';
import { notify } from '../src/integrations/notify';
import { localClock } from '../src/sales/digest';
import { calendarFor, repTiers, slugId, type Rep } from '../src/sales/reps';
import { startOfMonth } from '../src/admin/sales';
import type { Settings } from '../src/settings';

const rep = (over: Partial<Rep>): Rep => ({
  id: 'r', name: 'Rep', email: null, role: 'closer', tiers: 'A,B', weight: 1, calendar_url: 'https://cal.example/r', booking_setting: null,
  commission_pct: 10, monthly_target: 0, slack_user_id: null, discord_user_id: null, active: 1, created_at: 0, ...over,
});
const rt = (settings: Partial<Settings>, reps: Rep[] = []) => ({ settings: settings as Settings, reps, origin: 'https://hq.example' }) as unknown as Runtime;

describe('sales team', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('routes only to active closers who take the tier and have a calendar', () => {
    const reps = [
      rep({ id: 'josh', tiers: 'A', calendar_url: null, booking_setting: 'BOOKING_URL_A' }),
      rep({ id: 'b1', tiers: 'B' }),
      rep({ id: 'setter', role: 'setter' }),
      rep({ id: 'off', active: 0 }),
      rep({ id: 'nocal', calendar_url: null }),
    ];
    const r = rt({ BOOKING_URL_A: 'https://calendly.com/josh' }, reps);
    expect(closersFor(r, 'A').map((x) => x.id)).toEqual(['josh']);
    expect(closersFor(r, 'B').map((x) => x.id)).toEqual(['b1']);
    expect(calendarFor(r.settings, reps[0])).toBe('https://calendly.com/josh');
  });

  it('splits round-robin by weight', () => {
    const reps = [{ id: 'a', weight: 2 }, { id: 'b', weight: 1 }];
    let state: Record<string, number> = {};
    const picks: string[] = [];
    for (let i = 0; i < 6; i++) { const r = pickWeighted(reps, state); state = r.state; picks.push(r.closer.id); }
    expect(picks.filter((p) => p === 'a')).toHaveLength(4);
  });

  it('parses tiers and makes slug ids', () => {
    expect(repTiers({ tiers: 'A, B,' })).toEqual(['A', 'B']);
    expect(slugId('Sarah O’Neil')).toBe('sarah-oneil');
  });

  it('posts wins to the wins channel on Slack and Discord with @mentions', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response('ok'); }));
    const r = rt({ SLACK_WEBHOOK_URL: 'https://slack/alerts', SLACK_WINS_WEBHOOK_URL: 'https://slack/wins', DISCORD_WEBHOOK_URL: 'https://discord/alerts' });
    const res = await notify(r, { kind: 'won', title: '🎉 Deal closed', lines: ['$50,000'], rep: rep({ slack_user_id: 'U123', discord_user_id: '123456789012345678' }) });
    expect(res).toEqual({ slack: true, discord: true });
    expect(calls.map((c) => c.url).sort()).toEqual(['https://discord/alerts', 'https://slack/wins']);
    expect(calls.find((c) => c.url.includes('slack'))!.body.text).toMatch(/^<@U123> \*🎉 Deal closed\*/);
    const d = calls.find((c) => c.url.includes('discord'))!.body;
    expect(d.content).toBe('<@123456789012345678>');
    expect(d.allowed_mentions.users).toEqual(['123456789012345678']);
  });

  it('does nothing when no webhooks are set', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await notify(rt({}), { kind: 'booked', title: 'x' })).toEqual({ slack: false, discord: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('works out local time and month start in the team time zone', () => {
    const t = Date.UTC(2026, 9, 10, 22, 30); // 11 Oct 09:30 in Sydney (AEDT, UTC+11)
    expect(localClock(t, 'Australia/Sydney')).toEqual({ date: '2026-10-11', hour: 9 });
    expect(new Date(startOfMonth(t, 'Australia/Sydney')).toISOString()).toBe('2026-09-30T14:00:00.000Z');
  });
});
