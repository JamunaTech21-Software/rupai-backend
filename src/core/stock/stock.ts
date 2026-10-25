import { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../errors/app-error.js';
import type { ErrorCode } from '../errors/codes.js';
import { type Dec, dec } from '../money/decimal.js';
import { businessDateToDb, type BusinessDate } from '../time/dates.js';
import {
  type Direction,
  type DirectMovementType,
  LOCATIONS_OF,
  type LocationType,
  type MaterialClass,
  MOVEMENT_TYPES,
  type MovementType,
  type Ownership,
  STOCK_SOURCES,
  type StockSource,
  type StockState,
} from './taxonomy.js';
import { averageOf, type Holding, valueIn, valueOut, type Valued } from './valuation.js';

/**
 * The stock movement service (Spec P1 §7.4, §8; P3 §13.1–§13.2; P2 §3.7): the ONLY code that writes
 * stock_movement or stock_balance. Callers are documents on approval (goods receipt, material issue, stock
 * adjustment, sale …), always inside their own transaction; any refusal throws and aborts it.
 *
 *   moveStock              movements of one source document, one per line
 *   transferStock          out of one place at the average, into another at the same cost (no gain or loss)
 *   changeStockState       between states at one place (reserve, allocate, damage …), no cost effect
 *   reverseStockMovements  compensating movements for everything a source moved (P3 §13.1)
 *
 *   - The service assigns cost (P1 §7.4): receipts at the document's cost, everything outbound at the
 *     weighted average (valuation.ts), held material at zero.
 *   - Every balance a call touches is locked FOR UPDATE, in key order, before anything is checked, so two
 *     documents issuing the same stock cannot both pass (P2 §3.7). An outbound movement beyond the balance is
 *     refused with INSUFFICIENT_STOCK, available and requested in its context: no balance goes negative for
 *     any material, location, ownership and state (P1 §8.4); the CHECK on stock_balance is the backstop.
 *   - Ownership is part of the balance key (P1 §8.3): held and owned stock never mix.
 *   - Reads and writes use SQL directly: the movement belongs to the approving document, whatever the
 *     approver's own data scope.
 * Posting stays with the caller, which posts the values returned here.
 */

const fail = (code: ErrorCode, message: string, context?: Record<string, unknown>): AppError =>
  new AppError(code, message, [{ code, message, ...(context ? { context } : {}) }]);
interface Num {
  toString(): string;
}
const ZERO = dec('0');
/** An optional id that is set. */
const isSet = (v: bigint | null | undefined): v is bigint => v !== null && v !== undefined;

export interface StockItem {
  readonly materialClass: MaterialClass;
  readonly rawMaterialId?: bigint | null;
  readonly teaTypeId?: bigint | null;
  readonly teaGradeId?: bigint | null;
  readonly productionBatchId?: bigint | null;
}

export interface StockPlace {
  readonly type: LocationType;
  readonly id: bigint;
}

/** What the source document is, and when and by whom it moves stock. */
export interface MovementContext {
  readonly source: { readonly type: StockSource; readonly id: bigint };
  /** The business date: decides the accounting period. */
  readonly date: BusinessDate;
  /** The business time; omitted: the start of `date`. Green leaf gives the full timestamp (P1 §8.7). */
  readonly movedAt?: Date;
  /** The origin estate, where meaningful. */
  readonly estateId?: bigint | null;
  readonly actorId: bigint;
  /** A soft-closed or reopened period accepts the movement (permitted adjustments, as journals). */
  readonly allowRestrictedPeriod?: boolean;
}

export interface MovementLine {
  readonly movementType: DirectMovementType;
  readonly item: StockItem;
  readonly location: StockPlace;
  /** Default owned. */
  readonly ownership?: Ownership;
  /** Default available. */
  readonly stockState?: StockState;
  /** > 0, at most 3 places. */
  readonly quantity: Dec;
  /** Receipts: the document's unit cost. An adjustment increase may give one; nothing else does. */
  readonly unitCost?: Dec | null;
  readonly sourceLineId?: bigint | null;
  /** adjustment_reason: required for adjustments and write-offs. */
  readonly reasonId?: bigint | null;
  readonly narration?: string | null;
}

export interface MovedLine {
  readonly movementId: bigint;
  readonly direction: Direction;
  readonly quantity: Dec;
  readonly unitCost: Dec;
  readonly value: Dec;
  /** The balance after this movement. */
  readonly balance: { readonly quantity: Dec; readonly value: Dec; readonly averageUnitCost: Dec };
  /**
   * Reversal of a receipt only: when it empties the balance, what the balance still held differs from the
   * receipt's value by this (positive: less was left). The caller posts it to inventory variance.
   */
  readonly difference?: Dec;
}

/** How one row is costed, resolved by the service. */
type Cost =
  | { readonly kind: 'given'; readonly unitCost: Dec }
  | { readonly kind: 'average' }
  /** An increase at the average, or at a cost given by the document. */
  | { readonly kind: 'adjust'; readonly unitCost: Dec | null }
  /** The cost of an earlier row of the same call (the in-half of a transfer or state change). */
  | { readonly kind: 'like'; readonly row: number }
  /** A compensating row: exactly the cost and value of the movement it reverses. */
  | { readonly kind: 'exact'; readonly unitCost: Dec; readonly value: Dec };

interface Row {
  readonly movementType: MovementType;
  readonly direction: Direction;
  readonly item: StockItem;
  readonly location: StockPlace;
  readonly ownership: Ownership;
  readonly stockState: StockState;
  readonly quantity: Dec;
  readonly cost: Cost;
  readonly sourceLineId: bigint | null;
  readonly reasonId: bigint | null;
  readonly narration: string | null;
  readonly reversalOfId: bigint | null;
}

const id = (v: bigint | null | undefined) => (v === null || v === undefined ? '' : v.toString());

/** The ux_stock_balance key, spelled exactly as the generated balance_key column (migration p4_04). */
export function balanceKey(
  item: StockItem,
  location: StockPlace,
  ownership: Ownership,
  stockState: StockState,
): string {
  return [
    item.materialClass,
    id(item.rawMaterialId),
    id(item.teaTypeId),
    id(item.teaGradeId),
    id(item.productionBatchId),
    location.type,
    location.id.toString(),
    ownership,
    stockState,
  ].join('|');
}
const keyOf = (r: Row) => balanceKey(r.item, r.location, r.ownership, r.stockState);

// ---- checks -------------------------------------------------------------------------------------------

/** Everything about a row that does not need its balance: refusals before any lock is taken. */
async function check(tx: Tx, rows: readonly Row[], ctx: MovementContext): Promise<bigint> {
  const problems: ErrorDetail[] = [];
  const bad = (i: number, field: string, message: string) =>
    problems.push({ field: `lines[${String(i)}].${field}`, code: 'VALIDATION_FAILED', message });

  if (!(STOCK_SOURCES as readonly string[]).includes(ctx.source.type)) {
    problems.push({ field: 'source_type', code: 'VALIDATION_FAILED', message: 'Not a stock source.' });
  }
  if (rows.length === 0) {
    problems.push({ field: 'lines', code: 'VALIDATION_FAILED', message: 'Nothing to move.' });
  }

  const materials = new Set<bigint>();
  const warehouses = new Set<bigint>();
  const factories = new Set<bigint>();
  const reasons = new Set<bigint>();
  for (const [i, r] of rows.entries()) {
    if (!r.quantity.greaterThan(0)) bad(i, 'quantity', 'Must be above zero.');
    if (r.quantity.decimalPlaces() > 3) bad(i, 'quantity', 'At most 3 decimal places.');
    const { item } = r;
    if (!LOCATIONS_OF[item.materialClass].includes(r.location.type)) {
      bad(i, 'location_type', `${item.materialClass} is not kept at a ${r.location.type}.`);
    }
    if (r.location.type === 'warehouse') warehouses.add(r.location.id);
    else if (r.location.type === 'factory') factories.add(r.location.id);
    else bad(i, 'location_type', `Stock at a ${r.location.type.replace('_', ' ')} arrives with its module.`);
    const teaRefs = [item.teaTypeId, item.teaGradeId, item.productionBatchId].some(isSet);
    if (item.materialClass === 'material') {
      if (isSet(item.rawMaterialId)) materials.add(item.rawMaterialId);
      else bad(i, 'raw_material_id', 'A material names its raw material.');
      if (teaRefs) bad(i, 'tea_grade_id', 'A material has no tea type, grade or batch.');
    } else if (item.materialClass === 'made_tea') {
      if (!isSet(item.teaTypeId) || !isSet(item.teaGradeId))
        bad(i, 'tea_grade_id', 'Made tea names its tea type and grade.');
      if (isSet(item.rawMaterialId)) bad(i, 'raw_material_id', 'Made tea is not a raw material.');
    } else if (teaRefs || isSet(item.rawMaterialId)) {
      bad(i, 'raw_material_id', 'Green leaf names no material, tea type, grade or batch.');
    }
    const def = MOVEMENT_TYPES[r.movementType];
    if (def.needsReason) {
      if (isSet(r.reasonId)) reasons.add(r.reasonId);
      else bad(i, 'reason_id', `${def.label} needs its adjustment reason.`);
    }
    const given = 'unitCost' in r.cost ? r.cost.unitCost : null;
    if (given?.isNegative()) bad(i, 'unit_cost', 'Cannot be negative.');
    if (given && r.ownership === 'held' && !given.isZero() && r.cost.kind !== 'exact') {
      bad(i, 'unit_cost', 'Held stock carries no value (P1 §8.3).');
    }
  }
  if (problems.length > 0) throw Errors.validation(problems, 'The stock movement is invalid.');

  // References: exist; inbound needs them active.
  const inbound = (pred: (r: Row) => boolean) => rows.some((r) => r.direction === 'in' && pred(r));
  if (materials.size > 0) {
    const found = await tx.$queryRaw<
      { id: bigint; code: string; status: string; is_stock_tracked: number }[]
    >`
      SELECT id, code, status, is_stock_tracked FROM raw_material WHERE id IN (${Prisma.join([...materials])})`;
    for (const mid of materials) {
      const m = found.find((f) => f.id === mid);
      if (!m) problems.push(detail('raw_material_id', `No raw material ${mid.toString()}.`));
      else if (!m.is_stock_tracked)
        problems.push(
          detail('raw_material_id', `${m.code} is not stock-tracked: its cost is expensed directly.`),
        );
      else if (m.status !== 'active' && inbound((r) => r.item.rawMaterialId === mid))
        problems.push(detail('raw_material_id', `${m.code} is inactive: it takes no new stock.`));
    }
  }
  for (const [table, ids] of [
    ['warehouse', warehouses],
    ['factory', factories],
  ] as const) {
    if (ids.size === 0) continue;
    const found = await tx.$queryRaw<{ id: bigint; code: string; status: string }[]>`
      SELECT id, code, status FROM ${Prisma.raw(`\`${table}\``)} WHERE id IN (${Prisma.join([...ids])})`;
    for (const lid of ids) {
      const l = found.find((f) => f.id === lid);
      if (!l) problems.push(detail('location_id', `No ${table} ${lid.toString()}.`));
      else if (l.status !== 'active' && inbound((r) => r.location.type === table && r.location.id === lid))
        problems.push(detail('location_id', `${table} ${l.code} is inactive: it takes no new stock.`));
    }
  }
  if (reasons.size > 0) {
    const found = await tx.$queryRaw<{ id: bigint }[]>`
      SELECT id FROM adjustment_reason WHERE id IN (${Prisma.join([...reasons])}) AND status = 'active'`;
    if (found.length !== reasons.size)
      problems.push(detail('reason_id', 'No such active adjustment reason.'));
  }
  if (isSet(ctx.estateId)) {
    const [e] = await tx.$queryRaw<
      { n: bigint }[]
    >`SELECT COUNT(*) AS n FROM estate WHERE id = ${ctx.estateId}`;
    if (!e || e.n === 0n) problems.push(detail('estate_id', 'No such estate.'));
  }
  if (problems.length > 0) throw Errors.validation(problems, 'The stock movement is invalid.');

  // P3 §13.1: the accounting period is resolved at moved_at and stored; nothing moves into a closed one.
  const d = businessDateToDb(ctx.date);
  const [period] = await tx.$queryRaw<{ id: bigint; name: string; state: string }[]>`
    SELECT id, name, state FROM accounting_period
     WHERE period_number < 13 AND start_date <= ${d} AND end_date >= ${d} LIMIT 1`;
  if (!period) throw fail('PERIOD_CLOSED', `No accounting period covers ${ctx.date}.`, { date: ctx.date });
  const restricted = period.state === 'soft_closed' || period.state === 'reopened';
  if (period.state !== 'open' && !(restricted && ctx.allowRestrictedPeriod === true)) {
    throw fail(
      'PERIOD_CLOSED',
      `${period.name} is ${period.state.replace('_', '-')}: no stock moves into it.`,
      {
        period: period.name,
        state: period.state,
      },
    );
  }
  return period.id;
}
const detail = (field: string, message: string): ErrorDetail => ({
  field,
  code: 'VALIDATION_FAILED',
  message,
});

// ---- the write path -----------------------------------------------------------------------------------

interface Locked {
  readonly id: bigint;
  holding: Holding;
  touched: boolean;
}

/** Creates the balance row if it is missing, then locks it. Called in key order. */
async function lockBalance(tx: Tx, key: string, r: Row): Promise<Locked> {
  const { item, location } = r;
  await tx.$executeRaw`
    INSERT INTO stock_balance (material_class, raw_material_id, tea_type_id, tea_grade_id, production_batch_id,
                               location_type, location_id, ownership, stock_state)
    VALUES (${item.materialClass}, ${item.rawMaterialId ?? null}, ${item.teaTypeId ?? null},
            ${item.teaGradeId ?? null}, ${item.productionBatchId ?? null}, ${location.type}, ${location.id},
            ${r.ownership}, ${r.stockState})
    ON DUPLICATE KEY UPDATE id = id`;
  const [b] = await tx.$queryRaw<{ id: bigint; quantity: Num; value: Num }[]>`
    SELECT id, quantity, value FROM stock_balance WHERE balance_key = ${key} FOR UPDATE`;
  if (!b) throw new Error(`stock: balance ${key} vanished after its insert`);
  return {
    id: b.id,
    holding: { quantity: dec(b.quantity.toString()), value: dec(b.value.toString()) },
    touched: false,
  };
}

function insufficient(r: Row, h: Holding): AppError {
  const available = h.quantity.toFixed(3);
  const requested = r.quantity.toFixed(3);
  return fail('INSUFFICIENT_STOCK', `Only ${available} in stock; ${requested} requested.`, {
    available,
    requested,
    material_class: r.item.materialClass,
    raw_material_id: r.item.rawMaterialId?.toString() ?? null,
    tea_grade_id: r.item.teaGradeId?.toString() ?? null,
    location_type: r.location.type,
    location_id: r.location.id.toString(),
    ownership: r.ownership,
    stock_state: r.stockState,
  });
}

/** Values one row against its (locked) balance, or refuses it. */
function valueRow(r: Row, h: Holding, earlier: readonly MovedLine[]): Valued & { difference?: Dec } {
  const held = r.ownership === 'held';
  const c = r.cost;
  if (r.direction === 'out') {
    if (c.kind === 'exact') {
      // Reversing a receipt: it leaves at what it came in at.
      if (r.quantity.greaterThan(h.quantity)) throw insufficient(r, h);
      if (r.quantity.equals(h.quantity)) {
        return {
          unitCost: c.unitCost,
          value: h.value,
          after: { quantity: ZERO, value: ZERO },
          difference: c.value.minus(h.value),
        };
      }
      if (c.value.greaterThan(h.value)) {
        throw fail(
          'INVALID_TRANSITION',
          'Issues since the receipt have used up its value: reverse them first, or adjust the stock instead.',
          { balance_value: h.value.toFixed(4), receipt_value: c.value.toFixed(4) },
        );
      }
      return {
        unitCost: c.unitCost,
        value: c.value,
        after: { quantity: h.quantity.minus(r.quantity), value: h.value.minus(c.value) },
      };
    }
    const out = valueOut(h, r.quantity, held);
    if (!out) throw insufficient(r, h);
    return out;
  }
  switch (c.kind) {
    case 'given':
      return valueIn(h, r.quantity, c.unitCost, held);
    case 'exact':
      return valueIn(h, r.quantity, c.unitCost, held, c.value);
    case 'like': {
      const from = earlier[c.row];
      if (!from) throw new Error('stock: a paired row precedes its partner');
      return valueIn(h, r.quantity, from.unitCost, held, from.value);
    }
    case 'adjust': {
      if (c.unitCost !== null) return valueIn(h, r.quantity, c.unitCost, held);
      const average = averageOf(h);
      if (!held && average.isZero()) {
        throw Errors.validation(
          [detail('unit_cost', 'This stock has no average yet: give the unit cost of the increase.')],
          'The stock movement is invalid.',
        );
      }
      return valueIn(h, r.quantity, average, held);
    }
    case 'average':
      return valueIn(h, r.quantity, averageOf(h), held);
  }
}

async function apply(tx: Tx, ctx: MovementContext, rows: readonly Row[]): Promise<MovedLine[]> {
  const periodId = await check(tx, rows, ctx);
  const movedAt = ctx.movedAt ?? businessDateToDb(ctx.date);

  // Lock every balance first, in key order: two documents never wait on each other in a cycle.
  const balances = new Map<string, Locked>();
  for (const key of [...new Set(rows.map(keyOf))].sort()) {
    const r = rows.find((x) => keyOf(x) === key);
    if (r) balances.set(key, await lockBalance(tx, key, r));
  }

  const done: MovedLine[] = [];
  for (const r of rows) {
    const b = balances.get(keyOf(r));
    if (!b) throw new Error('stock: balance not locked');
    const v = valueRow(r, b.holding, done);
    const m = await tx.stockMovement.create({
      data: {
        materialClass: r.item.materialClass,
        rawMaterialId: r.item.rawMaterialId ?? null,
        teaTypeId: r.item.teaTypeId ?? null,
        teaGradeId: r.item.teaGradeId ?? null,
        productionBatchId: r.item.productionBatchId ?? null,
        locationType: r.location.type,
        locationId: r.location.id,
        ownership: r.ownership,
        stockState: r.stockState,
        movementType: r.movementType,
        direction: r.direction,
        quantity: r.quantity.toFixed(3),
        unitCost: v.unitCost.toFixed(4),
        value: v.value.toFixed(4),
        sourceType: ctx.source.type,
        sourceId: ctx.source.id,
        sourceLineId: r.sourceLineId,
        movedAt,
        accountingPeriodId: periodId,
        estateId: ctx.estateId ?? null,
        reversalOfId: r.reversalOfId,
        reasonId: r.reasonId,
        narration: r.narration?.slice(0, 200) ?? null,
        createdBy: ctx.actorId,
      },
      select: { id: true },
    });
    b.holding = v.after;
    b.touched = true;
    done.push({
      movementId: m.id,
      direction: r.direction,
      quantity: r.quantity,
      unitCost: v.unitCost,
      value: v.value,
      balance: { quantity: v.after.quantity, value: v.after.value, averageUnitCost: averageOf(v.after) },
      ...(v.difference && !v.difference.isZero() ? { difference: v.difference } : {}),
    });
  }

  for (const b of balances.values()) {
    if (!b.touched) continue;
    await tx.$executeRaw`
      UPDATE stock_balance
         SET quantity = ${b.holding.quantity.toFixed(3)}, value = ${b.holding.value.toFixed(4)},
             average_unit_cost = ${averageOf(b.holding).toFixed(4)},
             last_movement_at = GREATEST(COALESCE(last_movement_at, ${movedAt}), ${movedAt})
       WHERE id = ${b.id}`;
  }
  return done;
}

// ---- operations ---------------------------------------------------------------------------------------

/** One movement per line, in line order, for one source document. */
export async function moveStock(
  tx: Tx,
  ctx: MovementContext,
  lines: readonly MovementLine[],
): Promise<MovedLine[]> {
  const rows = lines.map((l, i): Row => {
    const def = MOVEMENT_TYPES[l.movementType] as (typeof MOVEMENT_TYPES)[MovementType] | undefined;
    if (!def || def.paired || def.direction === 'both') {
      throw Errors.validation([
        detail(`lines[${String(i)}].movement_type`, `Not a movement a document asks for: ${l.movementType}.`),
      ]);
    }
    const unitCost = l.unitCost ?? null;
    if (def.cost === 'average' && unitCost !== null) {
      throw Errors.validation([
        detail(
          `lines[${String(i)}].unit_cost`,
          `${def.label} is valued at the weighted average, not a given cost.`,
        ),
      ]);
    }
    if (def.cost === 'source' && unitCost === null) {
      throw Errors.validation([
        detail(`lines[${String(i)}].unit_cost`, `${def.label} carries its unit cost.`),
      ]);
    }
    return {
      movementType: l.movementType,
      direction: def.direction,
      item: l.item,
      location: l.location,
      ownership: l.ownership ?? 'owned',
      stockState: l.stockState ?? 'available',
      quantity: l.quantity,
      cost:
        def.cost === 'source'
          ? { kind: 'given', unitCost: unitCost ?? ZERO }
          : def.cost === 'adjust'
            ? { kind: 'adjust', unitCost }
            : { kind: 'average' },
      sourceLineId: l.sourceLineId ?? null,
      reasonId: l.reasonId ?? null,
      narration: l.narration ?? null,
      reversalOfId: null,
    };
  });
  return apply(tx, ctx, rows);
}

export interface TransferInput {
  readonly item: StockItem;
  readonly from: StockPlace;
  readonly to: StockPlace;
  readonly ownership?: Ownership;
  readonly quantity: Dec;
  readonly sourceLineId?: bigint | null;
  readonly narration?: string | null;
}

/** Out of `from` at its average, into `to` at exactly that cost: no gain or loss on transfer (P1 §8.2). */
export async function transferStock(
  tx: Tx,
  ctx: MovementContext,
  t: TransferInput,
): Promise<{ out: MovedLine; in: MovedLine }> {
  if (t.from.type === t.to.type && t.from.id === t.to.id) {
    throw Errors.validation([detail('to', 'A transfer goes somewhere else.')]);
  }
  const base = {
    item: t.item,
    ownership: t.ownership ?? 'owned',
    stockState: 'available' as const,
    quantity: t.quantity,
    sourceLineId: t.sourceLineId ?? null,
    reasonId: null,
    narration: t.narration ?? null,
    reversalOfId: null,
  };
  const [out, into] = await apply(tx, ctx, [
    { ...base, movementType: 'transfer_out', direction: 'out', location: t.from, cost: { kind: 'average' } },
    { ...base, movementType: 'transfer_in', direction: 'in', location: t.to, cost: { kind: 'like', row: 0 } },
  ]);
  if (!out || !into) throw new Error('stock: a transfer writes two movements');
  return { out, in: into };
}

export interface StateChangeInput {
  readonly item: StockItem;
  readonly location: StockPlace;
  readonly ownership?: Ownership;
  readonly from: StockState;
  readonly to: StockState;
  readonly quantity: Dec;
  readonly sourceLineId?: bigint | null;
  readonly reasonId?: bigint | null;
  readonly narration?: string | null;
}

/** Quantity moves between states at one place: out of one at the average, into the other at that cost. */
export async function changeStockState(
  tx: Tx,
  ctx: MovementContext,
  c: StateChangeInput,
): Promise<{ out: MovedLine; in: MovedLine }> {
  if (c.from === c.to) throw Errors.validation([detail('to', 'A state change goes to another state.')]);
  const base = {
    movementType: 'state_change' as const,
    item: c.item,
    location: c.location,
    ownership: c.ownership ?? 'owned',
    quantity: c.quantity,
    sourceLineId: c.sourceLineId ?? null,
    reasonId: c.reasonId ?? null,
    narration: c.narration ?? null,
    reversalOfId: null,
  };
  const [out, into] = await apply(tx, ctx, [
    { ...base, direction: 'out', stockState: c.from, cost: { kind: 'average' } },
    { ...base, direction: 'in', stockState: c.to, cost: { kind: 'like', row: 0 } },
  ]);
  if (!out || !into) throw new Error('stock: a state change writes two movements');
  return { out, in: into };
}

/**
 * Compensates every movement the source made that is not yet reversed, newest first: each the opposite way,
 * at exactly its own cost and value, naming it in reversal_of_id (unique: nothing is reversed twice). A
 * second call finds nothing left and returns []. `ctx.source` is the source being reversed.
 */
export async function reverseStockMovements(tx: Tx, ctx: MovementContext): Promise<MovedLine[]> {
  const moved = await tx.$queryRaw<
    {
      id: bigint;
      material_class: string;
      raw_material_id: bigint | null;
      tea_type_id: bigint | null;
      tea_grade_id: bigint | null;
      production_batch_id: bigint | null;
      location_type: string;
      location_id: bigint;
      ownership: string;
      stock_state: string;
      movement_type: string;
      direction: string;
      quantity: Num;
      unit_cost: Num;
      value: Num;
      source_line_id: bigint | null;
      reason_id: bigint | null;
    }[]
  >`
    SELECT m.* FROM stock_movement m
     WHERE m.source_type = ${ctx.source.type} AND m.source_id = ${ctx.source.id} AND m.reversal_of_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM stock_movement r WHERE r.reversal_of_id = m.id)
     ORDER BY m.id DESC`;
  if (moved.length === 0) return [];
  return apply(
    tx,
    ctx,
    moved.map((m): Row => ({
      movementType: m.movement_type as MovementType,
      direction: m.direction === 'in' ? 'out' : 'in',
      item: {
        materialClass: m.material_class as MaterialClass,
        rawMaterialId: m.raw_material_id,
        teaTypeId: m.tea_type_id,
        teaGradeId: m.tea_grade_id,
        productionBatchId: m.production_batch_id,
      },
      location: { type: m.location_type as LocationType, id: m.location_id },
      ownership: m.ownership as Ownership,
      stockState: m.stock_state as StockState,
      quantity: dec(m.quantity.toString()),
      cost: { kind: 'exact', unitCost: dec(m.unit_cost.toString()), value: dec(m.value.toString()) },
      sourceLineId: m.source_line_id,
      reasonId: m.reason_id,
      narration: `Reversal of movement ${m.id.toString()}`,
      reversalOfId: m.id,
    })),
  );
}
