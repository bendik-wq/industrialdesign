import { fromMinor } from '../webinar/pass';

/**
 * One definition of "a sale in a date range", shared by every tab that counts tickets, Sprints, deposits and
 * challenge orders (Command metrics, Funnel maps, Sprint board ladder, Financial model, Live webinars list):
 *
 *   - a sale is a row whose paid_at falls inside the range and whose status is paid or refunded
 *     (a refunded purchase still happened; the refund shows up in the revenue, not as a missing sale);
 *   - revenue is net of refunds: amount - refunded_amount, in the smallest currency unit, summed per currency.
 *
 * Before this module the Sprint board and the Financial model counted status = 'paid' only, so a refunded
 * ticket or Sprint vanished from their counts while Command and Funnel maps still counted it, and the
 * challenge map read deposits from the challenge_deposits mirror (gross, never net of refunds) while Command
 * read the payment rows themselves.
 */
export const PAID_SALE = "status IN ('paid', 'refunded')";
/** The same condition on an aliased table (p.status ...). */
export const paidSaleOn = (alias: string) => `${alias}.${PAID_SALE}`;

export interface SaleQuery {
  table: 'webinar_passes' | 'challenge_orders';
  kinds: string[];
  /** webinar_passes.source (deposits: live | challenge). */
  source?: string;
}
export interface SaleRow { currency: string; n: number; net: number }
export interface Sales { n: number; byCurrency: SaleRow[]; currency: string | null }

interface D1Like { prepare(sql: string): { bind(...a: unknown[]): { all<T>(): Promise<{ results: T[] }> } } }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const KIND = /^[a-z_]{1,24}$/;

/** The SQL for one sale query (kinds and source are bound, never interpolated). Args: from, to. */
export function salesSql(q: SaleQuery) {
  const kinds = q.kinds.filter((k) => KIND.test(k));
  if (!kinds.length) throw new Error('salesSql: no kinds');
  const where = [`kind IN (${kinds.map(() => '?').join(', ')})`, PAID_SALE, 'paid_at BETWEEN ? AND ?'];
  const args: (string | number)[] = [...kinds];
  if (q.source) { where.splice(1, 0, 'source = ?'); args.push(q.source); }
  return {
    sql: `SELECT lower(COALESCE(currency, 'usd')) AS currency, COUNT(*) AS n, COALESCE(SUM(amount - COALESCE(refunded_amount, 0)), 0) AS net
            FROM ${q.table} WHERE ${where.join(' AND ')} GROUP BY 1`,
    args: (from: number, to: number) => [...args, from, to],
  };
}

/** Sales in a range. Throws when the table is missing (callers decide whether that is 0 or "not counted"). */
export async function paidSales(db: D1Like, q: SaleQuery, r: { from: number; to: number }): Promise<Sales> {
  const { sql, args } = salesSql(q);
  const { results } = await db.prepare(sql).bind(...args(r.from, r.to)).all<{ currency: string | null; n: unknown; net: unknown }>();
  const byCurrency = results.map((x) => ({ currency: String(x.currency || 'usd'), n: num(x.n), net: num(x.net) }));
  return { n: byCurrency.reduce((a, x) => a + x.n, 0), byCurrency, currency: byCurrency[0]?.currency.toUpperCase() ?? null };
}

/** Net revenue in major units (cents → dollars, zero-decimal currencies as they are), summed across currencies. */
export const netMajor = (s: Pick<Sales, 'byCurrency'>) => s.byCurrency.reduce((a, x) => a + fromMinor(x.net, x.currency), 0);
/** Net revenue in minor units (for callers that keep cents). */
export const netMinor = (s: Pick<Sales, 'byCurrency'>) => s.byCurrency.reduce((a, x) => a + x.net, 0);
