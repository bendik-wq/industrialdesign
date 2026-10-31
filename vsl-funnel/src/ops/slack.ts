import type { Runtime } from '../app';
import { BRAND } from '../config';
import { plain } from '../integrations/notify';

/**
 * Command messages to Slack (and Discord when connected): the brief, alerts, routine results, approvals.
 * Lines may hold campaign names and other text that came from strangers (UTMs), so every line is stripped of
 * link and mention syntax; only the one link we add (into Funnel HQ) is a real link.
 */
export function opsWebhooks(rt: Runtime) {
  const s = rt.settings as Partial<Record<string, string>>;
  return { slack: s.OPS_SLACK_WEBHOOK_URL || s.SLACK_WEBHOOK_URL || '', discord: s.DISCORD_WEBHOOK_URL || '' };
}
export const opsSlackConfigured = (rt: Runtime) => { const w = opsWebhooks(rt); return Boolean(w.slack || w.discord); };

/** Markdown links [label](/admin#x) become plain "label"; Slack gets one real link at the end. */
const unlink = (s: string) => s.replace(/\[([^\]]+)\]\((?:\/admin[^)]*|https?:\/\/[^)]*)\)/g, '$1');
/** Our own **bold** → Slack *bold*. */
const bold = (s: string) => s.replace(/\*\*([^*\n]+)\*\*/g, '*$1*');

export async function postOps(rt: Runtime, msg: { title: string; lines: string[]; path?: string; linkText?: string }, fetcher: typeof fetch = fetch) {
  const { slack, discord } = opsWebhooks(rt);
  if (!slack && !discord) return { slack: false, discord: false };
  const url = `${rt.origin}${msg.path ?? '/admin#command'}`;
  const title = plain(unlink(msg.title));
  const lines = msg.lines.map((l) => bold(plain(unlink(l)))).filter(Boolean);
  const out = { slack: false, discord: false };
  const post = async (to: string, body: unknown) => {
    try { const r = await fetcher(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.ok; } catch (e) { console.error('ops slack', e); return false; }
  };
  if (slack) out.slack = await post(slack, { text: [`*${title}*`, ...lines, `<${url}|${msg.linkText ?? 'Open Command in Funnel HQ'}>`].join('\n').slice(0, 3900), unfurl_links: false });
  if (discord) out.discord = await post(discord, { username: rt.settings.SITE_NAME || BRAND.name, allowed_mentions: { parse: [] }, embeds: [{ title: title.slice(0, 250), url, description: lines.join('\n').replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1**$2**').slice(0, 4000), color: 0x0f2c5c }] });
  return out;
}
