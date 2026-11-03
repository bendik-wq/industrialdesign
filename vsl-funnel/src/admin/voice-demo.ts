/**
 * Funnel HQ → "Talk to an agent": a live, in-browser conversation with the real ElevenLabs phone agents, playing a sample
 * lead. Nobody is called and nothing is sent: every session carries demo=yes, and the post-call webhook skips it
 * (see isDemoConversation). Admin only; the API key never reaches the browser (we hand it a short-lived signed URL).
 */
import { Hono } from 'hono';
import { type AppEnv, type Runtime, runtimeFrom } from '../app';
import { el } from '../integrations/elevenlabs';
import type { Settings } from '../settings';
import { nextActionVars } from '../integrations/sales-playbook';

export interface DemoScenario {
  id: string;
  label: string;
  blurb: string;
  agent: 'outbound' | 'inbound' | 'webinar';
  you: string;
  vars: (s: Settings, rt?: Runtime) => Record<string, string> | Promise<Record<string, string>>;
}

const HOUR = 3_600_000;
/** A sample live event and lead, run through the real webinar-call builder so the demo hears exactly what a real call gets. */
async function webinarVars(rt: Runtime, kind: 'w_pre_welcome' | 'w_pre_day' | 'w_post_nobuy') {
  const W = await import('../integrations/webinar-calls');
  const now = Date.now(), after = kind === 'w_post_nobuy';
  const startsAt = after ? now - 20 * HOUR : kind === 'w_pre_welcome' ? now + 3 * 24 * HOUR : now + 24 * HOUR;
  const ctx = {
    funnel: 'live', regId: 'demo', leadId: 'demo', token: 'demo', day: null, title: 'Buy your first competitor',
    startsAt, endsAt: startsAt + 2 * HOUR, cancelled: false, regCreatedAt: now - 3 * 24 * HOUR, ticketPending: false,
    joinedAt: after ? startsAt + 5 * 60_000 : null, lastSeenAt: after ? startsAt + 110 * 60_000 : null, replayWatchedAt: null, replayClosesAt: after ? now + 28 * HOUR : null,
    offer: { name: 'Engagement deposit', relevant: true, opened: after, open: after, closesAt: after ? now + 28 * HOUR : null, openedAt: after ? startsAt + 80 * 60_000 : null },
    bought: { sprint: false, deposit: false, vip: false },
    links: { join: 'https://live.grosfjeld-li.com', replay: null, offer: null }, host: 'live.grosfjeld-li.com',
    prep: 'a pen and paper, and last year’s revenue and profit to hand',
  } as unknown as Parameters<typeof W.callVariables>[3];
  const lead = { id: 'demo', first_name: 'Dana', phone: '+61412345678', timezone: 'Australia/Brisbane', country: 'AU' } as unknown as Parameters<typeof W.callVariables>[2];
  return { ...(await W.callVariables(rt, kind, lead, ctx, null, {}, 1, now)), demo: 'yes' };
}

const base = (s: Settings) => ({
  closer_name: 'Josh’s team',
  callback_number: s.AI_CALL_CALLBACK_NUMBER || 'the number that called you',
  lead_ref: 'DEMO',
  demo: 'yes',
  known_pain: 'not known yet: ask.',
});

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    id: 'confirm', label: 'Appointment confirmation', agent: 'outbound',
    blurb: 'Sam calls a lead who just booked a strategy call for Thursday at 10:00 AM.',
    you: 'You are Dana, who owns an HVAC business in Brisbane. Try: “I can’t find any deals worth buying”, “Do I need my own money to buy a business?”, “My partner handles the money” or “Can we move it to Friday?” Listen for Sam selling you on showing up prepared, and offering one guide.',
    vars: (s) => ({ ...base(s), ...nextActionVars('confirm'), first_name: 'Dana', business: 'HVAC services company in Brisbane', tier: 'A', email: 'dana@example.com', call_kind: 'confirm', call_time: 'Thursday at 10:00 AM', voicemail_reason: 'your strategy call', opening: 'I’m calling about the strategy call you just booked for Thursday at 10:00 AM. Have you got thirty seconds?' }),
  },
  {
    id: 'speed', label: 'Speed to lead', agent: 'outbound',
    blurb: 'Sam calls minutes after someone applied, before they have booked.',
    you: 'You are Mark, who owns a plumbing business in Austin. Try: “Banks won’t lend to me”, “I’m scared of overpaying”, “Is this a robot?”, “How much does it cost?” or “Just email me.” Sam should ask about your challenge, offer one guide, and ask you to book.',
    vars: (s) => ({ ...base(s), ...nextActionVars('speed_to_lead'), first_name: 'Mark', business: 'plumbing business in Austin', tier: 'B', email: 'mark@example.com', call_kind: 'speed_to_lead', call_time: 'the time you picked', voicemail_reason: 'your application', opening: 'I saw your application come through a few minutes ago. Have you got a minute?' }),
  },
  {
    id: 'rebook', label: 'Missed call, rebook', agent: 'outbound',
    blurb: 'Sam calls someone who missed their strategy call to offer a new time.',
    you: 'You are Priya, who owns a dental clinic group in Melbourne. Try: “Sorry, something came up”, “I’m already flat out running one business” or “I’m not interested any more.” Sam should rebook warmly and respect a clear no after one check.',
    vars: (s) => ({ ...base(s), ...nextActionVars('rebook'), first_name: 'Priya', business: 'dental clinic group in Melbourne', tier: 'A', email: 'priya@example.com', call_kind: 'rebook', call_time: 'yesterday at 2:00 PM', voicemail_reason: 'finding you a new time for your strategy call', opening: 'We missed you on your strategy call, so I’m calling to see if you’d like a new time. Have you got thirty seconds?' }),
  },
  {
    id: 'webinar_welcome', label: 'Webinar: welcome after registering', agent: 'webinar',
    blurb: 'Sam calls someone who just registered for a live session in three days.',
    you: 'You are Dana from Brisbane. Try: “What should I bring?”, “My question is how sellers get paid” or “We’re stuck at five million and need more locations.” Sam should get your yes to attend, ask you to add the invite and ask for your question.',
    vars: (_s, rt) => webinarVars(rt!, 'w_pre_welcome'),
  },
  {
    id: 'webinar_pre', label: 'Webinar: day-before reminder', agent: 'webinar',
    blurb: 'Sam calls someone registered for tomorrow’s live session, “Buy your first competitor”.',
    you: 'You are Dana from Brisbane. Try: “I can’t make it after all”, “I don’t want to put my house on the line”, “What should I have ready?” or “Can you send me the link?”',
    vars: (_s, rt) => webinarVars(rt!, 'w_pre_day'),
  },
  {
    id: 'webinar_nobuy', label: 'Webinar: attended, didn’t buy', agent: 'webinar',
    blurb: 'Sam calls the day after the live session. The engagement deposit offer is still open (a sample close time).',
    you: 'You are Dana. Try: “What does the deposit get me?”, “Is it refundable?”, “I need to think about it”, “I don’t have time to run two businesses” or “No, not for me.” Sam should find the real objection, answer from the facts, offer the offer link once, and accept a clear no.',
    vars: (_s, rt) => webinarVars(rt!, 'w_post_nobuy'),
  },
  {
    id: 'callback', label: 'Someone rings us back', agent: 'inbound',
    blurb: 'You ring the number back after a missed call. Sam doesn’t know who you are.',
    you: 'Try: “Who is this?”, “What do you do?”, “Can I speak to Josh?”, “How does the funding work?” or “I own a $2M physio clinic and can’t find anything to buy.” Sam should qualify you lightly and point you to the application.',
    vars: () => ({ first_name: '', greeting_name: '', known: 'no', status: '', tier: '', call_time: '', closer_name: 'Josh’s team', business: '', email: '', opening: 'How can I help today?', ...nextActionVars('inbound_unknown'), known_pain: 'not known yet: ask.', demo: 'yes' }),
  },
];

/** True for conversations started from this page: the post-call webhook ignores them (no records, emails or pings). */
export function isDemoConversation(data: unknown) {
  const d = data as { conversation_initiation_client_data?: { dynamic_variables?: Record<string, unknown> } } | undefined;
  return d?.conversation_initiation_client_data?.dynamic_variables?.demo === 'yes';
}

export const voiceDemoApi = new Hono<AppEnv>();

voiceDemoApi.get('/scenarios', (c) => c.json({ scenarios: DEMO_SCENARIOS.map(({ id, label, blurb, you }) => ({ id, label, blurb, you })) }));

voiceDemoApi.post('/session', async (c) => {
  const rt = runtimeFrom(c);
  const s = rt.settings;
  const b = await c.req.json<{ scenario?: string; sandbox?: { q?: unknown; id?: unknown } }>().catch(() => ({} as { scenario?: string; sandbox?: { q?: unknown; id?: unknown } }));
  // From Funnel HQ → Sandbox: one call of the simulation, its variables rebuilt here on the server from the spec.
  let sc: Pick<DemoScenario, 'agent' | 'label' | 'vars'> | undefined = DEMO_SCENARIOS.find((x) => x.id === b.scenario);
  if (!sc && b.sandbox && typeof b.sandbox === 'object') {
    const S = await import('./sandbox');
    const call = await S.sandboxCallSession(rt, S.cleanInput(b.sandbox.q), String(b.sandbox.id ?? '').slice(0, 80)).catch(() => null);
    if (call) sc = { agent: call.agent, label: call.label, vars: () => ({ ...call.vars, demo: 'yes' }) };
  }
  if (!sc) return c.json({ ok: false, error: 'Pick a scenario.' }, 400);
  if (!s.ELEVENLABS_API_KEY) return c.json({ ok: false, error: 'Add the ElevenLabs API key under Integrations → Voice first.' }, 400);
  try {
    const agentId = sc.agent === 'inbound' ? s.ELEVENLABS_INBOUND_AGENT_ID : sc.agent === 'webinar' ? await webinarAgentId(s) : s.ELEVENLABS_AGENT_ID;
    if (!agentId) return c.json({ ok: false, error: 'That agent hasn’t been created yet (AI phone calls → Create / update agent).' }, 400);
    const r = await el<{ signed_url: string }>(s, `/v1/convai/conversation/get-signed-url?agent_id=${encodeURIComponent(agentId)}`);
    c.header('cache-control', 'no-store');
    return c.json({ ok: true, signedUrl: r.signed_url, dynamicVariables: await sc.vars(s, rt), label: sc.label });
  } catch (e) {
    console.error('voice demo session', e instanceof Error ? e.message.slice(0, 200) : e);
    const auth = e instanceof Error && /\b40[13]\b/.test(e.message);
    return c.json({ ok: false, error: auth ? 'ElevenLabs refused the API key. Check it under Integrations → Voice.' : 'ElevenLabs didn’t start the session. Try again in a moment.' }, 502);
  }
});

/** The webinar agent: the saved ID, else the agent ElevenLabs has under our name (it exists before the ID is saved). */
async function webinarAgentId(s: Settings) {
  if (String(s.ELEVENLABS_WEBINAR_AGENT_ID ?? '').trim()) return String(s.ELEVENLABS_WEBINAR_AGENT_ID).trim();
  const r = await el<{ agents?: { agent_id: string; name: string }[] }>(s, `/v1/convai/agents?page_size=30&search=${encodeURIComponent('webinar calls')}`);
  return r.agents?.find((a) => /webinar calls/i.test(a.name))?.agent_id ?? '';
}

/** The page itself (admin only). Its own CSP: our scripts, the microphone, and the ElevenLabs connection; nothing else. */
export const VOICE_DEMO_CSP = "default-src 'self'; script-src 'self' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' wss://api.elevenlabs.io https://api.elevenlabs.io wss://livekit.rtc.elevenlabs.io https://livekit.rtc.elevenlabs.io; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export function voiceDemoPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Talk to an agent · Funnel HQ</title><meta name="robots" content="noindex">
<link rel="stylesheet" href="/assets/glass.css"><link rel="stylesheet" href="/assets/voice-demo.css"></head>
<body class="vd"><main class="vd-wrap">
<a class="vd-back" href="/admin">← Funnel HQ</a>
<p class="vd-eyebrow">AI phone agents</p><h1>Talk to an agent</h1>
<p class="vd-lede">A live conversation with the real agents, in their real voice, through your microphone. You play a sample lead. Nobody is called, and nothing is saved to a lead or emailed.</p>
<div class="vd-grid" data-scenarios role="radiogroup" aria-label="Scenario"></div>
<section class="vd-call glass" data-call>
  <div class="vd-orb" data-orb aria-hidden="true"><span></span></div>
  <p class="vd-status" data-status role="status">Pick a scenario, then press Start.</p>
  <p class="vd-you" data-you></p>
  <div class="vd-actions"><button type="button" class="vd-start" data-start disabled>Start</button><button type="button" class="vd-end" data-end hidden>End call</button></div>
  <ol class="vd-log" data-log aria-live="polite"></ol>
</section>
<p class="vd-fine">Uses your microphone only while a call is running. The agent discloses it’s an AI at the start, as on real calls.</p>
</main><script src="/assets/voice-demo.js"></script></body></html>`;
}
