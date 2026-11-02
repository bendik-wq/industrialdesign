import type { Runtime } from '../app';
import { editionName } from '../webinar/editions';
import { INTEL_COPY, parseRoomEdition, showingLabel } from './intel';

/**
 * Simulive (area D): the automated webinar's room config when the edition is a recorded live session. The room
 * (webinar-room.js) already plays the recording in sync with the showing's clock, for everyone at the same second
 * and without seeking, and its chat already holds only the owners of that showing (plus the team, labelled, when
 * they drop in from the host console). This adds the honest label and the cards Josh shared live, at their moments.
 */
export async function simuliveConfig(rt: Pick<Runtime, 'settings'>, session: { starts_at: number }, replay: boolean, viewerTz?: string | null) {
  if (editionName(rt.settings) !== 'room') return null;
  const e = parseRoomEdition(rt.settings.WEBINAR_ROOM_EDITION);
  if (!e) return null;
  // The date the viewer would call it (their time zone when known).
  const tz = viewerTz || rt.settings.SALES_TIMEZONE || 'Australia/Sydney';
  let date = '';
  try { date = new Intl.DateTimeFormat('en-US', { timeZone: tz, day: 'numeric', month: 'long', year: 'numeric' }).format(e.recordedAt); } catch { date = new Date(e.recordedAt).toDateString(); }
  return {
    label: showingLabel(replay),
    note: INTEL_COPY.showingNote(date),
    recordedAt: e.recordedAt,
    startsAt: session.starts_at,
    durationSec: e.durationMin * 60,
    // Cards that make sense outside the live room: the application and the Sprint (the deposit and VIP belong to the live event).
    pushes: e.pushes.filter((p) => p.kind === 'application' || p.kind === 'sprint').map((p) => ({ at: p.atSec, kind: p.kind })),
    copy: {
      cardNote: INTEL_COPY.showingCardNote,
      applyCard: INTEL_COPY.applyCard, applyButton: INTEL_COPY.applyButton,
      sprintCard: INTEL_COPY.sprintCard, sprintButton: INTEL_COPY.sprintButton,
    },
  };
}
