import { describe, expect, it } from 'vitest';

import {
  ADMINISTRATOR_PERMISSIONS,
  PERMISSION_KEYS,
  SENSITIVE_PERMISSIONS,
} from '../../src/modules/identity/permission-catalogue.js';
import {
  requirementKey,
  requirementsFor,
  SENSITIVE_WHY,
  SOD_RULES,
} from '../../src/modules/identity/sod-rules.js';

describe('separation-of-duties rules (P6 Table 5.1)', () => {
  it('has the seven rules of Table 5.1, each with at least one combination', () => {
    expect(SOD_RULES.map((r) => r.code)).toEqual([
      'SOD-1',
      'SOD-2',
      'SOD-3',
      'SOD-4',
      'SOD-5',
      'SOD-6',
      'SOD-7',
    ]);
    for (const r of SOD_RULES) expect(r.combinations.length, r.code).toBeGreaterThan(0);
  });

  it('names only permissions that exist in the catalogue', () => {
    for (const r of SOD_RULES) {
      for (const combo of r.combinations) {
        for (const p of combo) expect(PERMISSION_KEYS.has(p), `${r.code}: ${p}`).toBe(true);
      }
    }
  });

  it('covers create+approve and approve+post on every document type that has both', () => {
    const sod1 = SOD_RULES[0]?.combinations.map((c) => c.join('+')) ?? [];
    const sod2 = SOD_RULES[1]?.combinations.map((c) => c.join('+')) ?? [];
    expect(sod1).toContain('payroll.create+payroll.approve');
    expect(sod1).toContain('sale.create+sale.approve');
    expect(sod2).toContain('payroll.approve+payroll.post');
    expect(sod2).toContain('journal.approve+journal.post');
  });

  it('P6 Fig 9.1: Payroll Clerk + Finance Manager raises payroll.create + payroll.approve', () => {
    const payrollClerk = ['payroll.view', 'payroll.create', 'payroll.edit', 'payroll.submit'];
    const financeManager = ['payroll.view', 'payroll.approve', 'journal.view'];
    const reqs = requirementsFor(new Set([...payrollClerk, ...financeManager]));
    expect(reqs.map((r) => r.key)).toContain('SOD-1:payroll.approve+payroll.create');
    expect(reqs.find((r) => r.rule === 'SOD-1')?.title).toBe('Create and approve on the same document type');
    // Neither role alone is a conflict: it is the union that matters (P6 §9.1).
    expect(requirementsFor(new Set(payrollClerk)).filter((r) => r.kind === 'sod_override')).toEqual([]);
    expect(requirementsFor(new Set(financeManager)).filter((r) => r.kind === 'sod_override')).toEqual([]);
  });

  it('SOD-4: user or role administration with any financial approve or post', () => {
    const keys = requirementsFor(new Set(['user.edit', 'payment.approve'])).map((r) => r.key);
    expect(keys).toContain('SOD-4:payment.approve+user.edit');
  });

  it('SOD-5 needs all three permissions together', () => {
    const two = requirementsFor(new Set(['stock_adjustment.approve', 'inventory.export']));
    expect(two.some((r) => r.rule === 'SOD-5')).toBe(false);
    const three = requirementsFor(new Set(['stock_adjustment.approve', 'inventory.export', 'sale.create']));
    expect(three.some((r) => r.rule === 'SOD-5')).toBe(true);
  });

  it('keys are stable whatever the order of the permissions', () => {
    expect(requirementKey('SOD-6', ['supplier.edit', 'payment.approve'])).toBe(
      requirementKey('SOD-6', ['payment.approve', 'supplier.edit']),
    );
  });
});

describe('sensitive permissions (P6 Table 10.1)', () => {
  it('every sensitive permission exists and says why', () => {
    for (const p of SENSITIVE_PERMISSIONS) {
      expect(PERMISSION_KEYS.has(p), p).toBe(true);
      expect(SENSITIVE_WHY[p], p).toBeTruthy();
    }
  });

  it('each one held is a requirement of its own', () => {
    expect(requirementsFor(new Set(['payroll.export', 'payroll.view'])).map((r) => r.key)).toEqual([
      'SENSITIVE:payroll.export',
    ]);
  });

  it('the Administrator role has no prohibited combination, only its four sensitive permissions', () => {
    const reqs = requirementsFor(new Set(ADMINISTRATOR_PERMISSIONS));
    expect(reqs.filter((r) => r.kind === 'sod_override')).toEqual([]);
    expect(reqs.map((r) => r.key)).toEqual([
      'SENSITIVE:audit.view',
      'SENSITIVE:device.revoke',
      'SENSITIVE:role.edit',
      'SENSITIVE:user.edit',
    ]);
  });
});
