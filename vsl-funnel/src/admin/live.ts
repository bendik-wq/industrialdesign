import { Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { requireAdmin } from './auth';
import {
  announce, deleteAuto, deleteMessage, endAnnouncement, handleRaise, hostLeave, hostPing, liveShowing, liveShowings, pinMessage, replyQuestion, saveAuto, setAutoActive, teamChat,
} from '../webinar/live';

/** Funnel HQ → Webinar → host console. Mounted at /admin/api/webinar/live (admin-only). */
export const liveAdmin = new Hono<AppEnv>();
liveAdmin.use('*', requireAdmin);

const body = async (c: { req: { json: <T>() => Promise<T> } }) => (await c.req.json<Record<string, unknown>>().catch(() => ({}))) as Record<string, unknown>;

liveAdmin.get('/', async (c) => c.json(await liveShowings(runtimeFrom(c))));
// Scheduled announcements (every showing, autopilot).
liveAdmin.post('/auto', async (c) => c.json(await saveAuto(runtimeFrom(c), await body(c))));
liveAdmin.put('/auto/:id', async (c) => c.json(await setAutoActive(runtimeFrom(c), c.req.param('id'), (await body(c)).active !== false)));
liveAdmin.delete('/auto/:id', async (c) => c.json(await deleteAuto(runtimeFrom(c), c.req.param('id'))));
liveAdmin.delete('/chat/:id', async (c) => c.json(await deleteMessage(runtimeFrom(c), c.req.param('id'))));
liveAdmin.post('/questions/:id/reply', async (c) => c.json(await replyQuestion(runtimeFrom(c), c.req.param('id'), await body(c))));
liveAdmin.delete('/announcements/:id', async (c) => c.json(await endAnnouncement(runtimeFrom(c), c.req.param('id'))));
liveAdmin.put('/raises/:id', async (c) => c.json(await handleRaise(runtimeFrom(c), c.req.param('id'), (await body(c)).handled !== false)));
liveAdmin.get('/s/:sid', async (c) => { const d = await liveShowing(runtimeFrom(c), c.req.param('sid')); return d ? c.json(d) : c.json({ error: 'Showing not found' }, 404); });
liveAdmin.post('/s/:sid/presence', async (c) => c.json(await hostPing(runtimeFrom(c), c.req.param('sid'), (await body(c)).host)));
liveAdmin.post('/s/:sid/leave', async (c) => c.json(await hostLeave(runtimeFrom(c), c.req.param('sid'), (await body(c)).host)));
liveAdmin.post('/s/:sid/chat', async (c) => c.json(await teamChat(runtimeFrom(c), c.req.param('sid'), await body(c))));
liveAdmin.post('/s/:sid/pin', async (c) => c.json(await pinMessage(runtimeFrom(c), c.req.param('sid'), (await body(c)).message_id)));
liveAdmin.post('/s/:sid/announce', async (c) => c.json(await announce(runtimeFrom(c), c.req.param('sid'), await body(c))));
