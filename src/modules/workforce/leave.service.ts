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
import type { ApprovalAdapter, SubmittedDocument } from '../../core/approval/adapters.js';
import { submitForApproval } from '../../core/approval/engine.js';
import { getRequestContext } from '../../core/context/request-context.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, round, toDecimalString, type Dec } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { runUnscoped, scopeToCheck } from '../../core/scope/scope.js';
import { readSetting } from '../../core/settings/settings.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idOut, iso, versionConflict } from '../organisation/common.js';
import type {
  CreateLeaveBody,
  EntitlementOut,
  GenerateBody,
  LeaveOut,
  PatchLeaveBody,
} from './leave.schema.js';

/**
 * Leave entitlements and leave requests (P2.07; Spec P3 §22, P9 §12, P7 §7.9).
 *
 *   entitlement  per profile, leave type and fiscal year, GENERATED (never typed): the type's annual
 *                days (interim source until statutory rules, Phase 9, D-2.07-1) pro-rata over the months
 *                the profile is employed in the year (LV.1), plus the previous year's balance carried
 *                forward, capped BEFORE adding (LV.2). An adjustment needs a reason (leave.approve).
 *   request      draft → submitted → approved, rejected, or returned (a draft again); an approved one may
 *                be cancelled, restoring the balance. Day count = working days (weekly offs excluded),
 *                a half day 0.5. The balance is checked when submitting and again on approval, under a
 *                lock on the entitlement row, where it is consumed; a type may allow a negative balance.
 *                Attendance for the dates is written from P5.02.
 *   self         everyone may file their own leave (P6 §6.1, self scope); for someone else it takes the
 *                estate.
 */

type EntitlementOutT = z.infer<typeof EntitlementOut>;
type LeaveOutT = z.infer<typeof LeaveOut>;

export const LEAVE_DOCUMENT = 'leave';
/** Weekday numbers (0 = Sunday … 6 = Saturday) that are not working days: the setting, else Friday. */
export const WEEKLY_OFF_SETTING = 'leave.weekly_off_days';
const DEFAULT_WEEKLY_OFF: readonly number[] = [5];

export const ENTITLEMENT_AUDIT: AuditedRecord = {
  type: 'leave_entitlement',
  class: 'master',
  fields: [
    'employment_profile_id',
    'leave_type_id',
    'fiscal_year_id',
    'entitled_days',
    'carried_forward_days',
    'adjustment_days',
    'adjustment_reason',
    'consumed_days',
  ],
};
export const LEAVE_AUDIT: AuditedRecord = {
  type: 'leave_request',
  class: 'operational',
  fields: [
    'employment_profile_id',
    'leave_type_id',
    'from_date',
    'to_date',
    'day_count',
    'is_half_day',
    'reason',
    'contact_during_leave',
    'covering_profile_id',
    'state',
    'rejection_reason',
    'cancellation_reason',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const ENTITLEMENT_LIST_FIELDS: ListFieldMap = {
  employment_profile_id: { field: 'employmentProfileId', convert: idf },
  leave_type_id: { field: 'leaveTypeId', convert: idf },
  fiscal_year_id: { field: 'fiscalYearId', convert: idf },
};
export const LEAVE_LIST_FIELDS: ListFieldMap = {
  employment_profile_id: { field: 'employmentProfileId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  leave_type_id: { field: 'leaveTypeId', convert: idf },
  state: { field: 'state' },
  from_date: { field: 'fromDate' },
  to_date: { field: 'toDate' },
  request_number: { field: 'requestNumber' },
  created_at: { field: 'createdAt' },
};

const ref = { select: { id: true, code: true, name: true } } as const;
const profileRef = {
  select: { id: true, profileNumber: true, person: { select: { fullName: true } } },
} as const;
const user = { select: { id: true, username: true } } as const;
const entitlementInclude = {
  profile: profileRef,
  leaveType: { select: { id: true, code: true, name: true, allowsNegativeBalance: true } },
  fiscalYear: { select: { id: true, code: true } },
} as const satisfies Prisma.LeaveEntitlementInclude;
type EntitlementRow = Prisma.LeaveEntitlementGetPayload<{ include: typeof entitlementInclude }>;
const leaveInclude = {
  profile: profileRef,
  leaveType: ref,
  covering: profileRef,
  entitlement: true,
  approver: user,
  creator: user,
} as const satisfies Prisma.LeaveRequestInclude;
type LeaveRow = Prisma.LeaveRequestGetPayload<{ include: typeof leaveInclude }>;

const pct = (v: Dec) => toDecimalString(v, 'pct');
const d = (v: Date | null) => (v ? businessDateFromDb(v) : null);
const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const refOut = (p: { id: bigint; profileNumber: string; person: { fullName: string } } | null) =>
  p ? { id: p.id.toString(), profile_number: p.profileNumber, full_name: p.person.fullName } : null;

/** Working days from `from` to `to` inclusive, the weekly offs excluded (P9 §12). */
export function workingDays(from: BusinessDate, to: BusinessDate, weeklyOff: readonly number[]): number {
  let n = 0;
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (!weeklyOff.includes(new Date(`${day}T00:00:00Z`).getUTCDay())) n += 1;
  }
  return n;
}

/**
 * The months of the fiscal year the profile is employed in (P9 LV.1): a month counts when the profile is
 * employed on its 15th (joined on or before it, not separated before it).
 */
export function activeMonths(
  fyStart: BusinessDate,
  fyEnd: BusinessDate,
  joined: BusinessDate,
  separated: BusinessDate | null,
): number {
  let n = 0;
  const [y0, m0] = fyStart.split('-').map(Number) as [number, number];
  for (let i = 0; i < 12; i += 1) {
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    const m = ((m0 - 1 + i) % 12) + 1;
    const mid = `${String(y)}-${String(m).padStart(2, '0')}-15` as BusinessDate;
    if (mid > fyEnd) break;
    if (joined <= mid && (separated === null || separated >= mid)) n += 1;
  }
  return n;
}

/** entitled = annual × months ÷ 12, to 3 places (P9 §12). */
export function proRata(annual: Dec | string, months: number): Dec {
  return round(dec(annual.toString()).times(months).dividedBy(12), 3);
}

/** total available = entitled + carried + adjustment; balance = total − consumed − encashed (LV.2). */
export function balanceOf(e: {
  entitledDays: Dec;
  carriedForwardDays: Dec;
  adjustmentDays: Dec;
  consumedDays: Dec;
  encashedDays: Dec;
}) {
  const total = dec(e.entitledDays.toString())
    .plus(e.carriedForwardDays.toString())
    .plus(e.adjustmentDays.toString());
  return { total, balance: total.minus(e.consumedDays.toString()).minus(e.encashedDays.toString()) };
}

export interface LeaveServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function leaveService({ db, accessLog, timezone }: LeaveServiceDeps) {
  const today = () => todayIn(timezone);
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  async function weeklyOff(tx: Database | Tx): Promise<readonly number[]> {
    const v = await readSetting(tx, null, WEEKLY_OFF_SETTING);
    return Array.isArray(v) && v.every((x) => typeof x === 'number' && x >= 0 && x <= 6)
      ? (v as number[])
      : DEFAULT_WEEKLY_OFF;
  }

  async function pendingDays(tx: Database | Tx, entitlementIds: readonly bigint[]) {
    if (entitlementIds.length === 0) return new Map<bigint, Dec>();
    const rows = await tx.leaveRequest.groupBy({
      by: ['leaveEntitlementId'],
      where: { leaveEntitlementId: { in: [...entitlementIds] }, state: 'submitted' },
      _sum: { dayCount: true },
    });
    return new Map(
      rows.flatMap((r) =>
        r.leaveEntitlementId === null
          ? []
          : [[r.leaveEntitlementId, dec((r._sum.dayCount ?? '0').toString())] as const],
      ),
    );
  }

  function toEntitlementOut(e: EntitlementRow, pending: Dec): EntitlementOutT {
    const { total, balance } = balanceOf(e);
    return {
      id: e.id.toString(),
      employment_profile_id: e.employmentProfileId.toString(),
      profile: refOut(e.profile) ?? { id: '', profile_number: '', full_name: '' },
      leave_type_id: e.leaveTypeId.toString(),
      leave_type: { id: e.leaveType.id.toString(), code: e.leaveType.code, name: e.leaveType.name },
      fiscal_year_id: e.fiscalYearId.toString(),
      fiscal_year: { id: e.fiscalYear.id.toString(), code: e.fiscalYear.code },
      entitled_days: pct(e.entitledDays),
      carried_forward_days: pct(e.carriedForwardDays),
      adjustment_days: pct(e.adjustmentDays),
      adjustment_reason: e.adjustmentReason,
      total_available: pct(total),
      consumed_days: pct(e.consumedDays),
      encashed_days: pct(e.encashedDays),
      pending_days: pct(pending),
      balance_days: pct(balance),
      available_to_request: pct(balance.minus(pending)),
      allows_negative_balance: e.leaveType.allowsNegativeBalance,
      version: e.version,
    };
  }

  async function entitlementOrNotFound(tx: Database | Tx, eid: bigint) {
    const e = await tx.leaveEntitlement.findUnique({ where: { id: eid }, include: entitlementInclude });
    if (!e) throw Errors.notFound('Leave entitlement not found.');
    return e;
  }

  // ---- write scope: the estate, or your own leave --------------------------------------------------------
  async function canFile(
    profile: { id: bigint; estateId: bigint },
    recordId: bigint | null,
    operation: string,
  ) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(profile.estateId)) return;
    if (scope.selfEmploymentProfileId === profile.id) return;
    await denyWrite(accessLog, 'leave', recordId, operation);
  }
  async function canManage(estateId: bigint, recordId: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, 'leave', recordId, operation);
  }

  // ---- requests -----------------------------------------------------------------------------------------
  async function approvalIds(tx: Database | Tx, ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, bigint>();
    const rows = await tx.approvalRequest.findMany({
      where: { documentType: LEAVE_DOCUMENT, documentId: { in: [...ids] }, state: 'pending' },
      select: { id: true, documentId: true },
    });
    return new Map(rows.map((r) => [r.documentId, r.id]));
  }
  function toLeaveOut(r: LeaveRow, approvalId: bigint | null): LeaveOutT {
    return {
      id: r.id.toString(),
      request_number: r.requestNumber,
      employment_profile_id: r.employmentProfileId.toString(),
      profile: refOut(r.profile) ?? { id: '', profile_number: '', full_name: '' },
      estate_id: r.estateId.toString(),
      leave_type_id: r.leaveTypeId.toString(),
      leave_type: { id: r.leaveType.id.toString(), code: r.leaveType.code, name: r.leaveType.name },
      from_date: businessDateFromDb(r.fromDate),
      to_date: businessDateFromDb(r.toDate),
      day_count: pct(r.dayCount),
      is_half_day: r.isHalfDay,
      is_paid: r.isPaid,
      reason: r.reason,
      contact_during_leave: r.contactDuringLeave,
      covering_profile_id: idOut(r.coveringProfileId),
      covering: refOut(r.covering),
      leave_entitlement_id: idOut(r.leaveEntitlementId),
      balance_days: r.entitlement ? pct(balanceOf(r.entitlement).balance) : null,
      state: r.state as LeaveOutT['state'],
      approval_id: idOut(approvalId),
      submitted_at: iso(r.submittedAt),
      approved_at: iso(r.approvedAt),
      approved_by: r.approver ? { id: r.approver.id.toString(), username: r.approver.username } : null,
      rejected_at: iso(r.rejectedAt),
      rejection_reason: r.rejectionReason,
      cancelled_at: iso(r.cancelledAt),
      cancellation_reason: r.cancellationReason,
      created_by: { id: r.creator.id.toString(), username: r.creator.username },
      version: r.version,
      created_at: r.createdAt.toISOString(),
      updated_at: iso(r.updatedAt),
    };
  }
  async function leaveOut(tx: Database | Tx, r: LeaveRow) {
    const p = r.state === 'submitted' ? await approvalIds(tx, [r.id]) : new Map<bigint, bigint>();
    return toLeaveOut(r, p.get(r.id) ?? null);
  }
  async function leaveOrNotFound(tx: Database | Tx, lid: bigint): Promise<LeaveRow> {
    const r = await tx.leaveRequest.findUnique({ where: { id: lid }, include: leaveInclude });
    if (!r) throw Errors.notFound('Leave request not found.');
    return r;
  }

  interface Terms {
    leaveTypeId: bigint;
    fromDate: BusinessDate;
    toDate: BusinessDate;
    isHalfDay: boolean;
    reason: string | null;
    contactDuringLeave: string | null;
    coveringProfileId: bigint | null;
  }
  /** Checks a request's terms for the profile; returns its day count, entitlement and paid flag. */
  async function evaluate(
    tx: Database | Tx,
    profile: { id: bigint; estateId: bigint; employmentType: string; joiningDate: Date; status: string },
    t: Terms,
    self: bigint | null,
  ) {
    const problems: ErrorDetail[] = [];
    if (profile.status === 'separated')
      problems.push(invalid('employment_profile_id', 'The profile is separated.'));
    const type = await tx.leaveType.findUnique({ where: { id: t.leaveTypeId } });
    if (type?.status !== 'active') problems.push(invalid('leave_type_id', 'No such active leave type.'));
    else if (type.appliesTo !== 'all' && type.appliesTo !== profile.employmentType) {
      problems.push(invalid('leave_type_id', `This leave type is for ${type.appliesTo}s only.`));
    }
    if (t.toDate < t.fromDate) problems.push(invalid('to_date', 'Cannot be before from_date.'));
    if (t.fromDate < businessDateFromDb(profile.joiningDate))
      problems.push(invalid('from_date', 'Before the joining date.'));
    if (t.isHalfDay && t.fromDate !== t.toDate)
      problems.push(invalid('is_half_day', 'A half day is a single day: to_date = from_date.'));
    if (t.coveringProfileId !== null) {
      const c = await tx.employmentProfile.findUnique({
        where: { id: t.coveringProfileId },
        select: { estateId: true, status: true },
      });
      if (
        c?.estateId !== profile.estateId ||
        c.status === 'separated' ||
        t.coveringProfileId === profile.id
      ) {
        problems.push(invalid('covering_profile_id', 'Another current profile of the same estate.'));
      }
    }
    const fy = await tx.fiscalYear.findFirst({
      where: {
        startDate: { lte: businessDateToDb(t.fromDate) },
        endDate: { gte: businessDateToDb(t.fromDate) },
      },
      select: { id: true, code: true, endDate: true },
    });
    if (!fy) problems.push(invalid('from_date', 'No fiscal year covers this date.'));
    else if (t.toDate > businessDateFromDb(fy.endDate)) {
      problems.push(
        invalid(
          'to_date',
          `The fiscal year ${fy.code} ends ${businessDateFromDb(fy.endDate)}: request the rest separately.`,
        ),
      );
    }
    const days = t.isHalfDay
      ? dec('0.5')
      : dec(String(workingDays(t.fromDate, t.toDate, await weeklyOff(tx))));
    if (problems.length === 0 && days.lte(0))
      problems.push(invalid('to_date', 'Those dates are all weekly offs.'));
    // Overlap with the profile's other leave (pending or approved).
    const overlap = await tx.leaveRequest.findFirst({
      where: {
        employmentProfileId: profile.id,
        state: { in: ['draft', 'submitted', 'approved'] },
        fromDate: { lte: businessDateToDb(t.toDate) },
        toDate: { gte: businessDateToDb(t.fromDate) },
        ...(self !== null ? { id: { not: self } } : {}),
      },
      select: { requestNumber: true },
    });
    if (overlap) problems.push(invalid('from_date', `Overlaps leave ${overlap.requestNumber}.`));
    let entitlement: { id: bigint } | null = null;
    const annual = type?.annualDays ?? null;
    if (type && annual !== null && fy) {
      entitlement = await tx.leaveEntitlement.findUnique({
        where: {
          employmentProfileId_leaveTypeId_fiscalYearId: {
            employmentProfileId: profile.id,
            leaveTypeId: type.id,
            fiscalYearId: fy.id,
          },
        },
        select: { id: true },
      });
      if (!entitlement)
        problems.push(
          invalid(
            'leave_type_id',
            `No ${type.name} entitlement for ${fy.code}: generate the year's entitlements first.`,
          ),
        );
    }
    if (problems.length > 0) throw Errors.validation(problems);
    return {
      days,
      entitlementId: entitlement?.id ?? null,
      isPaid: type?.isPaid ?? true,
      allowsNegative: type?.allowsNegativeBalance ?? false,
    };
  }

  /** The balance check (P3 §22.2), on the locked entitlement row: `pending` excludes this request. */
  async function assertBalance(
    tx: Tx,
    entitlementId: bigint,
    days: Dec,
    allowsNegative: boolean,
    exceptRequest: bigint,
    countPending: boolean,
  ) {
    await lockRowsForUpdate(tx, 'leave_entitlement', { id: entitlementId });
    const e = await tx.leaveEntitlement.findUniqueOrThrow({ where: { id: entitlementId } });
    const { balance } = balanceOf(e);
    let pending = dec('0');
    if (countPending) {
      const s = await tx.leaveRequest.aggregate({
        where: { leaveEntitlementId: entitlementId, state: 'submitted', id: { not: exceptRequest } },
        _sum: { dayCount: true },
      });
      pending = dec((s._sum.dayCount ?? '0').toString());
    }
    const available = balance.minus(pending);
    if (!allowsNegative && available.lt(days)) {
      throw new AppError(
        'INSUFFICIENT_BALANCE',
        `Only ${pct(available)} days are available; ${pct(days)} requested.`,
        [
          {
            field: 'to_date',
            code: 'INSUFFICIENT_BALANCE',
            message: `Balance ${pct(balance)}, pending ${pct(pending)}, available ${pct(available)}.`,
            context: {
              balance_days: pct(balance),
              pending_days: pct(pending),
              available_days: pct(available),
              requested_days: pct(days),
            },
          },
        ],
      );
    }
    return { balance, available };
  }

  const adapter: ApprovalAdapter = {
    documentType: LEAVE_DOCUMENT,
    async describe(tx, lid): Promise<SubmittedDocument> {
      const r = await leaveOrNotFound(tx, lid);
      const balance = r.entitlement ? balanceOf(r.entitlement).balance : null;
      return {
        id: lid,
        number: r.requestNumber,
        label: `${r.requestNumber} · ${r.profile.person.fullName} · ${r.leaveType.name} ${businessDateFromDb(r.fromDate)} – ${businessDateFromDb(r.toDate)}`,
        createdBy: r.createdBy,
        estateId: r.estateId,
        values: {
          estate_id: r.estateId.toString(),
          day_count: pct(r.dayCount),
          balance_negative: balance?.lt(r.dayCount.toString()) ?? false,
        },
        quantity: pct(r.dayCount),
      };
    },
    async onApproved(tx, lid, ctx) {
      await lockRowsForUpdate(tx, 'leave_request', { id: lid });
      const r = await leaveOrNotFound(tx, lid);
      if (r.state !== 'submitted')
        throw transition(`A ${r.state} request cannot be approved.`, r.state, 'Reload it.');
      if (r.leaveEntitlementId !== null) {
        const type = await tx.leaveType.findUniqueOrThrow({
          where: { id: r.leaveTypeId },
          select: { allowsNegativeBalance: true },
        });
        const days = dec(r.dayCount.toString());
        await assertBalance(tx, r.leaveEntitlementId, days, type.allowsNegativeBalance, lid, false);
        await tx.leaveEntitlement.update({
          where: { id: r.leaveEntitlementId },
          data: { consumedDays: { increment: r.dayCount }, ...stamp(ctx.actorId) },
        });
      }
      const now = new Date();
      await tx.leaveRequest.update({
        where: { id: lid },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, LEAVE_AUDIT, lid, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, LEAVE_AUDIT.type, lid, 'submitted', 'approved', { actorId: ctx.actorId });
    },
    async onRejected(tx, lid, ctx) {
      const now = new Date();
      await tx.leaveRequest.update({
        where: { id: lid },
        data: {
          state: 'rejected',
          stateChangedAt: now,
          rejectedAt: now,
          rejectedBy: ctx.actorId,
          rejectionReason: ctx.reason.slice(0, 500),
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, LEAVE_AUDIT, lid, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, LEAVE_AUDIT.type, lid, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, lid, ctx) {
      await tx.leaveRequest.update({
        where: { id: lid },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, LEAVE_AUDIT.type, lid, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  /** The caller's own profile (self service). */
  async function ownProfileId(): Promise<bigint> {
    const actor = getRequestContext()?.actorId;
    const u = actor
      ? await db.user.findUnique({ where: { id: BigInt(actor) }, select: { employmentProfileId: true } })
      : null;
    if (!u?.employmentProfileId) {
      throw Errors.validation([
        invalid(
          'employment_profile_id',
          'Your account is not linked to an employment profile: name whose leave this is.',
        ),
      ]);
    }
    return u.employmentProfileId;
  }

  return {
    adapter,

    // ================= entitlements =================
    entitlements: {
      async list(q: ListQuery) {
        const estate = q.filters.find((f) => f.field === 'estate_id');
        const rest = { ...q, filters: q.filters.filter((f) => f !== estate) };
        const and: Prisma.LeaveEntitlementWhereInput[] = [toWhere(rest, ENTITLEMENT_LIST_FIELDS)];
        if (estate)
          and.push({
            profile: {
              estateId: { in: (Array.isArray(estate.value) ? estate.value : [estate.value]).map(idf) },
            },
          });
        const where = { AND: and };
        const [rows, total] = await Promise.all([
          db.leaveEntitlement.findMany({
            where,
            include: entitlementInclude,
            orderBy: [...toOrderBy(q.sort, ENTITLEMENT_LIST_FIELDS), { id: 'asc' }],
            ...toPaging(q),
          }),
          db.leaveEntitlement.count({ where }),
        ]);
        const pending = await pendingDays(
          db,
          rows.map((r) => r.id),
        );
        return { items: rows.map((r) => toEntitlementOut(r, pending.get(r.id) ?? dec('0'))), total };
      },

      async get(eid: bigint) {
        const e = await entitlementOrNotFound(db, eid);
        return toEntitlementOut(e, (await pendingDays(db, [eid])).get(eid) ?? dec('0'));
      },

      /**
       * Generates the year's missing entitlements (LV.1, LV.2): every current profile employed in the year,
       * every active leave type with annual days that applies to it. Existing ones are left as they are.
       */
      async generate(b: z.infer<typeof GenerateBody>, actorId: bigint) {
        const fy = await db.fiscalYear.findUnique({ where: { id: b.fiscal_year_id } });
        if (!fy) throw Errors.validation([invalid('fiscal_year_id', 'No such fiscal year.')]);
        if (b.estate_id !== undefined) await canManage(b.estate_id, null, 'generate-entitlements');
        const start = businessDateFromDb(fy.startDate);
        const end = businessDateFromDb(fy.endDate);
        const profiles = await db.employmentProfile.findMany({
          where: {
            ...(b.estate_id !== undefined ? { estateId: b.estate_id } : {}),
            ...(b.employment_profile_id !== undefined ? { id: b.employment_profile_id } : {}),
            joiningDate: { lte: fy.endDate },
            OR: [{ separationDate: null }, { separationDate: { gte: fy.startDate } }],
          },
          select: { id: true, estateId: true, employmentType: true, joiningDate: true, separationDate: true },
        });
        const scope = await scopeToCheck();
        const changeable = profiles.filter(
          (p) => scope === null || scope.allEstates || scope.estates.includes(p.estateId),
        );
        const types = await db.leaveType.findMany({ where: { status: 'active', annualDays: { not: null } } });
        // The previous year, for carry-forward.
        const previous = await db.fiscalYear.findFirst({
          where: { endDate: { lt: fy.startDate } },
          orderBy: { endDate: 'desc' },
          select: { id: true },
        });
        let created = 0;
        let existing = 0;
        for (const p of changeable) {
          const months = activeMonths(start, end, businessDateFromDb(p.joiningDate), d(p.separationDate));
          for (const t of types) {
            if (t.appliesTo !== 'all' && t.appliesTo !== p.employmentType) continue;
            if (months === 0 || t.annualDays === null) continue;
            const done = await withTransaction(db, async (tx) => {
              const key = { employmentProfileId: p.id, leaveTypeId: t.id, fiscalYearId: fy.id };
              if (
                await tx.leaveEntitlement.findUnique({
                  where: { employmentProfileId_leaveTypeId_fiscalYearId: key },
                  select: { id: true },
                })
              )
                return false;
              let carried = dec('0');
              if (previous) {
                const prev = await tx.leaveEntitlement.findUnique({
                  where: {
                    employmentProfileId_leaveTypeId_fiscalYearId: { ...key, fiscalYearId: previous.id },
                  },
                });
                if (prev) {
                  const { balance } = balanceOf(prev);
                  const limit = dec(t.carryForwardLimitDays.toString());
                  // LV.2: capped at the limit BEFORE being added.
                  carried = balance.gt(0) ? (balance.gt(limit) ? limit : balance) : dec('0');
                }
              }
              const e = await tx.leaveEntitlement.create({
                data: {
                  ...key,
                  entitledDays: proRata(t.annualDays ?? '0', months).toString(),
                  carriedForwardDays: carried.toString(),
                  createdBy: actorId,
                },
              });
              await auditCreate(
                tx,
                ENTITLEMENT_AUDIT,
                e.id,
                {
                  employment_profile_id: p.id.toString(),
                  leave_type_id: t.id.toString(),
                  fiscal_year_id: fy.id.toString(),
                  entitled_days: e.entitledDays.toString(),
                  carried_forward_days: e.carriedForwardDays.toString(),
                },
                { actorId },
              );
              return true;
            });
            if (done) created += 1;
            else existing += 1;
          }
        }
        return { fiscal_year_id: fy.id.toString(), created, existing };
      },

      /** An approved manual adjustment (P3 §22.1): replaces the adjustment, with its reason. */
      async adjust(eid: bigint, expectedVersion: number, days: Dec, reason: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'leave_entitlement', { id: eid });
          const before = await entitlementOrNotFound(tx, eid);
          const profile = await tx.employmentProfile.findUniqueOrThrow({
            where: { id: before.employmentProfileId },
            select: { estateId: true },
          });
          await canManage(profile.estateId, eid, 'adjust-entitlement');
          const old = toEntitlementOut(before, (await pendingDays(tx, [eid])).get(eid) ?? dec('0'));
          if (before.version !== expectedVersion) versionConflict(before, old);
          const next = balanceOf({ ...before, adjustmentDays: days });
          if (!before.leaveType.allowsNegativeBalance && next.balance.lt(0)) {
            throw new AppError('INSUFFICIENT_BALANCE', 'The adjustment would leave a negative balance.', [
              {
                field: 'adjustment_days',
                code: 'INSUFFICIENT_BALANCE',
                message: `The balance would be ${pct(next.balance)}.`,
              },
            ]);
          }
          await tx.leaveEntitlement.update({
            where: { id: eid },
            data: {
              adjustmentDays: days.toString(),
              adjustmentReason: days.isZero() ? null : reason,
              ...stamp(actorId),
            },
          });
          const after = toEntitlementOut(
            await entitlementOrNotFound(tx, eid),
            (await pendingDays(tx, [eid])).get(eid) ?? dec('0'),
          );
          await auditUpdate(tx, ENTITLEMENT_AUDIT, eid, old, after, { actorId, reason });
          return after;
        });
      },
    },

    // ================= requests =================
    requests: {
      async list(q: ListQuery) {
        const where = toWhere(q, LEAVE_LIST_FIELDS) as Prisma.LeaveRequestWhereInput;
        const [rows, total] = await Promise.all([
          db.leaveRequest.findMany({
            where,
            include: leaveInclude,
            orderBy: [...toOrderBy(q.sort, LEAVE_LIST_FIELDS), { id: 'desc' }],
            ...toPaging(q),
          }),
          db.leaveRequest.count({ where }),
        ]);
        const pending = await approvalIds(
          db,
          rows.filter((r) => r.state === 'submitted').map((r) => r.id),
        );
        return { items: rows.map((r) => toLeaveOut(r, pending.get(r.id) ?? null)), total };
      },

      async get(lid: bigint) {
        return leaveOut(db, await leaveOrNotFound(db, lid));
      },

      async create(b: z.infer<typeof CreateLeaveBody>, actorId: bigint) {
        const profileId = b.employment_profile_id ?? (await ownProfileId());
        return withTransaction(db, async (tx) => {
          const profile = await tx.employmentProfile.findUnique({
            where: { id: profileId },
            select: {
              id: true,
              estateId: true,
              employmentType: true,
              joiningDate: true,
              status: true,
              estate: { select: { code: true } },
            },
          });
          if (!profile) throw Errors.validation([invalid('employment_profile_id', 'No such profile.')]);
          await canFile(profile, null, 'create-leave');
          const t: Terms = {
            leaveTypeId: b.leave_type_id,
            fromDate: b.from_date,
            toDate: b.to_date,
            isHalfDay: b.is_half_day ?? false,
            reason: b.reason ?? null,
            contactDuringLeave: b.contact_during_leave ?? null,
            coveringProfileId: b.covering_profile_id ?? null,
          };
          const e = await evaluate(tx, profile, t, null);
          const { number } = await allocateNumber(
            tx,
            LEAVE_DOCUMENT,
            { date: b.from_date, estateCode: profile.estate.code },
            'draft',
          );
          const r = await tx.leaveRequest.create({
            data: {
              employmentProfileId: profile.id,
              estateId: profile.estateId,
              leaveTypeId: t.leaveTypeId,
              requestNumber: number,
              fromDate: businessDateToDb(t.fromDate),
              toDate: businessDateToDb(t.toDate),
              dayCount: e.days.toString(),
              isHalfDay: t.isHalfDay,
              reason: t.reason,
              contactDuringLeave: t.contactDuringLeave,
              coveringProfileId: t.coveringProfileId,
              leaveEntitlementId: e.entitlementId,
              isPaid: e.isPaid,
              state: 'draft',
              stateChangedAt: new Date(),
              createdBy: actorId,
            },
          });
          const out = await leaveOut(tx, await leaveOrNotFound(tx, r.id));
          await auditCreate(tx, LEAVE_AUDIT, r.id, out, { actorId });
          await recordStatusChange(tx, LEAVE_AUDIT.type, r.id, null, 'draft', { actorId });
          return out;
        });
      },

      async update(lid: bigint, expectedVersion: number, b: z.infer<typeof PatchLeaveBody>, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          const before = await leaveOrNotFound(tx, lid);
          const profile = await tx.employmentProfile.findUniqueOrThrow({
            where: { id: before.employmentProfileId },
            select: { id: true, estateId: true, employmentType: true, joiningDate: true, status: true },
          });
          await canFile(profile, lid, 'update-leave');
          if (before.state !== 'draft')
            throw transition(
              `A ${before.state} request cannot be changed.`,
              before.state,
              'Only a draft is edited.',
            );
          const t: Terms = {
            leaveTypeId: b.leave_type_id ?? before.leaveTypeId,
            fromDate: b.from_date ?? businessDateFromDb(before.fromDate),
            toDate: b.to_date ?? businessDateFromDb(before.toDate),
            isHalfDay: b.is_half_day ?? before.isHalfDay,
            reason: b.reason !== undefined ? b.reason : before.reason,
            contactDuringLeave:
              b.contact_during_leave !== undefined ? b.contact_during_leave : before.contactDuringLeave,
            coveringProfileId:
              b.covering_profile_id !== undefined ? b.covering_profile_id : before.coveringProfileId,
          };
          const e = await evaluate(tx, profile, t, lid);
          const { count } = await tx.leaveRequest.updateMany({
            where: { id: lid, version: expectedVersion },
            data: {
              leaveTypeId: t.leaveTypeId,
              fromDate: businessDateToDb(t.fromDate),
              toDate: businessDateToDb(t.toDate),
              dayCount: e.days.toString(),
              isHalfDay: t.isHalfDay,
              reason: t.reason,
              contactDuringLeave: t.contactDuringLeave,
              coveringProfileId: t.coveringProfileId,
              leaveEntitlementId: e.entitlementId,
              isPaid: e.isPaid,
              ...stamp(actorId),
            },
          });
          const old = await leaveOut(tx, before);
          if (count !== 1) versionConflict(before, old);
          const after = await leaveOut(tx, await leaveOrNotFound(tx, lid));
          await auditUpdate(tx, LEAVE_AUDIT, lid, old, after, { actorId });
          return after;
        });
      },

      async remove(lid: bigint, actorId: bigint) {
        await withTransaction(db, async (tx) => {
          const r = await leaveOrNotFound(tx, lid);
          await canFile({ id: r.employmentProfileId, estateId: r.estateId }, lid, 'delete-leave');
          if (r.state !== 'draft')
            throw transition(
              `A ${r.state} request cannot be deleted.`,
              r.state,
              'Only a draft is deleted; cancel an approved one.',
            );
          const out = await leaveOut(tx, r);
          await tx.leaveRequest.delete({ where: { id: lid } });
          await auditDelete(tx, LEAVE_AUDIT, lid, out, { actorId });
        });
      },

      /** Checks the balance (with the requests already pending) and routes it to the leave workflow. */
      async submit(lid: bigint, expectedVersion: number, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'leave_request', { id: lid });
          const r = await leaveOrNotFound(tx, lid);
          const profile = await tx.employmentProfile.findUniqueOrThrow({
            where: { id: r.employmentProfileId },
            select: { id: true, estateId: true, employmentType: true, joiningDate: true, status: true },
          });
          await canFile(profile, lid, 'submit-leave');
          if (r.version !== expectedVersion) versionConflict(r, await leaveOut(tx, r));
          if (r.state !== 'draft')
            throw transition(
              `A ${r.state} request cannot be submitted.`,
              r.state,
              'Only a draft is submitted.',
            );
          const e = await evaluate(
            tx,
            profile,
            {
              leaveTypeId: r.leaveTypeId,
              fromDate: businessDateFromDb(r.fromDate),
              toDate: businessDateFromDb(r.toDate),
              isHalfDay: r.isHalfDay,
              reason: r.reason,
              contactDuringLeave: r.contactDuringLeave,
              coveringProfileId: r.coveringProfileId,
            },
            lid,
          );
          if (e.entitlementId !== null)
            await assertBalance(tx, e.entitlementId, e.days, e.allowsNegative, lid, true);
          const now = new Date();
          await tx.leaveRequest.update({
            where: { id: lid },
            data: {
              state: 'submitted',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: actorId,
              dayCount: e.days.toString(),
              leaveEntitlementId: e.entitlementId,
              ...stamp(actorId),
            },
          });
          await recordStatusChange(tx, LEAVE_AUDIT.type, lid, 'draft', 'submitted', { actorId });
          await submitForApproval(tx, { timezone }, LEAVE_DOCUMENT, lid, { actorId, date: today() });
          return leaveOut(tx, await leaveOrNotFound(tx, lid));
        });
      },

      /** Cancels approved leave: the balance is restored (attendance reversal arrives with P5.02). */
      async cancel(lid: bigint, expectedVersion: number, reason: string, actorId: bigint) {
        return withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'leave_request', { id: lid });
          const r = await leaveOrNotFound(tx, lid);
          await canFile({ id: r.employmentProfileId, estateId: r.estateId }, lid, 'cancel-leave');
          const old = await leaveOut(tx, r);
          if (r.version !== expectedVersion) versionConflict(r, old);
          if (r.state !== 'approved') {
            throw transition(
              `A ${r.state} request cannot be cancelled.`,
              r.state,
              r.state === 'draft'
                ? 'Delete the draft instead.'
                : 'Only approved leave is cancelled; a submitted one is returned or rejected by its approver.',
            );
          }
          if (r.leaveEntitlementId !== null) {
            await lockRowsForUpdate(tx, 'leave_entitlement', { id: r.leaveEntitlementId });
            await tx.leaveEntitlement.update({
              where: { id: r.leaveEntitlementId },
              data: { consumedDays: { decrement: r.dayCount }, ...stamp(actorId) },
            });
          }
          const now = new Date();
          await tx.leaveRequest.update({
            where: { id: lid },
            data: {
              state: 'cancelled',
              stateChangedAt: now,
              cancelledAt: now,
              cancelledBy: actorId,
              cancellationReason: reason,
              ...stamp(actorId),
            },
          });
          const after = await leaveOut(tx, await leaveOrNotFound(tx, lid));
          await auditUpdate(tx, LEAVE_AUDIT, lid, old, after, { actorId, reason });
          await recordStatusChange(tx, LEAVE_AUDIT.type, lid, 'approved', 'cancelled', {
            actorId,
            comment: reason,
          });
          return after;
        });
      },
    },

    /** Profiles on approved leave on the date (the Worker / Employee Management "On Leave" figure). */
    async onLeave(profileIds: readonly bigint[], date: BusinessDate): Promise<Set<bigint>> {
      if (profileIds.length === 0) return new Set();
      const day = businessDateToDb(date);
      const rows = await runUnscoped('on-leave figure of visible profiles', () =>
        db.leaveRequest.findMany({
          where: {
            employmentProfileId: { in: [...profileIds] },
            state: 'approved',
            fromDate: { lte: day },
            toDate: { gte: day },
          },
          select: { employmentProfileId: true },
        }),
      );
      return new Set(rows.map((r) => r.employmentProfileId));
    },
  };
}

export type LeaveService = ReturnType<typeof leaveService>;
