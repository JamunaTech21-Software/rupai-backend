import { describe, expect, it } from 'vitest';

import type { BusinessDate } from '../../src/core/time/dates.js';
import { monthsBetween } from '../../src/modules/workforce/contractor.service.js';

const m = (a: string, b: string) => monthsBetween(a as BusinessDate, b as BusinessDate);

describe('contract duration (the design’s Contract Duration, P2.05)', () => {
  it('counts whole months inclusive of the end date', () => {
    expect(m('2026-01-01', '2026-12-31')).toBe(12);
    expect(m('2026-01-01', '2026-03-31')).toBe(3);
    expect(m('2026-01-15', '2026-07-14')).toBe(6);
    expect(m('2026-02-01', '2028-01-31')).toBe(24);
  });
  it('a part month counts as one; never less than one', () => {
    expect(m('2026-01-15', '2026-03-20')).toBe(3);
    expect(m('2026-05-10', '2026-05-10')).toBe(1);
    expect(m('2026-01-31', '2026-02-27')).toBe(1);
  });
});
