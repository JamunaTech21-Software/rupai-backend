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
import type { ApprovalAdapter, ApprovalContext } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, toDecimalString, type Dec } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb, businessDateToDb, todayIn, type BusinessDate } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idIn, idOut, iso, versionConflict } from '../organisation/common.js';
import type {
  BenefitEntitlementOut,
  BenefitIssueOut,
  CreateCaseBody,
  CreateEntitlementBody,
  CreateIssueBody,
  GenerateIssuesBody,
  PatchCaseBody,
  PatchEntitlementBody,
  WelfareCaseOut,
} from './benefit.schema.js';

/**
 * Benefits and welfare (P2.08; Spec P3 §23, P7 §7; the design's Ration Card tab, D-2.08-*).
 *
 *   entitlement  a profile's right to a benefit for a period (a ration card, a house): approvable
 *                (operational); an approved one may be withdrawn from a date, with a reason.
 *   issue        one issue under an entitlement on a date (this week's ration): its quantity and employer
 *                cost; approvable (financial, never self-approved). Generated in bulk per benefit type and
 *                estate. Stock consumption (P4.04) and posting (Phase 3) join later.
 *   welfare case medical, education, disaster … help for a worker, a person or the community; approvable
 *                (financial) on its requested amount, then disbursed up to it and closed with its outcome.
 *
 * A benefit is NOT a payroll earning: payroll_treatment stays not_payroll (read-only until pay component
 * types exist, Phase 9), and no issue carries a payroll component (P3 §23.1, the verification).
 */

type EntitlementOutT = z.infer<typeof BenefitEntitlementOut>;
type IssueOutT = z.infer<typeof BenefitIssueOut>;
type CaseOutT = z.infer<typeof WelfareCaseOut>;

export const ENTITLEMENT_DOCUMENT = 'benefit_entitlement';
export const ISSUE_DOCUMENT = 'benefit_issue';
export const CASE_DOCUMENT = 'welfare_case';

export const BENEFIT_ENTITLEMENT_AUDIT: AuditedRecord = {
  type: ENTITLEMENT_DOCUMENT,
  class: 'operational',
  fields: [
    'employment_profile_id',
    'benefit_type_id',
    'effective_from',
    'effective_to',
    'quantity_per_period',
    'employer_cost_per_period',
    'employee_contribution',
    'allocation_reference',
    'issuing_office',
    'withdrawal_reason',
    'state',
  ],
};
export const BENEFIT_ISSUE_AUDIT: AuditedRecord = {
  type: ISSUE_DOCUMENT,
  class: 'financial',
  fields: [
    'benefit_entitlement_id',
    'issue_date',
    'period_reference',
    'quantity',
    'employer_cost',
    'employee_contribution',
    'issued_by_profile_id',
    'state',
  ],
};
export const WELFARE_CASE_AUDIT: AuditedRecord = {
  type: CASE_DOCUMENT,
  class: 'financial',
  fields: [
    'estate_id',
    'beneficiary_type',
    'beneficiary_id',
    'welfare_category',
    'case_date',
    'description',
    'requested_amount',
    'approved_amount',
    'disbursed_amount',
    'outcome',
    'state',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const ENTITLEMENT_LIST_FIELDS: ListFieldMap = {
  employment_profile_id: { field: 'employmentProfileId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  benefit_type_id: { field: 'benefitTypeId', convert: idf },
  state: { field: 'state' },
  effective_from: { field: 'effectiveFrom' },
};
export const ISSUE_LIST_FIELDS: ListFieldMap = {
  benefit_entitlement_id: { field: 'benefitEntitlementId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  state: { field: 'state' },
  issue_date: { field: 'issueDate' },
  period_reference: { field: 'periodReference' },
};
export const CASE_LIST_FIELDS: ListFieldMap = {
  estate_id: { field: 'estateId', convert: idf },
  beneficiary_type: { field: 'beneficiaryType' },
  beneficiary_id: { field: 'beneficiaryId', convert: idf },
  welfare_category: { field: 'welfareCategory' },
  state: { field: 'state' },
  case_date: { field: 'caseDate' },
  case_number: { field: 'caseNumber' },
};

const profileRef = {
  select: { id: true, profileNumber: true, person: { select: { fullName: true } } },
} as const;
const typeRef = {
  select: {
    id: true,
    code: true,
    name: true,
    benefitCategory: true,
    payrollTreatment: true,
    defaultEmployerCost: true,
  },
} as const;
const entitlementInclude = {
  profile: profileRef,
  benefitType: typeRef,
  approver: { select: { id: true, username: true } },
} as const satisfies Prisma.BenefitEntitlementInclude;
type EntitlementRow = Prisma.BenefitEntitlementGetPayload<{ include: typeof entitlementInclude }>;
const issueInclude = {
  entitlement: { include: { profile: profileRef, benefitType: typeRef } },
} as const satisfies Prisma.BenefitIssueInclude;
type IssueRow = Prisma.BenefitIssueGetPayload<{ include: typeof issueInclude }>;
type CaseRow = Prisma.WelfareCaseGetPayload<object>;

const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const money = (v: Dec | null) => (v === null ? null : toDecimalString(v.toString(), 'money'));
const qty = (v: Prisma.Decimal | null) => (v === null ? null : toDecimalString(v.toString(), 'qty'));
const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const draftOnly = (state: string, what: string) => {
  if (state !== 'draft')
    throw transition(`A ${state} ${what} cannot be changed.`, state, 'Only a draft is changed or deleted.');
};
const ref = (p: { id: bigint; profileNumber: string; person: { fullName: string } }) => ({
  id: p.id.toString(),
  profile_number: p.profileNumber,
  full_name: p.person.fullName,
});

export interface BenefitServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function benefitService({ db, accessLog, timezone }: BenefitServiceDeps) {
  const today = () => todayIn(timezone);
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  async function canManage(
    estateId: bigint,
    recordId: bigint | null,
    operation: string,
    module: 'benefit' | 'welfare',
  ) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, module, recordId, operation);
  }
  async function approvals(tx: Database | Tx, type: string, ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, bigint>();
    const rows = await tx.approvalRequest.findMany({
      where: { documentType: type, documentId: { in: [...ids] }, state: 'pending' },
      select: { id: true, documentId: true },
    });
    return new Map(rows.map((r) => [r.documentId, r.id]));
  }

  /** The approval adapter of a simple document: approved / rejected / returned (draft again). */
  function adapterFor(
    documentType: string,
    audit: AuditedRecord,
    table: 'benefitEntitlement' | 'benefitIssue' | 'welfareCase',
    describe: ApprovalAdapter['describe'],
    onApprove?: (tx: Tx, id: bigint) => Promise<Record<string, unknown>>,
  ): ApprovalAdapter {
    const model = (tx: Tx) =>
      tx[table] as unknown as {
        update(a: { where: { id: bigint }; data: Record<string, unknown> }): Promise<unknown>;
        findUniqueOrThrow(a: { where: { id: bigint } }): Promise<{ state: string }>;
      };
    return {
      documentType,
      describe,
      async onApproved(tx, id, ctx: ApprovalContext) {
        await lockRowsForUpdate(tx, audit.type, { id });
        const row = await model(tx).findUniqueOrThrow({ where: { id } });
        if (row.state !== 'submitted')
          throw transition(
            `A ${row.state} ${audit.type.replace('_', ' ')} cannot be approved.`,
            row.state,
            'Reload it.',
          );
        const extra = onApprove ? await onApprove(tx, id) : {};
        const now = new Date();
        await model(tx).update({
          where: { id },
          data: {
            ...extra,
            state: 'approved',
            stateChangedAt: now,
            approvedAt: now,
            approvedBy: ctx.actorId,
            ...stamp(ctx.actorId),
          },
        });
        await auditAction(tx, audit, id, 'approve', {
          actorId: ctx.actorId,
          actingForUserId: ctx.actingForUserId,
        });
        await recordStatusChange(tx, audit.type, id, 'submitted', 'approved', { actorId: ctx.actorId });
      },
      async onRejected(tx, id, ctx) {
        const now = new Date();
        await model(tx).update({
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
        await auditAction(tx, audit, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
        await recordStatusChange(tx, audit.type, id, 'submitted', 'rejected', {
          actorId: ctx.actorId,
          comment: ctx.reason,
        });
      },
      async onReturned(tx, id, ctx) {
        await model(tx).update({
          where: { id },
          data: {
            state: 'draft',
            stateChangedAt: new Date(),
            submittedAt: null,
            submittedBy: null,
            ...stamp(ctx.actorId),
          },
        });
        await recordStatusChange(tx, audit.type, id, 'submitted', 'draft', {
          actorId: ctx.actorId,
          comment: ctx.comment,
        });
      },
    };
  }

  // ================= entitlements =================
  function toEntitlementOut(e: EntitlementRow, approvalId: bigint | null): EntitlementOutT {
    const from = businessDateFromDb(e.effectiveFrom);
    const to = d(e.effectiveTo);
    const t = today();
    return {
      id: e.id.toString(),
      employment_profile_id: e.employmentProfileId.toString(),
      profile: ref(e.profile),
      estate_id: e.estateId.toString(),
      benefit_type_id: e.benefitTypeId.toString(),
      benefit_type: {
        id: e.benefitType.id.toString(),
        code: e.benefitType.code,
        name: e.benefitType.name,
        benefit_category: e.benefitType.benefitCategory,
        payroll_treatment: e.benefitType.payrollTreatment,
      },
      effective_from: from,
      effective_to: to,
      quantity_per_period: qty(e.quantityPerPeriod),
      employer_cost_per_period: money(e.employerCostPerPeriod),
      employee_contribution: money(e.employeeContribution) ?? '0.0000',
      allocation_reference: e.allocationReference,
      issuing_office: e.issuingOffice,
      withdrawal_reason: e.withdrawalReason,
      state: e.state as EntitlementOutT['state'],
      is_current:
        (e.state === 'approved' || e.state === 'withdrawn') && from <= t && (to === null || to >= t),
      approval_id: idOut(approvalId),
      approved_at: iso(e.approvedAt),
      approved_by: e.approver ? { id: e.approver.id.toString(), username: e.approver.username } : null,
      rejection_reason: e.rejectionReason,
      version: e.version,
      created_at: e.createdAt.toISOString(),
    };
  }
  async function entitlementOut(tx: Database | Tx, e: EntitlementRow) {
    return toEntitlementOut(
      e,
      e.state === 'submitted'
        ? ((await approvals(tx, ENTITLEMENT_DOCUMENT, [e.id])).get(e.id) ?? null)
        : null,
    );
  }
  async function entitlementOrNotFound(tx: Database | Tx, id: bigint) {
    const e = await tx.benefitEntitlement.findUnique({ where: { id }, include: entitlementInclude });
    if (!e) throw Errors.notFound('Benefit entitlement not found.');
    return e;
  }
  /** Terms check: the type, the dates (from joining; no overlap of the same benefit). */
  async function checkEntitlement(
    tx: Database | Tx,
    p: { id: bigint; joiningDate: Date; status: string },
    t: { benefitTypeId: bigint; from: BusinessDate; to: BusinessDate | null },
    self: bigint | null,
  ) {
    const problems: ErrorDetail[] = [];
    if (p.status === 'separated')
      problems.push(invalid('employment_profile_id', 'The profile is separated.'));
    const type = await tx.benefitType.findUnique({
      where: { id: t.benefitTypeId },
      select: { status: true },
    });
    if (type?.status !== 'active') problems.push(invalid('benefit_type_id', 'No such active benefit type.'));
    if (t.from < businessDateFromDb(p.joiningDate))
      problems.push(invalid('effective_from', 'Before the joining date.'));
    if (t.to !== null && t.to < t.from)
      problems.push(invalid('effective_to', 'Cannot be before effective_from.'));
    const clash = await tx.benefitEntitlement.findFirst({
      where: {
        employmentProfileId: p.id,
        benefitTypeId: t.benefitTypeId,
        state: { in: ['draft', 'submitted', 'approved', 'withdrawn'] },
        ...(t.to === null ? {} : { effectiveFrom: { lte: businessDateToDb(t.to) } }),
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: businessDateToDb(t.from) } }],
        ...(self !== null ? { id: { not: self } } : {}),
      },
      select: { effectiveFrom: true },
    });
    if (clash)
      problems.push(
        invalid(
          'effective_from',
          `Overlaps the same benefit from ${businessDateFromDb(clash.effectiveFrom)}.`,
        ),
      );
    if (problems.length > 0) throw Errors.validation(problems);
  }
  const dupEntitlement = (err: unknown): never => {
    if (constraintViolation(err)?.kind === 'unique')
      throw new AppError('DUPLICATE_KEY', 'The same benefit already starts on that date.', [
        { field: 'effective_from', code: 'DUPLICATE_KEY', message: 'Choose another date.' },
      ]);
    throw err;
  };

  const entitlementAdapter = adapterFor(
    ENTITLEMENT_DOCUMENT,
    BENEFIT_ENTITLEMENT_AUDIT,
    'benefitEntitlement',
    async (tx, id) => {
      const e = await entitlementOrNotFound(tx, id);
      return {
        id,
        number: null,
        label: `${e.profile.profileNumber} · ${e.profile.person.fullName} · ${e.benefitType.name} from ${businessDateFromDb(e.effectiveFrom)}`,
        createdBy: e.createdBy,
        estateId: e.estateId,
        values: { estate_id: e.estateId.toString() },
        amount: e.employerCostPerPeriod === null ? null : e.employerCostPerPeriod.toFixed(2),
      };
    },
  );

  // ================= issues =================
  function toIssueOut(i: IssueRow, approvalId: bigint | null): IssueOutT {
    return {
      id: i.id.toString(),
      benefit_entitlement_id: i.benefitEntitlementId.toString(),
      profile: ref(i.entitlement.profile),
      benefit_type: {
        id: i.entitlement.benefitType.id.toString(),
        code: i.entitlement.benefitType.code,
        name: i.entitlement.benefitType.name,
      },
      estate_id: i.estateId.toString(),
      issue_date: businessDateFromDb(i.issueDate),
      period_reference: i.periodReference,
      quantity: qty(i.quantity),
      employer_cost: money(i.employerCost) ?? '0.0000',
      employee_contribution: money(i.employeeContribution) ?? '0.0000',
      issued_by_profile_id: idOut(i.issuedByProfileId),
      state: i.state as IssueOutT['state'],
      approval_id: idOut(approvalId),
      approved_at: iso(i.approvedAt),
      rejection_reason: i.rejectionReason,
      version: i.version,
      created_at: i.createdAt.toISOString(),
    };
  }
  async function issueOut(tx: Database | Tx, i: IssueRow) {
    return toIssueOut(
      i,
      i.state === 'submitted' ? ((await approvals(tx, ISSUE_DOCUMENT, [i.id])).get(i.id) ?? null) : null,
    );
  }
  async function issueOrNotFound(tx: Database | Tx, id: bigint) {
    const i = await tx.benefitIssue.findUnique({ where: { id }, include: issueInclude });
    if (!i) throw Errors.notFound('Benefit issue not found.');
    return i;
  }
  /** Creates a draft issue under an entitlement that covers the date (inside the caller's transaction). */
  async function insertIssue(
    tx: Tx,
    e: EntitlementRow,
    b: Omit<z.infer<typeof CreateIssueBody>, 'benefit_entitlement_id'>,
    actorId: bigint,
  ) {
    const from = businessDateFromDb(e.effectiveFrom);
    const to = d(e.effectiveTo);
    if (
      !(e.state === 'approved' || e.state === 'withdrawn') ||
      b.issue_date < from ||
      (to !== null && b.issue_date > to)
    ) {
      throw Errors.validation([
        invalid('issue_date', 'The entitlement is not approved and in force on that date.'),
      ]);
    }
    const cost =
      b.employer_cost ??
      (e.employerCostPerPeriod
        ? dec(e.employerCostPerPeriod.toString())
        : e.benefitType.defaultEmployerCost
          ? dec(e.benefitType.defaultEmployerCost.toString())
          : null);
    if (cost === null)
      throw Errors.validation([
        invalid('employer_cost', 'No employer cost on the entitlement or its type: state it.'),
      ]);
    const { id } = await tx.benefitIssue
      .create({
        data: {
          benefitEntitlementId: e.id,
          estateId: e.estateId,
          issueDate: businessDateToDb(b.issue_date),
          periodReference: b.period_reference ?? null,
          quantity:
            b.quantity !== undefined
              ? (b.quantity?.toString() ?? null)
              : (e.quantityPerPeriod?.toString() ?? null),
          employerCost: cost.toString(),
          employeeContribution: (
            b.employee_contribution ?? dec(e.employeeContribution.toString())
          ).toString(),
          issuedByProfileId: idIn(b.issued_by_profile_id ?? null),
          state: 'draft',
          stateChangedAt: new Date(),
          createdBy: actorId,
        },
        select: { id: true },
      })
      .catch((err: unknown) => {
        if (constraintViolation(err)?.kind === 'unique')
          throw new AppError('DUPLICATE_KEY', 'This entitlement already has an issue on that date.', [
            { field: 'issue_date', code: 'DUPLICATE_KEY', message: 'One issue per entitlement and date.' },
          ]);
        throw err;
      });
    const out = await issueOut(tx, await issueOrNotFound(tx, id));
    await auditCreate(tx, BENEFIT_ISSUE_AUDIT, id, out, { actorId });
    await recordStatusChange(tx, BENEFIT_ISSUE_AUDIT.type, id, null, 'draft', { actorId });
    return out;
  }
  const issueAdapter = adapterFor(ISSUE_DOCUMENT, BENEFIT_ISSUE_AUDIT, 'benefitIssue', async (tx, id) => {
    const i = await issueOrNotFound(tx, id);
    return {
      id,
      number: null,
      label: `${i.entitlement.profile.profileNumber} · ${i.entitlement.profile.person.fullName} · ${i.entitlement.benefitType.name} ${businessDateFromDb(i.issueDate)}`,
      createdBy: i.createdBy,
      estateId: i.estateId,
      values: {
        estate_id: i.estateId.toString(),
        employer_cost: toDecimalString(i.employerCost.toString(), 'money'),
      },
      amount: i.employerCost.toFixed(2),
      quantity: i.quantity === null ? null : toDecimalString(i.quantity.toString(), 'qty'),
    };
  });

  // ================= welfare cases =================
  async function beneficiaryName(
    tx: Database | Tx,
    c: { beneficiaryType: string; beneficiaryId: bigint | null },
  ) {
    if (c.beneficiaryId === null) return null;
    if (c.beneficiaryType === 'employment_profile') {
      return (
        (
          await tx.employmentProfile.findUnique({
            where: { id: c.beneficiaryId },
            select: { person: { select: { fullName: true } } },
          })
        )?.person.fullName ?? null
      );
    }
    return (
      (await tx.person.findUnique({ where: { id: c.beneficiaryId }, select: { fullName: true } }))
        ?.fullName ?? null
    );
  }
  async function caseOut(tx: Database | Tx, c: CaseRow): Promise<CaseOutT> {
    const approvalId =
      c.state === 'submitted' ? ((await approvals(tx, CASE_DOCUMENT, [c.id])).get(c.id) ?? null) : null;
    return {
      id: c.id.toString(),
      case_number: c.caseNumber,
      estate_id: c.estateId.toString(),
      beneficiary_type: c.beneficiaryType as CaseOutT['beneficiary_type'],
      beneficiary_id: idOut(c.beneficiaryId),
      beneficiary_name: await beneficiaryName(tx, c),
      welfare_category: c.welfareCategory as CaseOutT['welfare_category'],
      case_date: businessDateFromDb(c.caseDate),
      description: c.description,
      requested_amount: money(c.requestedAmount),
      approved_amount: money(c.approvedAmount),
      disbursed_amount: money(c.disbursedAmount) ?? '0.0000',
      remaining_amount:
        c.approvedAmount === null
          ? null
          : money(dec(c.approvedAmount.toString()).minus(c.disbursedAmount.toString())),
      outcome: c.outcome,
      state: c.state as CaseOutT['state'],
      approval_id: idOut(approvalId),
      approved_at: iso(c.approvedAt),
      rejection_reason: c.rejectionReason,
      version: c.version,
      created_at: c.createdAt.toISOString(),
    };
  }
  async function caseOrNotFound(tx: Database | Tx, id: bigint) {
    const c = await tx.welfareCase.findUnique({ where: { id } });
    if (!c) throw Errors.notFound('Welfare case not found.');
    return c;
  }
  async function checkBeneficiary(tx: Database | Tx, estateId: bigint, type: string, id: bigint | null) {
    if (type === 'community') {
      if (id !== null)
        throw Errors.validation([invalid('beneficiary_id', 'A community case names no beneficiary.')]);
      return;
    }
    if (id === null) throw Errors.validation([invalid('beneficiary_id', 'Name the beneficiary.')]);
    const ok =
      type === 'employment_profile'
        ? (await tx.employmentProfile.findUnique({ where: { id }, select: { estateId: true } }))?.estateId ===
          estateId
        : await tx.person
            .findUnique({
              where: { id },
              select: { registeredEstateId: true, profiles: { select: { estateId: true } } },
            })
            .then(
              (p) =>
                p !== null && [p.registeredEstateId, ...p.profiles.map((x) => x.estateId)].includes(estateId),
            );
    if (!ok)
      throw Errors.validation([
        invalid(
          'beneficiary_id',
          `No such ${type === 'person' ? 'person' : 'profile'} of the case’s estate.`,
        ),
      ]);
  }
  const caseAdapter = adapterFor(
    CASE_DOCUMENT,
    WELFARE_CASE_AUDIT,
    'welfareCase',
    async (tx, id) => {
      const c = await caseOrNotFound(tx, id);
      return {
        id,
        number: c.caseNumber,
        label: `${c.caseNumber} · ${c.welfareCategory}${(await beneficiaryName(tx, c)) ? ` · ${String(await beneficiaryName(tx, c))}` : ' · community'}`,
        createdBy: c.createdBy,
        estateId: c.estateId,
        values: { estate_id: c.estateId.toString(), requested_amount: money(c.requestedAmount) },
        amount: c.requestedAmount === null ? null : c.requestedAmount.toFixed(2),
      };
    },
    // Approving grants the requested amount (P3 §23.4).
    async (tx, id) => ({ approvedAmount: (await caseOrNotFound(tx, id)).requestedAmount }),
  );

  return {
    adapters: [entitlementAdapter, issueAdapter, caseAdapter],

    entitlements: {
      async list(q: ListQuery) {
        const where = toWhere(q, ENTITLEMENT_LIST_FIELDS) as Prisma.BenefitEntitlementWhereInput;
        const [rows, total] = await Promise.all([
          db.benefitEntitlement.findMany({
            where,
            include: entitlementInclude,
            orderBy: [...toOrderBy(q.sort, ENTITLEMENT_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.benefitEntitlement.count({ where }),
        ]);
        const p = await approvals(
          db,
          ENTITLEMENT_DOCUMENT,
          rows.filter((r) => r.state === 'submitted').map((r) => r.id),
        );
        return { items: rows.map((r) => toEntitlementOut(r, p.get(r.id) ?? null)), total };
      },
      async get(id: bigint) {
        return entitlementOut(db, await entitlementOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateEntitlementBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const p = await tx.employmentProfile.findUnique({
            where: { id: b.employment_profile_id },
            select: { id: true, estateId: true, joiningDate: true, status: true },
          });
          if (!p) throw Errors.validation([invalid('employment_profile_id', 'No such profile.')]);
          await canManage(p.estateId, null, 'create-entitlement', 'benefit');
          await checkEntitlement(
            tx,
            p,
            { benefitTypeId: b.benefit_type_id, from: b.effective_from, to: b.effective_to ?? null },
            null,
          );
          const { id } = await tx.benefitEntitlement
            .create({
              data: {
                employmentProfileId: p.id,
                estateId: p.estateId,
                benefitTypeId: b.benefit_type_id,
                effectiveFrom: businessDateToDb(b.effective_from),
                effectiveTo: b.effective_to ? businessDateToDb(b.effective_to) : null,
                quantityPerPeriod: b.quantity_per_period?.toString() ?? null,
                employerCostPerPeriod: b.employer_cost_per_period?.toString() ?? null,
                employeeContribution: (b.employee_contribution ?? dec('0')).toString(),
                allocationReference: b.allocation_reference ?? null,
                issuingOffice: b.issuing_office ?? null,
                state: 'draft',
                stateChangedAt: new Date(),
                createdBy: actorId,
              },
              select: { id: true },
            })
            .catch(dupEntitlement);
          const out = await entitlementOut(tx, await entitlementOrNotFound(tx, id));
          await auditCreate(tx, BENEFIT_ENTITLEMENT_AUDIT, id, out, { actorId });
          await recordStatusChange(tx, BENEFIT_ENTITLEMENT_AUDIT.type, id, null, 'draft', { actorId });
          return out;
        });
      },
      async update(id: bigint, version: number, b: z.infer<typeof PatchEntitlementBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await entitlementOrNotFound(tx, id);
          await canManage(before.estateId, id, 'update-entitlement', 'benefit');
          draftOnly(before.state, 'entitlement');
          const p = await tx.employmentProfile.findUniqueOrThrow({
            where: { id: before.employmentProfileId },
            select: { id: true, joiningDate: true, status: true },
          });
          const to = b.effective_to !== undefined ? b.effective_to : d(before.effectiveTo);
          await checkEntitlement(
            tx,
            p,
            {
              benefitTypeId: b.benefit_type_id ?? before.benefitTypeId,
              from: b.effective_from ?? businessDateFromDb(before.effectiveFrom),
              to,
            },
            id,
          );
          const data: Record<string, unknown> = {};
          if (b.benefit_type_id !== undefined) data.benefitTypeId = b.benefit_type_id;
          if (b.effective_from !== undefined) data.effectiveFrom = businessDateToDb(b.effective_from);
          if (b.effective_to !== undefined)
            data.effectiveTo = b.effective_to ? businessDateToDb(b.effective_to) : null;
          if (b.quantity_per_period !== undefined)
            data.quantityPerPeriod = b.quantity_per_period?.toString() ?? null;
          if (b.employer_cost_per_period !== undefined)
            data.employerCostPerPeriod = b.employer_cost_per_period?.toString() ?? null;
          if (b.employee_contribution !== undefined)
            data.employeeContribution = b.employee_contribution.toString();
          if (b.allocation_reference !== undefined) data.allocationReference = b.allocation_reference;
          if (b.issuing_office !== undefined) data.issuingOffice = b.issuing_office;
          const { count } = await tx.benefitEntitlement
            .updateMany({ where: { id, version }, data: { ...data, ...stamp(actorId) } })
            .catch(dupEntitlement);
          const old = await entitlementOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await entitlementOut(tx, await entitlementOrNotFound(tx, id));
          await auditUpdate(tx, BENEFIT_ENTITLEMENT_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async remove(id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const e = await entitlementOrNotFound(tx, id);
          await canManage(e.estateId, id, 'delete-entitlement', 'benefit');
          draftOnly(e.state, 'entitlement');
          const out = await entitlementOut(tx, e);
          await tx.benefitEntitlement.delete({ where: { id } });
          await auditDelete(tx, BENEFIT_ENTITLEMENT_AUDIT, id, out, { actorId });
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'benefit_entitlement', { id });
          const e = await entitlementOrNotFound(tx, id);
          await canManage(e.estateId, id, 'submit-entitlement', 'benefit');
          if (e.version !== version) versionConflict(e, await entitlementOut(tx, e));
          if (e.state !== 'draft')
            throw transition(
              `A ${e.state} entitlement cannot be submitted.`,
              e.state,
              'Only a draft is submitted.',
            );
          const now = new Date();
          await tx.benefitEntitlement.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, BENEFIT_ENTITLEMENT_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, ENTITLEMENT_DOCUMENT, id, { actorId, date: today() });
          return entitlementOut(tx, await entitlementOrNotFound(tx, id));
        });
      },
      /** Ends an approved entitlement on a date, with a reason; issues after it are refused. */
      async withdraw(id: bigint, version: number, to: BusinessDate, reason: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'benefit_entitlement', { id });
          const e = await entitlementOrNotFound(tx, id);
          await canManage(e.estateId, id, 'withdraw-entitlement', 'benefit');
          const old = await entitlementOut(tx, e);
          if (e.version !== version) versionConflict(e, old);
          if (e.state !== 'approved')
            throw transition(
              `A ${e.state} entitlement cannot be withdrawn.`,
              e.state,
              'Only an approved entitlement.',
            );
          const from = businessDateFromDb(e.effectiveFrom);
          const until = d(e.effectiveTo);
          if (to < from || (until !== null && to > until))
            throw Errors.validation([
              invalid('effective_to', `Within the entitlement, from ${from}${until ? ` to ${until}` : ''}.`),
            ]);
          const after_ = await tx.benefitIssue.count({
            where: {
              benefitEntitlementId: id,
              issueDate: { gt: businessDateToDb(to) },
              state: { not: 'rejected' },
            },
          });
          if (after_ > 0)
            throw Errors.validation([
              invalid('effective_to', `${String(after_)} issues fall after that date.`),
            ]);
          await tx.benefitEntitlement.update({
            where: { id },
            data: {
              state: 'withdrawn',
              stateChangedAt: new Date(),
              effectiveTo: businessDateToDb(to),
              withdrawalReason: reason,
              ...stamp(actorId),
            },
          });
          const out = await entitlementOut(tx, await entitlementOrNotFound(tx, id));
          await auditUpdate(tx, BENEFIT_ENTITLEMENT_AUDIT, id, old, out, { actorId, reason });
          await recordStatusChange(tx, BENEFIT_ENTITLEMENT_AUDIT.type, id, 'approved', 'withdrawn', {
            actorId,
            comment: reason,
          });
          return out;
        });
      },
    },

    issues: {
      async list(q: ListQuery) {
        const type = q.filters.find((f) => f.field === 'benefit_type_id');
        const profile = q.filters.find((f) => f.field === 'employment_profile_id');
        const rest = { ...q, filters: q.filters.filter((f) => f !== type && f !== profile) };
        const and: Prisma.BenefitIssueWhereInput[] = [toWhere(rest, ISSUE_LIST_FIELDS)];
        if (type) and.push({ entitlement: { benefitTypeId: idf(type.value) } });
        if (profile) and.push({ entitlement: { employmentProfileId: idf(profile.value) } });
        const where = { AND: and };
        const [rows, total] = await Promise.all([
          db.benefitIssue.findMany({
            where,
            include: issueInclude,
            orderBy: [...toOrderBy(q.sort, ISSUE_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.benefitIssue.count({ where }),
        ]);
        const p = await approvals(
          db,
          ISSUE_DOCUMENT,
          rows.filter((r) => r.state === 'submitted').map((r) => r.id),
        );
        return { items: rows.map((r) => toIssueOut(r, p.get(r.id) ?? null)), total };
      },
      async get(id: bigint) {
        return issueOut(db, await issueOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateIssueBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const e = await tx.benefitEntitlement.findUnique({
            where: { id: b.benefit_entitlement_id },
            include: entitlementInclude,
          });
          if (!e) throw Errors.validation([invalid('benefit_entitlement_id', 'No such entitlement.')]);
          await canManage(e.estateId, null, 'create-issue', 'benefit');
          return insertIssue(tx, e, b, actorId);
        });
      },
      /** This period's issue for every entitlement of the type at the estate in force on the date. */
      async generate(b: z.infer<typeof GenerateIssuesBody>, actorId: bigint) {
        await canManage(b.estate_id, null, 'generate-issues', 'benefit');
        const day = businessDateToDb(b.issue_date);
        const entitlements = await db.benefitEntitlement.findMany({
          where: {
            estateId: b.estate_id,
            benefitTypeId: b.benefit_type_id,
            state: { in: ['approved', 'withdrawn'] },
            effectiveFrom: { lte: day },
            OR: [{ effectiveTo: null }, { effectiveTo: { gte: day } }],
          },
          include: entitlementInclude,
        });
        let created = 0;
        let existing = 0;
        for (const e of entitlements) {
          if ((await db.benefitIssue.count({ where: { benefitEntitlementId: e.id, issueDate: day } })) > 0) {
            existing += 1;
            continue;
          }
          await withTransaction(db, (tx) =>
            insertIssue(
              tx,
              e,
              { issue_date: b.issue_date, period_reference: b.period_reference ?? null },
              actorId,
            ),
          );
          created += 1;
        }
        return { created, existing };
      },
      async remove(id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const i = await issueOrNotFound(tx, id);
          await canManage(i.estateId, id, 'delete-issue', 'benefit');
          draftOnly(i.state, 'issue');
          const out = await issueOut(tx, i);
          await tx.benefitIssue.delete({ where: { id } });
          await auditDelete(tx, BENEFIT_ISSUE_AUDIT, id, out, { actorId });
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'benefit_issue', { id });
          const i = await issueOrNotFound(tx, id);
          await canManage(i.estateId, id, 'submit-issue', 'benefit');
          if (i.version !== version) versionConflict(i, await issueOut(tx, i));
          if (i.state !== 'draft')
            throw transition(
              `A ${i.state} issue cannot be submitted.`,
              i.state,
              'Only a draft is submitted.',
            );
          const now = new Date();
          await tx.benefitIssue.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, BENEFIT_ISSUE_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, ISSUE_DOCUMENT, id, { actorId, date: today() });
          return issueOut(tx, await issueOrNotFound(tx, id));
        });
      },
    },

    cases: {
      async list(q: ListQuery) {
        const where = toWhere(q, CASE_LIST_FIELDS) as Prisma.WelfareCaseWhereInput;
        const [rows, total] = await Promise.all([
          db.welfareCase.findMany({
            where,
            orderBy: [...toOrderBy(q.sort, CASE_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.welfareCase.count({ where }),
        ]);
        const items: CaseOutT[] = [];
        for (const r of rows) items.push(await caseOut(db, r));
        return { items, total };
      },
      async get(id: bigint) {
        return caseOut(db, await caseOrNotFound(db, id));
      },
      async create(b: z.infer<typeof CreateCaseBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const estate = await tx.estate.findUnique({
            where: { id: b.estate_id },
            select: { id: true, code: true, status: true },
          });
          if (estate?.status !== 'active')
            throw Errors.validation([invalid('estate_id', 'No such active estate.')]);
          await canManage(estate.id, null, 'create-case', 'welfare');
          await checkBeneficiary(tx, estate.id, b.beneficiary_type, b.beneficiary_id ?? null);
          if (b.case_date > today())
            throw Errors.validation([invalid('case_date', 'Cannot be in the future.')]);
          const { number } = await allocateNumber(
            tx,
            CASE_DOCUMENT,
            { date: b.case_date, estateCode: estate.code },
            'draft',
          );
          const c = await tx.welfareCase.create({
            data: {
              caseNumber: number,
              estateId: estate.id,
              beneficiaryType: b.beneficiary_type,
              beneficiaryId: b.beneficiary_id ?? null,
              welfareCategory: b.welfare_category,
              caseDate: businessDateToDb(b.case_date),
              description: b.description,
              requestedAmount: b.requested_amount?.toString() ?? null,
              state: 'draft',
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
          });
          const out = await caseOut(tx, c);
          await auditCreate(tx, WELFARE_CASE_AUDIT, c.id, out, { actorId });
          await recordStatusChange(tx, WELFARE_CASE_AUDIT.type, c.id, null, 'draft', { actorId });
          return out;
        });
      },
      async update(id: bigint, version: number, b: z.infer<typeof PatchCaseBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await caseOrNotFound(tx, id);
          await canManage(before.estateId, id, 'update-case', 'welfare');
          draftOnly(before.state, 'case');
          const type = b.beneficiary_type ?? before.beneficiaryType;
          const who = b.beneficiary_id !== undefined ? b.beneficiary_id : before.beneficiaryId;
          await checkBeneficiary(tx, before.estateId, type, who);
          const data: Record<string, unknown> = { beneficiaryType: type, beneficiaryId: who };
          if (b.welfare_category !== undefined) data.welfareCategory = b.welfare_category;
          if (b.case_date !== undefined) data.caseDate = businessDateToDb(b.case_date);
          if (b.description !== undefined) data.description = b.description;
          if (b.requested_amount !== undefined) data.requestedAmount = b.requested_amount?.toString() ?? null;
          const { count } = await tx.welfareCase.updateMany({
            where: { id, version },
            data: { ...data, ...stamp(actorId) },
          });
          const old = await caseOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await caseOut(tx, await caseOrNotFound(tx, id));
          await auditUpdate(tx, WELFARE_CASE_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async remove(id: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const c = await caseOrNotFound(tx, id);
          await canManage(c.estateId, id, 'delete-case', 'welfare');
          draftOnly(c.state, 'case');
          const out = await caseOut(tx, c);
          await tx.welfareCase.delete({ where: { id } });
          await auditDelete(tx, WELFARE_CASE_AUDIT, id, out, { actorId });
        });
      },
      async submit(id: bigint, version: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'welfare_case', { id });
          const c = await caseOrNotFound(tx, id);
          await canManage(c.estateId, id, 'submit-case', 'welfare');
          if (c.version !== version) versionConflict(c, await caseOut(tx, c));
          if (c.state !== 'draft')
            throw transition(`A ${c.state} case cannot be submitted.`, c.state, 'Only a draft is submitted.');
          if (c.requestedAmount === null)
            throw Errors.validation([
              invalid('requested_amount', 'State the amount requested before submitting.'),
            ]);
          const now = new Date();
          await tx.welfareCase.update({
            where: { id },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, WELFARE_CASE_AUDIT.type, id, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, CASE_DOCUMENT, id, { actorId, date: today() });
          return caseOut(tx, await caseOrNotFound(tx, id));
        });
      },
      /** Pays out part of the approved amount; never beyond it. */
      async disburse(id: bigint, version: number, amount: Dec, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'welfare_case', { id });
          const c = await caseOrNotFound(tx, id);
          await canManage(c.estateId, id, 'disburse-case', 'welfare');
          const old = await caseOut(tx, c);
          if (c.version !== version) versionConflict(c, old);
          if (c.state !== 'approved' || c.approvedAmount === null)
            throw transition(`A ${c.state} case cannot be disbursed.`, c.state, 'Only an approved case.');
          const remaining = dec(c.approvedAmount.toString()).minus(c.disbursedAmount.toString());
          if (amount.gt(remaining))
            throw Errors.validation([
              invalid(
                'amount',
                `Only ${toDecimalString(remaining, 'money')} remains of the approved amount.`,
              ),
            ]);
          await tx.welfareCase.update({
            where: { id },
            data: { disbursedAmount: { increment: amount.toString() }, ...stamp(actorId) },
          });
          const after = await caseOut(tx, await caseOrNotFound(tx, id));
          await auditUpdate(tx, WELFARE_CASE_AUDIT, id, old, after, { actorId });
          return after;
        });
      },
      async close(id: bigint, version: number, outcome: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const c = await caseOrNotFound(tx, id);
          await canManage(c.estateId, id, 'close-case', 'welfare');
          const old = await caseOut(tx, c);
          if (c.version !== version) versionConflict(c, old);
          if (c.state !== 'approved')
            throw transition(`A ${c.state} case cannot be closed.`, c.state, 'Only an approved case.');
          await tx.welfareCase.update({
            where: { id },
            data: { state: 'closed', stateChangedAt: new Date(), outcome, ...stamp(actorId) },
          });
          const after = await caseOut(tx, await caseOrNotFound(tx, id));
          await auditUpdate(tx, WELFARE_CASE_AUDIT, id, old, after, { actorId });
          await recordStatusChange(tx, WELFARE_CASE_AUDIT.type, id, 'approved', 'closed', {
            actorId,
            comment: outcome,
          });
          return after;
        });
      },
    },
  };
}

export type BenefitService = ReturnType<typeof benefitService>;
