import { constraintViolation } from '../db/errors.js';
import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { Dec, dec, round, sum } from '../money/decimal.js';
import { allocateNumber } from '../numbering/numbering.js';
import { businessDateFromDb, businessDateToDb, type BusinessDate } from '../time/dates.js';
import { REVERSAL_PURPOSE, type PartyType, type Side } from './sources.js';

/**
 * The one journal writer (Spec P1 §7.2, P3 §27.3–§27.6; D-3.03-1, D-3.03-5 to D-3.03-8). Rule-based
 * postings, reversals and P3.04's manual journals all reach the ledger through `writeJournal`, inside the
 * caller's transaction. Every check throws, which aborts the caller: partial posting is not an outcome.
 *
 *   - the period covering the date is open (soft-closed / reopened only for permitted adjustments)
 *   - every account exists, is active and postable, is not Current Year Result, and has the cost centre
 *     and estate it requires
 *   - amounts are positive; base = transaction × rate rounded to 4 places; debit = credit in transaction
 *     currency, and in base currency after at most one unit of rounding per line (to the largest line)
 *   - the gapless JV number is allocated here, in the posting transaction
 *   - ledger_balance and the bank account's current balance change in the same transaction
 */

export interface LineDimensions {
  readonly costCentreId?: bigint | null;
  readonly estateId?: bigint | null;
  readonly departmentId?: bigint | null;
  readonly budgetHeadId?: bigint | null;
  readonly party?: { readonly type: PartyType; readonly id: bigint } | null;
}

export interface DraftLine extends LineDimensions {
  readonly accountId: bigint;
  readonly side: Side;
  /** Transaction currency, > 0. */
  readonly amount: Dec;
  readonly narration?: string | null;
}

export type JournalType = 'automatic' | 'manual' | 'opening' | 'closing' | 'reversal' | 'adjustment';

export interface JournalInput {
  readonly journalType: JournalType;
  readonly date: BusinessDate;
  readonly narration: string;
  readonly reference?: string | null;
  readonly sourceType?: string | null;
  readonly sourceId?: bigint | null;
  readonly postingRuleId?: bigint | null;
  readonly estateId?: bigint | null;
  /** Omitted: the base currency at rate 1. */
  readonly currencyId?: bigint | null;
  readonly exchangeRate?: string | null;
  readonly reversalOfId?: bigint | null;
  readonly lines: readonly DraftLine[];
  readonly actorId: bigint;
  /** Soft-closed or reopened period: allowed for adjustment journals by a permitted poster (P3.04). */
  readonly allowRestrictedPeriod?: boolean;
  /** An existing draft (P3.04 manual journal) to post instead of creating a new journal row. */
  readonly journalId?: bigint;
}

export interface WrittenJournal {
  readonly id: bigint;
  readonly journalNumber: string;
  readonly totalDebit: string;
}

const fail = (code: ErrorCode, message: string, context?: Record<string, unknown>): AppError =>
  new AppError(code, message, [{ code, message, ...(context ? { context } : {}) }]);

const OPEN = new Set(['open']);
const RESTRICTED = new Set(['soft_closed', 'reopened']);

/** The monthly period (1–12) covering a date, with its fiscal year's code. */
async function periodFor(tx: Tx, date: BusinessDate) {
  const d = businessDateToDb(date);
  return tx.accountingPeriod.findFirst({
    where: { periodNumber: { lt: 13 }, startDate: { lte: d }, endDate: { gte: d } },
    include: { fiscalYear: { select: { id: true, code: true } } },
  });
}

/** Base amounts, balanced: rounding differences within one unit per line go to the largest line (D-3.03-8). */
export function toBase(
  lines: readonly { side: Side; amount: Dec }[],
  rate: Dec,
): { base: Dec[]; debit: Dec; credit: Dec } {
  const txDebit = sum(lines.filter((l) => l.side === 'debit').map((l) => l.amount));
  const txCredit = sum(lines.filter((l) => l.side === 'credit').map((l) => l.amount));
  if (!txDebit.equals(txCredit)) {
    throw fail('UNBALANCED_JOURNAL', 'Debits and credits differ.', {
      debit: txDebit.toFixed(4),
      credit: txCredit.toFixed(4),
    });
  }
  const base = lines.map((l) => round(l.amount.times(rate), 4));
  const total = (side: Side) => sum(base.filter((_, i) => lines[i]?.side === side));
  let debit = total('debit');
  let credit = total('credit');
  const diff = debit.minus(credit);
  if (!diff.isZero()) {
    const unit = new Dec('0.0001');
    if (diff.abs().greaterThan(unit.times(lines.length))) {
      throw fail('UNBALANCED_JOURNAL', 'Debits and credits differ in base currency.', {
        debit: debit.toFixed(4),
        credit: credit.toFixed(4),
      });
    }
    const short: Side = diff.isNegative() ? 'debit' : 'credit';
    let at = -1;
    for (const [i, l] of lines.entries()) {
      if (l.side === short && (at < 0 || (base[i] ?? dec('0')).greaterThan(base[at] ?? dec('0')))) at = i;
    }
    base[at] = (base[at] ?? dec('0')).plus(diff.abs());
    debit = total('debit');
    credit = total('credit');
  }
  return { base, debit, credit };
}

async function baseCurrency(tx: Tx): Promise<bigint> {
  const c = await tx.currency.findFirst({ where: { isBase: true }, select: { id: true } });
  if (!c) throw new Error('posting: the base currency is missing (run the seed)');
  return c.id;
}

/** Adds one line's amounts to its ledger_balance row and to the later periods of the fiscal year. */
async function addToLedger(
  tx: Tx,
  period: { id: bigint; startDate: Date; fiscalYearId: bigint },
  key: { accountId: bigint; costCentreId: bigint | null; estateId: bigint | null },
  debit: Dec,
  credit: Dec,
) {
  const d = debit.toFixed(4);
  const c = credit.toFixed(4);
  // Opening of a new row: everything earlier in the fiscal year for the same dimensions.
  const [earlier] = await tx.$queryRaw<
    { d: { toString(): string } | null; c: { toString(): string } | null }[]
  >`
    SELECT SUM(lb.period_debit) AS d, SUM(lb.period_credit) AS c
      FROM ledger_balance lb JOIN accounting_period ap ON ap.id = lb.accounting_period_id
     WHERE lb.account_id = ${key.accountId} AND lb.cost_centre_id <=> ${key.costCentreId}
       AND lb.estate_id <=> ${key.estateId} AND ap.fiscal_year_id = ${period.fiscalYearId}
       AND ap.start_date < ${period.startDate}`;
  const openingDebit = dec(earlier?.d?.toString() ?? '0');
  const openingCredit = dec(earlier?.c?.toString() ?? '0');
  const od = openingDebit.toFixed(4);
  const oc = openingCredit.toFixed(4);
  const cd = openingDebit.plus(debit).toFixed(4);
  const cc = openingCredit.plus(credit).toFixed(4);
  await tx.$executeRaw`
    INSERT INTO ledger_balance (account_id, accounting_period_id, cost_centre_id, estate_id,
        opening_debit, opening_credit, period_debit, period_credit, closing_debit, closing_credit, updated_at)
    VALUES (${key.accountId}, ${period.id}, ${key.costCentreId}, ${key.estateId},
        ${od}, ${oc}, ${d}, ${c}, ${cd}, ${cc}, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE period_debit = period_debit + CAST(${d} AS DECIMAL(18, 4)), period_credit = period_credit + CAST(${c} AS DECIMAL(18, 4)),
        closing_debit = closing_debit + CAST(${d} AS DECIMAL(18, 4)), closing_credit = closing_credit + CAST(${c} AS DECIMAL(18, 4)), updated_at = UTC_TIMESTAMP()`;
  await tx.$executeRaw`
    UPDATE ledger_balance lb JOIN accounting_period ap ON ap.id = lb.accounting_period_id
       SET lb.opening_debit = lb.opening_debit + CAST(${d} AS DECIMAL(18, 4)), lb.opening_credit = lb.opening_credit + CAST(${c} AS DECIMAL(18, 4)),
           lb.closing_debit = lb.closing_debit + CAST(${d} AS DECIMAL(18, 4)), lb.closing_credit = lb.closing_credit + CAST(${c} AS DECIMAL(18, 4)),
           lb.updated_at = UTC_TIMESTAMP()
     WHERE lb.account_id = ${key.accountId} AND lb.cost_centre_id <=> ${key.costCentreId}
       AND lb.estate_id <=> ${key.estateId} AND ap.fiscal_year_id = ${period.fiscalYearId}
       AND ap.start_date > ${period.startDate}`;
}

export async function writeJournal(tx: Tx, input: JournalInput): Promise<WrittenJournal> {
  if (input.lines.length < 2) throw fail('UNBALANCED_JOURNAL', 'A journal has at least two lines.');
  for (const l of input.lines) {
    if (!l.amount.greaterThan(0)) throw fail('UNBALANCED_JOURNAL', 'Every line carries a positive amount.');
  }

  const period = await periodFor(tx, input.date);
  if (!period)
    throw fail('PERIOD_CLOSED', `No accounting period covers ${input.date}.`, { date: input.date });
  const restricted = RESTRICTED.has(period.state);
  if (!OPEN.has(period.state) && !(restricted && input.allowRestrictedPeriod === true)) {
    throw fail(
      'PERIOD_CLOSED',
      restricted
        ? `${period.name} is ${period.state.replace('_', '-')}: only permitted adjustments post into it.`
        : `${period.name} is ${period.state}: nothing posts into it.`,
      { period: period.name, state: period.state },
    );
  }

  const accountIds = [...new Set(input.lines.map((l) => l.accountId))];
  const accounts = new Map(
    (
      await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: {
          id: true,
          code: true,
          isPostable: true,
          status: true,
          systemKey: true,
          requiresCostCentre: true,
          requiresEstate: true,
        },
      })
    ).map((a) => [a.id, a]),
  );
  for (const l of input.lines) {
    const a = accounts.get(l.accountId);
    if (!a || !a.isPostable || a.status !== 'active' || a.systemKey === 'current_year_result') {
      throw fail(
        'ACCOUNT_NOT_POSTABLE',
        a
          ? `${a.code} cannot be posted to (${a.status !== 'active' ? 'inactive' : a.isPostable ? 'derived, never posted' : 'a group'}).`
          : 'No such account.',
        { account_id: l.accountId.toString() },
      );
    }
    const costCentre = l.costCentreId ?? null;
    const estate = l.estateId ?? input.estateId ?? null;
    if (a.requiresCostCentre && costCentre === null) {
      throw fail('COST_CENTRE_REQUIRED', `${a.code} needs a cost centre on every line.`, { account: a.code });
    }
    if (a.requiresEstate && estate === null) {
      throw fail('ESTATE_REQUIRED', `${a.code} needs an estate on every line.`, { account: a.code });
    }
  }

  const base = await baseCurrency(tx);
  const currencyId = input.currencyId ?? base;
  const rate = currencyId === base ? new Dec(1) : dec(input.exchangeRate ?? '0');
  if (currencyId === base && input.exchangeRate && !dec(input.exchangeRate).equals(1)) {
    throw fail('UNBALANCED_JOURNAL', 'A base-currency journal has the rate 1.');
  }
  if (!rate.greaterThan(0))
    throw fail('UNBALANCED_JOURNAL', 'A foreign-currency journal needs its exchange rate.');
  const { base: amounts, debit, credit } = toBase(input.lines, rate);

  const { number } = await allocateNumber(
    tx,
    'journal',
    { date: input.date, fiscalYearCode: period.fiscalYear.code },
    'posting',
  );
  const now = new Date();
  const header = {
    journalNumber: number,
    journalType: input.journalType,
    journalDate: businessDateToDb(input.date),
    accountingPeriodId: period.id,
    fiscalYearId: period.fiscalYearId,
    narration: input.narration.slice(0, 500),
    reference: input.reference?.slice(0, 50) ?? null,
    sourceType: input.sourceType ?? null,
    sourceId: input.sourceId ?? null,
    postingRuleId: input.postingRuleId ?? null,
    estateId: input.estateId ?? null,
    currencyId,
    exchangeRate: rate.toFixed(8),
    totalDebit: debit.toFixed(4),
    totalCredit: credit.toFixed(4),
    reversalOfId: input.reversalOfId ?? null,
    state: 'posted',
    stateChangedAt: now,
    postedAt: now,
    postedBy: input.actorId,
  };
  const journalId =
    input.journalId ??
    (await tx.journal.create({ data: { ...header, createdBy: input.actorId }, select: { id: true } })).id;
  if (input.journalId !== undefined) {
    await tx.journal.update({
      where: { id: input.journalId },
      data: { ...header, version: { increment: 1 }, updatedAt: now, updatedBy: input.actorId },
    });
  }

  await tx.journalLine.createMany({
    data: input.lines.map((l, i) => {
      const amount = (amounts[i] ?? dec('0')).toFixed(4);
      const txAmount = l.amount.toFixed(4);
      return {
        journalId,
        lineNumber: i + 1,
        accountId: l.accountId,
        debit: l.side === 'debit' ? amount : '0',
        credit: l.side === 'credit' ? amount : '0',
        transactionDebit: l.side === 'debit' ? txAmount : '0',
        transactionCredit: l.side === 'credit' ? txAmount : '0',
        costCentreId: l.costCentreId ?? null,
        estateId: l.estateId ?? input.estateId ?? null,
        departmentId: l.departmentId ?? null,
        budgetHeadId: l.budgetHeadId ?? null,
        partyType: l.party?.type ?? null,
        partyId: l.party?.id ?? null,
        narration: l.narration?.slice(0, 300) ?? null,
        accountingPeriodId: period.id,
      };
    }),
  });

  // One ledger_balance change per (account, cost centre, estate); one bank balance change per account.
  const totals = new Map<string, { key: Parameters<typeof addToLedger>[2]; debit: Dec; credit: Dec }>();
  for (const [i, l] of input.lines.entries()) {
    const key = {
      accountId: l.accountId,
      costCentreId: l.costCentreId ?? null,
      estateId: l.estateId ?? input.estateId ?? null,
    };
    const k = `${key.accountId.toString()}:${String(key.costCentreId)}:${String(key.estateId)}`;
    const t = totals.get(k) ?? { key, debit: dec('0'), credit: dec('0') };
    const amount = amounts[i] ?? dec('0');
    if (l.side === 'debit') t.debit = t.debit.plus(amount);
    else t.credit = t.credit.plus(amount);
    totals.set(k, t);
  }
  const byAccount = new Map<bigint, Dec>();
  for (const t of totals.values()) {
    await addToLedger(tx, period, t.key, t.debit, t.credit);
    byAccount.set(
      t.key.accountId,
      (byAccount.get(t.key.accountId) ?? dec('0')).plus(t.debit).minus(t.credit),
    );
  }
  for (const [accountId, net] of byAccount) {
    if (net.isZero()) continue;
    await tx.$executeRaw`
      UPDATE bank_account SET current_balance = current_balance + CAST(${net.toFixed(4)} AS DECIMAL(18, 4)) WHERE account_id = ${accountId}`;
  }

  return { id: journalId, journalNumber: number, totalDebit: debit.toFixed(4) };
}

/**
 * Reverses a posted journal: a new posted journal with every line on the other side, dated `date`, linked
 * by reversal_of_id; the original becomes is_reversed. Linked in posting_link as (journal, id, reversal), so
 * a journal is reversed once (P1 §6.3, D-3.03-7).
 */
export async function reverseJournal(
  tx: Tx,
  journalId: bigint,
  opts: { date: BusinessDate; narration?: string; actorId: bigint; allowRestrictedPeriod?: boolean },
): Promise<WrittenJournal> {
  const original = await tx.journal.findUnique({ where: { id: journalId }, include: { lines: true } });
  if (!original) throw fail('NOT_FOUND', 'Journal not found.');
  if (original.state !== 'posted') throw fail('INVALID_TRANSITION', 'Only a posted journal is reversed.');
  if (original.isReversed) throw fail('INVALID_TRANSITION', 'This journal is already reversed.');
  if (original.reversalOfId !== null) throw fail('INVALID_TRANSITION', 'A reversal is not itself reversed.');
  if (businessDateToDb(opts.date) < original.journalDate) {
    throw fail(
      'INVALID_TRANSITION',
      `A reversal is dated on or after ${businessDateFromDb(original.journalDate)}.`,
    );
  }
  const written = await writeJournal(tx, {
    journalType: 'reversal',
    date: opts.date,
    narration:
      opts.narration ??
      `Reversal of ${original.journalNumber ?? original.id.toString()}: ${original.narration}`,
    reference: original.reference,
    sourceType: original.sourceType,
    sourceId: original.sourceId,
    estateId: original.estateId,
    currencyId: original.currencyId,
    exchangeRate: original.exchangeRate.toFixed(8),
    reversalOfId: original.id,
    actorId: opts.actorId,
    ...(opts.allowRestrictedPeriod ? { allowRestrictedPeriod: true } : {}),
    lines: original.lines
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((l) => ({
        accountId: l.accountId,
        side: l.debit.greaterThan(0) ? ('credit' as const) : ('debit' as const),
        amount: dec((l.debit.greaterThan(0) ? l.transactionDebit : l.transactionCredit).toString()),
        costCentreId: l.costCentreId,
        estateId: l.estateId,
        departmentId: l.departmentId,
        budgetHeadId: l.budgetHeadId,
        party: l.partyType && l.partyId ? { type: l.partyType as PartyType, id: l.partyId } : null,
        narration: l.narration,
      })),
  });
  await tx.postingLink
    .create({
      data: {
        sourceType: 'journal',
        sourceId: original.id,
        purpose: REVERSAL_PURPOSE,
        journalId: written.id,
        postedAt: new Date(),
        postedBy: opts.actorId,
      },
    })
    .catch((err: unknown) => {
      if (constraintViolation(err)?.kind === 'unique')
        throw fail('INVALID_TRANSITION', 'This journal is already reversed.');
      throw err;
    });
  await tx.journal.update({
    where: { id: original.id },
    data: { isReversed: true, version: { increment: 1 }, updatedAt: new Date(), updatedBy: opts.actorId },
  });
  return written;
}
