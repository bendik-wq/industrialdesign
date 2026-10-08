// AI layer. Claude when ANTHROPIC_API_KEY is set (the workspace's own key or the platform's); otherwise Cloudflare
// Workers AI (no key needed). Speech: Whisper (Workers AI) in; ElevenLabs out, with Deepgram Aura as fallback.
// Every call returns {text, model, usage} so the caller can meter it (src/usage.js).
import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "node:buffer";

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TTS_MODEL = "@cf/deepgram/aura-1";

const err = (status, message) => Object.assign(new Error(message), { status });
const claudeModel = (env) => env.CLAUDE_MODEL || "claude-opus-5-5";

// system: a string, or {text, cached, extra}. `cached` is a large stable block (Josh's transcripts) that Claude caches
// between requests; `extra` is per-request context (the user's pipeline, a target) placed after the cache breakpoint.
// Workers AI gets `fallback` (or `text`) plus `extra`.
function claudeSystem(sys) {
  const blocks = [{ type: "text", text: sys.text }];
  if (sys.cached) blocks.push({ type: "text", text: sys.cached });
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  if (sys.extra) blocks.push({ type: "text", text: sys.extra });
  return blocks;
}
const llamaSystem = (sys) => [sys.fallback || sys.text, sys.extra].filter(Boolean).join("\n\n");
const asSys = (system) => (typeof system === "string" ? { text: system } : system);

function claudeRequest(env, sys, messages, maxTokens, effort, extra = {}) {
  return {
    model: claudeModel(env),
    max_tokens: Math.max(4000, maxTokens * 4), // headroom for adaptive thinking
    output_config: { effort, ...(extra.format ? { format: extra.format } : {}) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: claudeSystem(sys),
    messages,
  };
}
const claudeUsage = (u = {}) => ({ input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 });
const llamaUsage = (u = {}) => ({ input: u.prompt_tokens || 0, output: u.completion_tokens || 0, cached: 0 });
function friendly(e) {
  if (e.status === 401 || e.status === 403) return err(502, "The Anthropic key was rejected. Check it under Settings → Integrations.");
  if (e.status === 429) return err(429, "Claude is rate-limiting this key right now. Try again in a minute.");
  if (e.status === 400 && /credit|billing/i.test(e.message)) return err(402, "The Anthropic account behind this key is out of credit.");
  return e;
}

// messages: [{role: "user"|"assistant", content: string}], oldest first, ending with the user's turn.
export async function chat(env, system, messages, maxTokens = 1200, effort = "low") {
  const sys = asSys(system);
  if (env.ANTHROPIC_API_KEY) {
    let res;
    try { res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages.create(claudeRequest(env, sys, messages, maxTokens, effort)); }
    catch (e) { throw friendly(e); }
    if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
    return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), model: res.model, usage: claudeUsage(res.usage) };
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: llamaSystem(sys) }, ...messages], max_tokens: maxTokens });
  return { text: String(out.response || "").trim(), model: WORKERS_AI_MODEL, usage: llamaUsage(out.usage) };
}

// Same as chat(), but calls onText(delta) as the reply is written. Resolves with the full reply.
export async function chatStream(env, system, messages, maxTokens, effort, onText) {
  const sys = asSys(system);
  if (env.ANTHROPIC_API_KEY) {
    try {
      const stream = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages.stream(claudeRequest(env, sys, messages, maxTokens, effort));
      stream.on("text", (t) => onText(t));
      const res = await stream.finalMessage();
      if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
      return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), model: res.model, usage: claudeUsage(res.usage) };
    } catch (e) { throw friendly(e); }
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  const body = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: llamaSystem(sys) }, ...messages], max_tokens: maxTokens, stream: true });
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "", text = "", usage = {};
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        if (j.response) { text += j.response; onText(j.response); }
        if (j.usage) usage = j.usage;
      } catch { /* partial line */ }
    }
  }
  return { text: text.trim(), model: WORKERS_AI_MODEL, usage: llamaUsage(usage) };
}

// Structured output against a JSON schema. Callers still validate: models can omit optional fields.
export async function chatJson(env, system, prompt, schema, maxTokens = 2000, effort = "low") {
  const sys = asSys(system);
  if (env.ANTHROPIC_API_KEY) {
    let res;
    try { res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages.create(claudeRequest(env, sys, [{ role: "user", content: prompt }], maxTokens, effort, { format: { type: "json_schema", schema } })); }
    catch (e) { throw friendly(e); }
    if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
    const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { data: JSON.parse(raw), model: res.model, usage: claudeUsage(res.usage) };
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  const out = await env.AI.run(WORKERS_AI_MODEL, {
    messages: [{ role: "system", content: llamaSystem(sys) }, { role: "user", content: prompt }],
    response_format: { type: "json_schema", json_schema: schema },
    max_tokens: maxTokens,
  });
  const r = out.response;
  let data = r;
  if (typeof r === "string") { try { data = JSON.parse(r); } catch { throw err(502, "The AI returned something unreadable. Try again."); } }
  return { data: data || {}, model: WORKERS_AI_MODEL, usage: llamaUsage(out.usage) };
}

export async function transcribe(env, audio, hint = "") {
  if (!env.AI) throw err(503, "Voice needs the Workers AI binding");
  const out = await env.AI.run(STT_MODEL, {
    audio: Buffer.from(audio).toString("base64"),
    vad_filter: true,
    initial_prompt: hint || "Business acquisition conversation: EBITDA, vendor finance, seller note, earn-out, LOI, due diligence.",
  });
  return { text: String(out.text || "").trim(), language: out.transcription_info?.language || null };
}

export const SPEAKERS = ["angus", "asteria", "arcas", "orion", "orpheus", "athena", "luna", "zeus", "perseus", "helios", "hera", "stella"];

// ElevenLabs voices per speaker. Josh uses JOSH_VOICE_ID (the workspace's chosen voice, or the platform's consented
// Josh clone); the simulator owners use ElevenLabs stock voices that fit each character.
const ELEVEN_MODEL = "eleven_multilingual_v2";
const ELEVEN_VOICES = {
  arcas: (env) => env.JOSH_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb", // Josh
  angus: () => "pqHfZKP75CvOlQylNhV4", // older American man
  athena: () => "XrExE9yKIg1WjnnlVkGX", // warm, measured woman
  zeus: () => "onwK4e9ZLuTAKqWW03F9", // older British man
  orion: () => "TX3LPaxmHKxFdv7VOQHJ", // middle-aged man
  luna: () => "EXAVITQu4vr4xnSDxMaL", // woman
};

async function elevenLabs(env, text, voiceId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.arrayBuffer();
}

// Returns mp3 bytes. ElevenLabs when configured, Workers AI Aura otherwise (and as the fallback if ElevenLabs fails).
export async function speak(env, text, speaker = "orion") {
  const clean = String(text).replace(/[#*_`>]/g, "").replace(/\n{2,}/g, ".\n").slice(0, 1900);
  const pick = ELEVEN_VOICES[speaker];
  if (env.ELEVENLABS_API_KEY && pick) {
    try { return await elevenLabs(env, clean, pick(env)); } catch (e) { console.warn(e.message); }
  }
  if (!env.AI) throw err(503, "Voice needs the Workers AI binding");
  return env.AI.run(TTS_MODEL, { text: clean, speaker: SPEAKERS.includes(speaker) ? speaker : "orion", encoding: "mp3" });
}
