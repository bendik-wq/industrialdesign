// AI layer. Claude when ANTHROPIC_API_KEY is set; otherwise Cloudflare Workers AI (no key needed).
// Speech: Whisper for speech-to-text, Deepgram Aura for text-to-speech, both on Workers AI.
import Anthropic from "@anthropic-ai/sdk";
import { Buffer } from "node:buffer";

const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const TTS_MODEL = "@cf/deepgram/aura-1";

const err = (status, message) => Object.assign(new Error(message), { status });

// messages: [{role: "user"|"assistant", content: string}], oldest first, ending with the user's turn.
export async function chat(env, system, messages, maxTokens = 1200) {
  if (env.ANTHROPIC_API_KEY) {
    const res = await new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }).beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: Math.max(4000, maxTokens * 2), // headroom for adaptive thinking
      output_config: { effort: "low" }, // conversational; latency matters more than depth
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages,
    });
    if (res.stop_reason === "refusal") throw err(422, "The model declined this request");
    return { text: res.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), model: res.model };
  }
  if (!env.AI) throw err(503, "No AI configured: add ANTHROPIC_API_KEY or the Workers AI binding");
  const out = await env.AI.run(WORKERS_AI_MODEL, { messages: [{ role: "system", content: system }, ...messages], max_tokens: maxTokens });
  return { text: String(out.response || "").trim(), model: WORKERS_AI_MODEL };
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

export async function speak(env, text, speaker = "orion") {
  if (!env.AI) throw err(503, "Voice needs the Workers AI binding");
  const clean = String(text).replace(/[#*_`>]/g, "").replace(/\n{2,}/g, ".\n").slice(0, 1900);
  return env.AI.run(TTS_MODEL, { text: clean, speaker: SPEAKERS.includes(speaker) ? speaker : "orion", encoding: "mp3" });
}
