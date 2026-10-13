import type { z } from 'zod';

import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  daysInMonth,
  type BusinessDate,
} from '../../core/time/dates.js';
import type { AccountingPeriod, FiscalYear, Prisma } from '../../generated/prisma/client.js';
import { duplicate, idOut, iso, referenced, versionConflict } from '../organisation/common.js';
import {
  ADJUSTMENT_PERIOD,
  type AccountingPeriodOut,
  type CreateFiscalYearBody,
  type FiscalYearOut,
  type FiscalYearState,
  type PatchFiscalYearBody,
  type PeriodState,
} from './calendar.schema.js';

/**
 * Fiscal years and accounting periods (Spec P3 §4.9–§4.10, P1 §14, decision O-17): ONE calendar for the
 * whole organisation. No function here takes an estate.
 *
 *   - A fiscal year's dates follow from organisation.fiscal_year_start_month: the caller names only the
 *     calendar year it starts in. Fiscal years never overlap (the organisation row is locked while that
 *     is checked).
 *   - generate-periods creates 12 contiguous monthly periods and period 13, the year-end adjustment
 *     period: one day, the last of the year. Period 13 overlaps period 12's last day BY DESIGN and is
 *     therefore never found by date; a year-end journal names it explicitly (BACKLOG D-1.09-3).
 *   - Every period starts `future`. Periods are opened in order (no period may open while an earlier one
 *     of its year is still future); opening the first opens the fiscal year. Soft-close, close and reopen
 *     arrive with period close (P10.02).
 *   - `periodOn` is the single lookup the posting engine uses to find a date's period (P1 §14).
 */

type FiscalYearOutT = z.infer<typeof FiscalYearOut>;
type PeriodOutT = z.infer<typeof AccountingPeriodOut>;
type FiscalYearRow = FiscalYear & { _count: { periods: number } };
const withCount = { _count: { select: { periods: true } } } as const;

export const FISCAL_YEAR_AUDIT: AuditedRecord = {
  type: 'fiscal_year',
  class: 'master',
  fields: ['code', 'name', 'start_date', 'end_date', 'state'],
};
export const PERIOD_AUDIT: AuditedRecord = {
  type: 'accounting_period',
  class: 'master',
  fields: ['fiscal_year_id', 'period_number', 'name', 'start_date', 'end_date', 'state'],
};

export const FISCAL_YEAR_LIST_FIELDS: ListFieldMap = {
  state: { field: 'state' },
  code: { field: 'code' },
  start_date: { field: 'startDate', convert: (v) => businessDateToDb(String(v) as BusinessDate) },
};
export const PERIOD_LIST_FIELDS: ListFieldMap = {
  fiscal_year_id: { field: 'fiscalYearId', convert: (v) => BigInt(String(v)) },
  state: { field: 'state' },
  period_number: { field: 'periodNumber', convert: (v) => Number(v) },
  start_date: { field: 'startDate', convert: (v) => businessDateToDb(String(v) as BusinessDate) },
  end_date: { field: 'endDate', convert: (v) => businessDateToDb(String(v) as BusinessDate) },
};

export function toFiscalYearOut(y: FiscalYearRow): FiscalYearOutT {
  return {
    id: y.id.toString(),
    code: y.code,
    name: y.name,
    start_date: businessDateFromDb(y.startDate),
    end_date: businessDateFromDb(y.endDate),
    state: y.state as FiscalYearState,
    period_count: y._count.periods,
    closed_at: iso(y.closedAt),
    closed_by: idOut(y.closedBy),
    version: y.version,
    created_at: y.createdAt.toISOString(),
    updated_at: iso(y.updatedAt),
  };
}

export function toPeriodOut(p: AccountingPeriod): PeriodOutT {
  return {
    id: p.id.toString(),
    fiscal_year_id: p.fiscalYearId.toString(),
    period_number: p.periodNumber,
    name: p.name,
    start_date: businessDateFromDb(p.startDate),
    end_date: businessDateFromDb(p.endDate),
    state: p.state as PeriodState,
    is_adjustment: p.periodNumber === ADJUSTMENT_PERIOD,
    closed_at: iso(p.closedAt),
    closed_by: idOut(p.closedBy),
    reopened_at: iso(p.reopenedAt),
    reopened_by: idOut(p.reopenedBy),
    reopen_reason: p.reopenReason,
    version: p.version,
    updated_at: iso(p.updatedAt),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${String(y)}-${pad(m)}-${pad(d)}` as BusinessDate;

/** The dates of the fiscal year that starts in `startYear`, for a start month of 1–12. */
export function fiscalYearDates(
  startYear: number,
  startMonth: number,
): { start: BusinessDate; end: BusinessDate } {
  const start = ymd(startYear, startMonth, 1);
  return { start, end: addDays(ymd(startYear + 1, startMonth, 1), -1) };
}

/** FY2026 for a calendar-year fiscal year, otherwise FY2026-27. */
export function fiscalYearCode(startYear: number, startMonth: number): string {
  return startMonth === 1 ? `FY${String(startYear)}` : `FY${String(startYear)}-${pad((startYear + 1) % 100)}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The 13 periods of a fiscal year: 12 contiguous months, then the one-day adjustment period. Pure. */
export function periodsOf(
  start: BusinessDate,
): { number: number; name: string; start: BusinessDate; end: BusinessDate }[] {
  const [y = 0, m = 1] = start.split('-').map(Number);
  const months = Array.from({ length: 12 }, (_, i) => {
    const month = ((m - 1 + i) % 12) + 1;
    const year = y + Math.floor((m - 1 + i) / 12);
    return {
      number: i + 1,
      name: `${MONTHS[month - 1] ?? ''} ${String(year)}`,
      start: ymd(year, month, 1),
      end: ymd(year, month, daysInMonth(year, month)),
    };
  });
  const last = months[11]?.end ?? start;
  return [...months, { number: ADJUSTMENT_PERIOD, name: 'Year-end adjustments', start: last, end: last }];
}

/**
 * The monthly accounting period (1–12) containing a date, or null where no fiscal year covers it.
 * Period 13 is never returned: it is named explicitly by year-end adjustments.
 */
export async function periodOn(tx: Database | Tx, date: BusinessDate): Promise<AccountingPeriod | null> {
  const d = businessDateToDb(date);
  return tx.accountingPeriod.findFirst({
    where: { periodNumber: { lt: ADJUSTMENT_PERIOD }, startDate: { lte: d }, endDate: { gte: d } },
  });
}

const invariant = (message: string, context?: Record<string, unknown>) =>
  new AppError('INVARIANT_VIOLATED', message, [
    { code: 'INVARIANT_VIOLATED', message, ...(context ? { context } : {}) },
  ]);

export function fiscalService(db: Database) {
  async function yearOrNotFound(tx: Database | Tx, id: bigint): Promise<FiscalYearRow> {
    const y = await tx.fiscalYear.findUnique({ where: { id }, include: withCount });
    if (!y) throw Errors.notFound('Fiscal year not found.');
    return y;
  }
  async function periodOrNotFound(tx: Database | Tx, id: bigint): Promise<AccountingPeriod> {
    const p = await tx.accountingPeriod.findUnique({ where: { id } });
    if (!p) throw Errors.notFound('Accounting period not found.');
    return p;
  }
  const stamp = (actorId: bigint) => ({
    version: { increment: 1 },
    updatedAt: new Date(),
    updatedBy: actorId,
  });

  const fiscalYears = {
    async list(q: ListQuery) {
      const where = toWhere(q, FISCAL_YEAR_LIST_FIELDS) as Prisma.FiscalYearWhereInput;
      const [rows, total] = await Promise.all([
        db.fiscalYear.findMany({
          where,
          include: withCount,
          orderBy: [...toOrderBy(q.sort, FISCAL_YEAR_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.fiscalYear.count({ where }),
      ]);
      return { items: rows.map(toFiscalYearOut), total };
    },

    async get(id: bigint) {
      return toFiscalYearOut(await yearOrNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateFiscalYearBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const org = await tx.organisation.findFirstOrThrow({
          select: { id: true, fiscalYearStartMonth: true },
        });
        await lockRowsForUpdate(tx, 'organisation', { id: org.id });
        const { start, end } = fiscalYearDates(body.start_year, org.fiscalYearStartMonth);
        const other = await tx.fiscalYear.findFirst({
          where: { startDate: { lte: businessDateToDb(end) }, endDate: { gte: businessDateToDb(start) } },
        });
        if (other) {
          throw Errors.validation([
            {
              field: 'start_year',
              code: 'VALIDATION_FAILED',
              message: `overlaps fiscal year ${other.code} (${businessDateFromDb(other.startDate)} to ${businessDateFromDb(other.endDate)})`,
              context: { fiscal_year_id: other.id.toString(), code: other.code },
            },
          ]);
        }
        const code = body.code ?? fiscalYearCode(body.start_year, org.fiscalYearStartMonth);
        const { id } = await tx.fiscalYear
          .create({
            data: {
              organisationId: org.id,
              code,
              name: body.name ?? `Fiscal year ${code.replace(/^FY/, '')}`,
              startDate: businessDateToDb(start),
              endDate: businessDateToDb(end),
              state: 'future',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Fiscal year code ${code}`));
        const out = toFiscalYearOut(await yearOrNotFound(tx, id));
        await auditCreate(tx, FISCAL_YEAR_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, FISCAL_YEAR_AUDIT.type, id, null, out.state, { actorId });
        return out;
      });
    },

    /** Code and name only: the dates are derived and never edited. */
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchFiscalYearBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await yearOrNotFound(tx, id);
        const { count } = await tx.fiscalYear
          .updateMany({
            where: { id, version: expectedVersion },
            data: {
              ...(changes.code !== undefined ? { code: changes.code } : {}),
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...stamp(actorId),
            },
          })
          .catch(duplicate('code', `Fiscal year code ${changes.code ?? ''}`));
        if (count !== 1) versionConflict(before, toFiscalYearOut(before));
        const after = toFiscalYearOut(await yearOrNotFound(tx, id));
        await auditUpdate(tx, FISCAL_YEAR_AUDIT, id, toFiscalYearOut(before), after, { actorId });
        return after;
      });
    },

    /** POST /fiscal-years/{id}/generate-periods (P4 §7.2): once per fiscal year. */
    async generatePeriods(id: bigint, actorId: bigint): Promise<PeriodOutT[]> {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'fiscal_year', { id });
        const year = await yearOrNotFound(tx, id);
        if (year._count.periods > 0) {
          throw invariant('The periods of this fiscal year have already been generated.', {
            period_count: year._count.periods,
          });
        }
        const out: PeriodOutT[] = [];
        for (const p of periodsOf(businessDateFromDb(year.startDate))) {
          const row = await tx.accountingPeriod.create({
            data: {
              fiscalYearId: id,
              periodNumber: p.number,
              name: p.name,
              startDate: businessDateToDb(p.start),
              endDate: businessDateToDb(p.end),
              state: 'future',
              createdBy: actorId,
            },
          });
          const o = toPeriodOut(row);
          await auditCreate(tx, PERIOD_AUDIT, row.id, o, { actorId });
          await recordStatusChange(tx, PERIOD_AUDIT.type, row.id, null, 'future', { actorId });
          out.push(o);
        }
        return out;
      });
    },

    /** Only a fiscal year nothing has happened in: still future, every period still future. */
    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const year = await yearOrNotFound(tx, id);
        const used = await tx.accountingPeriod.count({
          where: { fiscalYearId: id, state: { not: 'future' } },
        });
        if (year.state !== 'future' || used > 0) {
          throw invariant('A fiscal year that has been opened cannot be deleted.', { state: year.state });
        }
        for (const p of await tx.accountingPeriod.findMany({ where: { fiscalYearId: id } })) {
          await tx.accountingPeriod.delete({ where: { id: p.id } }).catch(referenced('accounting period'));
          await auditDelete(tx, PERIOD_AUDIT, p.id, toPeriodOut(p), { actorId });
        }
        await tx.fiscalYear.delete({ where: { id } }).catch(referenced('fiscal year'));
        await auditDelete(tx, FISCAL_YEAR_AUDIT, id, toFiscalYearOut(year), { actorId });
      });
    },
  };

  const periods = {
    async list(q: ListQuery) {
      const where = toWhere(q, PERIOD_LIST_FIELDS) as Prisma.AccountingPeriodWhereInput;
      const [rows, total] = await Promise.all([
        db.accountingPeriod.findMany({
          where,
          orderBy: [...toOrderBy(q.sort, PERIOD_LIST_FIELDS), { periodNumber: 'asc' }, { id: 'asc' }],
          ...toPaging(q),
        }),
        db.accountingPeriod.count({ where }),
      ]);
      return { items: rows.map(toPeriodOut), total };
    },

    async get(id: bigint) {
      return toPeriodOut(await periodOrNotFound(db, id));
    },

    /** future → open, in order: every earlier period of the year must have been opened first. */
    async open(id: bigint, expectedVersion: number, actorId: bigint): Promise<PeriodOutT> {
      return withTransaction(db, async (tx) => {
        const peek = await periodOrNotFound(tx, id);
        await lockRowsForUpdate(tx, 'fiscal_year', { id: peek.fiscalYearId });
        const before = await periodOrNotFound(tx, id);
        if (before.version !== expectedVersion) versionConflict(before, toPeriodOut(before));
        if (before.state === 'open') return toPeriodOut(before);
        if (before.state !== 'future') {
          throw new AppError('INVALID_TRANSITION', 'Only a future period can be opened.', [
            {
              code: 'INVALID_TRANSITION',
              message: `the period is ${before.state}`,
              context: { state: before.state },
            },
          ]);
        }
        const earlier = await tx.accountingPeriod.findFirst({
          where: {
            fiscalYearId: before.fiscalYearId,
            periodNumber: { lt: before.periodNumber },
            state: 'future',
          },
          orderBy: { periodNumber: 'asc' },
        });
        if (earlier) {
          throw invariant(`Open period ${String(earlier.periodNumber)} (${earlier.name}) first.`, {
            period_id: earlier.id.toString(),
            period_number: earlier.periodNumber,
          });
        }
        await tx.accountingPeriod.update({ where: { id }, data: { state: 'open', ...stamp(actorId) } });
        await recordStatusChange(tx, PERIOD_AUDIT.type, id, 'future', 'open', { actorId });
        const after = toPeriodOut(await periodOrNotFound(tx, id));
        await auditUpdate(tx, PERIOD_AUDIT, id, toPeriodOut(before), after, { actorId });

        const year = await yearOrNotFound(tx, before.fiscalYearId);
        if (year.state === 'future') {
          await tx.fiscalYear.update({ where: { id: year.id }, data: { state: 'open', ...stamp(actorId) } });
          await recordStatusChange(tx, FISCAL_YEAR_AUDIT.type, year.id, 'future', 'open', { actorId });
          await auditUpdate(
            tx,
            FISCAL_YEAR_AUDIT,
            year.id,
            toFiscalYearOut(year),
            { ...toFiscalYearOut(year), state: 'open' },
            { actorId },
          );
        }
        return after;
      });
    },
  };

  return { fiscalYears, periods };
}
