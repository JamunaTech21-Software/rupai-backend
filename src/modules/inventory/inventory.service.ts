import type { z } from 'zod';

import {
  auditCreate,
  auditDelete,
  auditUpdate,
  recordStatusChange,
  type AuditedRecord,
} from '../../core/audit/audit.js';
import { idCursorPage, toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import { dec, toDecimalString } from '../../core/money/decimal.js';
import { allocateNumber } from '../../core/numbering/numbering.js';
import { scopeToCheck } from '../../core/scope/scope.js';
import { averageOf } from '../../core/stock/valuation.js';
import { todayIn } from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { duplicate, iso, referenced, versionConflict } from '../organisation/common.js';
import type {
  BalanceOutT,
  CreateMaterialBody,
  MaterialOutT,
  MovementOutT,
  PatchMaterialBody,
} from './inventory.schema.js';

/**
 * Raw materials and the read side of the stock ledger (Spec P3 §12.4, §13; P4 §10.3; BACKLOG P4.04).
 *
 *   - Raw materials are organisation-tier masters. Their unit and is_stock_tracked are fixed once they have
 *     moved (the ledger is kept in that unit; tracked-ness decides whether receipts move stock at all).
 *   - There is NO endpoint that writes stock (P4 §10.3): every movement is created by an approved document
 *     through core/stock. Balances and movements are read only.
 *   - Stock is facility data (P1 §4.4, P6 §4.2): a warehouse grant sees that warehouse's stock, a factory
 *     grant that factory's; all estates sees everything. A movement is also seen through its origin estate
 *     (a goods receipt of the estate). The scope is applied here, explicitly: core/stock is never filtered,
 *     because it writes on behalf of the approving document.
 */

export const MATERIAL_AUDIT: AuditedRecord = {
  type: 'raw_material',
  class: 'master',
  fields: [
    'code',
    'name',
    'material_category',
    'uom_id',
    'is_stock_tracked',
    'reorder_level',
    'default_cost_centre_id',
    'expense_account_id',
    'status',
  ],
};

export const MATERIAL_LIST_FIELDS: ListFieldMap = {
  code: { field: 'code' },
  name: { field: 'name' },
  material_category: { field: 'materialCategory' },
  status: { field: 'status' },
  is_stock_tracked: { field: 'isStockTracked', convert: (v) => v === true || v === 'true' },
  uom_id: { field: 'uomId', convert: (v) => BigInt(String(v)) },
};

const big = (v: string | number | boolean) => BigInt(String(v));
export const BALANCE_LIST_FIELDS: ListFieldMap = {
  material_class: { field: 'materialClass' },
  raw_material_id: { field: 'rawMaterialId', convert: big },
  tea_type_id: { field: 'teaTypeId', convert: big },
  tea_grade_id: { field: 'teaGradeId', convert: big },
  location_type: { field: 'locationType' },
  location_id: { field: 'locationId', convert: big },
  ownership: { field: 'ownership' },
  stock_state: { field: 'stockState' },
};
export const MOVEMENT_LIST_FIELDS: ListFieldMap = {
  ...BALANCE_LIST_FIELDS,
  movement_type: { field: 'movementType' },
  direction: { field: 'direction' },
  source_type: { field: 'sourceType' },
  source_id: { field: 'sourceId', convert: big },
  estate_id: { field: 'estateId', convert: big },
  moved_at: { field: 'movedAt', convert: (v) => new Date(String(v)) },
};

const materialInclude = {
  uom: { select: { id: true, code: true, name: true } },
  defaultCostCentre: { select: { id: true, code: true, name: true } },
  expenseAccount: { select: { id: true, code: true, name: true } },
} as const;
type MaterialRow = Prisma.RawMaterialGetPayload<{ include: typeof materialInclude }>;

const ref = (r: { id: bigint; code: string; name: string } | null) =>
  r ? { id: r.id.toString(), code: r.code, name: r.name } : null;
const invalid = (field: string, message: string) =>
  Errors.validation([{ field, code: 'VALIDATION_FAILED', message }]);
const stamp = (actorId: bigint) => ({ version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId });
const ZERO = dec('0');
const NOTHING = { id: { in: [] as bigint[] } };

/** The location conditions of the caller's facility grants: null for all locations. */
async function grantedLocations() {
  const scope = await scopeToCheck();
  if (scope === null || scope.allEstates) return null;
  const or: { locationType: string; locationId: { in: bigint[] } }[] = [];
  if (scope.warehouses.length > 0)
    or.push({ locationType: 'warehouse', locationId: { in: [...scope.warehouses] } });
  if (scope.factories.length > 0)
    or.push({ locationType: 'factory', locationId: { in: [...scope.factories] } });
  return { or, estates: [...scope.estates] };
}
/** The stock locations the caller's grants reach; {} for all. */
async function visibleLocations(): Promise<Prisma.StockBalanceWhereInput> {
  const g = await grantedLocations();
  if (g === null) return {};
  return g.or.length > 0 ? { OR: g.or } : NOTHING;
}
/** Movements: the visible locations, and the movements of the caller's estates. */
async function visibleMovements(): Promise<Prisma.StockMovementWhereInput> {
  const g = await grantedLocations();
  if (g === null) return {};
  const or: Prisma.StockMovementWhereInput[] = [...g.or];
  if (g.estates.length > 0) or.push({ estateId: { in: g.estates } });
  return or.length > 0 ? { OR: or } : NOTHING;
}

/** Codes and names of the warehouses and factories rows name. */
async function locationLabels(db: Database, rows: readonly { locationType: string; locationId: bigint }[]) {
  const ids = (type: string) => [
    ...new Set(rows.filter((r) => r.locationType === type).map((r) => r.locationId)),
  ];
  const [w, f] = await Promise.all([
    db.warehouse.findMany({
      where: { id: { in: ids('warehouse') } },
      select: { id: true, code: true, name: true },
    }),
    db.factory.findMany({
      where: { id: { in: ids('factory') } },
      select: { id: true, code: true, name: true },
    }),
  ]);
  const out = new Map<string, { code: string; name: string }>();
  for (const x of w) out.set(`warehouse:${x.id.toString()}`, x);
  for (const x of f) out.set(`factory:${x.id.toString()}`, x);
  return out;
}

const itemInclude = {
  rawMaterial: { select: { id: true, code: true, name: true, uom: { select: { code: true } } } },
  teaType: { select: { id: true, code: true } },
  teaGrade: { select: { id: true, code: true } },
} as const;
interface ItemRow {
  materialClass: string;
  productionBatchId: bigint | null;
  locationType: string;
  locationId: bigint;
  rawMaterial: { id: bigint; code: string; name: string; uom: { code: string } } | null;
  teaType: { id: bigint; code: string } | null;
  teaGrade: { id: bigint; code: string } | null;
}
function itemOut(r: ItemRow, labels: Map<string, { code: string; name: string }>) {
  const label = labels.get(`${r.locationType}:${r.locationId.toString()}`);
  return {
    material_class: r.materialClass as BalanceOutT['material_class'],
    raw_material: r.rawMaterial ? ref(r.rawMaterial) : null,
    tea_type: r.teaType ? { id: r.teaType.id.toString(), code: r.teaType.code } : null,
    tea_grade: r.teaGrade ? { id: r.teaGrade.id.toString(), code: r.teaGrade.code } : null,
    production_batch_id: r.productionBatchId?.toString() ?? null,
    uom_code: r.rawMaterial?.uom.code ?? 'kg',
    location: {
      type: r.locationType as BalanceOutT['location']['type'],
      id: r.locationId.toString(),
      code: label?.code ?? null,
      name: label?.name ?? null,
    },
  };
}

export function inventoryService(db: Database, deps: { readonly timezone: string }) {
  const today = () => todayIn(deps.timezone);

  /** Owned, available stock per material, in the locations the caller sees. */
  async function stockOf(ids: readonly bigint[]) {
    if (ids.length === 0) return new Map<bigint, { quantity: Prisma.Decimal; value: Prisma.Decimal }>();
    const rows = await db.stockBalance.groupBy({
      by: ['rawMaterialId'],
      where: {
        AND: [
          { rawMaterialId: { in: [...ids] }, ownership: 'owned', stockState: 'available' },
          await visibleLocations(),
        ],
      },
      _sum: { quantity: true, value: true },
    });
    return new Map(
      rows.flatMap((r) =>
        r.rawMaterialId === null
          ? []
          : [[r.rawMaterialId, { quantity: r._sum.quantity ?? ZERO, value: r._sum.value ?? ZERO }]],
      ),
    );
  }
  function toMaterialOut(
    m: MaterialRow,
    stock: { quantity: Prisma.Decimal; value: Prisma.Decimal } | undefined,
  ): MaterialOutT {
    const quantity = dec((stock?.quantity ?? ZERO).toString());
    const value = dec((stock?.value ?? ZERO).toString());
    return {
      id: m.id.toString(),
      code: m.code,
      name: m.name,
      material_category: m.materialCategory as MaterialOutT['material_category'],
      uom_id: m.uomId.toString(),
      uom: { id: m.uom.id.toString(), code: m.uom.code, name: m.uom.name },
      is_stock_tracked: m.isStockTracked,
      reorder_level: m.reorderLevel === null ? null : toDecimalString(m.reorderLevel, 'qty'),
      default_cost_centre_id: m.defaultCostCentreId?.toString() ?? null,
      default_cost_centre: ref(m.defaultCostCentre),
      expense_account_id: m.expenseAccountId?.toString() ?? null,
      expense_account: ref(m.expenseAccount),
      stock: {
        quantity: toDecimalString(quantity, 'qty'),
        average_rate: toDecimalString(averageOf({ quantity, value }), 'money'),
        total_cost: toDecimalString(value, 'money'),
        below_reorder_level: m.reorderLevel !== null && quantity.lessThanOrEqualTo(m.reorderLevel.toString()),
      },
      status: m.status as MaterialOutT['status'],
      version: m.version,
      created_at: m.createdAt.toISOString(),
      updated_at: iso(m.updatedAt),
    };
  }
  async function materialOut(m: MaterialRow) {
    return toMaterialOut(m, (await stockOf([m.id])).get(m.id));
  }
  async function materialOrNotFound(tx: Database | Tx, id: bigint): Promise<MaterialRow> {
    const m = await tx.rawMaterial.findUnique({ where: { id }, include: materialInclude });
    if (!m) throw Errors.notFound('Raw material not found.');
    return m;
  }

  /** The references: an active unit and cost centre, a postable expense account. */
  async function checkRefs(tx: Tx, b: z.infer<typeof PatchMaterialBody>) {
    if (b.uom_id !== undefined) {
      const u = await tx.uom.findUnique({ where: { id: b.uom_id }, select: { status: true } });
      if (!u) throw invalid('uom_id', 'No such unit.');
      if (u.status !== 'active') throw invalid('uom_id', 'The unit is inactive.');
    }
    if (b.default_cost_centre_id !== undefined && b.default_cost_centre_id !== null) {
      const c = await tx.costCentre.findUnique({
        where: { id: b.default_cost_centre_id },
        select: { status: true },
      });
      if (!c) throw invalid('default_cost_centre_id', 'No such cost centre.');
      if (c.status !== 'active') throw invalid('default_cost_centre_id', 'The cost centre is inactive.');
    }
    if (b.expense_account_id !== undefined && b.expense_account_id !== null) {
      const a = await tx.account.findUnique({
        where: { id: b.expense_account_id },
        select: { code: true, accountType: true, isPostable: true },
      });
      if (!a) throw invalid('expense_account_id', 'No such account.');
      if (a.accountType !== 'expense' || !a.isPostable)
        throw invalid('expense_account_id', `${a.code} is not a postable expense account.`);
    }
  }

  function columns(b: z.infer<typeof PatchMaterialBody>) {
    return {
      ...(b.code !== undefined ? { code: b.code } : {}),
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.material_category !== undefined ? { materialCategory: b.material_category } : {}),
      ...(b.uom_id !== undefined ? { uomId: b.uom_id } : {}),
      ...(b.is_stock_tracked !== undefined ? { isStockTracked: b.is_stock_tracked } : {}),
      ...(b.reorder_level !== undefined ? { reorderLevel: b.reorder_level } : {}),
      ...(b.default_cost_centre_id !== undefined ? { defaultCostCentreId: b.default_cost_centre_id } : {}),
      ...(b.expense_account_id !== undefined ? { expenseAccountId: b.expense_account_id } : {}),
    };
  }

  return {
    // ================= raw materials =================
    async list(q: ListQuery) {
      const search = q.filters.find((f) => f.field === 'q');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'q') };
      const and: Prisma.RawMaterialWhereInput[] = [toWhere(rest, MATERIAL_LIST_FIELDS)];
      if (search) {
        const v = String(search.value);
        and.push({ OR: [{ code: { startsWith: v } }, { name: { contains: v } }] });
      }
      const where: Prisma.RawMaterialWhereInput = { AND: and };
      const [rows, total] = await Promise.all([
        db.rawMaterial.findMany({
          where,
          include: materialInclude,
          orderBy: [...toOrderBy(q.sort, MATERIAL_LIST_FIELDS), { id: 'asc' }],
          ...toPaging(q),
        }),
        db.rawMaterial.count({ where }),
      ]);
      const stock = await stockOf(rows.map((r) => r.id));
      return { items: rows.map((m) => toMaterialOut(m, stock.get(m.id))), total };
    },

    async get(id: bigint) {
      return materialOut(await materialOrNotFound(db, id));
    },

    async create(b: z.infer<typeof CreateMaterialBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        await checkRefs(tx, b);
        const code = b.code ?? (await allocateNumber(tx, 'raw_material', { date: today() }, 'draft')).number;
        const { id } = await tx.rawMaterial
          .create({
            data: {
              ...columns(b),
              code,
              name: b.name,
              materialCategory: b.material_category,
              uomId: b.uom_id,
              createdBy: actorId,
            },
            select: { id: true },
          })
          .catch(duplicate('code', `Raw material code ${code}`));
        const out = await materialOut(await materialOrNotFound(tx, id));
        await auditCreate(tx, MATERIAL_AUDIT, id, out, { actorId });
        await recordStatusChange(tx, MATERIAL_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    async update(id: bigint, expectedVersion: number, c: z.infer<typeof PatchMaterialBody>, actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await materialOrNotFound(tx, id);
        const old = await materialOut(before);
        await checkRefs(tx, c);
        const unitChanges = c.uom_id !== undefined && c.uom_id !== before.uomId;
        const trackingChanges =
          c.is_stock_tracked !== undefined && c.is_stock_tracked !== before.isStockTracked;
        if (
          (unitChanges || trackingChanges) &&
          (await tx.stockMovement.count({ where: { rawMaterialId: id } })) > 0
        ) {
          throw invalid(
            unitChanges ? 'uom_id' : 'is_stock_tracked',
            'The material has stock movements: its unit and stock tracking no longer change.',
          );
        }
        const { count } = await tx.rawMaterial
          .updateMany({ where: { id, version: expectedVersion }, data: { ...columns(c), ...stamp(actorId) } })
          .catch(duplicate('code', `Raw material code ${c.code ?? ''}`));
        if (count !== 1) versionConflict(before, old);
        const after = await materialOut(await materialOrNotFound(tx, id));
        await auditUpdate(tx, MATERIAL_AUDIT, id, old, after, { actorId });
        return after;
      });
    },

    /** An inactive material takes no new stock (core/stock refuses inbound movements); it may still leave. */
    async setStatus(id: bigint, expectedVersion: number, status: 'active' | 'inactive', actorId: bigint) {
      return withTransaction(db, async (tx) => {
        const before = await materialOrNotFound(tx, id);
        const old = await materialOut(before);
        if (before.version !== expectedVersion) versionConflict(before, old);
        if (before.status === status) return old;
        await tx.rawMaterial.update({ where: { id }, data: { status, ...stamp(actorId) } });
        const after = await materialOut(await materialOrNotFound(tx, id));
        await auditUpdate(tx, MATERIAL_AUDIT, id, old, after, { actorId });
        await recordStatusChange(tx, MATERIAL_AUDIT.type, id, before.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint) {
      await withTransaction(db, async (tx) => {
        const m = await materialOrNotFound(tx, id);
        const out = await materialOut(m);
        await tx.rawMaterial.delete({ where: { id } }).catch(referenced('raw material'));
        await auditDelete(tx, MATERIAL_AUDIT, id, out, { actorId });
      });
    },

    // ================= stock (read only) =================
    async balances(q: ListQuery) {
      const inStock = q.filters.find((f) => f.field === 'in_stock');
      const rest = { ...q, filters: q.filters.filter((f) => f.field !== 'in_stock') };
      const and: Prisma.StockBalanceWhereInput[] = [
        toWhere(rest, BALANCE_LIST_FIELDS),
        await visibleLocations(),
      ];
      if (inStock)
        and.push(
          inStock.value === true || inStock.value === 'true' ? { quantity: { gt: 0 } } : { quantity: 0 },
        );
      const where: Prisma.StockBalanceWhereInput = { AND: and };
      const [rows, total] = await Promise.all([
        db.stockBalance.findMany({
          where,
          include: itemInclude,
          orderBy: [{ materialClass: 'asc' }, { locationType: 'asc' }, { locationId: 'asc' }, { id: 'asc' }],
          ...toPaging(q),
        }),
        db.stockBalance.count({ where }),
      ]);
      const labels = await locationLabels(db, rows);
      const items = rows.map((b): BalanceOutT => ({
        id: b.id.toString(),
        ...itemOut(b, labels),
        ownership: b.ownership as BalanceOutT['ownership'],
        stock_state: b.stockState as BalanceOutT['stock_state'],
        quantity: toDecimalString(b.quantity, 'qty'),
        average_unit_cost: toDecimalString(b.averageUnitCost, 'money'),
        value: toDecimalString(b.value, 'money'),
        last_movement_at: iso(b.lastMovementAt),
        last_rebuilt_at: iso(b.lastRebuiltAt),
      }));
      return { items, total };
    },

    async movements(q: ListQuery) {
      const scoped = await visibleMovements();
      const { rows, nextCursor, limit } = await idCursorPage(q, ({ where, take }) =>
        db.stockMovement.findMany({
          where: { AND: [toWhere(q, MOVEMENT_LIST_FIELDS), scoped, where] },
          include: { ...itemInclude, reason: { select: { id: true, code: true, name: true } } },
          orderBy: { id: 'desc' },
          take,
        }),
      ).catch((err: unknown) => {
        if (err instanceof Error && err.message === 'invalid cursor') {
          throw Errors.validation([
            { field: 'cursor', code: 'VALIDATION_FAILED', message: 'is not a valid cursor' },
          ]);
        }
        throw err;
      });
      const labels = await locationLabels(db, rows);
      const items = rows.map((m): MovementOutT => ({
        id: m.id.toString(),
        ...itemOut(m, labels),
        ownership: m.ownership as MovementOutT['ownership'],
        stock_state: m.stockState as MovementOutT['stock_state'],
        movement_type: m.movementType,
        direction: m.direction as MovementOutT['direction'],
        quantity: toDecimalString(m.quantity, 'qty'),
        unit_cost: toDecimalString(m.unitCost, 'money'),
        value: toDecimalString(m.value, 'money'),
        source_type: m.sourceType as MovementOutT['source_type'],
        source_id: m.sourceId.toString(),
        source_line_id: m.sourceLineId?.toString() ?? null,
        moved_at: m.movedAt.toISOString(),
        accounting_period_id: m.accountingPeriodId.toString(),
        estate_id: m.estateId?.toString() ?? null,
        reversal_of_id: m.reversalOfId?.toString() ?? null,
        reason: ref(m.reason),
        narration: m.narration,
        created_at: m.createdAt.toISOString(),
        created_by: m.createdBy.toString(),
      }));
      return { items, nextCursor, limit };
    },
  };
}

export type InventoryService = ReturnType<typeof inventoryService>;
