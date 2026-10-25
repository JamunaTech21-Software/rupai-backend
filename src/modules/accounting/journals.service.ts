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
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { Dec, dec, round, sum, toDecimalString } from '../../core/money/decimal.js';
import { reverseJournal, writeJournal, type DraftLine } from '../../core/posting/journal.js';
import type { Side } from '../../core/posting/sources.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { businessDateFromDb, businessDateToDb, todayIn, type BusinessDate } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { denyWrite, idOut, iso, versionConflict } from '../organisation/common.js';
import {
  MANUAL_TYPES,
  type CreateJournalBody,
  type DraftLineBody,
  type JournalOutT,
  type PatchJournalBody,
  type ReverseJournalBody,
} from './journals.schema.js';

/**
 * Manual journals (P3.04; Spec P3 §27.3–§27.6, P4 §13.3, P7 §8.9; D-3.04-1 to D-3.04-9).
 *
 *   draft      lines in journal_draft_line, changed freely (each save checks the accounts and dimensions);
 *              may be unbalanced
 *   submitted  balanced, ≥ 2 lines, period accepting it: routed through the `journal` workflow
 *   approved   waiting for a holder of journal.post (sensitive), a different act from approving (SOD-2)
 *   posted     through writeJournal: gapless number, journal_line, ledger_balance; an opening journal
 *              also writes its opening_balance rows. Corrected only by reversal
 *   rejected   final; returned → draft again
 *
 * Every journal (automatic too) is read here; only manual, adjustment and opening journals are written.
 * Scope: a journal of an estate follows estate scope; one with no estate is organisation-wide, seen by
 * every journal.view holder and changed only with all estates (as bank accounts, D-3.02-6).
 */

export const JOURNAL_DOCUMENT = 'journal';
export const JOURNAL_AUDIT: AuditedRecord = {
  type: JOURNAL_DOCUMENT,
  class: 'financial',
  fields: [
    'journal_type',
    'journal_date',
    'narration',
    'reference',
    'estate',
    'currency',
    'exchange_rate',
    'transaction_debit',
    'transaction_credit',
    'line_count',
    'state',
  ],
};

const idf = (v: unknown) => BigInt(String(v));
export const JOURNAL_LIST_FIELDS: ListFieldMap = {
  journal_number: { field: 'journalNumber' },
  journal_type: { field: 'journalType' },
  journal_date: {
    field: 'journalDate',
    convert: (v) => businessDateToDb(String(v) as BusinessDate),
  },
  state: { field: 'state' },
  accounting_period_id: { field: 'accountingPeriodId', convert: idf },
  fiscal_year_id: { field: 'fiscalYearId', convert: idf },
  estate_id: { field: 'estateId', convert: idf },
  reference: { field: 'reference' },
  source_type: { field: 'sourceType' },
  source_id: { field: 'sourceId', convert: idf },
  is_reversed: { field: 'isReversed' },
};

const named = { select: { id: true, code: true, name: true } } as const;
const user = { select: { id: true, username: true } } as const;
const journalInclude = {
  period: { select: { id: true, name: true, state: true, endDate: true } },
  fiscalYear: { select: { id: true, code: true } },
  estate: named,
  currency: { select: { id: true, code: true } },
  reversalOf: { select: { id: true, journalNumber: true } },
  reversals: { select: { id: true, journalNumber: true }, take: 1 },
  submitter: user,
  approver: user,
  poster: user,
  creator: user,
  _count: { select: { lines: true, draftLines: true } },
} as const satisfies Prisma.JournalInclude;
type JournalRow = Prisma.JournalGetPayload<{ include: typeof journalInclude }>;

const lineInclude = { account: named, costCentre: named, estate: named } as const;
type PostedLine = Prisma.JournalLineGetPayload<{ include: typeof lineInclude }>;
type DraftRow = Prisma.JournalDraftLineGetPayload<{ include: typeof lineInclude }>;

type DraftLineIn = z.infer<typeof DraftLineBody>;
type JournalLineOutT = NonNullable<JournalOutT['lines']>[number];

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});
const fail = (
  code:
    | 'UNBALANCED_JOURNAL'
    | 'ACCOUNT_NOT_POSTABLE'
    | 'COST_CENTRE_REQUIRED'
    | 'ESTATE_REQUIRED'
    | 'PERIOD_CLOSED',
  message: string,
  field?: string,
) => new AppError(code, message, [{ code, message, ...(field ? { field } : {}) }]);
const transition = (message: string, state: string, help: string) =>
  new AppError('INVALID_TRANSITION', message, [
    { code: 'INVALID_TRANSITION', message: help, context: { state } },
  ]);
const money = (v: Dec | { toString(): string }) => toDecimalString(v.toString(), 'money');
const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });
const isManual = (type: string) => (MANUAL_TYPES as readonly string[]).includes(type);

/** Transaction-currency totals of a set of lines. */
function totals(lines: readonly { side: string; amount: Dec }[]) {
  const debit = sum(lines.filter((l) => l.side === 'debit').map((l) => l.amount));
  const credit = sum(lines.filter((l) => l.side === 'credit').map((l) => l.amount));
  return { debit, credit };
}

export interface JournalsServiceDeps {
  readonly db: Database;
  readonly accessLog: AccessLog;
  readonly timezone: string;
}

export function journalsService({ db, accessLog, timezone }: JournalsServiceDeps) {
  const today = () => todayIn(timezone);

  /** The journals this caller sees: all, or the organisation-wide ones and their estates'. */
  async function visible(): Promise<Prisma.JournalWhereInput> {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return {};
    return {
      OR: [
        { estateId: null },
        ...(scope.estates.length > 0 ? [{ estateId: { in: [...scope.estates] } }] : []),
      ],
    };
  }
  /** An estate's journal needs that estate; an organisation-wide one needs all estates. */
  async function assertWritable(estateIds: readonly (bigint | null)[], id: bigint | null, operation: string) {
    const scope = await scopeToCheck();
    if (scope === null || scope.allEstates) return;
    for (const e of estateIds) {
      if (e === null || !scope.estates.includes(e)) await denyWrite(accessLog, 'journal', id, operation);
    }
  }

  async function baseCurrencyId(tx: Database | Tx): Promise<bigint> {
    const c = await tx.currency.findFirst({ where: { isBase: true }, select: { id: true } });
    if (!c) throw new Error('journals: the base currency is missing (run the seed)');
    return c.id;
  }

  /** The monthly period covering a date. */
  async function periodFor(tx: Database | Tx, date: BusinessDate) {
    const d = businessDateToDb(date);
    return tx.accountingPeriod.findFirst({
      where: { periodNumber: { lt: 13 }, startDate: { lte: d }, endDate: { gte: d } },
      select: { id: true, fiscalYearId: true, name: true, state: true, endDate: true },
    });
  }
  /** D-3.04-5: the date's period ended before today. */
  const priorPeriod = (p: { endDate: Date }) => businessDateFromDb(p.endDate) < today();

  async function approvalId(tx: Database | Tx, j: { id: bigint; state: string }) {
    if (j.state !== 'submitted') return null;
    return (
      (
        await tx.approvalRequest.findFirst({
          where: { documentType: JOURNAL_DOCUMENT, documentId: j.id, state: 'pending' },
          select: { id: true },
        })
      )?.id ?? null
    );
  }

  const refOut = (r: { id: bigint; code: string; name: string } | null) =>
    r ? { id: r.id.toString(), code: r.code, name: r.name } : null;
  const userOut = (u: { id: bigint; username: string } | null) =>
    u ? { id: u.id.toString(), username: u.username } : null;

  function postedLineOut(l: PostedLine): JournalLineOutT {
    const debit = l.debit.greaterThan(0);
    return {
      line_number: l.lineNumber,
      account: refOut(l.account) ?? { id: '', code: '', name: '' },
      side: debit ? 'debit' : 'credit',
      amount: money(debit ? l.transactionDebit : l.transactionCredit),
      base_amount: money(debit ? l.debit : l.credit),
      cost_centre: refOut(l.costCentre),
      estate: refOut(l.estate),
      department_id: idOut(l.departmentId),
      budget_head_id: idOut(l.budgetHeadId),
      party_type: l.partyType,
      party_id: idOut(l.partyId),
      narration: l.narration,
    };
  }
  function draftLineOut(l: DraftRow): JournalLineOutT {
    return {
      line_number: l.lineNumber,
      account: refOut(l.account) ?? { id: '', code: '', name: '' },
      side: l.side as Side,
      amount: money(l.amount),
      base_amount: null,
      cost_centre: refOut(l.costCentre),
      estate: refOut(l.estate),
      department_id: idOut(l.departmentId),
      budget_head_id: idOut(l.budgetHeadId),
      party_type: null,
      party_id: null,
      narration: l.narration,
    };
  }

  /** The journal's lines: draft lines until posting, journal lines after (automatic journals have no draft). */
  async function linesOf(tx: Database | Tx, j: { id: bigint; state: string }): Promise<JournalLineOutT[]> {
    if (j.state === 'posted') {
      const rows = await tx.journalLine.findMany({
        where: { journalId: j.id },
        include: lineInclude,
        orderBy: { lineNumber: 'asc' },
      });
      return rows.map(postedLineOut);
    }
    const rows = await tx.journalDraftLine.findMany({
      where: { journalId: j.id },
      include: lineInclude,
      orderBy: { lineNumber: 'asc' },
    });
    return rows.map(draftLineOut);
  }

  async function journalOut(tx: Database | Tx, j: JournalRow, withLines: boolean): Promise<JournalOutT> {
    const lines = await linesOf(tx, j);
    const t = totals(lines.map((l) => ({ side: l.side, amount: dec(l.amount) })));
    const reversedBy = j.reversals[0] ?? null;
    return {
      id: j.id.toString(),
      journal_number: j.journalNumber,
      journal_type: j.journalType as JournalOutT['journal_type'],
      journal_date: businessDateFromDb(j.journalDate),
      period: { id: j.period.id.toString(), name: j.period.name, state: j.period.state },
      fiscal_year: { id: j.fiscalYear.id.toString(), code: j.fiscalYear.code },
      narration: j.narration,
      reference: j.reference,
      source_type: j.sourceType,
      source_id: idOut(j.sourceId),
      posting_rule_id: idOut(j.postingRuleId),
      estate: refOut(j.estate),
      currency: { id: j.currency.id.toString(), code: j.currency.code },
      exchange_rate: toDecimalString(j.exchangeRate.toString(), 'rate'),
      transaction_debit: money(t.debit),
      transaction_credit: money(t.credit),
      total_debit: money(j.totalDebit),
      total_credit: money(j.totalCredit),
      is_balanced: lines.length >= 2 && t.debit.equals(t.credit),
      is_prior_period: priorPeriod(j.period),
      reversal_of: j.reversalOf
        ? { id: j.reversalOf.id.toString(), journal_number: j.reversalOf.journalNumber }
        : null,
      reversed_by: reversedBy
        ? { id: reversedBy.id.toString(), journal_number: reversedBy.journalNumber }
        : null,
      is_reversed: j.isReversed,
      state: j.state as JournalOutT['state'],
      approval_id: idOut(await approvalId(tx, j)),
      submitted_at: iso(j.submittedAt),
      submitted_by: userOut(j.submitter),
      approved_at: iso(j.approvedAt),
      approved_by: userOut(j.approver),
      rejection_reason: j.rejectionReason,
      posted_at: iso(j.postedAt),
      posted_by: userOut(j.poster),
      created_by: userOut(j.creator),
      line_count: lines.length,
      ...(withLines ? { lines } : {}),
      version: j.version,
      created_at: j.createdAt.toISOString(),
      updated_at: iso(j.updatedAt),
    };
  }
  /** What the audit trail records of a journal. */
  const auditValues = (o: JournalOutT) => ({
    journal_type: o.journal_type,
    journal_date: o.journal_date,
    narration: o.narration,
    reference: o.reference,
    estate: o.estate?.code ?? null,
    currency: o.currency.code,
    exchange_rate: o.exchange_rate,
    transaction_debit: o.transaction_debit,
    transaction_credit: o.transaction_credit,
    line_count: o.line_count,
    state: o.state,
  });

  async function journalOrNotFound(tx: Database | Tx, id: bigint) {
    const j = await tx.journal.findFirst({
      where: { AND: [{ id }, await visible()] },
      include: journalInclude,
    });
    if (!j) throw Errors.notFound('Journal not found.');
    return j;
  }
  async function manualOrNotFound(tx: Tx, id: bigint) {
    const j = await journalOrNotFound(tx, id);
    if (!isManual(j.journalType)) {
      throw transition(
        `An ${j.journalType} journal is changed only through its source.`,
        j.state,
        'Manual, adjustment and opening journals are written here (P4 §13.3).',
      );
    }
    return j;
  }

  /**
   * D-3.04-3: the lines' accounts and dimensions, on every save. Returns the lines with their estate
   * resolved (the journal's when omitted). Balance and required dimensions wait for submit.
   */
  async function checkLines(tx: Tx, lines: readonly DraftLineIn[], journalEstate: bigint | null) {
    const problems: ErrorDetail[] = [];
    const accounts = new Map(
      (
        await tx.account.findMany({
          where: { id: { in: [...new Set(lines.map((l) => l.account_id))] } },
          select: {
            id: true,
            code: true,
            status: true,
            isPostable: true,
            isControlAccount: true,
            systemKey: true,
          },
        })
      ).map((a) => [a.id, a]),
    );
    const costCentres = new Map(
      (
        await tx.costCentre.findMany({
          where: { id: { in: lines.flatMap((l) => (l.cost_centre_id ? [l.cost_centre_id] : [])) } },
          select: { id: true, code: true, status: true, estateId: true },
        })
      ).map((c) => [c.id, c]),
    );
    for (const [i, l] of lines.entries()) {
      const at = (f: string) => `lines[${String(i)}].${f}`;
      const a = accounts.get(l.account_id);
      if (!a) {
        problems.push(invalid(at('account_id'), 'No such account.'));
      } else if (a.status !== 'active' || !a.isPostable || a.systemKey === 'current_year_result') {
        throw fail(
          'ACCOUNT_NOT_POSTABLE',
          `${a.code} cannot be posted to (${a.status !== 'active' ? 'inactive' : a.isPostable ? 'derived, never posted' : 'a group'}).`,
          at('account_id'),
        );
      } else if (a.isControlAccount) {
        throw fail(
          'ACCOUNT_NOT_POSTABLE',
          `${a.code} is a control account: it posts only through its sub-ledger, never by manual journal.`,
          at('account_id'),
        );
      }
      const estate = l.estate_id === undefined ? journalEstate : l.estate_id;
      if (l.cost_centre_id) {
        const c = costCentres.get(l.cost_centre_id);
        if (c?.status !== 'active')
          problems.push(invalid(at('cost_centre_id'), 'No such active cost centre.'));
        else if (c.estateId !== null && c.estateId !== estate)
          problems.push(invalid(at('cost_centre_id'), `${c.code} belongs to another estate.`));
      }
      if (l.estate_id) {
        const e = await tx.estate.findUnique({ where: { id: l.estate_id }, select: { status: true } });
        if (e?.status !== 'active') problems.push(invalid(at('estate_id'), 'No such active estate.'));
      }
      if (l.department_id) {
        const d = await tx.department.findUnique({
          where: { id: l.department_id },
          select: { status: true },
        });
        if (d?.status !== 'active') problems.push(invalid(at('department_id'), 'No such active department.'));
      }
      if (l.budget_head_id) {
        const b = await tx.budgetHead.findUnique({
          where: { id: l.budget_head_id },
          select: { status: true },
        });
        if (b?.status !== 'active')
          problems.push(invalid(at('budget_head_id'), 'No such active budget head.'));
      }
    }
    if (problems.length > 0) throw Errors.validation(problems);
    return lines.map((l) => ({ ...l, estate_id: l.estate_id === undefined ? journalEstate : l.estate_id }));
  }

  async function checkHeader(
    tx: Tx,
    h: { date: BusinessDate; estateId: bigint | null; currencyId: bigint | null; rate: Dec | null },
  ) {
    const period = await periodFor(tx, h.date);
    if (!period) throw Errors.validation([invalid('journal_date', `No accounting period covers ${h.date}.`)]);
    if (h.estateId !== null) {
      const e = await tx.estate.findUnique({ where: { id: h.estateId }, select: { status: true } });
      if (e?.status !== 'active') throw Errors.validation([invalid('estate_id', 'No such active estate.')]);
    }
    const base = await baseCurrencyId(tx);
    const currencyId = h.currencyId ?? base;
    if (currencyId === base) {
      if (h.rate !== null && !h.rate.equals(1))
        throw Errors.validation([invalid('exchange_rate', 'A base-currency journal has the rate 1.')]);
    } else {
      const c = await tx.currency.findUnique({ where: { id: currencyId }, select: { status: true } });
      if (c?.status !== 'active')
        throw Errors.validation([invalid('currency_id', 'No such active currency.')]);
      if (h.rate === null)
        throw Errors.validation([invalid('exchange_rate', 'A foreign-currency journal needs its rate.')]);
    }
    return { period, currencyId, rate: currencyId === base ? new Dec(1) : (h.rate ?? new Dec(1)) };
  }

  async function replaceLines(tx: Tx, journalId: bigint, lines: Awaited<ReturnType<typeof checkLines>>) {
    await tx.journalDraftLine.deleteMany({ where: { journalId } });
    if (lines.length === 0) return;
    await tx.journalDraftLine.createMany({
      data: lines.map((l, i) => ({
        journalId,
        lineNumber: i + 1,
        accountId: l.account_id,
        side: l.side,
        amount: l.amount.toFixed(4),
        costCentreId: l.cost_centre_id ?? null,
        estateId: l.estate_id ?? null,
        departmentId: l.department_id ?? null,
        budgetHeadId: l.budget_head_id ?? null,
        narration: l.narration ?? null,
      })),
    });
  }

  async function draftLines(tx: Database | Tx, journalId: bigint) {
    return tx.journalDraftLine.findMany({
      where: { journalId },
      include: { account: { select: { code: true, requiresCostCentre: true, requiresEstate: true } } },
      orderBy: { lineNumber: 'asc' },
    });
  }

  /** D-3.04-3/5: what submit and post require of a journal before it reaches the ledger. */
  async function assertReady(tx: Tx, j: JournalRow) {
    const lines = await draftLines(tx, j.id);
    if (lines.length < 2) throw fail('UNBALANCED_JOURNAL', 'A journal has at least two lines.');
    const t = totals(lines.map((l) => ({ side: l.side, amount: dec(l.amount.toString()) })));
    if (!t.debit.equals(t.credit)) {
      throw new AppError('UNBALANCED_JOURNAL', 'Debits and credits differ.', [
        {
          code: 'UNBALANCED_JOURNAL',
          message: 'Debits and credits differ.',
          context: { debit: money(t.debit), credit: money(t.credit) },
        },
      ]);
    }
    for (const l of lines) {
      if (l.account.requiresCostCentre && l.costCentreId === null)
        throw fail('COST_CENTRE_REQUIRED', `${l.account.code} needs a cost centre on every line.`);
      if (l.account.requiresEstate && l.estateId === null)
        throw fail('ESTATE_REQUIRED', `${l.account.code} needs an estate on every line.`);
    }
    const period = await periodFor(tx, businessDateFromDb(j.journalDate));
    const restricted = period?.state === 'soft_closed' || period?.state === 'reopened';
    if (!period || !(period.state === 'open' || (restricted && j.journalType === 'adjustment'))) {
      throw fail(
        'PERIOD_CLOSED',
        restricted
          ? `${period.name} is ${period.state.replace('_', '-')}: only adjustment journals post into it.`
          : `${period?.name ?? 'That period'} is ${period?.state ?? 'missing'}: nothing posts into it.`,
      );
    }
    return { lines, total: t.debit, period };
  }

  const adapter: ApprovalAdapter = {
    documentType: JOURNAL_DOCUMENT,
    async describe(tx, id) {
      const j = await tx.journal.findUniqueOrThrow({ where: { id }, include: journalInclude });
      const lines = await draftLines(tx, id);
      const t = totals(lines.map((l) => ({ side: l.side, amount: dec(l.amount.toString()) })));
      const base = round(t.debit.times(j.exchangeRate.toString()), 4);
      return {
        id,
        number: null,
        label: `${j.journalType === 'manual' ? 'Journal' : `${j.journalType[0]?.toUpperCase() ?? ''}${j.journalType.slice(1)} journal`} ${businessDateFromDb(j.journalDate)} · ${j.narration}`,
        createdBy: j.createdBy,
        estateId: j.estateId,
        values: {
          total_debit: base.toFixed(4),
          journal_type: j.journalType,
          is_prior_period: priorPeriod(j.period),
        },
        amount: base.toFixed(2),
      };
    },
    async onApproved(tx, id, ctx) {
      await lockRowsForUpdate(tx, 'journal', { id });
      const j = await tx.journal.findUniqueOrThrow({ where: { id }, select: { state: true } });
      if (j.state !== 'submitted')
        throw transition(`A ${j.state} journal cannot be approved.`, j.state, 'Reload it.');
      const now = new Date();
      await tx.journal.update({
        where: { id },
        data: {
          state: 'approved',
          stateChangedAt: now,
          approvedAt: now,
          approvedBy: ctx.actorId,
          ...stamp(ctx.actorId),
        },
      });
      await auditAction(tx, JOURNAL_AUDIT, id, 'approve', {
        actorId: ctx.actorId,
        actingForUserId: ctx.actingForUserId,
      });
      await recordStatusChange(tx, JOURNAL_AUDIT.type, id, 'submitted', 'approved', { actorId: ctx.actorId });
    },
    async onRejected(tx, id, ctx) {
      const now = new Date();
      await tx.journal.update({
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
      await auditAction(tx, JOURNAL_AUDIT, id, 'reject', { actorId: ctx.actorId, reason: ctx.reason });
      await recordStatusChange(tx, JOURNAL_AUDIT.type, id, 'submitted', 'rejected', {
        actorId: ctx.actorId,
        comment: ctx.reason,
      });
    },
    async onReturned(tx, id, ctx) {
      await tx.journal.update({
        where: { id },
        data: {
          state: 'draft',
          stateChangedAt: new Date(),
          submittedAt: null,
          submittedBy: null,
          ...stamp(ctx.actorId),
        },
      });
      await recordStatusChange(tx, JOURNAL_AUDIT.type, id, 'submitted', 'draft', {
        actorId: ctx.actorId,
        comment: ctx.comment,
      });
    },
  };

  /** D-3.04-9: one opening_balance row per (account, cost centre, estate) of a posted opening journal. */
  async function writeOpenings(tx: Tx, journalId: bigint, actorId: bigint) {
    const j = await tx.journal.findUniqueOrThrow({
      where: { id: journalId },
      select: { fiscalYearId: true },
    });
    const lines = await tx.journalLine.findMany({ where: { journalId } });
    const net = new Map<
      string,
      { accountId: bigint; costCentreId: bigint | null; estateId: bigint | null; amount: Dec }
    >();
    for (const l of lines) {
      const k = `${l.accountId.toString()}:${String(l.costCentreId)}:${String(l.estateId)}`;
      const t = net.get(k) ?? {
        accountId: l.accountId,
        costCentreId: l.costCentreId,
        estateId: l.estateId,
        amount: dec('0'),
      };
      t.amount = t.amount.plus(l.debit.toString()).minus(l.credit.toString());
      net.set(k, t);
    }
    for (const t of net.values()) {
      if (t.amount.isZero()) continue;
      await tx.openingBalance
        .create({
          data: {
            accountId: t.accountId,
            fiscalYearId: j.fiscalYearId,
            costCentreId: t.costCentreId,
            estateId: t.estateId,
            debit: t.amount.isPositive() ? t.amount.toFixed(4) : '0',
            credit: t.amount.isNegative() ? t.amount.abs().toFixed(4) : '0',
            source: 'migration',
            journalId,
            createdBy: actorId,
          },
        })
        .catch(async (err: unknown) => {
          if (constraintViolation(err)?.kind !== 'unique') throw err;
          const a = await tx.account.findUniqueOrThrow({
            where: { id: t.accountId },
            select: { code: true },
          });
          throw new AppError(
            'DUPLICATE_KEY',
            `${a.code} already has an opening balance for this fiscal year.`,
            [
              {
                code: 'DUPLICATE_KEY',
                message:
                  'One opening per account, fiscal year, cost centre and estate. Reverse the earlier opening journal first.',
                context: { account: a.code },
              },
            ],
          );
        });
    }
  }

  return {
    adapter,

    async list(q: ListQuery) {
      const where: Prisma.JournalWhereInput = {
        AND: [toWhere(q, JOURNAL_LIST_FIELDS), await visible()],
      };
      const [rows, total] = await Promise.all([
        db.journal.findMany({
          where,
          include: journalInclude,
          orderBy: [...toOrderBy(q.sort, JOURNAL_LIST_FIELDS), { id: 'desc' }],
          ...toPaging(q),
        }),
        db.journal.count({ where }),
      ]);
      const items: JournalOutT[] = [];
      for (const r of rows) items.push(await journalOut(db, r, false));
      return { items, total };
    },

    async get(id: bigint) {
      return journalOut(db, await journalOrNotFound(db, id), true);
    },

    async create(b: z.infer<typeof CreateJournalBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const estateId = b.estate_id ?? null;
        const h = await checkHeader(tx, {
          date: b.journal_date,
          estateId,
          currencyId: b.currency_id ?? null,
          rate: b.exchange_rate ?? null,
        });
        const lines = await checkLines(tx, b.lines ?? [], estateId);
        await assertWritable([estateId, ...lines.map((l) => l.estate_id ?? estateId)], null, 'create');
        const now = new Date();
        const j = await tx.journal.create({
          data: {
            journalType: b.journal_type,
            journalDate: businessDateToDb(b.journal_date),
            accountingPeriodId: h.period.id,
            fiscalYearId: h.period.fiscalYearId,
            narration: b.narration,
            reference: b.reference ?? null,
            estateId,
            currencyId: h.currencyId,
            exchangeRate: h.rate.toFixed(8),
            state: 'draft',
            stateChangedAt: now,
            createdBy: actorId,
          },
          select: { id: true },
        });
        await replaceLines(tx, j.id, lines);
        const out = await journalOut(tx, await journalOrNotFound(tx, j.id), true);
        await auditCreate(tx, JOURNAL_AUDIT, j.id, auditValues(out), { actorId });
        await recordStatusChange(tx, JOURNAL_AUDIT.type, j.id, null, 'draft', { actorId });
        return out;
      });
    },

    async update(id: bigint, version: number, b: z.infer<typeof PatchJournalBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'journal', { id });
        const before = await manualOrNotFound(tx, id);
        const old = await journalOut(tx, before, true);
        if (before.version !== version) versionConflict(before, old);
        if (before.state !== 'draft')
          throw transition(
            `A ${before.state} journal cannot be changed.`,
            before.state,
            'Only a draft is changed.',
          );
        const estateId = b.estate_id === undefined ? before.estateId : b.estate_id;
        const date = b.journal_date ?? businessDateFromDb(before.journalDate);
        const h = await checkHeader(tx, {
          date,
          estateId,
          currencyId: b.currency_id === undefined ? before.currencyId : b.currency_id,
          rate:
            b.exchange_rate === undefined
              ? b.currency_id === undefined
                ? dec(before.exchangeRate.toString())
                : null
              : b.exchange_rate,
        });
        // Lines are re-checked on every save: the accounts or the journal's estate may have changed.
        const given: DraftLineIn[] =
          b.lines ??
          (
            await tx.journalDraftLine.findMany({ where: { journalId: id }, orderBy: { lineNumber: 'asc' } })
          ).map((l) => ({
            account_id: l.accountId,
            side: l.side as Side,
            amount: dec(l.amount.toString()),
            cost_centre_id: l.costCentreId,
            estate_id: l.estateId,
            department_id: l.departmentId,
            budget_head_id: l.budgetHeadId,
            narration: l.narration,
          }));
        const lines = await checkLines(tx, given, estateId);
        await assertWritable(
          [before.estateId, estateId, ...lines.map((l) => l.estate_id ?? estateId)],
          id,
          'update',
        );
        await tx.journal.update({
          where: { id },
          data: {
            ...(b.journal_type !== undefined ? { journalType: b.journal_type } : {}),
            journalDate: businessDateToDb(date),
            accountingPeriodId: h.period.id,
            fiscalYearId: h.period.fiscalYearId,
            ...(b.narration !== undefined ? { narration: b.narration } : {}),
            ...(b.reference !== undefined ? { reference: b.reference } : {}),
            estateId,
            currencyId: h.currencyId,
            exchangeRate: h.rate.toFixed(8),
            ...stamp(actorId),
          },
        });
        if (b.lines !== undefined) await replaceLines(tx, id, lines);
        const after = await journalOut(tx, await journalOrNotFound(tx, id), true);
        await auditUpdate(tx, JOURNAL_AUDIT, id, auditValues(old), auditValues(after), { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'journal', { id });
        const j = await manualOrNotFound(tx, id);
        await assertWritable([j.estateId], id, 'delete');
        if (j.state !== 'draft')
          throw transition(
            `A ${j.state} journal cannot be deleted.`,
            j.state,
            j.state === 'posted' ? 'Reverse it instead.' : 'Only a draft is deleted.',
          );
        const out = await journalOut(tx, j, false);
        await tx.journalDraftLine.deleteMany({ where: { journalId: id } });
        await tx.journal.delete({ where: { id } });
        await auditDelete(tx, JOURNAL_AUDIT, id, auditValues(out), { actorId });
      });
    },

    async submit(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'journal', { id });
        const j = await manualOrNotFound(tx, id);
        await assertWritable([j.estateId], id, 'submit');
        if (j.version !== version) versionConflict(j, await journalOut(tx, j, true));
        if (j.state !== 'draft')
          throw transition(
            `A ${j.state} journal cannot be submitted.`,
            j.state,
            'Only a draft is submitted.',
          );
        await assertReady(tx, j);
        const now = new Date();
        await tx.journal.update({
          where: { id },
          data: {
            state: 'submitted',
            stateChangedAt: now,
            submittedAt: now,
            submittedBy: actorId,
            ...stamp(actorId),
          },
        });
        await recordStatusChange(tx, JOURNAL_AUDIT.type, id, 'draft', 'submitted', { actorId });
        await submitForApproval(tx, { timezone }, JOURNAL_DOCUMENT, id, { actorId, date: today() });
        return journalOut(tx, await journalOrNotFound(tx, id), true);
      });
    },

    /** journal.post: the approved journal reaches the ledger (D-3.04-4). */
    async post(id: bigint, version: number, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'journal', { id });
        const j = await manualOrNotFound(tx, id);
        await assertWritable([j.estateId], id, 'post');
        if (j.version !== version) versionConflict(j, await journalOut(tx, j, true));
        if (j.state === 'posted') throw new AppError('ALREADY_POSTED', 'This journal is already posted.');
        if (j.state !== 'approved')
          throw transition(
            `A ${j.state} journal cannot be posted.`,
            j.state,
            'Only an approved journal is posted.',
          );
        const { lines } = await assertReady(tx, j);
        const draft: DraftLine[] = lines.map((l) => ({
          accountId: l.accountId,
          side: l.side as Side,
          amount: dec(l.amount.toString()),
          costCentreId: l.costCentreId,
          estateId: l.estateId,
          departmentId: l.departmentId,
          budgetHeadId: l.budgetHeadId,
          narration: l.narration,
        }));
        await writeJournal(tx, {
          journalId: id,
          journalType: j.journalType as 'manual' | 'adjustment' | 'opening',
          date: businessDateFromDb(j.journalDate),
          narration: j.narration,
          reference: j.reference,
          estateId: j.estateId,
          currencyId: j.currencyId,
          exchangeRate: j.exchangeRate.toFixed(8),
          lines: draft,
          actorId,
          allowRestrictedPeriod: j.journalType === 'adjustment',
        });
        if (j.journalType === 'opening') await writeOpenings(tx, id, actorId);
        await auditAction(tx, JOURNAL_AUDIT, id, 'post', { actorId });
        await recordStatusChange(tx, JOURNAL_AUDIT.type, id, 'approved', 'posted', { actorId });
        return journalOut(tx, await journalOrNotFound(tx, id), true);
      });
    },

    /** D-3.04-6: a posted manual, adjustment or opening journal, reversed at once. Returns the reversal. */
    async reverse(id: bigint, version: number, b: z.infer<typeof ReverseJournalBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'journal', { id });
        const j = await manualOrNotFound(tx, id);
        await assertWritable([j.estateId], id, 'reverse');
        if (j.version !== version) versionConflict(j, await journalOut(tx, j, true));
        const written = await reverseJournal(tx, id, {
          date: b.date,
          ...(b.narration ? { narration: b.narration } : {}),
          actorId,
          allowRestrictedPeriod: j.journalType === 'adjustment',
        });
        // The reversal undoes the opening: a corrected opening journal may then post (D-3.04-9).
        if (j.journalType === 'opening') await tx.openingBalance.deleteMany({ where: { journalId: id } });
        await auditAction(tx, JOURNAL_AUDIT, id, 'reverse', { actorId, reason: b.narration ?? null });
        return journalOut(tx, await journalOrNotFound(tx, written.id), true);
      });
    },
  };
}

export type JournalsService = ReturnType<typeof journalsService>;
