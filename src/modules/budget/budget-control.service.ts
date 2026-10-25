import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditAction,
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import type { ApprovalAdapter } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import type { ControlMode } from '../../core/budget/budget.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec } from '../../core/money/decimal.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { todayIn } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idOut, iso, versionConflict } from '../organisation/common.js';
import type { ControlOutT, CreateControlBody, PatchControlBody } from './budget.schema.js';

/**
 * Budget controls (P3.06; Spec P3 §26.6, P7 §9.3; D-3.06-9, D-3.06-10): how hard a head is controlled.
 * Policy with approval: draft → submitted (the `budget_control` workflow; is_relaxation when the mode is
 * lowered or a threshold or tolerance raised against the control it revises) → active. One active per
 * (head, estate, fiscal year); changed by revision, which supersedes the active one on approval.
 */

export const CONTROL_DOCUMENT = 'budget_control';
export const CONTROL_AUDIT: AuditedRecord = {
  type: CONTROL_DOCUMENT,
  class: 'policy',
  fields: [
    'budget_head',
    'estate',
    'fiscal_year',
    'control_mode',
    'warning_threshold_percentage',
    'critical_threshold_percentage',
    'overrun_tolerance_percentage',
    'escalation_role',
    'state',
  ],
};
const MODE_RANK: Record<ControlMode, number> = { none: 0, warn: 1, require_approval: 2, block: 3 };

const idf = (v: unknown) => BigInt(String(v));
export const CONTROL_LIST_FIELDS: ListFieldMap = {
  budget_head_id: { field: 'budgetHeadId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  fiscal_year_id: { field: 'fiscalYearId', convert: idf },
  control_mode: { field: 'controlMode' },
  state: { field: 'state' },
};

const named = { select: { id: true, code: true, name: true } } as const;
const include = {
  budgetHead: named,
  estate: named,
  fiscalYear: { select: { id: true, code: true } },
  escalationRole: named,
} as const;
type Row = Prisma.BudgetControlGetPayload<{ include: typeof include }>;

const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const pct = (v: { toFixed(n: number): string } | null) => (v === null ? null : v.toFixed(4));
const ref = (r: { id: bigint; code: string; name: string } | null) =>
  r ? { id: r.id.toString(), code: r.code, name: r.name } : null;

export function controlOut(r: Row, approvalId: bigint | null): ControlOutT {
  return {
    id: r.id.toString(),
    budget_head: ref(r.budgetHead),
    estate: ref(r.estate),
    fiscal_year: r.fiscalYear ? { id: r.fiscalYear.id.toString(), code: r.fiscalYear.code } : null,
    control_mode: r.controlMode as ControlMode,
    warning_threshold_percentage: pct(r.warningThresholdPercentage),
    critical_threshold_percentage: pct(r.criticalThresholdPercentage),
    overrun_tolerance_percentage: pct(r.overrunTolerancePercentage),
    escalation_role: ref(r.escalationRole),
    supersedes_id: idOut(r.supersedesId),
    state: r.state as ControlOutT['state'],
    approval_id: idOut(approvalId),
    submitted_at: iso(r.submittedAt),
    approved_at: iso(r.approvedAt),
    rejection_reason: r.rejectionReason,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: iso(r.updatedAt),
  };
}

/** A relaxation: the mode lowered, or a threshold or the tolerance raised (D-3.06-10). */
export function isRelaxation(
  next: { controlMode: string; warning: string | null; critical: string | null; tolerance: string | null },
  prior: {
    controlMode: string;
    warning: string | null;
    critical: string | null;
    tolerance: string | null;
  } | null,
): boolean {
  const base = prior ?? { controlMode: 'warn', warning: null, critical: null, tolerance: null };
  if (MODE_RANK[next.controlMode as ControlMode] < MODE_RANK[base.controlMode as ControlMode]) return true;
  const raised = (a: string | null, b: string | null) =>
    a === null ? b !== null : b !== null && dec(a).greaterThan(b);
  // No tolerance is a tolerance of 0; no threshold means no alert, so removing one relaxes.
  const tolerance = dec(next.tolerance ?? '0').greaterThan(base.tolerance ?? '0');
  return raised(next.warning, base.warning) || raised(next.critical, base.critical) || tolerance;
}

export interface ControlServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function budgetControlService({ db, accessLog, timezone }: ControlServiceDeps) {
  async function visible(): Promise<Prisma.BudgetControlWhereInput> {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return {};
    return {
      OR: [
        { estateId: null },
        ...(scope.estates.length > 0 ? [{ estateId: { in: [...scope.estates] } }] : []),
      ],
    };
  }
  async function assertWritable(estateId: bigint | null, id: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return;
    if (estateId === null || !scope.estates.includes(estateId))
      await denyWrite(accessLog, CONTROL_DOCUMENT, id, operation);
  }
  async function approvalId(tx: Database | Tx, r: { id: bigint; state: string }) {
    if (r.state !== 'submitted') return null;
    return (
      (
        await tx.approvalRequest.findFirst({
          where: { documentType: CONTROL_DOCUMENT, documentId: r.id, state: 'pending' },
          select: { id: true },
        })
      )?.id ?? null
    );
  }
  async function out(tx: Database | Tx, r: Row) {
    return controlOut(r, await approvalId(tx, r));
  }
  const auditValues = (c: ControlOutT) => ({
    budget_head: c.budget_head?.code ?? null,
    estate: c.estate?.code ?? null,
    fiscal_year: c.fiscal_year?.code ?? null,
    control_mode: c.control_mode,
    warning_threshold_percentage: c.warning_threshold_percentage,
    critical_threshold_percentage: c.critical_threshold_percentage,
    overrun_tolerance_percentage: c.overrun_tolerance_percentage,
    escalation_role: c.escalation_role?.code ?? null,
    state: c.state,
  });
  async function orNotFound(tx: Database | Tx, id: bigint): Promise<Row> {
    const r = await tx.budgetControl.findFirst({ where: { AND: [{ id }, await visible()] }, include });
    if (!r) throw Errors.notFound('The budget control was not found.');
    return r;
  }

  async function check(
    tx: Tx,
    c: {
      budgetHeadId: bigint | null;
      estateId: bigint | null;
      fiscalYearId: bigint | null;
      controlMode: string;
      warning: string | null;
      critical: string | null;
      escalationRoleId: bigint | null;
    },
  ) {
    const details: ErrorDetail[] = [];
    if (c.budgetHeadId !== null) {
      const h = await tx.budgetHead.findUnique({ where: { id: c.budgetHeadId }, select: { status: true } });
      if (h?.status !== 'active')
        details.push({
          field: 'budget_head_id',
          code: 'VALIDATION_FAILED',
          message: 'The budget head is not active.',
        });
    }
    if (c.estateId !== null) {
      const e = await tx.estate.findUnique({ where: { id: c.estateId }, select: { status: true } });
      if (e?.status !== 'active')
        details.push({ field: 'estate_id', code: 'VALIDATION_FAILED', message: 'The estate is not active.' });
    }
    if (
      c.fiscalYearId !== null &&
      !(await tx.fiscalYear.findUnique({ where: { id: c.fiscalYearId }, select: { id: true } }))
    )
      details.push({
        field: 'fiscal_year_id',
        code: 'VALIDATION_FAILED',
        message: 'The fiscal year does not exist.',
      });
    if (c.warning !== null && c.critical !== null && dec(c.critical).lessThan(c.warning))
      details.push({
        field: 'critical_threshold_percentage',
        code: 'VALIDATION_FAILED',
        message: 'The critical threshold is at or above the warning threshold.',
      });
    if (c.controlMode === 'require_approval' && c.escalationRoleId === null)
      details.push({
        field: 'escalation_role_id',
        code: 'VALIDATION_FAILED',
        message: 'require_approval names the role that approves an overrun.',
      });
    if (c.escalationRoleId !== null) {
      const r = await tx.role.findUnique({ where: { id: c.escalationRoleId }, select: { status: true } });
      if (r?.status !== 'active')
        details.push({
          field: 'escalation_role_id',
          code: 'VALIDATION_FAILED',
          message: 'The role is not active.',
        });
    }
    if (details.length > 0)
      throw new AppError('VALIDATION_FAILED', details[0]?.message ?? 'Invalid.', details);
  }

  const adapter: ApprovalAdapter = {
    documentType: CONTROL_DOCUMENT,
    async describe(tx, id) {
      const r = await tx.budgetControl.findUniqueOrThrow({ where: { id }, include });
      const prior = r.supersedesId
        ? await tx.budgetControl.findUnique({ where: { id: r.supersedesId } })
        : await tx.budgetControl.findFirst({
            where: {
              state: 'active',
              budgetHeadId: r.budgetHeadId,
              estateId: r.estateId,
              fiscalYearId: r.fiscalYearId,
            },
          });
      const view = (x: typeof prior) =>
        x
          ? {
              controlMode: x.controlMode,
              warning: pct(x.warningThresholdPercentage),
              critical: pct(x.criticalThresholdPercentage),
              tolerance: pct(x.overrunTolerancePercentage),
            }
          : null;
      const self = view(r);
      return {
        id,
        number: null,
        label: `Budget control: ${r.budgetHead?.name ?? 'organisation default'}${r.estate ? ` · ${r.estate.name}` : ''}${r.fiscalYear ? ` · ${r.fiscalYear.code}` : ''} → ${r.controlMode}`,
        createdBy: r.createdBy,
        estateId: r.estateId,
        values: { is_relaxation: self && isRelaxation(self, view(prior)) ? 'true' : 'false' },
      };
    },
    async onApproved(tx, id, ctx) {
      await lockRowsForUpdate(tx, 'budget_control', { id });
      const r = await tx.budgetControl.findUniqueOrThrow({ where: { id } });
      if (r.state !== 'submitted')
        throw transition(`A ${r.state} control cannot be approved.`, r.state, 'Reload it.');
      const now = new Date();
      // The control it replaces: the one it revises, or the active one at the same scope.
      const prior = await tx.budgetControl.findFirst({
        where: r.supersedesId
          ? { id: r.supersedesId, state: 'active' }
          : {
              state: 'active',
              budgetHeadId: r.budgetHeadId,
              estateId: r.estateId,
              fiscalYearId: r.fiscalYearId,
            },
      });
      if (prior) {
        await tx.budgetControl.update({
          where: { id: prior.id },
          data: { state: 'superseded', stateChangedAt: now, ...stamp(ctx.actorId) },
        });
        await recordStatusChange(tx, CONTROL_AUDIT.type, prior.id, 'active', 'superseded', {
          actorId: ctx.actorId,
        });
      }
      await tx.budgetControl.update({
        where: { id },
        data: {
          state: 'active',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, CONTROL_AUDIT, id, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, CONTROL_AUDIT.type, id, 'submitted', 'active', { actorId: ctx.actorId });
    },
    async onRejected(tx, id, ctx) {
      const now = new Date();
      await tx.budgetControl.update({
        where: { id },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, CONTROL_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, CONTROL_AUDIT.type, id, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      await tx.budgetControl.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, CONTROL_AUDIT.type, id, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  return {
    adapter,

    async list(q: ListQuery) {
      const where: Prisma.BudgetControlWhereInput = {
        AND: [toWhere(q, CONTROL_LIST_FIELDS), await visible()],
      };
      const [rows, total] = await Promise.all([
        db.budgetControl.findMany({
          where,
          include,
          orderBy: [...toOrderBy(q.sort, CONTROL_LIST_FIELDS), { id: 'desc' }],
          ...toPaging(q),
        }),
        db.budgetControl.count({ where }),
      ]);
      const items: ControlOutT[] = [];
      for (const r of rows) items.push(await out(db, r));
      return { items, total };
    },

    async get(id: bigint) {
      return out(db, await orNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateControlBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estateId = b.estate_id ?? null;
        await assertWritable(estateId, null, 'create');
        const data = {
          budgetHeadId: b.budget_head_id ?? null,
          estateId,
          fiscalYearId: b.fiscal_year_id ?? null,
          controlMode: b.control_mode,
          warningThresholdPercentage: b.warning_threshold_percentage?.toFixed(4) ?? null,
          criticalThresholdPercentage: b.critical_threshold_percentage?.toFixed(4) ?? null,
          overrunTolerancePercentage: b.overrun_tolerance_percentage?.toFixed(4) ?? null,
          escalationRoleId: b.escalation_role_id ?? null,
        };
        await check(tx, {
          ...data,
          warning: data.warningThresholdPercentage,
          critical: data.criticalThresholdPercentage,
        });
        const r = await tx.budgetControl.create({
          data: { ...data, stateChangedAt: new Date(), createdBy: actorId },
          include,
        });
        const o = await out(tx, r);
        await auditCreate(tx, CONTROL_AUDIT, r.id, auditValues(o), { actorId });
        await recordStatusChange(tx, CONTROL_AUDIT.type, r.id, null, 'draft', { actorId });
        return o;
      });
    },

    async update(id: bigint, version: number, b: z.infer<typeof PatchControlBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget_control', { id });
        const before = await orNotFound(tx, id);
        const old = await out(tx, before);
        if (before.version !== version) versionConflict(before, old);
        await assertWritable(before.estateId, id, 'edit');
        if (before.state !== 'draft')
          throw transition(
            `A ${before.state} control cannot be changed.`,
            before.state,
            'Revise it instead (POST /revise).',
          );
        if (
          before.supersedesId !== null &&
          (b.budget_head_id !== undefined || b.estate_id !== undefined || b.fiscal_year_id !== undefined)
        )
          throw new AppError('VALIDATION_FAILED', 'A revision keeps the scope of the control it revises.');
        const pick = <T>(v: T | undefined, cur: T) => v ?? cur;
        const data = {
          budgetHeadId: pick(b.budget_head_id, before.budgetHeadId),
          estateId: pick(b.estate_id, before.estateId),
          fiscalYearId: pick(b.fiscal_year_id, before.fiscalYearId),
          controlMode: pick(b.control_mode, before.controlMode),
          warningThresholdPercentage:
            b.warning_threshold_percentage === undefined
              ? pct(before.warningThresholdPercentage)
              : (b.warning_threshold_percentage?.toFixed(4) ?? null),
          criticalThresholdPercentage:
            b.critical_threshold_percentage === undefined
              ? pct(before.criticalThresholdPercentage)
              : (b.critical_threshold_percentage?.toFixed(4) ?? null),
          overrunTolerancePercentage:
            b.overrun_tolerance_percentage === undefined
              ? pct(before.overrunTolerancePercentage)
              : (b.overrun_tolerance_percentage?.toFixed(4) ?? null),
          escalationRoleId: pick(b.escalation_role_id, before.escalationRoleId),
        };
        if (data.estateId !== before.estateId) await assertWritable(data.estateId, id, 'edit');
        await check(tx, {
          ...data,
          warning: data.warningThresholdPercentage,
          critical: data.criticalThresholdPercentage,
        });
        await tx.budgetControl.update({ where: { id }, data: { ...data, ...stamp(actorId) } });
        const after = await out(tx, await orNotFound(tx, id));
        await auditUpdate(tx, CONTROL_AUDIT, id, auditValues(old), auditValues(after), { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget_control', { id });
        const r = await orNotFound(tx, id);
        await assertWritable(r.estateId, id, 'delete');
        if (r.state !== 'draft')
          throw transition(`A ${r.state} control cannot be deleted.`, r.state, 'Only a draft is deleted.');
        const o = await out(tx, r);
        await tx.budgetControl.delete({ where: { id } });
        await auditDelete(tx, CONTROL_AUDIT, id, auditValues(o), { actorId });
      });
    },

    async submit(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget_control', { id });
        const r = await orNotFound(tx, id);
        if (r.version !== version) versionConflict(r, await out(tx, r));
        await assertWritable(r.estateId, id, 'submit');
        if (r.state !== 'draft')
          throw transition(
            `A ${r.state} control cannot be submitted.`,
            r.state,
            'Only a draft is submitted.',
          );
        const now = new Date();
        await tx.budgetControl.update({
          where: { id },
          data: {
            state: 'submitted',
            stateChangedAt: now,
            submittedAt: now,
            submittedBy: actorId,
            ...stamp(actorId),
          },
        });
        await recordStatusChange(tx, CONTROL_AUDIT.type, id, 'draft', 'submitted', { actorId });
        await submitForApproval(tx, { timezone }, CONTROL_DOCUMENT, id, { actorId, date: todayIn(timezone) });
        return out(tx, await orNotFound(tx, id));
      });
    },

    /** A draft copy of an active control; approving it supersedes the original. */
    async revise(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget_control', { id });
        const r = await orNotFound(tx, id);
        if (r.version !== version) versionConflict(r, await out(tx, r));
        await assertWritable(r.estateId, id, 'revise');
        if (r.state !== 'active')
          throw transition(
            `A ${r.state} control cannot be revised.`,
            r.state,
            'Only an active control is revised.',
          );
        const open = await tx.budgetControl.findFirst({
          where: { supersedesId: id, state: { in: ['draft', 'submitted'] } },
          select: { id: true },
        });
        if (open)
          throw transition(
            'A revision of this control is already open.',
            r.state,
            'Finish or delete it first.',
          );
        {
          const copy = await tx.budgetControl.create({
            data: {
              budgetHeadId: r.budgetHeadId,
              estateId: r.estateId,
              fiscalYearId: r.fiscalYearId,
              controlMode: r.controlMode,
              warningThresholdPercentage: r.warningThresholdPercentage,
              criticalThresholdPercentage: r.criticalThresholdPercentage,
              overrunTolerancePercentage: r.overrunTolerancePercentage,
              escalationRoleId: r.escalationRoleId,
              supersedesId: id,
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
            include,
          });
          const o = await out(tx, copy);
          await auditCreate(tx, CONTROL_AUDIT, copy.id, auditValues(o), { actorId });
          await recordStatusChange(tx, CONTROL_AUDIT.type, copy.id, null, 'draft', { actorId });
          return o;
        }
      });
    },
  };
}
