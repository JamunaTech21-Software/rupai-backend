import { ulid } from 'ulid';

import { Prisma } from '../../generated/prisma/client.js';
import { constraintViolation } from '../db/errors.js';
import type { Database } from '../db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../db/transaction.js';
import { AppError, Errors } from '../errors/app-error.js';
import { todayIn, type BusinessDate } from '../time/dates.js';
import { approvalAdapter, type ApprovalContext } from './adapters.js';
import { isApprover, resolveApprovers, type DocumentPlace } from './approvers.js';
import type { Condition } from './conditions.js';
import { pathFor, type ApproverRule } from './definition.js';
import { approvableDocument, NEVER_SELF_APPROVE, type ApprovableDocument } from './document-types.js';
import { selectWorkflow } from './select.js';

/**
 * The approval engine at runtime (Spec P7 §3.3, §4, §10–§14; P1 §11).
 *
 *   submit    the workflow is selected ONCE, on the submission date; the steps whose condition holds are
 *             the document's path, frozen on the request. No workflow: approved on submission.
 *   approve   completes the current step; the last one signals the document, which runs its own guards.
 *             A guard failure is the document's refusal: its effects are rolled back with their
 *             transaction, and a second transaction records the approval action and the refusal, so the
 *             action stays recorded and the document stays Submitted (P7 §2.2). `decide` does both.
 *   reject    ends the workflow; a reason is required.
 *   return    back to draft with a comment; resubmission starts a NEW request from step one.
 *   comment   a remark, deciding nothing.
 *
 * Who may act (P7 §4, §11, §12): a user the current step resolves to, within the document's scope, or a
 * delegate acting for one (one hop only). Nobody acts on a document they created or submitted unless the
 * step allows it and the document type ever permits it. The actor must also hold the document type's
 * approve permission: delegation transfers authority, never a permission.
 *
 * Race safety (P7 §17): the request row is locked, and the caller names the step it is acting on. Of two
 * approvers acting at once, one advances the step; the other is told it has moved on.
 */

export const ACTIONS = ['approve', 'reject', 'return', 'comment'] as const;
export type ApprovalActionKind = (typeof ACTIONS)[number];
export type RequestState = 'pending' | 'approved' | 'rejected' | 'returned';

/** P7 §13.2: bulk approval exists for these alone, and never for a financial document. */
export const BULK_APPROVABLE: ReadonlySet<string> = new Set(['attendance', 'plucking', 'labour_allocation']);

export interface PathEntry {
  readonly step_id: string;
  readonly step_number: number;
}

export interface EngineDeps {
  readonly timezone: string;
  /** Whether the ACTING user holds a permission (the request's resolver, or a fixed set in tests). */
  readonly can: (permission: string) => Promise<boolean>;
  /** The permission catalogue: a `{module}.reject` that does not exist falls back to approve. */
  readonly knownPermissions: ReadonlySet<string>;
}

export interface ActorInput {
  readonly actorId: bigint;
  readonly ipAddress?: string | null;
}

const stepSelect = {
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
} satisfies Prisma.WorkflowStepSelect;
type StepRow = Prisma.WorkflowStepGetPayload<{ select: typeof stepSelect }>;

export const readPath = (raw: unknown): PathEntry[] => {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(parsed) ? (parsed as PathEntry[]) : [];
};

const placeOf = (r: {
  estateId: bigint | null;
  factoryId: bigint | null;
  warehouseId: bigint | null;
}): DocumentPlace => ({ estateId: r.estateId, factoryId: r.factoryId, warehouseId: r.warehouseId });

function documentTypeOf(key: string): ApprovableDocument {
  const d = approvableDocument(key);
  if (!d) throw new Error(`${key} is not an approvable document type`);
  return d;
}

/** The permission each action needs on the document type (P4 §6.2). */
export function permissionFor(
  document: ApprovableDocument,
  action: ApprovalActionKind,
  known: ReadonlySet<string>,
) {
  const approve = document.approvePermission ?? `${document.module}.approve`;
  if (action === 'reject') {
    const reject = `${document.module}.reject`;
    return known.has(reject) ? reject : approve;
  }
  return approve;
}

async function unresolved(tx: Tx, document: ApprovableDocument, step: StepRow, place: DocumentPlace) {
  const r = await resolveApprovers(
    tx,
    document,
    { approverRule: step.approverRule as ApproverRule, roleId: step.roleId, userId: step.userId },
    place,
  );
  // A reporting-line or cost-centre step cannot be resolved until those tables exist (Phase 2, 3).
  return r.users.length === 0;
}

export interface SubmitResult {
  /** pending: awaiting its first approver. approved: no workflow applies, so it was approved at once. */
  readonly outcome: 'pending' | 'approved';
  readonly requestId: bigint | null;
}

/**
 * Starts the approval of a document, in the module's own transaction (its submit endpoint has already
 * moved the document to Submitted).
 * @throws RULE_AMBIGUOUS (two workflows at the same specificity), INVALID_TRANSITION (already pending).
 */
export async function submitForApproval(
  tx: Tx,
  deps: Pick<EngineDeps, 'timezone'>,
  documentType: string,
  documentId: bigint,
  actor: ActorInput & { readonly date?: BusinessDate },
): Promise<SubmitResult> {
  const document = documentTypeOf(documentType);
  const adapter = approvalAdapter(documentType);
  const doc = await adapter.describe(tx, documentId);
  const date = actor.date ?? todayIn(deps.timezone);
  const workflow = await selectWorkflow(
    tx,
    documentType,
    { estateId: doc.estateId ?? null, departmentId: doc.departmentId ?? null },
    date,
    doc.values,
  );
  if (!workflow) {
    // P7 §3.2: no workflow means no approval is required. A deliberate configuration.
    await adapter.onApproved(tx, documentId, {
      requestId: null,
      actorId: actor.actorId,
      actingForUserId: null,
    });
    return { outcome: 'approved', requestId: null };
  }

  const steps = await tx.workflowStep.findMany({
    where: { workflowId: workflow.id },
    select: stepSelect,
    orderBy: { stepNumber: 'asc' },
  });
  const indexes = pathFor(
    steps.map((s) => ({
      condition:
        s.conditionField && s.conditionOperator
          ? ({
              field: s.conditionField,
              operator: s.conditionOperator,
              value: (s.conditionValue ?? null) as Condition['value'],
            } as Condition)
          : null,
    })),
    doc.values,
  );
  const path: PathEntry[] = indexes.flatMap((i) => {
    const s = steps[i];
    return s ? [{ step_id: s.id.toString(), step_number: s.stepNumber }] : [];
  });
  const first = steps[indexes[0] ?? -1];
  // Refused at definition time (P7 §15.2 check 2), so only a corrupted workflow gets here.
  if (!first) throw new Error(`workflow ${workflow.id.toString()} produced an empty path`);

  const place: DocumentPlace = {
    estateId: doc.estateId ?? null,
    factoryId: doc.factoryId ?? null,
    warehouseId: doc.warehouseId ?? null,
  };
  const now = new Date();
  try {
    const request = await tx.approvalRequest.create({
      data: {
        documentType,
        documentId,
        workflowId: workflow.id,
        path: path as unknown as Prisma.InputJsonValue,
        currentStepNumber: first.stepNumber,
        currentStepId: first.id,
        stepStartedAt: now,
        isUnresolved: await unresolved(tx, document, first, place),
        isExceptional: doc.isExceptional ?? false,
        submittedAt: now,
        submittedBy: actor.actorId,
        documentCreatedBy: doc.createdBy,
        estateId: place.estateId ?? null,
        factoryId: place.factoryId ?? null,
        warehouseId: place.warehouseId ?? null,
        departmentId: doc.departmentId ?? null,
        documentNumber: doc.number,
        documentLabel: doc.label.slice(0, 200),
        summaryAmount: doc.amount ?? null,
        summaryQuantity: doc.quantity ?? null,
      },
      select: { id: true },
    });
    return { outcome: 'pending', requestId: request.id };
  } catch (err) {
    if (constraintViolation(err)?.kind === 'unique') {
      throw new AppError('INVALID_TRANSITION', 'This document is already awaiting approval.', [
        { code: 'INVALID_TRANSITION', message: 'Act on its pending approval instead.' },
      ]);
    }
    throw err;
  }
}

export interface Eligibility {
  /** Set when the actor acts under a delegation: the user they act for. */
  readonly actingForUserId: bigint | null;
}

/**
 * Whether a user may act on the current step: as one of its approvers, or as the delegate of one (P7
 * §11.1). One hop only: the delegator must be an approver in their own right.
 */
export async function eligibility(
  tx: Database | Tx,
  document: ApprovableDocument,
  step: StepRow,
  place: DocumentPlace,
  userId: bigint,
  documentType: string,
): Promise<Eligibility | null> {
  const rule = { approverRule: step.approverRule as ApproverRule, roleId: step.roleId, userId: step.userId };
  if (await isApprover(tx, document, rule, place, userId)) return { actingForUserId: null };
  const now = new Date();
  const delegations = await tx.approvalDelegation.findMany({
    where: {
      toUserId: userId,
      validFrom: { lte: now },
      validTo: { gt: now },
      endedAt: null,
      OR: [{ documentType: null }, { documentType }],
    },
    select: { fromUserId: true },
    orderBy: { id: 'asc' },
  });
  for (const d of delegations) {
    if (await isApprover(tx, document, rule, place, d.fromUserId)) return { actingForUserId: d.fromUserId };
  }
  return null;
}

export interface ActInput extends ActorInput {
  readonly action: ApprovalActionKind;
  /** The step the actor saw. Required for every decision; a comment may omit it. */
  readonly stepNumber?: number | null;
  readonly comment?: string | null;
  readonly bulkReference?: string | null;
}

export interface ActResult {
  readonly state: RequestState;
  /** The document refused its final approval: the action is recorded, the document is still Submitted. */
  readonly guardFailure: AppError | null;
}

/** Thrown by `act` when the document refuses its final approval; `decide` turns it into a record. */
export class GuardRefusal extends Error {
  constructor(readonly refusal: AppError) {
    super(refusal.message);
    this.name = 'GuardRefusal';
  }
}

const notPending = (state: string) =>
  new AppError('INVALID_TRANSITION', `This approval is ${state}.`, [
    { code: 'INVALID_TRANSITION', message: 'Nothing is awaiting a decision.', context: { state } },
  ]);

/**
 * An action on a pending request, in the caller's transaction. A refusal by the document at final
 * approval is thrown as GuardRefusal: use `decide`, which records it.
 */
export async function act(tx: Tx, deps: EngineDeps, requestId: bigint, input: ActInput): Promise<ActResult> {
  await lockRowsForUpdate(tx, 'approval_request', { id: requestId });
  const request = await tx.approvalRequest.findUnique({
    where: { id: requestId },
    include: { currentStep: { select: stepSelect } },
  });
  if (!request) throw Errors.notFound('No such approval.');
  const document = documentTypeOf(request.documentType);
  const step = request.currentStep;
  if (request.state !== 'pending' || !step) throw notPending(request.state);
  const decision = input.action !== 'comment';
  if (decision && input.stepNumber !== step.stepNumber) {
    const last = await tx.approvalAction.findFirst({
      where: { approvalRequestId: requestId, action: { not: 'comment' } },
      orderBy: { id: 'desc' },
      select: { stepNumber: true, user: { select: { username: true } } },
    });
    throw new AppError(
      'APPROVAL_STEP_CHANGED',
      `Step ${String(input.stepNumber ?? '?')} has already been decided${last ? ` by ${last.user.username}` : ''}. Reload to see where this approval stands.`,
      [
        {
          code: 'APPROVAL_STEP_CHANGED',
          message: 'The approval has moved on since you opened it.',
          context: { current_step_number: step.stepNumber, decided_by: last?.user.username ?? null },
        },
      ],
    );
  }
  const comment = input.comment?.trim() ?? '';
  if (
    (input.action === 'reject' || input.action === 'return' || input.action === 'comment') &&
    comment === ''
  ) {
    const field = input.action === 'reject' ? 'reason' : 'comment';
    throw Errors.validation([
      {
        field,
        code: 'VALIDATION_FAILED',
        message:
          input.action === 'reject'
            ? 'Say why it is rejected.'
            : input.action === 'return'
              ? 'Say what needs correcting.'
              : 'Write the comment.',
      },
    ]);
  }

  const place = placeOf(request);
  const involved = (id: bigint | null) =>
    id !== null && (id === request.submittedBy || id === request.documentCreatedBy);
  const elig = await eligibility(tx, document, step, place, input.actorId, request.documentType);
  if (decision || !involved(input.actorId)) {
    if (!elig) {
      throw new AppError('NOT_AN_APPROVER', 'You are not an approver of this step.', [
        {
          code: 'NOT_AN_APPROVER',
          message: 'Only the users this step resolves to, or their delegates, may act on it.',
          context: { step_number: step.stepNumber },
        },
      ]);
    }
    const permission = permissionFor(document, input.action, deps.knownPermissions);
    if (!(await deps.can(permission))) {
      throw new AppError('PERMISSION_DENIED', 'You do not have permission to do this.', [
        { code: 'PERMISSION_DENIED', message: `Requires ${permission}.`, context: { permission } },
      ]);
    }
  }
  const actingFor = elig?.actingForUserId ?? null;
  const self = decision && (involved(input.actorId) || involved(actingFor));
  if (self && !(step.allowSelfApproval && !NEVER_SELF_APPROVE.has(document.approvalClass))) {
    throw new AppError(
      'SELF_APPROVAL_FORBIDDEN',
      'You cannot decide on a document you created or submitted.',
      [{ code: 'SELF_APPROVAL_FORBIDDEN', message: 'Another approver must act on it.' }],
    );
  }

  await tx.approvalAction.create({
    data: {
      approvalRequestId: requestId,
      workflowStepId: step.id,
      stepNumber: step.stepNumber,
      userId: input.actorId,
      actingForUserId: actingFor,
      action: input.action,
      comment: comment === '' ? null : comment.slice(0, 1000),
      ipAddress: input.ipAddress?.slice(0, 45) ?? null,
      isSelfApproval: self,
      bulkReference: input.bulkReference ?? null,
    },
  });
  if (input.action === 'comment') return { state: 'pending', guardFailure: null };

  const adapter = approvalAdapter(request.documentType);
  const ctx: ApprovalContext = { requestId, actorId: input.actorId, actingForUserId: actingFor };
  const now = new Date();
  const finish = (state: Exclude<RequestState, 'pending'>) =>
    tx.approvalRequest.update({
      where: { id: requestId },
      data: {
        state,
        finalOutcome: state,
        completedAt: now,
        currentStepId: null,
        currentStepNumber: null,
        isUnresolved: false,
        ...(state === 'approved' ? { guardFailure: Prisma.DbNull } : {}),
        version: { increment: 1 },
        updatedAt: now,
      },
    });

  if (input.action === 'reject') {
    await finish('rejected');
    await adapter.onRejected(tx, request.documentId, { ...ctx, reason: comment });
    return { state: 'rejected', guardFailure: null };
  }
  if (input.action === 'return') {
    await finish('returned');
    await adapter.onReturned(tx, request.documentId, { ...ctx, comment });
    return { state: 'returned', guardFailure: null };
  }

  const path = readPath(request.path);
  const at = path.findIndex((p) => p.step_number === step.stepNumber);
  const next = path[at + 1];
  if (next) {
    const nextStep = await tx.workflowStep.findUniqueOrThrow({
      where: { id: BigInt(next.step_id) },
      select: stepSelect,
    });
    await tx.approvalRequest.update({
      where: { id: requestId },
      data: {
        currentStepId: nextStep.id,
        currentStepNumber: nextStep.stepNumber,
        stepStartedAt: now,
        isUnresolved: await unresolved(tx, document, nextStep, place),
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    return { state: 'pending', guardFailure: null };
  }

  // Final approval: the document runs its guards and effects. A refusal rolls this transaction back;
  // `decide` then records the approval action and the refusal in a transaction of their own.
  try {
    await adapter.onApproved(tx, request.documentId, ctx);
  } catch (err) {
    if (err instanceof AppError) throw new GuardRefusal(err);
    throw err;
  }
  await finish('approved');
  return { state: 'approved', guardFailure: null };
}

/**
 * An action, with the guard rule of P7 §2.2 applied: if the document refuses its final approval, its
 * effects are rolled back and, in a second transaction, the approval action is recorded and the refusal
 * kept on the request. The step is re-checked under the lock first: if anything moved in between, the
 * refusal is not recorded and the caller is told the step changed.
 */
export async function decide(
  db: Database,
  deps: EngineDeps,
  requestId: bigint,
  input: ActInput,
  within?: (tx: Tx) => Promise<void>,
): Promise<ActResult> {
  try {
    return await withTransaction(db, async (tx) => {
      await within?.(tx);
      return act(tx, deps, requestId, input);
    });
  } catch (err) {
    if (!(err instanceof GuardRefusal)) throw err;
    await withTransaction(db, async (tx) => {
      await lockRowsForUpdate(tx, 'approval_request', { id: requestId });
      const request = await tx.approvalRequest.findUniqueOrThrow({
        where: { id: requestId },
        include: { currentStep: { select: stepSelect } },
      });
      const step = request.currentStep;
      if (request.state !== 'pending' || !step || step.stepNumber !== input.stepNumber) {
        throw new AppError('APPROVAL_STEP_CHANGED', 'The approval moved on while it was being decided.', [
          { code: 'APPROVAL_STEP_CHANGED', message: 'Reload to see where this approval stands.' },
        ]);
      }
      const document = documentTypeOf(request.documentType);
      const elig = await eligibility(
        tx,
        document,
        step,
        placeOf(request),
        input.actorId,
        request.documentType,
      );
      const involved = (id: bigint | null) =>
        id !== null && (id === request.submittedBy || id === request.documentCreatedBy);
      const now = new Date();
      await tx.approvalAction.create({
        data: {
          approvalRequestId: requestId,
          workflowStepId: step.id,
          stepNumber: step.stepNumber,
          userId: input.actorId,
          actingForUserId: elig?.actingForUserId ?? null,
          action: 'approve',
          comment: input.comment?.trim() ? input.comment.trim().slice(0, 1000) : null,
          ipAddress: input.ipAddress?.slice(0, 45) ?? null,
          isSelfApproval: involved(input.actorId) || involved(elig?.actingForUserId ?? null),
          bulkReference: input.bulkReference ?? null,
        },
      });
      await tx.approvalRequest.update({
        where: { id: requestId },
        data: {
          guardFailure: {
            code: err.refusal.code,
            message: err.refusal.message,
            details: err.refusal.details as unknown as Prisma.InputJsonValue,
            at: now.toISOString(),
            by: input.actorId.toString(),
          },
          version: { increment: 1 },
          updatedAt: now,
        },
      });
    });
    return { state: 'pending', guardFailure: err.refusal };
  }
}

export interface BulkResult {
  readonly bulkReference: string;
  readonly approved: readonly bigint[];
  readonly excluded: readonly { readonly requestId: bigint; readonly reason: string }[];
}

/**
 * Approves many requests of a bulk-approvable type in one go (P7 §13.2). Exceptional records are left
 * out and must be approved one by one. Each approval writes its own approval_action, sharing one bulk
 * reference, so the audit trail is the same as for single approvals. Each runs in its own transaction.
 */
export async function bulkApprove(
  db: Database,
  deps: EngineDeps,
  requestIds: readonly bigint[],
  actor: ActorInput,
): Promise<BulkResult> {
  const bulkReference = `B-${ulid()}`;
  const requests = await db.approvalRequest.findMany({
    where: { id: { in: [...requestIds] } },
    select: { id: true, documentType: true, isExceptional: true, state: true, currentStepNumber: true },
  });
  const byId = new Map(requests.map((r) => [r.id, r]));
  const approved: bigint[] = [];
  const excluded: { requestId: bigint; reason: string }[] = [];
  for (const id of requestIds) {
    const r = byId.get(id);
    if (!r) excluded.push({ requestId: id, reason: 'No such approval.' });
    else if (!BULK_APPROVABLE.has(r.documentType)) {
      excluded.push({ requestId: id, reason: 'This document type is never approved in bulk.' });
    } else if (r.isExceptional) {
      excluded.push({ requestId: id, reason: 'Exceptional: approve it individually.' });
    } else if (r.state !== 'pending') excluded.push({ requestId: id, reason: `It is ${r.state}.` });
    else {
      try {
        // One transaction per record: one refusal never undoes the others.
        const out = await decide(db, deps, id, {
          ...actor,
          action: 'approve',
          stepNumber: r.currentStepNumber,
          bulkReference,
        });
        if (out.guardFailure) excluded.push({ requestId: id, reason: out.guardFailure.message });
        else approved.push(id);
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        excluded.push({ requestId: id, reason: err.message });
      }
    }
  }
  return { bulkReference, approved, excluded };
}
