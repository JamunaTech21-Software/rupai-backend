import { describe, expect, it } from 'vitest';

import { PERMISSION_KEYS } from '../../src/modules/identity/permission-catalogue.js';
import { COUNTRIES } from '../../src/modules/lookups/countries.js';
import { LOOKUP_TYPES } from '../../src/modules/lookups/lookup-types.js';
import { lookupSchemas } from '../../src/modules/lookups/lookup.engine.js';

/** P1.10: the lookup descriptors are consistent with each other and with the permission catalogue. */

describe('lookup types (P3 §5, §7.1)', () => {
  it('describes the 37 reference masters (25 of P3, amenity of R.2, 3 Field / Block lists of R.3, 4 person lists of P2.01, job grade of P2.02, trade category of P2.05, benefit type of P2.08, evaluation criteria of P2.10), each once, each at its own path', () => {
    expect(LOOKUP_TYPES).toHaveLength(37);
    expect(new Set(LOOKUP_TYPES.map((t) => t.key)).size).toBe(37);
    expect(new Set(LOOKUP_TYPES.map((t) => t.path)).size).toBe(37);
    const path = (key: string) => LOOKUP_TYPES.find((t) => t.key === key)?.path;
    expect([path('uom'), path('tea_type'), path('tea_grade'), path('shift')]).toEqual([
      '/uoms',
      '/tea-types',
      '/tea-grades',
      '/shifts',
    ]);
    expect(path('department')).toBe('/lookups/department');
  });

  it('guards every type with permissions that exist in the catalogue', () => {
    const keys = new Set(PERMISSION_KEYS);
    for (const t of LOOKUP_TYPES) {
      for (const action of ['view', 'create', 'edit', 'delete']) {
        expect(keys.has(`${t.permission}.${action}`), `${t.key}: ${t.permission}.${action}`).toBe(true);
      }
    }
  });

  it('has a unique key field, and never accepts a read-only field', () => {
    for (const t of LOOKUP_TYPES) {
      expect(
        t.fields.some((f) => f.name === t.keyField && f.required),
        t.key,
      ).toBe(true);
      const { create, patch } = lookupSchemas(t);
      for (const f of t.fields.filter((x) => x.readOnly)) {
        expect(patch.safeParse({ [f.name]: true }).success, `${t.key}.${f.name}`).toBe(false);
        expect(create.safeParse({ [f.name]: true }).success, `${t.key}.${f.name}`).toBe(false);
      }
    }
  });

  it('validates by field type: codes, enums, decimal strings, times', () => {
    const schema = (key: string) => {
      const type = LOOKUP_TYPES.find((t) => t.key === key);
      if (!type) throw new Error(key);
      return lookupSchemas(type);
    };
    expect(schema('department').create.safeParse({ code: 'FIELD', name: 'Field' }).success).toBe(true);
    expect(schema('department').create.safeParse({ code: 'has space', name: 'x' }).success).toBe(false);
    expect(schema('department').create.safeParse({ code: 'A', name: 'x', extra: 1 }).success).toBe(false);
    expect(
      schema('activity_type').create.safeParse({ code: 'A', name: 'x', cost_category: 'sales' }).success,
    ).toBe(false);
    expect(
      schema('shift').create.safeParse({ code: 'N', name: 'Night', start_time: '22:00', end_time: '06:00' })
        .success,
    ).toBe(true);
    expect(
      schema('shift').create.safeParse({ code: 'N', name: 'Night', start_time: '25:00', end_time: '06:00' })
        .success,
    ).toBe(false);
    expect(
      schema('uom').create.safeParse({
        uom_category_id: '1',
        code: 'kg',
        name: 'Kilogram',
        conversion_factor: 1000,
      }).success,
    ).toBe(false); // a number, not a decimal string
    expect(schema('currency').create.parse({ code: 'usd', name: 'US dollar' })).toMatchObject({
      code: 'USD',
    });
  });
});

describe('countries (P3 §31.1: ISO 3166)', () => {
  it('249 entries with unique, well-formed codes', () => {
    expect(COUNTRIES).toHaveLength(249);
    expect(new Set(COUNTRIES.map((c) => c[0])).size).toBe(249);
    expect(new Set(COUNTRIES.map((c) => c[1])).size).toBe(249);
    for (const [iso2, iso3, dialling, name] of COUNTRIES) {
      expect(iso2, name).toMatch(/^[A-Z]{2}$/);
      expect(iso3, name).toMatch(/^[A-Z]{3}$/);
      if (dialling !== null) expect(dialling, name).toMatch(/^\+[0-9]{1,4}$/);
      expect(name.length).toBeGreaterThan(2);
    }
    expect(COUNTRIES.find((c) => c[0] === 'BD')).toEqual(['BD', 'BGD', '+880', 'Bangladesh']);
  });
});
