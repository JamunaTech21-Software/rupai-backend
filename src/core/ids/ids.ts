import { decodeTime, monotonicFactory } from 'ulid';
import { z } from 'zod';

/**
 * Record identity (Spec P1 §15.1, P2 §2.2, P3 §2):
 *
 *   - Surrogate keys are BIGINT UNSIGNED. In the API they travel as numeric STRINGS ("9007199254740993"),
 *     because a JSON number loses precision above 2^53.
 *   - The six field-capture tables (attendance, plucking_work_record, team_distribution, leaf_collection,
 *     field_activity, field_inspection) use a ULID primary key. It is generated at the point of capture,
 *     possibly on an offline device, and adopted by the server unchanged.
 */

/** Crockford base32, 26 characters, uppercase. The first 10 encode the millisecond timestamp. */
export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const monotonic = monotonicFactory();

/**
 * A new ULID. Monotonic: several ULIDs generated in the same millisecond still sort in creation order,
 * which keeps index locality in InnoDB (Spec P2 §2.2). It never goes backwards, even if the clock does.
 */
export function newUlid(): string {
  return monotonic();
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_PATTERN.test(value);
}

/** The creation time encoded in a ULID. Used, for example, for the device clock-skew check (P12 §4.4). */
export function ulidTime(value: string): Date {
  if (!isUlid(value)) throw new RangeError(`not a ULID: ${String(value)}`);
  return new Date(decodeTime(value));
}

const BIGINT_ID = /^[1-9]\d{0,19}$/;
const MAX_UNSIGNED_BIGINT = 18_446_744_073_709_551_615n;

export function isId(value: unknown): value is string {
  return typeof value === 'string' && BIGINT_ID.test(value) && BigInt(value) <= MAX_UNSIGNED_BIGINT;
}

/** Parses an API id string into the bigint Prisma expects. */
export function parseId(value: string): bigint {
  if (!isId(value)) throw new RangeError(`not a valid id: ${String(value)}`);
  return BigInt(value);
}

/** Zod: a BIGINT surrogate id given as a numeric string → bigint. */
export const zId = z
  .string({ error: 'must be an identifier string' })
  .refine(isId, 'must be a positive numeric identifier')
  .transform((v) => BigInt(v));

/** Zod: a ULID (uppercase Crockford base32, 26 characters). */
export const zUlid = z
  .string({ error: 'must be a ULID string' })
  .regex(ULID_PATTERN, 'must be a 26-character ULID');
