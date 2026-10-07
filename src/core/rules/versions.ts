import { Prisma } from '../../generated/prisma/client.js';
import type { AccessLog } from '../audit/access-log.js';
import {
  auditAction,
  auditCreate,
  auditUpdate,
  recordStatusChange,
  type AuditValues,
} from '../audit/audit.js';
import { currentActorId } from '../auth/authorize.js';
import type { Tx } from '../db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../errors/app-error.js';
import { assertVersion } from '../http/concurrency.js';
import { addDays, isBusinessDate, todayIn, type BusinessDate } from '../time/dates.js';
import {
  partitionsOfRow,
  readDate,
  readId,
  readOptionalDate,
  readOptionalId,
  scopeOfRow,
} from './rule-row.js';
import { canWriteEstate, logRuleScopeDenied, ruleScope, scopeDenied, visibleRulesSql } from './rule-scope.js';
import {
  ESTATE_DIMENSION,
  ROUNDING_MODES,
  type RoundingMode,
  type RuleState,
  type RuleTable,
} from './rule-table.js';

/**
 * Versions of an effective-dated rule (Spec P1 §3.2, §10.7, P3 §17.1, P4 §6.5). One service for every
 * rule table, working on the rule block with raw SQL; the module owns only its extra columns.
 *
 *   draft ──submit──► submitted ──approve──► active ──(a later version replaces it fully)──► superseded
 *     ▲                  │  │
 *     └──── return ──────┘  └──reject──► rejected
 *
 *   - Versions are inserted, never overwritten. Only a DRAFT is edited (If-Match); an active version is
 *     changed by superseding it: a new draft with the same rule code and scope.
 *   - Approval is what makes a version take effect, and it is where the timeline is kept consistent:
 *       · the version it supersedes is CLOSED the day before it starts (still resolving for its own past
 *         dates: February payroll recomputed in August still finds February's rate), or marked
 *         superseded when the new version covers it entirely (a correction from the same date)
 *       · any other overlap at the same scope is refused (RULE_OVERLAP): MySQL has no exclusion
 *         constraint, so this is the application's job (P2 §2.10). Rows of that scope are locked first.
 *     Closing happens on APPROVAL, not when the draft is created: closing early would leave the scope with
 *     no rule (RULE_NOT_FOUND, payroll halts) for as long as the new version awaits approval.
 *   - Retrospective (P1 §10.7): a version starting before the day it was created, or before the day it
 *     is approved, is flagged. Approving one needs elevated approval and a reason, and the result names
 *     the affected range so payroll can raise the arrears run. Paid payrolls are never recalculated.
 *   - Nobody approves a version they created (SELF_APPROVAL_FORBIDDEN).
 *   - Every change is audited in the same transaction (policy depth: every field) and every state change
 *     goes to status_history.
 *
 * Approval is a direct action until the approval engine (P1.13) routes rule versions through workflows.
 */

export interface RuleVersion {
  readonly id: bigint;
  readonly ruleCode: string;
  readonly name: string;
  /** Partition key → value. */
  readonly partitions: Readonly<Record<string, string>>;
  /** Dimension key → id as string, or null for "any". */
  readonly scope: Readonly<Record<string, string | null>>;
  readonly specificity: number;
  readonly method: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly currencyId: bigint | null;
  readonly roundingMode: RoundingMode | null;
  readonly roundingPrecision: number | null;
  readonly effectiveFrom: BusinessDate;
  readonly effectiveTo: BusinessDate | null;
  readonly isRetrospective: boolean;
  readonly supersedesId: bigint | null;
  readonly notes: string | null;
  readonly state: RuleState;
  readonly stateChangedAt: Date | null;
  readonly submittedAt: Date | null;
  readonly submittedBy: bigint | null;
  readonly approvedAt: Date | null;
  readonly approvedBy: bigint | null;
  readonly rejectedAt: Date | null;
  readonly rejectedBy: bigint | null;
  readonly rejectionReason: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly createdBy: bigint;
  readonly updatedAt: Date | null;
  readonly updatedBy: bigint | null;
  /** The module's own columns, raw from the database (DECIMAL as Prisma.Decimal …). */
  readonly extras: Readonly<Record<string, unknown>>;
}

type Id = bigint | string;

/** What a version is made of. Shape is validated by the module's Zod schema; this checks the domain. */
export interface RuleVersionInput {
  readonly name: string;
  readonly method: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly effectiveFrom: BusinessDate;
  readonly effectiveTo?: BusinessDate | null;
  readonly currencyId?: Id | null;
  readonly roundingMode?: RoundingMode | null;
  readonly roundingPrecision?: number | null;
  readonly notes?: string | null;
  /** Values for the module's extra columns, ready for the database (decimals as strings). */
  readonly extras?: Readonly<Record<string, unknown>>;
}

/** A first version also names its rule code, scope and partitions. A later one inherits them. */
export interface NewRuleInput extends RuleVersionInput {
  readonly ruleCode: string;
  readonly scope?: Readonly<Record<string, Id | null | undefined>>;
  readonly partitions?: Readonly<Record<string, Id>>;
}

export type DraftPatch = Partial<NewRuleInput>;

/** A span of a version's validity, for planning an activation. */
export interface Span {
  readonly id: bigint;
  readonly effectiveFrom: BusinessDate;
  readonly effectiveTo: BusinessDate | null;
}

export type ConflictReason = 'overlaps' | 'split_required' | 'partial_replacement';

export interface ActivationPlan {
  /** Versions closed the day before the new one starts. */
  readonly closes: readonly { readonly id: bigint; readonly effectiveTo: BusinessDate }[];
  /** Versions the new one covers entirely: marked superseded. */
  readonly supersedes: readonly bigint[];
  readonly conflicts: readonly { readonly span: Span; readonly reason: ConflictReason }[];
}

const END_OF_TIME = '9999-12-31';
const overlaps = (a: Span, b: Span) =>
  a.effectiveFrom <= (b.effectiveTo ?? END_OF_TIME) && b.effectiveFrom <= (a.effectiveTo ?? END_OF_TIME);

/**
 * What activating `next` does to the ACTIVE versions of the same scope. Pure, so every timeline case is
 * unit-tested. Only the version `next` supersedes is adjusted; any other overlap is a conflict.
 *
 *   superseded version starts BEFORE next   → closed the day before next starts, unless next ends
 *                                              before it does (it would have to be split: refused)
 *   superseded version starts ON/AFTER next → superseded, if next covers it to its end; else refused
 */
export function planActivation(
  next: Span & { readonly supersedesId: bigint | null },
  active: readonly Span[],
): ActivationPlan {
  const closes: { id: bigint; effectiveTo: BusinessDate }[] = [];
  const supersedes: bigint[] = [];
  const conflicts: { span: Span; reason: ConflictReason }[] = [];
  for (const a of active) {
    if (a.id === next.id || !overlaps(next, a)) continue;
    if (a.id !== next.supersedesId) {
      conflicts.push({ span: a, reason: 'overlaps' });
    } else if (next.effectiveFrom <= a.effectiveFrom) {
      const coversToEnd =
        next.effectiveTo === null || (a.effectiveTo !== null && next.effectiveTo >= a.effectiveTo);
      if (coversToEnd) supersedes.push(a.id);
      else conflicts.push({ span: a, reason: 'partial_replacement' });
    } else if (next.effectiveTo !== null && (a.effectiveTo === null || a.effectiveTo > next.effectiveTo)) {
      conflicts.push({ span: a, reason: 'split_required' });
    } else {
      closes.push({ id: a.id, effectiveTo: addDays(next.effectiveFrom, -1) });
    }
  }
  return { closes, supersedes, conflicts };
}

const CONFLICT_MESSAGES: Record<ConflictReason, string> = {
  overlaps: 'overlaps it at the same scope. Supersede that version instead, or change the dates.',
  split_required:
    'would end before the version it supersedes ends. Add the later version explicitly instead of splitting this one.',
  partial_replacement:
    'starts on or before the version it supersedes but ends before it does, which would leave part of it in force.',
};

function overlapError(
  table: RuleTable,
  plan: ActivationPlan,
  versions: ReadonlyMap<bigint, RuleVersion>,
): AppError {
  const details: ErrorDetail[] = plan.conflicts.map(({ span, reason }) => {
    const v = versions.get(span.id);
    return {
      code: 'RULE_OVERLAP',
      field: 'effective_from',
      message: `This version ${CONFLICT_MESSAGES[reason]} (${v?.ruleCode ?? ''} ${span.effectiveFrom} to ${span.effectiveTo ?? 'open'})`,
      context: {
        rule_table: table.table,
        reason,
        rule_id: span.id.toString(),
        rule_code: v?.ruleCode ?? null,
        effective_from: span.effectiveFrom,
        effective_to: span.effectiveTo,
      },
    };
  });
  return new AppError(
    'RULE_OVERLAP',
    'The version would overlap another active version at the same scope.',
    details,
  );
}

const invalid = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

const RULE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/;

export interface RuleVersionsDeps {
  /** The organisation's timezone (config.timezone): what "today" is for the retrospective flag. */
  readonly timezone: string;
  readonly accessLog?: AccessLog;
  /** For tests. */
  readonly now?: () => Date;
}

export interface ApproveOptions {
  /** Whether this approver holds ELEVATED approval for retrospective versions (P1 §3.2, §10.7). */
  readonly elevated?: boolean;
  /** Required when the version is retrospective (P1 §13.2). */
  readonly reason?: string | null;
  /** The module's own precondition (statutory_rule: is_verified). Throw to refuse. */
  readonly guard?: (version: RuleVersion) => void | Promise<void>;
}

export interface ApprovalResult {
  readonly version: RuleVersion;
  readonly closed: readonly { readonly id: bigint; readonly effectiveTo: BusinessDate }[];
  readonly superseded: readonly bigint[];
  /** For a retrospective version: the past range it changes, for the arrears run (P1 §10.7). */
  readonly retrospective: { readonly from: BusinessDate; readonly to: BusinessDate } | null;
}

export interface ListOptions {
  readonly ruleCode?: string;
  /** Only versions in force on this date (P4 §6.5 ?as_of=). */
  readonly asOf?: BusinessDate;
  readonly states?: readonly RuleState[];
  readonly limit?: number;
}

const tableSql = (table: RuleTable) => Prisma.raw(`\`${table.table}\``);
const c = (name: string) => Prisma.raw(`\`${name}\``);
const rc = (name: string) => Prisma.raw(`\`r\`.\`${name}\``);

export function ruleVersions(table: RuleTable, deps: RuleVersionsDeps) {
  const now = deps.now ?? (() => new Date());
  const today = () => todayIn(deps.timezone, now());
  const estateKey = table.dimensions.find((d) => d.column === ESTATE_DIMENSION)?.key ?? 'estate';

  function toVersion(row: Readonly<Record<string, unknown>>): RuleVersion {
    const params =
      typeof row.parameters === 'string' ? (JSON.parse(row.parameters) as unknown) : row.parameters;
    const date = (v: unknown) => (v === null || v === undefined ? null : (v as Date));
    return {
      id: readId(row.id),
      ruleCode: String(row.rule_code),
      name: String(row.name),
      partitions: partitionsOfRow(table, row),
      scope: scopeOfRow(table, row),
      specificity: Number(row.specificity),
      method: String(row.method),
      parameters: (params ?? {}) as Record<string, unknown>,
      currencyId: readOptionalId(row.currency_id),
      roundingMode: (row.rounding_mode ?? null) as RoundingMode | null,
      roundingPrecision:
        row.rounding_precision === null || row.rounding_precision === undefined
          ? null
          : Number(row.rounding_precision),
      effectiveFrom: readDate(row.effective_from),
      effectiveTo: readOptionalDate(row.effective_to),
      isRetrospective: Boolean(Number(row.is_retrospective)),
      supersedesId: readOptionalId(row.supersedes_id),
      notes: (row.notes ?? null) as string | null,
      state: String(row.state) as RuleState,
      stateChangedAt: date(row.state_changed_at),
      submittedAt: date(row.submitted_at),
      submittedBy: readOptionalId(row.submitted_by),
      approvedAt: date(row.approved_at),
      approvedBy: readOptionalId(row.approved_by),
      rejectedAt: date(row.rejected_at),
      rejectedBy: readOptionalId(row.rejected_by),
      rejectionReason: (row.rejection_reason ?? null) as string | null,
      version: Number(row.version),
      createdAt: row.created_at as Date,
      createdBy: readId(row.created_by),
      updatedAt: date(row.updated_at),
      updatedBy: readOptionalId(row.updated_by),
      extras: Object.fromEntries(table.extraColumns.map((col) => [col, row[col]])),
    };
  }

  /** The audited values (snake_case, P1 Table 13.1 policy depth: every field). */
  function auditValues(v: RuleVersion): AuditValues {
    return {
      rule_code: v.ruleCode,
      name: v.name,
      method: v.method,
      parameters: v.parameters,
      currency_id: v.currencyId,
      rounding_mode: v.roundingMode,
      rounding_precision: v.roundingPrecision,
      effective_from: v.effectiveFrom,
      effective_to: v.effectiveTo,
      is_retrospective: v.isRetrospective,
      supersedes_id: v.supersedesId,
      notes: v.notes,
      ...Object.fromEntries(table.partitions.map((p) => [p.column, v.partitions[p.key]])),
      ...Object.fromEntries(table.dimensions.map((d) => [d.column, v.scope[d.key]])),
      ...Object.fromEntries(
        table.extraColumns.map((col) => {
          const x = v.extras[col];
          return [col, x instanceof Prisma.Decimal ? x.toFixed() : x];
        }),
      ),
    };
  }

  const estateOf = (scope: Readonly<Record<string, string | null>>) => {
    const v = scope[estateKey];
    return v === null || v === undefined ? null : BigInt(v);
  };

  async function assertWritable(
    scope: Readonly<Record<string, string | null>>,
    operation: string,
    target: unknown,
  ) {
    if (canWriteEstate(await ruleScope(), estateOf(scope))) return;
    await logRuleScopeDenied(deps.accessLog, table.table, operation, target);
    throw scopeDenied(
      estateOf(scope) === null
        ? 'Only a user with access to all estates may change an organisation-wide rule.'
        : 'That estate is outside your data scope.',
    );
  }

  /** One version, in the caller's scope. 404 when it does not exist or is out of scope. */
  async function get(tx: Tx, id: Id, opts: { lock?: boolean } = {}): Promise<RuleVersion> {
    const scope = await ruleScope();
    const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT r.* FROM ${tableSql(table)} AS r
      WHERE ${rc('id')} = ${BigInt(id)} AND ${visibleRulesSql(scope)}
      ${opts.lock ? Prisma.sql`FOR UPDATE` : Prisma.empty}`);
    const [row] = rows;
    if (row) return toVersion(row);
    if (scope !== null) {
      const exists = await tx.$queryRaw<unknown[]>(
        Prisma.sql`SELECT 1 FROM ${tableSql(table)} WHERE ${c('id')} = ${BigInt(id)}`,
      );
      if (exists.length > 0)
        await logRuleScopeDenied(deps.accessLog, table.table, 'read', { id: String(id) });
    }
    throw Errors.notFound(`No such ${table.table} version.`);
  }

  async function list(tx: Tx, opts: ListOptions = {}): Promise<RuleVersion[]> {
    const where: Prisma.Sql[] = [visibleRulesSql(await ruleScope())];
    if (opts.ruleCode !== undefined) where.push(Prisma.sql`${rc('rule_code')} = ${opts.ruleCode}`);
    if (opts.asOf !== undefined) {
      where.push(Prisma.sql`${rc('state')} = 'active'`);
      where.push(Prisma.sql`${rc('effective_from')} <= ${opts.asOf}`);
      where.push(Prisma.sql`(${rc('effective_to')} IS NULL OR ${rc('effective_to')} >= ${opts.asOf})`);
    }
    if (opts.states && opts.states.length > 0)
      where.push(Prisma.sql`${rc('state')} IN (${Prisma.join([...opts.states])})`);
    const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT r.* FROM ${tableSql(table)} AS r WHERE ${Prisma.join(where, ' AND ')}
      ORDER BY ${rc('rule_code')}, ${rc('effective_from')}, ${rc('id')} LIMIT ${opts.limit ?? 500}`);
    return rows.map(toVersion);
  }

  /** Domain checks shared by create and edit. Collects every problem (P4 §3.1). */
  function validate(v: {
    ruleCode: string;
    name: string;
    method: string;
    parameters: unknown;
    effectiveFrom: BusinessDate;
    effectiveTo: BusinessDate | null;
    roundingMode: string | null;
    roundingPrecision: number | null;
    notes: string | null;
    scope: Readonly<Record<string, Id | null | undefined>>;
    partitions: Readonly<Record<string, Id | undefined>>;
  }): void {
    const problems: ErrorDetail[] = [];
    if (!RULE_CODE.test(v.ruleCode))
      problems.push(invalid('rule_code', 'must be 1–30 letters, digits, ".", "_" or "-"'));
    if (!v.name.trim() || v.name.length > 150)
      problems.push(invalid('name', 'is required, at most 150 characters'));
    if (!table.methods.includes(v.method))
      problems.push(invalid('method', `must be one of ${table.methods.join(', ')}`));
    if (typeof v.parameters !== 'object' || v.parameters === null || Array.isArray(v.parameters)) {
      problems.push(invalid('parameters', 'must be an object'));
    }
    if (!isBusinessDate(v.effectiveFrom)) problems.push(invalid('effective_from', 'must be a date'));
    if (v.effectiveTo !== null && (!isBusinessDate(v.effectiveTo) || v.effectiveTo < v.effectiveFrom)) {
      problems.push(invalid('effective_to', 'must be a date on or after effective_from'));
    }
    if (v.roundingMode !== null && !(ROUNDING_MODES as readonly string[]).includes(v.roundingMode)) {
      problems.push(invalid('rounding_mode', `must be one of ${ROUNDING_MODES.join(', ')}`));
    }
    if (
      v.roundingPrecision !== null &&
      (!Number.isInteger(v.roundingPrecision) || v.roundingPrecision < 0 || v.roundingPrecision > 8)
    ) {
      problems.push(invalid('rounding_precision', 'must be a whole number from 0 to 8'));
    }
    if (v.notes !== null && v.notes.length > 500) problems.push(invalid('notes', 'at most 500 characters'));
    const known = new Set(table.dimensions.map((d) => d.key));
    for (const key of Object.keys(v.scope))
      if (!known.has(key)) problems.push(invalid(`scope.${key}`, 'is not a scope of this rule'));
    for (const d of table.dimensions) {
      const x = v.scope[d.key];
      if (x !== null && x !== undefined && !/^[1-9]\d*$/.test(String(x)))
        problems.push(invalid(`scope.${d.key}`, 'must be an id'));
    }
    for (const p of table.partitions) {
      const x = v.partitions[p.key];
      if (x === undefined || String(x).trim() === '') problems.push(invalid(p.key, 'is required'));
    }
    if (problems.length > 0) throw Errors.validation(problems);
  }

  const isRetro = (from: BusinessDate) => from < today();

  async function assertCodeFree(tx: Tx, ruleCode: string, exceptId?: bigint) {
    const rows = await tx.$queryRaw<unknown[]>(Prisma.sql`
      SELECT 1 FROM ${tableSql(table)} WHERE ${c('rule_code')} = ${ruleCode}
      ${exceptId === undefined ? Prisma.empty : Prisma.sql`AND ${c('id')} <> ${exceptId}`} LIMIT 1`);
    if (rows.length > 0) {
      throw new AppError('DUPLICATE_KEY', `Rule code ${ruleCode} is already in use.`, [
        {
          field: 'rule_code',
          code: 'DUPLICATE_KEY',
          message: 'is already in use: supersede its active version to add a new one',
        },
      ]);
    }
  }

  async function insert(tx: Tx, data: Record<string, unknown>): Promise<bigint> {
    const cols = Object.keys(data);
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO ${tableSql(table)} (${Prisma.join(cols.map(c))})
      VALUES (${Prisma.join(cols.map((k) => data[k]))})`);
    const [row] = await tx.$queryRaw<{ id: bigint }[]>(Prisma.sql`SELECT LAST_INSERT_ID() AS id`);
    if (!row) throw new Error('insert returned no id');
    return readId(row.id);
  }

  async function update(tx: Tx, id: bigint, data: Record<string, unknown>): Promise<void> {
    const sets = Object.entries(data).map(([k, v]) => Prisma.sql`${c(k)} = ${v}`);
    await tx.$executeRaw(Prisma.sql`
      UPDATE ${tableSql(table)} SET ${Prisma.join(sets)}, ${c('version')} = ${c('version')} + 1
      WHERE ${c('id')} = ${id}`);
  }

  function columnsOf(input: RuleVersionInput) {
    const extras = input.extras ?? {};
    const unknown = Object.keys(extras).filter((k) => !table.extraColumns.includes(k));
    if (unknown.length > 0) throw new Error(`${table.table}: unknown extra columns ${unknown.join(', ')}`);
    return {
      name: input.name,
      method: input.method,
      parameters: JSON.stringify(input.parameters),
      currency_id:
        input.currencyId === undefined || input.currencyId === null ? null : BigInt(input.currencyId),
      rounding_mode: input.roundingMode ?? null,
      rounding_precision: input.roundingPrecision ?? null,
      effective_from: input.effectiveFrom,
      effective_to: input.effectiveTo ?? null,
      notes: input.notes ?? null,
      ...extras,
    };
  }

  const scopeColumns = (scope: Readonly<Record<string, Id | null | undefined>>) =>
    Object.fromEntries(
      table.dimensions.map((d) => {
        const x = scope[d.key];
        return [d.column, x === undefined || x === null ? null : BigInt(x)];
      }),
    );
  const partitionColumns = (partitions: Readonly<Record<string, Id | undefined>>) =>
    Object.fromEntries(table.partitions.map((p) => [p.column, String(partitions[p.key])]));
  const asScopeView = (scope: Readonly<Record<string, Id | null | undefined>>) =>
    Object.fromEntries(
      table.dimensions.map((d) => [
        d.key,
        scope[d.key] === undefined || scope[d.key] === null ? null : String(scope[d.key]),
      ]),
    );

  async function createDraft(
    tx: Tx,
    input: NewRuleInput,
    supersedes: RuleVersion | null,
  ): Promise<RuleVersion> {
    const scope = supersedes ? supersedes.scope : (input.scope ?? {});
    const partitions = supersedes ? supersedes.partitions : (input.partitions ?? {});
    const ruleCode = supersedes ? supersedes.ruleCode : input.ruleCode;
    validate({
      ruleCode,
      name: input.name,
      method: input.method,
      parameters: input.parameters,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo ?? null,
      roundingMode: input.roundingMode ?? null,
      roundingPrecision: input.roundingPrecision ?? null,
      notes: input.notes ?? null,
      scope,
      partitions,
    });
    await assertWritable(asScopeView(scope), 'create', { rule_code: ruleCode, scope: asScopeView(scope) });
    if (!supersedes) await assertCodeFree(tx, ruleCode);
    const actor = currentActorId();
    const id = await insert(tx, {
      rule_code: ruleCode,
      ...partitionColumns(partitions),
      ...scopeColumns(scope),
      ...columnsOf(input),
      is_retrospective: isRetro(input.effectiveFrom),
      supersedes_id: supersedes?.id ?? null,
      state: 'draft',
      state_changed_at: now(),
      created_by: actor,
    });
    const created = await get(tx, id);
    await auditCreate(tx, table.audit, id, auditValues(created));
    await recordStatusChange(tx, table.table, id, null, 'draft', {
      comment: supersedes ? `Supersedes version ${supersedes.id.toString()}` : null,
    });
    return created;
  }

  /** A first version of a new rule, as a draft. */
  function create(tx: Tx, input: NewRuleInput): Promise<RuleVersion> {
    return createDraft(tx, input, null);
  }

  /** The next version of an ACTIVE version's rule, as a draft (P4 §6.5 POST /{rules}/{id}/supersede). */
  async function supersede(tx: Tx, id: Id, input: RuleVersionInput): Promise<RuleVersion> {
    const current = await get(tx, id, { lock: true });
    if (current.state !== 'active') {
      throw new AppError('INVALID_TRANSITION', 'Only an active version can be superseded.', [
        {
          code: 'INVALID_TRANSITION',
          message: `the version is ${current.state}`,
          context: { state: current.state },
        },
      ]);
    }
    return createDraft(tx, { ...input, ruleCode: current.ruleCode }, current);
  }

  /** Edits a DRAFT (P4 §6.5 PUT: draft versions only). A later version keeps its rule's code and scope. */
  async function updateDraft(
    tx: Tx,
    id: Id,
    expectedVersion: number,
    patch: DraftPatch,
  ): Promise<RuleVersion> {
    const current = await get(tx, id, { lock: true });
    if (current.state !== 'draft') {
      throw new AppError(
        'INVALID_TRANSITION',
        'Only a draft version can be edited; supersede an active one.',
        [
          {
            code: 'INVALID_TRANSITION',
            message: `the version is ${current.state}`,
            context: { state: current.state },
          },
        ],
      );
    }
    assertVersion(expectedVersion, current.version);
    await assertWritable(current.scope, 'update', { id: current.id.toString() });
    const identityChange =
      patch.ruleCode !== undefined || patch.scope !== undefined || patch.partitions !== undefined;
    if (identityChange && current.supersedesId !== null) {
      throw Errors.validation([
        invalid('rule_code', 'a later version keeps the rule code and scope of the version it supersedes'),
      ]);
    }
    const scope = patch.scope ?? current.scope;
    const partitions = patch.partitions ?? current.partitions;
    const merged: NewRuleInput = {
      ruleCode: patch.ruleCode ?? current.ruleCode,
      name: patch.name ?? current.name,
      method: patch.method ?? current.method,
      parameters: patch.parameters ?? current.parameters,
      effectiveFrom: patch.effectiveFrom ?? current.effectiveFrom,
      effectiveTo: patch.effectiveTo === undefined ? current.effectiveTo : patch.effectiveTo,
      currencyId: patch.currencyId === undefined ? current.currencyId : patch.currencyId,
      roundingMode: patch.roundingMode === undefined ? current.roundingMode : patch.roundingMode,
      roundingPrecision:
        patch.roundingPrecision === undefined ? current.roundingPrecision : patch.roundingPrecision,
      notes: patch.notes === undefined ? current.notes : patch.notes,
      extras: { ...current.extras, ...patch.extras },
    };
    validate({
      ruleCode: merged.ruleCode,
      name: merged.name,
      method: merged.method,
      parameters: merged.parameters,
      effectiveFrom: merged.effectiveFrom,
      effectiveTo: merged.effectiveTo ?? null,
      roundingMode: merged.roundingMode ?? null,
      roundingPrecision: merged.roundingPrecision ?? null,
      notes: merged.notes ?? null,
      scope,
      partitions,
    });
    if (patch.scope !== undefined)
      await assertWritable(asScopeView(scope), 'update', {
        id: current.id.toString(),
        scope: asScopeView(scope),
      });
    if (merged.ruleCode !== current.ruleCode) await assertCodeFree(tx, merged.ruleCode, current.id);
    await update(tx, current.id, {
      rule_code: merged.ruleCode,
      ...partitionColumns(partitions),
      ...scopeColumns(scope),
      ...columnsOf(merged),
      // Retrospective against the day it was created, and against today (P1 §10.7, BACKLOG D-1.06-5).
      is_retrospective:
        isRetro(merged.effectiveFrom) || merged.effectiveFrom < todayIn(deps.timezone, current.createdAt),
      updated_at: now(),
      updated_by: currentActorId(),
    });
    const after = await get(tx, current.id);
    await auditUpdate(tx, table.audit, current.id, auditValues(current), auditValues(after));
    return after;
  }

  const transitionError = (v: RuleVersion, expected: RuleState) =>
    v.state === 'draft' && expected === 'submitted'
      ? new AppError('NOT_SUBMITTED', 'The version has not been submitted.', [
          { code: 'NOT_SUBMITTED', message: 'submit it first' },
        ])
      : v.state === 'active'
        ? new AppError('ALREADY_APPROVED', 'The version is already approved.', [
            { code: 'ALREADY_APPROVED', message: 'supersede it to change it' },
          ])
        : new AppError('INVALID_TRANSITION', `The version is ${v.state}.`, [
            {
              code: 'INVALID_TRANSITION',
              message: `expected ${expected}, found ${v.state}`,
              context: { state: v.state },
            },
          ]);

  /** Locks every active or submitted version at the same partitions and scope, in id order. */
  async function lockSameScope(tx: Tx, v: RuleVersion): Promise<RuleVersion[]> {
    const conditions = [
      ...table.partitions.map((p) => Prisma.sql`${c(p.column)} = ${v.partitions[p.key]}`),
      ...table.dimensions.map((d) => {
        const x = v.scope[d.key];
        return Prisma.sql`${c(d.column)} <=> ${x === null || x === undefined ? null : BigInt(x)}`;
      }),
    ];
    const rows = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT * FROM ${tableSql(table)}
      WHERE ${Prisma.join(conditions, ' AND ')} AND (${c('state')} IN ('active', 'submitted') OR ${c('id')} = ${v.id})
      ORDER BY ${c('id')} FOR UPDATE`);
    return rows.map(toVersion);
  }

  /**
   * Reads the version (scope-checked, unlocked), then locks its whole scope in id order and returns the
   * LOCKED copy. Locking its own row first would deadlock two approvers working on two versions of the
   * same scope; one ordered lock makes the second wait and then see the first's result.
   */
  async function lockForTransition(tx: Tx, id: Id): Promise<{ v: RuleVersion; sameScope: RuleVersion[] }> {
    const peek = await get(tx, id);
    const sameScope = await lockSameScope(tx, peek);
    const v = sameScope.find((x) => x.id === peek.id);
    // Only a draft's scope can change, and only by a concurrent edit: ask the caller to retry.
    if (!v) throw Errors.versionConflict({ version: peek.version });
    return { v, sameScope };
  }

  function plan(v: RuleVersion, sameScope: readonly RuleVersion[]): ActivationPlan {
    const active = sameScope.filter((x) => x.state === 'active' && x.id !== v.id);
    const result = planActivation(v, active);
    if (result.conflicts.length > 0) throw overlapError(table, result, new Map(active.map((x) => [x.id, x])));
    return result;
  }

  async function transition(
    tx: Tx,
    v: RuleVersion,
    to: RuleState,
    data: Record<string, unknown>,
    comment: string | null,
  ) {
    await update(tx, v.id, {
      state: to,
      state_changed_at: now(),
      updated_at: now(),
      updated_by: currentActorId(),
      ...data,
    });
    await recordStatusChange(tx, table.table, v.id, v.state, to, { comment });
  }

  /** draft → submitted. An overlap is reported now rather than at approval. */
  async function submit(tx: Tx, id: Id): Promise<RuleVersion> {
    const { v, sameScope } = await lockForTransition(tx, id);
    if (v.state !== 'draft') throw transitionError(v, 'draft');
    await assertWritable(v.scope, 'submit', { id: v.id.toString() });
    plan(v, sameScope);
    await transition(tx, v, 'submitted', { submitted_at: now(), submitted_by: currentActorId() }, null);
    return get(tx, v.id);
  }

  /** submitted → draft, for correction (P1 §6.1 "returned"). */
  async function returnToDraft(tx: Tx, id: Id, comment: string): Promise<RuleVersion> {
    const v = await get(tx, id, { lock: true });
    if (v.state !== 'submitted') throw transitionError(v, 'submitted');
    await assertWritable(v.scope, 'return', { id: v.id.toString() });
    if (!comment.trim()) throw Errors.validation([invalid('comment', 'say what needs correcting')]);
    await transition(tx, v, 'draft', { submitted_at: null, submitted_by: null }, comment);
    return get(tx, v.id);
  }

  /** submitted → rejected. Terminal; a reason is required. */
  async function reject(tx: Tx, id: Id, reason: string): Promise<RuleVersion> {
    const v = await get(tx, id, { lock: true });
    if (v.state !== 'submitted') throw transitionError(v, 'submitted');
    await assertWritable(v.scope, 'reject', { id: v.id.toString() });
    if (!reason.trim() || reason.length > 500)
      throw Errors.validation([invalid('reason', 'is required, at most 500 characters')]);
    await transition(
      tx,
      v,
      'rejected',
      { rejected_at: now(), rejected_by: currentActorId(), rejection_reason: reason },
      reason,
    );
    await auditAction(tx, table.audit, v.id, 'reject', { reason });
    return get(tx, v.id);
  }

  /** submitted → active: the version takes effect, and the timeline around it is adjusted. */
  async function approve(tx: Tx, id: Id, opts: ApproveOptions = {}): Promise<ApprovalResult> {
    const { v, sameScope } = await lockForTransition(tx, id);
    if (v.state !== 'submitted') throw transitionError(v, 'submitted');
    await assertWritable(v.scope, 'approve', { id: v.id.toString() });
    const actor = currentActorId();
    if (actor === v.createdBy) {
      throw new AppError('SELF_APPROVAL_FORBIDDEN', 'You cannot approve a rule version you created.', [
        { code: 'SELF_APPROVAL_FORBIDDEN', message: 'another approver must approve it' },
      ]);
    }
    const retrospective = v.isRetrospective || isRetro(v.effectiveFrom);
    if (retrospective && !opts.elevated) {
      throw new AppError(
        'RETROSPECTIVE_APPROVAL_REQUIRED',
        'This version takes effect in the past and needs elevated approval.',
        [
          {
            field: 'effective_from',
            code: 'RETROSPECTIVE_APPROVAL_REQUIRED',
            message: `starts ${v.effectiveFrom}, before today`,
          },
        ],
      );
    }
    const reason = opts.reason?.trim() ?? '';
    if (retrospective && !reason) {
      throw Errors.validation([invalid('reason', 'is required to approve a retrospective version')]);
    }
    await opts.guard?.(v);

    const activation = plan(v, sameScope);
    const closedBy = `Closed by version ${v.id.toString()}`;
    for (const sid of activation.supersedes) {
      // Before activating: active_key (scope + effective_from) must be free for the new version.
      await update(tx, sid, {
        state: 'superseded',
        state_changed_at: now(),
        updated_at: now(),
        updated_by: actor,
      });
      await recordStatusChange(tx, table.table, sid, 'active', 'superseded', {
        comment: `Replaced by version ${v.id.toString()}`,
      });
    }
    for (const close of activation.closes) {
      const before = await get(tx, close.id);
      await update(tx, close.id, { effective_to: close.effectiveTo, updated_at: now(), updated_by: actor });
      await auditUpdate(
        tx,
        table.audit,
        close.id,
        auditValues(before),
        { ...auditValues(before), effective_to: close.effectiveTo },
        { reason: closedBy },
      );
    }
    await transition(
      tx,
      v,
      'active',
      { approved_at: now(), approved_by: actor, is_retrospective: retrospective },
      reason || null,
    );
    if (retrospective !== v.isRetrospective) {
      await auditUpdate(
        tx,
        table.audit,
        v.id,
        auditValues(v),
        { ...auditValues(v), is_retrospective: retrospective },
        { reason },
      );
    }
    await auditAction(tx, table.audit, v.id, 'approve', { reason: reason || null });

    const yesterday = addDays(today(), -1);
    return {
      version: await get(tx, v.id),
      closed: activation.closes,
      superseded: activation.supersedes,
      retrospective: retrospective
        ? {
            from: v.effectiveFrom,
            to: v.effectiveTo !== null && v.effectiveTo < yesterday ? v.effectiveTo : yesterday,
          }
        : null,
    };
  }

  return {
    table,
    get,
    list,
    create,
    supersede,
    updateDraft,
    submit,
    returnToDraft,
    reject,
    approve,
    toVersion,
  };
}

export type RuleVersionService = ReturnType<typeof ruleVersions>;
