import type { LongEmail } from '../kit';

// Shared library: industry acquisition dynamics. Each email goes only to owners in its industry.
export const LIB_INDUSTRIES: LongEmail[] = [
  // ── Medical & GP clinics ──
  {
    id: 'lib_ind_medical_doctor_agreements',
    industries: ['medical'],
    subject: 'clinic deals: how the doctors are engaged',
    preheader: 'In plenty of clinics the doctors aren’t employees, and that changes what you’re buying.',
    body: [
      '{name}, one for clinic owners.',
      'When you buy a GP clinic, the first question is how the doctors are engaged. Many Australian clinics engage GPs as contractors under service agreements, with the doctor paying the clinic a share of billings.',
      'That makes the asset the agreements, the patient base and the rooms. If a doctor’s agreement lets them leave on a month’s notice, the revenue a lender sees and the revenue you keep can be two different numbers.',
      'Read every service agreement before you value anything. Notice periods, restraints and what happens on a change of owner tell you how much of the billing book really transfers.',
    ],
    ps: 'I run my own group of clinics, and this read comes before any conversation about price.',
    cta: 'next',
  },
  {
    id: 'lib_ind_medical_back_office',
    industries: ['medical'],
    subject: 'the clinic across town and your back office',
    preheader: 'A second clinic shares the billing, rostering and compliance you already pay for.',
    body: [
      '{name},',
      'The case for buying the practice across town rests on more than its patients. It rests on the back office you already pay for: billing, rostering, compliance, recruitment, and a practice manager who could run two sites.',
      'A second clinic on the same systems carries less overhead per doctor than the first. That gap is where a lender sees the cash flow improve, and it’s why clinic groups grow by buying rather than by opening empty rooms and waiting for patients.',
      'Reply with the suburb or city you’d want your second clinic in, and I’ll tell you what I’d check first.',
    ],
    cta: 'reply',
  },

  // ── Dental ──
  {
    id: 'lib_ind_dental_chairs_days',
    industries: ['dental'],
    subject: 'dental practices: count the chairs, then the days',
    preheader: 'Chair utilisation shows what a practice can earn without a single new fitout.',
    body: [
      '{name}, a quick one for dental owners.',
      'When you look at the practice two suburbs over, count the surgeries and then count the days each one is staffed. A practice with four chairs and two of them dark half the week is a different deal from one running at capacity.',
      'An empty chair is upside you can fill with your associates, your hygienists and your patient flow. A full practice needs another site to grow, which makes it worth buying for a different reason.',
      'Either way, the number to model is the profit today, because that is what the lender lends against.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_dental_principal_stays',
    industries: ['dental'],
    subject: 'the principal dentist who wants a few more years',
    preheader: 'Plenty of dental sellers want out of the admin, not out of the surgery.',
    body: [
      '{name},',
      'A familiar dental sale: the principal is in their sixties, still enjoys the clinical work, and is tired of the payroll, the lease and the compliance.',
      'That seller doesn’t want to disappear. They want to sell the business and keep treating patients for a few years.',
      'Structure for it. A seller who stays on as an associate keeps patient goodwill in the building, and a slice of seller rollover gives them a reason to care how the practice performs after the sale.',
      'The guide on buying a competitor shows how that first conversation opens.',
    ],
    ps: 'This is education, not legal, tax or financial advice, and every structure depends on the practice’s own figures.',
    cta: 'guide:buy-your-competitor',
  },

  // ── Allied health ──
  {
    id: 'lib_ind_allied_practitioner_book',
    industries: ['allied-health'],
    subject: 'physio practices: patients follow the clinician',
    preheader: 'Before you buy an allied health practice, see who the appointments belong to.',
    body: [
      '{name},',
      'In physio, podiatry and most allied health, patients follow the practitioner they see. Buy a practice where one clinician drives half the appointments and you’ve bought a job offer that clinician can decline.',
      'Look at appointments by practitioner across the last two years. A spread of clinicians, steady referrals from GPs and specialists, and a front desk that books patients to the practice rather than to a person are what make it a business.',
      'That is also the version a lender will lend against.',
    ],
    ps: 'Ask for the data by month, because a clinician who left last year shows up there and nowhere else.',
    cta: 'next',
  },
  {
    id: 'lib_ind_allied_referral_map',
    industries: ['allied-health'],
    subject: 'adding podiatry to a physio practice',
    preheader: 'Your first allied health target is on your own outbound referral list.',
    body: [
      '{name}, one for allied health owners.',
      'The add on that makes sense in allied health is the discipline your patients already get referred out for. A physio group that buys the podiatry or exercise physiology practice down the road keeps those referrals in house.',
      'You share the rooms, the booking system and the reception team. Revenue per room goes up without signing a new lease.',
      'Map where your clinicians refer patients today, and your first target is somewhere on that list.',
    ],
    cta: 'next',
  },

  // ── Veterinary ──
  {
    id: 'lib_ind_vet_corporate_buyers',
    industries: ['veterinary'],
    subject: 'vet clinics and the corporate groups already buying',
    preheader: 'Two things the corporate consolidation of vet clinics tells an independent buyer.',
    body: [
      '{name},',
      'Corporate groups have been buying vet clinics for years, and plenty of independent owners have had an approach. That tells you two things.',
      'First, owners in this sector know what a corporate offer looks like, so lead with what a corporate buyer can’t give them: a local owner who keeps the name, the team and the way they practise.',
      'Second, groups pay for scale. A cluster of clinics under one owner is worth more than the same clinics sold one at a time, and that is the reason to start assembling one.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_vet_diligence_three',
    industries: ['veterinary'],
    subject: 'vet clinic diligence: the vets, the gear, the lease',
    preheader: 'Three checks that change the price or the structure of a vet clinic deal.',
    body: [
      '{name}, three things I’d check in any vet clinic.',
      '• Which vets stay after the sale, and whether they’re employed or locums<br>• The age of the imaging, anaesthetic and lab equipment you’d have to replace<br>• The lease, because a clinic fitout is expensive to move',
      'Each one changes the price or the structure. A clinic that needs new imaging in year one should carry that cost in the deal, through the price or through the seller finance terms.',
      'The red flags guide covers the rest.',
    ],
    cta: 'guide:due-diligence-red-flags',
  },

  // ── HVAC ──
  {
    id: 'lib_ind_hvac_agreements',
    industries: ['hvac'],
    subject: 'hvac targets: maintenance agreements beat installs',
    preheader: 'Two HVAC businesses with the same revenue can carry very different amounts of debt.',
    body: [
      '{name},',
      'Two HVAC businesses with the same revenue can be worth very different amounts. One lives on new installs and has to win every dollar again next year, while the other has a base of maintenance agreements that renew.',
      'Lenders lend against cash flow they believe will repeat. Service and maintenance revenue is the part they believe.',
      'When you look at the HVAC company you keep bidding against, ask for revenue split by installs, service calls and agreements. That split tells you what the business is worth and how much debt it carries comfortably.',
    ],
    ps: 'Ask for the agreement count by month too, because a shrinking base hides inside a good revenue year.',
    cta: 'next',
  },
  {
    id: 'lib_ind_hvac_licence_holder',
    industries: ['hvac'],
    subject: 'the hvac licence question to ask first',
    preheader: 'Whose licence does the business trade under on the day after settlement.',
    body: [
      '{name}, a short one.',
      'In HVAC the licences sit with people: refrigerant handling licences for the technicians, and a contractor licence that rests on a named qualifier or nominee.',
      'If the qualifier is the owner who’s selling, the deal needs a plan for whose licence the business trades under on day one. Sometimes that’s yours, and sometimes it’s a senior tech who gets a reason to stay.',
      'Reply and tell me where your business is licensed, and I’ll tell you what to check on a target there.',
    ],
    cta: 'reply',
  },

  // ── Plumbing ──
  {
    id: 'lib_ind_plumbing_owner_out',
    industries: ['plumbing'],
    subject: 'the plumbing owner who still answers the night calls',
    preheader: 'Who quotes, who answers and whose licence it is decide whether the revenue survives.',
    body: [
      '{name},',
      'The plumbing business whose owner wants out has a familiar shape. The owner still quotes the big jobs, answers the phone at night and holds the licence the business trades under.',
      'That is the work to plan before price. Who quotes, who answers, and whose licence goes on the paperwork after settlement decide whether the revenue survives the handover.',
      'Agree a transition period and pay part of the price through seller finance, and the owner has every reason to hand those things over properly.',
    ],
    ps: 'Seller finance works best alongside commercial debt and seller rollover, and the mix depends on the business’s own numbers.',
    cta: 'next',
  },
  {
    id: 'lib_ind_plumbing_recurring_base',
    industries: ['plumbing'],
    subject: 'plumbing add ons: strata, maintenance and drains',
    preheader: 'The plumbing revenue lenders like most is the work that comes back.',
    body: [
      '{name},',
      'The plumbing businesses lenders like most have work that comes back: strata and property maintenance contracts, commercial service agreements, scheduled drain maintenance.',
      'If your business lives on new builds or one-off jobs, buying a business with that recurring base changes how your whole group looks to a lender. Steady revenue smooths out the lumpy, and the combined business carries debt more comfortably than either half alone.',
      'The guide on buying a competitor shows how the approach works.',
    ],
    cta: 'guide:buy-your-competitor',
  },

  // ── Electrical ──
  {
    id: 'lib_ind_electrical_one_builder',
    industries: ['electrical'],
    subject: 'electrical contractors and the one big builder',
    preheader: 'Concentration is the first thing a lender sees in an electrical contractor.',
    body: [
      '{name},',
      'Plenty of electrical contractors grow on the back of one or two builders. It works until the builder slows down, changes subcontractors or goes under.',
      'When you look at the electrical contractor down the road, ask for revenue by customer for three years. If one builder accounts for a large share of the work, the lender will see concentration and you should price it.',
      'The contractor with a spread of commercial maintenance clients and smaller builders is the safer buy, and the easier one to finance.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_electrical_team',
    industries: ['electrical'],
    subject: 'what an electrical business really sells you: people',
    preheader: 'Licensed electricians, apprentices and a supervisor who can run a crew.',
    body: [
      '{name},',
      'The scarce thing in electrical is qualified people. Buying the contractor down the road gets you licensed electricians, apprentices partway through their training and a supervisor who can run a crew.',
      'Ask the seller who the business can’t lose, what those people earn against the market, and what happens to the apprentices’ training arrangements on a change of owner.',
      'The guide to seller questions has the rest of the list.',
    ],
    ps: 'Meet the supervisors before settlement, with the seller’s blessing, and you learn more than any spreadsheet tells you.',
    cta: 'guide:questions-to-ask-a-business-seller',
  },

  // ── Roofing & solar ──
  {
    id: 'lib_ind_roofing_warranties',
    industries: ['roofing-solar'],
    subject: 'roofing deals: who carries the old warranties',
    preheader: 'Every roof and system already installed comes with a workmanship promise.',
    body: [
      '{name},',
      'Every roof and solar system the business installed comes with a workmanship warranty. When you buy the business, you need to know who answers the call when one of those comes back.',
      'In a share purchase, the company keeps those obligations. Under an asset purchase, the contract decides, and a sensible deal holds back part of the seller finance to cover claims for a set period.',
      'That holdback is fair to both sides, and it keeps the seller interested in the quality of what they built.',
    ],
    ps: 'This is education, not legal advice, and your lawyer sets the warranty terms for your deal.',
    cta: 'next',
  },
  {
    id: 'lib_ind_roofing_repeat_base',
    industries: ['roofing-solar'],
    subject: 'the roofer ready to retire, and the repeat work',
    preheader: 'Rebates and storms move the revenue. A lender looks through both to the base.',
    body: [
      '{name}, a question for roofing and solar owners.',
      'Solar revenue moves with incentive and rebate programs, and roofing revenue moves with storms and builders. A lender looks through both to the base: repairs, maintenance, insurance work and repeat commercial clients.',
      'The roofer whose owner is ready to retire is worth most to a buyer who can add that base to their own. Reply and tell me roughly what share of your revenue is repeat work, and I’ll tell you how I’d think about a target.',
    ],
    cta: 'reply',
  },

  // ── Landscaping ──
  {
    id: 'lib_ind_landscaping_routes',
    industries: ['landscaping'],
    subject: 'landscaping: buy the maintenance rounds',
    preheader: 'A dense maintenance book on routes near yours is the add on that pays.',
    body: [
      '{name},',
      'Landscaping businesses earn two ways: construction projects that end, and maintenance rounds that come back every week or month.',
      'A crew across the city with a dense maintenance book is a strong add on, because the routes sit near yours and the same trucks and supervisors cover more sites in a day. Each extra site on a route you already drive adds margin without adding much cost.',
      'Ask for the maintenance client list by suburb and contract term, then lay it over your own routes.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_landscaping_fleet_finance',
    industries: ['landscaping'],
    subject: 'the mowers, the trucks and the finance on them',
    preheader: 'An equipment list looks like an asset until you read the finance contracts.',
    body: [
      '{name}, one check in landscaping that gets missed.',
      'The equipment list in a landscaping sale looks like an asset, and some of it carries finance the seller still owes. Ask for every equipment finance contract and every lease, and how each one is treated at settlement.',
      'Then check the age of the fleet. A business that’s skipped replacing its trucks for three years shows more profit than it can keep, and the replacement bill becomes yours.',
      'The red flags guide goes through more of these.',
    ],
    cta: 'guide:due-diligence-red-flags',
  },

  // ── Commercial cleaning ──
  {
    id: 'lib_ind_cleaning_contract_terms',
    industries: ['cleaning'],
    subject: 'cleaning contracts and the short notice clause',
    preheader: 'The contracts are what you’re buying, so read how each one can end.',
    body: [
      '{name},',
      'The cleaning company with the contracts you want is selling those contracts, and each one has terms. Plenty of commercial cleaning contracts can be ended on short notice, and some let the client terminate on a change of control.',
      'Read them before you value anything. The length of each client relationship matters as much as the contract term, because a client who has stayed eight years on a 30 day contract has shown you something.',
      'A lender reads it the same way.',
    ],
    ps: 'Change of control clauses decide whether you buy shares or assets, so flag them early.',
    cta: 'next',
  },
  {
    id: 'lib_ind_cleaning_wage_compliance',
    industries: ['cleaning'],
    subject: 'cleaning diligence: wages, awards and subcontractors',
    preheader: 'Labour is the biggest cost in cleaning, so it’s where the risk sits.',
    body: [
      '{name},',
      'Labour is the biggest cost in commercial cleaning, so labour compliance is where the risk sits. Check that cleaners are paid correctly under the award or wage rules that apply, and that anyone engaged as a subcontractor really is one.',
      'An underpayment problem in the target becomes your problem after the deal. Profit that depends on paying people less than they’re owed is profit you can’t keep.',
      'The red flags guide covers the rest of the diligence list.',
    ],
    cta: 'guide:due-diligence-red-flags',
  },

  // ── Security ──
  {
    id: 'lib_ind_security_licence_first',
    industries: ['security'],
    subject: 'security firms: the licence is the business',
    preheader: 'Lose the business licence and the sites go with it.',
    body: [
      '{name},',
      'A security business trades under a business licence (a master licence in some states), and every guard on site needs an individual licence. Lose the business licence and the sites go with it.',
      'In any security deal the licence question comes first: whose name it’s in, whether it transfers or has to be reissued, and what the regulator needs from a new owner.',
      'The guide on buying a security business goes through the order of it.',
    ],
    cta: 'guide:buy-a-security-business',
  },
  {
    id: 'lib_ind_security_site_density',
    industries: ['security'],
    subject: 'the security firm with the sites next to yours',
    preheader: 'Guarding is a density business, and density shows up as margin.',
    body: [
      '{name},',
      'Guarding is a density business. The security firm with the sites next to yours adds contracts your supervisors can already reach and patrols your vehicles already drive.',
      'That density shows up as margin, and margin is what the lender tests. A target that looks average on its own can carry its debt comfortably once it shares your rosters, supervisors and control room.',
      'Start by marking your sites and theirs on one map.',
    ],
    ps: 'Model the target on its own profit first, and treat the shared costs as the upside.',
    cta: 'next',
  },
  {
    id: 'lib_ind_security_monitoring',
    industries: ['security'],
    subject: 'alarm monitoring revenue and why lenders like it',
    preheader: 'Guarding gets retendered. Monitoring behaves more like a subscription.',
    body: [
      '{name}, one for security owners.',
      'Monitoring and maintenance contracts on alarm and CCTV systems are the steadiest revenue in security. Clients pay monthly, the systems stay installed, and switching providers is a hassle clients avoid.',
      'Guarding contracts get retendered on price. A book of monitoring clients behaves more like a subscription, and lenders treat it that way.',
      'If your business is mostly guarding, a monitoring business is the add on that steadies the whole group.',
    ],
    cta: 'next',
  },

  // ── Accounting ──
  {
    id: 'lib_ind_accounting_retiring_book',
    industries: ['accounting'],
    subject: 'the retiring partner’s book of clients',
    preheader: 'Loyal clients, no successor inside the firm, and a handover to plan.',
    body: [
      '{name},',
      'Accounting firms change hands in a familiar way: a partner near retirement with a loyal book and no successor inside the firm.',
      'The clients are loyal to the partner, so the deal is built around introducing you properly. A handover period, joint meetings with the larger clients, and part of the price paid over time against fees retained give both sides the same goal.',
      'The guide on buying an accounting firm covers the structure.',
    ],
    ps: 'This is education, not tax or legal advice, and each firm’s deal is built on its own fee data.',
    cta: 'guide:buy-an-accounting-firm',
  },
  {
    id: 'lib_ind_accounting_cash_curve',
    industries: ['accounting'],
    subject: 'accounting firms and the tax season cash curve',
    preheader: 'Annual profit hides the months when the repayments still fall due.',
    body: [
      '{name},',
      'Accounting revenue bunches around tax deadlines and year end. Cash arrives after the work is billed, which can sit weeks or months behind the busy period.',
      'When you model buying a firm, look at monthly cash flow as well as annual profit. Repayments on acquisition debt fall due every month, including the quiet ones.',
      'A working capital line sized for that gap keeps the deal comfortable through the year.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_accounting_fee_table',
    industries: ['accounting'],
    subject: 'compliance fees vs advisory fees in a firm you buy',
    preheader: 'One table tells you most of what an accounting firm is worth.',
    body: [
      '{name}, a short one.',
      'In an accounting firm, recurring compliance work (tax returns, BAS or quarterly filings, year end accounts) is what a lender counts on. Advisory projects are welcome, and they’re harder to bank on.',
      'Ask for fees by client and by type of work for three years, and see how many clients have stayed five years or more.',
      'That one table tells you most of what the firm is worth.',
    ],
    cta: 'next',
  },

  // ── Insurance brokerage ──
  {
    id: 'lib_ind_insurance_renewals',
    industries: ['insurance'],
    subject: 'buying a broker’s book: renewals are the asset',
    preheader: 'Commission on renewals is the cash flow, and retention decides its value.',
    body: [
      '{name},',
      'An insurance brokerage is a book of policies that renew. Commission on those renewals is the cash flow you’re buying, and retention is the number that decides its value.',
      'Look at renewal retention by year and by class of business, and at how much of the book sits with the top ten clients.',
      'The guide on buying an insurance brokerage covers the licensing and the structure.',
    ],
    cta: 'guide:buy-an-insurance-brokerage',
  },
  {
    id: 'lib_ind_insurance_licences',
    industries: ['insurance'],
    subject: 'brokerage licences and carrier appointments',
    preheader: 'AFSL, state licences, carrier appointments: each one has to survive the sale.',
    body: [
      '{name},',
      'In Australia, a brokerage either holds its own AFSL or works as an authorised representative under someone else’s. In the US, producers hold state licences and the agency holds appointments with each carrier.',
      'Each of those has to survive the sale. Check whether the licence or appointments carry over in a share purchase, need fresh applications in an asset purchase, or depend on the person who’s leaving.',
      'Get that mapped early and the rest of the deal moves faster.',
    ],
    ps: 'This is education, not legal advice, and a specialist lawyer confirms the licensing path for your deal.',
    cta: 'next',
  },
  {
    id: 'lib_ind_insurance_seller_wants',
    industries: ['insurance'],
    subject: 'the broker who wants out, and what they want',
    preheader: 'Price matters, and so does who looks after their clients next.',
    body: [
      '{name},',
      'The broker who wants out has spent decades with their clients. Price matters to them, and so does who looks after those clients next.',
      'Offer them a role through a full renewal cycle so they can introduce you to the larger accounts, and pay part of the price as seller finance or rollover tied to the book. That tells the seller you care about the same thing they do.',
      'Reply with the size of brokerage you’d want to buy, by commission income, and I’ll tell you how I’d shape a first offer.',
    ],
    cta: 'reply',
  },

  // ── IT & managed services ──
  {
    id: 'lib_ind_msp_managed_split',
    industries: ['it-services'],
    subject: 'msp targets: managed revenue vs project revenue',
    preheader: 'Project work and hardware resale pad revenue and leave the lender cold.',
    body: [
      '{name},',
      'An MSP’s value sits in its managed services agreements: monthly fees for support, security and backup that renew. Project work and hardware resale pad the revenue line and leave the lender cold.',
      'Ask for revenue split by managed, project and resale, and for the term left on each agreement.',
      'The guide on buying an MSP goes further into what to check.',
    ],
    cta: 'guide:buy-an-msp-it-services-business',
  },
  {
    id: 'lib_ind_msp_tool_stack',
    industries: ['it-services'],
    subject: 'the msp next door runs a different stack',
    preheader: 'Integration work in an MSP deal sits in the tools, and it has a cost.',
    body: [
      '{name}, one for IT services owners.',
      'The MSP with clients next to yours is a natural buy, and the integration work sits in the tools. Different monitoring, ticketing, backup and security platforms mean months of migration and some client friction.',
      'Price that work into the plan. A target on your stack is worth more to you than one that isn’t, even at the same profit.',
      'Look at the target’s tools before you look at its price.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_msp_key_engineer',
    industries: ['it-services'],
    subject: 'the engineer who knows every client environment',
    preheader: 'In a small MSP, one person carries the knowledge. Find them early.',
    body: [
      '{name},',
      'In a small MSP, one senior engineer carries the knowledge of every client environment. If that person leaves after the sale, service drops and clients notice.',
      'Find that person early in diligence, check how well the environments are documented, and give them a reason to stay through the transition.',
      'A retention bonus costs far less than losing the clients.',
    ],
    ps: 'Ask to see the documentation itself, because “it’s all in the system” is a sentence, not a handover.',
    cta: 'next',
  },

  // ── Marketing agencies ──
  {
    id: 'lib_ind_agency_retainers',
    industries: ['agencies'],
    subject: 'agency deals: retainers, projects and the founder',
    preheader: 'What makes a marketing agency hard to finance, and what makes it easier.',
    body: [
      '{name},',
      'Marketing agencies are hard to finance when revenue is project based and the founder runs every client relationship. They get easier when retainers renew and an account team owns the day to day.',
      'Look at revenue by client for three years, how long the retainers have run, and who each client actually talks to.',
      'The guide on buying a marketing agency covers the structure that fits.',
    ],
    cta: 'guide:buy-a-marketing-agency',
  },
  {
    id: 'lib_ind_agency_capability',
    industries: ['agencies'],
    subject: 'buying the agency with the capability you lack',
    preheader: 'Sell their capability into your client base on day one, and model it as upside.',
    body: [
      '{name},',
      'The agency with the clients you want also has the capability you don’t: paid media, SEO, creative or data. Buying it lets you sell that capability into your own client base from day one.',
      'Cross selling is the real return in an agency deal. Model it as upside, and make sure the deal works on the target’s current profit first.',
      'Lenders test the profit that exists today, and that’s the number the structure is built on.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_agency_paid_later',
    industries: ['agencies'],
    subject: 'why agency sellers take part of the price later',
    preheader: 'Seller finance and rollover do the job an earnout tries to do, more cleanly.',
    body: [
      '{name}, a short one.',
      'Agency sellers expect part of the price to depend on the clients staying. Seller finance and seller rollover do that job cleanly: the founder gets paid as the business performs and has a reason to make the handover work.',
      'That suits a buyer using commercial debt for the rest, because the lender sees a seller still invested in the outcome.',
    ],
    ps: 'Education only, not financial advice, and the mix of debt, seller finance and rollover depends on the agency’s figures.',
    cta: 'next',
  },

  // ── Recruitment & staffing ──
  {
    id: 'lib_ind_recruit_payroll_gap',
    industries: ['recruitment'],
    subject: 'recruitment: temp margin and the payroll gap',
    preheader: 'Temp workers get paid weekly, clients pay weeks later, and the gap needs funding.',
    body: [
      '{name},',
      'A temp and contract desk pays its workers weekly and gets paid by clients weeks later. That gap needs funding, and agencies fund it through debtor or invoice finance.',
      'When you buy a recruitment agency with a contract book, the acquisition debt sits beside that facility. Model both, month by month, before you agree a price.',
      'The guide on buying a recruitment agency goes through the numbers to ask for.',
    ],
    cta: 'guide:buy-a-recruitment-agency',
  },
  {
    id: 'lib_ind_recruit_consultant_restraints',
    industries: ['recruitment'],
    subject: 'recruitment consultants and the clients they carry',
    preheader: 'Read every restraint, and see how the fees spread across the team.',
    body: [
      '{name},',
      'In recruitment, the client relationship sits with the consultant who fills the roles. A consultant who leaves after the sale can take the client with them unless their contract says otherwise.',
      'Read every consultant’s restraint and notice terms, and see how revenue spreads across the team. A desk where one biller brings in half the fees is a key person risk that needs pricing.',
      'The agency that owns your next niche is worth buying when the niche belongs to the agency rather than to one person.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_recruit_next_niche',
    industries: ['recruitment'],
    subject: 'which recruitment niche would you buy into',
    preheader: 'The same clients, hiring a different kind of role.',
    body: [
      '{name}, a question.',
      'The cleanest growth move in recruitment is buying an agency in the niche next to yours: the same clients hiring a different kind of role. A client who uses you for finance hires will listen when you can also fill their IT or engineering roles.',
      'Reply with the niche you’d add first, and I’ll tell you what I’d look for in an agency that already owns it.',
    ],
    cta: 'reply',
  },

  // ── Hospitality ──
  {
    id: 'lib_ind_hosp_lease_first',
    industries: ['hospitality'],
    subject: 'buying a venue starts with the lease',
    preheader: 'In hospitality, the lease decides whether you’re buying a business or a few years of one.',
    body: [
      '{name},',
      'In hospitality, the lease decides whether you’re buying a business or a few years of one. Term remaining, options, rent reviews, the make good clause and whether the landlord will consent to assignment all come before price.',
      'A venue with two years left and no option is a very different deal from the same venue with ten.',
      'The guide on buying a restaurant or venue covers the rest of the order.',
    ],
    ps: 'Talk to the landlord early, with the seller’s agreement, because their consent sits on your critical path.',
    cta: 'guide:buy-a-restaurant-or-venue',
  },
  {
    id: 'lib_ind_hosp_licence_chef',
    industries: ['hospitality'],
    subject: 'the liquor licence and the chef in a venue deal',
    preheader: 'Two things that walk out of a venue easily, and how to keep both.',
    body: [
      '{name},',
      'Two things in a venue walk out the door easily: the liquor licence, if the transfer isn’t handled with the regulator in time, and the head chef, if nobody has spoken to them.',
      'Put the licence transfer on the critical path from the day the offer is accepted. Meet the chef and the venue manager before settlement, with the seller’s blessing.',
      'Lenders look harder at hospitality than at most service businesses, and a clear plan on both points helps your case.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_hosp_shared_kitchen',
    industries: ['hospitality'],
    subject: 'the venue on your radar and your central kitchen',
    preheader: 'Each venue runs on thin margins. A group buys better and runs leaner.',
    body: [
      '{name},',
      'The venue that’s been on your radar gets cheaper to run once it shares what you already have: suppliers, purchasing, a central kitchen or prep, payroll and management.',
      'That’s the add on case in hospitality. Each venue on its own runs on thin margins, and a group buys better and runs leaner.',
      'Model the savings honestly, and make sure the venue covers its own debt before counting any of them.',
    ],
    cta: 'next',
  },

  // ── Childcare & education ──
  {
    id: 'lib_ind_childcare_approvals',
    industries: ['childcare'],
    subject: 'childcare centres: approvals before anything else',
    preheader: 'A change of provider has to line up with settlement, and the regulator sets the pace.',
    body: [
      '{name},',
      'A childcare centre operates under approvals: provider and service approvals in Australia, state licensing in the US. A change of owner triggers notifications or fresh applications, and the timing has to line up with settlement.',
      'Check the centre’s quality rating and recent compliance history too, because both affect enrolments and what the regulator asks of a new provider.',
      'The guide on buying a childcare centre walks through it.',
    ],
    cta: 'guide:buy-a-childcare-centre',
  },
  {
    id: 'lib_ind_childcare_occupancy',
    industries: ['childcare'],
    subject: 'occupancy is the number in a childcare deal',
    preheader: 'Gaps on Mondays and Fridays are upside your waitlist can fill.',
    body: [
      '{name}, a short one.',
      'Childcare profit moves with occupancy. Places are licensed, staff ratios are set, and every extra enrolled child in a room that’s already staffed adds revenue with little extra cost.',
      'Look at occupancy by room and by day for two years, and at the waitlist. The centre in the next suburb with gaps on Mondays and Fridays has upside your own waitlist can fill.',
      'Lenders lend on today’s occupancy, so that upside is yours.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_childcare_lease_educators',
    industries: ['childcare'],
    subject: 'childcare leases and educator turnover',
    preheader: 'Rent and staff stability show up in the numbers before they show up anywhere else.',
    body: [
      '{name},',
      'Childcare centres sit on long leases, and rent is one of the biggest costs after wages. Read the term, the rent reviews and the landlord’s obligations before you value the centre.',
      'Then look at the educators. A centre with a stable team and a long serving director keeps families, and one with constant turnover loses them.',
      'Both show up in the numbers well before they show up in the brochure.',
    ],
    ps: 'Ask for staff turnover by year alongside the financials, and read the two together.',
    cta: 'next',
  },

  // ── Logistics & freight ──
  {
    id: 'lib_ind_logistics_fleet_debt',
    industries: ['logistics'],
    subject: 'logistics deals: the fleet and the finance on it',
    preheader: 'Acquisition debt and equipment debt are paid from the same cash flow.',
    body: [
      '{name},',
      'In transport, much of the fleet carries its own equipment finance or leases. Every contract has to be listed, along with how it’s treated at settlement and what replacement the fleet needs in the next few years.',
      'Lenders look at the acquisition debt and the equipment debt together, against the same cash flow. The guide on buying a logistics business covers how to model both.',
    ],
    cta: 'guide:buy-a-logistics-business',
  },
  {
    id: 'lib_ind_logistics_lanes',
    industries: ['logistics'],
    subject: 'the carrier on the routes you want',
    preheader: 'Backloads, lane density and customers who ship both ways.',
    body: [
      '{name},',
      'The carrier on the routes you want gives you backloads, lane density and customers who ship both ways. Trucks that run full in both directions earn more per trip than trucks that come home empty.',
      'Ask for revenue by customer and by lane. Concentration matters in freight, because one large shipper changing providers takes a big piece of revenue with it.',
      'The right target fills your empty legs and spreads your customer base at the same time.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_logistics_compliance',
    industries: ['logistics'],
    subject: 'freight compliance checks before you buy a carrier',
    preheader: 'Operating authority, accreditation, driver hours and the insurance premium.',
    body: [
      '{name}, one for transport owners.',
      'In the US, a carrier’s operating authority and safety record sit with the entity, so a share purchase and an asset purchase play out differently. Australian deals need the same attention on heavy vehicle accreditation and chain of responsibility obligations.',
      'Check driver hours records, maintenance logs and any incident history. A clean compliance file protects the insurance premium, and the premium is a real line in the profit you’re buying.',
    ],
    ps: 'This is education, not legal advice, and a transport lawyer confirms what transfers in your deal.',
    cta: 'next',
  },

  // ── Property management ──
  {
    id: 'lib_ind_rentroll_retention',
    industries: ['property'],
    subject: 'rent roll deals and the retention period',
    preheader: 'Some landlords leave when the agency changes hands. Here is how the price handles it.',
    body: [
      '{name},',
      'A rent roll is a set of management agreements with landlords, and some of them leave when the agency changes hands. Australian rent roll sales commonly handle that with a retention period, where the price adjusts for properties lost in the first months.',
      'Check the agreements are signed and current, the trust account is clean and audited, and the fees match what the roll reports.',
      'The guide on buying a rent roll covers the rest.',
    ],
    cta: 'guide:buy-a-rent-roll',
  },
  {
    id: 'lib_ind_rentroll_doors_per_manager',
    industries: ['property'],
    subject: 'rent roll add ons and doors per manager',
    preheader: 'Your property managers, trust account and systems can carry more doors.',
    body: [
      '{name},',
      'A rent roll from an agency winding down slots into a business that already has property managers, a trust account and systems. Those managers take on more doors without the business adding the same cost again.',
      'Location matters too. Properties close to your existing ones mean shorter inspection runs and more doors per manager.',
      'Lenders know rent rolls well, and a clean roll with steady fees is one of the more financeable things to buy.',
    ],
    cta: 'next',
  },
  {
    id: 'lib_ind_rentroll_why_sell',
    industries: ['property'],
    subject: 'why an agency sells its rent roll',
    preheader: 'Each reason leads to a different conversation with the principal.',
    body: [
      '{name},',
      'Agencies sell their rent rolls for plain reasons: the principal wants to focus on sales, is retiring, or no longer wants the compliance load of a trust account.',
      'Each reason leads to a different conversation. The retiring principal wants their landlords cared for, and the sales focused one wants a clean exit and a referral arrangement.',
      'Reply with the area you’d want to add doors in, and I’ll tell you how I’d approach agencies there.',
    ],
    cta: 'reply',
  },
];
