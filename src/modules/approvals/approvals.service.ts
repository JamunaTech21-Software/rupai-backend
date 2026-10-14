import type { z } from 'zod';

import { resolveApprovers } from '../../core/approval/approvers.js';
import type { ApproverRule } from '../../core/approval/definition.js';
import { approvableDocument, NEVER_SELF_APPROVE } from '../../core/approval/document-types.js';
import {
  decide,
  eligibility,
  permissionFor,
  readPath,
  type ApprovalActionKind,
  type EngineDeps,
} from '../../core/approval/engine.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { auditCreate, auditUpdate, type AuditedRecord } from '../../core/audit/audit.js';
import { holdsPermission, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec } from '../../core/money/decimal.js';
import { currentScope, type ResolvedScope } from '../../core/scope/scope.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PERMISSION_KEYS } from '../identity/permission-catalogue.js';
import type {
  ApprovalOut,
  DelegateBody,
  DelegationOut,
  HistoryOut,
  QueueItemOut,
} from './approvals.schema.js';

/**
 * The approval runtime's HTTP-facing service (Spec P7 §4, §10–§14): the approval queue, one approval with
 * its frozen path and history, the actions, the exception list and delegations. The decisions themselves
 * are made by the engine (core/approval/engine.ts); this service decides who may SEE what.
 *
 * Who may see an approval: its submitter or the document's creator, anyone who may act on it now, and
 * anyone holding the document module's view permission (or workflow.view) whose scope reaches the
 * document. Everyone else gets 404, as for any record out of reach (P4 §4.3).
 */

type ApprovalOutT = z.infer<typeof ApprovalOut>;
type QueueItemT = z.infer<typeof QueueItemOut>;
type DelegationOutT = z.infer<typeof DelegationOut>;

const DELEGATION_AUDIT: AuditedRecord = {
  type: 'approval_delegation',
  class: 'master',
  fields: ['from_user_id', 'to_user_id', 'document_type', 'valid_from', 'valid_to', 'ended_at', 'reason'],
};
/** P7 §11.1 "a bounded period". */
const MAX_DELEGATION_DAYS = 90;
const QUEUE_LIMIT = 2000;

const requestInclude = {
  workflow: { select: { ruleCode: true } },
  submitter: { select: { id: true, username: true } },
  currentStep: {
    select: {
      id: true,
      stepNumber: true,
      name: true,
      approverRule: true,
      roleId: true,
      userId: true,
      allowSelfApproval: true,
      conditionField: true,
      conditionOperator: true,
      conditionValue: true,
    },
  },
  actions: {
    include: {
      user: { select: { id: true, username: true } },
      actingFor: { select: { id: true, username: true } },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.ApprovalRequestInclude;
type RequestRow = Prisma.ApprovalRequestGetPayload<{ include: typeof requestInclude }>;

const ref = (u: { id: bigint; username: string } | null) =>
  u ? { id: u.id.toString(), username: u.username } : null;
const iso = (d: Date | null) => (d ? d.toISOString() : null);
/** As stored: the queue's amount has two places (base currency), its quantity three. */
const decimal = (d: Prisma.Decimal | null, kind: 'money' | 'qty') =>
  d ? d.toFixed(kind === 'money' ? 2 : 3) : null;
const labelOf = (type: string) => approvableDocument(type)?.label ?? type;

/** Whether the caller's scope reaches where the document sits. */
function scopeReaches(
  scope: ResolvedScope,
  r: { estateId: bigint | null; factoryId: bigint | null; warehouseId: bigint | null },
): boolean {
  if (scope.allEstates) return true;
  if (r.estateId !== null && scope.estates.includes(r.estateId)) return true;
  if (r.factoryId !== null && scope.factories.includes(r.factoryId)) return true;
  return r.warehouseId !== null && scope.warehouses.includes(r.warehouseId);
}

export interface ApprovalsDeps {
  readonly db: Database;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function approvalsService({ db, authz, timezone }: ApprovalsDeps) {
  const engineDeps: EngineDeps = {
    timezone,
    can: (permission) => holdsPermission(authz, permission),
    knownPermissions: PERMISSION_KEYS,
  };
  const can = (permission: string) => holdsPermission(authz, permission);
  const viewPermission = (type: string) => {
    const module = approvableDocument(type)?.module;
    const key = module ? `${module}.view` : null;
    return key && PERMISSION_KEYS.has(key) ? key : 'workflow.view';
  };

  /** What the caller may do on this request now, and whether they may see it at all. */
  async function access(tx: Database | Tx, r: RequestRow, userId: bigint) {
    const document = approvableDocument(r.documentType);
    const involved = userId === r.submittedBy || userId === r.documentCreatedBy;
    const none = { approve: false, reject: false, return: false, comment: false };
    let actions = none;
    let eligible = false;
    if (document && r.state === 'pending' && r.currentStep) {
      const e = await eligibility(
        tx,
        document,
        r.currentStep,
        { estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId },
        userId,
        r.documentType,
      );
      eligible = e !== null;
      const selfBlocked =
        (involved ||
          (e?.actingForUserId !== null &&
            e?.actingForUserId !== undefined &&
            (e.actingForUserId === r.submittedBy || e.actingForUserId === r.documentCreatedBy))) &&
        !(r.currentStep.allowSelfApproval && !NEVER_SELF_APPROVE.has(document.approvalClass));
      const may = async (kind: ApprovalActionKind) =>
        eligible && !selfBlocked && (await can(permissionFor(document, kind, PERMISSION_KEYS)));
      actions = {
        approve: await may('approve'),
        reject: await may('reject'),
        return: await may('return'),
        comment: involved || eligible,
      };
    }
    const viewer =
      involved ||
      eligible ||
      ((await can(viewPermission(r.documentType))) || (await can('workflow.view'))
        ? scopeReaches(await currentScope(), r)
        : false);
    return { actions, viewer };
  }

  async function view(tx: Database | Tx, r: RequestRow, actions: ApprovalOutT['can']): Promise<ApprovalOutT> {
    const document = approvableDocument(r.documentType);
    const steps = await tx.workflowStep.findMany({
      where: { workflowId: r.workflowId },
      include: {
        role: { select: { id: true, code: true, name: true } },
        user: { select: { id: true, username: true } },
      },
      orderBy: { stepNumber: 'asc' },
    });
    const path = readPath(r.path).map((p) => p.step_number);
    const decided = new Map<number, { user: { id: bigint; username: string }; at: Date }>();
    for (const a of r.actions) {
      if (a.action === 'approve' && a.stepNumber !== null)
        decided.set(a.stepNumber, { user: a.user, at: a.actedAt });
    }
    const current = r.currentStepNumber;
    const out: ApprovalOutT['steps'] = [];
    for (const s of steps) {
      const onPath = path.includes(s.stepNumber);
      const status: ApprovalOutT['steps'][number]['status'] = !onPath
        ? 'skipped'
        : current === s.stepNumber
          ? 'current'
          : decided.has(s.stepNumber) &&
              (current === null || path.indexOf(s.stepNumber) < path.indexOf(current))
            ? 'done'
            : r.state === 'pending'
              ? 'upcoming'
              : 'not_reached';
      const approvers =
        status === 'current' && document
          ? (
              await resolveApprovers(
                tx,
                document,
                { approverRule: s.approverRule as ApproverRule, roleId: s.roleId, userId: s.userId },
                { estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId },
              )
            ).users
          : [];
      const d = status === 'done' ? decided.get(s.stepNumber) : undefined;
      out.push({
        step_number: s.stepNumber,
        name: s.name,
        approver_rule: s.approverRule as ApproverRule,
        role: s.role ? { id: s.role.id.toString(), code: s.role.code, name: s.role.name } : null,
        user: ref(s.user),
        on_path: onPath,
        status,
        decided_by: ref(d?.user ?? null),
        decided_at: iso(d?.at ?? null),
        approvers: [...approvers],
      });
    }
    const guard = r.guardFailure as { code?: string; message?: string; at?: string; by?: string } | null;
    return {
      id: r.id.toString(),
      document_type: r.documentType,
      document_type_label: labelOf(r.documentType),
      document_id: r.documentId.toString(),
      document_number: r.documentNumber,
      document_label: r.documentLabel,
      amount: decimal(r.summaryAmount, 'money'),
      quantity: decimal(r.summaryQuantity, 'qty'),
      estate_id: r.estateId?.toString() ?? null,
      workflow_id: r.workflowId.toString(),
      workflow_code: r.workflow.ruleCode,
      state: r.state as ApprovalOutT['state'],
      current_step_number: r.currentStepNumber,
      is_unresolved: r.isUnresolved,
      is_exceptional: r.isExceptional,
      guard_failure:
        guard?.code && guard.message
          ? { code: guard.code, message: guard.message, at: guard.at ?? '', by: guard.by ?? '' }
          : null,
      submitted_by: { id: r.submitter.id.toString(), username: r.submitter.username },
      submitted_at: r.submittedAt.toISOString(),
      completed_at: iso(r.completedAt),
      version: r.version,
      steps: out,
      actions: r.actions.map((a) => ({
        id: a.id.toString(),
        action: a.action as ApprovalOutT['actions'][number]['action'],
        step_number: a.stepNumber,
        user: { id: a.user.id.toString(), username: a.user.username },
        acting_for: ref(a.actingFor),
        comment: a.comment,
        acted_at: a.actedAt.toISOString(),
        is_self_approval: a.isSelfApproval,
        bulk_reference: a.bulkReference,
      })),
      can: actions,
    };
  }

  async function loadVisible(tx: Database | Tx, id: bigint, userId: bigint) {
    const r = await tx.approvalRequest.findUnique({ where: { id }, include: requestInclude });
    if (!r) throw Errors.notFound('No such approval.');
    const a = await access(tx, r, userId);
    if (!a.viewer) throw Errors.notFound('No such approval.');
    return { r, actions: a.actions };
  }

  function delegationOut(
    d: Prisma.ApprovalDelegationGetPayload<{ include: { fromUser: true; toUser: true } }>,
  ): DelegationOutT {
    const now = new Date();
    return {
      id: d.id.toString(),
      from_user: { id: d.fromUser.id.toString(), username: d.fromUser.username },
      to_user: { id: d.toUser.id.toString(), username: d.toUser.username },
      document_type: d.documentType,
      valid_from: d.validFrom.toISOString(),
      valid_to: d.validTo.toISOString(),
      ended_at: iso(d.endedAt),
      is_active: d.endedAt === null && d.validFrom <= now && d.validTo > now,
      reason: d.reason,
      created_by: d.createdBy.toString(),
      created_at: d.createdAt.toISOString(),
    };
  }
  const delegationAudit = (d: {
    fromUserId: bigint;
    toUserId: bigint;
    documentType: string | null;
    validFrom: Date;
    validTo: Date;
    endedAt: Date | null;
    reason: string;
  }) => ({
    from_user_id: d.fromUserId,
    to_user_id: d.toUserId,
    document_type: d.documentType,
    valid_from: d.validFrom,
    valid_to: d.validTo,
    ended_at: d.endedAt,
    reason: d.reason,
  });

  return {
    /**
     * The caller's queue (P7 §13.1): every pending approval whose current step they may act on, directly
     * or for someone who delegated to them, across every document type. Oldest first.
     */
    async queue(userId: bigint, q: ListQuery): Promise<{ items: QueueItemT[]; total: number }> {
      const now = new Date();
      const delegators = await db.approvalDelegation.findMany({
        where: { toUserId: userId, validFrom: { lte: now }, validTo: { gt: now }, endedAt: null },
        select: { fromUserId: true },
      });
      const people = [userId, ...delegators.map((d) => d.fromUserId)];
      const roles = await db.userRole.findMany({
        where: {
          userId: { in: people },
          role: { status: 'active' },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { roleId: true },
      });
      const filter = (field: string) => q.filters.filter((f) => f.field === field);
      const values = (field: string) =>
        filter(field).flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      const types = values('document_type');
      const estates = values('estate_id');
      const candidates = await db.approvalRequest.findMany({
        where: {
          state: 'pending',
          ...(types.length > 0 ? { documentType: { in: types } } : {}),
          ...(estates.length > 0 ? { estateId: { in: estates.map(BigInt) } } : {}),
          currentStep: {
            OR: [
              { approverRule: 'by_role', roleId: { in: [...new Set(roles.map((r) => r.roleId))] } },
              { approverRule: 'by_named_user', userId: { in: people } },
            ],
          },
        },
        include: requestInclude,
        orderBy: [{ stepStartedAt: 'asc' }, { id: 'asc' }],
        take: QUEUE_LIMIT,
      });
      const amountFrom = filter('amount').find((f) => f.op === 'from')?.value;
      const amountTo = filter('amount').find((f) => f.op === 'to')?.value;
      const items: QueueItemT[] = [];
      for (const r of candidates) {
        const amount = decimal(r.summaryAmount, 'money');
        // Decimal comparison: never a float on money (P9 §2.1).
        if (amountFrom !== undefined && (amount === null || dec(amount).lt(dec(String(amountFrom)))))
          continue;
        if (amountTo !== undefined && (amount === null || dec(amount).gt(dec(String(amountTo))))) continue;
        const { actions } = await access(db, r, userId);
        if (!actions.approve && !actions.reject && !actions.return) continue;
        const document = approvableDocument(r.documentType);
        const step = r.currentStep;
        if (!document || !step) continue;
        const e = await eligibility(
          db,
          document,
          step,
          { estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId },
          userId,
          r.documentType,
        );
        const actingFor = e?.actingForUserId
          ? await db.user.findUnique({
              where: { id: e.actingForUserId },
              select: { id: true, username: true },
            })
          : null;
        const since = r.stepStartedAt ?? r.submittedAt;
        items.push({
          approval_id: r.id.toString(),
          document_type: r.documentType,
          document_type_label: labelOf(r.documentType),
          document_id: r.documentId.toString(),
          document_number: r.documentNumber,
          document_label: r.documentLabel,
          amount,
          quantity: decimal(r.summaryQuantity, 'qty'),
          estate_id: r.estateId?.toString() ?? null,
          submitted_by: { id: r.submitter.id.toString(), username: r.submitter.username },
          submitted_at: r.submittedAt.toISOString(),
          step_number: step.stepNumber,
          step_name: step.name,
          waiting_since: since.toISOString(),
          waiting_hours: Math.floor((now.getTime() - since.getTime()) / 3_600_000),
          acting_for: ref(actingFor),
          has_guard_failure: r.guardFailure !== null,
        });
      }
      const minAge = values('waiting_hours_from')[0];
      const aged = minAge === undefined ? items : items.filter((i) => i.waiting_hours >= Number(minAge));
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      return { items: aged.slice((page - 1) * perPage, page * perPage), total: aged.length };
    },

    async get(id: bigint, userId: bigint): Promise<ApprovalOutT> {
      const { r, actions } = await loadVisible(db, id, userId);
      return view(db, r, actions);
    },

    /** Every approval the caller may see (administration and the ageing view, P7 §11.3). */
    async list(q: ListQuery, userId: bigint): Promise<{ items: ApprovalOutT[]; total: number }> {
      const filter = (field: string) =>
        q.filters
          .filter((f) => f.field === field)
          .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      const states = filter('state');
      const types = filter('document_type');
      const estates = filter('estate_id');
      const unresolved = filter('is_unresolved')[0];
      const rows = await db.approvalRequest.findMany({
        where: {
          ...(states.length > 0 ? { state: { in: states } } : {}),
          ...(types.length > 0 ? { documentType: { in: types } } : {}),
          ...(estates.length > 0 ? { estateId: { in: estates.map(BigInt) } } : {}),
          ...(unresolved !== undefined ? { isUnresolved: unresolved === 'true' } : {}),
        },
        include: requestInclude,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        take: QUEUE_LIMIT,
      });
      const scope = await currentScope();
      const visible = rows.filter((r) => scopeReaches(scope, r));
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      const slice = visible.slice((page - 1) * perPage, page * perPage);
      const items: ApprovalOutT[] = [];
      for (const r of slice) items.push(await view(db, r, (await access(db, r, userId)).actions));
      return { items, total: visible.length };
    },

    /**
     * The exception list (P7 §4.3): pending approvals whose current step resolves to nobody. Re-checked
     * on every read, so an approval leaves the list as soon as somebody is given the role.
     */
    async exceptions(userId: bigint): Promise<ApprovalOutT[]> {
      return withTransaction(db, async (tx) => {
        const rows = await tx.approvalRequest.findMany({
          where: { state: 'pending' },
          include: requestInclude,
          orderBy: [{ stepStartedAt: 'asc' }, { id: 'asc' }],
          take: QUEUE_LIMIT,
        });
        const scope = await currentScope();
        const out: ApprovalOutT[] = [];
        for (const r of rows) {
          const document = approvableDocument(r.documentType);
          const step = r.currentStep;
          if (!document || !step || !scopeReaches(scope, r)) continue;
          const nobody =
            (
              await resolveApprovers(
                tx,
                document,
                { approverRule: step.approverRule as ApproverRule, roleId: step.roleId, userId: step.userId },
                { estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId },
              )
            ).users.length === 0;
          if (nobody !== r.isUnresolved) {
            await tx.approvalRequest.update({ where: { id: r.id }, data: { isUnresolved: nobody } });
          }
          if (nobody)
            out.push(await view(tx, { ...r, isUnresolved: true }, (await access(tx, r, userId)).actions));
        }
        return out;
      });
    },

    /**
     * An action on an approval. The engine decides; this returns the approval as it now stands, and the
     * document's refusal if the final approval was refused (the action is committed regardless).
     */
    async act(
      id: bigint,
      kind: ApprovalActionKind,
      body: { step_number?: number; comment?: string; reason?: string },
      actor: { userId: bigint; ipAddress: string | null },
    ): Promise<{ approval: ApprovalOutT; guardFailure: AppError | null }> {
      const out = await decide(
        db,
        engineDeps,
        id,
        {
          action: kind,
          stepNumber: body.step_number ?? null,
          comment: kind === 'reject' ? (body.reason ?? null) : (body.comment ?? null),
          actorId: actor.userId,
          ipAddress: actor.ipAddress,
        },
        // Out of sight is 404 before anything else (P4 §4.3).
        async (tx) => {
          await loadVisible(tx, id, actor.userId);
        },
      );
      const r = await db.approvalRequest.findUniqueOrThrow({ where: { id }, include: requestInclude });
      return {
        approval: await view(db, r, (await access(db, r, actor.userId)).actions),
        guardFailure: out.guardFailure,
      };
    },

    /** The approval history of one document (P4 §6.2 /{docs}/{id}/history): decisions and transitions. */
    async history(documentType: string, documentId: bigint): Promise<z.infer<typeof HistoryOut>[]> {
      const requests = await db.approvalRequest.findMany({
        where: { documentType, documentId },
        include: requestInclude,
      });
      const scope = await currentScope();
      if (requests.some((r) => !scopeReaches(scope, r))) throw Errors.notFound('No such document.');
      const statuses = await db.statusHistory.findMany({
        where: { recordType: documentType, recordId: documentId.toString() },
        include: { changer: { select: { id: true, username: true } } },
        orderBy: { id: 'asc' },
      });
      const rows: z.infer<typeof HistoryOut>[] = [
        ...requests.flatMap((r) =>
          r.actions.map((a) => ({
            kind: 'approval' as const,
            at: a.actedAt.toISOString(),
            user: { id: a.user.id.toString(), username: a.user.username },
            acting_for: ref(a.actingFor),
            action: a.action,
            from_state: null,
            to_state: null,
            step_number: a.stepNumber,
            comment: a.comment,
            approval_id: r.id.toString(),
          })),
        ),
        ...statuses.map((h) => ({
          kind: 'status' as const,
          at: h.changedAt.toISOString(),
          user: ref(h.changer),
          acting_for: null,
          action: 'transition',
          from_state: h.fromState,
          to_state: h.toState,
          step_number: null,
          comment: h.comment,
          approval_id: null,
        })),
      ];
      return rows.sort((a, b) => a.at.localeCompare(b.at));
    },

    /** P7 §11.1: approval authority handed to another user for a bounded period, with a reason. */
    async delegate(body: z.infer<typeof DelegateBody>, actorId: bigint): Promise<DelegationOutT> {
      return withTransaction(db, async (tx) => {
        const problems: ErrorDetail[] = [];
        const bad = (field: string, message: string) =>
          problems.push({ field, code: 'VALIDATION_FAILED', message });
        const from = new Date(body.valid_from);
        const to = new Date(body.valid_to);
        if (body.from_user_id === body.to_user_id) bad('to_user_id', 'A user cannot delegate to themselves.');
        if (to <= from) bad('valid_to', 'Must be after valid_from.');
        else if (to.getTime() - from.getTime() > MAX_DELEGATION_DAYS * 86_400_000) {
          bad('valid_to', `A delegation lasts at most ${String(MAX_DELEGATION_DAYS)} days.`);
        }
        if (to <= new Date()) bad('valid_to', 'Must be in the future.');
        const users = await tx.user.findMany({
          where: { id: { in: [body.from_user_id, body.to_user_id] } },
          select: { id: true, status: true },
        });
        for (const [field, id] of [
          ['from_user_id', body.from_user_id],
          ['to_user_id', body.to_user_id],
        ] as const) {
          const u = users.find((x) => x.id === id);
          if (!u) bad(field, 'No such user.');
          else if (u.status !== 'active') bad(field, 'The user is not active.');
        }
        if (problems.length > 0) throw Errors.validation(problems);

        const overlapping = (fromUserId: bigint, toUserId: bigint) =>
          tx.approvalDelegation.count({
            where: {
              fromUserId,
              toUserId,
              endedAt: null,
              validFrom: { lt: to },
              validTo: { gt: from },
              ...(body.document_type
                ? { OR: [{ documentType: null }, { documentType: body.document_type }] }
                : {}),
            },
          });
        if ((await overlapping(body.from_user_id, body.to_user_id)) > 0) {
          throw new AppError('DUPLICATE_KEY', 'This delegation overlaps one that already exists.', [
            { field: 'valid_from', code: 'DUPLICATE_KEY', message: 'End or wait for the existing one.' },
          ]);
        }
        // The two users would cover for each other at once: nobody would be accountable.
        if ((await overlapping(body.to_user_id, body.from_user_id)) > 0) {
          throw Errors.validation([
            {
              field: 'to_user_id',
              code: 'DELEGATION_CIRCULAR',
              message: 'That user has delegated to this one for the same period.',
            },
          ]);
        }
        const d = await tx.approvalDelegation.create({
          data: {
            fromUserId: body.from_user_id,
            toUserId: body.to_user_id,
            documentType: body.document_type ?? null,
            validFrom: from,
            validTo: to,
            reason: body.reason,
            createdBy: actorId,
          },
          include: { fromUser: true, toUser: true },
        });
        await auditCreate(tx, DELEGATION_AUDIT, d.id, delegationAudit(d), { actorId });
        return delegationOut(d);
      });
    },

    async delegations(q: ListQuery): Promise<{ items: DelegationOutT[]; total: number }> {
      const filter = (field: string) =>
        q.filters
          .filter((f) => f.field === field)
          .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      const user = filter('user_id')[0];
      const active = filter('is_active')[0];
      const now = new Date();
      const where: Prisma.ApprovalDelegationWhereInput = {
        ...(user ? { OR: [{ fromUserId: BigInt(user) }, { toUserId: BigInt(user) }] } : {}),
        ...(active === 'true' ? { endedAt: null, validFrom: { lte: now }, validTo: { gt: now } } : {}),
        ...(active === 'false'
          ? { NOT: { endedAt: null, validFrom: { lte: now }, validTo: { gt: now } } }
          : {}),
      };
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      const [rows, total] = await Promise.all([
        db.approvalDelegation.findMany({
          where,
          include: { fromUser: true, toUser: true },
          orderBy: [{ validFrom: 'desc' }, { id: 'desc' }],
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        db.approvalDelegation.count({ where }),
      ]);
      return { items: rows.map(delegationOut), total };
    },

    /** Ends a delegation now. It never applies again; the record stays. */
    async endDelegation(id: bigint, actorId: bigint): Promise<DelegationOutT> {
      return withTransaction(db, async (tx) => {
        const before = await tx.approvalDelegation.findUnique({ where: { id } });
        if (!before) throw Errors.notFound('No such delegation.');
        const now = new Date();
        if (before.endedAt !== null || before.validTo <= now) {
          throw new AppError('INVALID_TRANSITION', 'This delegation has already ended.', [
            { code: 'INVALID_TRANSITION', message: 'Nothing to end.' },
          ]);
        }
        const after = await tx.approvalDelegation.update({
          where: { id },
          data: { endedAt: now, version: { increment: 1 }, updatedAt: now, updatedBy: actorId },
          include: { fromUser: true, toUser: true },
        });
        await auditUpdate(tx, DELEGATION_AUDIT, id, delegationAudit(before), delegationAudit(after), {
          actorId,
        });
        return delegationOut(after);
      });
    },

    viewPermission,
  };
}

export type ApprovalsService = ReturnType<typeof approvalsService>;
