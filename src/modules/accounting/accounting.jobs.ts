import { z } from 'zod';

import { Prisma } from '../../generated/prisma/client.js';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { dec } from '../../core/money/decimal.js';
import { activeRules, emit, recipients, type RuleRow } from '../../core/notify/notify.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { partyLabels } from '../../core/settlement/parties.js';
import { refreshAgeing } from '../../core/settlement/settlement.js';
import { SETTLEMENT_SIDES, SIDES, type SettlementSide } from '../../core/settlement/sides.js';
import { addDays, businessDateFromDb, businessDateToDb, diffDays, todayIn } from '../../core/time/dates.js';

/**
 * The nightly ledger check (P3 §27.3 invariant, §27.6; P2 §10; D-3.03-6). MySQL cannot express either
 * invariant, so it is verified every night:
 *
 *   - every posted journal balances and its totals equal its lines
 *   - every ledger_balance row equals the journal lines it summarises (and no lines lack a row)
 *   - each sub-ledger agrees with its control accounts (P13 C-05, D-3.05-13): the posted balance of the
 *     receivable (payable) control accounts equals the outstanding base of the receivables (payables)
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
      const subledgers = await subledgerDifferences(db);
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
        subledgers,
      };
      if (unbalanced.length > 0 || diverging.length > 0 || subledgers.some((x) => !x.agrees)) {
        ctx.logger.error(result, 'ledger verification found divergences');
        return { state: 'partial' as const, result };
      }
      return { result };
    },
  });
}

/**
 * Control accounts against their sub-ledger (D-3.05-13). All posted lines count: balance-sheet accounts carry
 * across fiscal years until year-end carry-forward (P10.02) posts openings, which will need excluding here.
 */
async function subledgerDifferences(db: Database) {
  const ledger = await db.$queryRaw<{ side: string; balance: { toString(): string } | null }[]>`
    SELECT a.control_subledger AS side, SUM(jl.debit - jl.credit) AS balance
      FROM journal_line jl JOIN account a ON a.id = jl.account_id
     WHERE a.control_subledger IN ('receivable', 'payable')
     GROUP BY a.control_subledger`;
  const out = [];
  for (const side of SETTLEMENT_SIDES) {
    const [items] = await db.$queryRaw<{ total: { toString(): string } | null }[]>`
      SELECT SUM(outstanding_base_amount) AS total FROM ${Prisma.raw(`\`${SIDES[side].item}\``)}`;
    const debit = dec(ledger.find((l) => l.side === side)?.balance?.toString() ?? '0');
    // A receivable is a debit balance, a payable a credit one.
    const control = side === 'receivable' ? debit : debit.negated();
    const subledger = dec(items?.total?.toString() ?? '0');
    out.push({
      side,
      control: control.toFixed(4),
      subledger: subledger.toFixed(4),
      agrees: control.equals(subledger),
    });
  }
  return out;
}

// ---- ageing and payment_due (D-3.05-11, D-3.05-12) ------------------------------------------------------

export const REFRESH_AGEING_JOB = 'accounting.refresh_ageing';
export const DEFAULT_DUE_LEAD_DAYS = 7;

/**
 * Nightly: re-bands every open receivable and payable as at today (P3 §15.1 "refreshed nightly"), then
 * evaluates the `payment_due` trigger: once per item and due date when it falls due within the rule's
 * lead_days, and once more the day after it falls due (overdue). Recipients may see the item's estate.
 */
export function refreshAgeingJob(db: Database, timezone: string) {
  async function runRule(rule: RuleRow, side: SettlementSide, signal: AbortSignal) {
    const def = SIDES[side];
    const today = todayIn(timezone);
    const horizon = addDays(today, rule.leadDays ?? DEFAULT_DUE_LEAD_DAYS);
    let after = 0n;
    let found = 0;
    let created = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = await db.$queryRaw<
        {
          id: bigint;
          reference_number: string;
          party_type: string;
          party_id: bigint;
          estate_id: bigint | null;
          due_date: Date;
          outstanding_amount: { toString(): string };
          code: string;
        }[]
      >`
        SELECT i.id, i.reference_number, i.party_type, i.party_id, i.estate_id, i.due_date, i.outstanding_amount,
               c.code
          FROM ${Prisma.raw(`\`${def.item}\``)} i JOIN currency c ON c.id = i.currency_id
         WHERE i.id > ${after} AND i.state IN ('open', 'partially_settled')
           AND i.due_date <= ${businessDateToDb(horizon)}
         ORDER BY i.id LIMIT 200`;
      if (rows.length === 0) break;
      after = rows[rows.length - 1]?.id ?? after;
      const labels = await partyLabels(
        db,
        rows.map((r) => ({ type: r.party_type, id: r.party_id })),
      );
      for (const r of rows) {
        found += 1;
        const due = businessDateFromDb(r.due_date);
        const days = diffDays(today, due);
        const overdue = days < 0;
        const who = labels.get(`${r.party_type}:${String(r.party_id)}`)?.name ?? r.party_type;
        const amount = `${r.code} ${dec(r.outstanding_amount.toString()).toFixed(2)}`;
        const users = await recipients(db, rule, {
          place: { estateId: r.estate_id },
          viewPermission: def.viewPermission,
        });
        const what =
          side === 'receivable'
            ? `Receivable ${r.reference_number} from ${who}`
            : `Payable ${r.reference_number} to ${who}`;
        created += await emit(db, rule, users, {
          subject: overdue
            ? `${what} is overdue`
            : `${what} is due ${days === 0 ? 'today' : `in ${String(days)} day${days === 1 ? '' : 's'}`}`,
          body: `${what}: ${amount} outstanding, due on ${due}.`,
          linkType: def.item,
          linkId: r.id,
          // One alert while due, one once overdue (the unique key repeats nothing else).
          occurredOn: overdue ? addDays(due, 1) : due,
          ...(overdue ? { severity: 'warning' as const } : {}),
        });
      }
    }
    return { found, created };
  }

  return defineJob({
    type: REFRESH_AGEING_JOB,
    label: 'Refresh receivable and payable ageing, and tell people about payments due',
    payload: z.object({}),
    async run(ctx) {
      return runUnscoped('ageing and payment alerts cover every estate', async () => {
        const today = todayIn(timezone);
        const rebanded: Record<string, number> = {};
        for (const side of SETTLEMENT_SIDES) rebanded[side] = await refreshAgeing(db, side, today);
        const rules = await activeRules(db, 'payment_due');
        const alerts: Record<string, { found: number; created: number }> = {};
        for (const rule of rules) {
          for (const side of SETTLEMENT_SIDES) {
            alerts[`${rule.code}:${side}`] = await runRule(rule, side, ctx.signal);
          }
        }
        return { result: { as_at: today, rebanded, alerts } };
      });
    },
  });
}

export const ACCOUNTING_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: REFRESH_AGEING_JOB,
    description: 'Re-bands open receivables and payables by days overdue and sends payment-due alerts.',
    cron: '30 2 * * *',
    jobType: REFRESH_AGEING_JOB,
  },
  {
    name: VERIFY_LEDGER_JOB,
    description: 'Checks every journal balances and every ledger balance equals its journal lines.',
    cron: '15 3 * * *',
    jobType: VERIFY_LEDGER_JOB,
  },
];
