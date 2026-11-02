import { describe, expect, it } from 'vitest';
import { auditCopy } from '../src/content/copy-rules';
import { ENGAGE_COPY } from '../src/rooms/engage';
import { DEFAULT_AUTO_PUSH, type Identity, apply, autoPushDue, join, newEngage, newRoomState, parseAutoPush, view } from '../src/rooms/state';

const T0 = Date.parse('2026-11-03T18:00:00Z');
const MIN = 60_000;
const host: Identity = { id: 'hadmin', name: 'Josh', role: 'host' };
const ann: Identity = { id: 'rann', name: 'Ann B.', role: 'attendee', leadId: 'l1', regId: 'r1' };

function room(schedule = DEFAULT_AUTO_PUSH, live = true) {
  const st = newRoomState({ id: 'rmauto12345', mode: 'webinar', title: 'Live', startsAt: T0, offerAvailable: true });
  st.eng = newEngage({ avail: { application: true, sprint: true, deposit: true, vip: false, resources: ['scripts'] } });
  st.eng.auto = parseAutoPush(schedule);
  for (const w of [host, ann]) join(st, w, T0);
  if (live) { st.status = 'live'; st.wentLiveAt = T0; }
  return st;
}

describe('automatic pushes', () => {
  it('parses one push per line, ignores junk, sorts by minute and turns off with "off"', () => {
    expect(parseAutoPush(DEFAULT_AUTO_PUSH).map((x) => [x.at, x.kind])).toEqual([[35, 'application'], [45, 'sprint']]);
    expect(parseAutoPush('45 sprint\n20 min: resource scripts\nnonsense\n10 resource\n35 application, 35 application')
      .map((x) => x.id)).toEqual(['20:resource:scripts', '35:application', '45:sprint']);
    expect(parseAutoPush('off')).toEqual([]);
    expect(parseAutoPush('')).toEqual([]);
  });

  it('fires each push once at its minute after Go live, to everyone, and the attendee gets the card', () => {
    const st = room();
    expect(autoPushDue(st, T0 + 34 * MIN).effects).toHaveLength(0);
    const r = autoPushDue(st, T0 + 35 * MIN);
    expect(r.effects).toEqual([{ type: 'pushed', push: expect.objectContaining({ kind: 'application', to: null, by: 'auto' }) }]);
    expect(autoPushDue(st, T0 + 36 * MIN).effects).toHaveLength(0); // once only
    expect(view(st, st.members.rann, T0 + 36 * MIN).eng!.pushes.map((p) => p.kind)).toEqual(['application']);
    expect(autoPushDue(st, T0 + 50 * MIN).effects.map((e) => (e as { push: { kind: string } }).push.kind)).toEqual(['sprint']);
    const auto = view(st, st.members.hadmin, T0 + 50 * MIN).eng!.auto as { id: string; done: { how: string } | null }[];
    expect(auto.map((x) => x.done?.how)).toEqual(['auto', 'auto']);
  });

  it('does nothing before Go live or in a meeting', () => {
    expect(autoPushDue(room(DEFAULT_AUTO_PUSH, false), T0 + 90 * MIN).effects).toHaveLength(0);
    const m = room(); m.mode = 'meeting';
    expect(autoPushDue(m, T0 + 90 * MIN).effects).toHaveLength(0);
  });

  it('the deposit waits for the offer to open; a push the room can’t make is marked, not retried', () => {
    const st = room('5 deposit\n6 vip');
    st.offer = { available: true, open: false, closesAt: null, label: 'Deposit' };
    expect(autoPushDue(st, T0 + 10 * MIN).effects).toHaveLength(0);
    expect(st.eng!.autoDone!.map((d) => [d.id, d.how])).toEqual([['6:vip', 'unavailable']]);
    st.offer.open = true;
    expect(autoPushDue(st, T0 + 11 * MIN).effects).toHaveLength(1);
  });

  it('the host can skip one or push it early; attendees can’t', () => {
    const st = room();
    expect(apply(st, 'rann', { t: 'autopush_skip', id: '35:application' }, T0).error).toBe('forbidden');
    expect(apply(st, 'hadmin', { t: 'autopush_skip', id: '35:application' }, T0).ok).toBe(true);
    const now = apply(st, 'hadmin', { t: 'autopush_now', id: '45:sprint' }, T0 + MIN);
    expect(now.effects[0]).toMatchObject({ type: 'pushed', push: { kind: 'sprint' } });
    expect(apply(st, 'hadmin', { t: 'autopush_now', id: '45:sprint' }, T0 + MIN).error).toBe('autopush_done');
    expect(autoPushDue(st, T0 + 60 * MIN).effects).toHaveLength(0);
  });

  it('copy passes the house rules', () => {
    const keys = Object.keys(ENGAGE_COPY).filter((k) => k.startsWith('auto'));
    expect(keys.length).toBeGreaterThan(5);
    for (const k of keys) expect(auditCopy(String((ENGAGE_COPY as Record<string, unknown>)[k]))).toEqual([]);
  });
});
