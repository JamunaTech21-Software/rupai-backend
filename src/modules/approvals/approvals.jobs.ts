import type { Logger } from 'pino';
import { z } from 'zod';

import { resolveApprovers, type DocumentPlace } from '../../core/approval/approvers.js';
import type { ApproverRule } from '../../core/approval/definition.js';
import {
  approvableDocument,
  NEVER_SELF_APPROVE,
  type ApprovableDocument,
} from '../../core/approval/document-types.js';
import { BULK_APPROVABLE, permissionFor, readPath } from '../../core/approval/engine.js';
import { dbPermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';
import { activeRules, emit, recipients, requestSoon } from '../../core/notify/notify.js';
import { todayIn } from '../../core/time/dates.js';
import { PERMISSION_KEYS } from '../identity/permission-catalogue.js';

/**
 * Re-checks the exception flag of every pending approval (P7 §4.3, D-1.14-11). The flag is set when a
 * step becomes current; people gain and lose roles and scope afterwards, so this keeps the stored flag,
 * which the list filter reads, true between visits to /approvals/exceptions (which re-checks live).
 * Telling the administrators is approval.notify's part (below).
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

/** Approvals whose step started longer ago than this are not announced again (their queue shows them). */
export const NOTIFY_WINDOW_DAYS = 3;
export const APPROVAL_NOTIFY_JOB = 'approval.notify';

const stepSelect = {
  id: true,
  stepNumber: true,
  name: true,
  approverRule: true,
  roleId: true,
  userId: true,
  allowSelfApproval: true,
} as const;

const before = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The approval side of notifications (P1.16; P7 §4.2, §4.3). Run every five minutes, and soon after any
 * approval decision commits (`notifyApprovalsSoon`). It reads the approvals as they stand, so nothing in
 * the approval transaction depends on it (P1 §4.3), and a run it misses the next one makes up.
 *
 *   approval_pending     each pending approval whose step started in the last NOTIFY_WINDOW_DAYS: its
 *                        approvers, and their delegates, who hold the approve permission and are not the
 *                        submitter or creator (unless the step allows it). Once per step: the occurrence
 *                        is the day the step started. Bulk-approvable types (attendance, plucking) get one
 *                        notice per user and type per day, linked to the queue, not one per record.
 *   approval_unresolved  each pending approval nobody can act on (P7 §4.3): the rule's recipients (the
 *                        administrators, seeded) and the approvers of the step after it. Once per step.
 */
export function approvalNotifyJob(db: Database, timezone: string) {
  const authz = dbPermissionResolver(db);
  return defineJob({
    type: APPROVAL_NOTIFY_JOB,
    label: 'Tell approvers what awaits them',
    payload: z.object({}),
    async run(ctx) {
      const pendingRules = await activeRules(db, 'approval_pending');
      const stuckRules = await activeRules(db, 'approval_unresolved');
      const permissions = new Map<bigint, ReadonlySet<string>>();
      const holds = async (userId: bigint, permission: string) => {
        let set = permissions.get(userId);
        if (!set) permissions.set(userId, (set = await authz.permissionsOf(userId)));
        return set.has(permission);
      };
      const page = (where: object, after: bigint) =>
        db.approvalRequest.findMany({
          where: { state: 'pending', id: { gt: after }, ...where },
          include: { currentStep: { select: stepSelect }, submitter: { select: { username: true } } },
          orderBy: { id: 'asc' },
          take: 200,
        });
      type Row = Awaited<ReturnType<typeof page>>[number];
      const placeOf = (r: Row): DocumentPlace => ({
        estateId: r.estateId,
        factoryId: r.factoryId,
        warehouseId: r.warehouseId,
      });
      const resolve = async (document: ApprovableDocument, step: Row['currentStep'], r: Row) =>
        step
          ? (
              await resolveApprovers(
                db,
                document,
                { approverRule: step.approverRule as ApproverRule, roleId: step.roleId, userId: step.userId },
                placeOf(r),
              )
            ).users.map((u) => BigInt(u.id))
          : [];

      /** Who may act on the step now: P7 §4, §11.1, §12.2, as the queue decides it. */
      async function approversOf(r: Row, document: ApprovableDocument): Promise<bigint[]> {
        const step = r.currentStep;
        if (!step) return [];
        const direct = await resolve(document, step, r);
        const now = new Date();
        const delegates =
          direct.length === 0
            ? []
            : await db.approvalDelegation.findMany({
                where: {
                  fromUserId: { in: direct },
                  validFrom: { lte: now },
                  validTo: { gt: now },
                  endedAt: null,
                  OR: [{ documentType: null }, { documentType: r.documentType }],
                },
                select: { toUserId: true },
              });
        const selfAllowed = step.allowSelfApproval && !NEVER_SELF_APPROVE.has(document.approvalClass);
        const permission = permissionFor(document, 'approve', PERMISSION_KEYS);
        const out: bigint[] = [];
        for (const id of new Set([...direct, ...delegates.map((d) => d.toUserId)])) {
          if (!selfAllowed && (id === r.submittedBy || id === r.documentCreatedBy)) continue;
          if (await holds(id, permission)) out.push(id);
        }
        return out.sort(before);
      }

      let checked = 0;
      let created = 0;
      const today = todayIn(timezone);
      const since = new Date(Date.now() - NOTIFY_WINDOW_DAYS * 86_400_000);
      if (pendingRules.length > 0) {
        for (let after = 0n; ;) {
          ctx.signal.throwIfAborted();
          const rows = await page({ stepStartedAt: { gte: since } }, after);
          if (rows.length === 0) break;
          for (const r of rows) {
            after = r.id;
            const document = approvableDocument(r.documentType);
            const step = r.currentStep;
            if (!document || !step) continue;
            checked += 1;
            const users = await approversOf(r, document);
            const label = document.label;
            const draft = BULK_APPROVABLE.has(r.documentType)
              ? {
                  subject: `${label} records await your approval`,
                  body: `Records of ${label.toLowerCase()} are waiting in your approval queue. Approve them there, in bulk.`,
                  linkType: `approval_queue.${r.documentType}`,
                  linkId: 0n,
                  occurredOn: today,
                }
              : {
                  subject: `Approval needed: ${label} ${r.documentNumber ?? ''}`.trim(),
                  body:
                    `${r.documentLabel}, submitted by ${r.submitter.username}, is at step ` +
                    `${String(step.stepNumber)} (${step.name}) and waits in your approval queue.`,
                  linkType: 'approval_request',
                  linkId: r.id,
                  occurredOn: todayIn(timezone, r.stepStartedAt ?? r.submittedAt),
                };
            for (const rule of pendingRules) created += await emit(db, rule, users, draft);
          }
          await ctx.progress(checked);
        }
      }

      let stuck = 0;
      if (stuckRules.length > 0) {
        for (let after = 0n; ;) {
          ctx.signal.throwIfAborted();
          const rows = await page({ isUnresolved: true }, after);
          if (rows.length === 0) break;
          for (const r of rows) {
            after = r.id;
            const document = approvableDocument(r.documentType);
            const step = r.currentStep;
            if (!document || !step) continue;
            stuck += 1;
            const path = readPath(r.path);
            const next = path[path.findIndex((p) => p.step_number === step.stepNumber) + 1];
            const nextStep = next
              ? await db.workflowStep.findUnique({ where: { id: BigInt(next.step_id) }, select: stepSelect })
              : null;
            const nextApprovers = nextStep ? await resolve(document, nextStep, r) : [];
            const draft = {
              subject: `Nobody can approve ${document.label} ${r.documentNumber ?? ''}`.trim(),
              body:
                `Step ${String(step.stepNumber)} (${step.name}) of ${r.documentLabel} resolves to no one, so it ` +
                'cannot move on. Give the role to someone whose scope covers it, or grant a temporary role. ' +
                'It is on the approval exception list.',
              linkType: 'approval_request',
              linkId: r.id,
              occurredOn: todayIn(timezone, r.stepStartedAt ?? r.submittedAt),
              severity: 'warning' as const,
            };
            for (const rule of stuckRules) {
              // Administrative: the administrators hear of it whatever their estate scope.
              const users = await recipients(db, rule, {
                place: null,
                viewPermission: 'workflow.view',
                also: notifiesNextStep(rule.conditionJson) ? nextApprovers : [],
              });
              created += await emit(db, rule, users, draft);
            }
          }
        }
      }
      return { result: { pending_checked: checked, unresolved: stuck, notifications_created: created } };
    },
  });
}

/** condition_json of approval_unresolved: { "notify_next_step_approvers": false } leaves them out. */
const notifiesNextStep = (condition: unknown) =>
  !(
    typeof condition === 'object' &&
    condition !== null &&
    (condition as Record<string, unknown>).notify_next_step_approvers === false
  );

/**
 * After an approval transaction has committed (a submission or a decision): asks approval.notify to run
 * now rather than at its next five-minute slot. Never throws.
 */
export function notifyApprovalsSoon(deps: { db: Database; jobs: JobQueue; logger?: Logger }): Promise<void> {
  return requestSoon(deps, APPROVAL_NOTIFY_JOB, 'approval:all:notify');
}

export const APPROVAL_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'approval.notify',
    description:
      'Tells approvers what awaits them, and the administrators which approvals nobody can act on.',
    cron: '*/5 * * * *',
    jobType: APPROVAL_NOTIFY_JOB,
  },
  {
    name: 'approval.recheck_unresolved',
    description: 'Re-checks which pending approvals have nobody able to act on their current step.',
    cron: '5 * * * *',
    jobType: 'approval.recheck_unresolved',
  },
];
