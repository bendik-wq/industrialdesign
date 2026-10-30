// Territory maths for the densification map. Pure functions, shared by the browser (live what-ifs while you drag a
// radius) and the server (the API and Josh's tools), so both always agree.
//
// Grounded in the JL skill's Monopoly Method: "Pick fragmented vertical in large metro area", buy, "Return to Step 3
// and repeat", where market share drives the exit ("10 businesses = 1% market share → $5-10M exit"). Concentrating
// in one metro first is what makes the local monopoly: each tuck-in shares the techs, vans, office and brand already
// there. A deal far from everything is a new region, which the skill's company structure runs as its own "arm"
// ("Geographic expansion (each region = arm)").
//
// Population: GeoNames places with 1,000+ people (CC BY 4.0). A place's people are spread over a disk sized for an
// urban density of 2,000 people per km²; suburbs ("sections") carry their own people and the parent city keeps the
// rest, so metros get street-level resolution without double counting. Figures are estimates and labelled ≈.

const KM_PER_DEG = 111.32;
const DENSITY = 2000;
const rad = (d) => (d * Math.PI) / 180;

export function km(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}
const offset = (p, dxKm, dyKm) => ({ lat: p.lat + dyKm / KM_PER_DEG, lng: p.lng + dxKm / (KM_PER_DEG * Math.max(0.05, Math.cos(rad(p.lat)))) });
export const areaKm2 = (r) => Math.PI * r * r;
export const footprintKm = (pop) => Math.max(0.4, Math.sqrt(pop / DENSITY / Math.PI));

// Equal-area sample points in a unit disk (Vogel's spiral): fraction covered = share of points covered.
const spiral = (n) => Array.from({ length: n }, (_, i) => { const r = Math.sqrt((i + 0.5) / n), t = i * 2.399963; return [r * Math.cos(t), r * Math.sin(t)]; });
const S24 = spiral(24), S64 = spiral(64);

// ------------------------------------------------------------------ population tiles
export const tileKey = (lat, lng) => `${Math.floor(lat / 5)}_${Math.floor(lng / 5)}`;
export function tilesFor(circles, padKm = 0) {
  const keys = new Set();
  for (const c of circles) {
    const r = (c.radius_km || 0) + padKm;
    const dLat = r / KM_PER_DEG, dLng = r / (KM_PER_DEG * Math.max(0.05, Math.cos(rad(c.lat))));
    for (let a = Math.floor((c.lat - dLat) / 5); a <= Math.floor((c.lat + dLat) / 5); a++)
      for (let b = Math.floor((c.lng - dLng) / 5); b <= Math.floor((c.lng + dLng) / 5); b++) keys.add(`${a}_${b}`);
  }
  return [...keys];
}

// Rows from the tiles → places with a footprint. A city's figure includes its suburbs, so the suburbs inside its
// footprint keep their own people and the city keeps what's left.
export function preparePlaces(rows) {
  const all = rows.map(([la, ln, pop, name, kind]) => ({ lat: la / 1e4, lng: ln / 1e4, pop, name, kind }));
  const cities = all.filter((p) => p.kind === "c").sort((a, b) => b.pop - a.pop);
  const sections = all.filter((p) => p.kind === "s");
  for (const c of cities) { c.rest = c.pop; c.r = footprintKm(c.pop); }
  for (const s of sections) {
    s.r = footprintKm(s.pop); s.rest = s.pop;
    const parent = cities.find((c) => c.pop > s.pop && km(c, s) <= c.r);
    if (parent) parent.rest = Math.max(parent.pop * 0.15, parent.rest - s.pop);
  }
  for (const c of cities) c.pop = Math.round(c.rest);
  return [...cities, ...sections].map(({ rest, ...p }) => p);
}

// ------------------------------------------------------------------ coverage
const inCircle = (p, c) => km(p, c) <= c.radius_km;
export const covered = (p, circles) => circles.some((c) => inCircle(p, c));

function fracCovered(place, circles) {
  let near = false;
  for (const c of circles) {
    const d = km(place, c);
    if (d + place.r <= c.radius_km) return 1;
    if (d < c.radius_km + place.r) near = true;
  }
  if (!near) return 0;
  let hit = 0;
  for (const [x, y] of S24) if (covered(offset(place, x * place.r, y * place.r), circles)) hit++;
  return hit / S24.length;
}
export function peopleIn(circles, places) {
  if (!circles.length) return 0;
  let n = 0;
  for (const p of places) n += p.pop * fracCovered(p, circles);
  return Math.round(n);
}
// Share of circle `c` already covered by `others`.
export function overlap(c, others) {
  if (!others.length) return 0;
  let hit = 0;
  for (const [x, y] of S64) if (covered(offset(c, x * c.radius_km, y * c.radius_km), others)) hit++;
  return hit / S64.length;
}
// Area of the union of circles, by sampling a grid over their bounding box.
export function unionKm2(circles) {
  if (!circles.length) return 0;
  if (circles.length === 1) return areaKm2(circles[0].radius_km);
  const lats = circles.flatMap((c) => [c.lat - c.radius_km / KM_PER_DEG, c.lat + c.radius_km / KM_PER_DEG]);
  const lat0 = Math.min(...lats), lat1 = Math.max(...lats);
  const k = KM_PER_DEG * Math.max(0.05, Math.cos(rad((lat0 + lat1) / 2)));
  const lngs = circles.flatMap((c) => [c.lng - c.radius_km / k, c.lng + c.radius_km / k]);
  const lng0 = Math.min(...lngs), lng1 = Math.max(...lngs);
  const N = 90, hKm = ((lat1 - lat0) * KM_PER_DEG) / N, wKm = ((lng1 - lng0) * k) / N;
  let hit = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) if (covered({ lat: lat0 + ((i + 0.5) * (lat1 - lat0)) / N, lng: lng0 + ((j + 0.5) * (lng1 - lng0)) / N }, circles)) hit++;
  return hit * hKm * wKm;
}

// Sites that overlap or touch form one region (an "arm").
export function arms(sites) {
  const parent = sites.map((_, i) => i);
  const root = (i) => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++)
    if (km(sites[i], sites[j]) <= sites[i].radius_km + sites[j].radius_km) parent[root(i)] = root(j);
  const groups = new Map();
  sites.forEach((s, i) => { const r = root(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
  return [...groups.values()];
}

// ------------------------------------------------------------------ the plan
const STAGE_P = { sourced: 0.02, contacted: 0.05, first_call: 0.1, meeting: 0.2, docs: 0.35, loi: 0.5, diligence: 0.7 };
const STAGE_LABEL = { sourced: "Sourced", contacted: "Contacted", first_call: "First call", meeting: "Meeting", docs: "NDA & docs", loi: "LOI sent", diligence: "Diligence" };
export const KINDS = {
  tuckin: { label: "Tuck-in", text: "Inside your footprint: shares the team, vans, office and brand you already run, and lifts your local share." },
  extend: { label: "Extend", text: "Next to your footprint: new customers within reach of the team you already have." },
  arm: { label: "New arm", text: "A new region. The skill runs each region as its own arm, with its own manager." },
  first: { label: "First deal", text: "Your first location. Pick a big metro with many small operators to buy next." },
};
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const money = (v, cur = "$") => (v >= 1e6 ? `${cur}${(v / 1e6).toFixed(1)}M` : `${cur}${Math.round(v / 1e3)}k`);

// sites: [{id, name, lat, lng, radius_km}], targets: [{id, name, stage, lat, lng, revenue, ebitda, currency}],
// places: preparePlaces(rows), radiusKm: the default service radius for a business you'd buy.
export function plan({ sites, targets, places, radiusKm = 25 }) {
  const own = sites.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
  const open = targets.filter((t) => Number.isFinite(t.lat) && Number.isFinite(t.lng) && STAGE_P[t.stage] != null);
  const ownPeople = peopleIn(own, places);
  const groups = arms(own);
  const share = (circles, extraOwned = 0) => {
    const ops = open.filter((t) => covered(t, circles)).length;
    const ownedN = circles.length + extraOwned;
    return { owned: ownedN, operators: ops + ownedN, pct: ownedN / Math.max(1, ops + ownedN) };
  };
  const armsOut = groups.map((g, i) => ({
    id: i + 1, sites: g.map((s) => s.id), name: g.map((s) => s.name).slice(0, 2).join(" + ") + (g.length > 2 ? ` +${g.length - 2}` : ""),
    lat: g.reduce((a, s) => a + s.lat, 0) / g.length, lng: g.reduce((a, s) => a + s.lng, 0) / g.length,
    areaKm2: Math.round(unionKm2(g)), people: peopleIn(g, places), ...share(g),
  }));
  const siteOut = own.map((s) => ({ id: s.id, areaKm2: Math.round(areaKm2(s.radius_km)), people: peopleIn([s], places), operators: open.filter((t) => inCircle(t, s)).length, overlap: Math.round(overlap(s, own.filter((o) => o !== s)) * 100) }));

  // Score each open target as the next deal.
  const raw = open.map((t) => {
    const c = { lat: t.lat, lng: t.lng, radius_km: radiusKm };
    const local = places.filter((p) => km(p, c) <= radiusKm + p.r);
    const people = peopleIn([c], local);
    const near = own.map((s) => ({ s, d: km(s, t) })).sort((a, b) => a.d - b.d)[0];
    const ov = overlap(c, own);
    const inside = covered(t, own);
    let kind = "first";
    if (own.length) kind = inside && ov >= 0.5 ? "tuckin" : ov >= 0.1 || near.d <= near.s.radius_km + radiusKm * 1.25 ? "extend" : "arm";
    const added = own.length ? Math.max(0, peopleIn([...own, c], places) - ownPeople) : people;
    const size = t.ebitda > 0 ? t.ebitda * 5 : t.revenue > 0 ? t.revenue : 0;
    return { t, c, kind, people, added, near, ov, inside, size };
  });
  const maxAdded = Math.max(1, ...raw.map((r) => r.added)), maxSize = Math.max(1, ...raw.map((r) => r.size)), maxPeople = Math.max(1, ...raw.map((r) => r.people));
  const lg = (v, m) => (v > 0 ? Math.log1p(v) / Math.log1p(m) : 0);
  const ranked = raw.map((r) => {
    const { t, kind, near } = r;
    // Fit: concentrate first (tuck-in, extend), then new regions, closer ones before far ones.
    const fit = kind === "tuckin" ? 1 : kind === "extend" ? 0.85 : kind === "first" ? 0.5 + 0.5 * lg(r.people, maxPeople)
      : 0.4 * Math.exp(-Math.max(0, near.d - (near.s.radius_km + radiusKm)) / (4 * radiusKm));
    const reach = lg(r.added, maxAdded), size = r.size ? lg(r.size, maxSize) : 0.35, momentum = Math.min(1, STAGE_P[t.stage] / 0.7);
    // A new region is a new arm: worth doing, but after densifying, and less the further away it is.
    const armFactor = kind === "arm" ? 0.75 - 0.25 * Math.min(1, Math.max(0, near.d - (near.s.radius_km + radiusKm)) / (10 * radiusKm)) : 1;
    const score = Math.round(100 * armFactor * (0.35 * fit + 0.2 * reach + 0.25 * size + 0.2 * momentum));
    const why = [];
    if (kind === "tuckin") {
      const host = own.filter((s) => inCircle(t, s)).map((s) => s.name)[0] || near.s.name;
      const g = groups.find((gr) => gr.some((s) => inCircle(t, s))) || [near.s];
      const before = share(g), after = { owned: before.owned + 1, operators: before.operators };
      why.push(`Inside your ${host} area: shares the team, vans and office already there`);
      why.push(`Local share of known operators goes from ${before.owned}/${before.operators} to ${after.owned}/${after.operators}`);
    } else if (kind === "extend") why.push(r.ov >= 0.1 ? `${Math.round(near.d)} km from ${near.s.name}: ${Math.round(r.ov * 100)}% of its area is already in your reach` : `${Math.round(near.d)} km from ${near.s.name}, just past your edge: the same team can reach it`);
    else if (kind === "arm") why.push(`${Math.round(near.d)} km from your nearest site (${near.s.name}): a new region, run as its own arm`);
    else why.push(`≈ ${fmtN(r.people)} people within ${radiusKm} km`);
    if (r.added >= 1000 && kind !== "first") why.push(`Adds ≈ ${fmtN(r.added)} people to your reach`);
    if (t.ebitda > 0) why.push(`EBITDA ${money(t.ebitda, t.currency)}`);
    else if (t.revenue > 0) why.push(`Revenue ${money(t.revenue, t.currency)}`);
    else why.push("No financials yet: add revenue or EBITDA to score its size");
    if (STAGE_P[t.stage] >= 0.2) why.push(`At ${STAGE_LABEL[t.stage]}: further along than most`);
    return { id: t.id, name: t.name, lat: t.lat, lng: t.lng, stage: t.stage, kind, score, people: r.people, added: r.added, nearestKm: near ? Math.round(near.d) : null, nearest: near?.s.name || null, why };
  }).sort((a, b) => b.score - a.score);

  // White space: sizeable towns near your footprint with nobody in the pipeline yet.
  const whitespace = [];
  if (own.length) {
    const reachKm = Math.max(...own.map((s) => s.radius_km)) * 3 + radiusKm;
    const towns = places.filter((p) => p.pop >= 5000 && !covered(p, own) && own.some((s) => km(s, p) <= reachKm) && !open.some((t) => km(t, p) <= radiusKm));
    const scored = towns.map((p) => {
      const c = { lat: p.lat, lng: p.lng, radius_km: radiusKm };
      const near = own.map((s) => ({ s, d: km(s, p) })).sort((a, b) => a.d - b.d)[0];
      return { p, c, near, gain: Math.max(0, peopleIn([...own, c], places.filter((q) => km(q, c) <= radiusKm + q.r)) - peopleIn(own, places.filter((q) => km(q, c) <= radiusKm + q.r))) };
    }).sort((a, b) => b.gain - a.gain);
    for (const w of scored) {
      if (whitespace.length >= 6) break;
      if (w.gain < 5000 || whitespace.some((x) => km(x, w.p) < radiusKm)) continue;
      whitespace.push({ name: w.p.name, lat: w.p.lat, lng: w.p.lng, people: w.gain, nearestKm: Math.round(w.near.d), nearest: w.near.s.name, adjacent: w.near.d <= w.near.s.radius_km + radiusKm * 1.25 });
    }
  }
  const total = share(own);
  return {
    radiusKm,
    summary: { sites: own.length, areaKm2: Math.round(unionKm2(own)), people: ownPeople, arms: groups.length, owned: total.owned, operators: total.operators, share: total.pct, openTargets: open.length },
    arms: armsOut, sites: siteOut, ranked, whitespace,
  };
}
