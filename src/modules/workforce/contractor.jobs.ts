import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { activeRules, emit, recipients, type RuleRow } from '../../core/notify/notify.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { addDays, businessDateFromDb, businessDateToDb, diffDays, todayIn } from '../../core/time/dates.js';

/**
 * Contract-expiry alerts (P2.05; P3 §8.7 "end_date drives the contract-expiry alert", trigger
 * `contract_expiry` of P1.16). Nightly: every approved contract whose end date falls within a rule's
 * lead_days is reported to the rule's recipients who may see contractors of its estate. Once per
 * contract and end date (the occurrence): an extension is a new end date, with its own alert.
 */

export const DEFAULT_LEAD_DAYS = 30;
export const CONTRACT_EXPIRY_JOB = 'contractor.notify_contract_expiry';

export function contractExpiryJob(db: Database, timezone: string) {
  async function runRule(rule: RuleRow, signal: AbortSignal) {
    const today = todayIn(timezone);
    const horizon = addDays(today, rule.leadDays ?? DEFAULT_LEAD_DAYS);
    let after = 0n;
    let found = 0;
    let created = 0;
    for (;;) {
      signal.throwIfAborted();
      const rows = await db.contractorContract.findMany({
        where: {
          id: { gt: after },
          state: 'approved',
          endDate: { gte: businessDateToDb(today), lte: businessDateToDb(horizon) },
        },
        include: { contractor: { select: { name: true } }, estate: { select: { name: true } } },
        orderBy: { id: 'asc' },
        take: 200,
      });
      if (rows.length === 0) break;
      after = rows[rows.length - 1]?.id ?? after;
      for (const c of rows) {
        found += 1;
        const end = businessDateFromDb(c.endDate);
        const days = diffDays(today, end);
        const users = await recipients(db, rule, {
          place: { estateId: c.estateId },
          viewPermission: 'contractor.view',
        });
        created += await emit(db, rule, users, {
          subject: `Contract ${c.contractNumber} ends ${days === 0 ? 'today' : `in ${String(days)} day${days === 1 ? '' : 's'}`}: ${c.contractor.name}`,
          body:
            `The contract ${c.contractNumber} of ${c.contractor.name} at ${c.estate.name} ends on ${end}. ` +
            'Renew it with a new contract, or let it complete.',
          linkType: 'contractor_contract',
          linkId: c.id,
          occurredOn: end,
        });
      }
    }
    return { found, created };
  }

  return defineJob({
    type: CONTRACT_EXPIRY_JOB,
    label: 'Tell people about contractor contracts ending soon',
    payload: z.object({}),
    async run(ctx) {
      return runUnscoped('contract expiry alerts cover every estate', async () => {
        const rules = await activeRules(db, 'contract_expiry');
        const result: Record<string, { found: number; created: number }> = {};
        for (const rule of rules) result[rule.code] = await runRule(rule, ctx.signal);
        return { result: { rules: result } };
      });
    },
  });
}

export const CONTRACTOR_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'contractor.notify_contract_expiry',
    description: 'Tells people about contractor contracts that end soon.',
    cron: '15 6 * * *',
    jobType: CONTRACT_EXPIRY_JOB,
  },
];
