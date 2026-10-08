import type { Env } from '../env';
import type { Route, Tier } from '../config';

export interface Lead {
  id: string;
  ref_code: string;
  created_at: number;
  updated_at: number;
  visitor_id: string | null;
  session_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp_opt_in: number;
  answers: string;
  step_reached: number;
  app_started_at: number | null;
  app_completed_at: number | null;
  score: number | null;
  score_breakdown: string | null;
  tier: Tier | null;
  tier_override: Tier | null;
  route: Route | null;
  closer_id: string | null;
  status: LeadStatus;
  booked_at: number | null;
  call_at: number | null;
  booking_provider: string | null;
  booking_ref: string | null;
  booking_cancelled_at: number | null;
  whatsapp_clicked_at: number | null;
  whatsapp_connected_at: number | null;
  whatsapp_wa_id: string | null;
  unsubscribed_at: number | null;
  revenue: number;
  notes: string | null;
  channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  click_id: string | null;
  click_type: string | null;
  ft_channel: string | null;
  ft_source: string | null;
  ft_campaign: string | null;
  ft_content: string | null;
  landing_path: string | null;
  variant: string | null;
  country: string | null;
  city: string | null;
  device: string | null;
  fbp: string | null;
  fbc: string | null;
}

export const LEAD_STATUSES = ['partial', 'applied', 'booked', 'showed', 'no_show', 'won', 'lost', 'nurture', 'disqualified'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Effective tier: a manual override from the dashboard beats the computed one. */
export const effectiveTier = (l: Pick<Lead, 'tier' | 'tier_override'>): Tier | null => l.tier_override ?? l.tier;

export const getLead = (env: Env, id: string) => env.DB.prepare('SELECT * FROM leads WHERE id = ?').bind(id).first<Lead>();
export const getLeadByEmail = (env: Env, email: string) => env.DB.prepare('SELECT * FROM leads WHERE email = ?').bind(email.toLowerCase()).first<Lead>();
export const getLeadByRef = (env: Env, ref: string) => env.DB.prepare('SELECT * FROM leads WHERE ref_code = ?').bind(ref.toUpperCase()).first<Lead>();

export function parseAnswers(l: Pick<Lead, 'answers'>): Record<string, string | string[]> {
  try {
    return JSON.parse(l.answers || '{}');
  } catch {
    return {};
  }
}

/** Ties the current browser to a lead (identity stitching across devices via email links). */
export async function linkVisitor(env: Env, visitorId: string, leadId: string) {
  await env.DB.batch([
    env.DB.prepare('UPDATE visitors SET lead_id = ? WHERE id = ?').bind(leadId, visitorId),
    // Back-fill the lead onto this visitor's anonymous history so the timeline is complete.
    env.DB.prepare('UPDATE events SET lead_id = ? WHERE visitor_id = ? AND lead_id IS NULL').bind(leadId, visitorId),
    env.DB.prepare('UPDATE vsl_views SET lead_id = ? WHERE visitor_id = ? AND lead_id IS NULL').bind(leadId, visitorId),
  ]);
}

export async function updateLead(env: Env, id: string, fields: Partial<Record<keyof Lead, string | number | null>>) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await env.DB.prepare(`UPDATE leads SET ${sets}, updated_at = ? WHERE id = ?`).bind(...keys.map((k) => fields[k as keyof Lead] ?? null), Date.now(), id).run();
}

const DISPOSABLE = /@(mailinator|guerrillamail|10minutemail|tempmail|temp-mail|yopmail|trashmail|sharklasers|getnada|maildrop|dispostable|fakeinbox|throwawaymail)\./i;

export function validateEmail(raw: unknown): { email: string; disposable: boolean } | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return null;
  return { email, disposable: DISPOSABLE.test(email) };
}

const DIAL: Record<string, string> = { AU: '61', NZ: '64', US: '1', CA: '1', GB: '44', IE: '353', SG: '65', AE: '971', ZA: '27', IN: '91' };

/** Normalises to E.164 (+61412345678). Local numbers get the visitor's country code. */
export function normalisePhone(raw: unknown, country: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else {
    const dial = country ? DIAL[country] : undefined;
    if (dial && digits.startsWith('0')) digits = dial + digits.slice(1);
    else if (dial && digits.length <= 10 && !digits.startsWith(dial)) digits = dial + digits;
  }
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export const cleanName = (raw: unknown, max = 60) => (typeof raw === 'string' ? raw.replace(/[<>]/g, '').trim().slice(0, max) || null : null);
