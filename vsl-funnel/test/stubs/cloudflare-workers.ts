/** Node stand-in for the Workers runtime module `cloudflare:workers` (see vitest.config.ts). */
export class WorkflowEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) { this.ctx = ctx; this.env = env; }
}
/** G&L Studio: @cloudflare/containers' Container extends these (src/studio/container.ts). */
export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) { this.ctx = ctx; this.env = env; }
}
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) { this.ctx = ctx; this.env = env; }
}
