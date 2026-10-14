import { z } from 'zod';

import { resolveApprovers } from '../../core/approval/approvers.js';
import type { ApproverRule } from '../../core/approval/definition.js';
import { approvableDocument } from '../../core/approval/document-types.js';
import type { Database } from '../../core/db/prisma.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';

/**
 * Re-checks the exception flag of every pending approval (P7 §4.3, D-1.14-11). The flag is set when a
 * step becomes current; people gain and lose roles and scope afterwards, so this keeps the stored flag,
 * which the list filter reads, true between visits to /approvals/exceptions (which re-checks live).
 * Notifying the administrator of new exceptions arrives with notifications (P1.16).
 */
export function recheckUnresolvedJob(db: Database) {
  return defineJob({
    type: 'approval.recheck_unresolved',
    label: 'Re-check approvals nobody can act on',
    payload: z.object({}),
    async run(ctx) {
      let after = 0n;
      let checked = 0;
      let unresolved = 0;
      let cleared = 0;
      let raised = 0;
      for (;;) {
        ctx.signal.throwIfAborted();
        const rows = await db.approvalRequest.findMany({
          where: { state: 'pending', id: { gt: after } },
          include: { currentStep: true },
          orderBy: { id: 'asc' },
          take: 200,
        });
        if (rows.length === 0) break;
        for (const r of rows) {
          after = r.id;
          const document = approvableDocument(r.documentType);
          const step = r.currentStep;
          if (!document || !step) continue;
          const nobody =
            (
              await resolveApprovers(
                db,
                document,
                { approverRule: step.approverRule as ApproverRule, roleId: step.roleId, userId: step.userId },
                { estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId },
              )
            ).users.length === 0;
          checked += 1;
          if (nobody) unresolved += 1;
          if (nobody !== r.isUnresolved) {
            // Only while still pending on the same step: a decision in between wins.
            await db.approvalRequest.updateMany({
              where: { id: r.id, state: 'pending', currentStepId: step.id },
              data: { isUnresolved: nobody },
            });
            if (nobody) raised += 1;
            else cleared += 1;
          }
        }
        await ctx.progress(checked);
      }
      return { result: { checked, unresolved, newly_unresolved: raised, cleared } };
    },
  });
}

export const APPROVAL_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'approval.recheck_unresolved',
    description: 'Re-checks which pending approvals have nobody able to act on their current step.',
    cron: '5 * * * *',
    jobType: 'approval.recheck_unresolved',
  },
];
