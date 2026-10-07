// AI layer. Claude when ANTHROPIC_API_KEY is set; otherwise Cloudflare Workers AI (no key needed).
// Speech: Whisper (Workers AI) for speech-to-text; ElevenLabs for text-to-speech, with Deepgram Aura as fallback.
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

// ElevenLabs voices per speaker. Josh uses JOSH_VOICE_ID (set it to Josh's cloned voice); the simulator owners
// use ElevenLabs stock voices that fit each character.
const ELEVEN_MODEL = "eleven_multilingual_v2";
const ELEVEN_VOICES = {
  arcas: (env) => env.JOSH_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb", // Josh
  angus: () => "pqHfZKP75CvOlQylNhV4", // Frank Dalton: older American man
  athena: () => "XrExE9yKIg1WjnnlVkGX", // Dr. Susan Park: warm, measured woman
  zeus: () => "onwK4e9ZLuTAKqWW03F9", // Robert Hughes: older British man
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
