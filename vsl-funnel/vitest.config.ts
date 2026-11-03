import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// `cloudflare:workers` only exists inside the Workers runtime; in the Node tests it resolves to a small stub
// (the Workflow class in src/workflows.ts extends its WorkflowEntrypoint). Everything else is vitest's default.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)) } },
});
