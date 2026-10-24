import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';

/**
 * The nightly ledger check (P3 §27.3 invariant, §27.6; P2 §10; D-3.03-6). MySQL cannot express either
 * invariant, so it is verified every night:
 *
 *   - every posted journal balances and its totals equal its lines
 *   - every ledger_balance row equals the journal lines it summarises (and no lines lack a row)
 *
 * A divergence is a defect: the job ends `partial`, lists the first offenders and logs an error.
 */
export const VERIFY_LEDGER_JOB = 'accounting.verify_ledger';

export function verifyLedgerJob(db: Database) {
  return defineJob({
    type: VERIFY_LEDGER_JOB,
    label: 'Verify journals and ledger balances',
    payload: z.object({}),
    async run(ctx) {
      const unbalanced = await db.$queryRaw<{ id: bigint; journal_number: string | null }[]>`
        SELECT j.id, j.journal_number FROM journal j
          LEFT JOIN (SELECT journal_id, SUM(debit) AS d, SUM(credit) AS c FROM journal_line GROUP BY journal_id) l
            ON l.journal_id = j.id
         WHERE j.state = 'posted'
           AND (j.total_debit <> j.total_credit OR j.total_debit <> IFNULL(l.d, 0) OR j.total_credit <> IFNULL(l.c, 0))
         LIMIT 20`;
      const diverging = await db.$queryRaw<{ account_id: bigint; accounting_period_id: bigint }[]>`
        SELECT x.account_id, x.accounting_period_id FROM (
          SELECT account_id, accounting_period_id, cost_centre_id, estate_id, SUM(debit) AS d, SUM(credit) AS c
            FROM journal_line GROUP BY account_id, accounting_period_id, cost_centre_id, estate_id
        ) x
        LEFT JOIN ledger_balance lb ON lb.account_id = x.account_id AND lb.accounting_period_id = x.accounting_period_id
             AND lb.cost_centre_id <=> x.cost_centre_id AND lb.estate_id <=> x.estate_id
         WHERE lb.id IS NULL OR lb.period_debit <> x.d OR lb.period_credit <> x.c
        UNION
        SELECT lb.account_id, lb.accounting_period_id FROM ledger_balance lb
         WHERE (lb.period_debit <> 0 OR lb.period_credit <> 0) AND NOT EXISTS (
           SELECT 1 FROM journal_line jl WHERE jl.account_id = lb.account_id
              AND jl.accounting_period_id = lb.accounting_period_id
              AND jl.cost_centre_id <=> lb.cost_centre_id AND jl.estate_id <=> lb.estate_id)
         LIMIT 20`;
      const [counts] = await db.$queryRaw<{ journals: bigint; balances: bigint }[]>`
        SELECT (SELECT COUNT(*) FROM journal WHERE state = 'posted') AS journals,
               (SELECT COUNT(*) FROM ledger_balance) AS balances`;
      const result = {
        journals_checked: Number(counts?.journals ?? 0),
        balances_checked: Number(counts?.balances ?? 0),
        unbalanced_journals: unbalanced.map((j) => j.journal_number ?? j.id.toString()),
        diverging_balances: diverging.map((d) => ({
          account_id: d.account_id.toString(),
          accounting_period_id: d.accounting_period_id.toString(),
        })),
      };
      if (unbalanced.length > 0 || diverging.length > 0) {
        ctx.logger.error(result, 'ledger verification found divergences');
        return { state: 'partial' as const, result };
      }
      return { result };
    },
  });
}

export const ACCOUNTING_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: VERIFY_LEDGER_JOB,
    description: 'Checks every journal balances and every ledger balance equals its journal lines.',
    cron: '15 3 * * *',
    jobType: VERIFY_LEDGER_JOB,
  },
];
