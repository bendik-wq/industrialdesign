// Voice training loop, step 1: build the three agents from the CURRENT code and push them to ElevenLabs (same agent ids).
// Settings come from a JSON file (read from the live database by the caller); nothing else is touched.
import { readFileSync } from 'node:fs';
import { buildAgent, upsertAgent } from '../../src/integrations/elevenlabs';
import { buildInboundAgent } from '../../src/integrations/elevenlabs-inbound';
import { buildWebinarAgent } from '../../src/integrations/webinar-calls';
import type { Settings } from '../../src/settings';

const s = JSON.parse(readFileSync(process.argv[2], 'utf8')) as Settings;
const out = await Promise.all([
  upsertAgent(s, buildAgent(s) as unknown as Record<string, unknown>, s.ELEVENLABS_AGENT_ID),
  upsertAgent(s, buildInboundAgent(s) as unknown as Record<string, unknown>, s.ELEVENLABS_INBOUND_AGENT_ID),
  upsertAgent(s, buildWebinarAgent(s as never) as unknown as Record<string, unknown>, String((s as Record<string, string>).ELEVENLABS_WEBINAR_AGENT_ID ?? '')),
]);
console.log(JSON.stringify(out.map((o) => ({ id: o.id, created: o.created }))));
