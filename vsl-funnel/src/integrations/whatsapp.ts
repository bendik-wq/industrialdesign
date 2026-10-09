import type { Runtime } from '../app';
import { hmacHex, safeEqual } from '../lib/crypto';
import { REF_CODE_RE, newId } from '../lib/ids';
import type { Lead } from '../funnel/leads';
import { effectiveTier, getLeadByRef, updateLead } from '../funnel/leads';
import type { Settings } from '../settings';
import { identityFromLead, track } from '../tracking/track';
import { META_API_VERSION } from '../tracking/forward';

/**
 * Click-to-chat link to Josh's WhatsApp. The prefilled message carries the
 * lead's ref code, so when the chat arrives (and with the Cloud API webhook
 * connected, automatically) it can be matched back to the lead record.
 */
export type WhatsAppIntent = 'question' | 'resources' | 'booked';

const ASK: Record<WhatsAppIntent, string> = {
  question: 'I just watched the video and have a question.',
  resources: "I'd love the acquisition starter resources.",
  booked: "I've booked my strategy call and wanted to say hi.",
};

/** Works out the prefilled message from where the click came from (e.g. "resources-page", "email-booked_confirm"). */
export function intentFromSource(src: string, lead: Pick<Lead, 'booked_at'> | null): WhatsAppIntent {
  if (/resources|c_/.test(src)) return 'resources';
  if (/booked|precall|call_/.test(src) || lead?.booked_at) return 'booked';
  return 'question';
}

/**
 * Josh's WhatsApp is only offered to qualified (A or B tier) leads who have a
 * call booked — never to anonymous visitors, C-tier, or anyone who hasn't booked.
 */
export const whatsappEligible = (lead: Pick<Lead, 'tier' | 'tier_override' | 'booked_at' | 'booking_cancelled_at'> | null) => {
  const tier = lead ? effectiveTier(lead) : null;
  return (tier === 'A' || tier === 'B') && Boolean(lead?.booked_at) && !lead?.booking_cancelled_at;
};

export function whatsappLink(settings: Settings, lead: Pick<Lead, 'first_name' | 'ref_code' | 'tier' | 'tier_override' | 'booked_at' | 'booking_cancelled_at'> | null, intent: WhatsAppIntent): string | null {
  const number = settings.JOSH_WHATSAPP.replace(/\D/g, '');
  if (!number || !whatsappEligible(lead)) return null;
  const intro = lead?.first_name ? `Hi Josh, it's ${lead.first_name}.` : 'Hi Josh!';
  const ask = ASK[intent];
  const ref = lead?.ref_code ? ` (ref ${lead.ref_code})` : '';
  return `https://wa.me/${number}?text=${encodeURIComponent(`${intro} ${ask}${ref}`)}`;
}

export const cloudApiConfigured = (s: Settings) => Boolean(s.WHATSAPP_TOKEN && s.WHATSAPP_PHONE_NUMBER_ID);

/**
 * Sends the approved "resources" template via the WhatsApp Cloud API to a
 * lead who opted in. Business-initiated messages must use a pre-approved
 * template; the template gets the lead's first name and resources link.
 */
export async function sendResourcesTemplate(rt: Runtime, lead: Lead) {
  const s = rt.settings;
  if (!cloudApiConfigured(s) || !s.WHATSAPP_RESOURCES_TEMPLATE || !lead.phone || !lead.whatsapp_opt_in || !whatsappEligible(lead)) return false;
  const to = lead.phone.replace(/\D/g, '');
  const res = await fetch(`https://graph.facebook.com/${META_API_VERSION}/${s.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: s.WHATSAPP_RESOURCES_TEMPLATE,
        language: { code: 'en' },
        components: [{ type: 'body', parameters: [{ type: 'text', text: lead.first_name || 'there' }, { type: 'text', text: `${rt.origin}/resources?l=${lead.ref_code}` }] }],
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message: string } };
  await rt.env.DB.prepare('INSERT INTO whatsapp_messages (id, ts, lead_id, direction, wa_id, template, status, provider_id, body) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(newId('w'), Date.now(), lead.id, 'out', to, s.WHATSAPP_RESOURCES_TEMPLATE, res.ok ? 'sent' : 'failed', body.messages?.[0]?.id ?? null, res.ok ? null : body.error?.message ?? `HTTP ${res.status}`)
    .run();
  if (res.ok) await track(rt, await identityFromLead(rt.env, lead.id), { name: 'whatsapp_sent', source: 'server', props: { template: s.WHATSAPP_RESOURCES_TEMPLATE } });
  return res.ok;
}

/** Verifies Meta's X-Hub-Signature-256 header. */
export async function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null) {
  if (!header?.startsWith('sha256=')) return false;
  return safeEqual(await hmacHex(appSecret, rawBody), header.slice(7));
}

interface WaWebhook {
  entry?: { changes?: { value?: { contacts?: { wa_id: string; profile?: { name?: string } }[]; messages?: { from: string; id: string; timestamp: string; type: string; text?: { body: string } }[] } }[] }[];
}

/** Inbound messages: store them and, when a ref code is present, mark the lead as connected on WhatsApp. */
export async function handleInbound(rt: Runtime, payload: WaWebhook) {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const msg of change.value?.messages ?? []) {
        const body = msg.text?.body ?? `[${msg.type}]`;
        const ref = body.toUpperCase().match(REF_CODE_RE)?.[1];
        let lead = ref ? await getLeadByRef(rt.env, ref) : null;
        if (!lead) {
          lead = await rt.env.DB.prepare("SELECT * FROM leads WHERE whatsapp_wa_id = ? OR replace(phone, '+', '') = ? LIMIT 1").bind(msg.from, msg.from).first<Lead>();
        }
        await rt.env.DB.prepare('INSERT OR IGNORE INTO whatsapp_messages (id, ts, lead_id, direction, wa_id, body, status, provider_id) VALUES (?,?,?,?,?,?,?,?)')
          .bind(newId('w'), Number(msg.timestamp) * 1000 || Date.now(), lead?.id ?? null, 'in', msg.from, body.slice(0, 4000), 'received', msg.id)
          .run();
        if (!lead) continue;
        const firstConnect = !lead.whatsapp_connected_at;
        await updateLead(rt.env, lead.id, { whatsapp_connected_at: lead.whatsapp_connected_at ?? Date.now(), whatsapp_wa_id: msg.from });
        const who = await identityFromLead(rt.env, lead.id);
        await track(rt, who, { name: firstConnect ? 'whatsapp_connected' : 'whatsapp_inbound', source: 'webhook', props: { wa_id: msg.from, matched_by: ref ? 'ref_code' : 'phone' } });
      }
    }
  }
}
