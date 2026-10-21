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
import type { ApprovalAdapter, ApprovalContext, SubmittedDocument } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, sum, toDecimalString, type Dec } from '../../core/money/decimal.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idIn, idOut, iso, versionConflict, writable } from '../organisation/common.js';
import type {
  AssignmentOut,
  CreateAssignmentBody,
  CurrentAssignmentOut,
  PatchAssignmentBody,
} from './assignment.schema.js';

/**
 * Employment assignments (P2.03; Spec P3 §8.3, P4 §6.5, P7 §9.6, P1 §5.5; the manager's design, D-2-3).
 *
 *   draft ──submit──► submitted ──approved (workflow)──► approved ──(next one approved)──► closed
 *     ▲                  │  │                               (effective_to = the day before it)
 *     └──── return ──────┘  └──reject──► rejected
 *
 *   - A change of department, designation, place, task, shift or pay is a NEW assignment starting on its
 *     date. The approved one before it is closed the day before, on APPROVAL (closing earlier would leave
 *     the profile without an assignment while the change waits). Nothing is updated in place after a
 *     draft: payroll and cost attribution of any past date resolve the row in force then.
 *   - What a new assignment leaves out is carried over from the latest approved one (a transfer names
 *     only the new section); an explicit null clears it.
 *   - A wage change (wage basis, base rate or salary lines differ from the assignment it follows) goes
 *     through the approval engine (P7 §9.6). Any other change takes effect when submitted: most master
 *     records need no approval.
 *   - The first assignment starts on the joining date with reason `joining`; each later one starts after
 *     the latest approved one. One pending change per profile at a time; one per start date.
 *   - Scope: the profile's estate, and the division, section or department it names; everyone sees their
 *     own (self). Writes need the estate.
 */

type AssignmentOutT = z.infer<typeof AssignmentOut>;
type Body = z.infer<typeof PatchAssignmentBody>;
type PayLineIn = NonNullable<Body['pay_lines']>[number];

export const ASSIGNMENT_DOCUMENT = 'employment_assignment';

export const ASSIGNMENT_AUDIT: AuditedRecord = {
  type: ASSIGNMENT_DOCUMENT,
  class: 'master',
  fields: [
    'employment_profile_id',
    'department_id',
    'designation_id',
    'division_id',
    'section_id',
    'activity_type_id',
    'cost_centre_id',
    'default_shift_id',
    'wage_basis',
    'base_rate',
    'pay_lines',
    'effective_from',
    'effective_to',
    'change_reason',
    'remarks',
    'is_wage_change',
    'is_retrospective',
    'state',
    'rejection_reason',
  ],
};

const ref = { select: { id: true, code: true, name: true } } as const;
const user = { select: { id: true, username: true } } as const;
export const assignmentInclude = {
  profile: {
    select: {
      id: true,
      profileNumber: true,
      employmentType: true,
      estateId: true,
      joiningDate: true,
      status: true,
      person: { select: { fullName: true } },
    },
  },
  department: ref,
  designation: ref,
  division: ref,
  section: ref,
  activityType: ref,
  defaultShift: ref,
  payLines: { select: { component: true, amount: true }, orderBy: { id: 'asc' } },
  creator: user,
  submitter: user,
  approver: user,
} as const satisfies Prisma.EmploymentAssignmentInclude;

type Row = Prisma.EmploymentAssignmentGetPayload<{ include: typeof assignmentInclude }>;

/** The current assignment of a profile, for the profile lists (approved, in force today). */
export const currentAssignmentInclude = (today: BusinessDate) =>
  ({
    where: inForce(today),
    select: {
      id: true,
      effectiveFrom: true,
      wageBasis: true,
      department: ref,
      designation: ref,
      division: ref,
      section: ref,
      activityType: ref,
    },
    orderBy: { effectiveFrom: 'desc' },
    take: 1,
  }) as const satisfies Prisma.EmploymentProfile$assignmentsArgs;

/** Approved and in force on the date. */
export function inForce(date: BusinessDate): Prisma.EmploymentAssignmentWhereInput {
  const d = businessDateToDb(date);
  return {
    state: 'approved',
    effectiveFrom: { lte: d },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }],
  };
}

type RefRow = { id: bigint; code: string; name: string } | null;
const refOut = (r: RefRow) => (r ? { id: r.id.toString(), code: r.code, name: r.name } : null);

export function currentAssignmentOut(
  rows: readonly {
    id: bigint;
    effectiveFrom: Date;
    wageBasis: string;
    department: RefRow;
    designation: RefRow;
    division: RefRow;
    section: RefRow;
    activityType: RefRow;
  }[],
): z.infer<typeof CurrentAssignmentOut> {
  const a = rows[0];
  if (!a) return null;
  return {
    id: a.id.toString(),
    effective_from: businessDateFromDb(a.effectiveFrom),
    department: refOut(a.department),
    designation: refOut(a.designation),
    division: refOut(a.division),
    section: refOut(a.section),
    activity_type: refOut(a.activityType),
    wage_basis: a.wageBasis as AssignmentOutT['wage_basis'],
  };
}

export const ASSIGNMENT_LIST_FIELDS: ListFieldMap = {
  employment_profile_id: { field: 'employmentProfileId', convert: (v) => BigInt(String(v)) },
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  department_id: { field: 'departmentId', convert: (v) => BigInt(String(v)) },
  designation_id: { field: 'designationId', convert: (v) => BigInt(String(v)) },
  division_id: { field: 'divisionId', convert: (v) => BigInt(String(v)) },
  section_id: { field: 'sectionId', convert: (v) => BigInt(String(v)) },
  activity_type_id: { field: 'activityTypeId', convert: (v) => BigInt(String(v)) },
  state: { field: 'state' },
  change_reason: { field: 'changeReason' },
  wage_basis: { field: 'wageBasis' },
  is_wage_change: { field: 'isWageChange' },
  effective_from: { field: 'effectiveFrom' },
  created_at: { field: 'createdAt' },
};

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const money = (v: Prisma.Decimal | null) => (v === null ? null : toDecimalString(v, 'money'));
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);

/** The values an assignment holds, whatever their source (a body merged over the one it follows). */
interface Terms {
  departmentId: bigint | null;
  designationId: bigint | null;
  divisionId: bigint | null;
  sectionId: bigint | null;
  activityTypeId: bigint | null;
  costCentreId: bigint | null;
  defaultShiftId: bigint | null;
  wageBasis: string;
  baseRate: Dec | null;
  effectiveFrom: BusinessDate;
  changeReason: string;
  remarks: string | null;
  payLines: { component: string; amount: Dec }[];
}

function termsOf(a: {
  departmentId: bigint | null;
  designationId: bigint | null;
  divisionId: bigint | null;
  sectionId: bigint | null;
  activityTypeId: bigint | null;
  costCentreId: bigint | null;
  defaultShiftId: bigint | null;
  wageBasis: string;
  baseRate: Prisma.Decimal | null;
  effectiveFrom: Date;
  changeReason: string;
  remarks: string | null;
  payLines: { component: string; amount: Prisma.Decimal }[];
}): Terms {
  return {
    departmentId: a.departmentId,
    designationId: a.designationId,
    divisionId: a.divisionId,
    sectionId: a.sectionId,
    activityTypeId: a.activityTypeId,
    costCentreId: a.costCentreId,
    defaultShiftId: a.defaultShiftId,
    wageBasis: a.wageBasis,
    baseRate: a.baseRate === null ? null : dec(a.baseRate.toString()),
    effectiveFrom: businessDateFromDb(a.effectiveFrom),
    changeReason: a.changeReason,
    remarks: a.remarks,
    payLines: a.payLines.map((l) => ({ component: l.component, amount: dec(l.amount.toString()) })),
  };
}

/** The body over a base: undefined keeps the base, null clears. */
function merge(base: Terms, b: Body): Terms {
  function pick<T>(v: T | undefined, kept: T): T {
    if (v === undefined) return kept;
    return v;
  }
  const id = (v: string | bigint | null | undefined, kept: bigint | null) =>
    v === undefined ? kept : idIn(v);
  return {
    departmentId: id(b.department_id, base.departmentId),
    designationId: id(b.designation_id, base.designationId),
    divisionId: id(b.division_id, base.divisionId),
    sectionId: id(b.section_id, base.sectionId),
    activityTypeId: id(b.activity_type_id, base.activityTypeId),
    costCentreId: id(b.cost_centre_id, base.costCentreId),
    defaultShiftId: id(b.default_shift_id, base.defaultShiftId),
    wageBasis: pick(b.wage_basis, base.wageBasis),
    baseRate: pick(b.base_rate, base.baseRate),
    effectiveFrom: pick(b.effective_from, base.effectiveFrom),
    changeReason: pick(b.change_reason, base.changeReason),
    remarks: pick(b.remarks, base.remarks),
    payLines: b.pay_lines === undefined ? base.payLines : b.pay_lines.map((l: PayLineIn) => ({ ...l })),
  };
}

const sameMoney = (a: Dec | null, b: Dec | null) => (a === null || b === null ? a === b : a.eq(b));

/** Whether the pay differs from the assignment it follows (P7 §9.6). */
export function isWageChange(next: Terms, previous: Terms | null): boolean {
  if (!previous) return next.baseRate !== null || next.payLines.length > 0;
  if (next.wageBasis !== previous.wageBasis || !sameMoney(next.baseRate, previous.baseRate)) return true;
  if (next.payLines.length !== previous.payLines.length) return true;
  const before = new Map(previous.payLines.map((l) => [l.component, l.amount]));
  return next.payLines.some((l) => {
    return !before.get(l.component)?.eq(l.amount);
  });
}

export interface AssignmentServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function assignmentService({ db, accessLog, timezone }: AssignmentServiceDeps) {
  const today = () => todayIn(timezone);

  async function approvalIds(tx: Database | Tx, ids: readonly bigint[]): Promise<Map<bigint, bigint>> {
    if (ids.length === 0) return new Map();
    const rows = await tx.approvalRequest.findMany({
      where: { documentType: ASSIGNMENT_DOCUMENT, documentId: { in: [...ids] }, state: 'pending' },
      select: { id: true, documentId: true },
    });
    return new Map(rows.map((r) => [r.documentId, r.id]));
  }

  function toOut(a: Row, approvalId: bigint | null): AssignmentOutT {
    const lines = a.payLines.map((l) => ({
      component: l.component as AssignmentOutT['pay_lines'][number]['component'],
      amount: toDecimalString(l.amount, 'money'),
    }));
    const from = businessDateFromDb(a.effectiveFrom);
    const to = d(a.effectiveTo);
    const t = today();
    return {
      id: a.id.toString(),
      employment_profile_id: a.employmentProfileId.toString(),
      profile: {
        id: a.profile.id.toString(),
        profile_number: a.profile.profileNumber,
        employment_type: a.profile.employmentType as AssignmentOutT['profile']['employment_type'],
        full_name: a.profile.person.fullName,
      },
      estate_id: a.estateId.toString(),
      department_id: idOut(a.departmentId),
      department: refOut(a.department),
      designation_id: idOut(a.designationId),
      designation: refOut(a.designation),
      division_id: idOut(a.divisionId),
      division: refOut(a.division),
      section_id: idOut(a.sectionId),
      section: refOut(a.section),
      activity_type_id: idOut(a.activityTypeId),
      activity_type: refOut(a.activityType),
      cost_centre_id: idOut(a.costCentreId),
      default_shift_id: idOut(a.defaultShiftId),
      default_shift: refOut(a.defaultShift),
      wage_basis: a.wageBasis as AssignmentOutT['wage_basis'],
      base_rate: money(a.baseRate),
      pay_lines: lines,
      total_pay: lines.length === 0 ? null : money(sum(a.payLines.map((l) => dec(l.amount.toString())))),
      effective_from: from,
      effective_to: to,
      change_reason: a.changeReason as AssignmentOutT['change_reason'],
      remarks: a.remarks,
      is_wage_change: a.isWageChange,
      is_retrospective: a.isRetrospective,
      state: a.state as AssignmentOutT['state'],
      is_current: a.state === 'approved' && from <= t && (to === null || to >= t),
      approval_id: idOut(approvalId),
      submitted_at: iso(a.submittedAt),
      submitted_by: a.submitter ? { id: a.submitter.id.toString(), username: a.submitter.username } : null,
      approved_at: iso(a.approvedAt),
      approved_by: a.approver ? { id: a.approver.id.toString(), username: a.approver.username } : null,
      rejected_at: iso(a.rejectedAt),
      rejection_reason: a.rejectionReason,
      created_by: { id: a.creator.id.toString(), username: a.creator.username },
      version: a.version,
      created_at: a.createdAt.toISOString(),
      updated_at: iso(a.updatedAt),
    };
  }
  async function outOf(tx: Database | Tx, a: Row) {
    const pending = a.state === 'submitted' ? await approvalIds(tx, [a.id]) : new Map<bigint, bigint>();
    return toOut(a, pending.get(a.id) ?? null);
  }

  async function orNotFound(tx: Database | Tx, id: bigint): Promise<Row> {
    const a = await tx.employmentAssignment.findUnique({ where: { id }, include: assignmentInclude });
    if (!a) throw Errors.notFound('Employment assignment not found.');
    return a;
  }
  async function profileOrNotFound(tx: Database | Tx, id: bigint) {
    const p = await tx.employmentProfile.findUnique({
      where: { id },
      select: {
        id: true,
        estateId: true,
        employmentType: true,
        joiningDate: true,
        status: true,
        profileNumber: true,
      },
    });
    if (!p) throw Errors.notFound('Employment profile not found.');
    return p;
  }
  type Profile = Awaited<ReturnType<typeof profileOrNotFound>>;

  const canWrite = (estateId: bigint, id: bigint | null, operation: string) =>
    writable({ estate: estateId }).then((ok) =>
      ok ? undefined : denyWrite(accessLog, 'employment', id, operation),
    );

  /** The latest approved assignment of the profile (the one a new one follows), with its terms. */
  async function latestApproved(tx: Database | Tx, profileId: bigint, before?: BusinessDate) {
    return tx.employmentAssignment.findFirst({
      where: {
        employmentProfileId: profileId,
        state: 'approved',
        ...(before ? { effectiveFrom: { lt: businessDateToDb(before) } } : {}),
      },
      include: assignmentInclude,
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  /** Every check of an assignment's terms, as field errors (create, change and again on submit). */
  async function validate(tx: Database | Tx, t: Terms, p: Profile, previous: Row | null) {
    const problems: ErrorDetail[] = [];
    const joining = businessDateFromDb(p.joiningDate);
    if (!previous) {
      if (t.effectiveFrom !== joining) {
        problems.push(
          invalid('effective_from', `The first assignment starts on the joining date, ${joining}.`),
        );
      }
      if (t.changeReason !== 'joining') {
        problems.push(invalid('change_reason', 'The first assignment is the joining one.'));
      }
    } else {
      const last = businessDateFromDb(previous.effectiveFrom);
      if (t.effectiveFrom <= last) {
        problems.push(
          invalid('effective_from', `Must be after ${last}, when the current assignment started.`),
        );
      }
      if (t.changeReason === 'joining') {
        problems.push(invalid('change_reason', 'Only the first assignment is the joining one.'));
      }
    }
    if (p.employmentType === 'employee') {
      if (t.departmentId === null) problems.push(invalid('department_id', 'An employee has a department.'));
      if (t.designationId === null)
        problems.push(invalid('designation_id', 'An employee has a designation.'));
    } else {
      if (t.sectionId === null) problems.push(invalid('section_id', 'A worker works in a section.'));
      if (t.activityTypeId === null) problems.push(invalid('activity_type_id', 'A worker has a job / task.'));
    }
    if (t.costCentreId !== null) {
      problems.push(
        invalid('cost_centre_id', 'Cost centres arrive with accounting (Phase 3): leave it empty.'),
      );
    }
    const active = async (
      field: string,
      what: string,
      id: bigint | null,
      find: (id: bigint) => Promise<{ status: string } | null>,
    ) => {
      if (id === null) return;
      if ((await find(id))?.status !== 'active') problems.push(invalid(field, `No such active ${what}.`));
    };
    await active('department_id', 'department', t.departmentId, (id) =>
      tx.department.findUnique({ where: { id }, select: { status: true } }),
    );
    await active('designation_id', 'designation', t.designationId, (id) =>
      tx.designation.findUnique({ where: { id }, select: { status: true } }),
    );
    await active('activity_type_id', 'job / task', t.activityTypeId, (id) =>
      tx.activityType.findUnique({ where: { id }, select: { status: true } }),
    );
    if (t.defaultShiftId !== null) {
      const s = await tx.shift.findUnique({
        where: { id: t.defaultShiftId },
        select: { status: true, estateId: true },
      });
      if (s?.status !== 'active' || (s.estateId !== null && s.estateId !== p.estateId)) {
        problems.push(invalid('default_shift_id', 'No such active shift for this estate.'));
      }
    }
    // The hierarchy is read whatever the caller's grant: a section grant still names its division.
    if (t.divisionId !== null) {
      const v = await tx.division.findUnique({
        where: { id: t.divisionId },
        select: { estateId: true, status: true },
      });
      if (v?.estateId !== p.estateId || v.status !== 'active') {
        problems.push(invalid('division_id', 'No such active division in the profile’s estate.'));
      }
    }
    if (t.sectionId !== null) {
      const s = await tx.section.findUnique({
        where: { id: t.sectionId },
        select: { divisionId: true, status: true, division: { select: { estateId: true } } },
      });
      if (s?.division.estateId !== p.estateId || s.status !== 'active') {
        problems.push(invalid('section_id', 'No such active section in the profile’s estate.'));
      } else if (t.divisionId !== null && s.divisionId !== t.divisionId) {
        problems.push(invalid('section_id', 'The section is not in that division.'));
      }
    }
    if (t.wageBasis === 'monthly' && p.employmentType === 'employee' && t.payLines.length > 0) {
      if (!t.payLines.some((l) => l.component === 'basic')) {
        problems.push(invalid('pay_lines', 'A salary structure has a basic salary.'));
      }
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  /** A new section without a division moves the division with it (the division is then the section's). */
  const sectionLeads = <B extends Body>(b: B): B =>
    b.section_id !== undefined && b.division_id === undefined ? { ...b, division_id: null } : b;

  /** The division a section belongs to fills an omitted division (the design asks for the section only). */
  async function withDivision(tx: Database | Tx, t: Terms): Promise<Terms> {
    if (t.sectionId === null || t.divisionId !== null) return t;
    const s = await tx.section.findUnique({ where: { id: t.sectionId }, select: { divisionId: true } });
    return s ? { ...t, divisionId: s.divisionId } : t;
  }

  const columns = (t: Terms) => ({
    departmentId: t.departmentId,
    designationId: t.designationId,
    divisionId: t.divisionId,
    sectionId: t.sectionId,
    activityTypeId: t.activityTypeId,
    costCentreId: t.costCentreId,
    defaultShiftId: t.defaultShiftId,
    wageBasis: t.wageBasis,
    baseRate: t.baseRate === null ? null : t.baseRate.toString(),
    effectiveFrom: businessDateToDb(t.effectiveFrom),
    changeReason: t.changeReason,
    remarks: t.remarks,
  });
  async function replaceLines(tx: Tx, id: bigint, lines: Terms['payLines']) {
    await tx.assignmentPayLine.deleteMany({ where: { assignmentId: id } });
    if (lines.length > 0) {
      await tx.assignmentPayLine.createMany({
        data: lines.map((l) => ({ assignmentId: id, component: l.component, amount: l.amount.toString() })),
      });
    }
  }

  const onUnique = (err: unknown): never => {
    const v = constraintViolation(err);
    if (v?.kind === 'unique' && v.index.includes('ux_assignment_open')) {
      throw new AppError(
        'DUPLICATE_KEY',
        'This profile already has a change awaiting submission or approval.',
        [
          {
            field: 'employment_profile_id',
            code: 'DUPLICATE_KEY',
            message: 'Finish, withdraw or wait for the pending assignment first.',
          },
        ],
      );
    }
    if (v?.kind === 'unique' && v.index.includes('ux_assignment_effective')) {
      throw new AppError('DUPLICATE_KEY', 'This profile already has an assignment starting on that date.', [
        { field: 'effective_from', code: 'DUPLICATE_KEY', message: 'Choose another date.' },
      ]);
    }
    throw err;
  };

  const notSeparated = (p: Profile) => {
    if (p.status === 'separated') {
      throw transition('A separated profile cannot be changed.', p.status, 'Open a new profile instead.');
    }
  };
  const draftOnly = (a: Row, what: string) => {
    if (a.state !== 'draft') {
      throw transition(
        `A ${a.state} assignment cannot be ${what}.`,
        a.state,
        a.state === 'approved'
          ? 'Create the next assignment from the date the change takes effect.'
          : 'Only a draft is changed.',
      );
    }
  };

  /** Puts a submitted assignment into effect: closes the one it follows. Shared by the adapter. */
  async function putIntoEffect(tx: Tx, id: bigint, actorId: bigint, actingForUserId: bigint | null) {
    await lockRowsForUpdate(tx, 'employment_assignment', { id });
    const a = await orNotFound(tx, id);
    if (a.state !== 'submitted')
      throw transition(`A ${a.state} assignment cannot be approved.`, a.state, 'Reload it.');
    if (a.profile.status === 'separated') {
      throw transition('The profile was separated meanwhile.', a.profile.status, 'Reject this change.');
    }
    const from = businessDateFromDb(a.effectiveFrom);
    // Other approved rows of the profile, locked: the timeline changes under this lock only.
    await lockRowsForUpdate(tx, 'employment_profile', { id: a.employmentProfileId });
    const later = await tx.employmentAssignment.count({
      where: {
        employmentProfileId: a.employmentProfileId,
        state: 'approved',
        effectiveFrom: { gte: a.effectiveFrom },
      },
    });
    if (later > 0) {
      throw transition(
        'An assignment starting on or after this one was approved meanwhile.',
        a.state,
        'Reject this change.',
      );
    }
    const previous = await latestApproved(tx, a.employmentProfileId, from);
    if (previous?.effectiveTo === null) {
      const closeOn = businessDateToDb(addDays(from, -1));
      await tx.employmentAssignment.update({
        where: { id: previous.id },
        data: { effectiveTo: closeOn, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
      });
      await auditUpdate(
        tx,
        ASSIGNMENT_AUDIT,
        previous.id,
        { effective_to: null },
        { effective_to: addDays(from, -1) },
        { actorId },
      );
    }
    const now = new Date();
    await tx.employmentAssignment.update({
      where: { id },
      data: {
        state: 'approved',
        stateChangedAt: now,
        approvedAt: now,
        approvedBy: actorId,
        version: { increment: 1 },
        updatedAt: now,
        updatedBy: actorId,
      },
    });
    await auditAction(tx, ASSIGNMENT_AUDIT, id, 'approve', { actorId, actingForUserId });
    await recordStatusChange(tx, ASSIGNMENT_AUDIT.type, id, 'submitted', 'approved', { actorId });
  }

  const adapter: ApprovalAdapter = {
    documentType: ASSIGNMENT_DOCUMENT,
    async describe(tx, id): Promise<SubmittedDocument> {
      const a = await orNotFound(tx, id);
      const total = a.payLines.length === 0 ? null : sum(a.payLines.map((l) => dec(l.amount.toString())));
      const amount = total ?? (a.baseRate === null ? null : dec(a.baseRate.toString()));
      return {
        id,
        number: null,
        label: `${a.profile.profileNumber} · ${a.profile.person.fullName} · ${a.changeReason.replace('_', ' ')} from ${businessDateFromDb(a.effectiveFrom)}`,
        createdBy: a.createdBy,
        estateId: a.estateId,
        departmentId: a.departmentId,
        values: {
          estate_id: a.estateId.toString(),
          department_id: idOut(a.departmentId),
          is_wage_change: a.isWageChange,
          is_retrospective: a.isRetrospective,
          change_reason: a.changeReason,
          employment_type: a.profile.employmentType,
        },
        amount: amount === null ? null : amount.toFixed(2),
        isExceptional: a.isRetrospective,
      };
    },
    async onApproved(tx, id, ctx: ApprovalContext) {
      await putIntoEffect(tx, id, ctx.actorId, ctx.actingForUserId);
    },
    async onRejected(tx, id, ctx) {
      const a = await orNotFound(tx, id);
      const now = new Date();
      await tx.employmentAssignment.update({
        where: { id },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          version: { increment: 1 },
          updatedAt: now,
          updatedBy: ctx.actorId,
        },
      });
      await auditAction(tx, ASSIGNMENT_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, ASSIGNMENT_AUDIT.type, id, a.state, 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      const a = await orNotFound(tx, id);
      const now = new Date();
      await tx.employmentAssignment.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: now,
          submittedAt: null,
          submittedBy: null,
          version: { increment: 1 },
          updatedAt: now,
          updatedBy: ctx.actorId,
        },
      });
      await recordStatusChange(tx, ASSIGNMENT_AUDIT.type, id, a.state, 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  return {
    adapter,

    async list(q: ListQuery) {
      const where = toWhere(q, ASSIGNMENT_LIST_FIELDS) as Prisma.EmploymentAssignmentWhereInput;
      const [rows, total] = await Promise.all([
        db.employmentAssignment.findMany({
          where,
          include: assignmentInclude,
          orderBy: [...toOrderBy(q.sort, ASSIGNMENT_LIST_FIELDS), { id: 'desc' }],
          ...toPaging(q),
        }),
        db.employmentAssignment.count({ where }),
      ]);
      const pending = await approvalIds(
        db,
        rows.filter((r) => r.state === 'submitted').map((r) => r.id),
      );
      return { items: rows.map((r) => toOut(r, pending.get(r.id) ?? null)), total };
    },

    /** GET /employment-profiles/{id}/assignments: the timeline, latest first (drafts and rejections too). */
    async ofProfile(profileId: bigint) {
      await profileOrNotFound(db, profileId);
      const rows = await db.employmentAssignment.findMany({
        where: { employmentProfileId: profileId },
        include: assignmentInclude,
        orderBy: [{ effectiveFrom: 'desc' }, { id: 'desc' }],
      });
      const pending = await approvalIds(
        db,
        rows.filter((r) => r.state === 'submitted').map((r) => r.id),
      );
      return rows.map((r) => toOut(r, pending.get(r.id) ?? null));
    },

    /** The approved assignment in force on a date (P13 §12.1: last month's register shows last month's division). */
    async resolve(profileId: bigint, asOf: BusinessDate | undefined) {
      await profileOrNotFound(db, profileId);
      const date = asOf ?? today();
      const a = await db.employmentAssignment.findFirst({
        where: { employmentProfileId: profileId, ...inForce(date) },
        include: assignmentInclude,
        orderBy: { effectiveFrom: 'desc' },
      });
      if (!a) throw Errors.notFound(`No assignment is in force on ${date}.`);
      return toOut(a, null);
    },

    async get(id: bigint) {
      return outOf(db, await orNotFound(db, id));
    },

    async create(profileId: bigint, body: z.infer<typeof CreateAssignmentBody>, actorId: bigint) {
      return withTransaction(db, (tx) => this.createIn(tx, profileId, body, actorId));
    },

    /** The same inside the caller's transaction (the workforce import, P2.06). */
    async createIn(tx: Tx, profileId: bigint, body: z.infer<typeof CreateAssignmentBody>, actorId: bigint) {
      const p = await profileOrNotFound(tx, profileId);
      await canWrite(p.estateId, null, 'create');
      notSeparated(p);
      const previous = await latestApproved(tx, profileId);
      const blank: Terms = {
        departmentId: null,
        designationId: null,
        divisionId: null,
        sectionId: null,
        activityTypeId: null,
        costCentreId: null,
        defaultShiftId: null,
        wageBasis: p.employmentType === 'worker' ? 'daily' : 'monthly',
        baseRate: null,
        effectiveFrom: body.effective_from,
        changeReason: previous ? 'other' : 'joining',
        remarks: null,
        payLines: [],
      };
      // A later assignment carries over what it does not change; its reason and remarks are its own.
      const base = previous ? { ...termsOf(previous), changeReason: 'other', remarks: null } : blank;
      const terms = await withDivision(tx, merge(base, sectionLeads(body)));
      await validate(tx, terms, p, previous);
      const { id } = await tx.employmentAssignment
        .create({
          data: {
            ...columns(terms),
            employmentProfileId: profileId,
            estateId: p.estateId,
            state: 'draft',
            stateChangedAt: new Date(),
            createdBy: actorId,
          },
          select: { id: true },
        })
        .catch(onUnique);
      await replaceLines(tx, id, terms.payLines);
      const out = await outOf(tx, await orNotFound(tx, id));
      await auditCreate(tx, ASSIGNMENT_AUDIT, id, out, { actorId });
      await recordStatusChange(tx, ASSIGNMENT_AUDIT.type, id, null, 'draft', { actorId });
      return out;
    },

    async update(id: bigint, expectedVersion: number, changes: Body, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await canWrite(before.estateId, id, 'update');
        draftOnly(before, 'changed');
        const p = await profileOrNotFound(tx, before.employmentProfileId);
        notSeparated(p);
        const terms = await withDivision(tx, merge(termsOf(before), sectionLeads(changes)));
        await validate(tx, terms, p, await latestApproved(tx, p.id));
        const { count } = await tx.employmentAssignment
          .updateMany({
            where: { id, version: expectedVersion },
            data: { ...columns(terms), version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
          })
          .catch(onUnique);
        if (count !== 1) versionConflict(before, await outOf(tx, before));
        await replaceLines(tx, id, terms.payLines);
        const after = await outOf(tx, await orNotFound(tx, id));
        await auditUpdate(tx, ASSIGNMENT_AUDIT, id, await outOf(tx, before), after, { actorId });
        return after;
      });
    },

    /** Only a draft: a submitted change is withdrawn by the approver returning or rejecting it. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const a = await orNotFound(tx, id);
        await canWrite(a.estateId, id, 'delete');
        draftOnly(a, 'deleted');
        const out = await outOf(tx, a);
        await tx.assignmentPayLine.deleteMany({ where: { assignmentId: id } });
        await tx.employmentAssignment.delete({ where: { id } });
        await auditDelete(tx, ASSIGNMENT_AUDIT, id, out, { actorId });
      });
    },

    /**
     * POST /submit: a wage change is routed through the approval engine (P7 §9.6); any other change takes
     * effect at once. Either way the result says where it stands (state, approval_id).
     */
    async submit(id: bigint, expectedVersion: number, actorId: bigint) {
      return withTransaction(db, (tx) => this.submitIn(tx, id, expectedVersion, actorId));
    },

    /**
     * The same inside the caller's transaction. `wageApprovedBy`: the workforce import's commit, where
     * whoever commits a file with salaries approves them (D-2.06-3): the wage change takes effect, approved
     * by them, instead of waiting in the queue.
     */
    async submitIn(
      tx: Tx,
      id: bigint,
      expectedVersion: number | null,
      actorId: bigint,
      opts: { readonly wageApprovedBy?: bigint } = {},
    ) {
      await lockRowsForUpdate(tx, 'employment_assignment', { id });
      const a = await orNotFound(tx, id);
      await canWrite(a.estateId, id, 'submit');
      if (expectedVersion !== null && a.version !== expectedVersion) versionConflict(a, await outOf(tx, a));
      draftOnly(a, 'submitted');
      const p = await profileOrNotFound(tx, a.employmentProfileId);
      notSeparated(p);
      const terms = termsOf(a);
      const previous = await latestApproved(tx, p.id);
      await validate(tx, terms, p, previous);
      const wage = isWageChange(terms, previous ? termsOf(previous) : null);
      const t = today();
      const now = new Date();
      await tx.employmentAssignment.update({
        where: { id },
        data: {
          state: 'submitted',
          stateChangedAt: now,
          submittedAt: now,
          submittedBy: actorId,
          isWageChange: wage,
          isRetrospective: terms.effectiveFrom < t,
          version: { increment: 1 },
          updatedAt: now,
          updatedBy: actorId,
        },
      });
      await recordStatusChange(tx, ASSIGNMENT_AUDIT.type, id, 'draft', 'submitted', { actorId });
      if (wage && opts.wageApprovedBy === undefined) {
        await submitForApproval(tx, { timezone }, ASSIGNMENT_DOCUMENT, id, { actorId, date: t });
      } else {
        await putIntoEffect(tx, id, opts.wageApprovedBy ?? actorId, null);
      }
      return outOf(tx, await orNotFound(tx, id));
    },
  };
}

export type AssignmentService = ReturnType<typeof assignmentService>;
