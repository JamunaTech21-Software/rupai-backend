import { describe, expect, it } from 'vitest';

import { buildTree } from '../../src/modules/accounting/accounts.service.js';
import type { AccountOutT } from '../../src/modules/accounting/accounts.schema.js';
import {
  normalBalanceOf,
  oppositeBalance,
  P8_CHART,
  pathOf,
  resolveChart,
  shapeErrors,
  subtreeHeight,
  type AccountShape,
} from '../../src/modules/accounting/chart.js';

/** P3.01: the chart's pure rules and the P8 seed table (D-3.01-1 to D-3.01-10). */

const chart = resolveChart(P8_CHART);
const byCode = new Map(chart.map((a) => [a.code, a]));
const at = (code: string) => {
  const a = byCode.get(code);
  if (!a) throw new Error(`no ${code}`);
  return a;
};

describe('the P8 seed chart', () => {
  it('has 199 accounts: 169 postable, 30 groups, 13 top-level', () => {
    expect(chart).toHaveLength(199);
    expect(chart.filter((a) => a.is_postable)).toHaveLength(169);
    expect(chart.filter((a) => a.parent === null).map((a) => a.code)).toEqual([
      '1000',
      '2000',
      '3000',
      '4000',
      '5000',
      '6000',
      '7100',
      '7200',
      '7300',
      '9100',
      '9200',
      '9300',
      '9900',
    ]);
  });

  it('keeps every account within four levels, under a group of its own type', () => {
    for (const a of chart) {
      expect(a.level).toBeGreaterThanOrEqual(1);
      expect(a.level).toBeLessThanOrEqual(4);
      if (a.parent === null) continue;
      const parent = at(a.parent);
      expect(parent.is_postable, a.code).toBe(false);
      expect(parent.account_type, a.code).toBe(a.account_type);
      expect(a.level).toBe(parent.level + 1);
    }
    expect(at('1111').level).toBe(4);
  });

  it('marks the control accounts with their sub-ledgers (P8 §2.4, §3.3)', () => {
    const control = chart.filter((a) => a.is_control_account);
    expect(control.map((a) => a.code)).toEqual([
      '1210',
      '1215',
      '1220',
      '1310',
      '1320',
      '1325',
      '1330',
      '1335',
      '1340',
      '1345',
      '1350',
      '1360',
      '2110',
      '2115',
      '2210',
      '2220',
    ]);
    expect(at('1220').control_subledger).toBe('advance');
    expect(at('2220').control_subledger).toBe('pf_liability');
  });

  it('gives each system account a unique key, and the 9000 series is clearing', () => {
    const keys = chart.flatMap((a) => (a.system_key ? [a.system_key] : []));
    expect(keys).toHaveLength(23);
    expect(new Set(keys).size).toBe(keys.length);
    expect(at('3400').system_key).toBe('current_year_result');
    expect(chart.filter((a) => a.is_clearing).map((a) => a.code)).toEqual([
      '1119',
      '9100',
      '9200',
      '9300',
      '9900',
    ]);
  });

  it('derives normal balances from the type, opposite for contra accounts (D-3.01-6)', () => {
    expect(at('1111').normal_balance).toBe('debit');
    expect(at('2110').normal_balance).toBe('credit');
    expect(at('1240').normal_balance).toBe('credit');
    expect(at('1583').normal_balance).toBe('credit');
    expect(at('4140').normal_balance).toBe('debit');
    expect(at('5230').normal_balance).toBe('credit');
    expect(at('3600').normal_balance).toBe('debit');
  });

  it('requires a cost centre on every postable expense account (P8 §3.4) and inherits subtypes', () => {
    for (const a of chart) {
      expect(a.requires_cost_centre, a.code).toBe(a.is_postable && a.account_type === 'expense');
    }
    expect(at('5110').account_subtype).toBe('direct_expense');
    expect(at('6210').account_subtype).toBe('operating_expense');
    expect(at('7210').account_subtype).toBe('financing');
    expect(at('2510').account_subtype).toBe('long_term_liability');
    expect(at('3100').account_subtype).toBeNull();
  });

  it('refuses an inconsistent table', () => {
    expect(() => resolveChart([{ code: '1', name: 'x', parent: null }])).toThrow(/has no type/);
    expect(() =>
      resolveChart([
        { code: '1', name: 'a', parent: null, type: 'asset' },
        { code: '2', name: 'b', parent: '1' },
      ]),
    ).toThrow(/postable/);
  });
});

describe('account rules', () => {
  const shape = (over: Partial<AccountShape>): AccountShape => ({
    account_type: 'asset',
    account_subtype: null,
    is_postable: true,
    is_control_account: false,
    control_subledger: null,
    is_bank_or_cash: false,
    currency_id: null,
    ...over,
  });
  const fields = (s: AccountShape) => shapeErrors(s).map((e) => e.field);

  it('accepts a plain account', () => {
    expect(shapeErrors(shape({}))).toEqual([]);
  });

  it('keeps the subtype within the type', () => {
    expect(fields(shape({ account_subtype: 'operating_revenue' }))).toEqual(['account_subtype']);
    expect(fields(shape({ account_type: 'equity', account_subtype: 'current_asset' }))).toEqual([
      'account_subtype',
    ]);
    expect(fields(shape({ account_type: 'expense', account_subtype: 'financing' }))).toEqual([]);
  });

  it('wants a control account postable and naming its sub-ledger', () => {
    expect(fields(shape({ is_control_account: true }))).toEqual(['control_subledger']);
    expect(fields(shape({ control_subledger: 'payable' }))).toEqual(['control_subledger']);
    expect(
      fields(shape({ is_control_account: true, control_subledger: 'receivable', is_postable: false })),
    ).toEqual(['is_control_account']);
  });

  it('keeps cash, bank and currency on postable asset accounts', () => {
    expect(fields(shape({ is_bank_or_cash: true, account_type: 'expense' }))).toEqual(['is_bank_or_cash']);
    expect(fields(shape({ currency_id: '2' }))).toEqual(['currency_id']);
    expect(fields(shape({ is_bank_or_cash: true, currency_id: '2' }))).toEqual([]);
  });

  it('balances, paths and heights', () => {
    expect(normalBalanceOf('asset')).toBe('debit');
    expect(normalBalanceOf('expense')).toBe('debit');
    expect(normalBalanceOf('liability')).toBe('credit');
    expect(normalBalanceOf('revenue')).toBe('credit');
    expect(normalBalanceOf('equity')).toBe('credit');
    expect(oppositeBalance('debit')).toBe('credit');
    expect(pathOf(null, 7n)).toBe('/7/');
    expect(pathOf('/1/5/', 12n)).toBe('/1/5/12/');
    expect(subtreeHeight(2, 2)).toBe(1);
    expect(subtreeHeight(2, 4)).toBe(3);
  });

  it('nests a flat chart, siblings in numeric code order', () => {
    const a = (id: string, code: string, parent: string | null) =>
      ({ id, code, parent_id: parent }) as unknown as AccountOutT;
    const tree = buildTree([
      a('3', '1110', '1'),
      a('1', '1000', null),
      a('2', '1100', '1'),
      a('4', '200', null),
    ]);
    expect(tree.map((n) => n.code)).toEqual(['200', '1000']);
    expect(tree[1]?.children.map((n) => n.code)).toEqual(['1100', '1110']);
  });
});
