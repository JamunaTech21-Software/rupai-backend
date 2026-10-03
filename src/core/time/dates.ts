import { z } from 'zod';

/**
 * Dates and times (Spec P2 §2.7, P4 §2.3, P14 §8.3):
 *
 *   - TIMESTAMPS are stored in UTC and travel as ISO 8601 with an explicit offset. The server never
 *     infers a timezone from the caller.
 *   - BUSINESS DATES (sale date, attendance date, posting date) carry no time and no timezone. A plucking
 *     record dated 12 June is dated 12 June regardless of server or client timezone. They travel as
 *     "YYYY-MM-DD" and are stored in DATE columns.
 *   - The display timezone (Asia/Dhaka) is configuration, used only to answer "what is today's date".
 *
 * The one trap this module exists to prevent: Prisma maps a DATE column to a JS Date at 00:00 UTC.
 * Formatting that Date in a local timezone west of UTC, or with toLocaleDateString, shifts it by a day.
 * Always convert with businessDateFromDb / businessDateToDb.
 */

/** A calendar date "YYYY-MM-DD". Branded, so a plain string cannot be passed where a validated date is expected. */
export type BusinessDate = string & { readonly __brand: 'BusinessDate' };

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== 'string') return false;
  const m = DATE_PATTERN.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parseBusinessDate(value: string): BusinessDate {
  if (!isBusinessDate(value)) throw new RangeError(`not a calendar date in YYYY-MM-DD form: ${value}`);
  return value;
}

/** DATE column → business date, read from the UTC calendar fields so it never shifts. */
export function businessDateFromDb(d: Date): BusinessDate {
  if (Number.isNaN(d.getTime())) throw new RangeError('invalid Date');
  return d.toISOString().slice(0, 10) as BusinessDate;
}

/** Business date → the Date that Prisma writes to a DATE column (00:00 UTC on that day). */
export function businessDateToDb(date: BusinessDate): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** Today's calendar date in the given IANA timezone, e.g. the estate's Asia/Dhaka. */
export function todayIn(timezone: string, now: Date = new Date()): BusinessDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now) as BusinessDate;
}

export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isInteger(days)) throw new RangeError('days must be an integer');
  const d = businessDateToDb(date);
  d.setUTCDate(d.getUTCDate() + days);
  return businessDateFromDb(d);
}

/** Whole days from `from` to `to` (to − from). Negative when `to` is earlier. */
export function diffDays(from: BusinessDate, to: BusinessDate): number {
  return Math.round((businessDateToDb(to).getTime() - businessDateToDb(from).getTime()) / 86_400_000);
}

/** Calendar days in a month (month is 1–12). Used by monthly-wage proration (Spec P9 W2). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive range check, comparing calendar dates only. */
export function isWithin(date: BusinessDate, from: BusinessDate, to: BusinessDate | null): boolean {
  return date >= from && (to === null || date <= to);
}

/** Parses an ISO 8601 timestamp that carries an explicit offset ("Z" or "+06:00"). */
export function parseTimestamp(value: string): Date {
  if (!TIMESTAMP_PATTERN.test(value)) throw new RangeError('timestamp must be ISO 8601 with a UTC offset');
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new RangeError('timestamp is not a real instant');
  return d;
}

/** Formats an instant for the API: ISO 8601 in UTC. */
export function toTimestamp(d: Date): string {
  return d.toISOString();
}

/** Zod: a business date string. */
export const zBusinessDate = z
  .string({ error: 'must be a date string' })
  .refine(isBusinessDate, 'must be a calendar date in YYYY-MM-DD form')
  .transform((v) => v);

/** Zod: an ISO 8601 timestamp with an explicit offset → Date. */
export const zTimestamp = z
  .string({ error: 'must be a timestamp string' })
  .refine(
    (v) => TIMESTAMP_PATTERN.test(v) && !Number.isNaN(Date.parse(v)),
    'must be ISO 8601 with a UTC offset',
  )
  .transform((v) => new Date(v));
