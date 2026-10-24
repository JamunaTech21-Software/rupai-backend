import { describe, expect, it } from 'vitest';

import { dec, Dec } from '../../src/core/money/decimal.js';
import { toBase } from '../../src/core/posting/journal.js';
import { POSTABLE_SOURCES, postableSource, splitResolutionKey } from '../../src/core/posting/sources.js';
import { SEED_RULES } from '../../src/modules/accounting/posting-rules.seed.js';

/** P3.03: base-currency conversion and balance (D-3.03-8), resolution keys, and the seeded rule map. */

describe('base currency (D-3.03-8)', () => {
  const line = (side: 'debit' | 'credit', amount: string) => ({ side, amount: dec(amount) });

  it('converts at the rate, rounded to 4 places', () => {
    const r = toBase([line('debit', '100'), line('credit', '100')], new Dec('110.12345678'));
    expect(r.base.map((b) => b.toFixed(4))).toEqual(['11012.3457', '11012.3457']);
    expect(r.debit.equals(r.credit)).toBe(true);
  });

  it('puts a rounding difference on the largest line of the short side', () => {
    const r = toBase(
      [line('debit', '0.0001'), line('debit', '0.0001'), line('credit', '0.0002')],
      new Dec('0.5'),
    );
    // Each 0.0001 × 0.5 rounds up to 0.0001 (debit 0.0002); 0.0002 × 0.5 = 0.0001: one unit short on credit.
    expect(r.debit.equals(r.credit)).toBe(true);
    expect(r.credit.toFixed(4)).toBe('0.0002');
  });

  it('refuses unbalanced transaction amounts', () => {
    expect(() => toBase([line('debit', '100'), line('credit', '99.99')], new Dec(1))).toThrow(/differ/);
  });
});

describe('resolution keys', () => {
  it('splits a key into the document’s ref and the record’s account field', () => {
    expect(splitResolutionKey('material_category')).toEqual({ ref: 'material_category', field: null });
    expect(splitResolutionKey('asset_category:accumulated_account')).toEqual({
      ref: 'asset_category',
      field: 'accumulated_account',
    });
  });
});

describe('the seeded rule map (D-3.03-10)', () => {
  it('has 17 rules, each of a declared source and purpose, with a debit and a credit', () => {
    expect(SEED_RULES).toHaveLength(17);
    expect(new Set(SEED_RULES.map((r) => r.code)).size).toBe(17);
    for (const r of SEED_RULES) {
      const source = postableSource(r.source);
      expect(source, r.code).toBeDefined();
      expect(source?.purposes, r.code).toContain(r.purpose);
      expect(
        r.lines.some(([side]) => side === 'debit'),
        r.code,
      ).toBe(true);
      expect(
        r.lines.some(([side]) => side === 'credit'),
        r.code,
      ).toBe(true);
    }
  });

  it('uses only amounts, account fields and refs its source supplies', () => {
    for (const r of SEED_RULES) {
      const source = postableSource(r.source);
      if (!source) continue;
      for (const [, resolution, key, amount] of r.lines) {
        expect(
          source.amounts.map((a) => a.name),
          `${r.code} ${amount}`,
        ).toContain(amount);
        if (resolution === 'from_account_field') {
          expect(
            source.accountFields.map((a) => a.name),
            `${r.code} ${key}`,
          ).toContain(key);
        } else if (resolution !== 'fixed') {
          expect(
            source.refs.map((a) => a.name),
            `${r.code} ${key}`,
          ).toContain(splitResolutionKey(key).ref);
        }
      }
    }
  });

  it('declares every source once', () => {
    expect(new Set(POSTABLE_SOURCES.map((s) => s.key)).size).toBe(POSTABLE_SOURCES.length);
  });
});
