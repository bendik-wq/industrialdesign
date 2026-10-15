// Data VSL funnel: serves the page and video from static assets, saves applications to D1,
// and exports them as CSV at /admin/leads.csv behind ADMIN_PASSWORD (HTTP Basic auth).

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const clip = (v, n = 300) => String(v ?? "").trim().slice(0, n);
const csvCell = (v) => {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
  return `"${s.replace(/"/g, '""')}"`;
};

async function apply(req, env) {
  let d;
  try { d = await req.json(); } catch { return json({ error: "Invalid request." }, 400); }
  if (d.website) return json({ ok: true }); // honeypot: bots fill the hidden field
  const lead = {
    name: clip(d.name, 120), business: clip(d.business, 160), email: clip(d.email, 200).toLowerCase(),
    phone: clip(d.phone, 40), status: d.status === "closed" ? "closed" : d.status === "operating" ? "operating" : "",
    industry: clip(d.industry, 120), years: clip(d.years, 40), systems: clip(d.systems, 1000),
    watched: Math.max(0, Math.min(3600, parseInt(d.watched, 10) || 0)), source: clip(d.source, 300),
  };
  if (!lead.name || !lead.business || !lead.phone || !lead.status || d.consent !== "yes" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email))
    return json({ error: "Please fill in your name, business, email, mobile, trading status and tick the consent box." }, 400);
  const ip = req.headers.get("cf-connecting-ip") || "";
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM leads WHERE ip = ? AND created_at > datetime('now', '-1 hour')").bind(ip).first();
  if (recent && recent.n >= 5) return json({ error: "Too many submissions. Please try again later." }, 429);
  await env.DB.prepare(
    "INSERT INTO leads (name, business, email, phone, status, industry, years, systems, watched, source, ip, country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(lead.name, lead.business, lead.email, lead.phone, lead.status, lead.industry, lead.years, lead.systems, lead.watched, lead.source, ip, req.cf?.country || "").run();
  return json({ ok: true });
}

function authorised(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = req.headers.get("authorization") || "";
  if (!h.startsWith("Basic ")) return false;
  let pass = "";
  try { pass = atob(h.slice(6)).split(":").slice(1).join(":"); } catch { return false; }
  const a = new TextEncoder().encode(pass), b = new TextEncoder().encode(env.ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function exportLeads(req, env) {
  if (!authorised(req, env)) return new Response("Login required", { status: 401, headers: { "www-authenticate": 'Basic realm="Data VSL leads"' } });
  const { results } = await env.DB.prepare("SELECT created_at, name, business, email, phone, status, industry, years, systems, watched, source, country FROM leads ORDER BY id DESC").all();
  const cols = ["created_at", "name", "business", "email", "phone", "status", "industry", "years", "systems", "watched", "source", "country"];
  const csv = [cols.join(","), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="data-vsl-leads-${new Date().toISOString().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
}

// Static assets ignore Range, and iOS Safari won't play a video without 206 responses.
async function media(req, env) {
  const asset = await env.ASSETS.fetch(new Request(req.url));
  if (!asset.ok) return asset;
  const type = asset.headers.get("content-type") || "application/octet-stream";
  const base = { "content-type": type, "accept-ranges": "bytes", "cache-control": "public, max-age=86400" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (!m) return new Response(req.method === "HEAD" ? null : asset.body, { headers: { ...base, "content-length": asset.headers.get("content-length") || "" } });
  const buf = await asset.arrayBuffer(), size = buf.byteLength;
  let start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
  let end = m[1] !== "" && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${size}` } });
  return new Response(req.method === "HEAD" ? null : buf.slice(start, end + 1), {
    status: 206, headers: { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/media/") && url.pathname.endsWith(".mp4")) return media(req, env);
    if (url.pathname === "/api/apply" && req.method === "POST") return apply(req, env);
    if (url.pathname === "/admin/leads.csv") return exportLeads(req, env);
    return env.ASSETS.fetch(req);
  },
};
