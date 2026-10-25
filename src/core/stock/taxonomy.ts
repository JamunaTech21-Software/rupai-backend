/**
 * The closed vocabulary of the stock ledger (Spec P1 §8.1–§8.3, P3 §13.1). A new business situation is an
 * existing movement type with a reason, never a new type: every type has a defined direction and cost
 * treatment (P1 §8.2), and the migration's CHECK constraints admit exactly these values.
 */

export const MATERIAL_CLASSES = ['green_leaf', 'made_tea', 'material'] as const;
export type MaterialClass = (typeof MATERIAL_CLASSES)[number];

export const LOCATION_TYPES = ['warehouse', 'factory', 'collection_point', 'store'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

/** Where each class of stock may lie (P1 Table 8.1). A material store is a warehouse row (P3 §12.5). */
export const LOCATIONS_OF: Readonly<Record<MaterialClass, readonly LocationType[]>> = {
  green_leaf: ['collection_point', 'factory'],
  made_tea: ['warehouse', 'factory'],
  material: ['warehouse', 'factory'],
};

export const OWNERSHIPS = ['owned', 'held'] as const;
export type Ownership = (typeof OWNERSHIPS)[number];

export const STOCK_STATES = ['available', 'reserved', 'allocated', 'sold', 'dispatched', 'damaged'] as const;
export type StockState = (typeof STOCK_STATES)[number];

export const DIRECTIONS = ['in', 'out'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** P3 §13.1 source_type: the documents that move stock. */
export const STOCK_SOURCES = [
  'leaf_collection',
  'leaf_purchase',
  'leaf_transfer',
  'production_batch',
  'sale',
  'goods_receipt',
  'material_issue',
  'stock_adjustment',
  'opening_balance',
] as const;
export type StockSource = (typeof STOCK_SOURCES)[number];

/**
 * How a movement is costed (P1 §8.2, §7.4: "the service assigns cost; the caller does not compute it"):
 *   source    the receiving document's cost (purchase cost, batch cost, the transfer's own out cost)
 *   average   the weighted average of the balance it leaves (P9 §16.1)
 *   adjust    an increase: at the balance's average, or at a stated cost where the document carries one
 *             (an opening balance, a count of an item that has no average yet)
 */
export type CostTreatment = 'source' | 'average' | 'adjust';

export interface MovementTypeDefinition {
  readonly label: string;
  /** both: a state change writes one row out of the old state and one into the new. */
  readonly direction: Direction | 'both';
  readonly cost: CostTreatment;
  /** Adjustments and write-offs name their adjustment_reason (P3 §13.1). */
  readonly needsReason: boolean;
  /** Written only by a paired operation (transfer, state change), never asked for directly. */
  readonly paired: boolean;
}

const t = (
  label: string,
  direction: Direction | 'both',
  cost: CostTreatment,
  o: { reason?: boolean; paired?: boolean } = {},
): MovementTypeDefinition => ({
  label,
  direction,
  cost,
  needsReason: o.reason ?? false,
  paired: o.paired ?? false,
});

/** P1 Table 8.2. "Rejection at receipt" is not a movement: rejected stock never enters. */
export const MOVEMENT_TYPES = {
  receipt_production: t('Receipt from production', 'in', 'source'),
  receipt_collection: t('Receipt from collection', 'in', 'source'),
  receipt_purchase: t('Receipt from purchase', 'in', 'source'),
  transfer_in: t('Transfer in', 'in', 'source', { paired: true }),
  transfer_out: t('Transfer out', 'out', 'average', { paired: true }),
  consumption: t('Consumption to production', 'out', 'average'),
  issue_sale: t('Issue against sale', 'out', 'average'),
  issue_activity: t('Issue to activity or department', 'out', 'average'),
  adjustment_increase: t('Adjustment: increase', 'in', 'adjust', { reason: true }),
  adjustment_decrease: t('Adjustment: decrease', 'out', 'average', { reason: true }),
  write_off: t('Damage or write-off', 'out', 'average', { reason: true }),
  // Quantity moves between states at the same place: out of one, into the other, at the average.
  state_change: t('State change', 'both', 'average', { paired: true }),
} as const satisfies Record<string, MovementTypeDefinition>;
export type MovementType = keyof typeof MOVEMENT_TYPES;
export const MOVEMENT_TYPE_KEYS = Object.keys(MOVEMENT_TYPES) as MovementType[];
/** What a document may ask for directly; transfers and state changes have their own operations. */
export type DirectMovementType = Exclude<MovementType, 'transfer_in' | 'transfer_out' | 'state_change'>;
