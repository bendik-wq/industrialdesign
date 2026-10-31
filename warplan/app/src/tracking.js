// Open and click tracking for emails the bots send from Warplan's own mailboxes (Instantly tracks its own).
// Opens: a 1x1 image in the HTML part. Clicks: links in the HTML part go through a redirect. Both use signed tokens,
// so nobody can forge an open or turn the redirect into an open redirect. Off by default: tracking pixels push cold
// email towards spam, and Apple Mail pre-loads images, so opens over-count.
import { hmac, safeEqual } from "./auth.js";

const b64u = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const TABLES = { b: "bot_prospects", s: "sell_prospects" };
export const origin = (env) => (env.PUBLIC_URL || "https://warplan.bendik-50e.workers.dev").replace(/\/+$/, "");

async function sign(env, payload) { return `${b64u(payload)}.${(await hmac(env, `track:${payload}`)).slice(0, 22)}`; }
async function verify(env, token) {
  const [p, sig] = String(token || "").split(".");
  if (!p || !sig) return null;
  let payload;
  try { payload = unb64u(p); } catch { return null; }
  return safeEqual(sig, (await hmac(env, `track:${payload}`)).slice(0, 22)) ? payload : null;
}

// kind: "b" (buying prospect) or "s" (sell prospect)
export async function pixelUrl(env, kind, id) { return `${origin(env)}/o/${await sign(env, `${kind}:${id}`)}.gif`; }
export async function trackLinks(env, kind, id, html) {
  const out = [];
  let last = 0;
  for (const m of html.matchAll(/href="(https?:\/\/[^"]{1,500})"/g)) {
    out.push(html.slice(last, m.index), `href="${origin(env)}/c/${await sign(env, `${kind}:${id}:${m[1]}`)}"`);
    last = m.index + m[0].length;
  }
  return out.join("") + html.slice(last);
}

const GIF = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"), (c) => c.charCodeAt(0));
export async function trackRoute(request, env, url) {
  let m;
  if ((m = url.pathname.match(/^\/o\/([\w.-]{10,400})\.gif$/))) {
    const payload = await verify(env, m[1]);
    const [kind, id] = (payload || "").split(":");
    if (TABLES[kind] && /^\d+$/.test(id || "")) await env.DB.prepare(`UPDATE ${TABLES[kind]} SET opens = opens + 1, last_open = ?2 WHERE id = ?1`).bind(+id, new Date().toISOString()).run().catch(() => {});
    return new Response(GIF, { headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, private" } });
  }
  if ((m = url.pathname.match(/^\/c\/([\w.-]{10,1200})$/))) {
    const payload = await verify(env, m[1]);
    const [kind, id, ...rest] = (payload || "").split(":");
    const dest = rest.join(":");
    if (!TABLES[kind] || !/^\d+$/.test(id || "") || !/^https?:\/\//.test(dest)) return new Response("Link expired", { status: 404 });
    await env.DB.prepare(`UPDATE ${TABLES[kind]} SET clicks = clicks + 1 WHERE id = ?1`).bind(+id).run().catch(() => {});
    return Response.redirect(dest, 302);
  }
  return null;
}
