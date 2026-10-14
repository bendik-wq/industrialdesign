/** Speech-to-text on Cloudflare Workers AI (Whisper). Audio in, plain text out; nothing is stored. */
const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function transcribe(ai: Ai, audio: ArrayBuffer): Promise<string> {
  let text = '';
  try {
    const r = (await ai.run('@cf/openai/whisper-large-v3-turbo' as never, { audio: b64(audio) } as never)) as { text?: string };
    text = r?.text ?? '';
  } catch {
    // Older model takes raw bytes; used if the turbo one isn't available.
    const r = (await ai.run('@cf/openai/whisper' as never, { audio: [...new Uint8Array(audio)] } as never)) as { text?: string };
    text = r?.text ?? '';
  }
  // Drop sound tags like "(laughs)" / "[music]" and keep it to a sensible length.
  return text.replace(/\([^)]{1,30}\)|\[[^\]]{1,30}\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 2000);
}
