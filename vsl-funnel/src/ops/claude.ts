import Anthropic from '@anthropic-ai/sdk';
import type { Runtime } from '../app';

/**
 * One small door to Claude for Client Success and Support. Returns null when there is no API key (every
 * caller degrades to a template or a "needs a person" state) or when the model refuses. Tests swap the
 * transport with setClaudeTransport so nothing leaves the process.
 */
export const REASONING_MODEL = 'claude-sonnet-5-5';
export const NO_KEY_NOTE = 'Add the Anthropic API key (Integrations → Email) to have Claude draft these.';

export interface ClaudeAsk { model: string; system: string; user: string; maxTokens?: number }
type Transport = (rt: Runtime, ask: ClaudeAsk) => Promise<string | null>;

let transport: Transport | null = null;
export function setClaudeTransport(t: Transport | null) { transport = t; }

export const claudeReady = (rt: Runtime) => Boolean(transport || rt.settings.ANTHROPIC_API_KEY);

export async function askClaude(rt: Runtime, ask: ClaudeAsk): Promise<string | null> {
  if (transport) return transport(rt, ask);
  const key = rt.settings.ANTHROPIC_API_KEY;
  if (!key) return null;
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 60_000 });
  const res = await client.messages.create({
    model: ask.model,
    max_tokens: ask.maxTokens ?? 1200,
    system: [{ type: 'text', text: ask.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: ask.user }],
  });
  if (res.stop_reason === 'refusal') return null;
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
}

/** The first JSON object in a model reply (tolerates a code fence or a sentence around it). */
export function parseJsonReply<T>(text: string | null): T | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as T; } catch { return null; }
}
