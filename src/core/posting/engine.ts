import { evaluateAll, type Condition, type DocumentValues } from '../approval/conditions.js';
import { constraintViolation } from '../db/errors.js';
import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { dec, type Dec } from '../money/decimal.js';
import { businessDateToDb, type BusinessDate } from '../time/dates.js';
import { writeJournal, type DraftLine, type LineDimensions } from './journal.js';
import {
  accountResolver,
  postableSource,
  splitResolutionKey,
  type AccountResolution,
  type PostingPurpose,
  type Side,
} from './sources.js';

/**
 * PostingService.post (Spec P1 §7.2, §7.7; D-3.03-2 to D-3.03-4): a document's facts in, a posted journal
 * out, inside the document's own approval transaction.
 *
 *   1. posting_link already holds (source, purpose) → already posted: a no-op returning that journal
 *   2. the rule: active, in force on the date, conditions hold, lowest sequence (tie → RULE_AMBIGUOUS,
 *      none → RULE_NOT_FOUND)
 *   3. one line per rule line and amount item, the account resolved and stored (never re-resolved)
 *   4. writeJournal (every assertion of Fig 7.1) and the posting_link row, same transaction
 */

/** One amount of a document, with what it alone knows (payroll: a component on a cost centre). */
export interface PostingItem extends LineDimensions {
  /** Transaction currency, as a decimal string, ≥ 0. Zero makes no line. */
  readonly amount: string;
  /** Accounts this item names, by from_account_field resolution key. */
  readonly accounts?: Readonly<Record<string, bigint | null>>;
  /** Records the registered resolvers read, by resolution key (component, material_category, …). */
  readonly refs?: Readonly<Record<string, bigint | null>>;
  readonly narration?: string | null;
}

export interface PostingRequest {
  readonly sourceType: string;
  readonly sourceId: bigint;
  readonly purpose: PostingPurpose;
  readonly date: BusinessDate;
  /** The document number, for human lookup. */
  readonly reference: string | null;
  readonly narration: string;
  readonly estateId?: bigint | null;
  readonly currencyId?: bigint | null;
  readonly exchangeRate?: string | null;
  /** By amount_source: one amount, or items. */
  readonly amounts: Readonly<Record<string, string | readonly PostingItem[]>>;
  /** Accounts the document names (from_account_field), for every item. */
  readonly accounts?: Readonly<Record<string, bigint | null>>;
  /** Dimensions for every line unless an item gives its own. */
  readonly dimensions?: LineDimensions;
  /** What the rules' conditions test. */
  readonly values?: DocumentValues;
  readonly actorId: bigint;
}

export interface PostingResult {
  readonly journalId: bigint;
  readonly journalNumber: string | null;
  /** True when (source, purpose) had already posted: nothing was written. */
  readonly alreadyPosted: boolean;
}

export interface RuleLineShape {
  readonly side: string;
  readonly accountResolution: string;
  readonly accountId: bigint | null;
  readonly resolutionKey: string | null;
  readonly amountSource: string;
  readonly sequence: number;
  readonly narration: string | null;
}

/** A line as built, before the writer's checks. account null: resolved by a resolver not yet available. */
export interface BuiltLine extends LineDimensions {
  readonly ruleLine: number;
  readonly side: Side;
  readonly accountId: bigint | null;
  readonly amount: Dec;
  readonly narration: string | null;
}

const fail = (code: ErrorCode, message: string, context?: Record<string, unknown>): AppError =>
  new AppError(code, message, [{ code, message, ...(context ? { context } : {}) }]);

function itemsOf(value: string | readonly PostingItem[] | undefined): readonly PostingItem[] {
  if (value === undefined) return [];
  return typeof value === 'string' ? [{ amount: value }] : value;
}

/**
 * The lines a rule produces for a document. `strict` (posting): every account must resolve. Not strict
 * (preview): an account a resolver cannot find yet stays null.
 */
export async function buildLines(
  tx: Tx,
  ruleLines: readonly RuleLineShape[],
  req: Pick<PostingRequest, 'amounts' | 'accounts' | 'dimensions'>,
  strict: boolean,
): Promise<BuiltLine[]> {
  const out: BuiltLine[] = [];
  for (const rl of [...ruleLines].sort((a, b) => a.sequence - b.sequence)) {
    for (const item of itemsOf(req.amounts[rl.amountSource])) {
      const amount = dec(item.amount);
      if (amount.isNegative()) {
        throw fail('UNBALANCED_JOURNAL', `${rl.amountSource} is negative: amounts are never negative.`);
      }
      if (amount.isZero()) continue;
      const resolution = rl.accountResolution as AccountResolution;
      const key = rl.resolutionKey ?? '';
      let accountId: bigint | null;
      if (resolution === 'fixed') accountId = rl.accountId;
      else if (resolution === 'from_account_field')
        accountId = item.accounts?.[key] ?? req.accounts?.[key] ?? null;
      else {
        const resolver = accountResolver(resolution);
        const { ref: refName, field } = splitResolutionKey(key);
        const ref = item.refs?.[refName] ?? null;
        accountId = resolver && ref !== null ? await resolver(tx, ref, field) : null;
      }
      if (accountId === null && strict) {
        throw fail('ACCOUNT_NOT_POSTABLE', `No account for ${rl.amountSource} (${resolution} ${key}).`, {
          amount_source: rl.amountSource,
          resolution,
          resolution_key: key,
        });
      }
      const dims = req.dimensions ?? {};
      out.push({
        ruleLine: rl.sequence,
        side: rl.side as Side,
        accountId,
        amount,
        narration: item.narration ?? rl.narration,
        costCentreId: item.costCentreId !== undefined ? item.costCentreId : (dims.costCentreId ?? null),
        estateId: item.estateId !== undefined ? item.estateId : (dims.estateId ?? null),
        departmentId: item.departmentId !== undefined ? item.departmentId : (dims.departmentId ?? null),
        budgetHeadId: item.budgetHeadId !== undefined ? item.budgetHeadId : (dims.budgetHeadId ?? null),
        party: item.party !== undefined ? item.party : (dims.party ?? null),
      });
    }
  }
  return out;
}

/** The rule in force for (source, purpose) on a date whose conditions hold. */
export async function selectPostingRule(
  tx: Tx,
  sourceType: string,
  purpose: string,
  date: BusinessDate,
  values: DocumentValues,
) {
  const d = businessDateToDb(date);
  const candidates = await tx.postingRule.findMany({
    where: {
      sourceType,
      purpose,
      isActive: true,
      effectiveFrom: { lte: d },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: d } }],
    },
    include: { lines: true },
    orderBy: [{ sequence: 'asc' }, { id: 'asc' }],
  });
  const matching = candidates.filter((r) => evaluateAll(r.conditionJson as unknown as Condition[], values));
  const [first, second] = matching;
  if (!first) {
    throw fail('RULE_NOT_FOUND', `No active posting rule for ${sourceType} (${purpose}) on ${date}.`, {
      source_type: sourceType,
      purpose,
      date,
    });
  }
  if (second?.sequence === first.sequence) {
    throw fail('RULE_AMBIGUOUS', `Posting rules ${first.ruleCode} and ${second.ruleCode} both apply.`, {
      rules: [first.ruleCode, second.ruleCode],
    });
  }
  return first;
}

export async function postDocument(tx: Tx, req: PostingRequest): Promise<PostingResult> {
  const source = postableSource(req.sourceType);
  if (!source) throw new Error(`posting: ${req.sourceType} is not a postable source`);
  if (!source.purposes.includes(req.purpose)) {
    throw new Error(`posting: ${req.sourceType} does not post for ${req.purpose}`);
  }
  const existing = await tx.postingLink.findUnique({
    where: {
      sourceType_sourceId_purpose: {
        sourceType: req.sourceType,
        sourceId: req.sourceId,
        purpose: req.purpose,
      },
    },
    include: { journal: { select: { journalNumber: true } } },
  });
  if (existing) {
    return {
      journalId: existing.journalId,
      journalNumber: existing.journal.journalNumber,
      alreadyPosted: true,
    };
  }

  const rule = await selectPostingRule(tx, req.sourceType, req.purpose, req.date, req.values ?? {});
  const built = await buildLines(tx, rule.lines, req, true);
  const lines: DraftLine[] = built.map(({ accountId, ...l }) => {
    if (accountId === null) throw new Error('posting: a strict build left an account unresolved');
    return { ...l, accountId };
  });
  const written = await writeJournal(tx, {
    journalType: 'automatic',
    date: req.date,
    narration: req.narration,
    reference: req.reference,
    sourceType: req.sourceType,
    sourceId: req.sourceId,
    postingRuleId: rule.id,
    estateId: req.estateId ?? null,
    currencyId: req.currencyId ?? null,
    exchangeRate: req.exchangeRate ?? null,
    lines,
    actorId: req.actorId,
  });
  // The guard (P3 §27.5). A concurrent duplicate fails here and the caller's transaction rolls back with
  // its journal; its retry finds the link above and is a no-op.
  await tx.postingLink
    .create({
      data: {
        sourceType: req.sourceType,
        sourceId: req.sourceId,
        purpose: req.purpose,
        journalId: written.id,
        postedAt: new Date(),
        postedBy: req.actorId,
      },
    })
    .catch((err: unknown) => {
      if (constraintViolation(err)?.kind === 'unique') {
        throw fail(
          'DUPLICATE_POSTING',
          `${req.sourceType} ${req.sourceId.toString()} has already posted for ${req.purpose}.`,
        );
      }
      throw err;
    });
  return { journalId: written.id, journalNumber: written.journalNumber, alreadyPosted: false };
}
