import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';
import type { BusinessDate } from '../time/dates.js';
import { DOCUMENT_TYPE_BY_KEY } from './document-types.js';

/**
 * Document numbering (Spec P1 §15.2, P2 §6.5, P3 §28.6).
 *
 *   allocateNumber(tx, …) takes the next number of a document type IN THE CALLER'S TRANSACTION. The
 *   sequence row is locked until that transaction ends, so:
 *     - two allocations can never return the same number
 *     - if the transaction rolls back, the increment rolls back with it: no gap
 *   A GAPLESS (financial) document therefore allocates at posting, inside the posting transaction, and
 *   an operational one at draft creation, where a cancelled draft may leave a harmless gap. Allocating a
 *   gapless number at draft time is refused: that is how gaps would get in.
 *
 * A sequence counts within a SCOPE: the estate, fiscal year and season the format includes, and the reset
 * period. Every part of the scope also appears in the rendered number, so numbers of one document type
 * never collide across scopes:
 *
 *     PO-DEMO-A-FY2026-27-00042      prefix, estate, fiscal year, sequence
 *     GRN-2026-00007                 yearly reset without a fiscal year component: the calendar year
 *     LT-202610-00003                monthly reset: the year and month
 */

export const RESET_FREQUENCIES = ['never', 'yearly', 'monthly'] as const;
export type ResetFrequency = (typeof RESET_FREQUENCIES)[number];

export interface NumberFormatShape {
  readonly documentType: string;
  readonly prefix: string;
  readonly includeFiscalYear: boolean;
  readonly includeSeason: boolean;
  readonly includeEstateCode: boolean;
  readonly separator: string;
  readonly sequenceWidth: number;
  readonly resetFrequency: string;
  readonly isGapless: boolean;
}

/** What the document knows about itself. A component the format includes must be given. */
export interface NumberContext {
  /** The document date: decides the reset period. */
  readonly date: BusinessDate;
  readonly estateCode?: string | null;
  readonly fiscalYearCode?: string | null;
  readonly seasonCode?: string | null;
}

export interface NumberParts {
  /** The sequence's scope: what the counter is unique within. */
  readonly scopeKey: string;
  /** The parts printed before the sequence, in order. */
  readonly segments: readonly string[];
}

const missing = (format: NumberFormatShape, what: string) =>
  new Error(`numbering: ${format.documentType} numbers include the ${what}, but the caller gave none`);

/** The scope and printed parts of a number. Pure. */
export function numberParts(format: NumberFormatShape, ctx: NumberContext): NumberParts {
  const scope: string[] = [];
  const segments: string[] = [format.prefix];
  if (format.includeEstateCode) {
    if (!ctx.estateCode) throw missing(format, 'estate code');
    scope.push(`E:${ctx.estateCode}`);
    segments.push(ctx.estateCode);
  }
  if (format.includeFiscalYear) {
    if (!ctx.fiscalYearCode) throw missing(format, 'fiscal year');
    scope.push(`FY:${ctx.fiscalYearCode}`);
    segments.push(ctx.fiscalYearCode);
  }
  if (format.includeSeason) {
    if (!ctx.seasonCode) throw missing(format, 'season');
    scope.push(`S:${ctx.seasonCode}`);
    segments.push(ctx.seasonCode);
  }
  const [year = '', month = ''] = ctx.date.split('-');
  if (format.resetFrequency === 'monthly') {
    scope.push(`M:${year}-${month}`);
    segments.push(`${year}${month}`);
  } else if (format.resetFrequency === 'yearly' && !format.includeFiscalYear && !format.includeSeason) {
    // A fiscal year or season in the number already restarts it each year.
    scope.push(`Y:${year}`);
    segments.push(year);
  }
  return { scopeKey: scope.length === 0 ? '*' : scope.join('|'), segments };
}

/** The printed number for a sequence value. Pure. */
export function renderNumber(
  format: NumberFormatShape,
  ctx: NumberContext,
  sequence: bigint | number,
): string {
  const { segments } = numberParts(format, ctx);
  return [...segments, String(sequence).padStart(format.sequenceWidth, '0')].join(format.separator);
}

export interface AllocatedNumber {
  readonly number: string;
  readonly sequence: bigint;
  readonly scopeKey: string;
}

/**
 * Takes the next number of `documentType` inside `tx`.
 * @param at 'posting' for the posting transaction of a financial document; 'draft' at draft creation.
 * @throws when the document type has no format, or a gapless number is asked for at draft time.
 */
export async function allocateNumber(
  tx: Tx,
  documentType: string,
  ctx: NumberContext,
  at: 'draft' | 'posting',
): Promise<AllocatedNumber> {
  if (!DOCUMENT_TYPE_BY_KEY.has(documentType))
    throw new Error(`numbering: unknown document type ${documentType}`);
  const format = await tx.numberFormat.findUnique({ where: { documentType } });
  if (!format) {
    throw new AppError('INVARIANT_VIOLATED', `No number format is configured for ${documentType}.`, [
      { code: 'INVARIANT_VIOLATED', message: 'Run the seed, which creates one per document type.' },
    ]);
  }
  if (format.isGapless && at !== 'posting') {
    throw new Error(`numbering: ${documentType} is gapless; allocate its number in the posting transaction`);
  }
  const { scopeKey } = numberParts(format, ctx);
  // One statement that takes the row's exclusive lock whether it inserts or updates. Selecting first and
  // then inserting would let two first allocations hold shared locks on each other and deadlock.
  await tx.$executeRaw`
    INSERT INTO number_sequence (document_type, scope_key, last_number, updated_at)
    VALUES (${documentType}, ${scopeKey}, 1, UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE last_number = last_number + 1, updated_at = UTC_TIMESTAMP()`;
  const [row] = await tx.$queryRaw<{ last_number: bigint | number }[]>`
    SELECT last_number FROM number_sequence WHERE document_type = ${documentType} AND scope_key = ${scopeKey}`;
  if (!row) throw new Error('numbering: the sequence row vanished inside its own transaction');
  const sequence = BigInt(row.last_number);
  return { number: renderNumber(format, ctx, sequence), sequence, scopeKey };
}
