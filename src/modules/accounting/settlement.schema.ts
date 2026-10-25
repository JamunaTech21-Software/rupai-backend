import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import {
  AGEING_BANDS,
  PAYABLE_PARTIES,
  RECEIVABLE_PARTIES,
  SETTLEMENT_STATES,
  type SettlementSide,
} from '../../core/settlement/sides.js';

/** Response schemas of receivables and payables (Spec P3 §15, §16.7, P4 §11.2–§11.3; D-3.05-14). Read only. */

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

function itemFields(side: SettlementSide) {
  return {
    id: z.string(),
    /** With source_id: the document that raised the item, for a link to it. */
    source_type: z.string(),
    source_id: z.string(),
    /** The source document's number. */
    reference_number: z.string(),
    party: z.object({
      type: z.enum(side === 'receivable' ? RECEIVABLE_PARTIES : PAYABLE_PARTIES),
      id: z.string(),
      /** null while the party's module is not built. */
      code: z.string().nullable(),
      name: z.string().nullable(),
    }),
    estate: ref.nullable(),
    document_date: z.string(),
    due_date: z.string(),
    /** As at today; 0 when not yet due or closed. */
    days_overdue: z.number().int(),
    currency: z.object({ id: z.string(), code: z.string() }),
    exchange_rate: z.string(),
    original_amount: z.string(),
    original_base_amount: z.string(),
    /** Credit notes and write-offs. */
    adjusted_amount: z.string(),
    /** Base currency relieved at the item's own rate. */
    settled_base_amount: z.string(),
    outstanding_amount: z.string(),
    outstanding_base_amount: z.string(),
    /** Refreshed nightly (and at every change); null once closed. */
    ageing_band: z.enum(AGEING_BANDS).nullable(),
    state: z.enum(SETTLEMENT_STATES),
    accounting_period: z.object({ id: z.string(), name: z.string() }),
    created_at: z.string(),
    updated_at: z.string().nullable(),
  };
}
/** The two differ only in the settled amount's name (D-3.05-2). */
export const ReceivableOut = z.object({ ...itemFields('receivable'), received_amount: z.string() });
export const PayableOut = z.object({ ...itemFields('payable'), paid_amount: z.string() });

const settlingDocument = z.object({
  id: z.string(),
  /** null until posted. */
  number: z.string().nullable(),
  date: z.string(),
  state: z.string(),
  is_reversed: z.boolean(),
});
const allocationFields = {
  id: z.string(),
  amount: z.string(),
  base_amount: z.string(),
  /** Positive = gain. Fixed at posting. */
  fx_gain_loss: z.string(),
  sequence: z.number().int(),
  /** true once the document is posted (and not reversed): the amount is off the outstanding. */
  applied: z.boolean(),
};
export const CollectionAllocationOut = z.object({ ...allocationFields, collection: settlingDocument });
export const PaymentAllocationOut = z.object({ ...allocationFields, payment: settlingDocument });

export const AgeingQuery = z.strictObject({
  group_by: z.enum(['band', 'party']).default('band'),
  estate_id: zId.optional(),
  party_type: z.string().max(40).optional(),
  party_id: zId.optional(),
});

const bands = Object.fromEntries(AGEING_BANDS.map((b) => [b, z.string()])) as Record<
  (typeof AGEING_BANDS)[number],
  z.ZodString
>;
/** Open items by band as at today, live from the sub-ledger (D-3.05-11). Base currency. */
export const AgeingOut = z.object({
  as_at: z.string(),
  group_by: z.enum(['band', 'party']),
  estate_id: z.string().nullable(),
  total: z.string(),
  count: z.number().int(),
  bands: z.array(z.object({ band: z.enum(AGEING_BANDS), count: z.number().int(), amount: z.string() })),
  /** group_by party only: one row per party, largest outstanding first. */
  parties: z.array(
    z.object({
      party: z.object({
        type: z.string(),
        id: z.string(),
        code: z.string().nullable(),
        name: z.string().nullable(),
      }),
      ...bands,
      total: z.string(),
    }),
  ),
});
