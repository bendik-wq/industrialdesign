import Anthropic from '@anthropic-ai/sdk';
import { accessUser, json } from '../../lib/auth.js';

// The model answers with a reply plus a list of edits; the browser applies them (with undo).
const OP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'ops'],
  properties: {
    reply: { type: 'string' },
    ops: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'id', 'field', 'value', 'target', 'kind', 'title'],
        properties: {
          type: { type: 'string', enum: ['set_offer', 'set_math', 'set_field', 'connect', 'add_node', 'delete_node'] },
          id: { type: 'string' },
          field: { type: 'string' },
          value: { type: 'string' },
          target: { type: 'string' },
          kind: { type: 'string' },
          title: { type: 'string' }
        }
      }
    }
  }
};

const SYSTEM = `You are the operator of "G&L Overview & Strategy", the sales funnel and operating plan for G&L's acquisition-advisory offer. You talk with the owner and change the funnel when they ask.

The funnel JSON you receive has:
- offer: name, claim, terms (comma-separated key terms), audience, minRevenue ($/yr), price ($), days (contract length)
- math: goalClients (per month), bookRate, showRate, closeRate (percent)
- nodes: stages with id, kind (channel | page | gate | system | close | deliver | outcome | nurture | side), title, sub, message (what the prospect sees), next (id of the next stage), noNext (gates only: where people who fail go), objective, kpi, owner, plus kind-specific fields: channel (volume, visits, enabled, primary, qualifies), gate (threshold, readiness), deliver (days), and facing (customer sees it).

Non-negotiable rule: only owners with money get a sales conversation. Every sales step (kind "close") must sit behind a money gate whose threshold is at least offer.minRevenue, nothing that fails a gate may route to a sales step, and no channel may skip the gate. If a request would break this, don't make that change; say why and offer the closest safe alternative.

Congruency matters: the same promise (offer terms) and the same buyer (revenue minimum) must show up in every customer-facing message, delivery length must match offer.days, and channel traffic must cover the visitors the goal needs. When you change one thing, also make the follow-on edits that keep the funnel congruent, and say what you changed.

Respond with JSON only, matching the schema. "reply" is a short, plain-English answer (no markdown headings). "ops" is the list of edits, in order; leave it empty for questions. Unused op fields are empty strings. Op meanings:
- set_offer: field = offer key, value = new value
- set_math: field = math key, value = number as string
- set_field: id = node id, field = node key, value = new value ("true"/"false" for switches, digits for numbers)
- connect: id = source node id, field = "next" or "noNext", target = target node id ("" to disconnect)
- add_node: id = a new short unique slug, kind, title; target = optional next stage id. Follow with set_field ops to fill objective, kpi, owner, message, volume, visits and so on, and with connect ops to link other stages to it.
- delete_node: id
Only reference ids that exist or that you add in the same response.`;

export async function onRequestPost({ request, env }) {
  const user = await accessUser(request, env);
  if (!user) return json({ error: 'Sign in through Cloudflare Access to use the AI chat.' }, 401);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'The Claude API key is not set for this project yet.' }, 503);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Bad request' }, 400); }
  const { messages = [], funnel, issues = [], numbers = {} } = body;
  if (!funnel || !Array.isArray(messages) || !messages.length) return json({ error: 'Bad request' }, 400);

  const history = messages.slice(-12)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .map(m => ({ role: m.role, content: m.text.slice(0, 4000) }));
  while (history.length && history[0].role !== 'user') history.shift();
  if (!history.length || history[history.length - 1].role !== 'user') return json({ error: 'Bad request' }, 400);
  const last = history.pop();
  history.push({
    role: 'user',
    content: `Current funnel:\n${JSON.stringify(funnel)}\n\nLive numbers: ${JSON.stringify(numbers)}\nCongruency issues right now: ${issues.length ? issues.join(' | ') : 'none'}\n\nRequest from ${user}:\n${last.content}`
  });

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OP_SCHEMA } },
      system: SYSTEM,
      messages: history
    });
    if (response.stop_reason === 'refusal') return json({ reply: 'I can’t help with that one. Try asking it a different way.', ops: [] });
    if (response.stop_reason === 'max_tokens') return json({ error: 'That answer ran too long. Try a smaller request.' }, 502);
    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const out = JSON.parse(text);
    return json({ reply: String(out.reply || ''), ops: Array.isArray(out.ops) ? out.ops.slice(0, 40) : [] });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: 'Claude is busy. Try again in a moment.' }, 429);
    if (err instanceof Anthropic.APIError) return json({ error: 'Claude returned an error (' + (err.status || 'unknown') + ').' }, 502);
    if (err instanceof SyntaxError) return json({ error: 'Claude’s answer wasn’t valid JSON.' }, 502);
    return json({ error: 'Couldn’t reach Claude.' }, 502);
  }
}
