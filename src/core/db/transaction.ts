import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from './prisma.js';
import { TRANSACTION_DEFAULTS } from './prisma.js';

/**
 * The transaction client. Services that take part in a caller's transaction receive a `Tx` as a
 * parameter. They never create or discover one themselves (Spec P2 §3.5).
 */
export type Tx = Prisma.TransactionClient;

/**
 * Runs `work` in one interactive transaction at READ COMMITTED. It commits if `work` resolves and rolls
 * back on any thrown error.
 *
 * Rules (Spec P2 §3.5):
 *   - pass `tx` explicitly to every repository or service call inside `work`
 *   - keep it short: no HTTP calls, file writes or anything that can block indefinitely inside it
 *   - derivations caused by an approval (posting, stock movement, settlement) happen inside the same call
 */
export function withTransaction<T>(
  db: Database,
  work: (tx: Tx) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return db.$transaction(work, { ...TRANSACTION_DEFAULTS, ...options });
}

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,63}$/;

/** Quotes a plain snake_case identifier, refusing anything else. Never pass user input. */
export function quoteIdentifier(name: string, kind = 'identifier'): Prisma.Sql {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`unsafe ${kind}: ${name}`);
  return Prisma.raw(`\`${name}\``);
}

/**
 * Locks rows with `SELECT … FOR UPDATE` inside a transaction. Used at the three genuine contention
 * points of Spec P2 §3.7: stock balance on sale approval, gapless document numbering, and receivable
 * or payable allocation. Values are always bound parameters. Table and column names must be plain
 * snake_case identifiers and are checked before being quoted.
 *
 * @returns the locked rows (possibly empty).
 */
export async function lockRowsForUpdate<Row = Record<string, unknown>>(
  tx: Tx,
  table: string,
  where: Record<string, string | number | bigint>,
): Promise<Row[]> {
  const entries = Object.entries(where);
  const tableSql = quoteIdentifier(table, 'table identifier');
  if (entries.length === 0) throw new Error('lockRowsForUpdate requires at least one condition');
  const conditions = Prisma.join(
    entries.map(([col, value]) => Prisma.sql`${quoteIdentifier(col, 'column identifier')} = ${value}`),
    ' AND ',
  );
  return tx.$queryRaw<Row[]>`SELECT * FROM ${tableSql} WHERE ${conditions} FOR UPDATE`;
}
