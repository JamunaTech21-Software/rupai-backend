import { z } from 'zod';

import { Prisma } from '../../generated/prisma/client.js';

/**
 * Decimal arithmetic for money, quantities, rates and percentages (Spec P9 §2, P4 §2.3, P3 §2).
 *
 *   - No binary floating point anywhere in a financial or quantity calculation. No `number`, no
 *     `parseFloat`, no `Number(...)`.
 *   - Values cross the API as decimal STRINGS ("12345.6700"), never JSON numbers.
 *   - Intermediate working keeps full precision. Rounding happens only at the points P9 §2.2 names.
 *
 * `Dec` is decimal.js (the same library Prisma uses for DECIMAL columns), cloned with 40 significant
 * digits. Prisma's own default of 20 is too few for an 18-digit amount times an 8-decimal exchange rate.
 */
export const Dec = Prisma.Decimal.clone({
  precision: 40,
  rounding: Prisma.Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
});
export type Dec = InstanceType<typeof Dec>;

/** Anything a decimal can be built from. Floats are deliberately excluded. */
export type DecimalInput = Dec | string | bigint;

/**
 * The closed set of decimal kinds (Spec P3 §2 type list):
 *   scale     — digits stored after the point (the column's DECIMAL(p, s))
 *   intDigits — digits allowed before the point (p − s)
 */
export const DECIMAL_KINDS = {
  /** Money, DECIMAL(18,4). Four places absorb unit rates and FX without drift. Payable amounts round to 2. */
  money: { scale: 4, intDigits: 14 },
  /** Quantity and weight in kg, DECIMAL(14,3): to the gram. */
  qty: { scale: 3, intDigits: 11 },
  /** Exchange rate, DECIMAL(18,8). */
  rate: { scale: 8, intDigits: 10 },
  /** Percentage, ratio or yield, DECIMAL(9,4). */
  pct: { scale: 4, intDigits: 5 },
} as const;
export type DecimalKind = keyof typeof DECIMAL_KINDS;

/** Rounding modes a rule may carry (Spec P3 §17.1 rounding_mode). Default half_up (P9 §2.2). */
export const ROUNDING_MODES = {
  half_up: Dec.ROUND_HALF_UP,
  half_down: Dec.ROUND_HALF_DOWN,
  up: Dec.ROUND_UP,
  down: Dec.ROUND_DOWN,
} as const;
export type RoundingMode = keyof typeof ROUNDING_MODES | 'none';

/** Payable money is rounded to 2 decimal places, half up (Spec P9 §2.2). */
export const PAYABLE_SCALE = 2;

/** Plain decimal notation only: optional sign, digits, optional fraction. No exponent, no separators. */
const DECIMAL_STRING = /^-?\d+(?:\.\d+)?$/;

export class DecimalFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalFormatError';
  }
}

/** Converts a trusted value (a database Decimal, another Dec, a bigint or a validated string) to Dec. */
export function dec(value: DecimalInput): Dec {
  if (typeof value === 'string') {
    if (!DECIMAL_STRING.test(value)) throw new DecimalFormatError(`not a plain decimal string: "${value}"`);
    return new Dec(value);
  }
  if (typeof value === 'bigint') return new Dec(value.toString());
  // A Prisma.Decimal comes from a different decimal.js constructor, so go through its exact string form.
  const v: { toString(): string } = value;
  return v instanceof Dec ? v : new Dec(v.toString());
}

/**
 * Parses untrusted input (an API body or a query) as a decimal of the given kind. It refuses floats,
 * exponents, separators, more decimal places than the column stores, and more integer digits than fit.
 */
export function parseDecimal(input: unknown, kind: DecimalKind): Dec {
  if (typeof input !== 'string') {
    throw new DecimalFormatError('must be a decimal string such as "12345.6700", not a number');
  }
  const s = input.trim();
  if (!DECIMAL_STRING.test(s)) throw new DecimalFormatError('must be a plain decimal such as 12345.6700');
  const { scale, intDigits } = DECIMAL_KINDS[kind];
  const [intPart = '', frac = ''] = s.replace('-', '').split('.');
  if (frac.length > scale) throw new DecimalFormatError(`must have at most ${scale} decimal places`);
  if (intPart.replace(/^0+(?=\d)/, '').length > intDigits) {
    throw new DecimalFormatError(`must have at most ${intDigits} digits before the decimal point`);
  }
  return new Dec(s);
}

/** Rounds to `places` with the given mode (default half up). 'none' returns the value unchanged. */
export function round(value: DecimalInput, places: number, mode: RoundingMode = 'half_up'): Dec {
  const d = dec(value);
  return mode === 'none' ? d : d.toDecimalPlaces(places, ROUNDING_MODES[mode]);
}

/** Rounds a payable money amount: 2 dp, half up (Spec P9 §2.2). For example 3,040.625 → 3,040.63. */
export function roundMoney(value: DecimalInput): Dec {
  return round(value, PAYABLE_SCALE);
}

/**
 * Formats for the API and for storage: a fixed number of places for the kind, e.g. money "12345.6700"
 * or qty "2400.000". Rounds half up if the value carries more places than the kind stores.
 */
export function toDecimalString(value: DecimalInput, kind: DecimalKind): string {
  return dec(value).toFixed(DECIMAL_KINDS[kind].scale, Dec.ROUND_HALF_UP);
}

export function sum(values: readonly DecimalInput[]): Dec {
  return values.reduce<Dec>((acc, v) => acc.plus(dec(v)), new Dec(0));
}

/**
 * Divides, refusing a zero divisor. Per Spec P9 §2.1 a zero divisor never produces a result: no zero,
 * no infinity, always an exception the caller handles (usually as "not applicable").
 */
export function divide(numerator: DecimalInput, divisor: DecimalInput): Dec {
  const d = dec(divisor);
  if (d.isZero()) throw new RangeError('division by zero is not permitted (Spec P9 §2.1)');
  return dec(numerator).div(d);
}

/**
 * Allocates `total` across lines in proportion to `weights`, rounded to `places`, so the parts ALWAYS sum
 * to the total exactly. Any rounding difference is absorbed on the LARGEST line by allocated amount.
 * That is the single rounding-difference rule of Spec P9 §14.3, applied everywhere a total is split.
 *
 * Example (P9 BA.2): 100,000.00 over values 168,000 / 54,000 / 9,000 → 72,727.28 / 23,376.62 / 3,896.10
 */
export function allocate(
  total: DecimalInput,
  weights: readonly DecimalInput[],
  places = PAYABLE_SCALE,
): Dec[] {
  if (weights.length === 0) throw new RangeError('allocate needs at least one weight');
  const w = weights.map(dec);
  if (w.some((x) => x.isNegative())) throw new RangeError('allocation weights must not be negative');
  const t = dec(total);
  const totalWeight = sum(w);
  if (totalWeight.isZero()) throw new RangeError('allocation weights sum to zero (Spec P9 §2.1)');
  if (w.length === 1) return [round(t, places)]; // single-line case short-circuits (P9 BA.3)

  const parts = w.map((x) => round(t.mul(x).div(totalWeight), places));
  const diff = round(t, places).minus(sum(parts));
  if (!diff.isZero()) {
    let largest = 0;
    parts.forEach((p, i) => {
      if (p.gt(parts[largest] ?? p)) largest = i;
    });
    parts[largest] = (parts[largest] ?? new Dec(0)).plus(diff);
  }
  return parts;
}

/**
 * Splits `total` into `count` equal instalments rounded to `places`. The FINAL instalment is adjusted so
 * the instalments sum to the total exactly (Spec P9 §11, e.g. 10,000.00 / 3 → 3,333.33, 3,333.33, 3,333.34).
 */
export function splitInstalments(total: DecimalInput, count: number, places = PAYABLE_SCALE): Dec[] {
  if (!Number.isInteger(count) || count < 1)
    throw new RangeError('instalment count must be a positive integer');
  const t = round(total, places);
  const each = round(t.div(count), places);
  const parts = Array.from({ length: count - 1 }, () => each);
  parts.push(t.minus(each.mul(count - 1)));
  return parts;
}

/**
 * Zod schema for a decimal string field of the given kind. It validates format, scale and magnitude, and
 * transforms to Dec, so services never see a string or a float. Options set inclusive bounds.
 */
export function zDecimal(kind: DecimalKind, opts: { min?: string; max?: string; positive?: boolean } = {}) {
  const { scale, intDigits } = DECIMAL_KINDS[kind];
  return z
    .string({ error: 'must be a decimal string such as "12345.6700", not a number' })
    .meta({
      description: `Decimal string (${kind}): up to ${intDigits} digits and ${scale} decimal places. Never a JSON number.`,
      pattern: `^-?\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`,
      examples: [kind === 'qty' ? '37.000' : kind === 'rate' ? '121.50000000' : '12345.6700'],
    })
    .transform((input, ctx): Dec => {
      let d: Dec;
      try {
        d = parseDecimal(input, kind);
      } catch (e) {
        ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : 'invalid decimal' });
        return z.NEVER;
      }
      if (opts.positive && !d.gt(0)) ctx.addIssue({ code: 'custom', message: 'must be greater than 0' });
      if (opts.min !== undefined && d.lt(opts.min))
        ctx.addIssue({ code: 'custom', message: `must be at least ${opts.min}` });
      if (opts.max !== undefined && d.gt(opts.max))
        ctx.addIssue({ code: 'custom', message: `must be at most ${opts.max}` });
      return d;
    });
}
