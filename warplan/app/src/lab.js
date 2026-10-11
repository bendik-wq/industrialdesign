// Deal Lab: a small Linux microVM per workspace (Smol Machines, through Monid) that runs real Python for the work a
// Worker can't do. First job: a formula-driven Excel deal model (lab/model.py) that a banker, accountant or seller
// can open, edit and check. The machine sleeps after 90 idle seconds (only its 3 GB disk bills while asleep,
// about a cent a month) and wakes on the next job; Python packages stay installed across sleeps.
//   Security: outbound network limited to the container registry and PyPI (for installing packages), no secrets in
//   the guest, and jobs only ever receive the deal numbers they need.
import MODEL_PY from "../lab/model.py";
import { run } from "./monid.js";
import { getTarget } from "./pipeline.js";
import { targetDeal } from "../public/js/deal.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const SPEC = {
  name: "Warplan Deal Lab",
  source: { type: "image", reference: "python:3.12-slim" },
  resources: { cpus: 1, memoryMb: 1024, diskGb: 3 },
  network: { mode: "allowCidrs", hosts: ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "pypi.org", "files.pythonhosted.org"] },
  workdir: "/workspace",
  autoStopSeconds: 90,
};
const PACKAGES = "openpyxl==3.1.5";
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
const SCRIPT_V = hash(MODEL_PY + PACKAGES);

async function getCfg(env, accountId) {
  const r = await env.DB.prepare("SELECT data FROM settings WHERE account_id = ?1 AND key = 'lab'").bind(accountId).first();
  return r ? JSON.parse(r.data) : null;
}
async function putCfg(env, accountId, cfg) {
  await env.DB.prepare("INSERT INTO settings (account_id, key, data, updated_at) VALUES (?1, 'lab', ?2, ?3) ON CONFLICT (account_id, key) DO UPDATE SET data = ?2, updated_at = ?3").bind(accountId, JSON.stringify(cfg), now()).run();
}
// One Smol Machines call through Monid; the machine's own metering shows up on the Monid bill.
async function sm(env, ctx, endpoint, { id, body } = {}, purpose = "Deal Lab", maxWaitMs = 30000) {
  const r = await run(env, ctx, { provider: "smolmachine", endpoint, input: { ...(body && { body }), ...(id && { pathParams: { id } }) } }, { purpose, maxWaitMs });
  return r.output;
}
async function exec(env, ctx, id, command, purpose) {
  const o = await sm(env, ctx, "/machines/{id}/exec", { id, body: { command } }, purpose);
  if (o?.exitCode !== 0) throw err(502, `Deal Lab: ${String(o?.stderr || o?.stdout || `exit ${o?.exitCode}`).trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
  return o;
}

// Make sure this workspace has a working machine with the packages and the current scripts on it.
async function ensureLab(env, ctx, retry = true) {
  let cfg = await getCfg(env, ctx.accountId);
  try {
    if (!cfg?.machine_id) {
      const m = await sm(env, ctx, "/machines", { body: SPEC }, "Deal Lab: create the machine");
      if (!m?.id) throw err(502, "Couldn't create the Deal Lab machine");
      cfg = { machine_id: m.id, created_at: now(), script: null };
      await putCfg(env, ctx.accountId, cfg);
    }
    if (cfg.script !== SCRIPT_V) {
      await exec(env, ctx, cfg.machine_id, `pip install --quiet --no-cache-dir --disable-pip-version-check ${PACKAGES} && mkdir -p /workspace/warplan /workspace/jobs /workspace/out`, "Deal Lab: install packages");
      await sm(env, ctx, "/machines/{id}/files/upload", { id: cfg.machine_id, body: { path: "/workspace/warplan/model.py", content_base64: b64(MODEL_PY) } }, "Deal Lab: upload scripts");
      cfg.script = SCRIPT_V;
      await putCfg(env, ctx.accountId, cfg);
    }
    return cfg;
  } catch (e) {
    // The machine was deleted (or belongs to an old Monid key): start over once.
    if (retry && cfg?.machine_id && /not.?found|RESOURCE_NOT_FOUND|404|no such machine|state "?error/i.test(e.message)) {
      await env.DB.prepare("DELETE FROM settings WHERE account_id = ?1 AND key = 'lab'").bind(ctx.accountId).run();
      return ensureLab(env, ctx, false);
    }
    throw e;
  }
}

export async function labStatus(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  return { ready: !!cfg?.machine_id, machine: cfg?.machine_id ? `${cfg.machine_id.slice(0, 9)}…` : null, created_at: cfg?.created_at || null, cost: "about $0.10 an hour while it runs (it sleeps after 90 seconds idle); a cent or so a month asleep" };
}
export async function deleteLab(env, ctx) {
  const cfg = await getCfg(env, ctx.accountId);
  if (cfg?.machine_id) await sm(env, ctx, "/machines/{id}/delete", { id: cfg.machine_id }, "Deal Lab: delete the machine").catch(() => {});
  await env.DB.prepare("DELETE FROM settings WHERE account_id = ?1 AND key = 'lab'").bind(ctx.accountId).run();
  return { ok: true };
}

const slug = (s) => String(s || "target").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "target";
function cleanAddbacks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 8).map((a) => ({ label: String(a.label || "Adjustment").slice(0, 60), amount: Math.round(+a.amount || 0), note: String(a.note || "").slice(0, 120) })).filter((a) => a.amount);
}

// The Excel deal model for a target, from its saved structure (or the default one sized to its EBITDA).
export async function buildModel(env, ctx, targetId, b = {}) {
  const t = await getTarget(env, ctx, +targetId);
  const deal = targetDeal(t);
  if (!deal.ebitda) throw err(400, "Add the target's EBITDA first (Edit details), or structure the deal in the Deal Builder");
  const cfg = await ensureLab(env, ctx);
  const job = crypto.randomUUID();
  const spec = {
    company: t.name, subtitle: [t.industry, t.location, `built ${now().slice(0, 10)}`].filter(Boolean).join(" · "),
    deal, revenue: t.revenue || null, addbacks: cleanAddbacks(b.addbacks), notes: String(b.notes || "").slice(0, 1500),
  };
  await sm(env, ctx, "/machines/{id}/files/upload", { id: cfg.machine_id, body: { path: `/workspace/jobs/${job}.json`, content_base64: b64(JSON.stringify(spec)) } }, `Deal Lab: model for ${t.name}`);
  await exec(env, ctx, cfg.machine_id, ["python", "/workspace/warplan/model.py", `/workspace/jobs/${job}.json`, `/workspace/out/${job}.xlsx`], `Deal Lab: model for ${t.name}`);
  const dl = await sm(env, ctx, "/machines/{id}/files/download", { id: cfg.machine_id, body: { path: `/workspace/out/${job}.xlsx` } }, `Deal Lab: model for ${t.name}`);
  let bytes;
  if (dl?.content_base64) bytes = Uint8Array.from(atob(dl.content_base64), (c) => c.charCodeAt(0));
  else if (dl?.url && /^https:\/\/sfs\.monid\.ai\//.test(dl.url)) bytes = new Uint8Array(await (await fetch(dl.url)).arrayBuffer());
  else throw err(502, "Deal Lab: the model was built but couldn't be downloaded");
  if (bytes.length < 100 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw err(502, "Deal Lab: the file came back damaged; try again");
  // Tidy the job files (best effort; the next jobs don't depend on it).
  exec(env, ctx, cfg.machine_id, ["rm", "-f", `/workspace/jobs/${job}.json`, `/workspace/out/${job}.xlsx`], "Deal Lab: tidy up").catch(() => {});
  const name = `${slug(t.name)}-deal-model-${now().slice(0, 10)}.xlsx`;
  const f = await env.DB.prepare("INSERT INTO files (account_id, target_id, name, mime, size, data, kind, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'model', ?7, ?8) RETURNING id")
    .bind(ctx.accountId, t.id, name, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", bytes.length, bytes, ctx.user?.id || null, now()).first();
  await env.DB.prepare("INSERT INTO target_events (account_id, target_id, user_id, user_name, kind, body, created_at) VALUES (?1, ?2, ?3, ?4, 'doc', ?5, ?6)")
    .bind(ctx.accountId, t.id, ctx.user?.id || null, ctx.user?.name || ctx.user?.email || "Agent", `Built the Excel deal model (${name}): ${deal.multiple}x ${deal.cur}${Math.round(deal.ebitda).toLocaleString("en-US")} EBITDA, live formulas.`, now()).run();
  return { file_id: f.id, name, size: bytes.length, url: `/api/files/${f.id}`, receipt: `Excel model ready: ${name}` };
}

export async function listFiles(env, ctx, targetId) {
  const { results } = await env.DB.prepare("SELECT id, name, size, kind, created_at FROM files WHERE account_id = ?1 AND target_id = ?2 ORDER BY id DESC LIMIT 20").bind(ctx.accountId, +targetId).all();
  return { files: results.map((f) => ({ ...f, url: `/api/files/${f.id}` })) };
}
export async function getFile(env, ctx, id) {
  const f = await env.DB.prepare("SELECT name, mime, data FROM files WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).first();
  if (!f) throw err(404, "No such file");
  const body = f.data instanceof ArrayBuffer ? f.data : new Uint8Array(f.data);
  return new Response(body, { headers: { "Content-Type": f.mime, "Content-Disposition": `attachment; filename="${f.name.replace(/[^\w.-]/g, "_")}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
export async function deleteFile(env, ctx, id) {
  await env.DB.prepare("DELETE FROM files WHERE id = ?1 AND account_id = ?2").bind(+id, ctx.accountId).run();
  return { ok: true };
}
