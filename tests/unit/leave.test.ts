import { describe, expect, it } from 'vitest';

import { dec } from '../../src/core/money/decimal.js';
import type { BusinessDate } from '../../src/core/time/dates.js';
import { activeMonths, balanceOf, proRata, workingDays } from '../../src/modules/workforce/leave.service.js';

const D = (s: string) => s as BusinessDate;
const FRIDAY = [5];

describe('leave entitlement (Spec P9 §12)', () => {
  it('LV.1 mid-year joiner: 18 days, April–March year, joined 1 October → 6 months → 9.000', () => {
    const months = activeMonths(D('2026-04-01'), D('2027-03-31'), D('2026-10-01'), null);
    expect(months).toBe(6);
    expect(proRata('18', months).toFixed(3)).toBe('9.000');
  });

  it('a full year is the annual figure; a leaver counts the months employed; a month counts by its 15th', () => {
    expect(activeMonths(D('2026-04-01'), D('2027-03-31'), D('2020-01-01'), null)).toBe(12);
    expect(activeMonths(D('2026-04-01'), D('2027-03-31'), D('2020-01-01'), D('2026-06-30'))).toBe(3);
    expect(activeMonths(D('2026-04-01'), D('2027-03-31'), D('2026-10-16'), null)).toBe(5);
    expect(proRata('14', 5).toFixed(3)).toBe('5.833');
  });

  it('LV.2 carry forward: available 23.000, balance 8.500', () => {
    const { total, balance } = balanceOf({
      entitledDays: dec('18'),
      carriedForwardDays: dec('5'),
      adjustmentDays: dec('0'),
      consumedDays: dec('14.5'),
      encashedDays: dec('0'),
    });
    expect(total.toFixed(3)).toBe('23.000');
    expect(balance.toFixed(3)).toBe('8.500');
  });

  it('day count: working days inclusive, weekly offs excluded', () => {
    // 2026-10-19 is a Monday: Mon–Sun with Friday off is 6 days.
    expect(workingDays(D('2026-10-19'), D('2026-10-25'), FRIDAY)).toBe(6);
    expect(workingDays(D('2026-10-23'), D('2026-10-23'), FRIDAY)).toBe(0);
    expect(workingDays(D('2026-10-19'), D('2026-10-25'), [5, 6])).toBe(5);
  });
});
