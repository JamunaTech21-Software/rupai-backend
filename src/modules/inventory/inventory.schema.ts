import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import {
  DIRECTIONS,
  LOCATION_TYPES,
  MATERIAL_CLASSES,
  MOVEMENT_TYPE_KEYS,
  OWNERSHIPS,
  STOCK_SOURCES,
  STOCK_STATES,
} from '../../core/stock/taxonomy.js';

/** Request and response schemas of raw materials, stock balances and stock movements (P4.04; Spec P3 §12.4, §13). */

export const MATERIAL_CATEGORIES = [
  'fuel',
  'packaging',
  'consumable',
  'chemical',
  'fertiliser',
  'spare',
  'maintenance',
  'other',
] as const;
export const MATERIAL_STATUSES = ['active', 'inactive'] as const;

export const IdParams = z.object({ id: zId });

const zCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');

const materialFields = {
  /** Numbered by the `raw_material` format when omitted. */
  code: zCode,
  name: z.string().trim().min(1).max(150),
  material_category: z.enum(MATERIAL_CATEGORIES),
  /** The unit stock is kept in. Fixed once the material has moved. */
  uom_id: zId,
  /** false: a receipt creates no stock and its cost is expensed directly. Fixed once the material has moved. */
  is_stock_tracked: z.boolean(),
  reorder_level: zDecimal('qty', { min: '0' }).nullable(),
  default_cost_centre_id: zId.nullable(),
  /** A postable expense account, overriding the category default in the posting rule. */
  expense_account_id: zId.nullable(),
};

export const CreateMaterialBody = z
  .strictObject(materialFields)
  .partial()
  .required({ name: true, material_category: true, uom_id: true });
export const ReplaceMaterialBody = z
  .strictObject(materialFields)
  .partial({ code: true, is_stock_tracked: true });
export const PatchMaterialBody = z.strictObject(materialFields).partial();

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const MaterialOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  material_category: z.enum(MATERIAL_CATEGORIES),
  uom_id: z.string(),
  uom: Ref,
  is_stock_tracked: z.boolean(),
  reorder_level: z.string().nullable(),
  default_cost_centre_id: z.string().nullable(),
  default_cost_centre: Ref.nullable(),
  expense_account_id: z.string().nullable(),
  expense_account: Ref.nullable(),
  /**
   * Owned, available stock in the stores the caller sees: the design's "average rate" (value ÷ quantity)
   * and "total cost". Read from stock_balance.
   */
  stock: z.object({
    quantity: z.string(),
    average_rate: z.string(),
    total_cost: z.string(),
    below_reorder_level: z.boolean(),
  }),
  status: z.enum(MATERIAL_STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type MaterialOutT = z.infer<typeof MaterialOut>;

const Item = z.object({
  material_class: z.enum(MATERIAL_CLASSES),
  raw_material: Ref.nullable(),
  tea_type: z.object({ id: z.string(), code: z.string() }).nullable(),
  tea_grade: z.object({ id: z.string(), code: z.string() }).nullable(),
  production_batch_id: z.string().nullable(),
  /** The unit of the quantity (a raw material's; kg for tea and leaf). */
  uom_code: z.string(),
});
const Location = z.object({
  type: z.enum(LOCATION_TYPES),
  id: z.string(),
  code: z.string().nullable(),
  name: z.string().nullable(),
});

export const BalanceOut = z.object({
  id: z.string(),
  ...Item.shape,
  location: Location,
  ownership: z.enum(OWNERSHIPS),
  stock_state: z.enum(STOCK_STATES),
  quantity: z.string(),
  average_unit_cost: z.string(),
  value: z.string(),
  last_movement_at: z.string().nullable(),
  last_rebuilt_at: z.string().nullable(),
});
export type BalanceOutT = z.infer<typeof BalanceOut>;

export const MovementOut = z.object({
  id: z.string(),
  ...Item.shape,
  location: Location,
  ownership: z.enum(OWNERSHIPS),
  stock_state: z.enum(STOCK_STATES),
  movement_type: z.enum(MOVEMENT_TYPE_KEYS as [string, ...string[]]),
  direction: z.enum(DIRECTIONS),
  quantity: z.string(),
  unit_cost: z.string(),
  value: z.string(),
  source_type: z.enum(STOCK_SOURCES),
  source_id: z.string(),
  source_line_id: z.string().nullable(),
  moved_at: z.string(),
  accounting_period_id: z.string(),
  estate_id: z.string().nullable(),
  reversal_of_id: z.string().nullable(),
  reason: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  narration: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string(),
});
export type MovementOutT = z.infer<typeof MovementOut>;
