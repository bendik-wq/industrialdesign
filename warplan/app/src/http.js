// Small HTTP helpers shared by the route modules.
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
// JSON bodies are capped at 1 MB (file uploads use multipart, not this).
export const body = async (request) => {
  if (+(request.headers.get("Content-Length") || 0) > 1_000_000) throw Object.assign(new Error("That request is too large"), { status: 413 });
  const t = await request.text().catch(() => "");
  if (t.length > 1_000_000) throw Object.assign(new Error("That request is too large"), { status: 413 });
  try { return t ? JSON.parse(t) : {}; } catch { return {}; }
};
export const now = () => new Date().toISOString();
export const slow = () => new Promise((r) => setTimeout(r, 600));
export const cleanEmail = (e) => { const s = String(e || "").trim().toLowerCase(); return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 160 ? s : ""; };
export const displayName = (ctx) => ctx.user.name || String(ctx.user.email || "").split("@")[0];
export function needOwner(ctx) { if (!ctx.isOwner) fail(403, "Only workspace owners can do that"); }
