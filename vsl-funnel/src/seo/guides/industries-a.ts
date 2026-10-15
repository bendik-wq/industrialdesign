import type { Guide } from '../types';

/**
 * Industry guides, part A: health (medical, dental, allied health, veterinary) and
 * trades and services (HVAC, plumbing, electrical, roofing & solar, landscaping, cleaning).
 */
export const INDUSTRY_GUIDES_A: Guide[] = [
  {
    slug: "buy-a-medical-practice",
    title: "How to Buy a Medical Practice or GP Clinic, No Money Down",
    description: "How clinic owners buy a GP or medical practice with no money down: what you acquire, doctor and patient risks, and how debt, seller finance and rollover fit.",
    h1: "How to Buy a Medical Practice With No Money Down",
    answer: "Buying a medical practice with no money down means funding the price from senior debt, vendor finance (seller finance) and seller rollover instead of your own cash. It works best when an established clinic owner buys a nearby practice whose owner-doctor wants to retire, and repayments come from the practice's own cash flow while key doctors and patients stay.",
    keyPoints: [
      "You are buying doctor relationships, a patient book, staff, a lease and systems. Billing numbers and registrations usually stay with the individual doctor.",
      "The biggest risk is how much of the revenue walks out the door if the owner-doctor or one high-billing doctor leaves.",
      "Owner-doctors who keep consulting suit seller rollover. Retiring owners suit a 70/20/10 split or 100% vendor finance.",
      "Josh Li bought two of his own clinics with 100% vendor finance: no bank and no equity partner.",
      "The synergies are shared management, rostering across sites and filling empty consulting rooms.",
    ],
    body: `## What are you actually buying when you buy a medical practice?

A medical practice is mostly people and habits. The balance sheet is small: some fit-out, a few treatment beds and software. The value sits in four things:

- **The doctors.** In many clinics, doctors work as independent contractors who pay the practice a share of their billings. They are not employees. Their agreements, notice periods and restraints decide whether the revenue stays.
- **The patient book.** This means active patients, usually defined as patients seen within a set recent period. Agree the definition in writing, because "patients on file" can be several times bigger than the real book.
- **The support team.** The practice manager, nurses and reception run the place. A good practice manager is often worth more than the fit-out.
- **The premises and systems.** This covers the lease, accreditation status, practice software, recall lists and any income from co-located tenants such as pathology collection or allied health rooms.

Billing numbers and professional registrations usually belong to the individual doctor, not the clinic, so they do not transfer. That is why doctor retention is the whole game.

## What makes a medical practice a good acquisition target?

- **Several doctors, not one.** A clinic where the owner bills most of the revenue is a job, not a business.
- **A practice manager who already runs operations.** The owner should be able to take a holiday without bookings collapsing.
- **Spare rooms.** Underused consulting rooms are capacity you can fill with another doctor or an allied health tenant.
- **A long, assignable lease.** Relocating a clinic loses patients.
- **Close to your existing clinic, but not on top of it.** "The practice across town" shares your recruiting pool without fighting for the same patients.

## What are the due diligence risks specific to medical practices?

| Risk | What to check | Why it matters |
|---|---|---|
| Owner-doctor dependence | Share of billings from the owner, by month | If they cut back, revenue drops with them |
| Doctor agreements | Term, notice, restraint, whether they can be assigned | Doctors can leave with weeks of notice |
| Patient records and privacy | How records legally transfer to a new owner | Rules differ; check the rules in your state/country |
| Ownership and fee rules | Who may own a practice and how fees are structured | Some places restrict ownership or contractor models |
| Contractor classification | Whether contractor arrangements reflect reality | A mislabelled employee can become a back-pay liability |
| Accreditation | Current status and next review date | Lapsed accreditation can affect funding and insurer relationships |

Our full list of warning signs is in [due diligence red flags](/guides/due-diligence-red-flags).

## Why do medical practice owners sell?

Most owner-doctors do not want to stop practising medicine. They want to stop running a business. Rostering, recruiting doctors, compliance, IT and staff issues pile up on top of a full patient list. The common triggers are age, burnout from the management load, and the lack of a successor among the doctors, who often prefer to stay as contractors. Many owners would happily keep consulting two or three days a week if someone else carried the business.

## Which no-money-down structure fits a medical practice?

Every structure funds the price from the same three parts in different mixes: **senior (commercial) debt**, **seller finance** and **seller rollover**.

| Situation | Structure that often fits | Why |
|---|---|---|
| Owner-doctor will keep consulting | [60/40](/guides/60-40-deal-structure): 60% commercial debt, 40% seller rollover | The owner keeps a stake, so they stay invested in keeping doctors and patients |
| Owner wants to retire within a year or two | [70/20/10](/guides/70-20-10-deal-structure) | Most of the money at settlement, a note paid from cash flow, a small stake |
| Owner cares most about patients and staff | [100% vendor finance](/guides/100-percent-vendor-finance) | Paid over time from the clinic's cash flow, by a successor they trust |

Medical practices are where Josh Li started. He bought two of his own clinics with 100% vendor finance: no bank and no equity partner. The owners were paid over time from the clinics' own cash flow. What made those sellers say yes was not the price. It was confidence that their patients, staff and reputation would be looked after.

## What synergies come from buying a competing clinic?

- **One management layer.** One practice manager, one payroll, one software licence, one accreditation process.
- **Doctor recruiting across two sites.** You can offer a new doctor a fuller book sooner, which is the hardest thing to offer in medicine.
- **Shared nursing and reception rosters** that cover leave and sickness without agency staff.
- **Overflow bookings.** When one clinic is full, patients are offered the other instead of a competitor.
- **Bulk purchasing** of consumables and vaccines.

More on this in [how to buy your competitor](/guides/buy-your-competitor).

## Illustrative example: buying the clinic across town

*Illustrative only. The numbers are rounded and not a forecast.*

You own a six-doctor clinic doing $2.5M in revenue. Across town, a 64-year-old owner-GP runs a five-room clinic with three contractor doctors. They want to cut back to two days a week and stop managing.

- Agreed price: $1.2M. The clinic produces about $400k a year in cash flow before debt repayments.
- Structure (70/20/10): $840k commercial debt, a $240k seller note paid over three years, and $120k rolled into a 10% stake.
- Illustrative total repayments are about $265k a year, which gives a debt service coverage ratio (DSCR) of about 1.5x. That is $400k of cash flow divided by $265k of repayments. See [DSCR explained](/guides/dscr-explained).
- The owner keeps consulting for 18 months, introduces you to every doctor, and their rollover stake rewards them for keeping the doctors.

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the practice across town?

If you own an established clinic and want to buy another without putting in your own cash, we will show you how the numbers could work on a real target. [See if you qualify](/medical).`,
    faqs: [
      { q: "Can you buy a medical practice with no money down?", a: "Yes, if the clinic has steady cash flow and the seller agrees to take part of the price as seller finance or seller rollover. Senior debt funds the rest, and repayments come from the practice's cash flow." },
      { q: "Do patients transfer when you buy a GP clinic?", a: "Patients are not owned, so they can go elsewhere. They tend to stay when their doctor stays, which is why doctor retention and a handover period matter more than the patient count." },
      { q: "Do I need to be a doctor to own a medical practice?", a: "In many places non-doctors can own a practice, but some jurisdictions have ownership or fee-structure rules. Check the rules in your state/country before you sign." },
      { q: "What is the biggest risk when buying a medical practice?", a: "Doctors leaving. If one doctor bills a large share of revenue and can leave on short notice with no enforceable restraint, the practice's value can fall sharply after settlement." },
      { q: "How is a medical practice valued?", a: "It is usually valued on the cash flow the practice earns after paying a market rate for every doctor, including the owner. Then it is adjusted for doctor retention risk, lease term and how dependent the practice is on the owner." },
      { q: "Will the seller keep working after the sale?", a: "Often, yes. Many owner-doctors want to keep consulting part-time, and a seller rollover stake gives them a reason to help keep doctors and patients." },
    ],
    related: ["100-percent-vendor-finance", "70-20-10-deal-structure", "buy-a-physio-or-allied-health-practice", "due-diligence-red-flags", "buy-your-competitor"],
    industry: "medical",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-dental-practice",
    title: "How to Buy a Dental Practice With No Money Down: Guide",
    description: "How dental practice owners buy another practice with no money down: valuing chairs and recall, equipment and treatment risks, and the deal structures that fit.",
    h1: "How to Buy a Dental Practice With No Money Down",
    answer: "Buying a dental practice with no money down means paying for it with commercial debt, seller finance and seller rollover, then servicing those repayments from the practice's own cash flow. It suits an established dental practice owner buying a nearby practice with a healthy hygiene recall, sound equipment and a principal dentist ready to step back.",
    keyPoints: [
      "The real asset is an active recall system: patients who come back every six or twelve months without being sold to.",
      "Chairs, imaging and sterilisation equipment can need expensive replacement. Inspect their age before you agree a price.",
      "Prepaid treatment, especially orthodontics, is a liability you inherit. Someone has to finish that work.",
      "A principal dentist who keeps producing suits seller rollover. A retiring principal suits 70/20/10 or 100% vendor finance.",
      "Synergies come from hygiene capacity, keeping specialist work in-house and bigger lab and supply volumes.",
    ],
    body: `## What are you actually buying when you buy a dental practice?

A dental practice has more hard assets than a medical clinic, but the value still sits in recurring patient behaviour:

- **The recall book.** These are patients who return for check-ups and hygiene appointments on a schedule. A well-run recall system is the closest thing dentistry has to a subscription.
- **Clinical team and production.** This means associate dentists, hygienists or oral health therapists, and dental assistants. Look at who produces the revenue and how it is split.
- **Chairs and equipment.** This covers operatories, X-ray and other imaging, compressors, suction, sterilisation and practice software.
- **Insurer and plan arrangements.** These are preferred-provider agreements with health funds or insurers, and any in-house membership plans.
- **Premises and fit-out.** Dental fit-outs are expensive to move, so the lease matters even more than usual.

## What makes a dental practice a good acquisition target?

- **Strong, documented recall.** Ask for the share of active patients who have a future appointment booked. A practice that relies on new-patient marketing is fragile.
- **The principal produces well under half of revenue.** The more associates and hygienists produce, the more transferable the goodwill.
- **Spare chairs or spare hours.** An empty operatory is growth you can staff instead of building.
- **Equipment with years of life left**, or a price that reflects replacement.
- **Close enough to share staff.** "The practice two suburbs over" can share hygienists and cover leave.

## What are the due diligence risks specific to dental practices?

| Risk | What to check | Why it matters |
|---|---|---|
| Principal dependence | Production by provider, by month | Revenue can drop when the principal cuts back |
| Equipment age | Installation dates and service records for chairs, imaging and compressors | Replacements can absorb the first years of cash flow |
| Prepaid and in-progress treatment | Orthodontic and staged treatment already paid for | You may have to finish work with no new revenue |
| Imaging and infection control compliance | Registrations, licences and audit records | Check the rules in your state/country; lapses can halt work |
| Insurer agreements | Whether preferred-provider contracts survive a change of owner | Some must be re-signed, and fee schedules can change |
| Associate agreements | Restraints, notice and patient non-solicitation | Associates can open nearby and take patients |

The general warning signs are in [due diligence red flags](/guides/due-diligence-red-flags).

## Why do dental practice owners sell?

Dentistry is physically hard. Years of fine work at the chair take a toll on necks, backs and eyes. Many principals want to keep doing the clinical work they enjoy without managing staff, marketing, equipment and compliance. Others want out entirely and have no associate willing or able to buy them out. A buyer who lets them step back gradually, without a bank-funded fire sale, is often more attractive than a slightly higher cash bid.

## Which no-money-down structure fits a dental practice?

Each structure mixes the same three parts: **senior (commercial) debt**, **seller finance** and **seller rollover**.

- **[60/40](/guides/60-40-deal-structure)** fits a principal who will keep producing for several years. They roll 40% into equity, so they share in the growth they help create. The lender takes security over the business's assets rather than a personal guarantee.
- **[70/20/10](/guides/70-20-10-deal-structure)** fits a principal retiring within one or two years. Most of the money comes at settlement, a seller note is paid from cash flow, and a 10% stake keeps them invested in the handover.
- **[100% vendor finance](/guides/100-percent-vendor-finance)** fits a principal who cares most about patients and team continuity and wants a steady income instead of a lump sum.

If equipment needs replacing, build it into the deal. Lenders will often fund a working-capital line on top of the price, which is how an [over-financed acquisition](/guides/over-financed-acquisition) covers early capital spending.

## What synergies come from buying a competing dental practice?

- **Hygiene capacity.** Move overflow recall patients into the practice with open hygiene hours.
- **Specialist work kept in-house.** Implants, orthodontics or sedation offered across both sites instead of referred out.
- **Lab and supply volume.** One account with bigger volume usually means better terms.
- **One back office.** Shared bookkeeping, marketing, payroll and practice software.
- **Leave cover.** Dentists and hygienists cover each other without locum costs.

## Illustrative example: buying the practice two suburbs over

*Illustrative only. The numbers are rounded and not a forecast.*

You own a four-chair practice. Two suburbs over, a principal in their early sixties runs a five-chair practice with one associate and two hygienists. They produce a little over half the revenue.

- Agreed price: $1.5M. The practice earns about $480k a year in cash flow before debt repayments, after paying the principal a market wage for their clinical work.
- Structure (60/40): $900k commercial debt, and the principal rolls $600k into a 40% stake. They keep working three days a week.
- The lender adds a working-capital line to replace two ageing chairs in the first year.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the practice two suburbs over?

If you own an established dental practice and want to grow by acquisition without your own cash, we will walk you through how it could work. [See if you qualify](/dental).`,
    faqs: [
      { q: "Can a dentist buy a practice with no money down?", a: "Yes, when the practice has steady cash flow and the seller agrees to take part of the price as seller finance or seller rollover. Commercial debt covers the rest, and repayments come from the practice's own earnings." },
      { q: "What should I check before buying a dental practice?", a: "Check production by provider, recall rates, equipment age and service records, prepaid treatment, associate agreements and whether insurer agreements survive the change of owner." },
      { q: "What happens to prepaid orthodontic treatment when a practice sells?", a: "The buyer usually inherits the obligation to finish it. The cost of finishing that work is normally deducted from the price or held back at settlement." },
      { q: "How important is the hygiene recall when buying a dental practice?", a: "Very important. A strong recall means patients come back on a schedule, which makes revenue predictable and easier to borrow against." },
      { q: "Will the principal dentist stay after the sale?", a: "Often for a transition period, and sometimes for years. A seller rollover stake rewards them for staying productive and introducing patients to the new team." },
      { q: "Do I need a specialist dental lender?", a: "Not necessarily. Lenders look at cash flow, debt service coverage and the security available. A well-documented practice can attract several types of commercial lender." },
    ],
    related: ["60-40-deal-structure", "over-financed-acquisition", "buy-a-medical-practice", "due-diligence-red-flags", "dscr-explained"],
    industry: "dental",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-physio-or-allied-health-practice",
    title: "How to Buy a Physio or Allied Health Practice, No Money Down",
    description: "How to buy a physio, podiatry, chiro, psychology or optometry practice with no money down: referral risk, practitioner retention and deal structures that fit.",
    h1: "How to Buy a Physio or Allied Health Practice With No Money Down",
    answer: "Buying a physio or allied health practice with no money down means funding the price through commercial debt, seller finance and seller rollover, repaid from the practice's own cash flow. It works best for an established practice owner buying a nearby clinic with several practitioners, diverse referral sources and an owner willing to stay on through the handover.",
    keyPoints: [
      "You are buying practitioners, referral relationships and repeat caseloads. Equipment is usually a small part of the value.",
      "Referral concentration is the hidden risk: one GP, one sports club or one aged-care contract can carry a clinic.",
      "Practitioner retention decides the deal, so check restraints and how clients are allocated.",
      "Owner-practitioners who keep treating suit seller rollover. Burnt-out owners suit 70/20/10.",
      "Buying a different discipline nearby creates cross-referral that neither clinic could build alone.",
    ],
    body: `## What are you actually buying when you buy an allied health practice?

Allied health covers physiotherapy, podiatry, chiropractic, psychology, optometry, occupational therapy, exercise physiology and similar disciplines. The details differ, but the asset is the same: repeat patient visits that come through referral and reputation.

- **Practitioners and their caseloads.** These are employed or contracted clinicians and the patients who book with them.
- **Referral relationships.** These come from GPs, specialists, sports clubs, schools, workplaces and aged-care facilities.
- **Contracts and funded programs.** These include aged-care service contracts, workplace injury work and government or insurer-funded programs. Some can be assigned to a new owner and some cannot.
- **Classes and memberships.** Clinical Pilates, rehab gyms and group programs bring recurring income that is not tied to one practitioner.
- **Stock and equipment.** Orthotics, frames and lenses in optometry, and treatment equipment. This is usually modest.

## What makes an allied health practice a good acquisition target?

- **At least three clinicians**, so no single person carries the books.
- **Referrals from many sources.** No single referrer should supply a big share of new patients.
- **Strong rebooking.** Patients complete treatment plans instead of attending once.
- **Recurring programs** such as classes, aged-care contracts or memberships that survive staff changes.
- **A complementary discipline.** A physio owner buying "the podiatry practice down the road" gains referrals in both directions.

## What are the due diligence risks specific to allied health?

| Risk | What to check | Why it matters |
|---|---|---|
| Practitioner walk-out | Contracts, restraints, non-solicitation, how patients are allocated | A clinician can open nearby and take their caseload |
| Referral concentration | New patients by referrer over the last two years | Losing one GP or contract can cut intake sharply |
| Funder dependence | Share of revenue from government schemes, insurers or injury programs | Rules and fee schedules change; check the rules in your state/country |
| Contract assignability | Change-of-control clauses in aged-care and corporate contracts | Some need the client's consent to transfer |
| Registrations | Every clinician's current registration and insurance | Unregistered practice can void insurance and claims |
| Clinical records | Who owns the notes and how they transfer | Privacy obligations differ by jurisdiction |

See also [due diligence red flags](/guides/due-diligence-red-flags) and [questions to ask a business seller](/guides/questions-to-ask-a-business-seller).

## Why do allied health owners sell?

Most allied health owners are still treating full-time while running the business at night. Burnout is the common reason. The owner is the best clinician, the main referral contact and the manager all at once. Others sell because their associates want stability, not ownership, so there is no internal successor. Many would happily keep a reduced caseload if someone else ran the business.

## Which no-money-down structure fits an allied health practice?

Every structure combines **senior (commercial) debt**, **seller finance** and **seller rollover**. The mix depends on how much the goodwill depends on the owner.

| Situation | Structure that often fits |
|---|---|
| Owner is the top referral contact and will keep treating | [60/40](/guides/60-40-deal-structure). A 40% seller rollover keeps them invested in passing on referrers |
| Owner wants out within a year | [70/20/10](/guides/70-20-10-deal-structure), with a structured handover of referrers |
| Small practice, owner values legacy and staff | [100% vendor finance](/guides/100-percent-vendor-finance), paid from cash flow over time |

Allied health deals are often smaller than medical or dental deals. That makes seller finance a bigger share of the solution, because the seller is often the most motivated lender in the room.

## What synergies come from buying a nearby allied health practice?

- **Cross-referral.** Physio to podiatry, podiatry to exercise physiology, psychology to GP-referred care plans. Patients stay in your network.
- **A shared front desk and booking system**, which can absorb a second clinic's admin with little extra headcount.
- **Bigger contracts.** Two clinics can service aged-care facilities, schools or workplaces across a wider area.
- **Class timetables** filled from two patient bases.
- **Recruiting and mentoring.** Graduates join groups that offer supervision and a full caseload.

## Illustrative example: buying the podiatry practice down the road

*Illustrative only. The numbers are rounded and not a forecast.*

You own a physio group with two sites. Down the road, a podiatrist in their fifties runs a three-practitioner clinic with an aged-care contract. They are exhausted and want to work three days a week.

- Agreed price: $600k. The clinic earns about $200k a year in cash flow before debt repayments, after paying the owner a market wage.
- Structure (60/40): $360k commercial debt, and the owner rolls $240k into a 40% stake. They keep treating and introduce you to every referring GP.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).
- Your physios start referring foot and ankle patients to podiatry the first month, and podiatry refers back.

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the practice down the road?

If you own an established allied health practice and want to grow without using your own cash, we will show you how the structure could work on a real target. [See if you qualify](/allied-health).`,
    faqs: [
      { q: "Can I buy a physio clinic with no money down?", a: "Yes, if the clinic has reliable cash flow and the seller accepts part of the price as seller finance or seller rollover. Commercial debt funds the rest, repaid from the clinic's earnings." },
      { q: "What is the biggest risk in buying a physio practice?", a: "Practitioners leaving and taking their patients, closely followed by losing a major referrer. Check restraints, referral sources and how patients are allocated before you sign." },
      { q: "Do patients stay after a physio practice is sold?", a: "Patients usually follow their clinician and their referrer. If both stay through the handover, most patients stay too." },
      { q: "Can a physio buy a podiatry or chiro practice?", a: "Often yes, and it can create cross-referral. Some disciplines have ownership or supervision rules, so check the rules in your state/country." },
      { q: "Are aged-care contracts transferable when you buy a practice?", a: "Sometimes. Many contracts need the client's consent on a change of owner, so read the change-of-control clauses and speak to the facility early." },
      { q: "How long should the seller stay after selling an allied health practice?", a: "Long enough to introduce you to every key referrer and to settle the clinicians, often six to eighteen months. A rollover stake makes that easier to agree." },
    ],
    related: ["60-40-deal-structure", "buy-a-medical-practice", "questions-to-ask-a-business-seller", "due-diligence-red-flags", "seller-rollover-explained"],
    industry: "allied-health",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-vet-clinic",
    title: "How to Buy a Vet Clinic or Practice With No Money Down",
    description: "How vet clinic owners buy another clinic with no money down: client and staff risks, equipment and drug compliance, and the deal structures that fit.",
    h1: "How to Buy a Vet Clinic With No Money Down",
    answer: "Buying a vet clinic with no money down means funding the price with commercial debt, seller finance and seller rollover, then paying them back from the clinic's cash flow. It suits an established veterinary owner buying a nearby clinic whose owner-vet is tired of after-hours work, where the vets and nurses will stay and the equipment is sound.",
    keyPoints: [
      "You are buying a client base of pet owners, a vet and nurse team, surgical and imaging equipment, and often wellness plans.",
      "Vets and nurses are scarce. Staff retention is the main risk in almost every vet acquisition.",
      "Controlled drug records, imaging compliance and equipment age need careful checks.",
      "After-hours burnout is a common reason owner-vets sell, and sharing an after-hours roster is a big synergy.",
      "Independent owners often prefer a local successor paid over time to selling to a large group.",
    ],
    body: `## What are you actually buying when you buy a vet clinic?

A vet clinic sits between a medical practice and a retail business. You are buying:

- **The client base.** Pet owners with active animals on file, plus their vaccination and dental reminders. Ask how many clients visited in the last year, not how many are on file.
- **The team.** Vets, vet nurses and reception. In many markets vets are hard to recruit, so a stable team can be worth more than the building.
- **Clinical equipment.** Surgical suite, anaesthetic machines, X-ray and ultrasound, in-house lab analysers, dental units and kennels.
- **Inventory.** Medicines, including controlled drugs, plus pet food and retail stock.
- **Recurring programs.** Wellness or pet health plans, where clients pay monthly for routine care, plus boarding, grooming and puppy classes.
- **After-hours arrangements.** Whether the clinic covers its own after-hours care or refers to an emergency centre.

## What makes a vet clinic a good acquisition target?

- **More than one full-time vet**, with the owner doing a minority of the consults and surgery.
- **Nurses who stay.** Low nurse turnover is a strong sign of a well-run clinic.
- **A healthy share of revenue from routine care** such as vaccinations, dental work and wellness plans, not only one-off emergencies.
- **Equipment with life left in it**, or a price that reflects replacement.
- **Within reach of your clinic.** "The clinic the next town over" can share relief vets and after-hours cover.

## What are the due diligence risks specific to vet clinics?

| Risk | What to check | Why it matters |
|---|---|---|
| Vet and nurse retention | Tenure, pay compared with market, contracts and restraints | Replacing a vet can take months and leave revenue on the table |
| Owner-vet dependence | Owner's share of consults and surgery | Revenue drops if the owner steps back faster than planned |
| Controlled drugs | Drug register, storage and audit history | Check the rules in your state/country; breaches carry serious penalties |
| Imaging and premises compliance | Radiation registrations, premises licences and waste handling | Lapses can stop parts of the clinic operating |
| Equipment age | Purchase dates and service records | Imaging and anaesthetic equipment is expensive to replace |
| Inventory value | Stocktake at settlement, expired stock | Out-of-date drugs should not be in the price |

See [due diligence red flags](/guides/due-diligence-red-flags) for the general list.

## Why do vet clinic owners sell?

After-hours work is the big one. Years of being on call nights and weekends, often with a small team, wears owners down. Add the difficulty of recruiting vets, the emotional load of the work and the business admin, and many owners in their fifties and sixties want out. Larger groups may already have approached them. Many independent owners would still prefer a local successor who keeps the clinic's name, its staff and its way of treating clients.

## Which no-money-down structure fits a vet clinic?

Each structure blends **senior (commercial) debt**, **seller finance** and **seller rollover**.

- **[70/20/10](/guides/70-20-10-deal-structure)** is a common fit. The owner-vet gets most of their money at settlement, a seller note paid from cash flow, and a 10% stake. The lender often adds a working-capital line, which can fund an equipment upgrade.
- **[60/40](/guides/60-40-deal-structure)** fits an owner who wants to keep consulting but drop after-hours and management. Their 40% seller rollover keeps them invested in team retention.
- **[100% vendor finance](/guides/100-percent-vendor-finance)** fits an owner who has turned down a corporate offer because they care about their staff and clients. They are paid over time from the clinic's own cash flow.

Be honest about where you compete with larger groups. You usually will not win on headline price. You win on continuity, a handover the owner controls and a stake in what comes next. More on this in [seller rollover explained](/guides/seller-rollover-explained).

## What synergies come from buying a nearby vet clinic?

- **A shared after-hours roster.** Two clinics splitting nights and weekends can transform staff retention.
- **A relief vet pool** covering leave across both sites without locum fees.
- **A surgical or imaging hub.** One clinic does the advanced work and the other refers in.
- **Purchasing.** Bigger drug, food and consumables volumes on one account.
- **One wellness plan** offered across both client bases.

## Illustrative example: buying the clinic the next town over

*Illustrative only. The numbers are rounded and not a forecast.*

You own a three-vet clinic. The next town over, a 61-year-old owner runs a two-vet clinic with four nurses and covers every after-hours call personally. A larger group has made an offer, but the owner does not want their team absorbed.

- Agreed price: $1.1M. The clinic earns about $360k a year in cash flow before debt repayments, after paying the owner a market wage.
- Structure (70/20/10): $770k commercial debt, a $220k seller note over three years, and $110k rolled into a 10% stake.
- After-hours is merged into a shared roster on day one. The owner keeps two consulting days for a year.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the clinic the next town over?

If you own an established vet clinic and want to buy another without your own cash, we will show you how it could work on a real target. [See if you qualify](/veterinary).`,
    faqs: [
      { q: "Can you buy a vet clinic with no money down?", a: "Yes, when the clinic's cash flow can support repayments and the seller agrees to take part of the price as seller finance or seller rollover. Commercial debt funds the rest." },
      { q: "Do I have to be a vet to own a vet clinic?", a: "Not always. Some jurisdictions have rules about who can own a veterinary practice or supervise clinical work, so check the rules in your state/country." },
      { q: "What should I check before buying a vet practice?", a: "Check staff tenure and pay, the owner's share of the work, controlled-drug records, imaging and premises compliance, equipment age and an inventory count at settlement." },
      { q: "How do I compete with corporate buyers for a vet clinic?", a: "Usually not on price alone. Many owners value keeping the clinic's name, staff and culture, a gradual handover and a stake through seller rollover." },
      { q: "Are pet wellness plans valuable when buying a clinic?", a: "Yes. Clients paying monthly for routine care give predictable revenue, which lenders like and which makes the clinic easier to finance." },
      { q: "What happens to the drug inventory when a vet clinic is sold?", a: "It is normally counted at settlement and paid for at cost, excluding expired stock. Controlled drugs must be transferred and recorded under the rules where you operate." },
    ],
    related: ["70-20-10-deal-structure", "seller-rollover-explained", "100-percent-vendor-finance", "due-diligence-red-flags", "buy-your-competitor"],
    industry: "veterinary",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-an-hvac-business",
    title: "How to Buy an HVAC Company or Business With No Money Down",
    description: "How HVAC contractors buy a competitor with no money down: valuing maintenance contracts, licence and warranty risks, and the deal structures that fit.",
    h1: "How to Buy an HVAC Business With No Money Down",
    answer: "Buying an HVAC business with no money down means funding the price with commercial debt, seller finance and seller rollover, repaid from the business's cash flow. It works best when an established HVAC contractor buys a competitor with recurring maintenance contracts, licensed technicians who will stay, and an owner who wants out of the vans and the after-hours calls.",
    keyPoints: [
      "Recurring maintenance contracts are the most valuable thing an HVAC business owns, and lenders lend most readily against them.",
      "Install and project revenue is lumpier and carries warranty callbacks, so it is weighted more cautiously.",
      "Check that the trading licence and refrigerant handling licences will survive the owner leaving.",
      "Change-of-control clauses in commercial maintenance contracts can let clients walk away.",
      "Route density, a shared on-call roster and supplier buying power are the main synergies.",
    ],
    body: `## What are you actually buying when you buy an HVAC business?

HVAC means heating, ventilation and air conditioning, and often refrigeration too. An HVAC business has two different engines, and you should value them separately:

- **Service and maintenance agreements.** These are scheduled servicing of commercial plant, residential maintenance plans and preventive maintenance contracts with building owners and facility managers. This revenue repeats.
- **Install and project work.** This covers equipment replacements, new-build installs and fit-outs. It can be profitable but lumpy, and it depends on quoting and builder relationships.

Alongside those you are buying:

- **Licensed technicians.** Refrigerant handling and trade licences are personal to each technician. A business without enough licensed staff cannot do the work.
- **The business licence.** In many places a contracting licence is held by the company through a nominated qualified person, often the owner.
- **Fleet, tools and parts stock.** Vans, recovery units, vacuum pumps and stocked parts.
- **Supplier and manufacturer status.** Dealer or installer accreditation and the pricing that comes with it.

## What makes an HVAC business a good acquisition target?

- **A meaningful share of revenue from maintenance contracts**, renewed year after year.
- **A commercial client base with assets on site** such as rooftop units, chillers and cool rooms that need ongoing service.
- **Technicians who have been there for years**, with at least one senior tech who can lead without the owner.
- **Job management software** with service history by site. That history is what lets you quote renewals accurately.
- **Overlap with your territory.** "The HVAC company you keep bidding against" probably services buildings near yours.

## What are the due diligence risks specific to HVAC?

| Risk | What to check | Why it matters |
|---|---|---|
| Licence nominee | Who holds the contracting licence and what happens if they leave | The business may be unable to trade without a replacement nominee; check the rules in your state/country |
| Contract assignability | Change-of-control and termination-for-convenience clauses | Clients may be able to end contracts when ownership changes |
| Warranty callbacks | Install warranties outstanding and the callback history | You may inherit the cost of fixing past installs |
| Technician retention | Tenure, pay compared with market, licences held | Techs are hard to replace and can take clients |
| Fleet and tool age | Van ages, kilometres and leases | Fleet replacement can eat early cash flow |
| Seasonality and work in progress | Monthly revenue over three years; project progress billing | Peak-season numbers can flatter a sale |

For the full checklist, see [due diligence red flags](/guides/due-diligence-red-flags).

## Why do HVAC business owners sell?

Owners who started on the tools often still run the after-hours phone and quote at night. Peak season means long days in roof spaces and on rooftops. Common triggers are age, physical wear, chasing technicians in a tight labour market, and having no family member or senior tech who wants to take on the risk. Many have been approached by larger groups and do not like the idea of their name disappearing.

## Which no-money-down structure fits an HVAC business?

Each structure combines **senior (commercial) debt**, **seller finance** and **seller rollover**. The more of the revenue that is recurring maintenance, the more of the price senior debt can usually carry.

| Revenue mix | Structure that often fits | Why |
|---|---|---|
| Mostly maintenance contracts | [70/20/10](/guides/70-20-10-deal-structure) | Contracted revenue supports a larger commercial loan; the seller note covers the rest |
| Mixed maintenance and install, owner still quotes | [60/40](/guides/60-40-deal-structure) | A 40% rollover keeps the owner winning work and passing on builder relationships |
| Owner values the team above a lump sum | [100% vendor finance](/guides/100-percent-vendor-finance) | Paid over time from cash flow by a successor who keeps the techs |

A warranty holdback, where part of the seller note waits until the install warranty period ends, aligns the seller with the quality of past work.

## What synergies come from buying a competing HVAC business?

- **Route density.** More service sites in the same area means less driving and more billable hours per technician.
- **One on-call roster** shared across a bigger team, which helps technician retention.
- **Supplier buying power** on equipment, refrigerant and parts.
- **Cross-selling.** Maintenance plans offered to the other business's install customers, and installs quoted to its maintenance clients.
- **One office.** Dispatch, quoting, invoicing and compliance handled once.

See [how to buy your competitor](/guides/buy-your-competitor) for how to approach the owner.

## Illustrative example: buying the company you keep bidding against

*Illustrative only. The numbers are rounded and not a forecast.*

You run a 12-technician HVAC business. A competitor with eight technicians and a solid book of commercial maintenance contracts keeps showing up on the same tenders. Its owner is 63 and still answers the after-hours phone.

- Agreed price: $1.5M. The business earns about $500k a year in cash flow before debt repayments, after paying a manager to replace the owner.
- Structure (70/20/10): $1.05M commercial debt, a $300k seller note over three years (part of it held back until install warranties lapse), and $150k rolled into a 10% stake.
- The lender adds a working-capital line to cover wages during the slow season.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the HVAC company you keep bidding against?

If you own an established HVAC business and want to double it by acquisition without your own cash, we will show you how it could work. [See if you qualify](/hvac).`,
    faqs: [
      { q: "Can you buy an HVAC company with no money down?", a: "Yes, if the business has steady cash flow, ideally from maintenance contracts, and the seller agrees to take part of the price as seller finance or seller rollover. Commercial debt funds the rest." },
      { q: "Why are HVAC maintenance contracts so valuable?", a: "They repeat every year and are scheduled in advance, so revenue is predictable. Lenders can lend more against predictable cash flow." },
      { q: "What happens to the HVAC licence when the owner sells?", a: "If the licence relies on the owner as the nominated qualified person, a replacement nominee is usually needed. Check the rules in your state/country and plan this before settlement." },
      { q: "What should I check before buying an HVAC business?", a: "Check the split of maintenance and install revenue, contract assignability, licence nominee arrangements, warranty callbacks, technician tenure and fleet age." },
      { q: "Will commercial maintenance clients stay after I buy an HVAC company?", a: "Most stay if service quality and familiar technicians continue. Read change-of-control clauses and plan introductions to key clients with the seller." },
      { q: "How do I handle warranties on installs the seller did?", a: "A common approach is to hold back part of the seller note until the warranty period ends, so the cost of callbacks is shared fairly." },
    ],
    related: ["70-20-10-deal-structure", "buy-your-competitor", "buy-a-plumbing-business", "buy-an-electrical-business", "due-diligence-red-flags"],
    industry: "hvac",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-plumbing-business",
    title: "How to Buy a Plumbing Business With No Money Down: Guide",
    description: "How plumbing owners buy a competitor with no money down: the accounts and registers you acquire, licence and panel risks, and the deal structures that fit.",
    h1: "How to Buy a Plumbing Business With No Money Down",
    answer: "Buying a plumbing business with no money down means paying the price with commercial debt, seller finance and seller rollover, then servicing them from the business's own cash flow. It suits an established plumbing owner buying a competitor with repeat accounts such as property managers and strata, licensed plumbers who stay, and an owner ready to get off the tools.",
    keyPoints: [
      "Repeat accounts with property managers, strata, facility managers and commercial sites are worth far more than one-off household jobs.",
      "Testing registers, such as annual backflow device testing, are recurring revenue that often goes unvalued.",
      "Insurance and maintenance panel appointments may not transfer to a new owner. Confirm before you price them.",
      "The licence nominee, apprentices and builder concentration are the plumbing-specific risks.",
      "Shared dispatch, emergency rosters and drainage equipment are where two plumbing businesses save money.",
    ],
    body: `## What are you actually buying when you buy a plumbing business?

A plumbing business can look like a phone number and a few vans. The value is in who keeps calling:

- **Repeat accounts.** Property managers, strata and body corporate managers, facility managers, schools, councils and commercial sites send work every week without being sold to.
- **Testing and compliance registers.** Annual backflow prevention testing, thermostatic mixing valve servicing, gas appliance servicing and similar scheduled work. Each device on the register is a booking next year.
- **Panel appointments.** Insurance repair panels and maintenance panels can bring steady volume, but they are often personal to the business and need re-approval on a change of owner.
- **The emergency reputation.** The phone number, website, reviews and map listings that bring in blocked drains and burst pipes at 2am.
- **People and kit.** Licensed plumbers, gas fitters and apprentices, plus vans, drain cameras, jetters and pipe-relining gear.

## What makes a plumbing business a good acquisition target?

- **Most revenue from maintenance and service, not new construction.** Builder work is lumpier and carries defect and payment risk.
- **A documented testing register** with device locations and due dates.
- **A team leader or senior plumber who already runs the day**, so the business is not the owner on the tools.
- **Many accounts.** No single property manager or builder should supply a big share of revenue.
- **A motivated owner.** "The plumbing business whose owner wants out" is often worth more to you than to anyone else, because you can absorb its work.

## What are the due diligence risks specific to plumbing?

| Risk | What to check | Why it matters |
|---|---|---|
| Licence nominee | Who holds the contractor licence and gas licences | The business may not be able to trade without a replacement; check the rules in your state/country |
| Panel and account transfer | Whether insurance and maintenance panels re-approve a new owner | Panel volume can stop on settlement |
| Builder concentration | Revenue and debtors by builder | A builder in trouble can leave large unpaid invoices |
| Defects and warranty | Claims history on new-build and renovation work | You may inherit callbacks for past work |
| Apprentice reliance | Ratio of apprentices to licensed plumbers, supervision rules | Too few licensed staff limits what you can legally do |
| Job data | Whether job history sits in software or in the owner's head | Without history you cannot price renewals or registers |

See [due diligence red flags](/guides/due-diligence-red-flags) for the general list.

## Why do plumbing business owners sell?

Plumbing is hard on the body: crawl spaces, trenches, roof spaces and emergency call-outs. Many owners have built a solid business but are still the person every client asks for. Common reasons to sell are physical wear, the stress of chasing staff and payments, and having no successor. Apprentices rarely have the capital or appetite to buy, and family members often do not want the business.

## Which no-money-down structure fits a plumbing business?

Each structure is a mix of **senior (commercial) debt**, **seller finance** and **seller rollover**.

- **[70/20/10](/guides/70-20-10-deal-structure)** fits when most revenue is repeat accounts and registers. The predictable work supports a larger commercial loan, and the seller note is paid from cash flow.
- **[60/40](/guides/60-40-deal-structure)** fits when the owner is still the face of key accounts. A 40% seller rollover keeps them making introductions and supervising during the handover. The lender takes security over the business's assets instead of a personal guarantee. See [buying a business without a personal guarantee](/guides/buy-a-business-without-a-personal-guarantee).
- **[100% vendor finance](/guides/100-percent-vendor-finance)** fits a retiring owner who wants their plumbers looked after and an income over several years.

The mistake we see most often is pricing a panel appointment as if it were guaranteed. Price it as upside, or make part of the seller note depend on the panel re-approving the new owner.

## What synergies come from buying a competing plumbing business?

- **Shared dispatch and office.** One booking line, one scheduler, one invoicing system.
- **Emergency roster.** A bigger team makes after-hours cover sustainable, which keeps plumbers from burning out.
- **Equipment utilisation.** A jetter, camera or relining kit in one business can work full-time across two.
- **Combined registers.** More testing devices in the same area means tighter routes.
- **Apprentice pathways.** More licensed plumbers to supervise and train apprentices.

## Illustrative example: buying the business whose owner wants out

*Illustrative only. The numbers are rounded and not a forecast.*

You own a ten-plumber business. Across the city, a 60-year-old owner runs six plumbers, two apprentices and a backflow testing register, with most work coming from property managers.

- Agreed price: $900k. The business earns about $300k a year in cash flow before debt repayments, after paying a supervisor to replace the owner.
- Structure (70/20/10): $630k commercial debt, a $180k seller note over three years, and $90k rolled into a 10% stake.
- The owner spends six months handing over property-manager relationships and the testing register.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the plumbing business whose owner wants out?

If you own an established plumbing business and want to grow by acquisition without your own cash, we will show you how it could work. [See if you qualify](/plumbing).`,
    faqs: [
      { q: "Can you buy a plumbing business with no money down?", a: "Yes, when the business has steady cash flow and the seller agrees to take part of the price as seller finance or seller rollover. Commercial debt funds the rest, repaid from the business's earnings." },
      { q: "What is a plumbing business worth?", a: "It is usually valued on the cash flow left after paying someone to replace the owner's work. Repeat accounts and testing registers are typically worth more than one-off or builder work." },
      { q: "Do insurance panel jobs transfer when you buy a plumbing company?", a: "Not automatically. Many panels approve the business and its owners, so a new owner may need re-approval. Confirm with the panel before you count that revenue." },
      { q: "What happens to the plumbing licence when the business is sold?", a: "If the licence depends on the owner as nominee, someone else must usually be nominated. Check the rules in your state/country before settlement." },
      { q: "Is a backflow testing register valuable?", a: "Yes. Each registered device usually needs testing every year, so the register is predictable recurring revenue that sits outside day-to-day call-outs." },
      { q: "How do I stop plumbers leaving after I buy the business?", a: "Meet them early, keep pay and conditions at least the same, and have the seller stay through the handover. A seller rollover stake gives the seller a reason to help." },
    ],
    related: ["70-20-10-deal-structure", "buy-an-hvac-business", "buy-a-business-without-a-personal-guarantee", "questions-to-ask-a-business-seller", "due-diligence-red-flags"],
    industry: "plumbing",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-an-electrical-business",
    title: "How to Buy an Electrical Business With No Money Down",
    description: "How electrical contractors buy a competitor with no money down: valuing compliance and maintenance work, project and licence risks, and structures that fit.",
    h1: "How to Buy an Electrical Business With No Money Down",
    answer: "Buying an electrical business with no money down means funding the price with commercial debt, seller finance and seller rollover, repaid from the business's own cash flow. It works best when an established electrical contractor buys a competitor with recurring compliance and maintenance work, licensed electricians who will stay, and limited exposure to builder retentions and project margin risk.",
    keyPoints: [
      "Compliance testing and maintenance contracts repeat on a schedule and are what lenders lend against most readily.",
      "Construction work brings retentions, defects liability and margin fade. Value it more cautiously.",
      "The contractor licence nominee and the safety record are the licensing and compliance risks to check first.",
      "Buying a competitor can unlock bigger tenders and prequalification you could not reach alone.",
      "Owner-dependent builder relationships suit seller rollover and a structured handover.",
    ],
    body: `## What are you actually buying when you buy an electrical business?

Electrical contractors range from domestic service to large commercial projects. Separate the business into its revenue types before you value it:

- **Compliance and maintenance work.** This includes emergency and exit lighting testing, portable appliance testing (test and tag), switchboard thermal imaging, residual current device testing and planned maintenance for commercial sites. It is scheduled and repeats.
- **Service and small works.** Call-outs and minor works for property managers, strata, retail and facility managers.
- **Project work.** New builds, fit-outs and upgrades won by tender. This can be large but lumpy.
- **Specialist lines.** Data and communications cabling, solar, batteries, EV chargers, security and automation.

You are also buying licensed electricians and apprentices, the contractor licence and its nominee, safety systems and records, vans and test equipment, and prequalifications with builders, councils and large clients.

## What makes an electrical business a good acquisition target?

- **A solid base of scheduled compliance and maintenance work**, ideally with sites that renew year after year.
- **Many clients**, with no single builder making up a large share of revenue.
- **Clean safety records** and documented safe work procedures.
- **A supervisor or project manager who runs jobs without the owner.**
- **Complementary skills.** "The electrical contractor down the road" may hold data, solar or industrial capability you lack.

## What are the due diligence risks specific to electrical contracting?

| Risk | What to check | Why it matters |
|---|---|---|
| Licence nominee | Who holds the contractor licence and qualified supervisor roles | The business may not be able to trade without a replacement; check the rules in your state/country |
| Safety record | Incident reports, regulator notices, insurance claims | Safety failures carry serious liability and can cost prequalification |
| Retentions and defects | Money held by builders, defects periods outstanding | Cash you are owed may be slow, and defects may be yours to fix |
| Work in progress | Project margins to date compared with estimates | Projects that are losing money often look fine until the end |
| Builder concentration | Revenue and debtors by builder | A builder failing can leave large unpaid invoices |
| Apprentice ratios | Licensed electricians compared with apprentices | Supervision rules limit how much work you can take on |

For more, see [due diligence red flags](/guides/due-diligence-red-flags).

## Why do electrical contractors sell?

Many owners are still estimating at night, chasing builder payments and carrying the licence risk personally. Retentions and slow-paying builders add cash-flow stress. The common reasons to sell are age, fatigue from the project treadmill and having no successor. Senior electricians often prefer a wage to the risk of ownership. Some owners also sell because they have hit a ceiling: they cannot tender for bigger work without more scale.

## Which no-money-down structure fits an electrical business?

Every structure combines **senior (commercial) debt**, **seller finance** and **seller rollover**. Weight the mix towards senior debt when revenue is recurring, and towards seller finance and rollover when it is project-based.

| Revenue mix | Structure that often fits |
|---|---|
| Mostly compliance testing and maintenance | [70/20/10](/guides/70-20-10-deal-structure). Predictable work supports the larger commercial loan |
| Project-heavy, owner holds builder relationships | [60/40](/guides/60-40-deal-structure). The owner's 40% rollover keeps them winning tenders through the handover |
| Retiring owner who wants the team looked after | [100% vendor finance](/guides/100-percent-vendor-finance), paid from cash flow over time |

For project-heavy businesses, tie part of the seller note to retentions being collected and open projects finishing at their estimated margin. That way neither side carries the whole risk of work the seller started.

## What synergies come from buying a competing electrical contractor?

- **Bigger tenders.** Combined turnover, staff and track record can meet prequalification thresholds neither business met alone.
- **Testing routes.** More compliance sites in the same area means fewer kilometres per test.
- **Shared estimating and project management**, the scarcest skills in most electrical businesses.
- **Cross-selling.** Maintenance contracts offered to project clients, and solar or data work offered to maintenance clients.
- **Apprentice capacity.** More licensed electricians means more apprentices you can supervise.

See [how to buy your competitor](/guides/buy-your-competitor) for approaching the owner.

## Illustrative example: buying the contractor down the road

*Illustrative only. The numbers are rounded and not a forecast.*

You run a 15-electrician business focused on commercial maintenance. Down the road, a 58-year-old owner runs nine electricians doing fit-outs and data cabling, and wants to stop estimating.

- Agreed price: $1.2M. The business earns about $400k a year in cash flow before debt repayments, after paying a project manager to replace the owner.
- Structure (60/40): $720k commercial debt, and the owner rolls $480k into a 40% stake. They stay on for two years to hand over builder relationships.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).
- You cross-sell maintenance to their fit-out clients, and they bring data cabling to your sites.

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the electrical contractor down the road?

If you own an established electrical business and want to grow by acquisition without your own cash, we will show you how the numbers could work. [See if you qualify](/electrical).`,
    faqs: [
      { q: "Can an electrician buy a business with no money down?", a: "Yes, if the target has steady cash flow and the seller accepts part of the price as seller finance or seller rollover. Commercial debt funds the rest, repaid from the business's earnings." },
      { q: "What is the most valuable revenue in an electrical business?", a: "Scheduled compliance testing and maintenance contracts, because they repeat and can be planned. Project work is valuable but lumpier and riskier." },
      { q: "What happens to the electrical contractor licence when a business sells?", a: "If the licence relies on the owner as nominee or qualified supervisor, a replacement is usually needed. Check the rules in your state/country before settlement." },
      { q: "How do retentions affect buying an electrical business?", a: "Retentions are money builders hold back until defects periods end. Check how much is owed and when, and agree who gets it and who fixes any defects." },
      { q: "What should I check before buying an electrical contractor?", a: "Check the revenue mix, licence arrangements, safety record, work in progress margins, retentions, builder concentration and apprentice ratios." },
      { q: "Does buying a competitor help win bigger electrical tenders?", a: "It often does, because combined turnover, staff numbers and track record can meet prequalification requirements that neither business met alone." },
    ],
    related: ["60-40-deal-structure", "buy-your-competitor", "buy-an-hvac-business", "due-diligence-red-flags", "dscr-explained"],
    industry: "electrical",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-roofing-or-solar-business",
    title: "How to Buy a Roofing or Solar Business With No Money Down",
    description: "How to buy a roofing or solar business with no money down: warranty and safety risks, lead flow, and how debt, seller finance and rollover fit lumpy revenue.",
    h1: "How to Buy a Roofing or Solar Business With No Money Down",
    answer: "Buying a roofing or solar business with no money down means funding the price through commercial debt, seller finance and seller rollover, repaid from the business's cash flow. It suits an established roofing or solar owner buying a competitor with dependable lead flow, a clean height-safety record and a manageable workmanship warranty tail, where the retiring owner shares the project risk through the structure.",
    keyPoints: [
      "Roofing and solar revenue is mostly project-based, so senior debt is sized on the dependable base, not the best year.",
      "The workmanship warranty tail is a liability you inherit. Price it, insure it or hold back part of the seller note against it.",
      "Height safety, insurance history and subcontractor arrangements are the industry-specific risks.",
      "Lead flow that depends on one ad account or one builder is fragile.",
      "Roofing and solar cross-sell naturally: inspect the roof before the panels go on.",
    ],
    body: `## What are you actually buying when you buy a roofing or solar business?

Roofing and solar businesses often operate side by side, and many do both. What you acquire depends on the mix:

- **Roofing work.** Re-roofing, restorations, repairs, gutters and downpipes, insurance storm repairs and strata or commercial maintenance programs.
- **Solar and battery work.** Residential and commercial installs, battery retrofits and system servicing.
- **The installed base.** Every past customer is a future job: a roof inspection, a battery added to existing solar, panel cleaning, or replacement of an ageing inverter. Few sellers value this list properly.
- **Lead generation.** Website, reviews, ad accounts, referral partners, builders and insurer panels.
- **Crews and accreditations.** Employed crews or subcontractors, height-safety training, and installer or manufacturer accreditations, which may be personal to individuals.
- **Equipment.** Trucks, scaffolding, edge protection, lifting gear and tools.

## What makes a roofing or solar business a good acquisition target?

- **More than one lead source**, with a track record that does not depend on a single ad account or builder.
- **Some recurring or repeat revenue**, such as strata maintenance programs, insurer repair panels or solar servicing plans.
- **Low warranty callbacks**, documented with job photos and sign-offs.
- **Employed or long-standing crews**, not a different subcontractor every week.
- **An owner ready to step back.** "The roofer whose owner is ready to retire" often has a strong local name and no successor.

## What are the due diligence risks specific to roofing and solar?

| Risk | What to check | Why it matters |
|---|---|---|
| Workmanship warranty tail | Warranties issued, their length, callback history | You may be fixing past jobs for years after settlement |
| Height safety | Incident history, safe work procedures, training records | Falls carry serious liability; check the rules in your state/country |
| Insurance | Claims history and whether cover continues | Gaps can leave past work uninsured |
| Accreditations | Whose name accreditations are in, whether they transfer | Solar installs may require accredited installers to sign off |
| Subcontractor arrangements | Contracts, insurance and whether they are really employees | Misclassification and uninsured subcontractors create liabilities |
| Policy and rebate exposure | Share of solar demand driven by incentives | Incentive changes can move demand sharply |
| Deposits and work in progress | Customer deposits held for unfinished jobs | Deposits are owed work, not profit |

See [due diligence red flags](/guides/due-diligence-red-flags) for the general list.

## Why do roofing and solar owners sell?

Working at heights is a young person's job, and many owners are still on roofs in their fifties. Weather makes revenue unpredictable, insurance costs rise, and solar owners ride every change in incentives and product supply. Common reasons to sell are physical wear, the stress of warranty and safety liability, and having no successor who wants the risk.

## Which no-money-down structure fits a roofing or solar business?

Each structure blends **senior (commercial) debt**, **seller finance** and **seller rollover**. Because project revenue is lumpy, lenders usually size their loan on the dependable base. Seller finance and rollover carry more of the price than in a contract-based business.

- **[60/40](/guides/60-40-deal-structure)** often fits best. The owner rolls 40% into equity and shares the upside and the risk of the warranty tail and lead flow. There is no personal guarantee; the lender takes security over the business's assets.
- **[70/20/10](/guides/70-20-10-deal-structure)** fits businesses with strong repeat work, such as strata programs or insurer panels. Part of the seller note can be held back against warranty claims.
- **[100% vendor finance](/guides/100-percent-vendor-finance)** fits an owner who wants their crews kept on and an income over time.

How the seller shares warranty risk often decides whether a roofing deal closes. Sellers rarely accept a big price cut for it. Most will accept a holdback on the seller note that is released as warranties expire. More in [seller finance explained](/guides/seller-finance-explained).

## What synergies come from buying a competing roofing or solar business?

- **Cross-selling.** Roof inspections and repairs before solar installs, and solar quotes on every re-roof.
- **The installed-base list**, worked for batteries, servicing and roof maintenance.
- **Shared crews and scheduling** that smooth out weather delays across more jobs.
- **One lead-generation and sales team**, so marketing costs are spread over more installs.
- **Equipment.** Scaffolding, lifting gear and trucks used more of the time.

## Illustrative example: buying the roofer ready to retire

*Illustrative only. The numbers are rounded and not a forecast.*

You own a solar installer with a strong sales team. A 62-year-old roofer with three crews and a strata maintenance program wants to retire.

- Agreed price: $1.0M. The business earns about $340k a year in cash flow before debt repayments in an average year, after paying a supervisor to replace the owner.
- Structure (60/40): $600k commercial debt, and the owner rolls $400k into a 40% stake. They help with the handover and quote larger jobs for a year.
- Every roofing customer is offered a solar assessment, and every solar lead gets a roof inspection.
- Repayments are sized on average-year cash flow so that it covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the roofer whose owner is ready to retire?

If you own an established roofing or solar business and want to grow by acquisition without your own cash, we will show you how it could work. [See if you qualify](/roofing-solar).`,
    faqs: [
      { q: "Can you buy a roofing company with no money down?", a: "Yes, when the business has dependable cash flow and the seller takes part of the price as seller finance or seller rollover. Commercial debt funds the rest, usually sized on an average year." },
      { q: "Who is responsible for warranties after buying a roofing business?", a: "The buyer usually takes on workmanship warranties for past jobs. A holdback on the seller note, released as warranties expire, is a common way to share that risk." },
      { q: "Is a solar installation business a good business to buy?", a: "It can be, especially with an installed base to sell batteries and servicing to. Demand can move with policy and incentives, so value it on dependable cash flow, not the best year." },
      { q: "Do solar installer accreditations transfer when a business is sold?", a: "Often they are held by individual installers, not the business. Check whose name they are in and the rules in your state/country." },
      { q: "What should I check before buying a roofing business?", a: "Check warranty history, height-safety records, insurance claims, subcontractor arrangements, lead sources, customer deposits and work in progress." },
      { q: "Why combine a roofing and a solar business?", a: "Every solar install needs a sound roof, and every roof customer is a solar prospect. Combining them lets one sales team sell both." },
    ],
    related: ["60-40-deal-structure", "seller-finance-explained", "buy-an-electrical-business", "due-diligence-red-flags", "buy-your-competitor"],
    industry: "roofing-solar",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-landscaping-business",
    title: "How to Buy a Landscaping Business With No Money Down",
    description: "How landscaping owners buy a competitor with no money down: valuing maintenance contracts and equipment, crew and contract risks, and structures that fit.",
    h1: "How to Buy a Landscaping Business With No Money Down",
    answer: "Buying a landscaping business with no money down means paying for it with commercial debt, seller finance and seller rollover, then repaying them from the business's own cash flow. It works best when an established landscaping owner buys a competitor with recurring grounds maintenance contracts near its existing routes, reliable crews, and equipment that does not need immediate replacement.",
    keyPoints: [
      "Grounds maintenance contracts repeat every week or month. Landscape construction is one-off. Value them separately.",
      "Route density is the biggest synergy: more sites per street means less driving and more hours mowing.",
      "Equipment age is a real cost. Mowers, trucks and machinery wear out on a schedule you can predict.",
      "Many maintenance contracts can be ended on short notice, so check how long clients have actually stayed.",
      "Crew turnover and chemical-handling licences are the people and compliance risks.",
    ],
    body: `## What are you actually buying when you buy a landscaping business?

Landscaping covers two different businesses that often share a name:

- **Grounds maintenance.** Mowing, pruning, weeding, irrigation servicing and seasonal work for strata complexes, commercial sites, schools, retail centres, councils and homes. In colder markets, winter snow and ice contracts may fill the off-season. This work repeats.
- **Landscape construction.** Paving, retaining walls, turf, planting and irrigation installs for builders and homeowners. It is project-based and lumpier.

Alongside the revenue you are buying:

- **Contracts and routes.** The list of sites, how often each is serviced and when each contract renews or re-tenders.
- **Crews and supervisors**, including anyone with chemical-handling or other licences.
- **Equipment.** Ride-on mowers, trucks, trailers, mini-excavators, hand tools and spray units.
- **A yard or depot**, and sometimes nursery stock or materials.

## What makes a landscaping business a good acquisition target?

- **A high share of revenue from maintenance contracts**, with clients who have stayed for years.
- **Sites clustered near your existing routes.** Even a strong business is worth less if its sites are across the city from yours.
- **Many clients.** No single council, school group or strata manager should carry the business.
- **Crew leaders who run their crews** without the owner on site every day.
- **A sensible equipment replacement cycle**, documented in the books.
- "The landscaping crew across the city" can still be a good fit if its routes fill gaps in your schedule.

## What are the due diligence risks specific to landscaping?

| Risk | What to check | Why it matters |
|---|---|---|
| Short-notice contracts | Termination clauses and actual client tenure | Many contracts can be ended quickly; tenure history matters more than paperwork |
| Re-tender dates | When council and commercial contracts go back to tender | A big contract may be up for grabs months after you buy |
| Equipment age | Asset register, hours, service records, finance owing | Replacement spending can swallow the first years of cash flow |
| Seasonality | Monthly revenue over at least two years | Spring and summer can flatter a sale |
| Crew turnover | Staff tenure, pay compared with market, casual reliance | Crews carry site knowledge and client relationships |
| Chemical and safety compliance | Licences for spraying, safety records, incident history | Check the rules in your state/country |

The general checklist is in [due diligence red flags](/guides/due-diligence-red-flags).

## Why do landscaping owners sell?

Landscaping is physical, outdoor and seasonal. Many owners spend the day quoting and supervising and the evening on invoices and staff rosters. The common reasons to sell are physical wear, the difficulty of keeping crews, rising equipment costs and having no one to take over. Owners who built a solid maintenance book often realise it is worth more to a competitor with nearby routes than to anyone else.

## Which no-money-down structure fits a landscaping business?

Every structure combines **senior (commercial) debt**, **seller finance** and **seller rollover**.

| Situation | Structure that often fits |
|---|---|
| Mostly maintenance contracts with long client tenure | [70/20/10](/guides/70-20-10-deal-structure). Recurring revenue supports the larger commercial loan |
| Owner holds key council or strata relationships | [60/40](/guides/60-40-deal-structure). A 40% seller rollover keeps them helping through re-tenders |
| Owner wants crews kept on and an income over time | [100% vendor finance](/guides/100-percent-vendor-finance), paid from the business's cash flow |

Equipment needs careful handling. Lenders will often add a working-capital line on top of the price, and part of that can fund overdue replacements. That is what makes it an [over-financed acquisition](/guides/over-financed-acquisition).

## What synergies come from buying a competing landscaping business?

- **Route density.** Fewer kilometres between sites means more billable hours per crew every day. This is usually the biggest saving.
- **Equipment sharing.** Specialist machinery used across both businesses.
- **Buying power** on mulch, soil, turf, plants, fuel and chemicals.
- **Upselling.** Maintenance clients become construction and irrigation clients.
- **Bigger tenders.** More crews and a longer track record help win council and commercial contracts.

## Illustrative example: buying the crew across the city

*Illustrative only. The numbers are rounded and not a forecast.*

You run a landscaping business with eight maintenance crews. A competitor with five crews services strata and commercial sites that overlap half your routes. The owner is 59 and tired of rostering.

- Agreed price: $800k. The business earns about $270k a year in cash flow before debt repayments, after paying an operations manager to replace the owner.
- Structure (70/20/10): $560k commercial debt, a $160k seller note over three years, and $80k rolled into a 10% stake.
- The lender adds a working-capital line, part of which replaces two worn ride-on mowers.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the landscaping crew across the city?

If you own an established landscaping business and want to grow by acquisition without your own cash, we will show you how it could work. [See if you qualify](/landscaping).`,
    faqs: [
      { q: "Can you buy a landscaping business with no money down?", a: "Yes, when the business has steady cash flow, ideally from maintenance contracts, and the seller takes part of the price as seller finance or seller rollover. Commercial debt funds the rest." },
      { q: "What is a lawn care or landscaping business worth?", a: "It is usually valued on cash flow after paying someone to replace the owner and after realistic equipment replacement. Recurring maintenance contracts are generally worth more than one-off construction work." },
      { q: "Do landscaping maintenance contracts transfer to a new owner?", a: "Some do automatically and some need the client's consent. Many can be ended on short notice anyway, so client tenure and relationships matter more than the paperwork." },
      { q: "What should I check before buying a landscaping company?", a: "Check maintenance versus construction revenue, contract terms and re-tender dates, equipment age and finance owing, seasonality, crew turnover and spraying licences." },
      { q: "Why buy a competing landscaping business instead of growing organically?", a: "Buying a competitor adds sites to your routes overnight, and route density cuts travel time. That is hard to achieve one client at a time." },
      { q: "Is the equipment included when you buy a landscaping business?", a: "Usually yes, but check what is owned, leased or financed. Any finance owing has to be paid out or taken over, and that affects the price." },
    ],
    related: ["70-20-10-deal-structure", "over-financed-acquisition", "buy-a-commercial-cleaning-business", "buy-your-competitor", "due-diligence-red-flags"],
    industry: "landscaping",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
  {
    slug: "buy-a-commercial-cleaning-business",
    title: "How to Buy a Commercial Cleaning Business, No Money Down",
    description: "How cleaning business owners buy a competitor with no money down: valuing contracts, wage compliance and client risks, and the deal structures that fit.",
    h1: "How to Buy a Commercial Cleaning Business With No Money Down",
    answer: "Buying a commercial cleaning business with no money down means funding the price with commercial debt, seller finance and seller rollover, repaid from the business's contracted cash flow. It suits an established cleaning owner buying a competitor with long-standing contracts, correctly paid staff and no dependence on one client, so the combined business shares supervisors, overheads and tender capacity.",
    keyPoints: [
      "You are buying contracts, site knowledge and a workforce. The equipment is a small part of the value.",
      "Wage and award compliance is the biggest hidden risk. Underpayment liabilities can follow the business.",
      "Many cleaning contracts can be ended on short notice, so client tenure matters more than contract length.",
      "In some countries staff transfer automatically with the contracts. Check the rules where you operate.",
      "Shared supervisors, a shared office and bigger tender eligibility are the main synergies.",
    ],
    body: `## What are you actually buying when you buy a commercial cleaning business?

A commercial cleaning business sells reliability. Its value sits in contracts that keep renewing because nothing goes wrong:

- **Cleaning contracts.** Offices, medical centres, schools, strata common areas, retail, gyms, industrial sites and food production. Each has a site scope, a frequency and a monthly fee.
- **Site knowledge.** Alarm codes, keys, inductions, cleaning schedules and the quirks of each client. This is what makes switching providers a hassle for clients.
- **The workforce.** Cleaners, often part-time or casual, plus area supervisors and quality auditors.
- **Systems and certifications.** Rostering and timesheet software, quality, safety and environmental certifications, and induction records that tenders ask for.
- **Specialist capability.** Infection-control cleaning, food-safety sanitation, window and high-access work, and carpet and hard-floor care.

## What makes a cleaning business a good acquisition target?

- **Long average client tenure**, shown by billing history, not just signed contracts.
- **No single client carrying the business.** A big share from one contract is a cliff.
- **Clean payroll.** Award or minimum wage rates, penalty rates, leave and superannuation or pension contributions paid correctly and on time.
- **Healthy site-level margins.** Ask for profit by contract. Some contracts are usually losing money.
- **Supervisors who run the sites**, so the owner is not doing the night inspections.
- **Contracts you can service on your routes.** "The cleaning company with the contracts you want" is often the one cleaning the buildings next to yours.

## What are the due diligence risks specific to commercial cleaning?

| Risk | What to check | Why it matters |
|---|---|---|
| Wage underpayment | Pay rates, penalty rates, overtime, leave, pension contributions, timesheet versus roster | Back-pay liabilities can be large and can follow the business |
| Subcontracting chains | Whether sites are cleaned by subcontractors and how they pay their staff | Some places hold the head contractor responsible for underpayment further down the chain |
| Termination clauses | Notice periods and termination for convenience | Clients may be able to leave within weeks |
| Client concentration | Revenue and margin by client | Losing one large client can wipe out profit |
| Re-tender dates | When major contracts go back to market | A key contract may be lost soon after you buy |
| Employee transfer rules | Whether staff transfer automatically with contracts | Check the rules in your state/country; entitlements may come with them |

See [due diligence red flags](/guides/due-diligence-red-flags) for the general list.

## Why do commercial cleaning owners sell?

Cleaning owners live with the phone. A cleaner calls in sick at 5am, a client complains about a bin and a supervisor resigns, all in one day. Many owners started by cleaning sites themselves and never fully stepped away. Common reasons to sell are burnout from always being on call, the pressure of re-tendering for thin-margin contracts, and no successor. Supervisors rarely have the capital or the appetite to buy.

## Which no-money-down structure fits a cleaning business?

Each structure combines **senior (commercial) debt**, **seller finance** and **seller rollover**. Contracted monthly revenue suits commercial debt well, but lenders look at how long clients actually stay, because notice periods can be short.

- **[70/20/10](/guides/70-20-10-deal-structure)** fits a business with long-tenured clients and clean payroll. The commercial loan does most of the work, and the seller note is paid from monthly contract income.
- **[60/40](/guides/60-40-deal-structure)** fits when the owner holds the key client relationships. A 40% seller rollover keeps them helping through re-tenders.
- **[100% vendor finance](/guides/100-percent-vendor-finance)** fits an owner who cares about their long-serving cleaners and wants an income over time.

The best protection against inherited wage liabilities is an independent payroll review before the LOI becomes binding, plus a specific indemnity from the seller. Where possible, offset that indemnity against the seller note.

## What synergies come from buying a competing cleaning business?

- **Supervisor routes.** Area supervisors cover more sites per night when the sites sit closer together.
- **One back office.** Payroll, rostering, HR, compliance and certifications run once instead of twice.
- **Tender eligibility.** A bigger combined business can bid for larger multi-site contracts.
- **Buying power** on chemicals, consumables and equipment.
- **Cover.** A larger pool of cleaners fills sick and leave shifts without agency labour.

See [how to buy your competitor](/guides/buy-your-competitor).

## Illustrative example: buying the company with the contracts you want

*Illustrative only. The numbers are rounded and not a forecast.*

You run a cleaning business with 80 cleaners servicing offices and medical centres. A competitor with 50 cleaners holds contracts in the same business parks. Its owner is 57 and still does night inspections.

- Agreed price: $1.5M. The business earns about $480k a year in cash flow before debt repayments, after paying an operations manager to replace the owner.
- Structure (70/20/10): $1.05M commercial debt, a $300k seller note over three years (with a payroll indemnity offset against it), and $150k rolled into a 10% stake.
- The lender adds a working-capital line to cover the gap between paying cleaners weekly and clients paying monthly.
- Repayments are sized so that cash flow covers them about 1.5 times. See [DSCR explained](/guides/dscr-explained).

> This guide is general information, not financial, legal or tax advice. Get advice on your own situation.

## Ready to buy the cleaning company with the contracts you want?

If you own an established cleaning business and want to grow by acquisition without your own cash, we will show you how the numbers could work. [See if you qualify](/cleaning).`,
    faqs: [
      { q: "Can you buy a cleaning business with no money down?", a: "Yes, when the contracts produce steady cash flow and the seller takes part of the price as seller finance or seller rollover. Commercial debt funds the rest, repaid from contract income." },
      { q: "What is a commercial cleaning business worth?", a: "It is usually valued on cash flow after paying someone to replace the owner, adjusted for client tenure, concentration and wage compliance. Contracts with long-standing clients are worth more than recent wins." },
      { q: "Do cleaning contracts transfer when a business is sold?", a: "Some transfer automatically, and others need the client's consent on a change of owner. Read each contract's assignment and change-of-control clauses." },
      { q: "What is the biggest risk when buying a cleaning company?", a: "Wage underpayment. If staff have been underpaid, the liability can follow the business. A payroll review and a seller indemnity are essential." },
      { q: "Do cleaners transfer to the new owner when you buy a cleaning business?", a: "In some countries employees transfer automatically with the business or contract, along with their entitlements. Check the rules in your state/country." },
      { q: "Why do lenders like cleaning businesses?", a: "Contracted monthly income is predictable. Lenders still check client tenure and concentration, because many contracts can be ended at short notice." },
    ],
    related: ["70-20-10-deal-structure", "buy-a-landscaping-business", "questions-to-ask-a-business-seller", "due-diligence-red-flags", "buy-your-competitor"],
    industry: "cleaning",
    section: "Industries",
    published: "2026-10-14",
    updated: "2026-10-14",
  },
];
