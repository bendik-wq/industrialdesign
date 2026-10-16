/**
 * Page-behaviour emails: when someone reads a guide, opens their industry's page, looks at the
 * masterclass without signing up, reads several guides in one go, or comes back after a quiet spell,
 * they get one email about exactly that (once per person per email). Copy: longflow/behaviour.ts.
 */
import { GUIDE_SLUGS } from './kit';

export const INDUSTRY_IDS = ['medical', 'dental', 'allied-health', 'veterinary', 'hvac', 'plumbing', 'electrical', 'roofing-solar', 'landscaping', 'cleaning', 'security', 'accounting', 'insurance', 'it-services', 'agencies', 'recruitment', 'hospitality', 'childcare', 'logistics', 'property'] as const;

const key = (s: string) => s.replace(/-/g, '_');
/** Template id for a guide's email. */
export const guideTemplate = (slug: string) => `tb_g_${key(slug)}`.slice(0, 60);
export const industryTemplate = (id: string) => `tb_i_${key(id)}`;

export interface PageSignals {
  /** Paths viewed in the last few hours. */
  pages: string[];
  /** Distinct guides read in the last few hours. */
  guidesRecent: number;
  /** Days since the visit before this one (0 if none). */
  quietDays: number;
  registeredForWebinar: boolean;
}

export interface PageRule { template: string; label: string; delay: number; when: (p: PageSignals) => boolean }

export const PAGE_RULES: PageRule[] = [
  ...GUIDE_SLUGS.map((slug) => ({ template: guideTemplate(slug), label: `Read the guide “${slug.replace(/-/g, ' ')}”`, delay: 45, when: (p: PageSignals) => p.pages.includes(`/guides/${slug}`) })),
  ...INDUSTRY_IDS.map((id) => ({ template: industryTemplate(id), label: `Looked at the page for ${id.replace(/-/g, ' ')} owners`, delay: 60, when: (p: PageSignals) => p.pages.some((x) => x === `/for/${id}` || x.startsWith(`/for/${id}/`)) })),
  { template: 'tb_webinar_look', label: 'Looked at the masterclass page, didn’t sign up', delay: 90, when: (p) => !p.registeredForWebinar && p.pages.some((x) => x === '/webinar' || x.startsWith('/webinar?')) },
  { template: 'tb_reader', label: 'Read three or more guides in one sitting', delay: 120, when: (p) => p.guidesRecent >= 3 },
  { template: 'tb_back_after_quiet', label: 'Came back to the site after three weeks or more away', delay: 60, when: (p) => p.quietDays >= 21 },
];
