import type { Runtime } from '../app';
import { APPLICATION } from '../config';
import { defang } from '../lib/text';
import { clip, type ResearchItemInput } from './sources';

/**
 * Voice of customer from our own D1: application answers, booking-form answers, call outcomes and notes,
 * masterclass questions and chat. The strongest signal, because these are people who raised their hand.
 * Contact details are stripped from every excerpt; each row links to the lead in Funnel HQ.
 */
const YEAR = 365 * 86400_000;
const leadLink = (id: string) => `/admin#lead=${encodeURIComponent(id)}`;
const clean = (s: unknown, max = 1200) => clip(defang(String(s ?? '')), max);

const LABELS = new Map<string, Map<string, string>>();
for (const q of APPLICATION) if (q.type === 'single' || q.type === 'multi') LABELS.set(q.id, new Map(q.options.map((o) => [o.value, o.label])));
export const answerLabel = (q: string, v: string) => LABELS.get(q)?.get(v) ?? v;

/** Structured counts that need no AI: what held applicants back, their goal, and the objections logged on calls. */
export async function vocCounts(rt: Runtime, now = Date.now()) {
  const since = now - YEAR;
  const { results: leads } = await rt.env.DB.prepare('SELECT answers, objection, lost_reason FROM leads WHERE created_at > ? AND (app_completed_at IS NOT NULL OR objection IS NOT NULL) LIMIT 5000').bind(since).all<{ answers: string; objection: string | null; lost_reason: string | null }>();
  const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const blockers = new Map<string, number>(), goals = new Map<string, number>(), objections = new Map<string, number>();
  let applicants = 0;
  for (const l of leads) {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(l.answers || '{}'); } catch { /* skip */ }
    if (Object.keys(a).length) applicants++;
    for (const b of Array.isArray(a.blockers) ? a.blockers : []) tally(blockers, answerLabel('blockers', String(b)));
    if (typeof a.goal === 'string') tally(goals, answerLabel('goal', a.goal));
    if (l.objection) tally(objections, l.objection);
  }
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((x, y) => y[1] - x[1]).map(([label, count]) => ({ label, count }));
  return { applicants, blockers: sorted(blockers), goals: sorted(goals), objections: sorted(objections) };
}

/** Free-text voice of customer as research items (upserted, so re-running only refreshes). */
export async function collectVoc(rt: Runtime, now = Date.now()): Promise<ResearchItemInput[]> {
  const since = now - YEAR;
  const out: ResearchItemInput[] = [];
  const base = (id: string, kind: string, community: string, body: string | null, at: number | null, leadId: string | null, band: string | null = null): ResearchItemInput => ({
    id: `voc:${id}`, source: 'voc', kind, external_id: id, url: leadId ? leadLink(leadId) : null, title: null, body, community, query: null,
    score: 0, comments: 0, published_at: at, lead_id: leadId, revenue_band: band,
  });

  const { results: leads } = await rt.env.DB.prepare(
    `SELECT id, answers, booking_answers, objection, lost_reason, notes, revenue_band, created_at, app_completed_at, updated_at
       FROM leads WHERE created_at > ? AND (app_completed_at IS NOT NULL OR booking_answers IS NOT NULL OR objection IS NOT NULL OR lost_reason IS NOT NULL OR notes IS NOT NULL)
      ORDER BY created_at DESC LIMIT 1500`,
  ).bind(since).all<{ id: string; answers: string; booking_answers: string | null; objection: string | null; lost_reason: string | null; notes: string | null; revenue_band: string | null; created_at: number; app_completed_at: number | null; updated_at: number }>();
  for (const l of leads) {
    let a: Record<string, unknown> = {};
    try { a = JSON.parse(l.answers || '{}'); } catch { /* skip */ }
    const why = typeof a.why_now === 'string' ? a.why_now.trim() : '';
    const blockers = (Array.isArray(a.blockers) ? a.blockers : []).map((b) => answerLabel('blockers', String(b)));
    if (why.length >= 15 || blockers.length) {
      const parts = [why, blockers.length ? `Held back by: ${blockers.join('; ')}` : ''].filter(Boolean);
      out.push(base(`app:${l.id}`, 'application', 'Application', clean(parts.join(' | ')), l.app_completed_at ?? l.created_at, l.id, l.revenue_band));
    }
    let booking: { q: string; a: string }[] = [];
    try { booking = JSON.parse(l.booking_answers || '[]'); } catch { /* skip */ }
    const said = (Array.isArray(booking) ? booking : []).filter((x) => x && typeof x.a === 'string' && x.a.trim().length >= 15 && !/email|phone|name|website|linkedin/i.test(String(x.q)));
    if (said.length) out.push(base(`book:${l.id}`, 'booking', 'Booking form', clean(said.map((x) => `${clip(x.q, 80)}: ${x.a}`).join(' | ')), l.created_at, l.id, l.revenue_band));
    if (l.objection || l.lost_reason || (l.notes && l.notes.trim().length >= 15)) {
      const parts = [l.objection ? `Objection: ${l.objection}` : '', l.lost_reason ? `Lost because: ${l.lost_reason}` : '', l.notes ? `Notes: ${l.notes}` : ''].filter(Boolean);
      out.push(base(`call:${l.id}`, l.notes ? 'call_note' : 'objection', 'Call notes', clean(parts.join(' | ')), l.updated_at, l.id, l.revenue_band));
    }
  }

  const { results: cal } = await rt.env.DB.prepare('SELECT invitee_uri, answers, booked_at, start_at FROM calendly_bookings WHERE lead_id IS NULL AND answers IS NOT NULL AND start_at > ? LIMIT 500')
    .bind(since).all<{ invitee_uri: string; answers: string; booked_at: number | null; start_at: number }>().catch(() => ({ results: [] as { invitee_uri: string; answers: string; booked_at: number | null; start_at: number }[] }));
  for (const c of cal) {
    let ans: { q: string; a: string }[] = [];
    try { ans = JSON.parse(c.answers || '[]'); } catch { /* skip */ }
    const said = (Array.isArray(ans) ? ans : []).filter((x) => x && typeof x.a === 'string' && x.a.trim().length >= 15 && !/email|phone|name|website|linkedin/i.test(String(x.q)));
    if (said.length) out.push(base(`cal:${c.invitee_uri.split('/').pop()}`, 'booking', 'Booking form', clean(said.map((x) => `${clip(x.q, 80)}: ${x.a}`).join(' | ')), c.booked_at ?? c.start_at, null));
  }

  const { results: qs } = await rt.env.DB.prepare("SELECT id, lead_id, value, created_at FROM webinar_interactions WHERE kind = 'question' AND created_at > ? ORDER BY created_at DESC LIMIT 500")
    .bind(since).all<{ id: string; lead_id: string; value: string | null; created_at: number }>().catch(() => ({ results: [] as { id: string; lead_id: string; value: string | null; created_at: number }[] }));
  for (const q of qs) if ((q.value ?? '').trim().length >= 10) out.push(base(`wq:${q.id}`, 'webinar_question', 'Masterclass question', clean(q.value, 600), q.created_at, q.lead_id));

  const { results: chat } = await rt.env.DB.prepare("SELECT id, lead_id, body, created_at FROM webinar_chat WHERE author = 'viewer' AND deleted_at IS NULL AND length(body) >= 25 AND created_at > ? ORDER BY created_at DESC LIMIT 500")
    .bind(since).all<{ id: number; lead_id: string | null; body: string; created_at: number }>().catch(() => ({ results: [] as { id: number; lead_id: string | null; body: string; created_at: number }[] }));
  for (const m of chat) out.push(base(`wc:${m.id}`, 'webinar_chat', 'Masterclass chat', clean(m.body, 600), m.created_at, m.lead_id));

  return out;
}
