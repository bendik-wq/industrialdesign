import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { AudienceError, audiencesReport, proposeCreateAll, proposeLookalikes, setTerms, syncNow } from './sync';

/** Funnel HQ → Meta audiences. Mounted at /admin/api/audiences (admin-only). */
export const audiencesAdmin = new Hono<AppEnv>();
audiencesAdmin.use('*', requireAdmin);

const fail = (c: { json: (b: unknown, s: 400 | 404 | 409 | 500) => Response }, e: unknown) => {
  if (e instanceof AudienceError) return c.json({ ok: false, error: e.message }, e.status as 400 | 404 | 409);
  console.error('audiences', e);
  return c.json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) }, 500);
};
const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;

audiencesAdmin.get('/', async (c) => { try { return c.json(await audiencesReport(runtimeFrom(c))); } catch (e) { return fail(c, e); } });
// "Create all in Meta": a proposal in Command; nothing reaches Meta until it is approved.
audiencesAdmin.post('/create', async (c) => { try { return c.json({ ok: true, ...(await proposeCreateAll(runtimeFrom(c))) }); } catch (e) { return fail(c, e); } });
audiencesAdmin.post('/lookalikes', async (c) => { try { return c.json({ ok: true, ...(await proposeLookalikes(runtimeFrom(c), String((await body(c)).source ?? ''))) }); } catch (e) { return fail(c, e); } });
audiencesAdmin.post('/terms', async (c) => { try { await setTerms(runtimeFrom(c), (await body(c)).accepted ? 'accepted' : 'unknown'); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });
audiencesAdmin.post('/sync/:key', async (c) => { try { return c.json(await syncNow(runtimeFrom(c), c.req.param('key'))); } catch (e) { return fail(c, e); } });
