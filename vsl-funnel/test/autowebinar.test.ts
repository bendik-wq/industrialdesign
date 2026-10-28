import { describe, expect, it } from 'vitest';
import { nextJitStart } from '../src/webinar/webinar';
import { answerProblems } from '../src/webinar/assistant';
import { auditFields } from '../src/content/copy-rules';
import { DEFAULT_CHAPTERS, DEFAULT_POLLS, ROOM_COPY, THANK_YOU, WORKSHEET } from '../src/webinar/content';

describe('just-in-time showings', () => {
  const hours = { from: 7, to: 22 };
  it('offers the next 15-minute slot at least 4 minutes away', () => {
    const now = Date.parse('2026-10-28T02:00:00Z'); // 1pm Sydney
    expect(nextJitStart(now, 15, 'Australia/Sydney', hours)).toBe(Date.parse('2026-10-28T02:15:00Z'));
    expect(nextJitStart(now + 12 * 60_000, 15, 'Australia/Sydney', hours)).toBe(Date.parse('2026-10-28T02:30:00Z'));
  });
  it('stays inside the viewer’s waking hours and can be switched off', () => {
    const night = Date.parse('2026-10-28T15:00:00Z'); // 2am Sydney
    expect(nextJitStart(night, 15, 'Australia/Sydney', hours)).toBeNull();
    expect(nextJitStart(night, 15, 'America/New_York', hours)).not.toBeNull(); // 11am New York
    expect(nextJitStart(night, 0, 'America/New_York', hours)).toBeNull();
  });
});

describe('room assistant safety net', () => {
  it('drops answers that break house rules', () => {
    expect(answerProblems('Book your free strategy call today.')).toContain('calls the call free');
    expect(answerProblems('Commercial debt and seller finance cover the price.')).toContain('funding without seller rollover');
    expect(answerProblems('Commercial debt, seller finance and seller rollover cover the price.')).toEqual([]);
    expect(answerProblems('Great question!')).toContain('exclamation or emoji');
  });
});

describe('room copy', () => {
  it('passes the copy rules and names seller rollover wherever funding is described', () => {
    expect(auditFields({ DEFAULT_CHAPTERS, DEFAULT_POLLS, ROOM_COPY, THANK_YOU, WORKSHEET })).toEqual([]);
    const all = JSON.stringify({ ROOM_COPY, WORKSHEET, THANK_YOU });
    expect(all).not.toMatch(/\bfree\b/i);
    expect(all).not.toMatch(/\blive\b/i);
  });
  it('polls are spaced through the session with the soft close last', () => {
    const ats = DEFAULT_POLLS.map((p) => p.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(DEFAULT_POLLS[DEFAULT_POLLS.length - 1].options[0].value).toMatch(/^yes/);
  });
});
