import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Prisma } from '../../src/generated/prisma/client.js';
import {
  allocate,
  Dec,
  dec,
  DecimalFormatError,
  divide,
  parseDecimal,
  round,
  roundMoney,
  splitInstalments,
  sum,
  toDecimalString,
  zDecimal,
} from '../../src/core/money/decimal.js';

const s = (values: readonly Dec[]) => values.map((v) => v.toFixed(2));

describe('no floating point (Spec P9 §2.1)', () => {
  it('0.1 + 0.2 is exactly 0.3', () => {
    expect(dec('0.1').plus('0.2').toString()).toBe('0.3');
  });

  it('round-trips the API string exactly', () => {
    expect(toDecimalString(parseDecimal('12345.6700', 'money'), 'money')).toBe('12345.6700');
    expect(toDecimalString(parseDecimal('2400', 'qty'), 'qty')).toBe('2400.000');
  });

  it('keeps 40 significant digits: an 18-digit amount times an 8-decimal rate is exact', () => {
    const product = dec('99999999999999.9999').mul('121.50000001');
    expect(product.toString()).toBe('12150000000999999.987849999999');
  });

  it('accepts Prisma Decimal values from the database', () => {
    expect(dec(new Prisma.Decimal('9847.25')).plus('0.75').toString()).toBe('9848');
  });
});

describe('parseDecimal: untrusted input', () => {
  it.each([
    [12.5, 'not a number'],
    ['1e5', 'plain decimal'],
    ['1,250.00', 'plain decimal'],
    ['12.3.4', 'plain decimal'],
    ['', 'plain decimal'],
    ['12.34567', 'at most 4 decimal places'],
    ['123456789012345.00', 'at most 14 digits'],
  ])('refuses %j for money', (input, message) => {
    expect(() => parseDecimal(input, 'money')).toThrow(DecimalFormatError);
    expect(() => parseDecimal(input, 'money')).toThrow(message);
  });

  it('enforces the scale of each kind', () => {
    expect(() => parseDecimal('37.0001', 'qty')).toThrow('at most 3 decimal places');
    expect(parseDecimal('121.50000000', 'rate').toString()).toBe('121.5');
    expect(() => parseDecimal('121.500000001', 'rate')).toThrow('at most 8 decimal places');
  });

  it('accepts negatives and leading zeros within the digit limit', () => {
    expect(parseDecimal('-0012.50', 'money').toString()).toBe('-12.5');
  });
});

describe('rounding (Spec P9 §2.2)', () => {
  it('W5.1: 6.25 × 486.500 = 3,040.625 → 3,040.63 (half up, not half even)', () => {
    expect(roundMoney(dec('6.25').mul('486.500')).toFixed(2)).toBe('3040.63');
  });

  it('W1.1: 152.00 × 24.5000 = 3,724.00', () => {
    expect(roundMoney(dec('152.00').mul('24.5000')).toFixed(2)).toBe('3724.00');
  });

  it('W2.2: 24,000.00 × (24 / 31) = 18,580.6451… → 18,580.65, with full precision until the end', () => {
    expect(roundMoney(dec('24000.00').mul(divide('24', '31'))).toFixed(2)).toBe('18580.65');
  });

  it('PF.1: 8% of 1,748.00 = 139.84', () => {
    expect(roundMoney(dec('1748.00').mul('8').div(100)).toFixed(2)).toBe('139.84');
  });

  it('supports the rule rounding modes', () => {
    expect(round('2.345', 2, 'half_up').toFixed(2)).toBe('2.35');
    expect(round('2.345', 2, 'half_down').toFixed(2)).toBe('2.34');
    expect(round('2.341', 2, 'up').toFixed(2)).toBe('2.35');
    expect(round('2.349', 2, 'down').toFixed(2)).toBe('2.34');
    expect(round('2.34567', 2, 'none').toString()).toBe('2.34567');
  });

  it('payslip lines add up to the printed totals when each component is rounded first (P9 Fig 8.2)', () => {
    const earnings = [dec('152.00').mul('11.5000'), dec('6.50').mul('37.000'), dec('200.00')].map(roundMoney);
    const gross = sum(earnings);
    const deductions = [roundMoney((earnings[0] ?? dec('0')).mul('0.08')), dec('300.00')];
    const net = gross.minus(sum(deductions));
    expect(s(earnings)).toEqual(['1748.00', '240.50', '200.00']);
    expect(gross.toFixed(2)).toBe('2188.50');
    expect(s(deductions)).toEqual(['139.84', '300.00']);
    expect(net.toFixed(2)).toBe('1748.66');
  });
});

describe('division by zero (Spec P9 §2.1)', () => {
  it('never returns zero or infinity', () => {
    expect(() => divide('10', '0')).toThrow(RangeError);
    expect(() => divide('10', '0.000')).toThrow('division by zero');
  });
});

describe('allocate: the rounding-difference rule (Spec P9 §14.3)', () => {
  it('BA.1 quantity basis: 100,000.00 over 600 / 300 / 100 kg', () => {
    expect(s(allocate('100000.00', ['600.000', '300.000', '100.000']))).toEqual([
      '60000.00',
      '30000.00',
      '10000.00',
    ]);
  });

  it('BA.2 value basis: the 0.01 rounding difference lands on the largest line', () => {
    const parts = allocate('100000.00', ['168000.00', '54000.00', '9000.00']);
    expect(s(parts)).toEqual(['72727.28', '23376.62', '3896.10']);
    expect(sum(parts).toFixed(2)).toBe('100000.00');
  });

  it('BA.3 single output short-circuits', () => {
    expect(s(allocate('100000.00', ['1000.000']))).toEqual(['100000.00']);
  });

  it('always sums exactly, whatever the weights', () => {
    const parts = allocate('1000.00', ['1', '1', '1', '1', '1', '1', '1']);
    expect(sum(parts).toFixed(2)).toBe('1000.00');
  });

  it('refuses zero or negative weights', () => {
    expect(() => allocate('100', ['0', '0'])).toThrow('sum to zero');
    expect(() => allocate('100', ['5', '-1'])).toThrow('must not be negative');
  });
});

describe('splitInstalments (Spec P9 §11)', () => {
  it('ADV.1: 24,000.00 over 6 → six of 4,000.00', () => {
    expect(s(splitInstalments('24000.00', 6))).toEqual(Array(6).fill('4000.00'));
  });

  it('ADV.2: 10,000.00 over 3 → 3,333.33, 3,333.33, 3,333.34 (final adjusted)', () => {
    const parts = splitInstalments('10000.00', 3);
    expect(s(parts)).toEqual(['3333.33', '3333.33', '3333.34']);
    expect(sum(parts).toFixed(2)).toBe('10000.00');
  });
});

describe('zDecimal (request validation)', () => {
  const schema = z.object({
    quantity: zDecimal('qty', { positive: true }),
    rate: zDecimal('money', { max: '1000' }),
  });

  it('transforms valid strings to Dec', () => {
    const v = schema.parse({ quantity: '37.000', rate: '6.5000' });
    expect(v.quantity).toBeInstanceOf(Dec);
    expect(v.quantity.toFixed(3)).toBe('37.000');
  });

  it('rejects a JSON number, too many places, zero for positive, and out-of-range values', () => {
    const r = schema.safeParse({ quantity: 37, rate: '1000.0001' });
    expect(r.success).toBe(false);
    const msgs = r.error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('quantity: must be a decimal string'),
        expect.stringContaining('rate:'),
      ]),
    );
    expect(schema.safeParse({ quantity: '0.000', rate: '1' }).error?.issues[0]?.message).toBe(
      'must be greater than 0',
    );
  });
});
