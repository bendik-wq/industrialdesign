// One scoring model for every country. Each provider fills in what its registry publishes;
// missing facts simply don't score (and the UI says "not published" rather than guessing).
//
// Succession (0–100): how likely the owner sells in the next 1–5 years.
// Size (0–100): how much business there is to buy.
// Fit = 55% succession + 45% size, minus a penalty for companies too big for a small buyer.

// Workers freeze Date at module load (epoch 0), so always read the clock at call time.
const thisYear = () => new Date().getUTCFullYear();
const LEADER_ROLE = /g[ée]rant|pr[ée]sident|directeur g|daglig leder|styrets leder|innehaver|owner|director|ceo|managing|member|partner|proprietor|licen[cs]e/i;

export function ageOf(p) {
  return p?.birthYear ? thisYear() - p.birthYear - (p.birthMonth && p.birthMonth > new Date().getUTCMonth() + 1 ? 1 : 0) : null;
}

export function score(c) {
  const YEAR = thisYear();
  const signals = [];
  const add = (type, label, pts, detail) => signals.push({ type, label, pts, detail });
  const people = (c.people || []).filter((p) => p.name);
  const leaders = people.filter((p) => LEADER_ROLE.test(p.role || "")).length ? people.filter((p) => LEADER_ROLE.test(p.role || "")) : people;
  const aged = leaders.filter((p) => p.birthYear).sort((a, b) => a.birthYear - b.birthYear);
  const owner = aged[0] || leaders[0] || null;
  const ownerAge = ageOf(aged[0]);
  const companyAge = c.founded ? YEAR - c.founded : null;

  // ---- succession ----
  let s = 0;
  if (ownerAge != null) {
    const pts = ownerAge >= 70 ? 50 : ownerAge >= 65 ? 45 : ownerAge >= 60 ? 36 : ownerAge >= 55 ? 24 : ownerAge >= 50 ? 10 : 0;
    if (pts) { s += pts; add("succession", `Owner is ${ownerAge}`, pts, `${owner.name} (${owner.role || "director"}), born ${owner.birthYear}`); }
    else add("succession", `Owner is ${ownerAge}`, 0, "Younger owner: less likely to sell soon");
  } else if (c.licensedSince) {
    const t = YEAR - c.licensedSince;
    const pts = t >= 35 ? 40 : t >= 25 ? 30 : t >= 15 ? 12 : 0;
    if (pts) { s += pts; add("succession", `Licensed ~${t} years`, pts, `Lead license ≈ ${c.licensedSince}; owner likely ${t >= 35 ? "60+" : "50s–60s"}`); }
  }
  if (companyAge >= 30) { s += 20; add("succession", `Founded ${c.founded}`, 20, `${companyAge} years old`); }
  else if (companyAge >= 20) { s += 12; add("succession", `Founded ${c.founded}`, 12, `${companyAge} years old`); }
  else if (companyAge >= 10) { s += 5; add("succession", `Founded ${c.founded}`, 5, `${companyAge} years old`); }
  if (people.length === 1) { s += 10; add("succession", "One person runs it", 10, "Only one person on record: key-person dependency"); }
  const surname = owner?.name?.split(/\s+/).find((w) => w === w.toUpperCase() && w.length > 2) || owner?.name?.split(/\s+/).at(-1);
  if (surname && surname.length > 2 && c.name.toUpperCase().includes(surname.toUpperCase())) {
    s += 8; add("succession", "Company carries the owner's name", 8, `"${surname}": brand depends on the owner`);
  }
  if (ownerAge >= 55 && surname) {
    const heir = leaders.find((p) => p !== owner && ageOf(p) != null && ageOf(p) < 45 && p.name.toUpperCase().includes(surname.toUpperCase()));
    if (heir) { s -= 15; add("succession", "Family successor in place", -15, `${heir.name} (${ageOf(heir)}) is also in management`); }
  }
  for (const x of c.extraSuccession || []) { s += x.pts; add("succession", x.label, x.pts, x.detail); }

  // ---- size ----
  let z = 0;
  const staff = c.employeesMin ?? c.employees;
  if (staff != null) {
    const pts = staff >= 100 ? 60 : staff >= 50 ? 52 : staff >= 20 ? 42 : staff >= 10 ? 32 : staff >= 5 ? 18 : staff >= 1 ? 6 : 0;
    if (pts) { z += pts; add("size", `${c.employeesBand || staff} employees`, pts, "Registered headcount"); }
  }
  if (c.establishments >= 5) { z += 18; add("size", `${c.establishments} locations`, 18, "Multi-site operator"); }
  else if (c.establishments >= 2) { z += 12; add("size", `${c.establishments} locations`, 12, "More than one site"); }
  if (c.revenue) {
    const m = c.revenue / 1e6;
    const pts = m >= 10 ? 20 : m >= 3 ? 14 : m >= 1 ? 8 : 0;
    if (pts) { z += pts; add("size", `Revenue ${fmtMoney(c.revenue, c.currency)}`, pts, `Reported ${c.revenueYear}`); }
  }
  if (c.reviews >= 300) { z += 20; add("size", `${c.reviews} Google reviews`, 20, `Rated ${c.rating}: high customer volume`); }
  else if (c.reviews >= 100) { z += 14; add("size", `${c.reviews} Google reviews`, 14, `Rated ${c.rating}`); }
  else if (c.reviews >= 30) { z += 6; add("size", `${c.reviews} Google reviews`, 6, `Rated ${c.rating}`); }
  for (const x of c.extraSize || []) { z += x.pts; add("size", x.label, x.pts, x.detail); }
  if (companyAge >= 15) { z += 6; add("size", "Established customer base", 6, `${companyAge} years trading`); }

  const succession = clamp(s);
  const size = clamp(z);
  let fit = Math.round(0.55 * succession + 0.45 * size);
  if (staff >= 250) { fit -= 15; add("flag", "Too big for most buyers", -15, "250+ staff: likely PE-backed or priced at large-company multiples"); }
  if (c.excluded) fit = 0;
  fit = clamp(fit);

  return {
    ownerName: owner?.name || null,
    ownerAge,
    successionScore: succession,
    sizeScore: size,
    fitScore: fit,
    verdict: fit >= 65 ? "Strong target" : fit >= 50 ? "Worth a call" : fit >= 35 ? "Watch list" : "Long shot",
    summary: summarize(c, owner, ownerAge, companyAge),
    signals,
  };
}

function summarize(c, owner, ownerAge, companyAge) {
  const bits = [];
  if (owner && ownerAge != null) bits.push(`${owner.name} is ${ownerAge}`);
  else if (owner) bits.push(`Run by ${owner.name}`);
  if (c.founded) bits.push(`founded ${c.founded}${companyAge >= 20 ? ` (${companyAge} yrs)` : ""}`);
  else if (c.licensedSince) bits.push(`licensed since ~${c.licensedSince}`);
  if (c.employeesBand || c.employees != null) bits.push(`${c.employeesBand || c.employees} staff`);
  if (c.establishments >= 2) bits.push(`${c.establishments} sites`);
  if (c.revenue) bits.push(`${fmtMoney(c.revenue, c.currency)} revenue`);
  return bits.join(" · ");
}

export function fmtMoney(v, cur = "EUR") {
  const sym = { EUR: "€", GBP: "£", USD: "$", NOK: "NOK " }[cur] ?? "";
  return v >= 1e6 ? `${sym}${(v / 1e6).toFixed(1)}M` : `${sym}${Math.round(v / 1e3)}k`;
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
