import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { dec } from '../../core/money/decimal.js';
import { activeRules, emit, recipients, type RuleRow } from '../../core/notify/notify.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { rebuildStockBalances } from '../../core/stock/rebuild.js';
import { todayIn } from '../../core/time/dates.js';

/**
 * Inventory jobs (BACKLOG P4.04):
 *   inventory.rebuild_balances  nightly: every balance rebuilt from its movements (P3 §13.2). A divergence is a
 *                               defect: it is corrected, listed, logged, and the job ends `partial`.
 *   inventory.low_stock         daily: the `low_stock` trigger (P3 §12.4 reorder_level). Once a day for each
 *                               material whose owned, available stock at a store is at or below its reorder
 *                               level, to the rule's recipients who may see that store.
 */
export const REBUILD_BALANCES_JOB = 'inventory.rebuild_balances';
export const LOW_STOCK_JOB = 'inventory.low_stock';

export function rebuildBalancesJob(db: Database) {
  return defineJob({
    type: REBUILD_BALANCES_JOB,
    label: 'Rebuild stock balances from the movement ledger',
    payload: z.object({}),
    async run(ctx) {
      return runUnscoped('the stock rebuild covers every location', async () => {
        const result = await rebuildStockBalances(db, ctx.signal);
        if (result.discrepancies.length > 0) {
          ctx.logger.error(result, 'stock balances diverged from their movements and were rebuilt');
          return { state: 'partial' as const, result };
        }
        return { result };
      });
    },
  });
}

export function lowStockJob(db: Database, timezone: string) {
  async function runRule(rule: RuleRow) {
    const today = todayIn(timezone);
    const low = await db.$queryRaw<
      {
        raw_material_id: bigint;
        code: string;
        name: string;
        uom: string;
        reorder_level: { toString(): string };
        location_type: string;
        location_id: bigint;
        quantity: { toString(): string };
      }[]
    >`
      SELECT b.raw_material_id, m.code, m.name, u.code AS uom, m.reorder_level, b.location_type, b.location_id,
             b.quantity
        FROM stock_balance b
        JOIN raw_material m ON m.id = b.raw_material_id
        JOIN uom u ON u.id = m.uom_id
       WHERE b.material_class = 'material' AND b.ownership = 'owned' AND b.stock_state = 'available'
         AND m.status = 'active' AND m.reorder_level IS NOT NULL AND b.quantity <= m.reorder_level
       ORDER BY b.raw_material_id, b.location_type, b.location_id`;
    let created = 0;
    for (const r of low) {
      const place =
        r.location_type === 'warehouse' ? { warehouseId: r.location_id } : { factoryId: r.location_id };
      const users = await recipients(db, rule, { place, viewPermission: 'inventory.view' });
      const qty = dec(r.quantity.toString()).toFixed(3);
      const level = dec(r.reorder_level.toString()).toFixed(3);
      created += await emit(db, rule, users, {
        subject: `Low stock: ${r.code} ${r.name}`,
        body: `${r.code} ${r.name}: ${qty} ${r.uom} left at ${r.location_type} ${r.location_id.toString()}, reorder level ${level} ${r.uom}.`,
        linkType: 'raw_material',
        linkId: r.raw_material_id,
        occurredOn: today,
      });
    }
    return { found: low.length, created };
  }

  return defineJob({
    type: LOW_STOCK_JOB,
    label: 'Tell people about materials at or below their reorder level',
    payload: z.object({}),
    async run() {
      return runUnscoped('low-stock alerts cover every store', async () => {
        const alerts: Record<string, { found: number; created: number }> = {};
        for (const rule of await activeRules(db, 'low_stock')) alerts[rule.code] = await runRule(rule);
        return { result: { alerts } };
      });
    },
  });
}

export const INVENTORY_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: REBUILD_BALANCES_JOB,
    description: 'Rebuilds every stock balance from its movements and reports any that diverged.',
    cron: '45 3 * * *',
    jobType: REBUILD_BALANCES_JOB,
  },
  {
    name: LOW_STOCK_JOB,
    description: 'Alerts on materials at or below their reorder level.',
    cron: '0 6 * * *',
    jobType: LOW_STOCK_JOB,
  },
];
