/**
 * Video answers in the FAQ (landing page and the pre-call page), cut from Josh's live Q&A at the
 * 5 March 2026 masterclass. Only the ones that answer an objection a buyer already has; each
 * plays inline and loads only when its question is opened. A video shows once its file is in
 * public/assets/media/faq/ and its id is listed in faq-videos-ready.ts (scripts/faq-videos.sh does both).
 */
import { FAQ_READY } from './faq-videos-ready';

export interface FaqVideo { id: string; q: string; a: string; length: string; /** Show after this FAQS index. */ after: number }

export const FAQ_VIDEOS: FaqVideo[] = [
  {
    id: 'faq-12-personal-guarantee',
    q: 'Do I have to sign a personal guarantee?',
    a: 'Not always. On one $5.5M radiology deal, nobody signed one: the deal was over $5M and the equipment secured the loan. Lenders tend to drop the personal guarantee on larger, asset-backed deals, and every lender is different, so it’s one of the first things we test with them.',
    length: '0:58',
    after: 0,
  },
  {
    id: 'faq-4-us-financing',
    q: 'How do you help with financing in the US?',
    a: 'We have a network of US banks and private lenders. Most of the work is helping you <strong>structure and present the deal</strong> so it gets funded. You build the banker relationships, and we can present on your behalf, depending on how involved you want Josh to be.',
    length: '0:53',
    after: 0,
  },
  {
    id: 'faq-5-seller-buyout',
    q: 'Can I buy out a seller who keeps a stake?',
    a: 'Yes. When a seller rolls over equity you can build in an early exit: a <strong>sale option</strong> (for example after three years, at a fixed price or a fixed multiple), or they <strong>ride it out</strong> and exit when you do. The option can trigger on time or on the size of the business.',
    length: '2:30',
    after: 1,
  },
  {
    id: 'faq-6-control',
    q: 'How do I stop minority shareholders taking control?',
    a: 'In the shareholders’ agreement: <strong>drag-along rights</strong>, and <strong>no voting control or veto rights</strong> for minority holders. Set up the agreement, charter and constitution properly from the start, and get your own legal advice on the wording.',
    length: '1:19',
    after: 1,
  },
];

export const FAQ_VIDEO_DISCLAIMER = 'Video answers are from a live recorded masterclass, lightly edited for length. Results are not typical and depend on your business, market and the deals available to you. Nothing here is financial, legal or tax advice.';

export const readyFaqVideos = () => FAQ_VIDEOS.filter((v) => FAQ_READY.includes(v.id));
