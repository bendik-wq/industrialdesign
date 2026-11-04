import { Container } from '@cloudflare/containers';
import type { Env } from '../env';

/**
 * G&L Studio's editor container (Cloudflare Containers). wrangler.jsonc binds it as STUDIO_EDITOR and builds the
 * image from containers/studio-editor/Dockerfile (node + ffmpeg). One instance per video, named by the video id
 * (src/studio/editor.ts editorFetch); it starts on the first request and sleeps after 30 minutes without one (the
 * pipeline polls a running render every 20 seconds, which keeps it awake until the render is done).
 */
export class StudioEditor extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '30m';
  enableInternet = true; // it fetches the raw from, and uploads results to, the Worker's signed /studio/blob links
  pingEndpoint = 'editor/health';

  override onError(error: unknown) {
    console.error('studio editor container error', error instanceof Error ? error.message : error);
    throw error;
  }
}
