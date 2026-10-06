// Dealflow: acquisition-target dashboard. Serves the static UI and a small JSON API over D1.
// Every request requires HTTP Basic auth against the DASHBOARD_PASSWORD secret.

const STATUSES = ["New", "Researching", "Contacted", "Conversation", "NDA", "Financials", "LOI", "Passed", "Not a fit"];
const SORTS = {
  fit: "c.fit_score",
  size: "c.size_score",
  succession: "c.succession_score",
  licensed: "c.licensed_since",
  business: "c.business_since",
  licenses: "c.license_count",
  name: "c.name",
};
const LIST_COLS = `c.id, c.name, c.legal_name, c.owner, c.city, c.county, c.metro, c.entity, c.licensed_since, c.business_since,
  c.license_count, c.active_licenses, c.outlets, c.size_score, c.size_tier, c.succession_score, c.fit_score, c.non_target, c.reviews,
  COALESCE(p.status, 'New') AS status`;

export default {
  async fetch(request, env) {
    const denied = checkAuth(request, env);
    if (denied) return denied;

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, url);
    } catch (err) {
      console.error(err);
      return json({ error: "Internal error" }, 500);
    }
  },
};

async function route(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/stats" && method === "GET") return json(await stats(env));
  if (pathname === "/api/meta" && method === "GET") return json(await meta(env));
  if (pathname === "/api/companies" && method === "GET") return json(await list(env, url.searchParams));
  if (pathname === "/api/export.csv" && method === "GET") return exportCsv(env, url.searchParams);

  const m = pathname.match(/^\/api\/companies\/(\d+)(\/pipeline)?$/);
  if (m && !m[2] && method === "GET") return detail(env, Number(m[1]));
  if (m && m[2] && method === "PUT") return savePipeline(env, Number(m[1]), request);

  return json({ error: "Not found" }, 404);
}

function checkAuth(request, env) {
  const expected = env.DASHBOARD_PASSWORD;
  if (!expected) return new Response("DASHBOARD_PASSWORD secret is not set", { status: 503 });
  const header = request.headers.get("Authorization") || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [, password = ""] = atob(encoded).split(/:(.*)/s);
    if (timingSafeEqual(password, expected)) return null;
  }
  return new Response("Authentication required", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="Dealflow", charset="UTF-8"' },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a), y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function filters(params) {
  const where = [];
  const binds = [];
  if (params.get("excluded") !== "1") where.push("c.non_target = 0");
  if (params.get("sole") === "0") where.push("c.sole = 0");
  if (params.get("lapsed") === "1") where.push("c.active_licenses = 0");
  const q = params.get("q")?.trim();
  if (q) {
    where.push("(c.name LIKE ?1 OR c.legal_name LIKE ?1 OR c.owner LIKE ?1 OR c.city LIKE ?1 OR c.county LIKE ?1)".replaceAll("?1", `?${binds.length + 1}`));
    binds.push(`%${q}%`);
  }
  for (const [param, col] of [["metro", "c.metro"], ["county", "c.county"]]) {
    const vals = params.getAll(param).filter(Boolean);
    if (vals.length) {
      where.push(`${col} IN (${vals.map((_, i) => `?${binds.length + i + 1}`).join(",")})`);
      binds.push(...vals);
    }
  }
  const tiers = params.getAll("tier").filter(Boolean);
  if (tiers.length) {
    where.push(`c.size_tier IN (${tiers.map((_, i) => `?${binds.length + i + 1}`).join(",")})`);
    binds.push(...tiers);
  }
  for (const [param, col] of [["minSuccession", "c.succession_score"], ["minSize", "c.size_score"], ["minFit", "c.fit_score"]]) {
    const v = Number(params.get(param));
    if (v > 0) { where.push(`${col} >= ?${binds.length + 1}`); binds.push(v); }
  }
  const status = params.get("status");
  if (status === "Any pipeline") where.push("p.status IS NOT NULL AND p.status NOT IN ('New')");
  else if (STATUSES.includes(status)) {
    where.push(status === "New" ? "(p.status IS NULL OR p.status = 'New')" : `p.status = ?${binds.length + 1}`);
    if (status !== "New") binds.push(status);
  }
  return { sql: where.length ? `WHERE ${where.join(" AND ")}` : "", binds };
}

function orderBy(params) {
  const col = SORTS[params.get("sort")] || SORTS.fit;
  // Oldest-first is the useful default for "since" columns; biggest-first for scores.
  const defaultDir = ["c.licensed_since", "c.business_since", "c.name"].includes(col) ? "ASC" : "DESC";
  const dir = params.get("dir") === "asc" ? "ASC" : params.get("dir") === "desc" ? "DESC" : defaultDir;
  return `ORDER BY ${col} IS NULL, ${col} ${dir}, c.fit_score DESC, c.id`;
}

async function list(env, params) {
  const { sql, binds } = filters(params);
  const limit = Math.min(200, Math.max(1, Number(params.get("limit")) || 50));
  const page = Math.max(1, Number(params.get("page")) || 1);
  const from = `FROM companies c LEFT JOIN pipeline p ON p.key = c.key ${sql}`;
  const [rows, total] = await env.DB.batch([
    env.DB.prepare(`SELECT ${LIST_COLS} ${from} ${orderBy(params)} LIMIT ${limit} OFFSET ${(page - 1) * limit}`).bind(...binds),
    env.DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(...binds),
  ]);
  return { rows: rows.results, total: total.results[0].n, page, limit };
}

async function detail(env, id) {
  const row = await env.DB.prepare(
    `SELECT c.*, COALESCE(p.status, 'New') AS status, COALESCE(p.notes, '') AS notes, p.updated_at
     FROM companies c LEFT JOIN pipeline p ON p.key = c.key WHERE c.id = ?1`
  ).bind(id).first();
  if (!row) return json({ error: "Not found" }, 404);
  row.signals = JSON.parse(row.signals || "[]");
  row.licensees = JSON.parse(row.licensees || "[]");
  return json(row);
}

async function savePipeline(env, id, request) {
  const body = await request.json().catch(() => ({}));
  if (body.status && !STATUSES.includes(body.status)) return json({ error: "Invalid status" }, 400);
  const company = await env.DB.prepare("SELECT key FROM companies WHERE id = ?1").bind(id).first();
  if (!company) return json({ error: "Not found" }, 404);
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO pipeline (key, status, notes, updated_at) VALUES (?1, COALESCE(?2, 'New'), COALESCE(?3, ''), ?4)
     ON CONFLICT(key) DO UPDATE SET status = COALESCE(?2, status), notes = COALESCE(?3, notes), updated_at = ?4`
  ).bind(company.key, body.status ?? null, typeof body.notes === "string" ? body.notes.slice(0, 10000) : null, now).run();
  return json({ ok: true, updated_at: now });
}

async function stats(env) {
  const [totals, tiers, pipeline] = await env.DB.batch([
    env.DB.prepare(`SELECT COUNT(*) AS targets,
        SUM(succession_score >= 50) AS high_succession,
        SUM(size_tier IN ('Mid','Large')) AS mid_plus,
        SUM(succession_score >= 50 AND size_tier IN ('Mid','Large')) AS prime,
        SUM(active_licenses = 0) AS lapsed
      FROM companies WHERE non_target = 0`),
    env.DB.prepare("SELECT size_tier AS tier, COUNT(*) AS n FROM companies WHERE non_target = 0 GROUP BY size_tier"),
    env.DB.prepare("SELECT status, COUNT(*) AS n FROM pipeline WHERE status != 'New' GROUP BY status"),
  ]);
  return { ...totals.results[0], tiers: tiers.results, pipeline: pipeline.results };
}

async function meta(env) {
  const metros = await env.DB.prepare(
    "SELECT metro, COUNT(*) AS n FROM companies WHERE non_target = 0 GROUP BY metro ORDER BY n DESC"
  ).all();
  return { metros: metros.results, statuses: STATUSES };
}

const CSV_FORMATS = {
  full: [
    ["Rank", "id"], ["Company", "name"], ["Legal name", "legal_name"], ["Owner", "owner"], ["Street", "street"], ["City", "city"],
    ["ZIP", "zip"], ["County", "county"], ["Metro", "metro"], ["Entity", "entity"], ["Est. licensed since", "licensed_since"],
    ["Business since", "business_since"], ["Licensed contractors", "license_count"], ["Locations", "outlets"],
    ["Size tier", "size_tier"], ["Size score", "size_score"], ["Succession score", "succession_score"], ["Fit score", "fit_score"],
    ["Phone", "phone"], ["Email", "email"], ["Website", "website"], ["Google rating", "rating"], ["Google reviews", "reviews"],
    ["Status", "status"], ["Signals", (r) => JSON.parse(r.signals || "[]").filter((s) => s.pts).map((s) => s.label).join("; ")],
  ],
  // Lob / PostGrid address-book import.
  lob: [
    ["name", "owner"], ["company", "name"], ["address_line1", "street"], ["address_city", "city"],
    ["address_state", () => "TX"], ["address_zip", "zip"], ["address_country", () => "US"],
    ["first_name", (r) => (r.owner || "").split(" ")[0]], ["licensed_since", "licensed_since"],
  ],
  // Instantly / Smartlead lead import (rows without an email are skipped).
  instantly: [
    ["email", "email"], ["first_name", (r) => (r.owner || "").split(" ")[0]], ["last_name", (r) => (r.owner || "").split(" ").slice(1).join(" ")],
    ["company_name", "name"], ["city", "city"], ["state", () => "TX"], ["licensed_since", "licensed_since"],
    ["years_in_business", (r) => (r.business_since ? new Date().getFullYear() - r.business_since : "")],
  ],
};

async function exportCsv(env, params) {
  const format = CSV_FORMATS[params.get("format")] ? params.get("format") : "full";
  const { sql, binds } = filters(params);
  const need = { lob: "c.street != ''", instantly: "c.email IS NOT NULL" }[format];
  const where = need ? (sql ? `${sql} AND ${need}` : `WHERE ${need}`) : sql;
  const { results } = await env.DB.prepare(
    `SELECT c.*, COALESCE(p.status, 'New') AS status FROM companies c LEFT JOIN pipeline p ON p.key = c.key ${where} ${orderBy(params)} LIMIT 5000`
  ).bind(...binds).all();
  const cols = CSV_FORMATS[format];
  const cell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([h]) => h).join(","), ...results.map((r) => cols.map(([, f]) => cell(typeof f === "function" ? f(r) : r[f])).join(","))];
  return new Response(lines.join("\n") + "\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tx-hvac-targets-${format}.csv"`,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
