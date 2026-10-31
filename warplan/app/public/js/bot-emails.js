// The prospecting bot's emails: short, direct, owner to owner. Shared by the server (what gets sent) and the
// editor (the live preview), so what you see is what goes out. A signature and an opt-out line are added on send.
export const MAX_TOUCHES = 10;

export const DEFAULT_TEMPLATES = {
  subject: "Buying {buying} in {area}",
  steps: [
    "Hi {first},\n\nMy name is {sender}, I run {group}. We're looking to buy {buying} in {area}.\n\nHave you ever thought about selling {company}? Probably not, right?\n\n{sender}",
    "Hi {first},\n\nWe sent you a note {when}, so this is a quick follow-up. We're buying {buying} in {area} this year and {company} stood out{signal}.\n\nWorth a quick chat?\n\n{sender}",
    "Hi {first},\n\nFollowing up again. If selling isn't on the cards, just reply \"not now\" and I'll leave it there.\n\n{sender}",
    "Hi {first},\n\nI've been trying to reach you by email. A call might be easier: {phone}. Five minutes, no obligation.\n\n{sender}\n{group}",
    "Hi {first},\n\nOne more try. If you've ever wondered what {company} would be worth to a buyer, I'm happy to tell you, no strings attached. {call}\n\n{sender}",
    "Hi {first},\n\nThis is my last email for now. If you ever think about selling, my direct line is {phone}.\n\n{sender}\n{group}",
  ],
};

// How each kind of business reads in "we're looking to buy …".
const BUYING = { hvac: "HVAC businesses", plumbing: "plumbing businesses", electrical: "electrical contractors", roofing: "roofing businesses", landscaping: "landscaping businesses",
  cleaning: "cleaning businesses", pest: "pest control businesses", dental: "dental practices", gp: "medical practices", physio: "physio clinics", vet: "vet clinics",
  accounting: "accounting firms", insurance: "insurance brokerages", it: "IT businesses", auto: "auto repair shops", trucking: "trucking companies", waste: "waste businesses",
  security: "security businesses", engineering: "engineering firms", funeral: "funeral homes", childcare: "childcare centres" };
export const buyingFor = (industryId, fallback = "") => BUYING[industryId] || pluralize(fallback) || "businesses like yours";

const pluralWord = (w) => (/(s|x|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
// "physiotherapy clinic" → "physiotherapy clinics", "plumber" → "plumbers", "accounting firm" → "accounting firms"
export const pluralize = (phrase) => String(phrase || "").trim().replace(/(\w+)$/, (w) => pluralWord(w));

export function signalLine(s = {}) {
  if (s.reviews >= 20 && s.rating) return ` (${s.reviews} reviews at ${s.rating}★ says a lot)`;
  if (s.years >= 10) return ` (${s.years} years in business says a lot)`;
  return "";
}

// Which template an email uses: the first is the opener, the last is always the final email, and when there are
// more emails than templates the middle ones repeat.
export function templateIndex(step, touches, n) {
  if (step <= 1 || n === 1) return 0;
  if (step >= touches) return n - 1;
  if (step <= n - 2) return step - 1;
  return n <= 2 ? n - 1 : 1 + ((step - 2) % (n - 2));
}

// step: 1-based. vars: {first, company, sender, group, buying, area, phone, signals, touches, gapDays}
export function renderEmail(templates, step, vars) {
  const t = { ...DEFAULT_TEMPLATES, ...(templates || {}) };
  const steps = Array.isArray(t.steps) && t.steps.length ? t.steps : DEFAULT_TEMPLATES.steps;
  const body = steps[templateIndex(step, vars.touches || steps.length, steps.length)];
  const phone = String(vars.phone || "").trim();
  const v = {
    first: String(vars.first || "").trim() || "there", company: vars.company || "your business", sender: vars.sender || "", group: vars.group || "",
    buying: vars.buying || "businesses like yours", area: vars.area || "your area", phone: phone || "just reply to this email",
    call: phone ? `Call or text me on ${phone}.` : "Just reply to this email.", signal: signalLine(vars.signals || {}),
    when: (vars.gapDays || 1) <= 1 ? "yesterday" : "the other day",
  };
  const fill = (s) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? v[k] : m));
  let text = fill(body).replace(/\n{3,}/g, "\n\n").trim();
  if (!v.group) text = text.replace(/, I run \./, ".").replace(/\n\s*$/gm, "\n").trim();
  const first = fill(t.subject || DEFAULT_TEMPLATES.subject).trim().slice(0, 140);
  return { subject: step === 1 ? first : `Re: ${first}`, body: text };
}

export function cleanTemplates(t) {
  const out = {};
  if (t && typeof t.subject === "string" && t.subject.trim()) out.subject = t.subject.trim().slice(0, 140);
  if (t && Array.isArray(t.steps)) {
    const steps = t.steps.map((s) => String(s || "").trim().slice(0, 2000)).filter(Boolean).slice(0, MAX_TOUCHES);
    if (steps.length) out.steps = steps;
  }
  return out;
}
