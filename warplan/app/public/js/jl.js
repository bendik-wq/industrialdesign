// The JL skill (Josh Li's 3C Acquisition Model, knowledge/jl-3c-skill.md) as structured data for the parts of
// Warplan that show it directly: dialer scripts, follow-up cadence, qualification gate, seller motivation.
// Every string here is quoted from the skill (or, where marked "video", from Josh's own videos). Don't paraphrase
// or add to these: if the skill doesn't cover something, Warplan says so instead of making it up.
// Placeholders: [Name] owner's first name, [Your Name], [Company] your company, [industry], [business name].

export const JL_SOURCE = "3C Acquisition Model";

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

// ------------------------------------------------------------------ C1: Capabilities (board, bench, credibility)
export const BOARD_ROLES = [
  { id: "chair", label: "Chair", text: "Former executive or industry titan for credibility" },
  { id: "finance", label: "Finance Lead", text: "CFO/credit veteran who understands deal structures" },
  { id: "legal", label: "Legal Lead", text: "M&A attorney or former general counsel" },
  { id: "sector", label: "Sector Operator", text: "Industry expert with operational experience" },
];
export const BENCH_ROLES = [
  { id: "accountant", label: "Accountants", text: "Big Four or quality regional firms for Quality of Earnings (QoE)" },
  { id: "lawyer", label: "Lawyers", text: "Specialized M&A counsel for SPA/APA, employment, leases" },
  { id: "sme", label: "Industry SMEs", text: "Consultants specific to target sector" },
];
export const RECRUITMENT = ["Offer 2%-10% founders' equity instead of cash", "Target recently retired executives looking for meaningful involvement", "Use LinkedIn, direct outreach, and industry networks", "Pitch the vision and ground-floor opportunity", "Structure vesting tied to signed SPA and 12-month post-close support"];
export const BENCH_FEES = ["Delayed/rolled fees tied to closing or post-close working capital", "\"No money down\" by deferring professional fees", "Working capital loan covers legal/accounting upon close"];
export const FOUNDER_EQUITY = {
  title: "The Founder Equity Offer (Board Recruitment)",
  lines: ["Role: [Board Chair/Finance Lead/Legal Lead/Sector Expert]", "Equity: 0.25% - 2.0% founders shares", "Vesting: 50% on first signed SPA; 50% over 12 months post-close with monthly advisory", "Time Commitment: 2-4 hours monthly board meetings; available for ad-hoc advice on deals; introduction to network as needed", "Compensation: Equity only (no cash)"],
};
export const CREDIBILITY_OUTPUTS = ["Board/advisory roster with bios and track records", "Advisor engagement terms documenting equity/scope", "Credibility packet: thesis memo + NBIO template + diligence checklist", "\"Over 250 years cumulative experience, $300M+ in transactions\" type positioning"];
export const C1_SCRIPTS = {
  board: {
    title: "Board Recruitment",
    text: "[Name], I'm building [Company Name] to acquire and consolidate [industry] businesses. I've reviewed your background and believe you'd be a tremendous asset as [Board Chair/Finance Lead/etc.].\n\nI'm offering [0.5-2.0]% founders' equity with vesting tied to our first signed acquisition and 12-month post-close advisory. This is a ground-floor opportunity to help build a significant platform in [industry].\n\nWould you be open to a 30-minute call to discuss?",
  },
  founderPitch: {
    title: "Founder equity pitch",
    text: "[Name], I'm building [Company] to consolidate [industry]. Based on your background at [Company/Role], you'd be invaluable as [Role].\n\nThis is a ground-floor opportunity. I'm offering [X]% founders equity, vesting over our first acquisition and 12 months of advisory. No cash compensation—this is for people who want to build something significant and have the equity upside.\n\nWe're targeting [deal size/volume] over [timeframe] with exit to [PE/strategic/IPO]. Your involvement would immediately credibilize us with sellers and lenders.\n\nWould you be open to a 30-minute call to discuss?",
  },
};

// ------------------------------------------------------------------ C2: Capital (lenders)
export const C2_SCRIPTS = {
  lenderEmail: {
    title: "Phase 1: Initial email (keep to 3-4 sentences)",
    subject: "Introduction - [Your Company] Acquisition Platform",
    text: "[Banker Name],\n\nI'm [Your Name] with [Company]. We're building an acquisition platform in [sector], targeting businesses doing $X-$Y EBITDA.\n\nI'm interviewing commercial lenders to understand sector parameters and build relationships before bringing deals. Would you have 20 minutes for a call to discuss your appetite and lending criteria?\n\n[Your Name]\n[Title]\n[Phone]",
  },
  lenderIntro: {
    title: "Lender Introduction",
    text: "Hi [Banker Name], I'm [Your Name] with [Company]. We're building an acquisition platform in [industry sector].\n\nQuick context:\n- Target EBITDA: $[X]-$[Y]\n- Collateral: [equipment/AR/real estate]\n- Structure: [brief]\n\nCould you share your lending parameters for this sector? Specifically:\n- DSCR/ICR thresholds\n- Maximum leverage\n- Amortization and balloon options\n- PG requirements\n- Typical timing from application to funding\n\nI'm interviewing lenders to establish the right banking relationships before we bring deals.",
  },
};
export const LENDER_APPROACH = ["\"I'm building relationships across the banking sector\"", "Present with board credibility behind you", "Request term sheets for hypothetical scenarios", "Build rapport before needing money"];
export const LENDER_QUESTIONS = [
  { group: "Sector Experience", qs: ["How many deals have you done in [sector]?", "What size tickets do you typically finance?", "Any sector-specific concerns or red flags?"] },
  { group: "Credit Parameters", qs: ["What DSCR do you require? ICR?", "How do you calculate EBITDA for this sector?", "What adjustments do you typically make?"] },
  { group: "Structure", qs: ["What's your typical advance rate/LTV?", "Amortization period preferences?", "Do you do balloon structures?", "What covenant package is standard?"] },
  { group: "Collateral & Guarantees", qs: ["What collateral do you require?", "PG policy for deals under $5M? Over $5M?", "Any flexibility on unsecured portions?"] },
  { group: "Process", qs: ["Centralized credit decisioning or branch-level?", "Typical timeline from application to funding?", "What documentation do you need to review a deal?"] },
];
export const LENDER_ONGOING = ["Send quarterly email updates on pipeline", "Share when you close deals (even if not with them)", "Request annual review of their lending parameters", "Invite to coffee when in area", "Make small talk about their deals/sector views"];
// Columns of the skill's Lender Matrix Template, plus the parameters "Before Deal Sourcing" says to collect.
export const LENDER_FIELDS = [
  { k: "sector_exp", label: "Sector Experience", type: "select", options: ["High", "Medium", "Low"] },
  { k: "min_dscr", label: "Min DSCR", type: "number", step: 0.05, suffix: "x" },
  { k: "icr", label: "ICR", type: "number", step: 0.05, suffix: "x" },
  { k: "max_ltv", label: "Max LTV", type: "number", suffix: "%" },
  { k: "pg_policy", label: "PG Policy", type: "text" },
  { k: "amort_years", label: "Amort Period", type: "number", suffix: " years" },
  { k: "balloon", label: "Balloon options", type: "select", options: ["Yes", "No", "Case by case"] },
  { k: "timing_days", label: "Timing", type: "number", suffix: " days" },
  { k: "ticket_min", label: "Ticket from", type: "number", money: true },
  { k: "ticket_max", label: "Ticket to", type: "number", money: true },
  { k: "sectors", label: "Sector appetite", type: "text" },
  { k: "decisioning", label: "Decisioning", type: "select", options: ["Centralized", "Branch"] },
  { k: "collateral", label: "Collateral requirements", type: "text" },
  { k: "covenants", label: "Standard covenants", type: "text" },
  { k: "unsecured", label: "Unsecured portions", type: "select", options: ["Yes", "If strong DSCR", "No"] },
];
export const LENDER_TARGET = { min: 20, max: 50, note: "Build matrix of 20-50 lenders before sourcing first deal" };
export const CAPITAL_CRITICAL = ["Maintain 1.5x Debt Service Coverage Ratio minimum", "Zero or minimal Personal Guarantees", "Maximize unsecured portions", "Align debt service holidays with integration plans"];
export const UNSECURED_CONVERSION = {
  title: "The Unsecured Conversion",
  counter: ["\"Given my board's track record and our operational plan...\"", "\"We'd prefer to keep this unsecured to maintain flexibility\"", "\"However, we're happy to provide detailed monthly reporting\"", "\"And maintain a cash reserve covenant of $X\""],
  fallbacks: ["Security only on specific assets (not blanket lien)", "Security with higher debt service buffer (1.75x vs 1.5x DSCR)", "Security with subordination agreement if bringing in additional capital later", "Partial security (e.g., on equipment but not AR/inventory)"],
};

// Relationship statuses, in order. The steps are the skill's: recruit → engagement terms (board, bench);
// Phase 1 email → Phase 2 call → Phase 3 ongoing relationship (lenders).
export const REL_STATUSES = {
  board: [["prospect", "Prospect"], ["pitched", "Pitched"], ["call", "30-min call"], ["agreed", "Agreed"], ["signed", "Terms signed"], ["passed", "Passed"]],
  bench: [["prospect", "Prospect"], ["contacted", "Contacted"], ["terms", "Fees discussed"], ["engaged", "Engagement letter (rolled fees)"], ["passed", "Passed"]],
  lender: [["prospect", "To contact"], ["emailed", "Phase 1: emailed"], ["interviewed", "Phase 2: interviewed"], ["relationship", "Phase 3: relationship"], ["passed", "Not a fit"]],
};
// How long before a relationship goes stale, from the skill's cadence: 2-4 hours monthly board meetings;
// quarterly email updates to lenders.
export const STALE_DAYS = { board: 30, bench: 90, lender: 90 };
export const FINANCING_STAGES = [["sent", "Deal sent"], ["term_sheet", "Term sheet"], ["credit", "Credit review"], ["approved", "Financing approved"], ["declined", "Declined"]];

// ------------------------------------------------------------------ C3: Closing (the deal room)
export const NBIO = {
  title: "Step 3: Indicative Offer (NBIO or LOI)",
  includes: ["Headline purchase price and valuation methodology", "Proposed structure (vendor finance %, terms, holiday)", "Key conditions (DD, financing approval, lease assignments, licenses)", "Exclusivity period (typically 60-90 days)", "Target timeline to close"],
  tips: ["Front-load economics, leave details for later", "Aim to negotiate 80% of deal in LOI stage"],
};
export const TIMELINE = { ddDays: 90, contractDays: 28, exclusivityDays: [60, 90], loiToCloseMonths: [3, 6], text: ["DD window: 90 days maximum", "Contract papering: 4 weeks target", "Total process: 3-6 months from LOI to close"] };
export const CONTRACT_CLOSE = ["Lawyers draft SPA (Share Purchase Agreement) or APA (Asset Purchase Agreement)", "Contract papering: 4 weeks target", "Maintain leadership pressure on lawyers to avoid fee-jacking", "Tight scope, clear timelines, prioritized issue lists", "Settlement: execute documents, transfer funds, obtain keys", "Immediate working capital draw to cover costs"];
// Severity and action from the skill's Red Flag Decision Matrix.
export const RED_FLAG_MATRIX = [
  { flag: "Financials ≠ Tax Returns", severity: "high", action: "Walk away immediately" },
  { flag: "Customer concentration >50%", severity: "high", action: "Walk or heavily discount" },
  { flag: "Seller won't transition", severity: "high", action: "Walk away" },
  { flag: "Clean quality issues <10% EBITDA", severity: "low", action: "Accept or minor price adjustment" },
  { flag: "Working capital gap <$50K", severity: "medium", action: "Build into deal structure" },
  { flag: "Some staff turnover concerns", severity: "medium", action: "Retention bonuses in structure" },
];
export const RED_FLAGS = {
  financial: ["Financials and tax returns don't match", "Slipping gross margin masked by accounting changes", "Underfunded working capital at close", "Customer/supplier concentration (1-2 entities = >30% revenue)", "Tax debt or liens"],
  operational: ["Seller wants immediate exit with no transition", "Very high employee turnover", "Unassignable key customer contracts", "Regulatory non-compliance in licensed sectors"],
};
// Checklist templates the deal room starts from. Every line is the skill's.
export const ROOM_TEMPLATES = {
  gate: [
    { section: "Qualification gate", title: "NDA signature required", seller: true, upload: false },
    { section: "Qualification gate", title: "Financial statements (≥3 years)", seller: true, upload: true },
    { section: "Qualification gate", title: "Tax returns (≥3 years)", seller: true, upload: true },
    { section: "Qualification gate", title: "For healthcare: billing breakdowns by practitioner", seller: true, upload: true, healthcare: true },
    { section: "Qualification gate", title: "Review with board/advisors before proceeding", seller: false },
  ],
  dd: [
    ...["Customer concentration analysis", "Revenue by customer segment", "Customer retention rates", "Average customer lifetime value", "One-time vs recurring revenue split", "Seasonal revenue patterns", "Payment terms and AR aging"].map((title) => ({ section: "Revenue Quality", title })),
    ...["Owner compensation normalization", "One-time expenses removal", "Related party transactions", "Personal expenses run through business", "Deferred maintenance impact", "Non-operating income/expenses"].map((title) => ({ section: "EBITDA Adjustments", title })),
    ...["Current vs historical working capital needs", "Cash conversion cycle", "Inventory turns", "AR collection periods", "AP payment terms", "Required cash balance for operations"].map((title) => ({ section: "Working Capital Assessment", title })),
    ...["Revenue dependencies on seller relationships", "Staff retention risk", "Customer transition plan", "Supplier relationship dependencies", "Contract assignability"].map((title) => ({ section: "Post-Acquisition Sustainability", title })),
  ],
  cp: ["Financing approval (if using commercial debt)", "Quality of Earnings sign-off", "Lease assignments or renewals secured", "Regulatory/license confirmations", "Key personnel employment agreements", "Seller transition commitment documented"].map((title) => ({ section: "Mandatory Conditions Precedent", title })),
  close: [
    ...["Lawyers draft SPA (Share Purchase Agreement) or APA (Asset Purchase Agreement)", "Tight scope, clear timelines, prioritized issue lists", "Interview staff before close to prevent exodus", "Clear continuity plan for customers/employees", "Structured exit for seller with accountability"].map((title) => ({ section: "Contractual close", title })),
    ...["Execute documents", "Transfer funds", "Obtain keys", "Immediate working capital draw to cover costs"].map((title) => ({ section: "Settlement", title })),
  ],
  plan: [
    ...["Meet with all key staff individually", "Review all customer contracts", "Audit all supplier relationships", "Verify all financial accounts and access", "Confirm all licenses and permits", "Set up new entity banking", "Draw working capital line"].map((title) => ({ section: "Days 1-30: Stabilization", title, day: 30 })),
    ...["Identify quick-win improvements", "Benchmark KPIs vs due diligence model", "Address any staff concerns", "Lock in key employee retention", "Review and optimize processes", "Assess technology/systems needs"].map((title) => ({ section: "Days 31-60: Assessment", title, day: 60 })),
    ...["Implement priority improvements", "Launch any new service offerings", "Optimize pricing where possible", "Reduce unnecessary expenses", "Strengthen customer relationships", "Build management dashboard"].map((title) => ({ section: "Days 61-100: Optimization", title, day: 100 })),
  ],
};
export const PLAN_PRINCIPLES = ["Don't change everything immediately", "Listen more than you talk initially", "Respect what's working", "Address what's clearly broken", "Communicate constantly with team"];
export const ROOM_TABS = [["gate", "Qualification gate"], ["offer", "NBIO / LOI"], ["dd", "Diligence log"], ["cp", "Conditions precedent"], ["close", "Close & settlement"], ["plan", "First 100 days"]];

// ------------------------------------------------------------------ KPIs and the daily cadence
export const KPIS = {
  capabilities: ["Board seats filled with relevant track records", "Advisor engagement letters executed with rolled fees", "Professional relationships established (accountants/lawyers)"],
  capital: ["Pro-forma DSCR ≥1.50x under base case", "Zero or minimal PG achieved", "Debt service holiday aligned to integration", "Working capital line secured"],
  closing: ["LOI-to-SPA conversion rate tracked", "DD variance (% price adjustment vs. initial offer)", "Legal/accounting spend vs. budget", "Days from first contact to close"],
};
export const DAILY_CADENCE = [
  { from: 9, to: 12, text: "Morning (9-12pm): 40-50 cold calls" },
  { from: 13, to: 15, text: "Afternoon (1-3pm): Follow-up emails to \"call back\" requests" },
  { from: 15, to: 17, text: "Late afternoon (3-5pm): LinkedIn connections and messages" },
  { from: 17, to: 24, text: "Evening: Update CRM, plan next day targets" },
];
export const CALL_LEVELS = [
  { upTo: 100, text: "Version 1 (Calls 1-100): Read from script, nervous, formal" },
  { upTo: 300, text: "Version 2 (Calls 101-300): Less robotic, conversational" },
  { upTo: 600, text: "Version 3 (Calls 301-600): Confident, natural, handling objections smoothly" },
  { upTo: 1000, text: "Version 4 (Calls 601-1000): Expert level, reading seller tone, adapting in real-time" },
];
