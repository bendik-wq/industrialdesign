import { describe, expect, it } from 'vitest';
import {
  AFTER_MIN, CHAT_CAP, LIVE_COPY, PRESENCE_MS, announcementLive, chatLabel, chatRate, chatStage, countPresence, escapeHtml, hostNames, maskProfanity, pickHostName,
  presenceLine, sanitiseChat, scheduledActive, viewerName, type AutoAnnouncement,
} from '../src/webinar/live';
import { auditCopy } from '../src/content/copy-rules';

const clean = (s: string) => { const r = sanitiseChat(s); if (!r.ok) throw new Error(r.error); return r.text; };

describe('chat sanitiser', () => {
  it('keeps ordinary messages as they are (whitespace collapsed)', () => {
    expect(clean('  Hi from   Brisbane,\n running a $4M plumbing business  ')).toBe('Hi from Brisbane, running a $4M plumbing business');
  });
  it('removes links, bare domains, emails and handles', () => {
    expect(clean('see https://evil.example/x?y=1 now')).toBe('see [removed] now');
    expect(clean('go to www.spam.io')).toBe('go to [removed]');
    expect(clean('check mysite.com/offer')).toBe('check [removed]');
    expect(clean('mail me at dana@firm.co')).toBe('mail me at [removed]');
    expect(clean('follow @dealguy on IG')).toBe('follow [removed] on IG');
  });
  it('removes phone numbers but keeps money and years', () => {
    expect(clean('call 0412 345 678')).toBe('call [removed]');
    expect(clean('ring +1 (415) 555-0199 today')).toBe('ring [removed] today');
    expect(clean('we did $1 500 000 in 2025')).toBe('we did $1 500 000 in 2025');
    expect(clean('EBITDA 1,200,000 on 12000000 revenue')).toBe('EBITDA 1,200,000 on [removed] revenue');
  });
  it('masks profanity', () => {
    expect(maskProfanity('this is shit')).toBe('this is s***');
    expect(clean('Fucking great point')).toBe('F****** great point');
    expect(clean('Scunthorpe classic')).toBe('Scunthorpe classic');
  });
  it('rejects empty and over-long messages', () => {
    expect(sanitiseChat('   ').ok).toBe(false);
    expect(sanitiseChat(42).ok).toBe(false);
    expect(sanitiseChat('x'.repeat(401))).toEqual({ ok: false, error: LIVE_COPY.tooLong });
    expect(sanitiseChat('x'.repeat(400)).ok).toBe(true);
  });
  it('strips control characters; escaping happens on output', () => {
    expect(clean('a\u0000b‮c')).toBe('a b c');
    expect(escapeHtml('<script>alert("x")</script> & \'')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;');
  });
});

describe('chat rate limit', () => {
  const now = 1_000_000;
  it('allows the first message and one every 8 seconds', () => {
    expect(chatRate(0, null, now).ok).toBe(true);
    expect(chatRate(3, now - 8_000, now).ok).toBe(true);
    const r = chatRate(3, now - 2_500, now);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.retryInSec).toBe(6); expect(r.error).toBe(LIVE_COPY.rateWait); }
  });
  it('caps a registration at 30 messages per showing', () => {
    expect(chatRate(CHAT_CAP - 1, now - 60_000, now).ok).toBe(true);
    const r = chatRate(CHAT_CAP, now - 60_000, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(LIVE_COPY.rateCap);
  });
});

describe('presence', () => {
  const now = 10_000_000;
  const rows = [
    { who: 'me', kind: 'viewer', seen_at: now - 1_000 },
    { who: 'a', kind: 'viewer', seen_at: now - 44_000 },
    { who: 'b', kind: 'viewer', seen_at: now - 46_000 }, // gone
    { who: 'c', kind: 'replay', seen_at: now - 5_000 },
    { who: 'host:x', kind: 'host', seen_at: now - 59_000 },
    { who: 'host:y', kind: 'host', seen_at: now - 61_000 }, // gone
  ];
  it('counts other people inside each window, never yourself', () => {
    expect(countPresence(rows, now, 'me')).toEqual({ viewers: 1, replay: 1, host: 1 });
    expect(countPresence(rows, now, null).viewers).toBe(2);
    expect(PRESENCE_MS.viewer).toBe(45_000);
    expect(PRESENCE_MS.host).toBe(60_000);
  });
  it('only says something when two or more others are really there', () => {
    expect(presenceLine('running', 0)).toBeNull();
    expect(presenceLine('running', 1)).toBeNull();
    expect(presenceLine('running', 6)).toBe('You and 6 other owners are watching this showing.');
    expect(presenceLine('waiting', 2)).toMatch(/waiting for this showing/);
    expect(presenceLine('closed', 9)).toBeNull();
  });
  it('keeps the replay separate from a showing', () => {
    expect(presenceLine('replay', 1)).toBeNull();
    expect(presenceLine('replay', 3)).toBe('3 other owners are watching this replay right now.');
  });
  it('knows when the chat is open', () => {
    const end = 5_000_000;
    expect(chatStage('waiting', end, 0, false)).toBe('waiting');
    expect(chatStage('running', end, 0, false)).toBe('running');
    expect(chatStage('replay', end, end + (AFTER_MIN - 1) * 60_000, false)).toBe('after');
    expect(chatStage('replay', end, end + (AFTER_MIN + 1) * 60_000, false)).toBe('closed');
    expect(chatStage('running', end, 0, true)).toBe('replay');
    expect(chatStage('expired', end, end, false)).toBe('closed');
  });
});

describe('chat labels', () => {
  it('shows first name and last initial, or "An owner"', () => {
    expect(viewerName('Dana', 'Kowalski', false)).toBe('Dana K.');
    expect(viewerName('Dana', null, false)).toBe('Dana');
    expect(viewerName('Dana', 'Kowalski', true)).toBe('An owner');
    expect(viewerName('', 'X', false)).toBe('An owner');
    expect(viewerName('<b>Jo</b>', 'smith', false)).toBe('bJob S.');
  });
  it('only team messages carry the team badge, whatever a viewer is called', () => {
    expect(chatLabel({ author: 'team', name: 'Josh' })).toEqual({ name: 'Josh', team: true, badge: 'Team' });
    expect(chatLabel({ author: 'viewer', name: 'Josh' })).toEqual({ name: 'Josh', team: false, badge: null });
  });
  it('team names come from the settings allowlist', () => {
    expect(hostNames({})).toEqual(['G&L team', 'Josh']);
    expect(hostNames({ WEBINAR_HOST_NAMES: 'G&L team, Josh, Sam <x>' })).toEqual(['G&L team', 'Josh', 'Sam x']);
    expect(pickHostName({}, 'Josh')).toBe('Josh');
    expect(pickHostName({}, 'Elon')).toBe('G&L team');
  });
});

describe('announcements', () => {
  it('expire after their minutes, or when ended', () => {
    expect(announcementLive({ expires_at: 2000, ended_at: null }, 1000)).toBe(true);
    expect(announcementLive({ expires_at: 2000, ended_at: null }, 2000)).toBe(false);
    expect(announcementLive({ expires_at: 9000, ended_at: 1500 }, 1000)).toBe(false);
  });
  it('scheduled ones show from their minute for their length', () => {
    const a = (id: string, at_min: number, minutes: number, extra: Partial<AutoAnnouncement> = {}): AutoAnnouncement => ({ id, at_min, minutes, body: id, link_url: null, link_label: null, replay: 1, active: 1, ...extra });
    const list = [a('apply', 46, 10), a('qa', 55, 20, { replay: 0 }), a('off', 0, 99, { active: 0 })];
    expect(scheduledActive(list, 45, false)).toBeNull();
    expect(scheduledActive(list, 46, false)?.id).toBe('apply');
    expect(scheduledActive(list, 55, false)?.id).toBe('qa');
    expect(scheduledActive(list, 55, true)?.id).toBe('apply');
    expect(scheduledActive(list, 56, true)).toBeNull();
    expect(scheduledActive(list, 75, false)).toBeNull();
  });
});

describe('live layer copy', () => {
  it('passes the house copy rules', () => {
    // Each string is shown on its own, so each is audited on its own.
    const strings = [...Object.values(LIVE_COPY), presenceLine('running', 6), presenceLine('waiting', 3), presenceLine('after', 2), presenceLine('replay', 4)].map(String);
    for (const s of strings) expect(auditCopy(s), s).toEqual([]);
    const all = strings.join('\n');
    expect(all).not.toMatch(/!|\bLIVE\b/);
  });
});
