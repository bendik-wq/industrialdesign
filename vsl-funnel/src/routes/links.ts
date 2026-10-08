import { type Context, Hono } from 'hono';
import { type AppEnv, runtimeFrom } from '../app';
import { type Lead, getLead, getLeadByRef, linkVisitor, updateLead } from '../funnel/leads';
import { unsubscribeSig, verifyLinkSig } from '../integrations/email';
import { cancelSequence } from '../integrations/email';
import { intentFromSource, whatsappLink } from '../integrations/whatsapp';
import { resolveVisitor } from '../lib/identity';
import { identityFromLead, identityFromVisitor, track } from '../tracking/track';
import { SEQUENCES, type SequenceId } from '../integrations/sequences';

export const links = new Hono<AppEnv>();

const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (ch) => ch.charCodeAt(0));

// Tracked email link: log the click, stitch this browser to the lead, then redirect.
links.get('/r/:id/:sig', async (c) => {
  const { id, sig } = c.req.param();
  const target = c.req.query('u') ?? '';
  const rt = runtimeFrom(c);
  if (!target || !(await verifyLinkSig(rt, id, target, sig))) return c.redirect('/', 302);

  const email = await c.env.DB.prepare('SELECT id, lead_id, template, sequence, clicked_at FROM emails WHERE id = ?').bind(id).first<{ id: string; lead_id: string; template: string; sequence: string; clicked_at: number | null }>();
  if (email) {
    const v = await resolveVisitor(c, 'beacon');
    c.set('visitor', v);
    await c.env.DB.prepare('UPDATE emails SET clicked_at = COALESCE(clicked_at, ?), click_count = click_count + 1 WHERE id = ?').bind(Date.now(), id).run();
    // Link scanners (Outlook Safe Links, Mimecast…) fetch links too — don't let them hijack identity.
    if (!v.isBot) await linkVisitor(c.env, v.visitorId, email.lead_id);
    await track(rt, { ...identityFromVisitor(v, null, email.lead_id), leadId: email.lead_id }, {
      name: 'email_click',
      source: 'email',
      props: { email_id: id, template: email.template, sequence: email.sequence, url: target.slice(0, 300), first: !email.clicked_at },
    });
  }
  return c.redirect(target, 302);
});

// Open pixel. (Apple Mail Privacy Protection pre-loads images, so treat opens as directional.)
links.get('/o/:file', async (c) => {
  const id = c.req.param('file').replace(/\.gif$/, '');
  const row = await c.env.DB.prepare('UPDATE emails SET opened_at = COALESCE(opened_at, ?), open_count = open_count + 1 WHERE id = ? RETURNING lead_id, template, open_count')
    .bind(Date.now(), id)
    .first<{ lead_id: string; template: string; open_count: number }>();
  if (row && row.open_count === 1) {
    const rt = runtimeFrom(c);
    rt.waitUntil(identityFromLead(c.env, row.lead_id).then((who) => track(rt, who, { name: 'email_open', source: 'email', props: { email_id: id, template: row.template } })));
  }
  return c.body(GIF, 200, { 'content-type': 'image/gif', 'cache-control': 'no-store, max-age=0' });
});

const unsubPage = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="/assets/site.css"></head><body class="simple"><main class="wrap narrow center"><h1 class="h2">${title}</h1>${body}</main></body></html>`;

async function unsubscribeTarget(c: Context<AppEnv>): Promise<Lead | null> {
  const leadId = c.req.param('lead') ?? '';
  const sig = c.req.param('sig') ?? '';
  if (sig !== (await unsubscribeSig(runtimeFrom(c), leadId))) return null;
  return getLead(c.env, leadId);
}

// GET shows a confirm button (so link scanners can't unsubscribe people); POST does it (also RFC 8058 one-click).
links.get('/u/:lead/:sig', async (c) => {
  const lead = await unsubscribeTarget(c);
  if (!lead) return c.html(unsubPage('Link expired', '<p>This unsubscribe link is invalid.</p>'), 404);
  if (lead.unsubscribed_at) return c.html(unsubPage('You’re unsubscribed', '<p>You won’t receive any more emails from us.</p>'));
  return c.html(unsubPage('Unsubscribe?', `<p>Stop all emails to <strong>${lead.email}</strong>?</p><form method="post"><button class="btn" type="submit">Yes, unsubscribe me</button></form>`));
});

links.post('/u/:lead/:sig', async (c) => {
  const lead = await unsubscribeTarget(c);
  if (!lead) return c.html(unsubPage('Link expired', '<p>This unsubscribe link is invalid.</p>'), 404);
  if (!lead.unsubscribed_at) {
    const rt = runtimeFrom(c);
    await updateLead(c.env, lead.id, { unsubscribed_at: Date.now() });
    await Promise.all((Object.keys(SEQUENCES) as SequenceId[]).map((s) => cancelSequence(rt, lead.id, s)));
    await track(rt, await identityFromLead(c.env, lead.id), { name: 'unsubscribe', source: 'email' });
  }
  return c.html(unsubPage('You’re unsubscribed', '<p>You won’t receive any more emails from us.</p>'));
});

// "Message Josh on WhatsApp": log the click against the lead, then hand off to wa.me.
links.get('/go/wa', async (c) => {
  const rt = runtimeFrom(c);
  const v = await resolveVisitor(c, 'beacon');
  c.set('visitor', v);
  const src = (c.req.query('src') ?? 'unknown').slice(0, 60);
  const ref = c.req.query('l');
  const lead = (v.leadId ? await getLead(c.env, v.leadId) : null) ?? (ref ? await getLeadByRef(c.env, ref) : null);
  const url = whatsappLink(rt.settings, lead, intentFromSource(src, lead));
  if (!url) return c.redirect(c.req.header('referer') ?? '/', 302);

  if (lead) {
    if (!v.leadId && !v.isBot) await linkVisitor(c.env, v.visitorId, lead.id);
    if (!lead.whatsapp_clicked_at) await updateLead(c.env, lead.id, { whatsapp_clicked_at: Date.now() });
  }
  await track(rt, identityFromVisitor(v, null, lead?.id ?? null), { name: 'whatsapp_click', source: 'server', path: '/go/wa', props: { src } });
  return c.redirect(url, 302);
});
