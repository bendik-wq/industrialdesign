import type { Runtime } from '../app';
import type { Lead } from '../funnel/leads';

/** Posts a hot-lead / booking alert to Slack so a closer can act within minutes. */
export async function notifySlack(rt: Runtime, lead: Lead, headline: string, extra: string[] = []) {
  if (!rt.settings.SLACK_WEBHOOK_URL) return;
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || lead.id;
  const lines = [
    `*${headline}* — ${name}`,
    `Tier *${lead.tier_override ?? lead.tier ?? '–'}* · score ${lead.score ?? '–'} · ${lead.country ?? '??'} · ${lead.channel ?? 'Direct'}${lead.utm_campaign ? ` / ${lead.utm_campaign}` : ''}`,
    `${lead.email ?? ''}${lead.phone ? ` · ${lead.phone}` : ''} · ref ${lead.ref_code}`,
    ...extra,
    `<${rt.origin}/admin#lead=${lead.id}|Open in dashboard>`,
  ];
  const res = await fetch(rt.settings.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: lines.join('\n') }) });
  if (!res.ok) console.error('slack notify failed', res.status);
}
