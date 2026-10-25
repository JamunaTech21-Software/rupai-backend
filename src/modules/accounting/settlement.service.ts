import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, sum, toDecimalString } from '../../core/money/decimal.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { partyLabels } from '../../core/settlement/parties.js';
import {
  AGEING_BANDS,
  OPEN_STATES,
  SIDES,
  type AgeingBand,
  type SettlementSide,
  type SettlementState,
} from '../../core/settlement/sides.js';
import {
  businessDateFromDb,
  businessDateToDb,
  diffDays,
  todayIn,
  type BusinessDate,
} from '../../core/time/dates.js';
import { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, iso } from '../organisation/common.js';
import type { AgeingOut, AgeingQuery } from './settlement.schema.js';

/**
 * Receivables and payables, read only (P3.05; Spec P3 §15, §16.7, P4 §11.2–§11.3; D-3.05-11, D-3.05-14).
 * They are derived records: only core/settlement writes them, so nothing here does. An item of an estate
 * follows estate scope; one with no estate is organisation-wide.
 */

const idf = (v: string | number | boolean) => BigInt(String(v));
const datef = (v: string | number | boolean) => businessDateToDb(String(v) as BusinessDate);

export const SETTLEMENT_LIST_FIELDS: ListFieldMap = {
  party_type: { field: 'partyType' },
  party_id: { field: 'partyId', convert: idf },
  state: { field: 'state' },
  ageing_band: { field: 'ageingBand' },
  due_date: { field: 'dueDate', convert: datef },
  document_date: { field: 'documentDate', convert: datef },
  estate_id: { field: 'estateId', convert: idf },
  source_type: { field: 'sourceType' },
  source_id: { field: 'sourceId', convert: idf },
  reference_number: { field: 'referenceNumber' },
  currency_id: { field: 'currencyId', convert: idf },
  outstanding_amount: { field: 'outstandingAmount' },
};
/** Not a column: open and past its due date as at today. */
export const OVERDUE_FILTER = 'is_overdue';

const money = (v: { toString(): string } | null) => toDecimalString(v?.toString() ?? '0', 'money');
const named = { select: { id: true, code: true, name: true } } as const;
const include = {
  estate: named,
  currency: { select: { id: true, code: true } },
  period: { select: { id: true, name: true } },
} as const;

interface ItemRow {
  id: bigint;
  sourceType: string;
  sourceId: bigint;
  referenceNumber: string;
  partyType: string;
  partyId: bigint;
  estate: { id: bigint; code: string; name: string } | null;
  documentDate: Date;
  dueDate: Date;
  currency: { id: bigint; code: string };
  exchangeRate: Prisma.Decimal;
  originalAmount: Prisma.Decimal;
  originalBaseAmount: Prisma.Decimal;
  settledAmount: Prisma.Decimal;
  adjustedAmount: Prisma.Decimal;
  settledBaseAmount: Prisma.Decimal;
  outstandingAmount: Prisma.Decimal | null;
  outstandingBaseAmount: Prisma.Decimal | null;
  ageingBand: string | null;
  state: string;
  period: { id: bigint; name: string };
  createdAt: Date;
  updatedAt: Date | null;
}

export interface SettlementServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function settlementService({ db, accessLog, timezone }: SettlementServiceDeps) {
  /** The items this caller sees: all, or the organisation-wide ones and their estates'. */
  async function visible(): Promise<Prisma.ReceivableWhereInput> {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return {};
    return {
      OR: [
        { estateId: null },
        ...(scope.estates.length > 0 ? [{ estateId: { in: [...scope.estates] } }] : []),
      ],
    };
  }

  // The two delegates differ only in the settled column's name (D-3.05-2).
  async function findItems(
    side: SettlementSide,
    args: {
      where: Prisma.ReceivableWhereInput;
      orderBy?: Prisma.ReceivableOrderByWithRelationInput[];
      skip?: number;
      take?: number;
    },
  ): Promise<ItemRow[]> {
    if (side === 'receivable') {
      const rows = await db.receivable.findMany({ ...args, include });
      return rows.map((r) => ({ ...r, settledAmount: r.receivedAmount }));
    }
    const rows = await db.payable.findMany({
      ...(args as Prisma.PayableFindManyArgs),
      include,
    });
    return rows.map((r) => ({ ...r, settledAmount: r.paidAmount }));
  }
  function countItems(side: SettlementSide, where: Prisma.ReceivableWhereInput): Promise<number> {
    return side === 'receivable'
      ? db.receivable.count({ where })
      : db.payable.count({ where: where as Prisma.PayableWhereInput });
  }

  async function out(side: SettlementSide, rows: ItemRow[]) {
    const today = todayIn(timezone);
    const labels = await partyLabels(
      db,
      rows.map((r) => ({ type: r.partyType, id: r.partyId })),
    );
    const settledKey = side === 'receivable' ? 'received_amount' : 'paid_amount';
    return rows.map((r) => {
      const due = businessDateFromDb(r.dueDate);
      const open = OPEN_STATES.includes(r.state as SettlementState);
      const label = labels.get(`${r.partyType}:${String(r.partyId)}`);
      return {
        id: r.id.toString(),
        source_type: r.sourceType,
        source_id: r.sourceId.toString(),
        reference_number: r.referenceNumber,
        party: {
          type: r.partyType,
          id: r.partyId.toString(),
          code: label?.code ?? null,
          name: label?.name ?? null,
        },
        estate: r.estate ? { id: r.estate.id.toString(), code: r.estate.code, name: r.estate.name } : null,
        document_date: businessDateFromDb(r.documentDate),
        due_date: due,
        days_overdue: open ? Math.max(0, diffDays(due, today)) : 0,
        currency: { id: r.currency.id.toString(), code: r.currency.code },
        exchange_rate: toDecimalString(r.exchangeRate.toString(), 'rate'),
        original_amount: money(r.originalAmount),
        original_base_amount: money(r.originalBaseAmount),
        [settledKey]: money(r.settledAmount),
        adjusted_amount: money(r.adjustedAmount),
        settled_base_amount: money(r.settledBaseAmount),
        outstanding_amount: money(r.outstandingAmount),
        outstanding_base_amount: money(r.outstandingBaseAmount),
        ageing_band: r.ageingBand,
        state: r.state,
        accounting_period: { id: r.period.id.toString(), name: r.period.name },
        created_at: r.createdAt.toISOString(),
        updated_at: iso(r.updatedAt),
      };
    });
  }

  async function itemOrNotFound(side: SettlementSide, id: bigint): Promise<ItemRow> {
    const [row] = await findItems(side, { where: { AND: [{ id }, await visible()] } });
    if (!row) throw Errors.notFound(`The ${side} was not found.`);
    return row;
  }

  async function assertEstate(side: SettlementSide, estateId: bigint | undefined) {
    if (estateId === undefined) return;
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates || scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, side, estateId, 'read');
  }

  return {
    async list(side: SettlementSide, q: ListQuery) {
      const overdue = q.filters.find((f) => f.field === OVERDUE_FILTER);
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== OVERDUE_FILTER) };
      const today = businessDateToDb(todayIn(timezone));
      const overdueWhere: Prisma.ReceivableWhereInput[] = !overdue
        ? []
        : overdue.value === true || overdue.value === 'true'
          ? [{ state: { in: [...OPEN_STATES] }, dueDate: { lt: today } }]
          : [{ NOT: { state: { in: [...OPEN_STATES] }, dueDate: { lt: today } } }];
      const where: Prisma.ReceivableWhereInput = {
        AND: [toWhere(rest, SETTLEMENT_LIST_FIELDS), ...overdueWhere, await visible()],
      };
      const [rows, total] = await Promise.all([
        findItems(side, {
          where,
          orderBy: [...toOrderBy(q.sort, SETTLEMENT_LIST_FIELDS), { id: 'desc' }],
          ...toPaging(q),
        }),
        countItems(side, where),
      ]);
      return { items: await out(side, rows), total };
    },

    async get(side: SettlementSide, id: bigint) {
      const [item] = await out(side, [await itemOrNotFound(side, id)]);
      return item;
    },

    /** The collections / payments allocated to an item, drafts included (applied = posted, not reversed). */
    async allocations(side: SettlementSide, id: bigint) {
      await itemOrNotFound(side, id);
      const doc = (d: {
        id: bigint;
        number: string | null;
        date: Date;
        state: string;
        isReversed: boolean;
      }) => ({
        id: d.id.toString(),
        number: d.number,
        date: businessDateFromDb(d.date),
        state: d.state,
        is_reversed: d.isReversed,
      });
      const common = (a: {
        id: bigint;
        amount: Prisma.Decimal;
        baseAmount: Prisma.Decimal;
        fxGainLoss: Prisma.Decimal;
        sequence: number;
      }) => ({
        id: a.id.toString(),
        amount: money(a.amount),
        base_amount: money(a.baseAmount),
        fx_gain_loss: money(a.fxGainLoss),
        sequence: a.sequence,
      });
      const docSelect = { select: { id: true, state: true, isReversed: true } } as const;
      if (side === 'receivable') {
        const rows = await db.collectionAllocation.findMany({
          where: { receivableId: id },
          include: {
            collection: { select: { ...docSelect.select, collectionNumber: true, collectionDate: true } },
          },
          orderBy: { id: 'asc' },
        });
        return rows.map((a) => ({
          ...common(a),
          applied: a.collection.state === 'posted' && !a.collection.isReversed,
          collection: doc({
            ...a.collection,
            number: a.collection.collectionNumber,
            date: a.collection.collectionDate,
          }),
        }));
      }
      const rows = await db.paymentAllocation.findMany({
        where: { payableId: id },
        include: { payment: { select: { ...docSelect.select, paymentNumber: true, paymentDate: true } } },
        orderBy: { id: 'asc' },
      });
      return rows.map((a) => ({
        ...common(a),
        applied: a.payment.state === 'posted' && !a.payment.isReversed,
        payment: doc({ ...a.payment, number: a.payment.paymentNumber, date: a.payment.paymentDate }),
      }));
    },

    /** Open items by ageing band as at today, live from the sub-ledger (D-3.05-11). Base currency. */
    async ageing(side: SettlementSide, q: z.infer<typeof AgeingQuery>): Promise<z.infer<typeof AgeingOut>> {
      await assertEstate(side, q.estate_id);
      const def = SIDES[side];
      const asAt = todayIn(timezone);
      const t = businessDateToDb(asAt);
      const scope = await scopeToCheck();
      const conditions: Prisma.Sql[] = [Prisma.sql`state IN ('open', 'partially_settled')`];
      if (scope !== null && !scope.allEstates) {
        conditions.push(
          scope.estates.length === 0
            ? Prisma.sql`estate_id IS NULL`
            : Prisma.sql`(estate_id IS NULL OR estate_id IN (${Prisma.join([...scope.estates])}))`,
        );
      }
      if (q.estate_id !== undefined) conditions.push(Prisma.sql`estate_id = ${q.estate_id}`);
      if (q.party_type !== undefined) conditions.push(Prisma.sql`party_type = ${q.party_type}`);
      if (q.party_id !== undefined) conditions.push(Prisma.sql`party_id = ${q.party_id}`);
      const rows = await db.$queryRaw<
        {
          party_type: string;
          party_id: bigint;
          band: AgeingBand;
          n: bigint;
          amount: { toString(): string };
        }[]
      >`
        SELECT party_type, party_id, band, COUNT(*) AS n, SUM(outstanding_base_amount) AS amount FROM (
          SELECT party_type, party_id, outstanding_base_amount, CASE
                   WHEN DATEDIFF(${t}, due_date) <= 0 THEN 'current'
                   WHEN DATEDIFF(${t}, due_date) <= 30 THEN '1_30'
                   WHEN DATEDIFF(${t}, due_date) <= 60 THEN '31_60'
                   WHEN DATEDIFF(${t}, due_date) <= 90 THEN '61_90'
                   ELSE 'over_90' END AS band
            FROM ${Prisma.raw(`\`${def.item}\``)} WHERE ${Prisma.join(conditions, ' AND ')}
        ) x GROUP BY party_type, party_id, band`;

      const bands = AGEING_BANDS.map((band) => {
        const of = rows.filter((r) => r.band === band);
        return {
          band,
          count: of.reduce((n, r) => n + Number(r.n), 0),
          amount: money(sum(of.map((r) => dec(r.amount.toString())))),
        };
      });
      const total = sum(rows.map((r) => dec(r.amount.toString())));
      let parties: z.infer<typeof AgeingOut>['parties'] = [];
      if (q.group_by === 'party') {
        const keys = [...new Set(rows.map((r) => `${r.party_type}:${String(r.party_id)}`))];
        const labels = await partyLabels(
          db,
          keys.map((k) => {
            const [type = '', id = '0'] = k.split(':');
            return { type, id: BigInt(id) };
          }),
        );
        parties = keys
          .map((k) => {
            const [type = '', id = '0'] = k.split(':');
            const of = rows.filter((r) => `${r.party_type}:${String(r.party_id)}` === k);
            const amountIn = (band: AgeingBand) =>
              sum(of.filter((r) => r.band === band).map((r) => dec(r.amount.toString())));
            const label = labels.get(k);
            return {
              party: { type, id, code: label?.code ?? null, name: label?.name ?? null },
              current: money(amountIn('current')),
              '1_30': money(amountIn('1_30')),
              '31_60': money(amountIn('31_60')),
              '61_90': money(amountIn('61_90')),
              over_90: money(amountIn('over_90')),
              total: money(sum(of.map((r) => dec(r.amount.toString())))),
            };
          })
          .sort((a, b) => dec(b.total).comparedTo(dec(a.total)));
      }
      return {
        as_at: asAt,
        group_by: q.group_by,
        estate_id: q.estate_id?.toString() ?? null,
        total: money(total),
        count: rows.reduce((n, r) => n + Number(r.n), 0),
        bands,
        parties,
      };
    },
  };
}
