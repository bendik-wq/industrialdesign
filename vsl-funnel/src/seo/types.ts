/**
 * A guide page: written to be the best answer on the web to one question, so search engines
 * rank it and AI assistants (ChatGPT, Claude, Perplexity, Gemini, Grok, Copilot) quote it.
 * Served at /guides/<slug> (main domain) or data.<domain>/guides/<slug> (host: 'data').
 */
export interface Guide {
  slug: string;
  /** <title>: 50–60 characters, main keyword first. The site name is appended. */
  title: string;
  /** Meta description: 140–160 characters, answers the question and says who it's for. */
  description: string;
  h1: string;
  /** The direct answer, 40–70 words, self-contained (AI assistants lift this verbatim). */
  answer: string;
  /** 3–6 one-line takeaways. */
  keyPoints: string[];
  /**
   * Markdown: "## " and "### " headings, paragraphs, "- " and "1. " lists, **bold**, *italic*,
   * [links](/guides/other-slug), "| a | b |" tables (first row = header, second row = |---|), "> " callouts.
   */
  body: string;
  /** 4–8 questions people actually ask, each answered in 1–3 sentences. Becomes FAQPage schema. */
  faqs: { q: string; a: string }[];
  /** Slugs of 3–5 related guides. */
  related: string[];
  /** Industry id (see src/landers/catalog.ts) for industry guides; the CTA then links to /<industry>. */
  industry?: string;
  /** Which site it lives on. Default 'main'. */
  host?: 'main' | 'data';
  /** Hub section. */
  section: 'Deal structures' | 'Financing' | 'Finding & closing deals' | 'Industries' | 'Selling your data';
  /** ISO date first published / last updated. */
  published: string;
  updated: string;
}
