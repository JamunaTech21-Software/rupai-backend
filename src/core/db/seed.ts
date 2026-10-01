import type { Logger } from 'pino';

import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from './prisma.js';
import { quoteIdentifier, withTransaction, type Tx } from './transaction.js';

export interface SeedResult {
  readonly inserted: number;
  readonly updated: number;
}

/**
 * One idempotent seeder. Running it twice must change nothing, and running it against a populated
 * database must add only what is missing (Spec P3 §31.3). Seeders upsert on stable business codes,
 * never on surrogate ids.
 */
export interface Seeder {
  readonly name: string;
  run(tx: Tx): Promise<SeedResult>;
}

type SeedValue = string | number | bigint | boolean | null;

/**
 * Idempotent upsert of reference rows keyed by a stable business code (Spec P3 §31.3):
 *   - inserts a row only if no row with that key exists
 *   - updates a row only if one of its other columns actually differs
 *   - otherwise touches nothing
 *
 * Reported counts are exact. (A plain `ON DUPLICATE KEY UPDATE` cannot tell "unchanged" from "inserted",
 * because the driver reports found rows rather than changed rows.)
 */
export async function seedRows(
  tx: Tx,
  table: string,
  key: string,
  rows: readonly Record<string, SeedValue>[],
): Promise<SeedResult> {
  const tableSql = quoteIdentifier(table, 'table');
  const keySql = quoteIdentifier(key, 'key column');
  let inserted = 0;
  let updated = 0;

  for (const row of rows) {
    const keyValue = row[key];
    if (keyValue === undefined || keyValue === null)
      throw new Error(`seed row for ${table} is missing ${key}`);
    const columns = Object.keys(row);
    const others = columns.filter((c) => c !== key);

    const colList = Prisma.join(columns.map((c) => quoteIdentifier(c, 'column')));
    const valList = Prisma.join(columns.map((c) => Prisma.sql`${row[c]}`));
    const ins = await tx.$executeRaw`
      INSERT INTO ${tableSql} (${colList})
      SELECT ${valList} FROM DUAL
      WHERE NOT EXISTS (SELECT 1 FROM ${tableSql} WHERE ${keySql} = ${keyValue})`;
    inserted += ins;
    if (ins > 0 || others.length === 0) continue;

    const sets = Prisma.join(others.map((c) => Prisma.sql`${quoteIdentifier(c, 'column')} = ${row[c]}`));
    // NULL-safe comparison: update only when something differs.
    const same = Prisma.join(
      others.map((c) => Prisma.sql`${quoteIdentifier(c, 'column')} <=> ${row[c]}`),
      ' AND ',
    );
    updated += await tx.$executeRaw`
      UPDATE ${tableSql} SET ${sets} WHERE ${keySql} = ${keyValue} AND NOT (${same})`;
  }
  return { inserted, updated };
}

/**
 * Runs seeders in order, each in its own transaction. A failure stops the run, and that seeder's
 * partial work is rolled back. Seeders that already ran keep their (idempotent) changes.
 */
export async function runSeeders(
  db: Database,
  seeders: readonly Seeder[],
  logger: Logger,
): Promise<Record<string, SeedResult>> {
  const results: Record<string, SeedResult> = {};
  for (const seeder of seeders) {
    const result = await withTransaction(db, (tx) => seeder.run(tx), { timeout: 120_000 });
    results[seeder.name] = result;
    logger.info({ seeder: seeder.name, ...result }, 'seeder finished');
  }
  return results;
}
