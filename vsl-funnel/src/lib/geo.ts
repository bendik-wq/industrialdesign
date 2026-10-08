export interface Geo {
  country: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  continent: string | null;
  isEU: boolean;
  asn: number | null;
  asOrg: string | null;
  colo: string | null;
  httpProtocol: string | null;
  tlsVersion: string | null;
}

/** Everything Cloudflare knows about the connection, from request.cf. */
export function geoFromRequest(req: Request): Geo {
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v));
  return {
    country: (cf?.country as string) ?? req.headers.get('cf-ipcountry'),
    region: cf?.region ?? null,
    city: cf?.city ?? null,
    postalCode: cf?.postalCode ?? null,
    timezone: cf?.timezone ?? null,
    latitude: num(cf?.latitude),
    longitude: num(cf?.longitude),
    continent: cf?.continent ?? null,
    isEU: cf?.isEUCountry === '1',
    asn: num(cf?.asn),
    asOrg: cf?.asOrganization ?? null,
    colo: cf?.colo ?? null,
    httpProtocol: cf?.httpProtocol ?? null,
    tlsVersion: cf?.tlsVersion ?? null,
  };
}

/** Hosting / datacenter ASNs — traffic from these is almost never a real prospect. */
const DATACENTER_ORG = /amazon|aws|google cloud|googlecloud|microsoft azure|digitalocean|linode|akamai|ovh|hetzner|vultr|oracle cloud|alibaba|tencent cloud|contabo|leaseweb|choopa|m247|datacamp|scaleway/i;
export const isDatacenter = (g: Geo) => Boolean(g.asOrg && DATACENTER_ORG.test(g.asOrg));
