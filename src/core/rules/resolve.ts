import { Prisma } from '../../generated/prisma/client.js';
import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import { AppError, type ErrorDetail } from '../errors/app-error.js';
import { isBusinessDate, type BusinessDate } from '../time/dates.js';
import { partitionsOfRow, readDate, readId, readOptionalDate, scopeOfRow } from './rule-row.js';
import { canSeeEstate, ruleScope, scopeDenied } from './rule-scope.js';
import { dimensionWeight, ESTATE_DIMENSION, type RuleTable } from './rule-table.js';

/**
 * Rule resolution (Spec P1 §10.2, P9 §3.1):
 *
 *   1. candidates: ACTIVE versions whose effective range contains the TRANSACTION date (never today),
 *      whose partitions equal the context's, and whose every non-null scope column matches the context
 *   2. most specific first, then latest effective_from
 *   3. none → RULE_NOT_FOUND; two at the highest specificity → RULE_AMBIGUOUS; else the first
 *
 * Step 1–2 are ONE indexed query (ix_<table>_resolution). Step 3 is `pickRule`, a pure function, so the
 * decision is unit-tested against whole rule sets (P9 §3) and the SQL is tested to agree with it.
 *
 * Ambiguity follows P1 §10.2 and P3 §17.1: two active versions at the same specificity covering the same
 * date are a configuration error whatever their effective_from. (P9 §3.1 also requires the same
 * effective_from; read that way, an unclosed older version would silently lose. BACKLOG D-1.06-3.) Two
 * candidates at one specificity always have the same scope, because both match the context, so this is
 * exactly an overlap the version service should have refused.
 */

/** Context values by dimension or partition key. Missing or null dimension = the caller has no value. */
export type RuleContext = Readonly<Record<string, bigint | number | string | null | undefined>>;

export interface RuleCandidate {
  readonly id: bigint;
  readonly ruleCode: string;
  readonly name: string;
  readonly specificity: number;
  readonly effectiveFrom: BusinessDate;
  readonly effectiveTo: BusinessDate | null;
  /** Dimension key → id as string, or null ("any"). */
  readonly scope: Readonly<Record<string, string | null>>;
  readonly partitions: Readonly<Record<string, string>>;
}

export interface Resolution {
  readonly rule: RuleCandidate;
  /** Every candidate that matched, most specific first. */
  readonly candidates: readonly RuleCandidate[];
}

interface NormalisedContext {
  readonly dims: Readonly<Record<string, string | null>>;
  readonly partitions: Readonly<Record<string, string>>;
}

/** Checks the context names only known keys and every partition. A mistake here is a programming error. */
export function normaliseContext(table: RuleTable, context: RuleContext): NormalisedContext {
  const known = new Set([...table.dimensions, ...table.partitions].map((d) => d.key));
  const unknown = Object.keys(context).filter((k) => !known.has(k));
  if (unknown.length > 0) throw new Error(`${table.table}: unknown context keys ${unknown.join(', ')}`);
  const str = (v: RuleContext[string]) => (v === null || v === undefined ? null : String(v));
  const partitions: Record<string, string> = {};
  for (const p of table.partitions) {
    const v = str(context[p.key]);
    if (v === null) throw new Error(`${table.table}: context must name ${p.key}`);
    partitions[p.key] = v;
  }
  const dims = Object.fromEntries(table.dimensions.map((d) => [d.key, str(context[d.key])]));
  return { dims, partitions };
}

/** Whether a version applies to this context on this date (its state is the caller's concern). */
export function ruleMatches(
  table: RuleTable,
  rule: RuleCandidate,
  context: NormalisedContext,
  date: BusinessDate,
): boolean {
  if (rule.effectiveFrom > date || (rule.effectiveTo !== null && rule.effectiveTo < date)) return false;
  if (table.partitions.some((p) => rule.partitions[p.key] !== context.partitions[p.key])) return false;
  return table.dimensions.every((d) => {
    const v = rule.scope[d.key] ?? null;
    return v === null || v === context.dims[d.key];
  });
}

const byResolutionOrder = (a: RuleCandidate, b: RuleCandidate) =>
  b.specificity - a.specificity ||
  (a.effectiveFrom === b.effectiveFrom ? 0 : a.effectiveFrom < b.effectiveFrom ? 1 : -1) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function describe(rule: RuleCandidate): string {
  return `${rule.ruleCode} "${rule.name}" (${rule.effectiveFrom} to ${rule.effectiveTo ?? 'open'})`;
}

function candidateContext(rule: RuleCandidate) {
  return {
    rule_id: rule.id.toString(),
    rule_code: rule.ruleCode,
    name: rule.name,
    specificity: rule.specificity,
    effective_from: rule.effectiveFrom,
    effective_to: rule.effectiveTo,
    scope: rule.scope,
  };
}

function contextView(context: NormalisedContext) {
  return { ...context.partitions, ...context.dims };
}

export function ruleNotFound(table: RuleTable, context: NormalisedContext, date: BusinessDate): AppError {
  const message = `No active ${table.table} applies on ${date} for this scope.`;
  return new AppError('RULE_NOT_FOUND', message, [
    {
      code: 'RULE_NOT_FOUND',
      message,
      context: { rule_table: table.table, date, context: contextView(context) },
    },
  ]);
}

export function ruleAmbiguous(
  table: RuleTable,
  colliding: readonly RuleCandidate[],
  date: BusinessDate,
): AppError {
  const details: ErrorDetail[] = colliding.map((r) => ({
    code: 'RULE_AMBIGUOUS',
    message: describe(r),
    context: { rule_table: table.table, date, ...candidateContext(r) },
  }));
  return new AppError(
    'RULE_AMBIGUOUS',
    `${String(colliding.length)} active ${table.table} versions apply on ${date} at the same specificity. Close or correct one of them.`,
    details,
  );
}

/**
 * The deterministic decision. `rules` may be any set of ACTIVE versions; those that do not match are
 * ignored. @throws RULE_NOT_FOUND or RULE_AMBIGUOUS.
 */
export function pickRule(
  table: RuleTable,
  rules: readonly RuleCandidate[],
  context: RuleContext,
  date: BusinessDate,
): Resolution {
  if (!isBusinessDate(date)) throw new RangeError(`not a business date: ${String(date)}`);
  const ctx = normaliseContext(table, context);
  const candidates = rules.filter((r) => ruleMatches(table, r, ctx, date)).sort(byResolutionOrder);
  const [first] = candidates;
  if (!first) throw ruleNotFound(table, ctx, date);
  const colliding = candidates.filter((r) => r.specificity === first.specificity);
  if (colliding.length > 1) throw ruleAmbiguous(table, colliding, date);
  return { rule: first, candidates };
}

const col = (name: string) => Prisma.raw(`\`r\`.\`${name}\``);

/** Step 1–2 as one query. More than this many matches is itself a broken configuration. */
const CANDIDATE_LIMIT = 100;

async function candidatesFor(
  db: Database | Tx,
  table: RuleTable,
  ctx: NormalisedContext,
  date: BusinessDate,
): Promise<RuleCandidate[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`${col('state')} = 'active'`,
    Prisma.sql`${col('effective_from')} <= ${date}`,
    Prisma.sql`(${col('effective_to')} IS NULL OR ${col('effective_to')} >= ${date})`,
    ...table.partitions.map((p) => Prisma.sql`${col(p.column)} = ${ctx.partitions[p.key]}`),
    ...table.dimensions.map((d) => {
      const v = ctx.dims[d.key];
      return v === null || v === undefined
        ? Prisma.sql`${col(d.column)} IS NULL`
        : Prisma.sql`(${col(d.column)} IS NULL OR ${col(d.column)} = ${v})`;
    }),
  ];
  const columns = [
    'id',
    'rule_code',
    'name',
    'specificity',
    'effective_from',
    'effective_to',
    ...table.partitions.map((p) => p.column),
    ...table.dimensions.map((d) => d.column),
  ];
  const rows = await db.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
    SELECT ${Prisma.join(columns.map(col))}
    FROM ${Prisma.raw(`\`${table.table}\``)} AS r
    WHERE ${Prisma.join(conditions, ' AND ')}
    ORDER BY ${col('specificity')} DESC, ${col('effective_from')} DESC, ${col('id')}
    LIMIT ${CANDIDATE_LIMIT}`);
  return rows.map((row) => toCandidate(table, row));
}

export function toCandidate(table: RuleTable, row: Readonly<Record<string, unknown>>): RuleCandidate {
  return {
    id: readId(row.id),
    ruleCode: String(row.rule_code),
    name: String(row.name),
    specificity: Number(row.specificity),
    effectiveFrom: readDate(row.effective_from),
    effectiveTo: readOptionalDate(row.effective_to),
    scope: scopeOfRow(table, row),
    partitions: partitionsOfRow(table, row),
  };
}

/**
 * The rule that applies to `context` on the transaction date. System-level: the caller already holds the
 * record it is calculating for. Store `rule.id` on every result it produces (P9 §3.2).
 * @throws RULE_NOT_FOUND or RULE_AMBIGUOUS (422).
 */
export async function resolveRule(
  db: Database | Tx,
  table: RuleTable,
  context: RuleContext,
  date: BusinessDate,
): Promise<Resolution> {
  const ctx = normaliseContext(table, context);
  return pickRule(table, await candidatesFor(db, table, ctx, date), context, date);
}

export type CandidateOutcome = 'selected' | 'less_specific' | 'ambiguous';

export interface Explanation {
  readonly date: BusinessDate;
  readonly context: Readonly<Record<string, string | null>>;
  readonly resolved: RuleCandidate | null;
  readonly error: { readonly code: 'RULE_NOT_FOUND' | 'RULE_AMBIGUOUS'; readonly message: string } | null;
  readonly candidates: readonly (RuleCandidate & {
    readonly outcome: CandidateOutcome;
    /** The scope dimensions this version names, each with its weight: why it ranks where it does. */
    readonly matched: readonly { readonly key: string; readonly weight: number }[];
  })[];
}

/**
 * The /resolve diagnostic (P4 §6.5): which rule applies, and why, without failing. A user may only ask
 * about an estate inside their scope.
 */
export async function explainRule(
  db: Database | Tx,
  table: RuleTable,
  context: RuleContext,
  date: BusinessDate,
): Promise<Explanation> {
  const ctx = normaliseContext(table, context);
  const estateKey = table.dimensions.find((d) => d.column === ESTATE_DIMENSION)?.key ?? 'estate';
  const estate = ctx.dims[estateKey];
  if (!canSeeEstate(await ruleScope(), estate === null || estate === undefined ? null : BigInt(estate))) {
    throw scopeDenied('That estate is outside your data scope.');
  }
  const candidates = await candidatesFor(db, table, ctx, date);
  let resolved: RuleCandidate | null = null;
  let error: Explanation['error'] = null;
  try {
    resolved = pickRule(table, candidates, context, date).rule;
  } catch (err) {
    if (!(err instanceof AppError) || (err.code !== 'RULE_NOT_FOUND' && err.code !== 'RULE_AMBIGUOUS'))
      throw err;
    error = { code: err.code, message: err.message };
  }
  const top = candidates[0]?.specificity;
  return {
    date,
    context: contextView(ctx),
    resolved,
    error,
    candidates: candidates.map((c) => ({
      ...c,
      outcome: resolved?.id === c.id ? 'selected' : c.specificity === top ? 'ambiguous' : 'less_specific',
      matched: table.dimensions
        .map((d, i) => ({ key: d.key, weight: dimensionWeight(table, i), named: c.scope[d.key] !== null }))
        .filter((m) => m.named)
        .map(({ key, weight }) => ({ key, weight })),
    })),
  };
}
