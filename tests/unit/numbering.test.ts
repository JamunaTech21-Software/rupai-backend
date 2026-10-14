import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../../src/config/env.js';
import { DOCUMENT_TYPES } from '../../src/core/numbering/document-types.js';
import { numberParts, renderNumber, type NumberFormatShape } from '../../src/core/numbering/numbering.js';
import { settingFromText, settingsCipher, settingToText } from '../../src/core/settings/settings.js';
import type { BusinessDate } from '../../src/core/time/dates.js';
import { TEST_ENV } from '../helpers/test-app.js';

/** P1.11: number rendering and scopes (P2 §6.5), and the settings cipher and types (P3 §28.6). */

const d = (s: string) => s as BusinessDate;
const format = (over: Partial<NumberFormatShape> = {}): NumberFormatShape => ({
  documentType: 'purchase_order',
  prefix: 'PO',
  includeFiscalYear: false,
  includeSeason: false,
  includeEstateCode: false,
  separator: '-',
  sequenceWidth: 5,
  resetFrequency: 'never',
  isGapless: false,
  ...over,
});
const ctx = {
  date: d('2026-10-13'),
  estateCode: 'DEMO-A',
  fiscalYearCode: 'FY2026-27',
  seasonCode: '2026-27',
};

describe('document numbers (P1 §15.2, P2 §6.5)', () => {
  it('prints prefix, the included components and a zero-padded sequence', () => {
    expect(renderNumber(format(), ctx, 42)).toBe('PO-00042');
    expect(renderNumber(format({ includeEstateCode: true, includeFiscalYear: true }), ctx, 42)).toBe(
      'PO-DEMO-A-FY2026-27-00042',
    );
    expect(renderNumber(format({ includeSeason: true, separator: '/', sequenceWidth: 3 }), ctx, 7n)).toBe(
      'PO/2026-27/007',
    );
    expect(renderNumber(format({ separator: '', sequenceWidth: 6 }), ctx, 123)).toBe('PO000123');
    expect(renderNumber(format({ sequenceWidth: 3 }), ctx, 12345)).toBe('PO-12345'); // never truncated
  });

  it('a sequence counts within its scope: estate, fiscal year, season and the reset period', () => {
    expect(numberParts(format(), ctx).scopeKey).toBe('*');
    expect(numberParts(format({ includeEstateCode: true, includeFiscalYear: true }), ctx).scopeKey).toBe(
      'E:DEMO-A|FY:FY2026-27',
    );
    expect(numberParts(format({ resetFrequency: 'yearly' }), ctx)).toEqual({
      scopeKey: 'Y:2026',
      segments: ['PO', '2026'],
    });
    expect(numberParts(format({ resetFrequency: 'monthly' }), ctx)).toEqual({
      scopeKey: 'M:2026-10',
      segments: ['PO', '202610'],
    });
    // A fiscal year in the number already restarts it each year: no calendar year is added.
    expect(numberParts(format({ resetFrequency: 'yearly', includeFiscalYear: true }), ctx).scopeKey).toBe(
      'FY:FY2026-27',
    );
  });

  it('every part of the scope is printed, so numbers of one type never collide across scopes', () => {
    const variants: Partial<NumberFormatShape>[] = [
      {},
      { includeEstateCode: true },
      { includeFiscalYear: true },
      { includeSeason: true, includeEstateCode: true },
      { resetFrequency: 'yearly' },
      { resetFrequency: 'monthly', includeEstateCode: true },
    ];
    const contexts = [
      ctx,
      { ...ctx, estateCode: 'DEMO-B' },
      { ...ctx, fiscalYearCode: 'FY2027-28', seasonCode: '2027-28', date: d('2027-11-02') },
    ];
    for (const v of variants) {
      const seen = new Map<string, string>();
      for (const c of contexts) {
        const scope = numberParts(format(v), c).scopeKey;
        const printed = renderNumber(format(v), c, 1);
        expect(seen.get(printed) ?? scope, JSON.stringify(v)).toBe(scope); // same print ⇒ same scope
        seen.set(printed, scope);
      }
    }
  });

  it('refuses to number a document that cannot supply a component its format includes', () => {
    expect(() => renderNumber(format({ includeEstateCode: true }), { date: d('2026-10-13') }, 1)).toThrow(
      /estate code/,
    );
    expect(() =>
      renderNumber(format({ includeSeason: true }), { date: d('2026-10-13'), seasonCode: null }, 1),
    ).toThrow(/season/);
  });

  it('knows every numbered document once, with a unique prefix; financial ones can carry the fiscal year', () => {
    expect(new Set(DOCUMENT_TYPES.map((t) => t.key)).size).toBe(DOCUMENT_TYPES.length);
    expect(new Set(DOCUMENT_TYPES.map((t) => t.prefix)).size).toBe(DOCUMENT_TYPES.length);
    for (const t of DOCUMENT_TYPES.filter((x) => x.lifecycle === 'financial')) {
      expect(t.components, t.key).toContain('fiscal_year');
    }
    expect(DOCUMENT_TYPES.find((t) => t.key === 'journal')).toMatchObject({
      lifecycle: 'financial',
      prefix: 'JV',
    });
  });
});

describe('system settings (P3 §28.6)', () => {
  it('encrypts with a random nonce and refuses a tampered value or the wrong key', () => {
    const cipher = settingsCipher('a-settings-key-of-at-least-32-characters');
    if (!cipher) throw new Error('cipher expected');
    const a = cipher.encrypt('smtp-password');
    const b = cipher.encrypt('smtp-password');
    expect(a).toMatch(/^enc:v1:/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('smtp-password');
    expect(cipher.decrypt(a)).toBe('smtp-password');
    const tampered = `${a.slice(0, -4)}AAAA`;
    expect(() => cipher.decrypt(tampered)).toThrow();
    expect(() => settingsCipher('another-settings-key-of-32-characters!!')?.decrypt(a)).toThrow();
    expect(settingsCipher(null)).toBeNull();
  });

  it('stores values as text by type, and never accepts a float for a decimal', () => {
    expect(settingToText('integer', 15)).toEqual({ text: '15' });
    expect(settingToText('integer', '15')).toHaveProperty('error');
    expect(settingToText('integer', 1.5)).toHaveProperty('error');
    expect(settingToText('decimal', '12.50')).toEqual({ text: '12.50' });
    expect(settingToText('decimal', 12.5)).toHaveProperty('error');
    expect(settingToText('boolean', true)).toEqual({ text: 'true' });
    expect(settingToText('boolean', 'true')).toHaveProperty('error');
    expect(settingToText('json', { a: [1, 2] })).toEqual({ text: '{"a":[1,2]}' });
    expect(settingToText('string', null)).toEqual({ text: null });
    expect(settingFromText('integer', '15')).toBe(15);
    expect(settingFromText('decimal', '12.50')).toBe('12.50');
    expect(settingFromText('boolean', 'false')).toBe(false);
    expect(settingFromText('json', '{"a":[1,2]}')).toEqual({ a: [1, 2] });
  });

  it('the encryption key is optional outside production, required in it, and never the token secret', () => {
    expect(loadConfig(TEST_ENV).settings.encryptionKey).toBeNull();
    expect(loadConfig({ ...TEST_ENV, SETTINGS_ENCRYPTION_KEY: '' }).settings.encryptionKey).toBeNull();
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig({ ...TEST_ENV, ...env });
      } catch (err) {
        if (err instanceof ConfigError) return err.problems.join('\n');
        throw err;
      }
      return '';
    };
    expect(problems({ SETTINGS_ENCRYPTION_KEY: 'short' })).toContain('SETTINGS_ENCRYPTION_KEY');
    expect(problems({ SETTINGS_ENCRYPTION_KEY: TEST_ENV.AUTH_TOKEN_SECRET })).toContain(
      'must differ from AUTH_TOKEN_SECRET',
    );
    expect(problems({ APP_ENV: 'production' })).toContain(
      'SETTINGS_ENCRYPTION_KEY is required in production',
    );
  });
});
