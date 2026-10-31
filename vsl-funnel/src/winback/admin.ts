import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from '../admin/auth';
import { emailConfigured } from '../integrations/email';
import { personalizeMode } from '../personalize/personalize';
import { BANDS, DEFAULT_RULES, type Destination, DESTINATIONS, SEGMENTS, TIERS, buildAudience, cleanRules } from './audience';
import {
  WinbackError, audienceFor, createCampaign, deleteCampaign, getCampaign, listCampaigns, ownerAddress, previewCampaign, proposeStart, sendTest, setPaused, stopCampaign, updateCampaign,
} from './campaigns';
import { MAX_STEPS, MIN_STEPS, TEMPLATE_NAMES } from './copy';
import { destinationOptions } from './destination';

/** Funnel HQ → Win-back. Mounted at /admin/api/winback (admin-only). */
export const winbackAdmin = new Hono<AppEnv>();
winbackAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;
const fail = (c: { json: (b: unknown, s: 400 | 404 | 409 | 500) => Response }, e: unknown) => {
  if (e instanceof WinbackError) return c.json({ ok: false, error: e.message }, e.status as 400 | 404 | 409);
  console.error('winback', e);
  return c.json({ ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) }, 500);
};
const publicAudience = (a: Awaited<ReturnType<typeof buildAudience>>) => ({ count: a.count, rows: a.rows.slice(0, 300), excluded: a.excluded, segmentCounts: a.segmentCounts });

winbackAdmin.get('/', async (c) => {
  const rt = runtimeFrom(c);
  try {
    return c.json({
      campaigns: await listCampaigns(rt),
      options: {
        segments: Object.entries(SEGMENTS).map(([id, s]) => ({ id, ...s })),
        tiers: TIERS, bands: Object.entries(BANDS).map(([id, label]) => ({ id, label })),
        destinations: await destinationOptions(rt),
        defaults: { rules: DEFAULT_RULES, steps: 5, gap_days: 3, daily_cap: 40, window_from: 9, window_to: 17 },
        steps: { min: MIN_STEPS, max: MAX_STEPS, names: TEMPLATE_NAMES },
      },
      timezone: rt.settings.SALES_TIMEZONE || 'Australia/Sydney',
      email: { configured: emailConfigured(rt), owner: ownerAddress(rt) },
      personalize: personalizeMode(rt.settings),
    });
  } catch (e) { return fail(c, e); }
});

// Live count and preview list for unsaved rules (the builder updates it as you change them).
winbackAdmin.post('/audience', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const b = await body(c);
    const destination = DESTINATIONS.includes(b.destination as Destination) ? (b.destination as Destination) : 'masterclass';
    const destRef = typeof b.dest_ref === 'string' && /^[\w-]{1,64}$/.test(b.dest_ref) ? b.dest_ref : null;
    return c.json({ ok: true, ...publicAudience(await buildAudience(rt, { rules: cleanRules(b.rules), destination, destRef: destination === 'masterclass' ? null : destRef, self: typeof b.id === 'string' ? b.id : null })) });
  } catch (e) { return fail(c, e); }
});

winbackAdmin.post('/', async (c) => { try { return c.json({ ok: true, campaign: await createCampaign(runtimeFrom(c), await body(c)) }); } catch (e) { return fail(c, e); } });
winbackAdmin.put('/:id', async (c) => { try { return c.json({ ok: true, campaign: await updateCampaign(runtimeFrom(c), c.req.param('id'), await body(c)) }); } catch (e) { return fail(c, e); } });
winbackAdmin.delete('/:id', async (c) => { try { await deleteCampaign(runtimeFrom(c), c.req.param('id')); return c.json({ ok: true }); } catch (e) { return fail(c, e); } });

winbackAdmin.get('/:id/audience', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const camp = await getCampaign(rt, c.req.param('id'));
    if (!camp) return c.json({ ok: false, error: 'Campaign not found.' }, 404);
    return c.json({ ok: true, ...publicAudience(await audienceFor(rt, camp)) });
  } catch (e) { return fail(c, e); }
});

winbackAdmin.get('/:id/preview', async (c) => {
  const rt = runtimeFrom(c);
  try {
    const camp = await getCampaign(rt, c.req.param('id'));
    if (!camp) return c.json({ ok: false, error: 'Campaign not found.' }, 404);
    return c.json({ ok: true, ...(await previewCampaign(rt, camp, c.req.query('lead') || null)) });
  } catch (e) { return fail(c, e); }
});

winbackAdmin.post('/:id/test', async (c) => {
  try { const b = await body(c); return c.json({ ok: true, ...(await sendTest(runtimeFrom(c), c.req.param('id'), typeof b.to === 'string' ? b.to : null, typeof b.lead === 'string' ? b.lead : null)) }); } catch (e) { return fail(c, e); }
});
winbackAdmin.post('/:id/start', async (c) => { try { return c.json({ ok: true, ...(await proposeStart(runtimeFrom(c), c.req.param('id'))) }); } catch (e) { return fail(c, e); } });
winbackAdmin.post('/:id/pause', async (c) => { try { return c.json({ ok: true, campaign: await setPaused(runtimeFrom(c), c.req.param('id'), true) }); } catch (e) { return fail(c, e); } });
winbackAdmin.post('/:id/resume', async (c) => { try { return c.json({ ok: true, campaign: await setPaused(runtimeFrom(c), c.req.param('id'), false) }); } catch (e) { return fail(c, e); } });
winbackAdmin.post('/:id/stop', async (c) => { try { return c.json({ ok: true, campaign: await stopCampaign(runtimeFrom(c), c.req.param('id')) }); } catch (e) { return fail(c, e); } });
