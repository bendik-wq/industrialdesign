import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Env } from './env';
import { type StepLike, runLiveReminderFlow } from './live/reminder-flow';

/**
 * Cloudflare Workflows (platform round builder A), declared in wrangler.jsonc `workflows` and exported from
 * src/index.ts. The logic lives in src/live/reminder-flow.ts (plain functions, unit-tested with a fake step).
 * In the tests `cloudflare:workers` resolves to test/stubs/cloudflare-workers.ts (vitest.config.ts).
 */
export class LiveReminderWorkflow extends WorkflowEntrypoint<Env, { regId: string }> {
  async run(event: Readonly<WorkflowEvent<{ regId: string }>>, step: WorkflowStep) {
    const regId = String(event.payload?.regId ?? '');
    if (!/^[\w-]{4,80}$/.test(regId)) return { reason: 'bad registration id', steps: 0 };
    return runLiveReminderFlow(this.env, regId, step as unknown as StepLike);
  }
}
