const enc = new TextEncoder();

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256(input: string) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(input)));
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacHex(secret: string, data: string) {
  return toHex(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `payload.signature` tokens for links and the admin session cookie. */
export async function signToken(secret: string, payload: string) {
  const sig = (await hmacHex(secret, payload)).slice(0, 32);
  return `${payload}.${sig}`;
}

export async function verifyToken(secret: string, token: string): Promise<string | null> {
  const i = token.lastIndexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const expected = (await hmacHex(secret, payload)).slice(0, 32);
  return safeEqual(expected, token.slice(i + 1)) ? payload : null;
}

/** Deterministic 0..1 from a string — sticky A/B bucketing without storage. */
export async function unitHash(input: string) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return new DataView(digest).getUint32(0) / 0x1_0000_0000;
}

/** Normalise + hash PII the way Meta / Google expect (lowercase, trimmed, SHA-256). */
export async function hashPII(value: string | null | undefined, kind: 'email' | 'phone' | 'name' | 'plain' = 'plain') {
  if (!value) return undefined;
  let v = value.trim().toLowerCase();
  if (kind === 'phone') v = v.replace(/\D/g, '');
  if (kind === 'name') v = v.replace(/[^\p{L}]/gu, '');
  return v ? sha256(v) : undefined;
}
