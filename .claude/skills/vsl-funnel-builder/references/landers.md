# Industry landers, Meta smart route, bandit

## Catalog (`src/landers/catalog.ts`)
- `INDUSTRIES` (20): `{ id, label, owners ("clinic owners"), one ("clinic"), many ("clinics"), target ("the practice across town"), keywords[] }`. The original list: medical, dental, allied-health, veterinary, hvac, plumbing, electrical, roofing-solar, landscaping, cleaning, security, accounting, insurance, it-services, agencies, recruitment, hospitality, childcare, logistics, property.
- `ANGLES` (5): `{ id, label, pre(i), headline(i), sub(i) }`. The original angles: loi (signed LOI in 90 days), competitor (buy the competitor), retiring (retiring owners), ceiling (growth ceiling), overfinanced. That gives 20 × 5 = 100 landers.
- Every headline must be unique across all 100. A test checks this. One bug hit here: two industries both used "practice", so their headlines came out identical.
- `inferIndustry(...texts)`: an exact id match first, then keywords. **Keywords of 4 characters or fewer must match on a word boundary** (allowing a plural "s"). Without that, "pet" matched inside "competitor". Add plurals and synonyms (roof/roofer/roofing).

## Routes (`landerPage` in `src/funnel/pages.ts`)
- `/for/:industry` → the bandit picks the angle. `/for/:industry/:angle` → a fixed angle (for a specific ad). `/m` → **smart route**: reads the industry from `?ind=`, or from the utm_campaign, utm_term (ad set) or utm_content (ad) names, e.g. "Dental – LAL 2%". If there's no match, it falls back to the main page A/B test.
- The chosen lander is stored in a `_ld` cookie (sticky per visitor) and on the session (`sessions.lander`). Leads get `lander` and first-touch `ft_lander`.
- `?preview=1` renders the page without counting the visit.
- Lander visitors are **excluded** from the main-page A/B experiment stats. The experiment query requires a non-bot `page_view` on "/" and `ft_lander IS NULL`. Without this, lander traffic inflated the main page's numbers.

## Bandit (`src/landers/bandit.ts`)
- Thompson sampling per industry over its 5 angles. Each angle gets a `MIN_VISITORS` floor (60) before sampling starts.
- Reward = leads per visitor, switching to **qualified (A/B) applications** once the industry has 30 or more qualified applications.
- `trafficShare` shows the current split in the dashboard.

## Dashboard
The "Landing pages & tests" tab merges the main-page A/B test (significance via a z-test on applications per visitor) with the 100 landers. It shows visitors, plays, leads, qualified, A-tier, booked, won, revenue and cash, by industry and by angle. It also has preview links and copyable ad URLs for `/for/...` and `/m?ind=`.
