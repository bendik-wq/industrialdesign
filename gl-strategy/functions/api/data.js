import { accessUser, json } from '../../lib/auth.js';

const KEYS = ['funnel', 'weeks', 'log', 'kpis', 'yt'];
const MAX = 2_000_000;

// Every key carries a revision number in KV metadata. A write must name the revision it
// was based on; if someone else saved in between, the server answers 409 with the latest
// copy so the browser can merge both sets of changes and try again.
async function read(env, key) {
  const { value, metadata } = await env.LOI_DATA.getWithMetadata(key);
  let data = null;
  try { data = value ? JSON.parse(value) : null; } catch (e) { data = null; }
  return { rev: metadata?.rev || 0, by: metadata?.by || null, at: metadata?.at || null, data };
}

export async function onRequest({ request, env }) {
  const user = await accessUser(request, env);
  if (!user) return json({ error: 'Sign in through Cloudflare Access to sync.' }, 401);
  const key = new URL(request.url).searchParams.get('key');
  if (key === 'me') return json({ email: user });
  if (key === 'revs') {
    const out = {};
    for (const k of KEYS) { const { metadata } = await env.LOI_DATA.getWithMetadata(k); out[k] = metadata?.rev || 0; }
    return json(out);
  }
  if (!KEYS.includes(key)) return json({ error: 'Unknown key' }, 400);

  if (request.method === 'GET') return json(await read(env, key));

  if (request.method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX) return json({ error: 'Too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'Not JSON' }, 400); }
    if (!body || typeof body !== 'object' || !('data' in body)) return json({ error: 'Expected { rev, data }' }, 400);
    const cur = await read(env, key);
    if ((body.rev || 0) !== cur.rev) return json({ conflict: true, ...cur }, 409);
    const rev = cur.rev + 1;
    await env.LOI_DATA.put(key, JSON.stringify(body.data), { metadata: { rev, by: user, at: Date.now() } });
    return json({ ok: true, rev });
  }
  return json({ error: 'Method not allowed' }, 405);
}
