import { describe, expect, it } from 'vitest';

import { ageingBand, SIDES } from '../../src/core/settlement/sides.js';
import type { BusinessDate } from '../../src/core/time/dates.js';

const d = (s: string) => s as BusinessDate;

describe('ageing bands (P9 §19.1)', () => {
  it('AG.1: due 2026-06-12, as at 2026-08-01 is 50 days overdue → 31_60', () => {
    expect(ageingBand(d('2026-06-12'), d('2026-08-01'))).toBe('31_60');
  });

  it('upper bounds are inclusive; not yet due is current', () => {
    const due = d('2026-01-01');
    expect(ageingBand(due, d('2025-12-15'))).toBe('current');
    expect(ageingBand(due, d('2026-01-01'))).toBe('current');
    expect(ageingBand(due, d('2026-01-02'))).toBe('1_30');
    expect(ageingBand(due, d('2026-01-31'))).toBe('1_30');
    expect(ageingBand(due, d('2026-02-01'))).toBe('31_60');
    expect(ageingBand(due, d('2026-03-02'))).toBe('31_60');
    expect(ageingBand(due, d('2026-03-03'))).toBe('61_90');
    expect(ageingBand(due, d('2026-04-01'))).toBe('61_90');
    expect(ageingBand(due, d('2026-04-02'))).toBe('over_90');
  });
});

describe('the two sides mirror each other (P3 §16.7, D-3.05-2)', () => {
  it('differ only in names, direction and their source and party lists', () => {
    const shape = (s: (typeof SIDES)[keyof typeof SIDES]) => Object.keys(s).sort();
    expect(shape(SIDES.receivable)).toEqual(shape(SIDES.payable));
    expect(SIDES.receivable.fxSign).toBe(1);
    expect(SIDES.payable.fxSign).toBe(-1);
  });
});
