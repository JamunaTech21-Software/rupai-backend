import { z } from 'zod';

import { resolveControl } from '../../core/budget/budget.js';
import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { dec } from '../../core/money/decimal.js';
import { activeRules, emit, recipients } from '../../core/notify/notify.js';
import { runUnscoped } from '../../core/scope/scope.js';
import { addDays, businessDateFromDb, todayIn } from '../../core/time/dates.js';

/**
 * Budget threshold alerts (P3.06; P1.16 trigger `budget_threshold`; D-3.06-14). Nightly: every line of an
 * active budget whose utilisation reached its control's warning threshold is reported once, and once more
 * at the critical threshold. The occurrence is the budget's release date (warning) or the day after
 * (critical), so a line is never reported twice for the same level.
 */

export const BUDGET_THRESHOLD_JOB = 'budget.notify_thresholds';

export function budgetThresholdJob(db: Database, timezone: string) {
  return defineJob({
    type: BUDGET_THRESHOLD_JOB,
    label: 'Tell people about budget lines reaching their thresholds',
    payload: z.object({}),
    async run(ctx) {
      return runUnscoped('budget alerts cover every estate', async () => {
        const rules = await activeRules(db, 'budget_threshold');
        if (rules.length === 0) return { result: { lines: 0, created: 0 } };
        const lines = await db.budgetLine.findMany({
          where: { budget: { state: 'active' }, utilisationPercentage: { gt: 0 } },
          include: {
            budget: { select: { budgetCode: true, name: true, fiscalYearId: true, activatedAt: true } },
            budgetHead: { select: { code: true, name: true } },
          },
        });
        let created = 0;
        let reported = 0;
        for (const l of lines) {
          ctx.signal.throwIfAborted();
          const control = await resolveControl(db, l.budgetHeadId, l.estateId, l.budget.fiscalYearId);
          const used = dec(l.utilisationPercentage.toString());
          const level =
            control.criticalThreshold !== null && used.greaterThanOrEqualTo(control.criticalThreshold)
              ? 'critical'
              : control.warningThreshold !== null && used.greaterThanOrEqualTo(control.warningThreshold)
                ? 'warning'
                : null;
          if (level === null) continue;
          reported += 1;
          const released = businessDateFromDb(l.budget.activatedAt ?? new Date(todayIn(timezone)));
          for (const rule of rules) {
            const users = await recipients(db, rule, {
              place: { estateId: l.estateId },
              viewPermission: 'budget.view',
            });
            created += await emit(db, rule, users, {
              subject: `${l.budgetHead.name} has used ${used.toFixed(2)} % of its budget (${l.budget.budgetCode})`,
              body:
                `${l.budget.name}: ${l.budgetHead.code} ${l.budgetHead.name} is at ${used.toFixed(2)} % ` +
                `(${level} threshold ${String(level === 'critical' ? control.criticalThreshold : control.warningThreshold)} %). ` +
                `Annual ${l.annualAmount.toFixed(2)}, actual ${l.actualAmount.toFixed(2)}, committed ${l.committedAmount.toFixed(2)}.`,
              linkType: 'budget_line',
              linkId: l.id,
              occurredOn: level === 'critical' ? addDays(released, 1) : released,
              severity: level === 'critical' ? 'critical' : 'warning',
            });
          }
        }
        return { result: { lines: reported, created } };
      });
    },
  });
}

export const BUDGET_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: BUDGET_THRESHOLD_JOB,
    description: 'Tells people about budget lines that reached their warning or critical threshold.',
    cron: '45 6 * * *',
    jobType: BUDGET_THRESHOLD_JOB,
  },
];
