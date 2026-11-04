import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { publicOrigin, type Runtime } from '../app';
import type { Env } from '../env';
import { loadSettings } from '../settings';
import { type Advance, advance } from './pipeline';

/**
 * The Workflow gl-studio-pipeline: one instance per run of a video (instance params {id}). Each step advances the
 * video once (src/studio/pipeline.ts advance, which never throws and holds the video's lease); between steps it
 * sleeps as long as the pipeline asked (a render is polled every 20 s). Steps are durable, so a deploy or a crash
 * resumes where it was. Past the step budget the 5-minute cron carries on.
 */
export interface StepLike {
  do<T>(name: string, config: Record<string, unknown>, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: number): Promise<void>;
}
export const STUDIO_FLOW_STEPS = 900;
const STEP = { retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '20 minutes' };

export async function runStudioFlow(env: Env, id: string, step: StepLike, waitUntil: (p: Promise<unknown>) => void) {
  for (let i = 0; i < STUDIO_FLOW_STEPS; i++) {
    const r = await step.do(`advance ${i}`, STEP, async (): Promise<Advance> => {
      const settings = await loadSettings(env);
      const rt: Runtime = { env, settings, reps: [], origin: publicOrigin(settings, 'https://example.com'), waitUntil };
      return advance(rt, id);
    });
    if (r.done) return { reason: r.status ?? 'done', steps: i + 1 };
    if (r.waitMs >= 1000) await step.sleep(`wait ${i}`, Math.min(r.waitMs, 30 * 60_000));
  }
  return { reason: 'step budget (the cron carries on)', steps: STUDIO_FLOW_STEPS };
}

export class StudioPipelineWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  async run(event: Readonly<WorkflowEvent<{ id: string }>>, step: WorkflowStep) {
    const id = String(event.payload?.id ?? '');
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(id)) return { reason: 'bad video id', steps: 0 };
    const ctx = this.ctx as unknown as { waitUntil?: (p: Promise<unknown>) => void };
    return runStudioFlow(this.env, id, step as unknown as StepLike, (p) => (ctx.waitUntil ? ctx.waitUntil(p) : void p));
  }
}
