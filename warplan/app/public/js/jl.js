// The JL skill (Josh Li's 3C Acquisition Model, knowledge/jl-3c-skill.md) as structured data for the parts of
// Warplan that show it directly: dialer scripts, follow-up cadence, qualification gate, seller motivation.
// Every string here is quoted from the skill (or, where marked "video", from Josh's own videos). Don't paraphrase
// or add to these: if the skill doesn't cover something, Warplan says so instead of making it up.
// Placeholders: [Name] owner's first name, [Your Name], [Company] your company, [industry], [business name].

export const JL_SOURCE = "JL skill: the 3C Acquisition Model";

export const SCRIPTS = {
  opener: {
    title: "Initial outreach (cold call)",
    text: "Hi [Name], this is [Your Name] with [Company]. I'm building a company in [industry] and wanted to introduce myself. Have you ever thought about selling [business name]?",
    note: "Golden question: \"Have you ever thought about selling?\"",
  },
  interested: { title: "If interested", text: "Great! I'd love to learn more. Can I send over an NDA and we can set up a time to discuss the business?" },
  notInterested: { title: "If not interested", text: "No problem at all. I'm building relationships in the industry, so I'll check back in with you in 6-12 months. Is that okay?" },
  otherBuyers: {
    title: "\"I have other buyers\" (the \"No worries, good luck\" technique)",
    text: "No worries, good luck with those buyers.",
    note: "Walk away confidently. 90% of the time, seller comes back within 2-7 days. 90% of sellers claiming \"other buyers\" are bluffing.",
  },
  followUp: {
    title: "Seller relationship (follow-up)",
    text: "Hi [Name], [Your Name] here. Just wanted to check in—we last spoke [X months] ago about [business name]. How are things going with the business? Any changes in your situation or thinking about the future? I'm still actively looking in [industry/area], so please keep me in mind if anything changes. No pressure at all—just wanted to stay in touch.",
  },
  evolution: {
    title: "Script evolution across follow-ups",
    lines: ["First call: \"Have you thought about selling?\"", "Follow-up 1: \"Just wanted to stay in touch\"", "Follow-up 2: \"Saw [industry news], made me think of you\"", "Follow-up 3: \"Still building in [area], keeping you in mind\"", "Follow-up 4: \"How's business? Any changes in your thinking?\""],
  },
  paymentHoliday: {
    title: "The payment holiday close (after price is agreed)",
    lines: ["Agree on headline purchase price first", "Then introduce: \"Given integration risk, I'd like a 9-12 month payment holiday\"", "Frame as: \"This gives me time to ensure the business maintains performance\"", "Offer slight interest rate increase if needed (e.g., 4% → 5%)", "Emphasize: \"You still get your full price, just delayed start\""],
  },
  gatekeeper: {
    title: "Gatekeepers (from Josh's videos)",
    text: "It's going to go straight to a receptionist and you just say, \"Hey, I want to speak to [the] partner.\" They put you through, organize a meeting.",
    note: "\"We're trying to eliminate as many gatekeepers as possible\": use LinkedIn and the website to get the owner's direct line or email.",
    source: "video",
  },
};

// Step 2 of the five-step deal flow.
export const QUALIFICATION = {
  title: "Qualification gate",
  items: ["NDA signature required", "Request: ≥3 years financial statements + tax returns", "For healthcare: billing breakdowns by practitioner"],
  note: "If seller provides these, indicates genuine motivation. Review with board/advisors before proceeding.",
};

// Seller psychology: motivation hierarchy and the signals that tell you which tier.
export const MOTIVATION = {
  tiers: [
    { tier: 1, name: "Immediate sellers", when: "Close in 30-90 days", examples: ["Health crisis (cancer, heart attack)", "Divorce or family emergency", "Burnout after 20-30 years", "Partnership dispute requiring exit", "Regulatory pressure they can't handle"] },
    { tier: 2, name: "Near-term sellers", when: "Close in 3-12 months", examples: ["Retirement planning (boomer demographic)", "Want to travel/relocate", "Tired of day-to-day operations", "See industry headwinds coming", "Kids don't want the business"] },
    { tier: 3, name: "Future sellers", when: "Nurture 12+ months", examples: ["\"Just curious about value\"", "Successful but exploring options", "Considering next chapter", "Building relationship with potential buyers"] },
  ],
  high: ["Provides financials within 1-2 days of NDA", "Responds to emails within hours", "Asks about your timeline", "Discusses personal plans post-sale", "Introduces you to key staff early", "Flexible on structure discussions"],
  low: ["Takes weeks to provide basic info", "Constantly reschedules meetings", "Non-responsive to questions", "Focuses only on price, ignores structure", "Hasn't thought through post-sale plans", "Defensive about business issues"],
};

// Multi-channel sequencing for an owner who hasn't picked up: what to do, and on which day after the first call.
export const SEQUENCE = [
  { day: 1, channel: "call", text: "Cold call attempt #1" },
  { day: 3, channel: "email", text: "Email introduction" },
  { day: 7, channel: "linkedin", text: "LinkedIn connection request" },
  { day: 10, channel: "call", text: "Cold call attempt #2" },
  { day: 14, channel: "email", text: "Follow-up email referencing call attempts" },
  { day: 21, channel: "linkedin", text: "LinkedIn message (if connected)" },
  { day: 30, channel: "call", text: "Cold call attempt #3" },
  { day: 45, channel: "email", text: "\"Last touch\" email offering to check back in 6 months" },
  { day: 90, channel: "email", text: "Month 3: Re-engage with industry news share" },
  { day: 180, channel: "call", text: "Month 6: Full sequence restart" },
];
// After the nth unanswered call (1-based), the next call and the touches in between.
export function nextInSequence(unanswered) {
  const calls = SEQUENCE.filter((s) => s.channel === "call");
  const last = calls[Math.min(unanswered, calls.length) - 1] || calls[0];
  const next = calls[unanswered] || null;
  const between = SEQUENCE.filter((s) => s.day > last.day && (!next || s.day < next.day));
  return { lastDay: last.day, next, between, daysToNext: next ? next.day - last.day : null };
}

export const RED_FLAGS_PROCESS = ["Seller unwillingness to explain details", "\"Other buyers interested\" claims (usually false)", "Pressure tactics or artificial urgency", "Broker-controlled process with inflated numbers"];

// Fill the skill's placeholders with what we know; anything unknown stays as a visible [placeholder].
export function personalize(text, v = {}) {
  return String(text)
    .replace(/\[Name\]/g, v.first || "[Name]")
    .replace(/\[Your Name\]/g, v.me || "[Your Name]")
    .replace(/\[Company\]/g, v.company || "[Company]")
    .replace(/\[industry\/area\]/g, v.industry || v.area || "[industry/area]")
    .replace(/\[industry\]/g, v.industry || "[industry]")
    .replace(/\[area\]/g, v.area || "[area]")
    .replace(/\[business name\]/g, v.business || "[business name]");
}
