const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
// No 0/O/1/I/L — ref codes get read aloud and typed into WhatsApp.
const REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomString(len: number, alphabet: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Time-sortable id: base36 ms timestamp + 10 random chars. */
export function newId(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${randomString(10, ALPHABET)}`;
}

export const newRefCode = () => randomString(6, REF_ALPHABET);

export const REF_CODE_RE = /\b([A-HJ-NP-Z2-9]{6})\b/;
