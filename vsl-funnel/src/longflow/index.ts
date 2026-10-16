import type { EmailContent, TemplateCtx } from '../integrations/templates';
import type { LibTopic } from './engine';
import { type Ask, type LongEmail, renderLong } from './kit';
import { BEHAVIOUR_COPY } from './behaviour';
import { LIB_LENDERS } from './library/lenders';
import { LIB_SELLER_FINANCE } from './library/seller-finance';
import { LIB_ROLLOVER } from './library/rollover';
import { LIB_DSCR } from './library/dscr';
import { LIB_STRUCTURES } from './library/structures';
import { LIB_CAPABILITIES } from './library/capabilities';
import { LIB_SOURCING } from './library/sourcing';
import { LIB_SELLERS } from './library/sellers';
import { LIB_DILIGENCE } from './library/diligence';
import { LIB_CLOSING } from './library/closing';
import { LIB_INTEGRATION } from './library/integration';
import { LIB_GROUPS } from './library/groups';
import { LIB_OWNER_LIFE } from './library/owner-life';
import { LIB_BELIEFS } from './library/beliefs';
import { LIB_INDUSTRIES } from './library/industries';
import { LIB_TIMING } from './library/timing';
import { FLOW_ABANDONED_1 } from './flows/abandoned-1';
import { FLOW_ABANDONED_2 } from './flows/abandoned-2';
import { FLOW_TIER_A_1 } from './flows/tier-a-1';
import { FLOW_TIER_A_2 } from './flows/tier-a-2';
import { FLOW_TIER_B_1 } from './flows/tier-b-1';
import { FLOW_TIER_B_2 } from './flows/tier-b-2';
import { FLOW_TIER_C_1 } from './flows/tier-c-1';
import { FLOW_TIER_C_2 } from './flows/tier-c-2';
import { FLOW_NURTURE_1 } from './flows/nurture-1';
import { FLOW_NURTURE_2 } from './flows/nurture-2';
import { FLOW_NO_SHOW_1 } from './flows/no-show-1';
import { FLOW_NO_SHOW_2 } from './flows/no-show-2';
import { FLOW_CANCELLED_1 } from './flows/cancelled-1';
import { FLOW_CANCELLED_2 } from './flows/cancelled-2';
import { FLOW_POST_CALL_1 } from './flows/post-call-1';
import { FLOW_POST_CALL_2 } from './flows/post-call-2';
import { FLOW_LOST_1 } from './flows/lost-1';
import { FLOW_LOST_2 } from './flows/lost-2';
import { FLOW_REACTIVATION_2 } from './flows/reactivation-2';
import { FLOW_REACTIVATION_B_1 } from './flows/reactivation-b-1';
import { FLOW_REACTIVATION_B_2 } from './flows/reactivation-b-2';
import { FLOW_REACTIVATION_C_1 } from './flows/reactivation-c-1';
import { FLOW_REACTIVATION_C_2 } from './flows/reactivation-c-2';

export const LIBRARY: Record<LibTopic, LongEmail[]> = {
  lenders: LIB_LENDERS, seller_finance: LIB_SELLER_FINANCE, rollover: LIB_ROLLOVER, structures: LIB_STRUCTURES, dscr: LIB_DSCR,
  capabilities: LIB_CAPABILITIES, sourcing: LIB_SOURCING, sellers: LIB_SELLERS, owner_life: LIB_OWNER_LIFE, beliefs: LIB_BELIEFS,
  diligence: LIB_DILIGENCE, closing: LIB_CLOSING, integration: LIB_INTEGRATION, groups: LIB_GROUPS, timing: LIB_TIMING, industries: LIB_INDUSTRIES,
};

interface FlowDef {
  /** What the flow's emails ask for. */
  ask: Ask;
  /** The flow's own emails, in order (month 1, then months 2–6). */
  emails: LongEmail[];
  /** Days after the flow starts before the six-month part begins (reactivation A has its own 30-day run first). */
  delayDays: number;
  /** Emails the flow already sends outside SEQUENCES steps (counted against the total). */
  alreadyWritten: number;
}

const def = (ask: Ask, emails: LongEmail[], delayDays = 1, alreadyWritten = 0): FlowDef => ({ ask, emails, delayDays, alreadyWritten });

/** Every flow that runs for six months. Keys are sequence ids. */
export const LONG_FLOWS = {
  abandoned: def('apply', [...FLOW_ABANDONED_1, ...FLOW_ABANDONED_2]),
  tier_a: def('book', [...FLOW_TIER_A_1, ...FLOW_TIER_A_2]),
  tier_b: def('book', [...FLOW_TIER_B_1, ...FLOW_TIER_B_2]),
  tier_c: def('webinar', [...FLOW_TIER_C_1, ...FLOW_TIER_C_2]),
  nurture: def('webinar', [...FLOW_NURTURE_1, ...FLOW_NURTURE_2]),
  no_show: def('book', [...FLOW_NO_SHOW_1, ...FLOW_NO_SHOW_2]),
  cancelled: def('book', [...FLOW_CANCELLED_1, ...FLOW_CANCELLED_2]),
  post_call: def('followup', [...FLOW_POST_CALL_1, ...FLOW_POST_CALL_2]),
  lost: def('webinar', [...FLOW_LOST_1, ...FLOW_LOST_2]),
  reactivation: def('book', FLOW_REACTIVATION_2, 31),
  reactivation_b: def('book', [...FLOW_REACTIVATION_B_1, ...FLOW_REACTIVATION_B_2], 0),
  reactivation_c: def('webinar', [...FLOW_REACTIVATION_C_1, ...FLOW_REACTIVATION_C_2], 0),
} satisfies Record<string, FlowDef>;
export type LongFlowId = keyof typeof LONG_FLOWS;

/** Every long-flow and behaviour email as an app template (the ask comes from the context buildEmail sets). */
export const LONG_TEMPLATES: Record<string, (c: TemplateCtx) => EmailContent> = {};
const all: LongEmail[] = [...Object.values(LIBRARY).flat(), ...Object.values(LONG_FLOWS).flatMap((f) => f.emails), ...BEHAVIOUR_COPY];
all.forEach((e, i) => { LONG_TEMPLATES[e.id] = (c) => renderLong(e, c, i); });
