import { accessUser, json } from '../../lib/auth.js';

const KEYS = new Set(['funnel', 'weeks', 'log', 'kpis', 'yt']);
const MAX = 2_000_000;

export async function onRequest({ request, env }) {
  const user = await accessUser(request, env);
  if (!user) return json({ error: 'Sign in through Cloudflare Access to sync.' }, 401);
  const key = new URL(request.url).searchParams.get('key');
  if (key === 'me') return json({ email: user });
  if (!KEYS.has(key)) return json({ error: 'Unknown key' }, 400);

  if (request.method === 'GET') {
    const v = await env.LOI_DATA.get(key);
    return new Response(v ?? 'null', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > MAX) return json({ error: 'Too large' }, 413);
    try { JSON.parse(body); } catch (e) { return json({ error: 'Not JSON' }, 400); }
    await env.LOI_DATA.put(key, body);
    return json({ ok: true, by: user });
  }
  return json({ error: 'Method not allowed' }, 405);
}
