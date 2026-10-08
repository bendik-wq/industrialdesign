// Bring-your-own provider keys. A workspace can connect its own Anthropic and ElevenLabs accounts; every AI call
// for that workspace then runs on (and is billed to) their key, with the platform's keys as the fallback.
//   At rest: AES-256-GCM, key derived with HKDF from KEYS_SECRET (or, if unset, the session secret).
//   In transit: keys go browser → Worker once, over HTTPS, and are never returned (only the last 4 characters).
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const err = (status, message) => Object.assign(new Error(message), { status });

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    hint: "Starts with sk-ant-. Create one at console.anthropic.com → API keys.",
    meta: ["model"],
  },
  elevenlabs: {
    label: "ElevenLabs (voices)",
    pattern: /^(sk_)?[A-Za-z0-9]{24,}$/,
    hint: "From elevenlabs.io → Profile → API keys. Add a voice ID to give Josh a specific voice.",
    meta: ["voiceId"],
  },
};
export const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

async function aesKey(env) {
  const secret = env.KEYS_SECRET || env.SESSION_SECRET || `keys:${env.DASHBOARD_PASSWORD || ""}`;
  if (!env.KEYS_SECRET && !env.SESSION_SECRET && !env.DASHBOARD_PASSWORD) throw err(503, "Key storage isn't configured on this server");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: enc.encode("warplan-account-keys"), info: enc.encode("v1") }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function seal(env, plain, aad) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, await aesKey(env), enc.encode(plain));
  return { ciphertext: b64(ct), iv: b64(iv) };
}
async function open(env, row, aad) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(row.iv), additionalData: enc.encode(aad) }, await aesKey(env), unb64(row.ciphertext));
  return dec.decode(pt);
}
const aadFor = (accountId, provider) => `acct:${accountId}:${provider}`;

// What the settings page shows: which providers are connected, never the keys.
export async function listKeys(env, accountId) {
  const { results } = await env.DB.prepare("SELECT provider, hint, meta, updated_at FROM account_keys WHERE account_id = ?1").bind(accountId).all();
  const have = Object.fromEntries(results.map((r) => [r.provider, r]));
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, label: p.label, hint: p.hint,
    connected: !!have[id], last4: have[id]?.hint || "", meta: have[id] ? JSON.parse(have[id].meta) : {}, updatedAt: have[id]?.updated_at || null,
    platformFallback: id === "anthropic" ? (env.ANTHROPIC_API_KEY ? "Claude (platform key)" : "Workers AI (Llama 3.3 70B)") : (env.ELEVENLABS_API_KEY ? "ElevenLabs (platform key)" : "Workers AI voices"),
  }));
}

function cleanMeta(provider, meta = {}) {
  const out = {};
  if (provider === "anthropic" && MODELS.includes(meta.model)) out.model = meta.model;
  if (provider === "elevenlabs" && /^[A-Za-z0-9]{10,40}$/.test(String(meta.voiceId || ""))) out.voiceId = meta.voiceId;
  return out;
}

// Check a key against the provider before storing it, so a typo fails here and not mid-conversation.
export async function verifyKey(provider, key) {
  if (provider === "anthropic") {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    if (r.status === 401 || r.status === 403) throw err(400, "Anthropic rejected that key");
    if (!r.ok) throw err(502, `Anthropic answered ${r.status}; try again in a minute`);
    return true;
  }
  if (provider === "elevenlabs") {
    const r = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
    if (r.status === 401 || r.status === 403) throw err(400, "ElevenLabs rejected that key");
    if (!r.ok) throw err(502, `ElevenLabs answered ${r.status}; try again in a minute`);
    return true;
  }
  throw err(400, "Unknown provider");
}

export async function saveKey(env, ctx, provider, b) {
  const p = PROVIDERS[provider];
  if (!p) throw err(404, "Unknown provider");
  const meta = cleanMeta(provider, b.meta);
  const key = String(b.key || "").trim();
  if (!key) {
    // Settings only (e.g. a new voice ID) for an already-connected key.
    const done = await env.DB.prepare("UPDATE account_keys SET meta = ?3, updated_at = ?4 WHERE account_id = ?1 AND provider = ?2 RETURNING provider")
      .bind(ctx.accountId, provider, JSON.stringify(meta), new Date().toISOString()).first();
    if (!done) throw err(400, "Paste the key first");
    return { ok: true };
  }
  if (!p.pattern.test(key)) throw err(400, `That doesn't look like an ${p.label} key. ${p.hint}`);
  if (b.verify !== false) await verifyKey(provider, key);
  const sealed = await seal(env, key, aadFor(ctx.accountId, provider));
  await env.DB.prepare(`INSERT INTO account_keys (account_id, provider, ciphertext, iv, hint, meta, created_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    ON CONFLICT (account_id, provider) DO UPDATE SET ciphertext = ?3, iv = ?4, hint = ?5, meta = ?6, created_by = ?7, updated_at = ?8`)
    .bind(ctx.accountId, provider, sealed.ciphertext, sealed.iv, key.slice(-4), JSON.stringify(meta), ctx.user.id || null, new Date().toISOString()).run();
  return { ok: true, last4: key.slice(-4) };
}

export async function deleteKey(env, ctx, provider) {
  await env.DB.prepare("DELETE FROM account_keys WHERE account_id = ?1 AND provider = ?2").bind(ctx.accountId, provider).run();
  return { ok: true };
}

// The env every AI call for this workspace should use: its own keys layered over the platform's.
// `ownKey` tells usage metering and limits whose bill it is.
export async function aiEnv(env, ctx) {
  const { results } = await env.DB.prepare("SELECT provider, ciphertext, iv, meta FROM account_keys WHERE account_id = ?1").bind(ctx.accountId).all();
  const out = { ...env, ownKey: false, CLAUDE_MODEL: env.CLAUDE_MODEL || "claude-opus-5-5" };
  for (const r of results) {
    let key;
    try { key = await open(env, r, aadFor(ctx.accountId, r.provider)); } catch { console.warn(`account ${ctx.accountId}: can't decrypt ${r.provider} key`); continue; }
    const meta = JSON.parse(r.meta || "{}");
    if (r.provider === "anthropic") { out.ANTHROPIC_API_KEY = key; out.ownKey = true; if (meta.model) out.CLAUDE_MODEL = meta.model; }
    // A cloned voice lives in one ElevenLabs account, so the platform's Josh voice won't work on their key.
    if (r.provider === "elevenlabs") { out.ELEVENLABS_API_KEY = key; out.JOSH_VOICE_ID = meta.voiceId || undefined; out.ownVoice = true; }
  }
  return out;
}
