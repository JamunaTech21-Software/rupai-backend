import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  ADMINISTRATOR_PERMISSIONS,
  BUSINESS_DECISION_ACTIONS,
  CLASS_ACTIONS,
  MODULES,
  PERMISSION_KEYS,
  PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  SPECIAL_ACTIONS,
} from '../../src/modules/identity/permission-catalogue.js';

describe('permission catalogue (P6 §3)', () => {
  it('has one entry per module.action, with no duplicates', () => {
    expect(PERMISSION_KEYS.size).toBe(PERMISSIONS.length);
    expect(new Set(MODULES.map((m) => m.key)).size).toBe(MODULES.length);
  });

  it('derives each module’s actions from its class (P6 Table 3.2), plus only the named special actions', () => {
    for (const mod of MODULES) {
      const actions = PERMISSIONS.filter((p) => p.module === mod.key).map((p) => p.action);
      expect(actions).toEqual([...CLASS_ACTIONS[mod.class], ...(mod.extra ?? [])]);
    }
    const special = PERMISSIONS.filter((p) => !(ACTIONS as readonly string[]).includes(p.action)).map(
      (p) => p.key,
    );
    expect(special.sort()).toEqual([
      'accounting_period.reopen',
      'device.register',
      'device.revoke',
      'receivable.write_off',
    ]);
    expect(SPECIAL_ACTIONS).toHaveLength(4);
  });

  it('keeps post separate from approve: post exists only on financial modules (P4 §4.4)', () => {
    const posting = new Set(PERMISSIONS.filter((p) => p.action === 'post').map((p) => p.moduleClass));
    expect([...posting]).toEqual(['financial']);
  });

  it('has every module and group of P6 Table 3.3', () => {
    expect(new Set(MODULES.map((m) => m.group)).size).toBe(21);
    for (const key of ['sale', 'payroll', 'journal', 'attendance', 'plucking', 'device', 'sync', 'report']) {
      expect(MODULES.some((m) => m.key === key)).toBe(true);
    }
  });

  it('marks every sensitive permission of P6 Table 10.1, and each one exists', () => {
    for (const key of SENSITIVE_PERMISSIONS) expect(PERMISSION_KEYS.has(key)).toBe(true);
    expect(PERMISSIONS.filter((p) => p.sensitive)).toHaveLength(SENSITIVE_PERMISSIONS.size);
  });
});

describe('Administrator permissions (P6 §5.5, §7.1)', () => {
  it('are all in the catalogue', () => {
    for (const key of ADMINISTRATOR_PERMISSIONS) expect(PERMISSION_KEYS.has(key)).toBe(true);
  });

  it('hold no business approve, reject or post', () => {
    const decisions = ADMINISTRATOR_PERMISSIONS.filter((k) =>
      BUSINESS_DECISION_ACTIONS.has(k.split('.')[1] as never),
    );
    expect(decisions).toEqual([]);
  });

  it('give no payroll or personal-data access', () => {
    const forbidden = ['payroll', 'person', 'employment', 'pf', 'gratuity', 'advance'];
    expect(ADMINISTRATOR_PERMISSIONS.filter((k) => forbidden.includes(k.split('.')[0] ?? ''))).toEqual([]);
  });

  it('administer users, roles, workflows and settings, and read the audit log', () => {
    for (const key of [
      'user.create',
      'user.edit',
      'role.edit',
      'workflow.edit',
      'system.edit',
      'audit.view',
    ]) {
      expect(ADMINISTRATOR_PERMISSIONS).toContain(key);
    }
  });
});
