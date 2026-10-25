import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import type { Database } from '../../core/db/prisma.js';
import type { Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import { dec, type Dec, toDecimalString } from '../../core/money/decimal.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb, businessDateToDb, type BusinessDate } from '../../core/time/dates.js';
import { Prisma } from '../../generated/prisma/client.js';
import { denyWrite } from '../organisation/common.js';
import type {
  ExpensesOut,
  ExpensesQuery,
  LedgerOut,
  LedgerQuery,
  OpeningBalanceOut,
} from './journals.schema.js';

/**
 * Reading the ledger (P3.04; Spec P4 §13.3, P3 §27.6; D-3.04-8 to D-3.04-11).
 *
 *   ledger    one account (a group: its subtree) between two dates of one fiscal year: the opening from
 *             ledger_balance (earlier periods) and the lines of the first period before `from`, every line
 *             with its running balance, the closing. Cursor pages on (date, journal, line)
 *   expenses  expense accounts' net movement from ledger_balance over whole periods, grouped
 *   openings  the opening_balance rows
 *
 * Balances are shown on the account's normal side: positive is normal, negative is the other side.
 * Estate scope: a caller without all estates sees lines of their estates and lines with no estate.
 */

type Amount = { toString(): string } | null;
const money = (v: Dec) => toDecimalString(v.toString(), 'money');
const n = (v: Amount) => dec(v?.toString() ?? '0');

/** SQL condition on a table alias's estate_id: the caller's estates (and none), or everything. */
async function estateCondition(alias: string): Promise<Prisma.Sql> {
  const scope = await scopeToCheck();
  const col = Prisma.raw(`\`${alias}\`.\`estate_id\``);
  if (scope === null || scope.allEstates) return Prisma.sql`1 = 1`;
  if (scope.estates.length === 0) return Prisma.sql`${col} IS NULL`;
  return Prisma.sql`(${col} IS NULL OR ${col} IN (${Prisma.join([...scope.estates])}))`;
}
/** An estate named in the query must be in scope (P10 §18: refused, not silently filtered). */
async function assertEstate(accessLog: AccessLog, estateId: bigint | undefined, module: string) {
  if (estateId === undefined) return;
  const scope = await scopeToCheck();
  if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
  await denyWrite(accessLog, module, estateId, 'read');
}

async function periodFor(tx: Database | Tx, date: BusinessDate) {
  const d = businessDateToDb(date);
  return tx.accountingPeriod.findFirst({
    where: { periodNumber: { lt: 13 }, startDate: { lte: d }, endDate: { gte: d } },
    include: { fiscalYear: { select: { id: true, code: true } } },
  });
}

/** Lines key order for the cursor: journal date, journal id, line number. */
function encodeCursor(date: BusinessDate, journalId: bigint, line: number): string {
  return Buffer.from(`l:${date}:${journalId.toString()}:${String(line)}`, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string | undefined) {
  if (cursor === undefined) return null;
  const m = /^l:(\d{4}-\d{2}-\d{2}):(\d{1,20}):(\d{1,6})$/.exec(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  );
  if (!m?.[1] || !m[2] || !m[3]) {
    throw Errors.validation([
      { field: 'cursor', code: 'VALIDATION_FAILED', message: 'is not a valid cursor' },
    ]);
  }
  return { date: m[1] as BusinessDate, journalId: BigInt(m[2]), line: Number(m[3]) };
}

/** The net expense (debit − credit, base currency) of some periods, from ledger_balance (D-3.04-11). */
export async function expenseOfPeriods(
  tx: Database | Tx,
  periodIds: readonly bigint[],
  filter: { estateId?: bigint | null; costCentreId?: bigint | null } = {},
): Promise<Dec> {
  if (periodIds.length === 0) return dec('0');
  const [r] = await tx.$queryRaw<{ net: Amount }[]>`
    SELECT SUM(lb.period_debit) - SUM(lb.period_credit) AS net
      FROM ledger_balance lb JOIN account a ON a.id = lb.account_id
     WHERE a.account_type = 'expense' AND lb.accounting_period_id IN (${Prisma.join([...periodIds])})
       AND ${filter.estateId ? Prisma.sql`lb.estate_id = ${filter.estateId}` : Prisma.sql`1 = 1`}
       AND ${filter.costCentreId ? Prisma.sql`lb.cost_centre_id = ${filter.costCentreId}` : Prisma.sql`1 = 1`}
       AND ${await estateCondition('lb')}`;
  return n(r?.net ?? null);
}

export const OPENING_LIST_FIELDS: ListFieldMap = {
  fiscal_year_id: { field: 'fiscalYearId', convert: (v) => BigInt(String(v)) },
  account_id: { field: 'accountId', convert: (v) => BigInt(String(v)) },
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  cost_centre_id: { field: 'costCentreId', convert: (v) => BigInt(String(v)) },
  source: { field: 'source' },
};

export function ledgerService(db: Database, accessLog: AccessLog) {
  return {
    async ledger(accountId: bigint, q: z.infer<typeof LedgerQuery>): Promise<z.infer<typeof LedgerOut>> {
      const account = await db.account.findUnique({ where: { id: accountId } });
      if (!account) throw Errors.notFound('Account not found.');
      await assertEstate(accessLog, q.estate_id, 'accounting');
      if (q.to < q.from)
        throw Errors.validation([
          { field: 'to', code: 'VALIDATION_FAILED', message: 'Cannot be before from.' },
        ]);
      const [first, last] = await Promise.all([periodFor(db, q.from), periodFor(db, q.to)]);
      if (!first)
        throw Errors.validation([
          { field: 'from', code: 'VALIDATION_FAILED', message: `No accounting period covers ${q.from}.` },
        ]);
      if (!last)
        throw Errors.validation([
          { field: 'to', code: 'VALIDATION_FAILED', message: `No accounting period covers ${q.to}.` },
        ]);
      if (first.fiscalYearId !== last.fiscalYearId) {
        throw new AppError('RANGE_REQUIRED', 'A ledger covers one fiscal year.', [
          {
            field: 'to',
            code: 'RANGE_REQUIRED',
            message: `From and to are both in ${first.fiscalYear.code}.`,
          },
        ]);
      }

      // The account, or a group's subtree (materialised path, P3 §27.1).
      const ids = account.isPostable
        ? [account.id]
        : (
            await db.account.findMany({
              where: { path: { startsWith: account.path ?? `/${account.id.toString()}/` } },
              select: { id: true },
            })
          ).map((a) => a.id);
      const inIds = Prisma.join(ids.length > 0 ? ids : [0n]);
      const dims = (alias: string) => Prisma.sql`
        ${q.estate_id ? Prisma.sql`${Prisma.raw(alias)}.estate_id = ${q.estate_id}` : Prisma.sql`1 = 1`}
        AND ${q.cost_centre_id ? Prisma.sql`${Prisma.raw(alias)}.cost_centre_id = ${q.cost_centre_id}` : Prisma.sql`1 = 1`}`;
      const lineScope = await estateCondition('jl');
      const from = businessDateToDb(q.from);
      const to = businessDateToDb(q.to);

      const [earlier] = await db.$queryRaw<{ d: Amount; c: Amount }[]>`
        SELECT SUM(lb.period_debit) AS d, SUM(lb.period_credit) AS c
          FROM ledger_balance lb JOIN accounting_period ap ON ap.id = lb.accounting_period_id
         WHERE lb.account_id IN (${inIds}) AND ap.fiscal_year_id = ${first.fiscalYearId}
           AND ap.start_date < ${first.startDate} AND ${dims('lb')} AND ${await estateCondition('lb')}`;
      const [before] = await db.$queryRaw<{ d: Amount; c: Amount }[]>`
        SELECT SUM(jl.debit) AS d, SUM(jl.credit) AS c
          FROM journal_line jl JOIN journal j ON j.id = jl.journal_id
         WHERE jl.account_id IN (${inIds}) AND jl.accounting_period_id = ${first.id}
           AND j.journal_date < ${from} AND ${dims('jl')} AND ${lineScope}`;
      const [range] = await db.$queryRaw<{ d: Amount; c: Amount }[]>`
        SELECT SUM(jl.debit) AS d, SUM(jl.credit) AS c
          FROM journal_line jl JOIN journal j ON j.id = jl.journal_id
         WHERE jl.account_id IN (${inIds}) AND j.journal_date BETWEEN ${from} AND ${to}
           AND ${dims('jl')} AND ${lineScope}`;

      const signed = (d: Dec, c: Dec) => (account.normalBalance === 'debit' ? d.minus(c) : c.minus(d));
      const opening = signed(
        n(earlier?.d ?? null).plus(n(before?.d ?? null)),
        n(earlier?.c ?? null).plus(n(before?.c ?? null)),
      );
      const periodDebit = n(range?.d ?? null);
      const periodCredit = n(range?.c ?? null);

      const after = decodeCursor(q.cursor);
      const afterSql = after
        ? Prisma.sql`(j.journal_date > ${businessDateToDb(after.date)}
            OR (j.journal_date = ${businessDateToDb(after.date)} AND (j.id > ${after.journalId}
              OR (j.id = ${after.journalId} AND jl.line_number > ${after.line}))))`
        : Prisma.sql`1 = 1`;
      // The running balance where this page starts: the opening and every earlier line of the range.
      let running = opening;
      if (after) {
        const [prior] = await db.$queryRaw<{ d: Amount; c: Amount }[]>`
          SELECT SUM(jl.debit) AS d, SUM(jl.credit) AS c
            FROM journal_line jl JOIN journal j ON j.id = jl.journal_id
           WHERE jl.account_id IN (${inIds}) AND j.journal_date BETWEEN ${from} AND ${to}
             AND ${dims('jl')} AND ${lineScope} AND NOT ${afterSql}`;
        running = running.plus(signed(n(prior?.d ?? null), n(prior?.c ?? null)));
      }
      const rows = await db.$queryRaw<
        {
          journal_id: bigint;
          journal_number: string | null;
          journal_type: string;
          journal_date: Date;
          line_number: number;
          account_id: bigint;
          code: string;
          name: string;
          narration: string;
          line_narration: string | null;
          reference: string | null;
          source_type: string | null;
          source_id: bigint | null;
          cost_centre_id: bigint | null;
          estate_id: bigint | null;
          debit: Amount;
          credit: Amount;
        }[]
      >`
        SELECT j.id AS journal_id, j.journal_number, j.journal_type, j.journal_date, jl.line_number,
               a.id AS account_id, a.code, a.name, j.narration, jl.narration AS line_narration, j.reference,
               j.source_type, j.source_id, jl.cost_centre_id, jl.estate_id, jl.debit, jl.credit
          FROM journal_line jl JOIN journal j ON j.id = jl.journal_id JOIN account a ON a.id = jl.account_id
         WHERE jl.account_id IN (${inIds}) AND j.journal_date BETWEEN ${from} AND ${to}
           AND ${dims('jl')} AND ${lineScope} AND ${afterSql}
         ORDER BY j.journal_date, j.id, jl.line_number
         LIMIT ${q.limit + 1}`;
      const page = rows.slice(0, q.limit);
      const lines = page.map((r) => {
        const d = n(r.debit);
        const c = n(r.credit);
        running = running.plus(signed(d, c));
        return {
          journal_id: r.journal_id.toString(),
          journal_number: r.journal_number,
          journal_type: r.journal_type as z.infer<typeof LedgerOut>['lines'][number]['journal_type'],
          journal_date: businessDateFromDb(r.journal_date),
          line_number: r.line_number,
          account: { id: r.account_id.toString(), code: r.code, name: r.name },
          narration: r.line_narration ?? r.narration,
          reference: r.reference,
          source_type: r.source_type,
          source_id: r.source_id?.toString() ?? null,
          cost_centre_id: r.cost_centre_id?.toString() ?? null,
          estate_id: r.estate_id?.toString() ?? null,
          debit: money(d),
          credit: money(c),
          balance: money(running),
        };
      });
      const lastRow = page.at(-1);
      return {
        account: {
          id: account.id.toString(),
          code: account.code,
          name: account.name,
          account_type: account.accountType,
          normal_balance: account.normalBalance as 'debit' | 'credit',
          is_postable: account.isPostable,
        },
        from: q.from,
        to: q.to,
        fiscal_year: { id: first.fiscalYear.id.toString(), code: first.fiscalYear.code },
        estate_id: q.estate_id?.toString() ?? null,
        cost_centre_id: q.cost_centre_id?.toString() ?? null,
        opening: money(opening),
        period_debit: money(periodDebit),
        period_credit: money(periodCredit),
        closing: money(opening.plus(signed(periodDebit, periodCredit))),
        lines,
        next_cursor:
          rows.length > q.limit && lastRow
            ? encodeCursor(businessDateFromDb(lastRow.journal_date), lastRow.journal_id, lastRow.line_number)
            : null,
      };
    },

    async expenses(q: z.infer<typeof ExpensesQuery>): Promise<z.infer<typeof ExpensesOut>> {
      await assertEstate(accessLog, q.estate_id, 'accounting');
      if (q.to < q.from)
        throw Errors.validation([
          { field: 'to', code: 'VALIDATION_FAILED', message: 'Cannot be before from.' },
        ]);
      const periods = await db.accountingPeriod.findMany({
        where: {
          periodNumber: { lt: 13 },
          startDate: { lte: businessDateToDb(q.to) },
          endDate: { gte: businessDateToDb(q.from) },
        },
        select: { id: true, name: true },
        orderBy: { startDate: 'asc' },
      });
      if (periods.length > 36) {
        throw new AppError('RANGE_REQUIRED', 'At most 36 periods at a time.', [
          { field: 'to', code: 'RANGE_REQUIRED', message: 'Narrow the range to three years or less.' },
        ]);
      }
      const ids = periods.map((p) => p.id);
      const group = {
        account: Prisma.sql`a.id AS k, a.code AS code, a.name AS label`,
        cost_centre: Prisma.sql`cc.id AS k, cc.code AS code, IFNULL(cc.name, 'No cost centre') AS label`,
        estate: Prisma.sql`e.id AS k, e.code AS code, IFNULL(e.name, 'Organisation-wide') AS label`,
        period: Prisma.sql`ap.id AS k, NULL AS code, ap.name AS label`,
      }[q.group_by];
      const by = {
        account: Prisma.sql`a.id, a.code, a.name`,
        cost_centre: Prisma.sql`cc.id, cc.code, cc.name`,
        estate: Prisma.sql`e.id, e.code, e.name`,
        period: Prisma.sql`ap.id, ap.name, ap.start_date`,
      }[q.group_by];
      const order = {
        account: Prisma.sql`a.code`,
        cost_centre: Prisma.sql`cc.code`,
        estate: Prisma.sql`e.code`,
        period: Prisma.sql`ap.start_date`,
      }[q.group_by];
      const rows =
        ids.length === 0
          ? []
          : await db.$queryRaw<{ k: bigint | null; code: string | null; label: string; net: Amount }[]>`
        SELECT ${group}, SUM(lb.period_debit) - SUM(lb.period_credit) AS net
          FROM ledger_balance lb
          JOIN account a ON a.id = lb.account_id
          JOIN accounting_period ap ON ap.id = lb.accounting_period_id
          LEFT JOIN cost_centre cc ON cc.id = lb.cost_centre_id
          LEFT JOIN estate e ON e.id = lb.estate_id
         WHERE a.account_type = 'expense' AND lb.accounting_period_id IN (${Prisma.join(ids)})
           AND ${q.estate_id ? Prisma.sql`lb.estate_id = ${q.estate_id}` : Prisma.sql`1 = 1`}
           AND ${q.cost_centre_id ? Prisma.sql`lb.cost_centre_id = ${q.cost_centre_id}` : Prisma.sql`1 = 1`}
           AND ${await estateCondition('lb')}
         GROUP BY ${by}
         ORDER BY ${order}`;
      const out = rows
        .map((r) => ({ key: r.k?.toString() ?? null, code: r.code, label: r.label, amount: n(r.net) }))
        .filter((r) => !r.amount.isZero());
      return {
        from: q.from,
        to: q.to,
        periods: periods.map((p) => ({ id: p.id.toString(), name: p.name })),
        group_by: q.group_by,
        estate_id: q.estate_id?.toString() ?? null,
        cost_centre_id: q.cost_centre_id?.toString() ?? null,
        total: money(out.reduce((s, r) => s.plus(r.amount), dec('0'))),
        rows: out.map((r) => ({ ...r, amount: money(r.amount) })),
      };
    },

    async openings(q: ListQuery): Promise<{ items: z.infer<typeof OpeningBalanceOut>[]; total: number }> {
      const scope = await scopeToCheck();
      const where: Prisma.OpeningBalanceWhereInput = {
        AND: [
          toWhere(q, OPENING_LIST_FIELDS),
          scope === null || scope.allEstates
            ? {}
            : { OR: [{ estateId: null }, { estateId: { in: [...scope.estates] } }] },
        ],
      };
      const named = { select: { id: true, code: true, name: true } } as const;
      const [rows, total] = await Promise.all([
        db.openingBalance.findMany({
          where,
          include: {
            account: named,
            fiscalYear: { select: { id: true, code: true } },
            costCentre: named,
            estate: named,
            journal: { select: { id: true, journalNumber: true } },
          },
          orderBy: [...toOrderBy(q.sort, OPENING_LIST_FIELDS), { account: { code: 'asc' } }, { id: 'asc' }],
          ...toPaging(q),
        }),
        db.openingBalance.count({ where }),
      ]);
      const ref = (r: { id: bigint; code: string; name: string } | null) =>
        r ? { id: r.id.toString(), code: r.code, name: r.name } : null;
      return {
        items: rows.map((r) => ({
          id: r.id.toString(),
          account: { id: r.account.id.toString(), code: r.account.code, name: r.account.name },
          fiscal_year: { id: r.fiscalYear.id.toString(), code: r.fiscalYear.code },
          cost_centre: ref(r.costCentre),
          estate: ref(r.estate),
          debit: money(n(r.debit)),
          credit: money(n(r.credit)),
          source: r.source as 'migration' | 'rollover',
          journal: { id: r.journal.id.toString(), journal_number: r.journal.journalNumber },
          created_at: r.createdAt.toISOString(),
        })),
        total,
      };
    },
  };
}
