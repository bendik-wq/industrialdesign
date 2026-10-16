import type { EmailContent, TemplateCtx } from '../integrations/templates';

/**
 * Shared pieces for the 14-day pre-webinar run (prewebinar-a … -e). Each email is one idea that
 * builds the case for showing up, written in Josh's voice under the house copy rules
 * (src/content/copy-rules.ts) and checked by auditEmail() in the tests.
 */
export type PW = (c: TemplateCtx) => EmailContent;
/** [template id, priority] in send order. Priority 1 = always sent, 2 = when there's room, 3 = only on long runs. */
export type PwOrder = [string, 1 | 2 | 3][];

/** The session they're registered for (their own links, their time zone). */
export const session = (c: TemplateCtx) => c.webinar ?? { title: 'the masterclass', when: 'the session time you picked', room: c.link('/'), replay: c.link('/'), ics: null, google: null, replayHours: 48, durationMin: 60 };
/** The usual button: their personal link to the session. */
export const seat = (c: TemplateCtx, label = 'My link to the session →') => ({ label, href: session(c).room });
/** A guide on the site, as a button. */
export const guide = (c: TemplateCtx, slug: string, label: string) => ({ label, href: c.link(`/guides/${slug}`) });
export const illustrative = 'Illustrative numbers only. Every deal is structured on its own figures, and none of this is financial advice.';
/** One line with the session, for the end of an email. */
export const whenLine = (c: TemplateCtx) => `${session(c).title}: ${session(c).when}.`;
