// Calling hours: when is it OK to ring this owner? Shared by the server (which refuses to place calls outside the
// window) and the dialer (which shows each owner's local time and sorts the callable ones first).
//   Window   08:00–21:00 in the owner's local time, 08:00–20:00 in states with stricter telemarketing hours
//            (FL, OK, MD, WA, MS, AL), no Sundays unless the workspace turns them on. A conservative default
//            for cold calls, not legal advice.
//   Zones    from the location ("Austin, TX", "Perth WA"), else the US/Canadian area code or Australian
//            area code, else the country. States that span two time zones must be inside the window in both.

const NY = "America/New_York", CHI = "America/Chicago", DEN = "America/Denver", LA = "America/Los_Angeles", PHX = "America/Phoenix", BOI = "America/Boise";
export const US_ZONES = {
  AL: [CHI], AK: ["America/Anchorage"], AZ: [PHX], AR: [CHI], CA: [LA], CO: [DEN], CT: [NY], DE: [NY], DC: [NY], FL: [NY, CHI], GA: [NY], HI: ["Pacific/Honolulu"],
  ID: [BOI, LA], IL: [CHI], IN: ["America/Indiana/Indianapolis", CHI], IA: [CHI], KS: [CHI, DEN], KY: [NY, CHI], LA: [CHI], ME: [NY], MD: [NY], MA: [NY],
  MI: ["America/Detroit", CHI], MN: [CHI], MS: [CHI], MO: [CHI], MT: [DEN], NE: [CHI, DEN], NV: [LA], NH: [NY], NJ: [NY], NM: [DEN], NY: [NY], NC: [NY],
  ND: [CHI, DEN], OH: [NY], OK: [CHI], OR: [LA, BOI], PA: [NY], RI: [NY], SC: [NY], SD: [CHI, DEN], TN: [CHI, NY], TX: [CHI, DEN], UT: [DEN], VT: [NY],
  VA: [NY], WA: [LA], WV: [NY], WI: [CHI], WY: [DEN],
};
// In split states the first zone is where most people live; these cities are in the other one.
const CITY_ZONE = {
  "el paso": DEN, "horizon city": DEN, "socorro": DEN, pensacola: CHI, "panama city": CHI, "panama city beach": CHI, "fort walton beach": CHI, destin: CHI, navarre: CHI, crestview: CHI, "niceville": CHI, "milton": CHI,
  gary: CHI, hammond: CHI, "merrillville": CHI, evansville: CHI, "valparaiso": CHI, "bowling green": CHI, paducah: CHI, owensboro: CHI, "hopkinsville": CHI, knoxville: NY, chattanooga: NY, "johnson city": NY,
  kingsport: NY, bristol: NY, "cleveland": NY, "coeur d'alene": LA, "lewiston": LA, "moscow": LA, "rapid city": DEN, "spearfish": DEN, scottsbluff: DEN, "sidney": DEN, dickinson: DEN, "goodland": DEN,
  menominee: CHI, "iron mountain": CHI, "ironwood": CHI, "ontario": BOI,
};
const CA_ZONES = { BC: ["America/Vancouver"], AB: ["America/Edmonton"], SK: ["America/Regina"], MB: ["America/Winnipeg"], ON: ["America/Toronto"], QC: ["America/Toronto"], NB: ["America/Halifax"], NS: ["America/Halifax"], PE: ["America/Halifax"], NL: ["America/St_Johns"] };
const AU_ZONES = { NSW: ["Australia/Sydney"], ACT: ["Australia/Sydney"], VIC: ["Australia/Melbourne"], TAS: ["Australia/Hobart"], QLD: ["Australia/Brisbane"], SA: ["Australia/Adelaide"], NT: ["Australia/Darwin"], WA: ["Australia/Perth"] };
const STATE_NAMES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI",
  idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const PROVINCE_NAMES = { "british columbia": "BC", alberta: "AB", saskatchewan: "SK", manitoba: "MB", ontario: "ON", quebec: "QC", "québec": "QC", "new brunswick": "NB", "nova scotia": "NS", "prince edward island": "PE", newfoundland: "NL" };
const AU_NAMES = { "new south wales": "NSW", victoria: "VIC", queensland: "QLD", "south australia": "SA", "western australia": "WA", tasmania: "TAS", "northern territory": "NT", "australian capital territory": "ACT" };

// North American area codes by state/province (numbers move with people, so the location wins when we have it).
const NANP = {
  AL: "205 251 256 334 659 938", AK: "907", AZ: "480 520 602 623 928", AR: "327 479 501 870", CA: "209 213 279 310 323 341 350 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669 707 714 747 760 805 818 820 831 840 858 909 916 925 949 951",
  CO: "303 719 720 970 983", CT: "203 475 860 959", DE: "302", DC: "202 771", FL: "239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 850 863 904 941 954", GA: "229 404 470 478 678 706 762 770 912 943",
  HI: "808", ID: "208 986", IL: "217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872", IN: "219 260 317 463 574 765 812 930", IA: "319 515 563 641 712", KS: "316 620 785 913", KY: "270 364 502 606 859",
  LA: "225 318 337 504 985", ME: "207", MD: "227 240 301 410 443 667", MA: "339 351 413 508 617 774 781 857 978", MI: "231 248 269 313 517 586 616 679 734 810 906 947 989", MN: "218 320 507 612 651 763 952",
  MS: "228 601 662 769", MO: "314 417 557 573 636 660 816 975", MT: "406", NE: "308 402 531", NV: "702 725 775", NH: "603", NJ: "201 551 609 640 732 848 856 862 908 973", NM: "505 575",
  NY: "212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934", NC: "252 336 472 704 743 828 910 919 980 984", ND: "701", OH: "216 220 234 283 326 330 380 419 436 440 513 567 614 740 937",
  OK: "405 539 572 580 918", OR: "458 503 541 971", PA: "215 223 267 272 412 445 484 570 582 610 717 724 814 835 878", RI: "401", SC: "803 821 839 843 854 864", SD: "605", TN: "423 615 629 731 865 901 931",
  TX: "210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 915 936 940 945 956 972 979", UT: "385 435 801", VT: "802", VA: "276 434 540 571 686 703 757 804 826 948",
  WA: "206 253 360 425 509 564", WV: "304 681", WI: "262 274 353 414 534 608 715 920", WY: "307",
  "CA-BC": "236 250 604 672 778", "CA-AB": "368 403 587 780 825", "CA-SK": "306 474 639", "CA-MB": "204 431 584", "CA-ON": "226 249 289 343 365 382 416 437 519 548 613 647 683 705 742 753 807 905",
  "CA-QC": "263 354 367 418 438 450 468 514 579 581 819 873", "CA-NS": "782 902", "CA-NB": "506", "CA-NL": "709",
};
const AREA = {};
for (const [region, codes] of Object.entries(NANP)) for (const c of codes.split(" ")) AREA[c] = region;
// Area codes in split states that sit wholly in one zone (the rest keep both).
const AREA_ZONE = { 915: DEN, 850: null, 423: NY, 865: NY, 615: CHI, 629: CHI, 731: CHI, 901: CHI, 931: CHI, 270: CHI, 364: CHI, 502: NY, 606: NY, 859: NY, 219: CHI, 260: "America/Indiana/Indianapolis", 317: "America/Indiana/Indianapolis", 463: "America/Indiana/Indianapolis", 574: "America/Indiana/Indianapolis", 765: "America/Indiana/Indianapolis", 316: CHI, 785: CHI, 913: CHI, 402: CHI, 531: CHI, 503: LA, 971: LA };
// Australian landline prefixes (mobiles, 04, say nothing about where someone is).
const AU_AREA = { 2: ["NSW"], 3: ["VIC"], 7: ["QLD"], 8: ["SA", "WA"] };

// Stricter state hours: these end at 8pm.
const END_8PM = new Set(["FL", "OK", "MD", "WA", "MS", "AL"]);
export const RULES = { start: 8, end: 21 };

const COUNTRY = { "1": null, "44": { country: "UK", zones: ["Europe/London"] }, "61": null, "49": { country: "DE", zones: ["Europe/Berlin"] }, "353": { country: "IE", zones: ["Europe/Dublin"] } };
const CURRENCY_ZONES = { "£": { country: "UK", zones: ["Europe/London"] }, "€": { country: "DE", zones: ["Europe/Berlin"] } };

// With a city we know the zone; with only a state that spans two, both have to be inside the window.
function usZones(code, loc) {
  const zones = US_ZONES[code];
  if (zones.length < 2) return zones;
  const city = String(loc).split(",")[0].trim().toLowerCase().replace(/\s+\d{5}.*$/, "");
  if (!city || city === code.toLowerCase() || STATE_NAMES[city] === code) return zones;
  return [CITY_ZONE[city] && zones.includes(CITY_ZONE[city]) ? CITY_ZONE[city] : zones[0]];
}
function fromLocation(loc, currency) {
  const s = String(loc || "").trim();
  if (!s) return null;
  const low = s.toLowerCase();
  // The deal currency settles "Perth WA" (Australia) vs "Seattle, WA".
  const isAU = /\baustralia\b/.test(low) || currency === "A$", isCA = /\bcanada\b/.test(low) || currency === "C$", isUK = /\b(united kingdom|uk|england|scotland|wales|northern ireland)\b/.test(low);
  if (isUK) return { country: "UK", region: "UK", zones: ["Europe/London"] };
  if (/\b(germany|deutschland)\b/.test(low)) return { country: "DE", region: "DE", zones: ["Europe/Berlin"] };
  if (/\bireland\b/.test(low)) return { country: "IE", region: "IE", zones: ["Europe/Dublin"] };
  // Two- or three-letter codes after a comma or space: "Austin, TX 78701", "Perth WA 6000", "Toronto, ON".
  for (const tok of s.split(/[\s,]+/).reverse()) {
    const t = tok.toUpperCase();
    if (!isCA && !isAU && US_ZONES[t] && tok === t) return { country: "US", region: t, zones: usZones(t, s) };
    if (!isAU && CA_ZONES[t] && tok === t && (isCA || !US_ZONES[t])) return { country: "CA", region: t, zones: CA_ZONES[t] };
    if (AU_ZONES[t] && tok === t && (isAU || !US_ZONES[t])) return { country: "AU", region: t, zones: AU_ZONES[t] };
  }
  for (const [name, code] of Object.entries(AU_NAMES)) if (low.includes(name) && (isAU || !STATE_NAMES[name])) return { country: "AU", region: code, zones: AU_ZONES[code] };
  for (const [name, code] of Object.entries(PROVINCE_NAMES)) if (low.includes(name)) return { country: "CA", region: code, zones: CA_ZONES[code] };
  // Longest names first so "west virginia" beats "virginia".
  for (const name of Object.keys(STATE_NAMES).sort((a, b) => b.length - a.length)) if (new RegExp(`\\b${name}\\b`).test(low)) { const code = STATE_NAMES[name]; return { country: "US", region: code, zones: usZones(code, s) }; }
  if (isAU) return { country: "AU", region: "AU", zones: ["Australia/Perth", "Australia/Sydney"] };
  return null;
}

function fromPhone(e164) {
  const s = String(e164 || "");
  if (/^\+1\d{10}$/.test(s)) {
    const r = AREA[s.slice(2, 5)];
    if (!r) return null;
    if (r.startsWith("CA-")) { const p = r.slice(3); return { country: "CA", region: p, zones: CA_ZONES[p] }; }
    const one = AREA_ZONE[s.slice(2, 5)];
    const zones = US_ZONES[r].length > 1 ? (one ? [one] : r === "TX" ? [CHI] : (r === "FL" && s.slice(2, 5) !== "850") || r === "MI" && s.slice(2, 5) !== "906" ? [US_ZONES[r][0]] : US_ZONES[r]) : US_ZONES[r];
    return { country: "US", region: r, zones };
  }
  const au = s.match(/^\+61([2378])\d{8}$/);
  if (au) { const regions = AU_AREA[au[1]]; return { country: "AU", region: regions.join("/"), zones: [...new Set(regions.flatMap((r) => AU_ZONES[r]))] }; }
  if (/^\+614\d{8}$/.test(s)) return { country: "AU", region: "AU", zones: ["Australia/Perth", "Australia/Sydney"] };
  for (const cc of ["353", "44", "49"]) if (s.startsWith(`+${cc}`) && COUNTRY[cc]) return { ...COUNTRY[cc], region: COUNTRY[cc].country };
  return null;
}

// Where is this owner, time-wise? Location first, then the number, then the deal currency.
export function zonesFor({ phone, location, currency } = {}) {
  const loc = fromLocation(location, currency);
  if (loc) return { ...loc, source: "location" };
  const ph = fromPhone(phone);
  if (ph) return { ...ph, source: "number" };
  const cur = CURRENCY_ZONES[currency];
  if (cur) return { ...cur, region: cur.country, source: "currency" };
  return null;
}

const fmtCache = new Map();
function parts(zone, at) {
  let f = fmtCache.get(zone);
  if (!f) { f = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "numeric", weekday: "short", hourCycle: "h23" }); fmtCache.set(zone, f); }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return { hour: +p.hour % 24, minute: +p.minute, dow: p.weekday };
}
// Hours for a given weekday. Australia has national telemarketing hours (Telemarketing and Research Calls
// Industry Standard): weekdays 9am–8pm, Saturday 9am–5pm, never Sunday, whatever the workspace setting.
export function rulesFor(info, dow) {
  if (info?.country === "AU") return dow === "Sun" ? null : dow === "Sat" ? { start: 9, end: 17 } : { start: 9, end: 20 };
  return { start: RULES.start, end: info && END_8PM.has(info.region) ? 20 : RULES.end };
}
const hoursText = (info) => (info?.country === "AU" ? "9am–8pm weekdays, 9am–5pm Saturdays (Australian rules)" : (({ start, end }) => `${start}am–${end - 12}pm`)(rulesFor(info)));
function openAt(info, at, sundays) {
  return info.zones.every((z) => {
    const p = parts(z, at);
    if (p.dow === "Sun" && !sundays && info.country !== "AU") return false;
    const r = rulesFor(info, p.dow);
    if (!r) return false;
    const mins = p.hour * 60 + p.minute;
    return mins >= r.start * 60 && mins < r.end * 60;
  });
}

// Is it OK to call right now? `local` is the owner's clock ("2:14 PM"), `opens_at` the next allowed moment.
const nextCache = new Map();
export function callWindow(info, at = new Date(), { sundays = false, findNext = true } = {}) {
  if (!info?.zones?.length) return { known: false, callable: true, local: null, reason: "Local time unknown: check before calling" };
  const callable = openAt(info, at, sundays);
  const local = new Intl.DateTimeFormat("en-US", { timeZone: info.zones[0], hour: "numeric", minute: "2-digit", weekday: "short" }).format(at);
  const out = { known: true, callable, local, zone: info.zones[0], zones: info.zones, region: info.region, country: info.country, hours: hoursText(info), source: info.source };
  if (callable || !findNext) return out;
  // Next opening: step forward in 15-minute slots (at most 4 days). Owners in the same place share the answer.
  const key = `${info.country}|${info.region}|${info.zones.join(",")}|${sundays}|${Math.floor(at.getTime() / 9e5)}`;
  if (!nextCache.has(key)) {
    let found = null;
    const t = new Date(Math.ceil(at.getTime() / 9e5) * 9e5);
    for (let i = 0; i < 4 * 96; i++, t.setTime(t.getTime() + 9e5)) if (openAt(info, t, sundays)) { found = t.toISOString(); break; }
    if (nextCache.size > 500) nextCache.clear();
    nextCache.set(key, found);
  }
  if (nextCache.get(key)) out.opens_at = nextCache.get(key);
  const p = parts(info.zones[0], at);
  out.reason = p.dow === "Sun" && (!sundays || info.country === "AU") ? "Sunday: no cold calls" : `It's ${local.replace(/^\w+ /, "")} there; calls ${out.hours} their time`;
  return out;
}

// The owner's local hour and weekday (for "best time to call" stats).
export function localHour(info, at = new Date()) {
  if (!info?.zones?.length) return null;
  const p = parts(info.zones[0], at);
  return { hour: p.hour, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.dow) };
}
