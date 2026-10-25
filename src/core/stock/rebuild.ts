import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../db/prisma.js';
import { withTransaction } from '../db/transaction.js';
import { dec } from '../money/decimal.js';
import { averageOf } from './valuation.js';

/**
 * Rebuilds stock_balance from stock_movement (Spec P3 §13.2: "fully rebuildable"; "a nightly job rebuilds
 * balances from movements and reports any discrepancy. A discrepancy is a defect"). Because each movement
 * stores its value, a balance is a plain sum: quantity = Σ in − Σ out, value = Σ in values − Σ out values,
 * average = value ÷ quantity (valuation.ts). No replay is needed.
 *
 * Each diverging balance is corrected in its own short transaction, under the same row lock core/stock
 * takes, and recomputed under that lock (so a movement written meanwhile is counted). Every row is then
 * stamped last_rebuilt_at.
 */

interface Num {
  toString(): string;
}
export interface BalanceDiscrepancy {
  readonly balance_key: string;
  readonly stored: { quantity: string; value: string } | null;
  readonly rebuilt: { quantity: string; value: string };
}

/** The generated balance_key, computed over movement rows (a constant: no input reaches it). */
const KEY = Prisma.raw(`CONCAT_WS('|', material_class, IFNULL(raw_material_id, ''), IFNULL(tea_type_id, ''),
  IFNULL(tea_grade_id, ''), IFNULL(production_batch_id, ''), location_type, location_id, ownership, stock_state)`);

export async function rebuildStockBalances(
  db: Database,
  signal?: AbortSignal,
): Promise<{ checked: number; discrepancies: BalanceDiscrepancy[] }> {
  // Keys whose stored balance differs from its movements, both ways round.
  const diverging = await db.$queryRaw<
    { balance_key: string; sq: Num | null; sv: Num | null; mq: Num | null; mv: Num | null }[]
  >`
    SELECT k.balance_key, b.quantity AS sq, b.value AS sv, m.q AS mq, m.v AS mv
      FROM (SELECT balance_key FROM stock_balance
            UNION SELECT DISTINCT ${KEY} FROM stock_movement) k
      LEFT JOIN stock_balance b ON b.balance_key = k.balance_key
      LEFT JOIN (SELECT ${KEY} AS balance_key,
                        SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END) AS q,
                        SUM(CASE direction WHEN 'in' THEN value ELSE -value END) AS v
                   FROM stock_movement GROUP BY 1) m ON m.balance_key = k.balance_key
     WHERE b.id IS NULL OR b.quantity <> IFNULL(m.q, 0) OR b.value <> IFNULL(m.v, 0)
        OR b.average_unit_cost <> CASE WHEN IFNULL(m.q, 0) = 0 THEN 0 ELSE ROUND(m.v / m.q, 4) END`;

  const discrepancies: BalanceDiscrepancy[] = [];
  for (const d of diverging) {
    signal?.throwIfAborted();
    const fixed = await withTransaction(db, async (tx) => {
      const [one] = await tx.$queryRaw<
        {
          material_class: string;
          raw_material_id: bigint | null;
          tea_type_id: bigint | null;
          tea_grade_id: bigint | null;
          production_batch_id: bigint | null;
          location_type: string;
          location_id: bigint;
          ownership: string;
          stock_state: string;
        }[]
      >`
        SELECT material_class, raw_material_id, tea_type_id, tea_grade_id, production_batch_id, location_type,
               location_id, ownership, stock_state
          FROM stock_movement WHERE ${KEY} = ${d.balance_key} LIMIT 1`;
      if (one) {
        await tx.$executeRaw`
          INSERT INTO stock_balance (material_class, raw_material_id, tea_type_id, tea_grade_id, production_batch_id,
                                     location_type, location_id, ownership, stock_state)
          VALUES (${one.material_class}, ${one.raw_material_id}, ${one.tea_type_id}, ${one.tea_grade_id},
                  ${one.production_batch_id}, ${one.location_type}, ${one.location_id}, ${one.ownership},
                  ${one.stock_state})
          ON DUPLICATE KEY UPDATE id = id`;
      }
      const [b] = await tx.$queryRaw<{ id: bigint }[]>`
        SELECT id FROM stock_balance WHERE balance_key = ${d.balance_key} FOR UPDATE`;
      if (!b) return null;
      const [m] = await tx.$queryRaw<{ q: Num | null; v: Num | null; at: Date | null }[]>`
        SELECT SUM(CASE direction WHEN 'in' THEN quantity ELSE -quantity END) AS q,
               SUM(CASE direction WHEN 'in' THEN value ELSE -value END) AS v, MAX(moved_at) AS at
          FROM stock_movement WHERE ${KEY} = ${d.balance_key}`;
      const holding = { quantity: dec(m?.q?.toString() ?? '0'), value: dec(m?.v?.toString() ?? '0') };
      await tx.$executeRaw`
        UPDATE stock_balance SET quantity = ${holding.quantity.toFixed(3)}, value = ${holding.value.toFixed(4)},
               average_unit_cost = ${averageOf(holding).toFixed(4)}, last_movement_at = ${m?.at ?? null}
         WHERE id = ${b.id}`;
      return holding;
    });
    if (fixed) {
      discrepancies.push({
        balance_key: d.balance_key,
        stored:
          d.sq === null || d.sv === null
            ? null
            : { quantity: dec(d.sq.toString()).toFixed(3), value: dec(d.sv.toString()).toFixed(4) },
        rebuilt: { quantity: fixed.quantity.toFixed(3), value: fixed.value.toFixed(4) },
      });
    }
  }
  const stamped = await db.$executeRaw`UPDATE stock_balance SET last_rebuilt_at = UTC_TIMESTAMP()`;
  return { checked: stamped, discrepancies };
}
