import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { toDecimalString } from '../../core/money/decimal.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  denyWrite,
  duplicate,
  idIn,
  idOut,
  iso,
  referenced,
  versionConflict,
} from '../organisation/common.js';
import type { Status } from './accounts.schema.js';
import { hasPostings } from './accounts.service.js';
import type { BankAccountOutT, CreateBankAccountBody, PatchBankAccountBody } from './bank-accounts.schema.js';

/**
 * Bank, cash and mobile-money accounts (Spec P3 §27.2, D-3.02-6).
 *
 *   - Each posts to one postable cash-or-bank asset account of the chart, and a chart account has at most
 *     one (ux_bank_chart_account: the spec's check). Its currency is the chart account's (the base
 *     currency when the account has none).
 *   - opening_balance changes only while the chart account has no postings; current_balance and
 *     last_reconciled_on belong to the posting engine and reconciliation (P3.03, P10).
 *   - Scope, as for shifts: an organisation-wide account (no estate) is seen by everyone holding
 *     bank_account.view and changed only with all estates; an estate's account follows estate scope.
 */

export const BANK_ACCOUNT_AUDIT: AuditedRecord = {
  type: 'bank_account',
  class: 'master',
  fields: [
    'code',
    'name',
    'account_id',
    'account_kind',
    'bank_name',
    'branch_name',
    'account_number',
    'currency_id',
    'estate_id',
    'opening_balance',
    'status',
  ],
};

export const BANK_ACCOUNT_LIST_FIELDS: ListFieldMap = {
  code: { field: 'code' },
  name: { field: 'name' },
  status: { field: 'status' },
  account_kind: { field: 'accountKind' },
  estate_id: { field: 'estateId', convert: (v) => BigInt(String(v)) },
  currency_id: { field: 'currencyId', convert: (v) => BigInt(String(v)) },
};

const include = {
  account: { select: { code: true, name: true } },
  currency: { select: { code: true } },
} as const;
type Row = Prisma.BankAccountGetPayload<{ include: typeof include }>;

export function toBankAccountOut(b: Row): BankAccountOutT {
  return {
    id: b.id.toString(),
    code: b.code,
    name: b.name,
    account_id: b.accountId.toString(),
    account_code: b.account.code,
    account_name: b.account.name,
    account_kind: b.accountKind as BankAccountOutT['account_kind'],
    bank_name: b.bankName,
    branch_name: b.branchName,
    account_number: b.accountNumber,
    currency_id: b.currencyId.toString(),
    currency_code: b.currency.code,
    estate_id: idOut(b.estateId),
    opening_balance: toDecimalString(b.openingBalance, 'money'),
    current_balance: toDecimalString(b.currentBalance, 'money'),
    last_reconciled_on: b.lastReconciledOn ? businessDateFromDb(b.lastReconciledOn) : null,
    status: b.status as Status,
    version: b.version,
    created_at: b.createdAt.toISOString(),
    updated_at: iso(b.updatedAt),
  };
}

const invalid = (field: string, message: string) =>
  Errors.validation([{ field, code: 'VALIDATION_FAILED', message }]);
const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });

/** The rows this caller sees: all, or the organisation-wide ones and their estates'. */
async function visible(): Promise<Prisma.BankAccountWhereInput> {
  const scope = await scopeToCheck();
  if (scope === null || scope.allEstates) return {};
  return {
    OR: [{ estateId: null }, ...(scope.estates.length > 0 ? [{ estateId: { in: [...scope.estates] } }] : [])],
  };
}

export function bankAccountsService(db: Database, accessLog: AccessLog) {
  /** Changing an estate's account needs that estate; an organisation-wide one needs all estates. */
  async function assertWritable(estateId: bigint | null, id: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return;
    if (estateId !== null && scope.estates.includes(estateId)) return;
    await denyWrite(accessLog, 'bank_account', id, operation);
  }

  async function orNotFound(tx: Database | Tx, id: bigint): Promise<Row> {
    const b = await tx.bankAccount.findFirst({ where: { id, ...(await visible()) }, include });
    if (!b) throw Errors.notFound('Bank account not found.');
    return b;
  }

  /** The chart account: postable, cash or bank, an asset. Returns the currency the bank account must use. */
  async function chartAccount(tx: Tx, accountId: bigint): Promise<bigint> {
    const a = await tx.account.findUnique({ where: { id: accountId } });
    if (!a) throw invalid('account_id', 'No such account.');
    if (!a.isPostable || !a.isBankOrCash || a.accountType !== 'asset') {
      throw invalid('account_id', `${a.code} is not a postable cash or bank account of the chart.`);
    }
    if (a.currencyId !== null) return a.currencyId;
    const base = await tx.currency.findFirst({ where: { isBase: true }, select: { id: true } });
    if (!base) throw new Error('the base currency is missing: run the seed');
    return base.id;
  }

  async function assertEstate(tx: Tx, estateId: bigint | null) {
    if (estateId !== null && (await tx.estate.count({ where: { id: estateId } })) !== 1) {
      throw invalid('estate_id', 'No such estate.');
    }
  }

  /** A bank account names its bank and its number (ck_bank_account_bank). */
  function assertKind(kind: string, bankName: string | null, accountNumber: string | null) {
    if (kind !== 'bank') return;
    const missing = [
      ...(bankName === null ? [{ field: 'bank_name', message: 'A bank account names its bank.' }] : []),
      ...(accountNumber === null
        ? [{ field: 'account_number', message: 'A bank account gives its account number.' }]
        : []),
    ];
    if (missing.length > 0)
      throw Errors.validation(missing.map((m) => ({ ...m, code: 'VALIDATION_FAILED' as const })));
  }

  const takenChartAccount = (err: unknown): never => {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('ux_bank_chart_account')) {
      throw new AppError('DUPLICATE_KEY', 'That chart account already has a bank account.', [
        { field: 'account_id', code: 'DUPLICATE_KEY', message: 'already has a bank account' },
      ]);
    }
    return duplicate('code', 'Bank account code')(err);
  };

  return {
    async list(q: ListQuery) {
      const where: Prisma.BankAccountWhereInput = {
        AND: [toWhere(q, BANK_ACCOUNT_LIST_FIELDS), await visible()],
      };
      const [rows, total] = await Promise.all([
        db.bankAccount.findMany({
          where,
          include,
          orderBy: [...toOrderBy(q.sort, BANK_ACCOUNT_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.bankAccount.count({ where }),
      ]);
      return { items: rows.map(toBankAccountOut), total };
    },

    async get(id: bigint) {
      return toBankAccountOut(await orNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateBankAccountBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estateId = idIn(b.estate_id ?? null);
        await assertWritable(estateId, null, 'create');
        await assertEstate(tx, estateId);
        const currencyId = await chartAccount(tx, b.account_id);
        if (b.currency_id !== undefined && b.currency_id !== currencyId) {
          throw invalid('currency_id', 'Must be the chart account’s currency.');
        }
        assertKind(b.account_kind, b.bank_name ?? null, b.account_number ?? null);
        const { id } = await tx.bankAccount
          .create({
            data: {
              code: b.code,
              name: b.name,
              accountId: b.account_id,
              accountKind: b.account_kind,
              bankName: b.bank_name ?? null,
              branchName: b.branch_name ?? null,
              accountNumber: b.account_number ?? null,
              currencyId,
              estateId,
              openingBalance: b.opening_balance ?? '0',
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(takenChartAccount);
        const out = toBankAccountOut(await orNotFound(tx, id));
        await auditCreate(tx, BANK_ACCOUNT_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, BANK_ACCOUNT_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(
      id: bigint,
      expectedVersion: number,
      c: z.infer<typeof PatchBankAccountBody>,
      actorId: bigint,
    ) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await assertWritable(before.estateId, id, 'update');
        const estateId = c.estate_id !== undefined ? idIn(c.estate_id) : before.estateId;
        if (estateId !== before.estateId) {
          await assertWritable(estateId, id, 'update');
          await assertEstate(tx, estateId);
        }
        const accountId = c.account_id ?? before.accountId;
        if (accountId !== before.accountId && (await hasPostings(tx, before.accountId))) {
          throw invalid('account_id', 'The chart account has postings: it no longer changes.');
        }
        const openingChanged =
          c.opening_balance !== undefined && !before.openingBalance.equals(c.opening_balance);
        if (openingChanged && (await hasPostings(tx, before.accountId))) {
          throw invalid(
            'opening_balance',
            'The account has postings: the opening balance no longer changes.',
          );
        }
        const currencyId = await chartAccount(tx, accountId);
        if (c.currency_id !== undefined && c.currency_id !== currencyId) {
          throw invalid('currency_id', 'Must be the chart account’s currency.');
        }
        const kind = c.account_kind ?? before.accountKind;
        const bankName = c.bank_name !== undefined ? c.bank_name : before.bankName;
        const number = c.account_number !== undefined ? c.account_number : before.accountNumber;
        assertKind(kind, bankName, number);
        const { count } = await tx.bankAccount
          .updateMany({
            where: { id, version: expectedVersion },
            data: {
              ...(c.code !== undefined ? { code: c.code } : {}),
              ...(c.name !== undefined ? { name: c.name } : {}),
              accountId,
              accountKind: kind,
              bankName,
              branchName: c.branch_name !== undefined ? c.branch_name : before.branchName,
              accountNumber: number,
              currencyId,
              estateId,
              ...(c.opening_balance !== undefined ? { openingBalance: c.opening_balance } : {}),
              ...stamp(actorId),
            },
          })
          .catch(takenChartAccount);
        if (count !== 1) versionConflict(before, toBankAccountOut(before));
        const after = toBankAccountOut(await orNotFound(tx, id));
        await auditUpdate(tx, BANK_ACCOUNT_AUDIT, id, toBankAccountOut(before), after, { actorId });
        return after;
      });
    },

    async setStatus(id: bigint, expectedVersion: number, status: Status, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await orNotFound(tx, id);
        await assertWritable(before.estateId, id, status);
        if (before.version !== expectedVersion) versionConflict(before, toBankAccountOut(before));
        if (before.status === status) return toBankAccountOut(before);
        await tx.bankAccount.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = toBankAccountOut(await orNotFound(tx, id));
        await auditUpdate(tx, BANK_ACCOUNT_AUDIT, id, toBankAccountOut(before), after, { actorId });
        await recordStatusChange(tx, BANK_ACCOUNT_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const b = await orNotFound(tx, id);
        await assertWritable(b.estateId, id, 'delete');
        await tx.bankAccount.delete({ where: { id } }).catch(referenced('bank account'));
        await auditDelete(tx, BANK_ACCOUNT_AUDIT, id, toBankAccountOut(b), { actorId });
      });
    },
  };
}
