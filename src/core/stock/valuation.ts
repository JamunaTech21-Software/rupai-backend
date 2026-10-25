import { type Dec, dec, round } from '../money/decimal.js';

/**
 * Weighted-average valuation (Spec P9 §16.1, P1 §8.5), as pure functions so the transactional path and the
 * nightly rebuild cannot disagree.
 *
 *   - A balance keeps its quantity and its VALUE: the running total of the values of the movements that
 *     made it. The average is value ÷ quantity to 4 places, and zero when the quantity is zero (the P9
 *     boundary: the next receipt sets the average afresh). Keeping the value, not the product
 *     quantity × average, is what lets the inventory sub-ledger equal the sum of the values posted.
 *   - Inbound: value = quantity × the movement's unit cost, so the average is recomputed
 *     (existing value + incoming value) ÷ (existing quantity + incoming quantity).
 *   - Outbound: at the average, never changing it; the movement that empties a balance takes all of the
 *     remaining value, so no residue of rounding is left behind.
 *   - Held material carries no value (P1 §8.3).
 *
 * P9 WA.1: 500 @ 100.00 + 300 @ 120.00 → 800 @ 107.50; issue 200 → 21,500.00; closing 600 = 64,500.00.
 */

export interface Holding {
  readonly quantity: Dec;
  readonly value: Dec;
}

export interface Valued {
  readonly unitCost: Dec;
  readonly value: Dec;
  readonly after: Holding;
}

const ZERO = dec('0');
export const EMPTY: Holding = { quantity: ZERO, value: ZERO };

/** value ÷ quantity, 4 places; zero for an empty balance. */
export function averageOf(h: Holding): Dec {
  return h.quantity.isZero() ? ZERO : round(h.value.div(h.quantity), 4);
}

/** `exactValue`: the value a paired or compensating movement carries over unchanged. */
export function valueIn(h: Holding, quantity: Dec, unitCost: Dec, held: boolean, exactValue?: Dec): Valued {
  const cost = held ? ZERO : round(unitCost, 4);
  const value = held ? ZERO : (exactValue ?? round(quantity.times(cost), 4));
  return {
    unitCost: cost,
    value,
    after: { quantity: h.quantity.plus(quantity), value: h.value.plus(value) },
  };
}

/** null: the balance does not hold that much (the caller refuses the movement). */
export function valueOut(h: Holding, quantity: Dec, held: boolean): Valued | null {
  if (quantity.greaterThan(h.quantity)) return null;
  const average = held ? ZERO : averageOf(h);
  const emptied = quantity.equals(h.quantity);
  let value = held ? ZERO : emptied ? h.value : round(quantity.times(average), 4);
  if (value.greaterThan(h.value)) value = h.value;
  const after = emptied ? EMPTY : { quantity: h.quantity.minus(quantity), value: h.value.minus(value) };
  return { unitCost: average, value, after };
}
