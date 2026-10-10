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
// Workers AI answers in its classic shape ({response}) or, for some modes, OpenAI's ({choices: [{message: {content}}]}).
// In JSON mode `response` can arrive already parsed (an object), so callers check the type.
const llamaText = (out) => out?.choices?.[0]?.message?.content ?? out?.response ?? "";
function friendly(e) {
  if (e.status === 401 || e.status === 403) return err(502, "The Anthropic key was rejected. Check it under Settings → Integrations.");
  if (e.status === 429) return err(429, "Claude is rate-limiting this key right now. Try again in a minute.");
  if (e.status === 400 && /credit|billing/i.test(e.message)) return err(402, "The Anthropic account behind this key is out of credit.");
  return e;
}

// messages: [{role: "user"|"assistant", content: string}], oldest first, ending with the user's turn.
// User-scoped keys (sk-ant-usr-…) aren't tied to a workspace and need its ID on every request.
const claude = (env) => new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_WORKSPACE_ID && { defaultHeaders: { "anthropic-workspace-id": env.ANTHROPIC_WORKSPACE_ID } }) });

export async function chat(env, system, messages, maxTokens = 1200, effort = "low") {
  const sys = asSys(system);
  if (env.ANTHROPIC_API_KEY) {
    let res;
    try { res = await claude(env).beta.messages.create(claudeRequest(env, sys, messages, maxTokens, effort)); }
    catch (e) { throw friendly(e); }
    if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
    return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), model: res.model, usage: claudeUsage(res.usage) };
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: llamaSystem(sys) }, ...messages], max_tokens: maxTokens });
  return { text: String(llamaText(out) || "").trim(), model: WORKERS_AI_MODEL, usage: llamaUsage(out.usage) };
}

// Same as chat(), but calls onText(delta) as the reply is written. Resolves with the full reply.
export async function chatStream(env, system, messages, maxTokens, effort, onText) {
  const sys = asSys(system);
  if (env.ANTHROPIC_API_KEY) {
    try {
      const stream = claude(env).beta.messages.stream(claudeRequest(env, sys, messages, maxTokens, effort));
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
        const piece = j.response ?? j.choices?.[0]?.delta?.content;
        if (piece) { text += piece; onText(piece); }
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
    try { res = await claude(env).beta.messages.create(claudeRequest(env, sys, [{ role: "user", content: prompt }], maxTokens, effort, { format: { type: "json_schema", schema } })); }
    catch (e) { throw friendly(e); }
    if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
    const raw = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return { data: JSON.parse(raw), model: res.model, usage: claudeUsage(res.usage) };
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  // Llama's strict JSON mode tends to return empty defaults on long prompts, so ask for JSON in plain text and parse it.
  const instruction = `${prompt}\n\nReply with ONLY one JSON object, no prose and no code fences, matching this JSON schema:\n${JSON.stringify(schema)}`;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: llamaSystem(sys) }, { role: "user", content: instruction }], max_tokens: maxTokens });
    const got = llamaText(out);
    const raw = typeof got === "string" ? got : "";
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}");
    try {
      const data = got && typeof got === "object" ? got : JSON.parse(raw.slice(a, b + 1));
      if (data && typeof data === "object" && Object.keys(data).length) return { data, model: WORKERS_AI_MODEL, usage: llamaUsage(out.usage) };
    } catch (e) { lastErr = e; }
  }
  throw err(502, `The AI returned something unreadable${lastErr ? "" : " (empty)"}. Try again, or connect Claude under Settings → Integrations.`);
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

// ------------------------------------------------------------------ agent loop (tool use)
// Runs the model with tools until it answers. `exec(name, input)` runs one tool and resolves {ok, result}.
// Callbacks: onText(delta) for streamed words, onTool({name, input, ok, result}) after each tool call.
// Claude: full multi-step loop, streamed, append-only history (keeps thinking blocks valid).
// Workers AI (Llama): one round of tool calls, then a final answer without tools (Llama loops otherwise).
export async function agentLoop(env, system, messages, tools, exec, { maxTokens = 1200, effort = "medium", onText = () => {}, onTool = () => {}, maxSteps = 8 } = {}) {
  const sys = asSys(system);
  const usage = { input: 0, output: 0, cached: 0 };
  const add = (u) => { usage.input += u.input; usage.output += u.output; usage.cached += u.cached; };
  const actions = [];
  if (env.ANTHROPIC_API_KEY) {
    const client = claude(env);
    const convo = [...messages];
    let text = "", model = claudeModel(env);
    for (let step = 0; step < maxSteps; step++) {
      let res;
      try {
        const stream = client.beta.messages.stream({ ...claudeRequest(env, sys, convo, maxTokens, effort), tools: tools.anthropic });
        stream.on("text", (t) => { text += t; onText(t); });
        res = await stream.finalMessage();
      } catch (e) { throw friendly(e); }
      model = res.model; add(claudeUsage(res.usage));
      if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
      if (res.stop_reason === "pause_turn") { convo.push({ role: "assistant", content: res.content }); continue; }
      const calls = res.content.filter((b) => b.type === "tool_use");
      if (!calls.length || res.stop_reason !== "tool_use") break;
      convo.push({ role: "assistant", content: res.content });
      const results = await Promise.all(calls.map(async (c) => {
        const r = await exec(c.name, c.input);
        const a = { name: c.name, input: c.input, ok: r.ok, result: r.result };
        actions.push(a); onTool(a);
        return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(r.result).slice(0, 20000), ...(r.ok ? {} : { is_error: true }) };
      }));
      convo.push({ role: "user", content: results }); // every result in one message keeps parallel calls working
      if (text && !/\s$/.test(text)) { text += "\n\n"; onText("\n\n"); }
    }
    return { text: text.trim(), model, usage, actions };
  }
  if (!env.AI) throw err(503, "No AI configured: add an Anthropic key under Settings → Integrations");
  // Llama makes one call per round: allow a few rounds, stop when it repeats itself, then answer without tools.
  const base = [{ role: "system", content: llamaSystem(sys) }, ...messages];
  const convo = [...base], seen = new Set();
  for (let round = 0; round < 4; round++) {
    const res = await env.AI.run(WORKERS_AI_MODEL, { messages: convo, tools: tools.llama, max_tokens: maxTokens });
    add(llamaUsage(res.usage));
    const calls = (res.choices?.[0]?.message?.tool_calls || res.tool_calls || []).slice(0, 5);
    if (!calls.length) {
      if (round === 0) { const t = String(llamaText(res) || "").trim(); onText(t); return { text: t, model: WORKERS_AI_MODEL, usage, actions }; }
      break;
    }
    const lines = [];
    let fresh = 0;
    for (const c of calls) {
      const name = c.function?.name || c.name;
      let input = c.function?.arguments ?? c.arguments ?? {};
      if (typeof input === "string") { try { input = JSON.parse(input || "{}"); } catch { input = null; } }
      const key = `${name}:${JSON.stringify(input)}`;
      if (seen.has(key)) continue;
      seen.add(key); fresh++;
      const r = await exec(name, input);
      const a = { name, input, ok: r.ok, result: r.result };
      actions.push(a); onTool(a);
      lines.push(`<tool_result name="${name}" ok="${r.ok}">${JSON.stringify(r.result).slice(0, 6000)}</tool_result>`);
    }
    if (!fresh) break;
    convo.push({ role: "assistant", content: `I used: ${actions.slice(-fresh).map((a) => `${a.name}(${JSON.stringify(a.input)})`).join("; ")}` });
    convo.push({ role: "user", content: `${lines.join("\n")}\nThose tools have run. If my request needs another, different tool (for example a second change I asked for), call it now. Otherwise reply with no tool call.` });
  }
  const budget = Math.floor(12000 / Math.max(1, actions.length));
  const done = actions.map((a) => `${a.result?.queued ? "QUEUED FOR APPROVAL (not done yet)" : a.ok ? "DONE" : "FAILED"}: ${a.name} ${JSON.stringify(a.input)}\nresult: ${JSON.stringify(a.result).slice(0, budget)}`).join("\n\n");
  const followUp = [...base,
    { role: "assistant", content: "(I used my tools.)" },
    { role: "user", content: `What your tools actually did:\n${done || "nothing"}\nNow answer me directly, using the results. Only say you changed something if it is listed as DONE; if it is QUEUED FOR APPROVAL, say it is waiting for my OK in the Inbox; if part of my request wasn't done, say so plainly.` }];
  const body = await env.AI.run(WORKERS_AI_MODEL, { messages: followUp, max_tokens: maxTokens, stream: true });
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "", text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
      try { const j = JSON.parse(line.slice(5)); const piece = j.response ?? j.choices?.[0]?.delta?.content; if (piece) { text += piece; onText(piece); } if (j.usage) add(llamaUsage(j.usage)); } catch { /* partial */ }
    }
  }
  return { text: text.trim(), model: WORKERS_AI_MODEL, usage, actions };
}
