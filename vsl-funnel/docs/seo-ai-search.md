# Search & AI search: how it works and what's left to do

## What's live

### Open to Google, Bing and the AI assistants
These pages can be read by Google, Bing, ChatGPT, Claude, Perplexity, Gemini, Grok, Copilot, Meta AI and Apple:
- The main page and the 20 industry pages (`/dental`, `/hvac`, …).
- `/about`.
- 34 guides on `apply.grosfjeld-li.com/guides`.
- The data page and 3 data guides on `data.grosfjeld-li.com/guides`.
- The webinar sign-up page.

The application, booking, breakout, resources and webinar-room pages, plus Funnel HQ, are never indexed.

### Files written for the crawlers
- **`/robots.txt`** names every AI crawler and allows it, and blocks the private pages.
- **`/sitemap.xml`** exists on each host.
- **`/llms.txt`** and **`/llms-full.txt`** give AI assistants a plain-text summary of the firm, plus every guide in full.
- **`/guides/<slug>.md`** is a Markdown copy of each guide.

### On every page
- A canonical URL. The split-test links (`/loi`, `/double`, `/dental/competitor`, `data…/recap`) all point back to their main page, so nothing counts as duplicate content.
- Open Graph and X link previews, with a 1200×630 image for each guide.
- Schema.org data: Organization, Josh Li as a Person, Article, FAQPage, Breadcrumbs and Service.

### How the guides are written to get cited
Each guide opens with a short answer of 40–70 words that an AI assistant can quote as it stands. After that come key points, question-shaped headings, labelled illustrative examples, comparison tables, FAQs and internal links.

### Tracking
- **Funnel HQ → Search & AI** shows:
  - which AI and search crawlers read which pages;
  - visitors and leads who arrived from AI answers (ChatGPT, Perplexity, Claude, Gemini, Grok, Copilot) or from Google and Bing;
  - views and CTA clicks for each guide.
- In every report, "AI Search" is now a channel of its own.

### IndexNow
All pages were sent to Bing and IndexNow. The button in Funnel HQ sends them again.

## What only Josh can do (10 minutes)
1. **Google Search Console.** Go to search.google.com/search-console and choose Add property → URL prefix → `https://apply.grosfjeld-li.com` → HTML tag. Paste the `content="…"` value into Funnel HQ → Integrations → Search. Then submit `https://apply.grosfjeld-li.com/sitemap.xml`. Repeat for `https://data.grosfjeld-li.com`.
2. **Bing Webmaster Tools.** Go to bing.com/webmasters and import from Search Console, or add the site and paste the meta code under Integrations → Search. Bing feeds ChatGPT search and Copilot.
3. **Josh's profiles.** Under Integrations → Search, add LinkedIn and X to "Josh's profiles" and set the X handle. AI assistants use these links to connect the site to Josh.
4. **Link to the site from everywhere Josh already has an audience.**
   - Put the site (or a guide) in the YouTube descriptions, the Instagram bio and LinkedIn.
   - Post guides on X. Grok reads X posts heavily.
   - Get mentions from podcasts and other sites. Links and mentions from other places are still the biggest signal for both Google and the AI assistants.

## Timing
Crawlers usually arrive within days. Google rankings and AI citations build over weeks to months. Watch Funnel HQ → Search & AI.
