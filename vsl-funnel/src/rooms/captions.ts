import type { Runtime } from '../app';

/**
 * Live captions (area C). The host's browser cuts its microphone into short pieces at pauses (16 kHz mono WAV,
 * a few seconds each, silent pieces never sent) and posts each to /api/rooms/:id/captions. This module turns a
 * piece into a caption line with Workers AI Whisper (large-v3-turbo: the most accurate Whisper on Workers AI,
 * with a voice-activity filter that drops hiss and room noise), stores it in room_captions for the transcript,
 * and translates lines on demand with Workers AI m2m100 (cached per line and language in room_caption_tr).
 */

export const WHISPER = '@cf/openai/whisper-large-v3-turbo';
export const WHISPER_FALLBACK = '@cf/openai/whisper';
export const TRANSLATE = '@cf/meta/m2m100-1.2b';
/** Pieces bigger than this are refused (about 20 seconds of 16 kHz mono 16-bit WAV). */
export const MAX_PIECE_BYTES = 700_000;
export const MIN_PIECE_BYTES = 4_000;

type AiLike = { run(model: string, input: unknown): Promise<unknown> };
const b64 = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Whisper's well-known inventions on silence or music ("Thank you.", "Subtitles by...") never become captions. */
const HALLUCINATIONS = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?|\.+|subtitles? by .*|transcribed by .*|please subscribe.*|music)$/i;
export function cleanCaption(raw: string) {
  const t = String(raw ?? '').replace(/\([^)]{1,30}\)|\[[^\]]{1,30}\]|♪+/g, '').replace(/\s+/g, ' ').trim().slice(0, 600);
  return !t || HALLUCINATIONS.test(t) ? '' : t;
}

/** One piece of audio to one caption line. `prompt` (the previous line) keeps names and terms consistent. */
export async function transcribePiece(ai: AiLike, audio: ArrayBuffer, o: { prompt?: string; lang?: string } = {}) {
  const input: Record<string, unknown> = { audio: b64(audio), vad_filter: true, initial_prompt: `G&L M&A Advisory. Josh Li. Seller finance, seller rollover, commercial debt, the 1.5x test, buy box, letter of intent. ${o.prompt ?? ''}`.slice(0, 600) };
  if (o.lang) input.language = o.lang;
  let text = '';
  let lang = o.lang ?? 'en';
  try {
    const r = (await ai.run(WHISPER, input)) as { text?: string; transcription_info?: { text?: string; language?: string } };
    text = r?.text ?? r?.transcription_info?.text ?? '';
    lang = (r?.transcription_info?.language || lang).slice(0, 5);
  } catch {
    const r = (await ai.run(WHISPER_FALLBACK, { audio: [...new Uint8Array(audio)] })) as { text?: string };
    text = r?.text ?? '';
  }
  return { text: cleanCaption(text), lang: /^[a-z]{2}/.test(lang) ? lang.slice(0, 2) : 'en' };
}

/** A WAV piece we accept: RIFF/WAVE header, a sane size. */
export function validPiece(buf: ArrayBuffer) {
  if (buf.byteLength < MIN_PIECE_BYTES || buf.byteLength > MAX_PIECE_BYTES) return false;
  const h = new Uint8Array(buf, 0, 12);
  const s = (a: number, b: number) => String.fromCharCode(...h.subarray(a, b));
  return s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE';
}

type Rt = Pick<Runtime, 'env'>;
export async function saveCaption(rt: Rt, roomId: string, tMs: number, text: string, lang: string) {
  await rt.env.DB.prepare('INSERT INTO room_captions (room_id, t_ms, text, lang) VALUES (?, ?, ?, ?)').bind(roomId, Math.max(0, Math.round(tMs)), text, lang).run();
}
export async function captionsSince(rt: Rt, roomId: string, sinceMs: number, limit = 40) {
  const r = await rt.env.DB.prepare('SELECT t_ms, text, lang FROM room_captions WHERE room_id = ? AND t_ms >= ? ORDER BY t_ms LIMIT ?').bind(roomId, sinceMs, limit).all<{ t_ms: number; text: string; lang: string }>();
  return r.results;
}

/** One line in one language: the cache first, then m2m100 (once per line and language, whoever asks). */
export async function translateLine(rt: Rt & { env: { AI?: unknown } }, roomId: string, line: { t_ms: number; text: string; lang: string }, target: string): Promise<string | null> {
  if (!/^[a-z]{2}$/.test(target) || target === line.lang) return line.text;
  const db = rt.env.DB;
  const hit = await db.prepare('SELECT text FROM room_caption_tr WHERE room_id = ? AND t_ms = ? AND lang = ?').bind(roomId, line.t_ms, target).first<{ text: string }>().catch(() => null);
  if (hit) return hit.text;
  const ai = rt.env.AI as AiLike | undefined;
  if (!ai) return null;
  let out = '';
  try {
    const r = (await ai.run(TRANSLATE, { text: line.text, source_lang: line.lang, target_lang: target })) as { translated_text?: string };
    out = String(r?.translated_text ?? '').replace(/\s+/g, ' ').trim().slice(0, 800);
  } catch { return null; }
  if (!out) return null;
  await db.prepare('INSERT INTO room_caption_tr (room_id, t_ms, lang, text) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(roomId, line.t_ms, target, out).run().catch(() => null);
  return out;
}
