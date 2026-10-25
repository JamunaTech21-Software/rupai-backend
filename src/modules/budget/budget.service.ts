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
import { available, checkAvailability, utilisation } from '../../core/budget/budget.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { type Dec, dec, splitInstalments, sum, toDecimalString } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb, todayIn } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idOut, iso, versionConflict } from '../organisation/common.js';
import type {
  AvailabilityQuery,
  BudgetLineBody,
  BudgetLineOutT,
  BudgetOutT,
  CreateBudgetBody,
  PatchBudgetBody,
  VsActualOut,
  VsActualQuery,
} from './budget.schema.js';

/**
 * Budgets (P3.06; Spec P3 §26.3–§26.5, P1 §5.22, P7 §9.4, P9 §19.2; D-3.06-1 to D-3.06-8, D-3.06-15).
 *
 *   draft      lines and monthly allocations changed freely (each save checks heads, cost centres, sums)
 *   submitted  through the `budget` workflow (total_amount, is_single_estate)
 *   approved   waiting for release: activation by a holder of budget.approve ("Release Budget")
 *   active     consumed by core/budget; one per (fiscal year, estate, department, type)
 *   superseded replaced by an activated revision, whose lines took over its figures
 *   rejected   final; returned → draft again
 *
 * Immutable once submitted: change is a revision (POST /revise), a new draft copying the lines.
 * Scope: a budget of an estate follows estate scope; an organisation-wide one is seen by every
 * budget.view holder and changed only with all estates.
 */

export const BUDGET_DOCUMENT = 'budget';
export const BUDGET_AUDIT: AuditedRecord = {
  type: BUDGET_DOCUMENT,
  class: 'financial',
  fields: [
    'budget_code',
    'name',
    'budget_type',
    'estate',
    'department',
    'total_amount',
    'line_count',
    'notes',
    'state',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const BUDGET_LIST_FIELDS: ListFieldMap = {
  budget_code: { field: 'budgetCode' },
  fiscal_year_id: { field: 'fiscalYearId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  department_id: { field: 'departmentId', convert: idf },
  budget_type: { field: 'budgetType' },
  state: { field: 'state' },
  name: { field: 'name' },
  revision_number: { field: 'revisionNumber' },
};
export const LINE_LIST_FIELDS: ListFieldMap = {
  budget_id: { field: 'budgetId', convert: idf },
  budget_head_id: { field: 'budgetHeadId', convert: idf },
  cost_centre_id: { field: 'costCentreId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  available_amount: { field: 'availableAmount' },
  utilisation_percentage: { field: 'utilisationPercentage' },
};

const named = { select: { id: true, code: true, name: true } } as const;
const user = { select: { id: true, username: true } } as const;
const budgetInclude = {
  fiscalYear: { select: { id: true, code: true } },
  estate: named,
  department: named,
  supersedes: { select: { id: true, budgetCode: true } },
  revisions: { select: { id: true, budgetCode: true }, orderBy: { id: 'desc' }, take: 1 },
  submitter: user,
  approver: user,
  activator: user,
  _count: { select: { lines: true } },
} as const;
type BudgetRow = Prisma.BudgetGetPayload<{ include: typeof budgetInclude }>;
const lineInclude = {
  budget: { select: { id: true, budgetCode: true, state: true } },
  budgetHead: { select: { id: true, code: true, name: true, headType: true } },
  costCentre: named,
  estate: named,
  allocations: { include: { period: { select: { id: true, name: true } } }, orderBy: { monthNumber: 'asc' } },
} as const;
type LineRow = Prisma.BudgetLineGetPayload<{ include: typeof lineInclude }>;

const money = (v: Dec | { toString(): string }) => toDecimalString(v.toString(), 'money');
const pct = (v: Dec | null) => (v === null ? null : toDecimalString(v.toString(), 'pct'));
const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const invalid = (details: ErrorDetail[]) =>
  new AppError('VALIDATION_FAILED', details[0]?.message ?? 'The budget is invalid.', details);

/** P9 §19.2: variance = annual − actual, labelled, never a bare signed number. */
export function varianceOf(annual: Dec, actual: Dec) {
  const v = annual.minus(actual);
  return {
    amount: money(v.abs()),
    label: v.isZero() ? ('on_budget' as const) : v.isNegative() ? ('overrun' as const) : ('surplus' as const),
  };
}

export function lineOut(l: LineRow): BudgetLineOutT {
  const annual = dec(l.annualAmount.toString());
  const actual = dec(l.actualAmount.toString());
  const committed = dec(l.committedAmount.toString());
  return {
    id: l.id.toString(),
    budget: {
      id: l.budget.id.toString(),
      budget_code: l.budget.budgetCode,
      state: l.budget.state as BudgetLineOutT['budget']['state'],
    },
    budget_head: {
      id: l.budgetHead.id.toString(),
      code: l.budgetHead.code,
      name: l.budgetHead.name,
      head_type: l.budgetHead.headType,
    },
    cost_centre: l.costCentre
      ? { id: l.costCentre.id.toString(), code: l.costCentre.code, name: l.costCentre.name }
      : null,
    estate: l.estate ? { id: l.estate.id.toString(), code: l.estate.code, name: l.estate.name } : null,
    annual_amount: money(annual),
    committed_amount: money(committed),
    actual_amount: money(actual),
    available_amount: money(available(annual, actual, committed)),
    utilisation_percentage: pct(utilisation(annual, actual, committed)),
    variance: varianceOf(annual, actual),
    allocations: l.allocations.map((a) => ({
      month_number: a.monthNumber,
      period: { id: a.period.id.toString(), name: a.period.name },
      amount: money(a.amount),
    })),
    notes: l.notes,
    sequence: l.sequence,
  };
}

export interface BudgetServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function budgetService({ db, accessLog, timezone }: BudgetServiceDeps) {
  const today = () => todayIn(timezone);

  async function visible(): Promise<Prisma.BudgetWhereInput> {
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
      await denyWrite(accessLog, 'budget', id, operation);
  }
  async function assertReadable(estateId: bigint | undefined) {
    if (estateId === undefined) return;
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, 'budget', estateId, 'read');
  }

  async function approvalId(tx: Database | Tx, b: { id: bigint; state: string }) {
    if (b.state !== 'submitted') return null;
    return (
      (
        await tx.approvalRequest.findFirst({
          where: { documentType: BUDGET_DOCUMENT, documentId: b.id, state: 'pending' },
          select: { id: true },
        })
      )?.id ?? null
    );
  }

  async function budgetOut(tx: Database | Tx, b: BudgetRow, withLines: boolean): Promise<BudgetOutT> {
    const lines = await tx.budgetLine.findMany({
      where: { budgetId: b.id },
      include: lineInclude,
      orderBy: { sequence: 'asc' },
    });
    const annual = sum(lines.map((l) => dec(l.annualAmount.toString())));
    const actual = sum(lines.map((l) => dec(l.actualAmount.toString())));
    const committed = sum(lines.map((l) => dec(l.committedAmount.toString())));
    const u = (v: { id: bigint; username: string } | null) =>
      v ? { id: v.id.toString(), username: v.username } : null;
    const revision = b.revisions[0];
    return {
      id: b.id.toString(),
      budget_code: b.budgetCode,
      fiscal_year: { id: b.fiscalYear.id.toString(), code: b.fiscalYear.code },
      estate: b.estate ? { id: b.estate.id.toString(), code: b.estate.code, name: b.estate.name } : null,
      department: b.department
        ? { id: b.department.id.toString(), code: b.department.code, name: b.department.name }
        : null,
      name: b.name,
      budget_type: b.budgetType as BudgetOutT['budget_type'],
      revision_number: b.revisionNumber,
      supersedes: b.supersedes
        ? { id: b.supersedes.id.toString(), budget_code: b.supersedes.budgetCode }
        : null,
      revised_by: revision ? { id: revision.id.toString(), budget_code: revision.budgetCode } : null,
      total_amount: money(b.totalAmount),
      committed_amount: money(committed),
      actual_amount: money(actual),
      available_amount: money(available(annual, actual, committed)),
      utilisation_percentage: pct(utilisation(annual, actual, committed)),
      notes: b.notes,
      state: b.state as BudgetOutT['state'],
      approval_id: idOut(await approvalId(tx, b)),
      submitted_at: iso(b.submittedAt),
      submitted_by: u(b.submitter),
      approved_at: iso(b.approvedAt),
      approved_by: u(b.approver),
      rejection_reason: b.rejectionReason,
      activated_at: iso(b.activatedAt),
      activated_by: u(b.activator),
      line_count: b._count.lines,
      ...(withLines ? { lines: lines.map(lineOut) } : {}),
      version: b.version,
      created_at: b.createdAt.toISOString(),
      updated_at: iso(b.updatedAt),
    };
  }
  const auditValues = (b: BudgetOutT) => ({
    budget_code: b.budget_code,
    name: b.name,
    budget_type: b.budget_type,
    estate: b.estate?.code ?? null,
    department: b.department?.code ?? null,
    total_amount: b.total_amount,
    line_count: b.line_count,
    notes: b.notes,
    state: b.state,
  });

  async function budgetOrNotFound(tx: Database | Tx, id: bigint): Promise<BudgetRow> {
    const b = await tx.budget.findFirst({
      where: { AND: [{ id }, await visible()] },
      include: budgetInclude,
    });
    if (!b) throw Errors.notFound('The budget was not found.');
    return b;
  }

  /** Dimensions: an open or future fiscal year, an active estate, an active department. */
  async function checkHeader(
    tx: Tx,
    h: { fiscalYearId: bigint; estateId: bigint | null; departmentId: bigint | null },
  ) {
    const details: ErrorDetail[] = [];
    const fy = await tx.fiscalYear.findUnique({
      where: { id: h.fiscalYearId },
      select: { id: true, code: true, state: true, startDate: true },
    });
    if (!fy)
      details.push({
        field: 'fiscal_year_id',
        code: 'VALIDATION_FAILED',
        message: 'The fiscal year does not exist.',
      });
    else if (fy.state === 'closed')
      details.push({
        field: 'fiscal_year_id',
        code: 'VALIDATION_FAILED',
        message: `Fiscal year ${fy.code} is closed.`,
      });
    let estateCode: string | null = null;
    if (h.estateId !== null) {
      const e = await tx.estate.findUnique({
        where: { id: h.estateId },
        select: { code: true, status: true },
      });
      if (e?.status !== 'active')
        details.push({ field: 'estate_id', code: 'VALIDATION_FAILED', message: 'The estate is not active.' });
      estateCode = e?.code ?? null;
    }
    if (h.departmentId !== null) {
      const d = await tx.department.findUnique({ where: { id: h.departmentId }, select: { status: true } });
      if (d?.status !== 'active')
        details.push({
          field: 'department_id',
          code: 'VALIDATION_FAILED',
          message: 'The department is not active.',
        });
    }
    if (details.length > 0 || !fy) throw invalid(details);
    return { fy, estateCode };
  }

  /** D-3.06-2, D-3.06-3: heads of the budget's type, cost centres of its estate, 12 months summing up. */
  async function checkLines(
    tx: Tx,
    lines: readonly z.infer<typeof BudgetLineBody>[],
    budgetType: string,
    estateId: bigint | null,
  ) {
    const details: ErrorDetail[] = [];
    const seen = new Set<string>();
    const out: {
      headId: bigint;
      costCentreId: bigint | null;
      annual: Dec;
      months: Dec[];
      notes: string | null;
    }[] = [];
    for (const [i, l] of lines.entries()) {
      const at = `lines[${String(i)}]`;
      const head = await tx.budgetHead.findUnique({
        where: { id: l.budget_head_id },
        select: { status: true, headType: true, code: true },
      });
      const want = budgetType === 'capital' ? 'capital' : 'expense';
      if (head?.status !== 'active')
        details.push({
          field: `${at}.budget_head_id`,
          code: 'VALIDATION_FAILED',
          message: 'The budget head is not active.',
        });
      else if (head.headType !== want)
        details.push({
          field: `${at}.budget_head_id`,
          code: 'VALIDATION_FAILED',
          message: `${head.code} is a ${head.headType} head; a${budgetType === 'operating' ? 'n operating' : ' capital'} budget takes ${want} heads.`,
        });
      const cc = l.cost_centre_id ?? null;
      if (cc !== null) {
        const c = await tx.costCentre.findUnique({
          where: { id: cc },
          select: { status: true, estateId: true },
        });
        if (c?.status !== 'active')
          details.push({
            field: `${at}.cost_centre_id`,
            code: 'VALIDATION_FAILED',
            message: 'The cost centre is not active.',
          });
        else if (c.estateId !== null && c.estateId !== estateId)
          details.push({
            field: `${at}.cost_centre_id`,
            code: 'VALIDATION_FAILED',
            message: 'The cost centre belongs to another estate.',
          });
      }
      const key = `${l.budget_head_id.toString()}:${String(cc)}`;
      if (seen.has(key))
        details.push({
          field: at,
          code: 'VALIDATION_FAILED',
          message: 'Each budget head and cost centre appears once.',
        });
      seen.add(key);
      const annual = dec(l.annual_amount);
      const months = l.allocations ? l.allocations.map((a) => dec(a)) : splitInstalments(annual, 12);
      if (!sum(months).equals(annual)) {
        throw new AppError(
          'ALLOCATION_MISMATCH',
          'The monthly allocation must add up to the annual amount.',
          [
            {
              field: `${at}.allocations`,
              code: 'ALLOCATION_MISMATCH',
              message: `The months add up to ${money(sum(months))}, the annual amount is ${money(annual)}.`,
            },
          ],
        );
      }
      out.push({ headId: l.budget_head_id, costCentreId: cc, annual, months, notes: l.notes ?? null });
    }
    if (details.length > 0) throw invalid(details);
    return out;
  }

  async function writeLines(
    tx: Tx,
    budgetId: bigint,
    fiscalYearId: bigint,
    estateId: bigint | null,
    lines: Awaited<ReturnType<typeof checkLines>>,
    actorId: bigint,
  ) {
    const periods = await tx.accountingPeriod.findMany({
      where: { fiscalYearId, periodNumber: { lte: 12 } },
      orderBy: { periodNumber: 'asc' },
      select: { id: true },
    });
    if (periods.length !== 12 && lines.length > 0)
      throw invalid([
        {
          field: 'fiscal_year_id',
          code: 'VALIDATION_FAILED',
          message: 'The fiscal year needs its 12 monthly periods.',
        },
      ]);
    for (const [i, l] of lines.entries()) {
      const line = await tx.budgetLine.create({
        data: {
          budgetId,
          budgetHeadId: l.headId,
          costCentreId: l.costCentreId,
          estateId,
          annualAmount: l.annual.toFixed(4),
          notes: l.notes,
          sequence: i + 1,
          createdBy: actorId,
        },
        select: { id: true },
      });
      await tx.budgetAllocation.createMany({
        data: l.months.map((amount, m) => ({
          budgetLineId: line.id,
          monthNumber: m + 1,
          accountingPeriodId: periods[m]?.id ?? 0n,
          amount: amount.toFixed(4),
          createdBy: actorId,
        })),
      });
    }
    return sum(lines.map((l) => l.annual));
  }

  /** Creates the monthly position rows of a line from its allocations. */
  async function openPositions(tx: Tx, budgetId: bigint) {
    await tx.$executeRaw`
      INSERT INTO budget_position_summary (budget_line_id, accounting_period_id, allocated_amount, updated_at)
      SELECT a.budget_line_id, a.accounting_period_id, a.amount, UTC_TIMESTAMP()
        FROM budget_allocation a JOIN budget_line l ON l.id = a.budget_line_id
       WHERE l.budget_id = ${budgetId}
      ON DUPLICATE KEY UPDATE allocated_amount = VALUES(allocated_amount)`;
  }

  // ---- approval adapter ---------------------------------------------------------------------------------

  const adapter: ApprovalAdapter = {
    documentType: BUDGET_DOCUMENT,
    async describe(tx, id) {
      const b = await tx.budget.findUniqueOrThrow({ where: { id }, include: budgetInclude });
      return {
        id,
        number: b.budgetCode,
        label: `${b.revisionNumber > 0 ? `Revision ${String(b.revisionNumber)} of ` : ''}${b.name} (${b.fiscalYear.code})`,
        createdBy: b.createdBy,
        estateId: b.estateId,
        values: {
          total_amount: b.totalAmount.toFixed(4),
          is_single_estate: b.estateId !== null ? 'true' : 'false',
        },
        amount: b.totalAmount.toFixed(2),
      };
    },
    async onApproved(tx, id, ctx) {
      await lockRowsForUpdate(tx, 'budget', { id });
      const b = await tx.budget.findUniqueOrThrow({ where: { id }, select: { state: true } });
      if (b.state !== 'submitted')
        throw transition(`A ${b.state} budget cannot be approved.`, b.state, 'Reload it.');
      const now = new Date();
      await tx.budget.update({
        where: { id },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, BUDGET_AUDIT, id, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, BUDGET_AUDIT.type, id, 'submitted', 'approved', { actorId: ctx.actorId });
    },
    async onRejected(tx, id, ctx) {
      const now = new Date();
      await tx.budget.update({
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
      await auditAction(tx, BUDGET_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, BUDGET_AUDIT.type, id, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      await tx.budget.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, BUDGET_AUDIT.type, id, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  const duplicateActive = () =>
    new AppError(
      'DUPLICATE_KEY',
      'An active budget already exists for this fiscal year, estate, department and type.',
      [
        {
          code: 'DUPLICATE_KEY',
          message: 'Revise the active budget instead (POST /budgets/{id}/revise).',
        },
      ],
    );

  return {
    adapter,

    async list(q: ListQuery) {
      const where: Prisma.BudgetWhereInput = { AND: [toWhere(q, BUDGET_LIST_FIELDS), await visible()] };
      const [rows, total] = await Promise.all([
        db.budget.findMany({
          where,
          include: budgetInclude,
          orderBy: [...toOrderBy(q.sort, BUDGET_LIST_FIELDS), { id: 'desc' }],
          ...toPaging(q),
        }),
        db.budget.count({ where }),
      ]);
      const items: BudgetOutT[] = [];
      for (const r of rows) items.push(await budgetOut(db, r, false));
      return { items, total };
    },

    async get(id: bigint) {
      return budgetOut(db, await budgetOrNotFound(db, id), true);
    },

    async create(b: z.infer<typeof CreateBudgetBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estateId = b.estate_id ?? null;
        await assertWritable(estateId, null, 'create');
        const { fy, estateCode } = await checkHeader(tx, {
          fiscalYearId: b.fiscal_year_id,
          estateId,
          departmentId: b.department_id ?? null,
        });
        const lines = await checkLines(tx, b.lines ?? [], b.budget_type, estateId);
        const { number } = await allocateNumber(
          tx,
          BUDGET_DOCUMENT,
          {
            date: businessDateFromDb(fy.startDate),
            estateCode: estateCode ?? 'ORG',
            fiscalYearCode: fy.code,
          },
          'draft',
        );
        const created = await tx.budget.create({
          data: {
            budgetCode: number,
            fiscalYearId: fy.id,
            estateId,
            departmentId: b.department_id ?? null,
            name: b.name,
            budgetType: b.budget_type,
            notes: b.notes ?? null,
            stateChangedAt: new Date(),
            createdBy: actorId,
          },
          select: { id: true },
        });
        const total = await writeLines(tx, created.id, fy.id, estateId, lines, actorId);
        await tx.budget.update({ where: { id: created.id }, data: { totalAmount: total.toFixed(4) } });
        const out = await budgetOut(tx, await budgetOrNotFound(tx, created.id), true);
        await auditCreate(tx, BUDGET_AUDIT, created.id, auditValues(out), { actorId });
        await recordStatusChange(tx, BUDGET_AUDIT.type, created.id, null, 'draft', { actorId });
        return out;
      });
    },

    async update(id: bigint, version: number, b: z.infer<typeof PatchBudgetBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget', { id });
        const before = await budgetOrNotFound(tx, id);
        const old = await budgetOut(tx, before, true);
        if (before.version !== version) versionConflict(before, old);
        await assertWritable(before.estateId, id, 'edit');
        if (before.state !== 'draft')
          throw transition(
            `A ${before.state} budget cannot be changed.`,
            before.state,
            'Revise it instead (POST /revise).',
          );
        if (
          before.revisionNumber > 0 &&
          (b.fiscal_year_id !== undefined ||
            b.estate_id !== undefined ||
            b.department_id !== undefined ||
            b.budget_type !== undefined)
        )
          throw invalid([
            {
              code: 'VALIDATION_FAILED',
              message: 'A revision keeps the dimensions of the budget it revises.',
            },
          ]);
        const estateId = b.estate_id === undefined ? before.estateId : b.estate_id;
        if (estateId !== before.estateId) await assertWritable(estateId, id, 'edit');
        const fiscalYearId = b.fiscal_year_id ?? before.fiscalYearId;
        const budgetType = b.budget_type ?? before.budgetType;
        await checkHeader(tx, {
          fiscalYearId,
          estateId,
          departmentId: b.department_id === undefined ? before.departmentId : b.department_id,
        });
        const data: Prisma.BudgetUncheckedUpdateInput = {
          ...(b.name !== undefined ? { name: b.name } : {}),
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
          ...(b.fiscal_year_id !== undefined ? { fiscalYearId } : {}),
          ...(b.estate_id !== undefined ? { estateId } : {}),
          ...(b.department_id !== undefined ? { departmentId: b.department_id } : {}),
          ...(b.budget_type !== undefined ? { budgetType } : {}),
          ...stamp(actorId),
        };
        const relines =
          b.lines !== undefined ||
          b.budget_type !== undefined ||
          b.estate_id !== undefined ||
          b.fiscal_year_id !== undefined;
        if (relines) {
          const bodies: z.infer<typeof BudgetLineBody>[] =
            b.lines ??
            (
              await tx.budgetLine.findMany({
                where: { budgetId: id },
                include: lineInclude,
                orderBy: { sequence: 'asc' },
              })
            ).map((l) => ({
              budget_head_id: l.budgetHeadId,
              cost_centre_id: l.costCentreId,
              annual_amount: dec(l.annualAmount.toString()),
              allocations: l.allocations.map((a) => dec(a.amount.toString())),
              notes: l.notes,
            }));
          const lines = await checkLines(tx, bodies, budgetType, estateId);
          await tx.budgetLine.deleteMany({ where: { budgetId: id } });
          const total = await writeLines(tx, id, fiscalYearId, estateId, lines, actorId);
          data.totalAmount = total.toFixed(4);
        }
        await tx.budget.update({ where: { id }, data });
        const after = await budgetOut(tx, await budgetOrNotFound(tx, id), true);
        await auditUpdate(tx, BUDGET_AUDIT, id, auditValues(old), auditValues(after), { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget', { id });
        const b = await budgetOrNotFound(tx, id);
        await assertWritable(b.estateId, id, 'delete');
        if (b.state !== 'draft')
          throw transition(`A ${b.state} budget cannot be deleted.`, b.state, 'Only a draft is deleted.');
        const out = await budgetOut(tx, b, false);
        await tx.budget.delete({ where: { id } });
        await auditDelete(tx, BUDGET_AUDIT, id, auditValues(out), { actorId });
      });
    },

    async submit(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget', { id });
        const b = await budgetOrNotFound(tx, id);
        if (b.version !== version) versionConflict(b, await budgetOut(tx, b, true));
        await assertWritable(b.estateId, id, 'submit');
        if (b.state !== 'draft')
          throw transition(`A ${b.state} budget cannot be submitted.`, b.state, 'Only a draft is submitted.');
        if (b._count.lines === 0)
          throw invalid([
            { field: 'lines', code: 'VALIDATION_FAILED', message: 'A budget needs at least one line.' },
          ]);
        const now = new Date();
        await tx.budget.update({
          where: { id },
          data: {
            state: 'submitted',
            stateChangedAt: now,
            submittedAt: now,
            submittedBy: actorId,
            ...stamp(actorId),
          },
        });
        await recordStatusChange(tx, BUDGET_AUDIT.type, id, 'draft', 'submitted', { actorId });
        await submitForApproval(tx, { timezone }, BUDGET_DOCUMENT, id, { actorId, date: today() });
        return budgetOut(tx, await budgetOrNotFound(tx, id), true);
      });
    },

    /**
     * D-3.06-5 "Release Budget": an approved budget becomes active and consumable. A revision supersedes the
     * budget it revises; its lines take over that budget's committed, actual and monthly position.
     */
    async activate(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget', { id });
        const b = await budgetOrNotFound(tx, id);
        if (b.version !== version) versionConflict(b, await budgetOut(tx, b, true));
        await assertWritable(b.estateId, id, 'activate');
        if (b.state === 'active')
          throw transition('This budget is already active.', b.state, 'Nothing to do.');
        if (b.state !== 'approved')
          throw transition(
            `A ${b.state} budget cannot be released.`,
            b.state,
            'Only an approved budget is released.',
          );
        const fy = await tx.fiscalYear.findUniqueOrThrow({
          where: { id: b.fiscalYearId },
          select: { state: true, code: true },
        });
        if (fy.state === 'closed')
          throw new AppError('PERIOD_CLOSED', `Fiscal year ${fy.code} is closed.`, [
            { code: 'PERIOD_CLOSED', message: 'Nothing is released into a closed year.' },
          ]);
        const now = new Date();
        if (b.supersedesId !== null) {
          await lockRowsForUpdate(tx, 'budget', { id: b.supersedesId });
          const prior = await tx.budget.findUniqueOrThrow({
            where: { id: b.supersedesId },
            select: { state: true },
          });
          if (prior.state === 'approved') {
            await tx.budget.update({
              where: { id: b.supersedesId },
              data: { state: 'superseded', stateChangedAt: now, ...stamp(actorId) },
            });
            await recordStatusChange(tx, BUDGET_AUDIT.type, b.supersedesId, 'approved', 'superseded', {
              actorId,
            });
            await openPositions(tx, id);
          } else if (prior.state === 'active') {
            const oldLines = await tx.budgetLine.findMany({ where: { budgetId: b.supersedesId } });
            const newLines = await tx.budgetLine.findMany({ where: { budgetId: id } });
            await tx.budget.update({
              where: { id: b.supersedesId },
              data: { state: 'superseded', stateChangedAt: now, ...stamp(actorId) },
            });
            await recordStatusChange(tx, BUDGET_AUDIT.type, b.supersedesId, 'active', 'superseded', {
              actorId,
            });
            await openPositions(tx, id);
            for (const o of oldLines) {
              const used = await tx.budgetConsumption.count({ where: { budgetLineId: o.id } });
              const carried = !o.committedAmount.isZero() || !o.actualAmount.isZero();
              const target = newLines.find((x) => x.lineKey === o.lineKey);
              if (!target) {
                if (used > 0 || carried)
                  throw invalid([
                    {
                      field: 'lines',
                      code: 'VALIDATION_FAILED',
                      message:
                        'The revision drops a line that has consumption; keep it (its amount may change).',
                      context: {
                        budget_head_id: o.budgetHeadId.toString(),
                        cost_centre_id: idOut(o.costCentreId),
                      },
                    },
                  ]);
                continue;
              }
              await tx.$executeRaw`
                UPDATE budget_line SET committed_amount = ${o.committedAmount.toFixed(4)}, actual_amount = ${o.actualAmount.toFixed(4)},
                       updated_at = UTC_TIMESTAMP()
                 WHERE id = ${target.id}`;
              await tx.$executeRaw`
                UPDATE budget_line SET utilisation_percentage = ROUND((actual_amount + committed_amount) / annual_amount * 100, 4)
                 WHERE id = ${target.id}`;
              await tx.$executeRaw`
                INSERT INTO budget_position_summary (budget_line_id, accounting_period_id, committed_amount, actual_amount, updated_at)
                SELECT ${target.id}, p.accounting_period_id, p.committed_amount, p.actual_amount, UTC_TIMESTAMP()
                  FROM budget_position_summary p WHERE p.budget_line_id = ${o.id}
                ON DUPLICATE KEY UPDATE committed_amount = VALUES(committed_amount), actual_amount = VALUES(actual_amount)`;
            }
          }
        } else {
          await openPositions(tx, id);
        }
        // Idempotent: every line has its monthly position rows, whichever path above ran.
        await openPositions(tx, id);
        try {
          await tx.budget.update({
            where: { id },
            data: {
              state: 'active',
              stateChangedAt: now,
              activatedAt: now,
              activatedBy: actorId,
              ...stamp(actorId),
            },
          });
        } catch (err) {
          if (constraintViolation(err)?.kind === 'unique') throw duplicateActive();
          throw err;
        }
        await auditAction(tx, BUDGET_AUDIT, id, 'approve', { actorId, reason: 'Released (activated)' });
        await recordStatusChange(tx, BUDGET_AUDIT.type, id, 'approved', 'active', { actorId });
        return budgetOut(tx, await budgetOrNotFound(tx, id), true);
      });
    },

    /** D-3.06-4: a new draft copying an approved or active budget, with its lines and allocations. */
    async revise(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'budget', { id });
        const b = await budgetOrNotFound(tx, id);
        if (b.version !== version) versionConflict(b, await budgetOut(tx, b, true));
        await assertWritable(b.estateId, id, 'revise');
        if (b.state !== 'active' && b.state !== 'approved')
          throw transition(
            `A ${b.state} budget cannot be revised.`,
            b.state,
            'Revise an approved or active budget; a draft is edited.',
          );
        const open = await tx.budget.findFirst({
          where: { supersedesId: id, state: { in: ['draft', 'submitted', 'approved'] } },
          select: { budgetCode: true },
        });
        if (open)
          throw transition(
            `Revision ${open.budgetCode} is already open.`,
            b.state,
            'Finish or delete it first.',
          );
        const revisionNumber = b.revisionNumber + 1;
        const root = b.budgetCode.replace(/-R\d+$/, '');
        const created = await tx.budget.create({
          data: {
            budgetCode: `${root}-R${String(revisionNumber)}`.slice(0, 30),
            fiscalYearId: b.fiscalYearId,
            estateId: b.estateId,
            departmentId: b.departmentId,
            name: b.name,
            budgetType: b.budgetType,
            notes: b.notes,
            revisionNumber,
            supersedesId: id,
            totalAmount: b.totalAmount,
            stateChangedAt: new Date(),
            createdBy: actorId,
          },
          select: { id: true },
        });
        const lines = await tx.budgetLine.findMany({
          where: { budgetId: id },
          include: { allocations: true },
          orderBy: { sequence: 'asc' },
        });
        for (const l of lines) {
          const copy = await tx.budgetLine.create({
            data: {
              budgetId: created.id,
              budgetHeadId: l.budgetHeadId,
              costCentreId: l.costCentreId,
              estateId: l.estateId,
              annualAmount: l.annualAmount,
              notes: l.notes,
              sequence: l.sequence,
              createdBy: actorId,
            },
            select: { id: true },
          });
          await tx.budgetAllocation.createMany({
            data: l.allocations.map((a) => ({
              budgetLineId: copy.id,
              monthNumber: a.monthNumber,
              accountingPeriodId: a.accountingPeriodId,
              amount: a.amount,
              createdBy: actorId,
            })),
          });
        }
        const out = await budgetOut(tx, await budgetOrNotFound(tx, created.id), true);
        await auditCreate(tx, BUDGET_AUDIT, created.id, auditValues(out), { actorId });
        await recordStatusChange(tx, BUDGET_AUDIT.type, created.id, null, 'draft', {
          actorId,
          comment: `Revision of ${b.budgetCode}`,
        });
        return out;
      });
    },

    async lines(q: ListQuery) {
      const where: Prisma.BudgetLineWhereInput = {
        AND: [toWhere(q, LINE_LIST_FIELDS), { budget: await visible() }],
      };
      const [rows, total] = await Promise.all([
        db.budgetLine.findMany({
          where,
          include: lineInclude,
          orderBy: [...toOrderBy(q.sort, LINE_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.budgetLine.count({ where }),
      ]);
      return { items: rows.map(lineOut), total };
    },

    /** A line's consumption, its predecessors' (same head and cost centre in earlier revisions) included. */
    async consumption(lineId: bigint) {
      const line = await db.budgetLine.findFirst({
        where: { id: lineId, budget: await visible() },
        select: { id: true, lineKey: true, budgetId: true },
      });
      if (!line) throw Errors.notFound('The budget line was not found.');
      const ids = [line.id];
      let budgetId: bigint | null = line.budgetId;
      for (let i = 0; i < 20; i += 1) {
        const b: { supersedesId: bigint | null } | null = await db.budget.findUnique({
          where: { id: budgetId },
          select: { supersedesId: true },
        });
        budgetId = b?.supersedesId ?? null;
        if (budgetId === null) break;
        const prior = await db.budgetLine.findFirst({
          where: { budgetId, lineKey: line.lineKey },
          select: { id: true },
        });
        if (prior) ids.push(prior.id);
      }
      const rows = await db.budgetConsumption.findMany({
        where: { budgetLineId: { in: ids } },
        include: { period: { select: { id: true, name: true } } },
        orderBy: { id: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id.toString(),
        budget_line_id: r.budgetLineId.toString(),
        consumption_type: r.consumptionType as 'commitment',
        source_type: r.sourceType as 'journal',
        source_id: r.sourceId.toString(),
        consumption_date: businessDateFromDb(r.consumptionDate),
        period: { id: r.period.id.toString(), name: r.period.name },
        amount: money(r.amount),
        releases_id: idOut(r.releasesId),
        released_by_id: idOut(r.releasedById),
        reversal_of_id: idOut(r.reversalOfId),
        created_at: r.createdAt.toISOString(),
      }));
    },

    async availability(q: z.infer<typeof AvailabilityQuery>) {
      await assertReadable(q.estate_id);
      const a = await checkAvailability(db, {
        budgetHeadId: q.budget_head_id,
        costCentreId: q.cost_centre_id ?? null,
        estateId: q.estate_id ?? null,
        departmentId: q.department_id ?? null,
        date: q.date,
        amount: q.amount ?? dec('0'),
      });
      return {
        line: a.line
          ? {
              id: a.line.id.toString(),
              budget_id: a.line.budgetId.toString(),
              budget_code: a.line.budgetCode,
            }
          : null,
        annual: a.annual === null ? null : money(a.annual),
        committed: a.committed === null ? null : money(a.committed),
        actual: a.actual === null ? null : money(a.actual),
        available: a.available === null ? null : money(a.available),
        utilisation: a.utilisation,
        available_after: a.availableAfter === null ? null : money(a.availableAfter),
        control: {
          mode: a.control.mode,
          control_id: idOut(a.control.controlId),
          warning_threshold_percentage: a.control.warningThreshold,
          critical_threshold_percentage: a.control.criticalThreshold,
          overrun_tolerance_percentage: a.control.overrunTolerance,
          escalation_role_id: idOut(a.control.escalationRoleId),
        },
        exceeded: a.exceeded,
        outcome: a.outcome,
      };
    },

    /** D-3.06-15: budget vs actual by head, cost centre or period. */
    async vsActual(id: bigint, q: z.infer<typeof VsActualQuery>): Promise<z.infer<typeof VsActualOut>> {
      const b = await budgetOrNotFound(db, id);
      const lines = await db.budgetLine.findMany({
        where: { budgetId: id },
        include: lineInclude,
        orderBy: { sequence: 'asc' },
      });
      const row = (
        key: string | null,
        code: string | null,
        label: string,
        budget: Dec,
        committed: Dec,
        actual: Dec,
      ) => ({
        key,
        code,
        label,
        budget: money(budget),
        committed: money(committed),
        actual: money(actual),
        available: money(available(budget, actual, committed)),
        utilisation_percentage: pct(utilisation(budget, actual, committed)),
        variance: varianceOf(budget, actual),
      });
      const groups = new Map<
        string,
        { key: string | null; code: string | null; label: string; budget: Dec; committed: Dec; actual: Dec }
      >();
      const add = (
        k: string,
        key: string | null,
        code: string | null,
        label: string,
        budget: Dec,
        committed: Dec,
        actual: Dec,
      ) => {
        const g = groups.get(k) ?? {
          key,
          code,
          label,
          budget: dec('0'),
          committed: dec('0'),
          actual: dec('0'),
        };
        g.budget = g.budget.plus(budget);
        g.committed = g.committed.plus(committed);
        g.actual = g.actual.plus(actual);
        groups.set(k, g);
      };
      if (q.group_by === 'period') {
        const positions = await db.budgetPositionSummary.findMany({
          where: { budgetLineId: { in: lines.map((l) => l.id) } },
          include: { period: { select: { id: true, name: true, startDate: true } } },
          orderBy: { period: { startDate: 'asc' } },
        });
        const allocated = new Map<string, Dec>();
        for (const l of lines)
          for (const a of l.allocations)
            allocated.set(
              a.accountingPeriodId.toString(),
              (allocated.get(a.accountingPeriodId.toString()) ?? dec('0')).plus(a.amount.toString()),
            );
        for (const l of lines)
          for (const a of l.allocations) {
            const k = a.accountingPeriodId.toString();
            if (!groups.has(k))
              add(k, k, null, a.period.name, allocated.get(k) ?? dec('0'), dec('0'), dec('0'));
          }
        for (const p of positions) {
          const k = p.accountingPeriodId.toString();
          add(
            k,
            k,
            null,
            p.period.name,
            dec('0'),
            dec(p.committedAmount.toString()),
            dec(p.actualAmount.toString()),
          );
        }
      } else {
        for (const l of lines) {
          const [k, key, code, label] =
            q.group_by === 'head'
              ? [l.budgetHeadId.toString(), l.budgetHeadId.toString(), l.budgetHead.code, l.budgetHead.name]
              : l.costCentre
                ? [
                    l.costCentre.id.toString(),
                    l.costCentre.id.toString(),
                    l.costCentre.code,
                    l.costCentre.name,
                  ]
                : ['none', null, null, 'No cost centre'];
          add(
            k,
            key,
            code,
            label,
            dec(l.annualAmount.toString()),
            dec(l.committedAmount.toString()),
            dec(l.actualAmount.toString()),
          );
        }
      }
      const rows = [...groups.values()].map((g) =>
        row(g.key, g.code, g.label, g.budget, g.committed, g.actual),
      );
      const all = [...groups.values()];
      const total = row(
        null,
        null,
        'Total',
        sum(all.map((g) => g.budget)),
        sum(all.map((g) => g.committed)),
        sum(all.map((g) => g.actual)),
      );
      return {
        budget: { id: b.id.toString(), budget_code: b.budgetCode, name: b.name },
        group_by: q.group_by,
        rows,
        total,
      };
    },
  };
}

export type BudgetService = ReturnType<typeof budgetService>;
