import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import { isId, isUlid, newUlid, parseId, ulidTime, zId, zUlid } from '../../src/core/ids/ids.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  daysInMonth,
  diffDays,
  isBusinessDate,
  isWithin,
  parseBusinessDate,
  parseTimestamp,
  todayIn,
  toTimestamp,
  zBusinessDate,
  zTimestamp,
  type BusinessDate,
} from '../../src/core/time/dates.js';

const D = (s: string) => parseBusinessDate(s);

describe('ULID (Spec P3 §2.2)', () => {
  it('generates valid, uppercase, 26-character ULIDs', () => {
    const id = newUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('is monotonic within the same millisecond, so ids sort by creation order', () => {
    const ids = Array.from({ length: 1000 }, () => newUlid());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(1000);
  });

  it('encodes its creation time', () => {
    const t = Date.parse('2026-06-12T09:14:02.000Z');
    expect(ulidTime(ulid(t)).toISOString()).toBe('2026-06-12T09:14:02.000Z');
  });

  it.each(['01jq7f3m2k8xabcdefghjkmnpq', '01JQ7F3M2K8X', 'ILOU0000000000000000000000', 123])(
    'rejects %j',
    (v) => {
      expect(isUlid(v)).toBe(false);
      expect(zUlid.safeParse(v).success).toBe(false);
    },
  );
});

describe('BIGINT ids travel as strings', () => {
  it('parses ids beyond Number.MAX_SAFE_INTEGER exactly', () => {
    expect(parseId('9007199254740993')).toBe(9007199254740993n);
    expect(zId.parse('18446744073709551615')).toBe(18446744073709551615n);
  });

  it.each(['0', '-1', '01', '1.5', 'abc', '18446744073709551616'])('rejects %s', (v) => {
    expect(isId(v)).toBe(false);
    expect(zId.safeParse(v).success).toBe(false);
  });
});

describe('business dates (Spec P2 §2.7)', () => {
  it('validates real calendar dates only', () => {
    expect(isBusinessDate('2026-06-12')).toBe(true);
    expect(isBusinessDate('2028-02-29')).toBe(true); // leap year
    expect(isBusinessDate('2026-02-29')).toBe(false);
    expect(isBusinessDate('2026-13-01')).toBe(false);
    expect(isBusinessDate('12-06-2026')).toBe(false); // the mock data's DD-MM-YYYY strings are refused
  });

  it('round-trips through a DATE column without shifting a day', () => {
    const d = D('2026-06-12');
    const stored = businessDateToDb(d);
    expect(stored.toISOString()).toBe('2026-06-12T00:00:00.000Z');
    expect(businessDateFromDb(stored)).toBe('2026-06-12');
  });

  it("today's date is computed in the estate timezone, not the server's", () => {
    // 19:30 UTC on 11 June is 01:30 on 12 June in Dhaka (UTC+6).
    const now = new Date('2026-06-11T19:30:00Z');
    expect(todayIn('Asia/Dhaka', now)).toBe('2026-06-12');
    expect(todayIn('UTC', now)).toBe('2026-06-11');
  });

  it('adds and diffs calendar days across month and year ends', () => {
    expect(addDays(D('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(D('2026-03-01'), -1)).toBe('2026-02-28');
    expect(diffDays(D('2026-06-01'), D('2026-06-30'))).toBe(29);
    expect(diffDays(D('2026-06-30'), D('2026-06-01'))).toBe(-29);
  });

  it('knows calendar days per month (monthly wage proration, P9 W2)', () => {
    expect(daysInMonth(2026, 7)).toBe(31);
    expect(daysInMonth(2026, 6)).toBe(30);
    expect(daysInMonth(2028, 2)).toBe(29);
  });

  it('checks inclusive effective ranges, open-ended when to is null (P1 §2.5)', () => {
    const date: BusinessDate = D('2026-03-01');
    expect(isWithin(date, D('2026-03-01'), null)).toBe(true);
    expect(isWithin(date, D('2025-04-01'), D('2026-02-28'))).toBe(false);
    expect(isWithin(D('2026-02-28'), D('2025-04-01'), D('2026-02-28'))).toBe(true);
  });

  it('zBusinessDate validates request fields', () => {
    expect(zBusinessDate.parse('2026-06-12')).toBe('2026-06-12');
    expect(zBusinessDate.safeParse('2026-06-31').success).toBe(false);
  });
});

describe('timestamps (Spec P4 §2.3)', () => {
  it('requires an explicit UTC offset: the server never infers a timezone', () => {
    expect(parseTimestamp('2026-06-12T07:12:00+06:00').toISOString()).toBe('2026-06-12T01:12:00.000Z');
    expect(() => parseTimestamp('2026-06-12T07:12:00')).toThrow('UTC offset');
    expect(zTimestamp.safeParse('2026-06-12 07:12').success).toBe(false);
  });

  it('formats instants as ISO 8601 UTC', () => {
    expect(toTimestamp(new Date(Date.UTC(2026, 5, 12, 2, 14, 33)))).toBe('2026-06-12T02:14:33.000Z');
  });
});
