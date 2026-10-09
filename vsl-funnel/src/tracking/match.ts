import { sha256 } from '../lib/crypto';

/**
 * Customer-information parameters for Meta (Conversions API + Pixel advanced
 * matching), normalised exactly as Meta specifies before SHA-256 hashing:
 * https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
 *
 * The same hashed values go to the browser Pixel and to CAPI, so both sides
 * describe the visitor identically and Meta can match and deduplicate.
 */
export interface MatchGeo {
  country: string | null;
  region: string | null;
  regionCode: string | null;
  city: string | null;
  postalCode: string | null;
}

export interface MatchPerson {
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  country?: string | null;
  city?: string | null;
}

const letters = (v: string) => v.toLowerCase().replace(/[^\p{L}]/gu, '');

export const normalise = {
  em: (v: string) => v.trim().toLowerCase(),
  // Digits only, including the country code (we store E.164).
  ph: (v: string) => v.replace(/\D/g, ''),
  fn: letters,
  ln: letters,
  ct: letters,
  // US: 2-letter state code. Elsewhere: the region name, lowercase, letters only.
  st: (region: string | null, code: string | null, country: string | null) =>
    country?.toUpperCase() === 'US' && code ? code.toLowerCase().slice(0, 2) : region ? letters(region) : '',
  // US: first 5 digits. Elsewhere: lowercase, no spaces or dashes.
  zp: (v: string, country: string | null) => (country?.toUpperCase() === 'US' ? v.replace(/\D/g, '').slice(0, 5) : v.toLowerCase().replace(/[\s-]/g, '')),
  country: (v: string) => v.trim().toLowerCase().slice(0, 2),
};

const h = async (v: string | null | undefined) => (v ? sha256(v) : undefined);

/** Hashed match keys. Location comes from the person when known, else from the visitor's IP geolocation. */
export async function hashedMatchKeys(person: MatchPerson | null, geo: Partial<MatchGeo> | null, externalIds: (string | null | undefined)[]) {
  const country = person?.country || geo?.country || null;
  const city = person?.city || geo?.city || null;
  const [em, ph, fn, ln, ct, st, zp, cc, ...ext] = await Promise.all([
    h(person?.email ? normalise.em(person.email) : null),
    h(person?.phone ? normalise.ph(person.phone) : null),
    h(person?.firstName ? normalise.fn(person.firstName) : null),
    h(person?.lastName ? normalise.ln(person.lastName) : null),
    h(city ? normalise.ct(city) : null),
    h(geo ? normalise.st(geo.region ?? null, geo.regionCode ?? null, country) : null),
    h(geo?.postalCode ? normalise.zp(geo.postalCode, country) : null),
    h(country ? normalise.country(country) : null),
    ...externalIds.filter(Boolean).map((id) => h(id)),
  ]);
  const keys: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries({ em, ph, fn, ln, ct, st, zp, country: cc })) if (v) keys[k] = v;
  const external = ext.filter((x): x is string => Boolean(x));
  if (external.length) keys.external_id = external;
  return keys;
}
