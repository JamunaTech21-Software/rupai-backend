import { describe, expect, it } from 'vitest';

import { addDays, type BusinessDate } from '../../src/core/time/dates.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';

/** P1.09: the fiscal calendar's date arithmetic, as pure functions (P3 §4.9–§4.10). */

const d = (s: string) => s as BusinessDate;

describe('fiscal year dates follow from the organisation start month', () => {
  it('July to June, January to December, and a year ending on a leap day', () => {
    expect(fiscalYearDates(2026, 7)).toEqual({ start: '2026-07-01', end: '2027-06-30' });
    expect(fiscalYearDates(2026, 1)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
    expect(fiscalYearDates(2027, 3)).toEqual({ start: '2027-03-01', end: '2028-02-29' });
    expect(fiscalYearDates(2026, 12)).toEqual({ start: '2026-12-01', end: '2027-11-30' });
  });

  it('consecutive fiscal years are contiguous for every start month', () => {
    for (let month = 1; month <= 12; month += 1) {
      const a = fiscalYearDates(2027, month);
      const b = fiscalYearDates(2028, month);
      expect(addDays(a.end, 1), `month ${String(month)}`).toBe(b.start);
    }
  });

  it('codes: FY2026 for a calendar year, FY2026-27 otherwise', () => {
    expect(fiscalYearCode(2026, 1)).toBe('FY2026');
    expect(fiscalYearCode(2026, 7)).toBe('FY2026-27');
    expect(fiscalYearCode(2099, 4)).toBe('FY2099-00');
  });
});

describe('the 12 + 1 periods of a fiscal year (P3 §4.10)', () => {
  it('twelve contiguous months, named, then the one-day adjustment period', () => {
    const periods = periodsOf(d('2026-07-01'));
    expect(periods).toHaveLength(13);
    expect(periods[0]).toEqual({ number: 1, name: 'July 2026', start: '2026-07-01', end: '2026-07-31' });
    expect(periods[7]).toEqual({ number: 8, name: 'February 2027', start: '2027-02-01', end: '2027-02-28' });
    expect(periods[11]).toEqual({ number: 12, name: 'June 2027', start: '2027-06-01', end: '2027-06-30' });
    expect(periods[12]).toEqual({
      number: 13,
      name: 'Year-end adjustments',
      start: '2027-06-30',
      end: '2027-06-30',
    });
    for (let i = 1; i < 12; i += 1) {
      expect(periods[i]?.start, `period ${String(i + 1)}`).toBe(
        addDays(periods[i - 1]?.end ?? d('1900-01-01'), 1),
      );
    }
  });

  it('covers the fiscal year exactly, for every start month, leap years included', () => {
    for (let month = 1; month <= 12; month += 1) {
      for (const year of [2027, 2028]) {
        const { start, end } = fiscalYearDates(year, month);
        const periods = periodsOf(start);
        expect(periods[0]?.start).toBe(start);
        expect(periods[11]?.end, `${String(year)}-${String(month)}`).toBe(end);
        expect(periods[12]).toMatchObject({ start: end, end });
      }
    }
    expect(periodsOf(d('2027-07-01'))[7]).toMatchObject({ name: 'February 2028', end: '2028-02-29' });
  });
});
