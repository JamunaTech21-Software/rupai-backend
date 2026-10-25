import type { BusinessDate } from '../time/dates.js';
import { diffDays } from '../time/dates.js';

/**
 * The two mirror-image sides of settlement (Spec P3 §15, §16.7; D-3.05-2): money owed to the organisation
 * (receivable, settled by collections) and money it owes (payable, settled by payments). One core, one
 * ageing routine and one allocation algorithm serve both; only these names differ.
 */

export const SETTLEMENT_SIDES = ['receivable', 'payable'] as const;
export type SettlementSide = (typeof SETTLEMENT_SIDES)[number];

export const SETTLEMENT_STATES = ['open', 'partially_settled', 'settled', 'written_off', 'reversed'] as const;
export type SettlementState = (typeof SETTLEMENT_STATES)[number];
/** States in which an item still has something to settle. */
export const OPEN_STATES: readonly SettlementState[] = ['open', 'partially_settled'];

export const RECEIVABLE_SOURCES = ['sale', 'lease_schedule', 'other', 'opening'] as const;
export const PAYABLE_SOURCES = [
  'supplier_invoice',
  'leaf_purchase',
  'contractor_bill',
  'employee_advance',
  'payroll_run',
  'other',
  'opening',
] as const;
export const RECEIVABLE_PARTIES = ['buyer', 'party', 'employment_profile'] as const;
export const PAYABLE_PARTIES = [
  'supplier',
  'leaf_supplier',
  'contractor',
  'party',
  'employment_profile',
] as const;
export type SettlementPartyType = (typeof RECEIVABLE_PARTIES)[number] | (typeof PAYABLE_PARTIES)[number];

export interface SideDefinition {
  readonly side: SettlementSide;
  /** The item table: receivable | payable. */
  readonly item: SettlementSide;
  /** The settling document: collection | payment. */
  readonly doc: 'collection' | 'payment';
  readonly alloc: 'collection_allocation' | 'payment_allocation';
  /** The allocation's foreign keys. */
  readonly docKey: 'collection_id' | 'payment_id';
  readonly itemKey: 'receivable_id' | 'payable_id';
  /** The item's settled column: received_amount | paid_amount. */
  readonly settledColumn: 'received_amount' | 'paid_amount';
  readonly docNumber: 'collection_number' | 'payment_number';
  readonly docDate: 'collection_date' | 'payment_date';
  readonly sources: readonly string[];
  readonly parties: readonly SettlementPartyType[];
  /** Who sees the items (P6). */
  readonly viewPermission: 'receivable.view' | 'payable.view';
  /** +1: a document base above the relieved base is a gain (money in); −1 on payables (D-3.05-7). */
  readonly fxSign: 1 | -1;
}

export const SIDES: Readonly<Record<SettlementSide, SideDefinition>> = {
  receivable: {
    side: 'receivable',
    item: 'receivable',
    doc: 'collection',
    alloc: 'collection_allocation',
    docKey: 'collection_id',
    itemKey: 'receivable_id',
    settledColumn: 'received_amount',
    docNumber: 'collection_number',
    docDate: 'collection_date',
    sources: RECEIVABLE_SOURCES,
    parties: RECEIVABLE_PARTIES,
    viewPermission: 'receivable.view',
    fxSign: 1,
  },
  payable: {
    side: 'payable',
    item: 'payable',
    doc: 'payment',
    alloc: 'payment_allocation',
    docKey: 'payment_id',
    itemKey: 'payable_id',
    settledColumn: 'paid_amount',
    docNumber: 'payment_number',
    docDate: 'payment_date',
    sources: PAYABLE_SOURCES,
    parties: PAYABLE_PARTIES,
    viewPermission: 'payable.view',
    fxSign: -1,
  },
};

// ---- ageing (P9 §19.1) -----------------------------------------------------------------------------

export const AGEING_BANDS = ['current', '1_30', '31_60', '61_90', 'over_90'] as const;
export type AgeingBand = (typeof AGEING_BANDS)[number];

/**
 * The ageing band of an item due on `due`, as at `asAt` (P9 §19.1): days overdue = as-at − due (0 if not
 * yet due). Upper bounds are inclusive: exactly 30 days overdue is 1_30. AG.1: due 2026-06-12, as at
 * 2026-08-01 → 50 days → 31_60.
 */
export function ageingBand(due: BusinessDate, asAt: BusinessDate): AgeingBand {
  const overdue = diffDays(due, asAt);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return '1_30';
  if (overdue <= 60) return '31_60';
  if (overdue <= 90) return '61_90';
  return 'over_90';
}
