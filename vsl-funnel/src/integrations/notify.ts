import type { Runtime } from '../app';
import { BRAND, ECONOMICS } from '../config';
import type { Lead } from '../funnel/leads';
import type { Rep } from '../sales/reps';

/**
 * Team notifications to Slack and Discord (incoming webhooks).
 *
 *  - "alerts": hot leads, bookings, cancellations, call-starting pings, no-shows, losses, daily digest
 *  - "wins":   closed deals (falls back to the alerts channel when no wins channel is set)
 *
 * Reps with a Slack / Discord user id are @mentioned on their own leads and calls.
 */
export type NotifyChannel = 'alerts' | 'wins';
export type NotifyKind =
  | 'hot_lead' | 'qualified_lead' | 'booked' | 'cancelled' | 'call_soon' | 'showed' | 'no_show' | 'won' | 'lost' | 'digest' | 'voice' | 'test';

export interface NotifyMessage {
  kind: NotifyKind;
  title: string;
  lines?: string[];
  lead?: Lead | null;
  rep?: Rep | null;
  fields?: { name: string; value: string }[];
}

const COLORS: Record<NotifyKind, number> = {
  hot_lead: 0xf59e0b, qualified_lead: 0x3b82f6, booked: 0x2563eb, cancelled: 0x9ca3af, call_soon: 0x8b5cf6, showed: 0x10b981,
  no_show: 0xef4444, won: 0x16a34a, lost: 0x6b7280, digest: 0x0f2c5c, voice: 0x14b8a6, test: 0x0f2c5c,
};

const CHANNEL: Partial<Record<NotifyKind, NotifyChannel>> = { won: 'wins' };

export const money = (n: number) => `${ECONOMICS.currency === 'AUD' ? 'A$' : '$'}${Math.round(n).toLocaleString('en-AU')}`;
const leadName = (l: Lead) => [l.first_name, l.last_name].filter(Boolean).join(' ') || l.email || l.id;

function webhooks(rt: Runtime, channel: NotifyChannel) {
  const s = rt.settings;
  const slack = channel === 'wins' ? s.SLACK_WINS_WEBHOOK_URL || s.SLACK_WEBHOOK_URL : s.SLACK_WEBHOOK_URL;
  const discord = channel === 'wins' ? s.DISCORD_WINS_WEBHOOK_URL || s.DISCORD_WEBHOOK_URL : s.DISCORD_WEBHOOK_URL;
  return { slack, discord };
}

export const notifyConfigured = (rt: Runtime) => Boolean(rt.settings.SLACK_WEBHOOK_URL || rt.settings.DISCORD_WEBHOOK_URL || rt.settings.SLACK_WINS_WEBHOOK_URL || rt.settings.DISCORD_WINS_WEBHOOK_URL);

/** Standard lead context lines (tier, source, contact) shared by most alerts. */
export function leadLines(lead: Lead) {
  const tier = lead.tier_override ?? lead.tier;
  const source = [lead.channel ?? 'Direct', lead.utm_campaign, lead.utm_content].filter(Boolean).join(' / ');
  return [
    `Tier ${tier ?? '–'} · score ${lead.score ?? '–'} · ${lead.country ?? '??'} · ${source}`,
    [lead.email, lead.phone, `ref ${lead.ref_code}`].filter(Boolean).join(' · '),
  ];
}

/** Sends one message to every configured destination for its channel. Never throws. */
export async function notify(rt: Runtime, msg: NotifyMessage, channelOverride?: NotifyChannel) {
  const channel = channelOverride ?? CHANNEL[msg.kind] ?? 'alerts';
  const { slack, discord } = webhooks(rt, channel);
  if (!slack && !discord) return { slack: false, discord: false };
  const link = msg.lead ? `${rt.origin}/admin#lead=${msg.lead.id}` : `${rt.origin}/admin`;
  const lines = (msg.lines ?? []).filter(Boolean);
  const jobs: Promise<boolean>[] = [];

  if (slack) {
    const mention = msg.rep?.slack_user_id ? `<@${msg.rep.slack_user_id}> ` : '';
    const fields = (msg.fields ?? []).map((f) => `*${f.name}:* ${f.value}`);
    const text = [`${mention}*${msg.title}*`, ...lines, ...fields, `<${link}|Open in Funnel HQ>`].join('\n');
    jobs.push(post(slack, { text, unfurl_links: false }, 'slack'));
  }
  if (discord) {
    const mention = msg.rep?.discord_user_id ? `<@${msg.rep.discord_user_id}>` : undefined;
    jobs.push(post(discord, {
      username: rt.settings.SITE_NAME || BRAND.name,
      content: mention,
      allowed_mentions: { users: msg.rep?.discord_user_id ? [msg.rep.discord_user_id] : [] },
      embeds: [{
        title: msg.title.slice(0, 250),
        url: link,
        description: lines.join('\n').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1**$2**').slice(0, 4000) || undefined, // Slack *bold* → Discord **bold**
        color: COLORS[msg.kind],
        fields: (msg.fields ?? []).slice(0, 20).map((f) => ({ name: f.name.slice(0, 250), value: f.value.slice(0, 1000) || '–', inline: true })),
        timestamp: new Date().toISOString(),
      }],
    }, 'discord'));
  }
  const [a, b] = await Promise.all(jobs);
  return { slack: slack ? a : false, discord: discord ? (slack ? b : a) : false };
}

async function post(url: string, body: unknown, label: string) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) console.error(`${label} notify failed`, res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error(`${label} notify failed`, e);
    return false;
  }
}

/** Backwards-compatible helper used across the funnel: a lead alert with a headline and extra lines. */
export async function notifySlack(rt: Runtime, lead: Lead, headline: string, extra: string[] = [], kind: NotifyKind = 'hot_lead') {
  const rep = rt.reps.find((r) => r.id === lead.closer_id) ?? null;
  await notify(rt, { kind, title: `${headline} — ${leadName(lead)}`, lines: [...leadLines(lead), ...extra], lead, rep });
}

export { leadName };
