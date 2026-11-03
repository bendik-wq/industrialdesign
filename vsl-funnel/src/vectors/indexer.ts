import type { Runtime } from '../app';
import { knowledgeBase } from '../support/kb';
import {
  NOT_HERE, type Embedder, type Ns, type VecIndex, embedder, isLocalOnlyError, leadText, metaHash, sha256, smallMeta, squash, clip, vecId, vecIndex, vectorSearchOn,
} from './core';

/**
 * The indexing job (cron, every 5 minutes, only with VECTOR_SEARCH on and the bindings present). Each source is
 * walked in small batches from a cursor kept in D1 (vec_cursor), so a tick that stops half way resumes where it
 * left off. Each item's text is hashed: an unchanged text is never re-embedded; a changed text is; a change in
 * metadata only (a lead's status, or that they bought) re-upserts the stored values with the new metadata.
 * When a source reaches its end the pass is done; the next pass starts after a gap (the source's `gapMs`).
 */

export interface Item { pos: string; ref: string; leadId: string | null; text: string; meta: Record<string, string | number | boolean>; snippet: string }
export interface Source { name: string; ns: Ns; gapMs: number; scan(rt: Runtime, after: string, limit: number): Promise<Item[]> }

const MIN = 60_000;
/** A lead "bought": a won deal, a paid engagement deposit or offer, or a paid challenge deposit. */
export const BOUGHT_SQL = `(l.status = 'won'
  OR EXISTS (SELECT 1 FROM webinar_passes p WHERE p.lead_id = l.id AND p.kind IN ('offer', 'deposit') AND p.status = 'paid')
  OR EXISTS (SELECT 1 FROM challenge_deposits d WHERE d.lead_id = l.id AND d.paid_at IS NOT NULL))`;

const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : 0);

export const SOURCES: Source[] = [
  {
    name: 'leads', ns: 'lead', gapMs: 30 * MIN,
    async scan(rt, after, limit) {
      const { results } = await rt.env.DB.prepare(
        `SELECT l.rowid AS rid, l.id, l.answers, l.industry, l.revenue_band, l.booking_answers, l.objection, l.lost_reason, l.target_business,
                COALESCE(l.tier_override, l.tier) AS tier, l.status, ${BOUGHT_SQL} AS bought
           FROM leads l WHERE l.rowid > ? ORDER BY l.rowid LIMIT ?`,
      ).bind(num(after), limit).all<Record<string, string | number | null> & { rid: number; id: string }>();
      return results.map((r) => {
        const text = leadText(r as never);
        return {
          pos: String(r.rid), ref: r.id, leadId: r.id, text: text.length >= 12 ? text : '',
          meta: smallMeta({ lead: r.id, tier: r.tier as string | null, band: r.revenue_band as string | null, status: r.status as string | null, bought: Boolean(Number(r.bought)) }),
          snippet: text.slice(0, 300),
        };
      });
    },
  },
  {
    name: 'questions', ns: 'q', gapMs: 30 * MIN,
    async scan(rt, after, limit) {
      const { results } = await rt.env.DB.prepare(
        'SELECT rowid AS rid, room_id, ref, lead_id, qtype, source, text FROM room_objections WHERE rowid > ? ORDER BY rowid LIMIT ?',
      ).bind(num(after), limit).all<{ rid: number; room_id: string; ref: string; lead_id: string | null; qtype: string; source: string; text: string | null }>();
      return results.map((r) => {
        const text = clip(squash(r.text));
        return { pos: String(r.rid), ref: `${r.room_id}|${r.ref}`, leadId: r.lead_id, text, meta: smallMeta({ room: r.room_id, lead: r.lead_id, qtype: r.qtype, src: r.source }), snippet: text.slice(0, 300) };
      });
    },
  },
  {
    name: 'notes', ns: 'note', gapMs: 30 * MIN,
    async scan(rt, after, limit) {
      const { results } = await rt.env.DB.prepare(
        "SELECT rowid AS rid, id, notes, lost_reason FROM leads WHERE rowid > ? ORDER BY rowid LIMIT ?",
      ).bind(num(after), limit).all<{ rid: number; id: string; notes: string | null; lost_reason: string | null }>();
      return results.map((r) => {
        const text = clip([squash(r.notes), r.lost_reason ? `Lost reason: ${squash(r.lost_reason)}` : ''].filter(Boolean).join('\n'));
        return { pos: String(r.rid), ref: `lead-${r.id}`, leadId: r.id, text: squash(r.notes) ? text : '', meta: smallMeta({ lead: r.id, src: 'notes' }), snippet: text.slice(0, 300) };
      });
    },
  },
  {
    name: 'calls', ns: 'note', gapMs: 30 * MIN,
    async scan(rt, after, limit) {
      const { results } = await rt.env.DB.prepare(
        'SELECT rowid AS rid, id, lead_id, summary, transcript FROM voice_calls WHERE rowid > ? ORDER BY rowid LIMIT ?',
      ).bind(num(after), limit).all<{ rid: number; id: string; lead_id: string | null; summary: string | null; transcript: string | null }>();
      return results.map((r) => {
        const text = clip(squash(r.summary) || squash(r.transcript));
        return { pos: String(r.rid), ref: `call-${r.id}`, leadId: r.lead_id, text, meta: smallMeta({ lead: r.lead_id, src: 'call' }), snippet: text.slice(0, 300) };
      });
    },
  },
  {
    // Josh's approved material only: the guides, the scripts and decks in public/materials, the guarantee, FAQ and offer terms.
    name: 'docs', ns: 'doc', gapMs: 6 * 60 * MIN,
    async scan(rt, after, limit) {
      const all = (await knowledgeBase(rt)).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const start = num(after);
      return all.slice(start, start + limit).map((p, i) => {
        const text = clip(`${squash(p.title)}\n${squash(p.text)}`);
        return { pos: String(start + i + 1), ref: p.id, leadId: null, text, meta: smallMeta({ ref: p.id, title: p.title }), snippet: text.slice(0, 300) };
      });
    },
  },
];

interface CursorRow { source: string; cursor: string; pass: number; pass_started_at: number | null; pass_done_at: number | null; embedded: number }
interface Existing { id: string; text_hash: string; meta_hash: string }

export interface TickOpts { now?: number; embedCap?: number; scanLimit?: number; sources?: Source[]; index?: VecIndex; embed?: Embedder }
export interface SourceOutcome { source: string; scanned: number; embedded: number; metaOnly: number; unchanged: number; skipped: number; done: boolean; waiting?: boolean; error?: string }

async function cursorOf(rt: Runtime, source: string, now: number): Promise<CursorRow> {
  const row = await rt.env.DB.prepare('SELECT source, cursor, pass, pass_started_at, pass_done_at, embedded FROM vec_cursor WHERE source = ?').bind(source).first<CursorRow>();
  if (row) return row;
  await rt.env.DB.prepare("INSERT INTO vec_cursor (source, cursor, pass, updated_at) VALUES (?, '', 0, ?) ON CONFLICT(source) DO NOTHING").bind(source, now).run();
  return { source, cursor: '', pass: 0, pass_started_at: null, pass_done_at: null, embedded: 0 };
}

async function existing(rt: Runtime, ids: string[]): Promise<Map<string, Existing>> {
  const out = new Map<string, Existing>();
  for (let i = 0; i < ids.length; i += 90) {
    const part = ids.slice(i, i + 90);
    if (!part.length) continue;
    const { results } = await rt.env.DB.prepare(`SELECT id, text_hash, meta_hash FROM vec_items WHERE id IN (${part.map(() => '?').join(',')})`).bind(...part).all<Existing>();
    for (const r of results) out.set(r.id, r);
  }
  return out;
}

const toArr = (v: ArrayLike<number>) => Array.from(v);

/** One source, one batch. Returns how far it got; never embeds more than `budget` texts. */
export async function indexSource(rt: Runtime, src: Source, idx: VecIndex, embed: Embedder, budget: number, o: { now: number; scanLimit: number }): Promise<SourceOutcome> {
  const db = rt.env.DB;
  const out: SourceOutcome = { source: src.name, scanned: 0, embedded: 0, metaOnly: 0, unchanged: 0, skipped: 0, done: false };
  const cur = await cursorOf(rt, src.name, o.now);
  let pass = cur.pass;
  if (!cur.cursor) {
    // At the start: wait out the gap after the last full pass, then begin a new one.
    if (cur.pass_done_at && o.now - cur.pass_done_at < src.gapMs) return { ...out, waiting: true };
    if (!cur.pass_started_at || cur.pass_done_at) {
      pass = cur.pass + 1;
      await db.prepare('UPDATE vec_cursor SET pass = ?, pass_started_at = ?, pass_done_at = NULL, updated_at = ? WHERE source = ?').bind(pass, o.now, o.now, src.name).run();
    }
  }
  const items = await src.scan(rt, cur.cursor, o.scanLimit);
  const withIds = await Promise.all(items.map(async (it) => ({ ...it, id: await vecId(src.ns, it.ref), th: it.text ? await sha256(it.text) : '', mh: await metaHash(it.meta) })));
  const have = await existing(rt, withIds.map((x) => x.id));

  // Walk in order; stop at the first item that needs an embedding we have no budget for (the cursor stays before it).
  const toEmbed: typeof withIds = [], metaOnly: typeof withIds = [], seen: string[] = [], gone: string[] = [];
  let lastPos = cur.cursor;
  let stopped = false;
  for (const it of withIds) {
    const ex = have.get(it.id);
    if (!it.text) {
      if (ex) gone.push(it.id); // the text was removed: drop the vector
      else out.skipped++;
    } else if (!ex || ex.text_hash !== it.th) {
      if (toEmbed.length >= budget) { stopped = true; break; }
      toEmbed.push(it);
    } else if (ex.meta_hash !== it.mh) metaOnly.push(it);
    else { out.unchanged++; seen.push(it.id); }
    lastPos = it.pos;
    out.scanned++;
  }

  if (toEmbed.length) {
    const vecs = await embed(toEmbed.map((x) => x.text));
    await idx.upsert(toEmbed.map((x, i) => ({ id: x.id, values: vecs[i], namespace: src.ns, metadata: x.meta })));
    out.embedded = toEmbed.length;
  }
  if (metaOnly.length) {
    // Same text, new metadata: re-upsert the stored values (no embedding call).
    const values = new Map<string, number[]>();
    for (let i = 0; i < metaOnly.length; i += 20) {
      for (const v of await idx.getByIds(metaOnly.slice(i, i + 20).map((x) => x.id))) values.set(v.id, toArr(v.values));
    }
    const ready = metaOnly.filter((x) => values.has(x.id));
    if (ready.length) await idx.upsert(ready.map((x) => ({ id: x.id, values: values.get(x.id)!, namespace: src.ns, metadata: x.meta })));
    out.metaOnly = ready.length;
    // A vector missing from the index (deleted by hand) is re-embedded next pass: forget its hashes.
    for (const x of metaOnly) if (!values.has(x.id)) gone.push(x.id);
  }
  if (gone.length) await idx.deleteByIds(gone);

  const stmts = [
    ...[...toEmbed, ...metaOnly.filter((x) => !gone.includes(x.id))].map((x) => db.prepare(
      `INSERT INTO vec_items (id, ns, ref, lead_id, text_hash, meta_hash, snippet, pass, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text_hash = excluded.text_hash, meta_hash = excluded.meta_hash, snippet = excluded.snippet, lead_id = excluded.lead_id, pass = excluded.pass, indexed_at = excluded.indexed_at`,
    ).bind(x.id, src.ns, x.ref, x.leadId, x.th, x.mh, x.snippet, pass, o.now)),
    ...gone.map((id) => db.prepare('DELETE FROM vec_items WHERE id = ?').bind(id)),
  ];
  for (let i = 0; i < seen.length; i += 90) {
    const part = seen.slice(i, i + 90);
    stmts.push(db.prepare(`UPDATE vec_items SET pass = ? WHERE id IN (${part.map(() => '?').join(',')})`).bind(pass, ...part));
  }

  out.done = !stopped && items.length < o.scanLimit;
  if (out.done) {
    stmts.push(db.prepare("UPDATE vec_cursor SET cursor = '', pass_done_at = ?, embedded = embedded + ?, last_error = NULL, updated_at = ? WHERE source = ?").bind(o.now, out.embedded, o.now, src.name));
    // Docs: passages that were not seen in this full pass no longer exist; remove their vectors.
    if (src.name === 'docs') {
      const { results: stale } = await db.prepare("SELECT id FROM vec_items WHERE ns = 'doc' AND pass < ?").bind(pass).all<{ id: string }>();
      const thisBatch = new Set(withIds.map((x) => x.id)); // their pass is updated by the batch below
      const staleIds = stale.map((r) => r.id).filter((id) => !thisBatch.has(id) && !gone.includes(id));
      if (staleIds.length) {
        await idx.deleteByIds(staleIds);
        for (const id of staleIds) stmts.push(db.prepare('DELETE FROM vec_items WHERE id = ?').bind(id));
      }
    }
  } else {
    stmts.push(db.prepare('UPDATE vec_cursor SET cursor = ?, embedded = embedded + ?, last_error = NULL, updated_at = ? WHERE source = ?').bind(lastPos, out.embedded, o.now, src.name));
  }
  await db.batch(stmts);
  return out;
}

/** The cron job: every source in turn, sharing one embedding budget. Off, or no bindings: does nothing. */
export async function indexTick(rt: Runtime, o: TickOpts = {}): Promise<{ skipped?: string; sources: SourceOutcome[] }> {
  if (!vectorSearchOn(rt)) return { skipped: 'VECTOR_SEARCH is off', sources: [] };
  const idx = o.index ?? vecIndex(rt);
  const embed = o.embed ?? embedder(rt);
  if (!idx || !embed) return { skipped: 'no Vectorize or Workers AI binding here', sources: [] };
  const now = o.now ?? Date.now();
  let budget = o.embedCap ?? 48;
  const outcomes: SourceOutcome[] = [];
  const errors: string[] = [];
  for (const src of o.sources ?? SOURCES) {
    if (budget <= 0) break;
    try {
      const r = await indexSource(rt, src, idx, embed, budget, { now, scanLimit: o.scanLimit ?? 100 });
      budget -= r.embedded;
      outcomes.push(r);
    } catch (e) {
      if (isLocalOnlyError(e)) return { skipped: NOT_HERE, sources: outcomes }; // local dev: the bindings are stubs
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      errors.push(`${src.name}: ${msg}`);
      outcomes.push({ source: src.name, scanned: 0, embedded: 0, metaOnly: 0, unchanged: 0, skipped: 0, done: false, error: msg });
      await rt.env.DB.prepare('UPDATE vec_cursor SET last_error = ?, updated_at = ? WHERE source = ?').bind(msg, now, src.name).run().catch(() => {});
    }
  }
  // Every source had its turn; a failure goes to the error log (Funnel HQ → Errors & cron) through the cron runner.
  if (errors.length) throw new Error(`AI search indexing: ${errors.join('; ')}`);
  return { sources: outcomes };
}

/** Start every source over now (Funnel HQ → "Re-check everything"): unchanged items still cost no embedding. */
export async function restartPasses(rt: Runtime, now = Date.now()) {
  await rt.env.DB.prepare("UPDATE vec_cursor SET cursor = '', pass_done_at = NULL, pass_started_at = NULL, updated_at = ?").bind(now).run();
}
