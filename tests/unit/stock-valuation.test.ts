import { describe, expect, it } from 'vitest';

import { dec } from '../../src/core/money/decimal.js';
import { averageOf, EMPTY, valueIn, valueOut } from '../../src/core/stock/valuation.js';

/** P4.04 — weighted-average valuation (Spec P9 §16.1), the pure half of core/stock. */
describe('weighted average (P9 §16.1)', () => {
  it('P9 WA.1: average 107.50, issue 21,500.00, closing 64,500.00', () => {
    const opening = valueIn(EMPTY, dec('500'), dec('100.00'), false);
    const receipt = valueIn(opening.after, dec('300'), dec('120.00'), false);
    expect(receipt.value.toFixed(2)).toBe('36000.00');
    expect(averageOf(receipt.after).toFixed(2)).toBe('107.50');
    const issue = valueOut(receipt.after, dec('200'), false);
    expect(issue?.unitCost.toFixed(2)).toBe('107.50');
    expect(issue?.value.toFixed(2)).toBe('21500.00');
    expect(issue?.after.quantity.toFixed(3)).toBe('600.000');
    expect(issue?.after.value.toFixed(2)).toBe('64500.00');
    expect(averageOf(issue?.after ?? EMPTY).toFixed(2)).toBe('107.50');
  });

  it('an outbound movement never changes the average', () => {
    const h = valueIn(EMPTY, dec('3'), dec('10.00'), false).after;
    const more = valueIn(h, dec('7'), dec('11.00'), false).after; // 107 / 10 = 10.70
    const out = valueOut(more, dec('4'), false);
    expect(averageOf(more).toFixed(4)).toBe('10.7000');
    expect(averageOf(out?.after ?? EMPTY).toFixed(4)).toBe('10.7000');
  });

  it('the movement that empties a balance takes all of its value; the next receipt sets the average afresh', () => {
    const h = valueIn(valueIn(EMPTY, dec('1'), dec('10'), false).after, dec('2'), dec('10.01'), false).after;
    // average 30.02 / 3 = 10.0067 (4 dp); three issues of 1 at that average would leave a residue.
    const a = valueOut(h, dec('1'), false);
    const b = valueOut(a?.after ?? EMPTY, dec('1'), false);
    const c = valueOut(b?.after ?? EMPTY, dec('1'), false);
    expect(c?.after).toEqual(EMPTY);
    expect(
      (a?.value ?? dec('0'))
        .plus(b?.value ?? 0)
        .plus(c?.value ?? 0)
        .toFixed(4),
    ).toBe('30.0200');
    const fresh = valueIn(EMPTY, dec('5'), dec('99.5'), false);
    expect(averageOf(fresh.after).toFixed(2)).toBe('99.50');
  });

  it('refuses to go below zero, and values held stock at nothing', () => {
    expect(valueOut(EMPTY, dec('0.001'), false)).toBeNull();
    const held = valueIn(EMPTY, dec('1000'), dec('0'), true);
    expect(held.value.isZero()).toBe(true);
    expect(valueOut(held.after, dec('400'), true)?.value.isZero()).toBe(true);
  });
});
