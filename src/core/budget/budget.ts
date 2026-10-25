import type { Database } from '../db/prisma.js';
import type { Tx } from '../db/transaction.js';
import { AppError } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { Dec, dec, round } from '../money/decimal.js';
import { businessDateToDb, type BusinessDate } from '../time/dates.js';

/**
 * The budget consumption contract (Spec P1 §7.5, §5.22, P3 §26.4–§26.6, P9 §19.2; D-3.06-6 to D-3.06-11).
 * The only code that consumes budget. Callers are approved documents, inside their own transaction:
 *
 *   checkAvailability   before submission: the line that would be consumed, its figures, the control in
 *                       force and the outcome (ok, warn, require_approval, block). Reads only.
 *   recordConsumption   commitment (purchase order, welfare case, training programme approved), actual
 *                       (invoice, journal, disbursement, completion), commitment release (with the actual,
 *                       or on cancellation). Idempotent per (line, type, source): a repeat is a no-op.
 *   reverseConsumption  the source is reversed or cancelled: each of its rows is undone by a reversal row.
 *
 *   available    = annual − actual − open commitments
 *   utilisation% = (actual + open commitments) / annual × 100   (BU.1: 2,150,000 / 2,400,000 = 89.5833 %)
 *
 * Which line: the active budget of the fiscal year covering the date, most specific estate / department
 * first, the head's line or its nearest ancestor's, the cost centre's line or the line with none (D-3.06-7).
 * No line, no consumption: the control decides whether that is allowed.
 */

export const CONSUMPTION_SOURCES = [
  'purchase_order',
  'supplier_invoice',
  'payroll_run',
  'welfare_case',
  'training_program',
  'journal',
] as const;
export type ConsumptionSource = (typeof CONSUMPTION_SOURCES)[number];
export const CONSUMPTION_TYPES = ['commitment', 'actual', 'commitment_release'] as const;
export type ConsumptionType = (typeof CONSUMPTION_TYPES)[number];
export const CONTROL_MODES = ['none', 'warn', 'require_approval', 'block'] as const;
export type ControlMode = (typeof CONTROL_MODES)[number];
export type Outcome = 'ok' | ControlMode;

const fail = (code: ErrorCode, message: string, context?: Record<string, unknown>): AppError =>
  new AppError(code, message, [{ code, message, ...(context ? { context } : {}) }]);
const d4 = (v: Dec) => v.toFixed(4);
interface Num {
  toString(): string;
}
const n = (v: Num | null | undefined) => dec(v?.toString() ?? '0');

/** Where an amount is spent. */
export interface BudgetTarget {
  readonly budgetHeadId: bigint;
  readonly costCentreId?: bigint | null;
  readonly estateId?: bigint | null;
  readonly departmentId?: bigint | null;
}

export interface ControlInForce {
  readonly mode: ControlMode;
  /** null: no control row applies (the default, warn) or the head is not controlled. */
  readonly controlId: bigint | null;
  readonly warningThreshold: string | null;
  readonly criticalThreshold: string | null;
  readonly overrunTolerance: string | null;
  readonly escalationRoleId: bigint | null;
}

export interface LineFigures {
  readonly id: bigint;
  readonly budgetId: bigint;
  readonly budgetCode: string;
  readonly budgetHeadId: bigint;
  readonly costCentreId: bigint | null;
  readonly estateId: bigint | null;
  readonly annual: Dec;
  readonly committed: Dec;
  readonly actual: Dec;
}

// ---- figures --------------------------------------------------------------------------------------------

/** P9 §19.2: utilisation to 4 places; null when the annual amount is 0 ("not applicable"). */
export function utilisation(annual: Dec, actual: Dec, committed: Dec): Dec | null {
  if (annual.isZero()) return null;
  return round(actual.plus(committed).dividedBy(annual).times(100), 4);
}
export function available(annual: Dec, actual: Dec, committed: Dec): Dec {
  return annual.minus(actual).minus(committed);
}

// ---- resolution -----------------------------------------------------------------------------------------

async function fiscalYearFor(tx: Database | Tx, date: BusinessDate) {
  const d = businessDateToDb(date);
  return tx.fiscalYear.findFirst({
    where: { startDate: { lte: d }, endDate: { gte: d } },
    select: { id: true },
  });
}

async function periodFor(tx: Database | Tx, date: BusinessDate) {
  const d = businessDateToDb(date);
  const p = await tx.accountingPeriod.findFirst({
    where: { periodNumber: { lt: 13 }, startDate: { lte: d }, endDate: { gte: d } },
    select: { id: true },
  });
  if (!p) throw fail('VALIDATION_FAILED', `No accounting period covers ${date}.`, { date });
  return p.id;
}

/** The head and its ancestors, nearest first (the tree has at most 4 levels, D-3.02-5). */
async function headChain(tx: Database | Tx, headId: bigint) {
  const chain: { id: bigint; headType: string; isControlled: boolean }[] = [];
  let at: bigint | null = headId;
  while (at !== null && chain.length < 6) {
    const h: { id: bigint; headType: string; isControlled: boolean; parentHeadId: bigint | null } | null =
      await tx.budgetHead.findUnique({
        where: { id: at },
        select: { id: true, headType: true, isControlled: true, parentHeadId: true },
      });
    if (!h) break;
    chain.push(h);
    at = h.parentHeadId;
  }
  if (chain.length === 0) throw fail('VALIDATION_FAILED', 'The budget head does not exist.');
  return chain;
}

const lineSelect = {
  id: true,
  budgetId: true,
  budgetHeadId: true,
  costCentreId: true,
  estateId: true,
  annualAmount: true,
  committedAmount: true,
  actualAmount: true,
  budget: { select: { budgetCode: true } },
} as const;
function figures(l: {
  id: bigint;
  budgetId: bigint;
  budgetHeadId: bigint;
  costCentreId: bigint | null;
  estateId: bigint | null;
  annualAmount: Num;
  committedAmount: Num;
  actualAmount: Num;
  budget: { budgetCode: string };
}): LineFigures {
  return {
    id: l.id,
    budgetId: l.budgetId,
    budgetCode: l.budget.budgetCode,
    budgetHeadId: l.budgetHeadId,
    costCentreId: l.costCentreId,
    estateId: l.estateId,
    annual: n(l.annualAmount),
    committed: n(l.committedAmount),
    actual: n(l.actualAmount),
  };
}

/** D-3.06-7: the line a target consumes at a date, or null. */
export async function findLine(tx: Database | Tx, target: BudgetTarget, date: BusinessDate) {
  const chain = await headChain(tx, target.budgetHeadId);
  const type = chain[0]?.headType;
  if (type !== 'expense' && type !== 'capital') return null;
  const fy = await fiscalYearFor(tx, date);
  if (!fy) return null;
  const estateId = target.estateId ?? null;
  const departmentId = target.departmentId ?? null;
  // The source's estate and department, then estate only, department only, organisation-wide.
  const budgets = await tx.budget.findMany({
    where: {
      state: 'active',
      fiscalYearId: fy.id,
      budgetType: type === 'capital' ? 'capital' : 'operating',
      OR: [
        { estateId: null, departmentId: null },
        ...(estateId !== null && departmentId !== null ? [{ estateId, departmentId }] : []),
        ...(estateId !== null ? [{ estateId, departmentId: null }] : []),
        ...(departmentId !== null ? [{ estateId: null, departmentId }] : []),
      ],
    },
    select: { id: true, estateId: true, departmentId: true },
  });
  const rank = (b: { estateId: bigint | null; departmentId: bigint | null }) =>
    (b.estateId !== null ? 2 : 0) + (b.departmentId !== null ? 1 : 0);
  const ordered = [...budgets].sort((a, b) => rank(b) - rank(a));
  for (const b of ordered) {
    for (const head of chain) {
      for (const cc of target.costCentreId ? [target.costCentreId, null] : [null]) {
        const line = await tx.budgetLine.findFirst({
          where: { budgetId: b.id, budgetHeadId: head.id, costCentreId: cc },
          select: lineSelect,
        });
        if (line) return figures(line);
      }
    }
  }
  return null;
}

/** D-3.06-9: the control in force for a head, estate and fiscal year. */
export async function resolveControl(
  tx: Database | Tx,
  budgetHeadId: bigint,
  estateId: bigint | null,
  fiscalYearId: bigint | null,
): Promise<ControlInForce> {
  const chain = await headChain(tx, budgetHeadId);
  const none: ControlInForce = {
    mode: 'none',
    controlId: null,
    warningThreshold: null,
    criticalThreshold: null,
    overrunTolerance: null,
    escalationRoleId: null,
  };
  if (chain[0] && !chain[0].isControlled) return none;
  const rows = await tx.budgetControl.findMany({
    where: {
      state: 'active',
      OR: [{ budgetHeadId: { in: chain.map((h) => h.id) } }, { budgetHeadId: null }],
      AND: [
        { OR: [{ estateId: null }, ...(estateId !== null ? [{ estateId }] : [])] },
        { OR: [{ fiscalYearId: null }, ...(fiscalYearId !== null ? [{ fiscalYearId }] : [])] },
      ],
    },
  });
  const depth = (h: bigint | null) => (h === null ? chain.length : chain.findIndex((c) => c.id === h));
  const best = rows.sort((a, b) => {
    const byHead = depth(a.budgetHeadId) - depth(b.budgetHeadId);
    if (byHead !== 0) return byHead;
    const spec = (r: typeof a) => (r.estateId !== null ? 2 : 0) + (r.fiscalYearId !== null ? 1 : 0);
    return spec(b) - spec(a);
  })[0];
  if (!best) return { ...none, mode: 'warn' };
  return {
    mode: best.controlMode as ControlMode,
    controlId: best.id,
    warningThreshold: best.warningThresholdPercentage?.toFixed(4) ?? null,
    criticalThreshold: best.criticalThresholdPercentage?.toFixed(4) ?? null,
    overrunTolerance: best.overrunTolerancePercentage?.toFixed(4) ?? null,
    escalationRoleId: best.escalationRoleId,
  };
}

function isExceeded(line: LineFigures | null, amount: Dec, control: ControlInForce): boolean {
  if (!line) return amount.greaterThan(0);
  const limit = line.annual.times(
    dec(control.overrunTolerance ?? '0')
      .dividedBy(100)
      .plus(1),
  );
  return line.actual.plus(line.committed).plus(amount).greaterThan(limit);
}
function outcomeOf(exceeded: boolean, control: ControlInForce): Outcome {
  return exceeded && control.mode !== 'none' ? control.mode : 'ok';
}

// ---- availability ---------------------------------------------------------------------------------------

export interface AvailabilityInput extends BudgetTarget {
  readonly date: BusinessDate;
  readonly amount: Dec;
}
export interface Availability {
  readonly line: LineFigures | null;
  readonly annual: string | null;
  readonly committed: string | null;
  readonly actual: string | null;
  readonly available: string | null;
  /** null when no line, or the annual amount is 0. */
  readonly utilisation: string | null;
  /** After this amount. */
  readonly availableAfter: string | null;
  readonly control: ControlInForce;
  readonly exceeded: boolean;
  readonly outcome: Outcome;
}

export async function checkAvailability(tx: Database | Tx, input: AvailabilityInput): Promise<Availability> {
  const line = await findLine(tx, input, input.date);
  const fy = await fiscalYearFor(tx, input.date);
  const control = await resolveControl(tx, input.budgetHeadId, input.estateId ?? null, fy?.id ?? null);
  const exceeded = isExceeded(line, input.amount, control);
  const u = line ? utilisation(line.annual, line.actual, line.committed) : null;
  return {
    line,
    annual: line ? d4(line.annual) : null,
    committed: line ? d4(line.committed) : null,
    actual: line ? d4(line.actual) : null,
    available: line ? d4(available(line.annual, line.actual, line.committed)) : null,
    utilisation: u ? u.toFixed(4) : null,
    availableAfter: line ? d4(available(line.annual, line.actual, line.committed).minus(input.amount)) : null,
    control,
    exceeded,
    outcome: outcomeOf(exceeded, control),
  };
}

// ---- recording ------------------------------------------------------------------------------------------

/** Adds to a line's committed / actual, its utilisation and the period's position. */
async function addToLine(tx: Tx, lineId: bigint, periodId: bigint, delta: { committed?: Dec; actual?: Dec }) {
  const c = d4(delta.committed ?? dec('0'));
  const a = d4(delta.actual ?? dec('0'));
  await tx.$executeRaw`
    UPDATE budget_line
       SET committed_amount = committed_amount + CAST(${c} AS DECIMAL(18, 4)),
           actual_amount = actual_amount + CAST(${a} AS DECIMAL(18, 4)), updated_at = UTC_TIMESTAMP()
     WHERE id = ${lineId}`;
  await tx.$executeRaw`
    UPDATE budget_line
       SET utilisation_percentage = IF(annual_amount = 0, 0,
             ROUND((actual_amount + committed_amount) / annual_amount * 100, 4))
     WHERE id = ${lineId}`;
  await tx.$executeRaw`
    INSERT INTO budget_position_summary (budget_line_id, accounting_period_id, committed_amount, actual_amount, updated_at)
    VALUES (${lineId}, ${periodId}, GREATEST(0, CAST(${c} AS DECIMAL(18, 4))), GREATEST(0, CAST(${a} AS DECIMAL(18, 4))), UTC_TIMESTAMP())
    ON DUPLICATE KEY UPDATE committed_amount = committed_amount + CAST(${c} AS DECIMAL(18, 4)),
        actual_amount = actual_amount + CAST(${a} AS DECIMAL(18, 4)), updated_at = UTC_TIMESTAMP()`;
}

async function lockLine(tx: Tx, lineId: bigint): Promise<LineFigures> {
  await tx.$queryRaw`SELECT id FROM budget_line WHERE id = ${lineId} FOR UPDATE`;
  return figures(await tx.budgetLine.findUniqueOrThrow({ where: { id: lineId }, select: lineSelect }));
}

/** The line now carrying a (possibly superseded) line's figures: its successor in the active revision. */
async function currentLine(tx: Tx, lineId: bigint): Promise<bigint> {
  let line = await tx.budgetLine.findUniqueOrThrow({
    where: { id: lineId },
    select: { id: true, budgetId: true, lineKey: true, budget: { select: { state: true } } },
  });
  for (let i = 0; i < 20 && line.budget.state === 'superseded'; i += 1) {
    const next = await tx.budgetLine.findFirst({
      where: {
        lineKey: line.lineKey,
        budget: { supersedesId: line.budgetId, state: { in: ['active', 'superseded'] } },
      },
      select: { id: true, budgetId: true, lineKey: true, budget: { select: { state: true } } },
    });
    if (!next) break;
    line = next;
  }
  return line.id;
}

export type Stage = 'commitment' | 'actual' | 'release';
export interface ConsumptionLine extends BudgetTarget {
  readonly amount: Dec;
}
export interface RecordInput {
  readonly stage: Stage;
  readonly sourceType: ConsumptionSource;
  readonly sourceId: bigint;
  readonly date: BusinessDate;
  /** commitment / actual: where. release: optional — only the commitments on these heads; amount caps it. */
  readonly lines: readonly ConsumptionLine[];
  /** release: the source whose commitment is released (e.g. the purchase order). */
  readonly releases?: { readonly sourceType: ConsumptionSource; readonly sourceId: bigint };
  readonly actorId: bigint;
  /** The document's workflow approved an overrun (require_approval), or the caller accepts it. */
  readonly overrunApproved?: boolean;
}
export interface Recorded {
  readonly lineId: bigint | null;
  readonly consumptionId: bigint | null;
  readonly amount: string;
  readonly outcome: Outcome | 'no_budget';
  readonly exceeded: boolean;
  /** false: already recorded (idempotent), or nothing to record. */
  readonly created: boolean;
}

const typeOf = (stage: Stage): ConsumptionType => (stage === 'release' ? 'commitment_release' : stage);

export async function recordConsumption(tx: Tx, input: RecordInput): Promise<Recorded[]> {
  if (input.stage === 'release') return release(tx, input);
  const type = typeOf(input.stage);
  // Resolved only when something is written: a source with no budget needs no period.
  let period: bigint | null = null;
  const periodId = async () => (period ??= await periodFor(tx, input.date));
  const fy = await fiscalYearFor(tx, input.date);
  const out: Recorded[] = [];
  for (const l of input.lines) {
    if (!l.amount.greaterThan(0)) continue;
    const found = await findLine(tx, l, input.date);
    const control = await resolveControl(tx, l.budgetHeadId, l.estateId ?? null, fy?.id ?? null);
    if (!found) {
      if (control.mode === 'block' && !input.overrunApproved) {
        throw fail(
          'BUDGET_NOT_ACTIVE',
          'No active budget covers this budget head, and its control blocks spending.',
          {
            budget_head_id: l.budgetHeadId.toString(),
          },
        );
      }
      out.push({
        lineId: null,
        consumptionId: null,
        amount: d4(l.amount),
        outcome: 'no_budget',
        exceeded: true,
        created: false,
      });
      continue;
    }
    const line = await lockLine(tx, found.id);
    const existing = await tx.budgetConsumption.findUnique({
      where: {
        budgetLineId_consumptionType_sourceType_sourceId: {
          budgetLineId: line.id,
          consumptionType: type,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      },
      select: { id: true, amount: true },
    });
    if (existing) {
      out.push({
        lineId: line.id,
        consumptionId: existing.id,
        amount: d4(n(existing.amount)),
        outcome: 'ok',
        exceeded: false,
        created: false,
      });
      continue;
    }
    const exceeded = isExceeded(line, l.amount, control);
    const outcome = outcomeOf(exceeded, control);
    if (outcome === 'block' && !input.overrunApproved) {
      throw fail('BUDGET_EXCEEDED', 'This would exceed the budget, and its control blocks it.', {
        budget_line_id: line.id.toString(),
        budget_code: line.budgetCode,
        annual: d4(line.annual),
        committed: d4(line.committed),
        actual: d4(line.actual),
        available: d4(available(line.annual, line.actual, line.committed)),
        amount: d4(l.amount),
      });
    }
    const row = await tx.budgetConsumption.create({
      data: {
        budgetLineId: line.id,
        consumptionType: type,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        consumptionDate: businessDateToDb(input.date),
        accountingPeriodId: await periodId(),
        amount: d4(l.amount),
        createdBy: input.actorId,
      },
      select: { id: true },
    });
    await addToLine(
      tx,
      line.id,
      await periodId(),
      type === 'commitment' ? { committed: l.amount } : { actual: l.amount },
    );
    out.push({
      lineId: line.id,
      consumptionId: row.id,
      amount: d4(l.amount),
      outcome,
      exceeded,
      created: true,
    });
  }
  return out;
}

/** Open amount of a commitment: its amount less its releases and reversals. */
async function openOf(tx: Tx, commitmentId: bigint, amount: Dec): Promise<Dec> {
  const [r] = await tx.$queryRaw<{ released: Num | null; reversed: Num | null }[]>`
    SELECT (SELECT SUM(r.amount) FROM budget_consumption r WHERE r.releases_id = ${commitmentId}
              AND NOT EXISTS (SELECT 1 FROM budget_consumption x WHERE x.reversal_of_id = r.id)) AS released,
           (SELECT SUM(x.amount) FROM budget_consumption x WHERE x.reversal_of_id = ${commitmentId}) AS reversed`;
  return amount.minus(n(r?.released)).minus(n(r?.reversed));
}

async function release(tx: Tx, input: RecordInput): Promise<Recorded[]> {
  if (!input.releases) throw new Error('budget: a release names the commitment source it releases');
  const commitments = await tx.budgetConsumption.findMany({
    where: {
      consumptionType: 'commitment',
      sourceType: input.releases.sourceType,
      sourceId: input.releases.sourceId,
      reversalOfId: null,
    },
    include: { line: { select: { budgetHeadId: true } } },
    orderBy: { id: 'asc' },
  });
  const heads = input.lines.length > 0 ? new Set(input.lines.map((l) => l.budgetHeadId)) : null;
  let cap = input.lines.length > 0 ? input.lines.reduce((t, l) => t.plus(l.amount), dec('0')) : null;
  const out: Recorded[] = [];
  for (const c of commitments) {
    if (heads && !heads.has(c.line.budgetHeadId)) continue;
    const lineId = await currentLine(tx, c.budgetLineId);
    await lockLine(tx, lineId);
    const open = await openOf(tx, c.id, n(c.amount));
    let amount = cap === null ? open : Dec.min(open, cap);
    if (!amount.greaterThan(0)) continue;
    const existing = await tx.budgetConsumption.findUnique({
      where: {
        budgetLineId_consumptionType_sourceType_sourceId: {
          budgetLineId: lineId,
          consumptionType: 'commitment_release',
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      },
      select: { id: true, amount: true },
    });
    if (existing) {
      out.push({
        lineId,
        consumptionId: existing.id,
        amount: d4(n(existing.amount)),
        outcome: 'ok',
        exceeded: false,
        created: false,
      });
      continue;
    }
    amount = round(amount, 4);
    const row = await tx.budgetConsumption.create({
      data: {
        budgetLineId: lineId,
        consumptionType: 'commitment_release',
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        consumptionDate: businessDateToDb(input.date),
        accountingPeriodId: await periodFor(tx, input.date),
        amount: d4(amount),
        releasesId: c.id,
        createdBy: input.actorId,
      },
      select: { id: true },
    });
    // The commitment leaves the period it was made in.
    await addToLine(tx, lineId, c.accountingPeriodId, { committed: amount.negated() });
    if (open.minus(amount).isZero()) {
      await tx.budgetConsumption.update({ where: { id: c.id }, data: { releasedById: row.id } });
    }
    if (cap !== null) cap = cap.minus(amount);
    out.push({
      lineId,
      consumptionId: row.id,
      amount: d4(amount),
      outcome: 'ok',
      exceeded: false,
      created: true,
    });
  }
  return out;
}

/**
 * Undoes everything a source consumed (D-3.06-6): one reversal row per row, same type, sourced from the
 * reversing document. Already reversed rows are skipped, so a repeat is a no-op.
 */
export async function reverseConsumption(
  tx: Tx,
  input: {
    readonly sourceType: ConsumptionSource;
    readonly sourceId: bigint;
    readonly by: { readonly sourceType: ConsumptionSource; readonly sourceId: bigint };
    readonly date: BusinessDate;
    readonly actorId: bigint;
  },
): Promise<number> {
  const rows = await tx.budgetConsumption.findMany({
    where: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversalOfId: null,
      reversals: { none: {} },
    },
    orderBy: { id: 'desc' },
  });
  if (rows.length === 0) return 0;
  const periodId = await periodFor(tx, input.date);
  let done = 0;
  for (const r of rows) {
    const type = r.consumptionType as ConsumptionType;
    const lineId = await currentLine(tx, r.budgetLineId);
    await lockLine(tx, lineId);
    let amount = n(r.amount);
    if (type === 'commitment') {
      // Only what is still open: releases already took the rest off.
      amount = await openOf(tx, r.id, amount);
      if (!amount.greaterThan(0)) continue;
    }
    await tx.budgetConsumption.create({
      data: {
        budgetLineId: lineId,
        consumptionType: type,
        sourceType: input.by.sourceType,
        sourceId: input.by.sourceId,
        consumptionDate: businessDateToDb(input.date),
        accountingPeriodId: periodId,
        amount: d4(amount),
        reversalOfId: r.id,
        createdBy: input.actorId,
      },
    });
    if (type === 'commitment')
      await addToLine(tx, lineId, r.accountingPeriodId, { committed: amount.negated() });
    else if (type === 'actual')
      await addToLine(tx, lineId, r.accountingPeriodId, { actual: amount.negated() });
    else await addToLine(tx, lineId, r.accountingPeriodId, { committed: amount });
    done += 1;
  }
  return done;
}
