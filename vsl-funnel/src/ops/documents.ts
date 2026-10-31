import type { Runtime } from '../app';
import { googleAccess, googleReady } from '../content/video-pack';
import { newId } from '../lib/ids';
import { listActions } from './actions';
import { BRIEF_METRICS } from './brief';
import { byCampaign, change, fmt, fmtChange, snapshot } from './metrics';
import { formatDay, ownerTz, priorOf, resolveRange } from './range';

/**
 * Documents made on request in Command: stored as markdown, downloadable as .md or .html, and created as a
 * Google Doc when Google Drive is connected (Integrations → Content). The month-to-date and weekly summaries
 * are built straight from the metrics (no AI needed, every number from a query); the chat can save others.
 */
export interface DocRow { id: string; title: string; kind: string; body: string; drive_url: string | null; thread_id: string | null; created_at: number }

export async function saveDocument(rt: Runtime, d: { title: string; body: string; kind?: string; threadId?: string | null }, now = Date.now()) {
  const id = newId('doc_');
  await rt.env.DB.prepare('INSERT INTO ops_documents (id, title, kind, body, thread_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, d.title.trim().slice(0, 140) || 'Document', d.kind ?? 'custom', d.body.slice(0, 200_000), d.threadId ?? null, now).run();
  return id;
}
export const getDocument = (rt: Runtime, id: string) => rt.env.DB.prepare('SELECT * FROM ops_documents WHERE id = ?').bind(id).first<DocRow>();
export async function listDocuments(rt: Runtime, limit = 50) {
  return (await rt.env.DB.prepare('SELECT id, title, kind, drive_url, thread_id, created_at, length(body) AS size FROM ops_documents ORDER BY created_at DESC LIMIT ?').bind(limit).all()).results;
}

/** A summary document for a named range (mtd, last_week, last_month, …) against the period before. */
export async function summaryDocument(rt: Runtime, rangeKey: string, now = Date.now()) {
  const tz = ownerTz(rt);
  const r = resolveRange(rangeKey, tz, now);
  const p = priorOf(r);
  const [a, b, camps, actions] = await Promise.all([snapshot(rt, r), snapshot(rt, p), byCampaign(rt, r), listActions(rt, { since: r.from, limit: 500 })]);
  const title = `${r.label} summary, ${formatDay(r.from, tz)} to ${formatDay(Math.min(r.to, now), tz)}`;
  const md = [`# ${title}`, '', `Compared with the same length of time before (${formatDay(p.from, tz)} to ${formatDay(p.to, tz)}). Time zone: ${tz}. Every number is counted from Funnel HQ data; the source view is linked on each line.`, '', '## Numbers'];
  for (const k of BRIEF_METRICS) {
    const m = a[k], q = b[k];
    md.push(`- **${m.label}**: ${fmt(m)} (before: ${fmt(q)}${q.value ? `, ${fmtChange(change(m.value, q.value))}` : ''}) · [${m.source.label}](${m.source.href})`);
  }
  const paid = camps.filter((c) => c.spend > 0 || c.leads > 0).slice(0, 12);
  md.push('', '## Campaigns', paid.length ? '| Campaign | Spend | Visitors | Sign-ups | Booked | Cost per lead | Cost per booked call |' : 'No campaign-tagged traffic or ad spend in this period.');
  if (paid.length) {
    md.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const c of paid) {
      const money = (v: number | null, kind: 'money' | 'cost') => fmt({ value: v, kind, currency: c.currency ?? 'USD' });
      md.push(`| ${c.campaign.replace(/\|/g, '/')} | ${money(c.spend, 'money')} | ${c.visitors} | ${c.leads} | ${c.bookings} | ${money(c.cpl, 'cost')} | ${money(c.cpa, 'cost')} |`);
    }
    md.push('Source: [Traffic & ads](/admin#traffic)');
  }
  const byDept = new Map<string, number>();
  for (const x of actions) byDept.set(x.dept, (byDept.get(x.dept) ?? 0) + 1);
  md.push('', '## Department activity', byDept.size ? [...byDept.entries()].map(([d, c]) => `- ${d}: ${c} actions logged`).join('\n') : 'No actions were logged in this period.', 'Source: [Command → Activity](/admin#command/activity)');
  return { title, body: md.join('\n'), kind: rangeKey === 'mtd' ? 'mtd' : rangeKey };
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Small, safe markdown → HTML (headings, lists, tables, bold, links into Funnel HQ or https). */
export function mdToHtml(md: string, origin = '') {
  const inline = (s: string) => escHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((\/admin[^)\s]*|https:\/\/[^)\s]+)\)/g, (_m, t, h) => `<a href="${h.startsWith('/') ? origin + h : h}">${t}</a>`);
  const out: string[] = [];
  let list = false, table = false;
  const close = () => { if (list) out.push('</ul>'); if (table) out.push('</table>'); list = table = false; };
  for (const raw of md.split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) { close(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*] /.test(line)) { if (!list) { close(); out.push('<ul>'); list = true; } out.push(`<li>${inline(line.replace(/^\s*[-*] /, ''))}</li>`); continue; }
    if (/^\|.*\|$/.test(line)) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (!table) { close(); out.push('<table>'); table = true; }
      out.push(`<tr>${line.slice(1, -1).split('|').map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`);
      continue;
    }
    close();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  close();
  return out.join('\n');
}

export function documentHtmlPage(d: Pick<DocRow, 'title' | 'body'>, origin = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(d.title)}</title>
<style>body{font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#1d1d1f;background:#fff;max-width:760px;margin:40px auto;padding:0 16px}h1{font-family:Newsreader,Georgia,serif;font-weight:500}h2{margin-top:32px;color:#0f2c5c;font-size:18px}a{color:#0f2c5c}table{border-collapse:collapse;width:100%;font-size:14px}td{border-top:1px solid #e5e5ea;padding:6px 8px}li{margin:4px 0}</style></head><body>${mdToHtml(d.body, origin)}</body></html>`;
}

/** Create the document as a Google Doc (Drive converts the HTML). Returns the link. */
export async function documentToDrive(rt: Runtime, d: DocRow, fetcher: typeof fetch = fetch) {
  if (!googleReady(rt)) throw new Error('Google Drive is not connected. Connect it under Integrations → Content (Connect Google Drive).');
  const token = await googleAccess(rt, fetcher);
  const boundary = `ops${crypto.randomUUID().replace(/-/g, '')}`;
  const meta: Record<string, unknown> = { name: d.title, mimeType: 'application/vnd.google-apps.document' };
  if (rt.settings.GOOGLE_DRIVE_FOLDER_ID) meta.parents = [rt.settings.GOOGLE_DRIVE_FOLDER_ID];
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${documentHtmlPage(d, rt.origin)}\r\n--${boundary}--`;
  const r = await fetcher('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/related; boundary=${boundary}` }, body });
  const j = (await r.json()) as { id?: string; webViewLink?: string; error?: { message?: string } };
  if (!r.ok || !j.id) throw new Error(`Google Drive: ${j.error?.message ?? r.status}`);
  const url = j.webViewLink ?? `https://docs.google.com/document/d/${j.id}/edit`;
  await rt.env.DB.prepare('UPDATE ops_documents SET drive_url = ? WHERE id = ?').bind(url, d.id).run();
  return url;
}
