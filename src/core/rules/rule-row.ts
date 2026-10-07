import { businessDateFromDb, isBusinessDate, type BusinessDate } from '../time/dates.js';
import type { RuleTable } from './rule-table.js';

/** Reading raw rule rows ($queryRaw): ids arrive as bigint, DATEs as Date at 00:00 UTC. */

export function readId(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' || typeof v === 'string') return BigInt(v);
  throw new TypeError(`not an id: ${String(v)}`);
}

export function readOptionalId(v: unknown): bigint | null {
  return v === null || v === undefined ? null : readId(v);
}

export function readDate(v: unknown): BusinessDate {
  if (v instanceof Date) return businessDateFromDb(v);
  if (typeof v === 'string' && isBusinessDate(v.slice(0, 10))) return v.slice(0, 10) as BusinessDate;
  throw new TypeError(`not a DATE: ${String(v)}`);
}

export function readOptionalDate(v: unknown): BusinessDate | null {
  return v === null || v === undefined ? null : readDate(v);
}

/** A scope value as the API shows it: the id as a string, or null for "any". */
export function scopeOfRow(
  table: RuleTable,
  row: Readonly<Record<string, unknown>>,
): Record<string, string | null> {
  return Object.fromEntries(
    table.dimensions.map((d) => [
      d.key,
      row[d.column] === null || row[d.column] === undefined ? null : String(row[d.column]),
    ]),
  );
}

export function partitionsOfRow(
  table: RuleTable,
  row: Readonly<Record<string, unknown>>,
): Record<string, string> {
  return Object.fromEntries(table.partitions.map((p) => [p.key, String(row[p.column])]));
}
