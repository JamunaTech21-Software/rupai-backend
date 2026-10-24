import type { Seeder } from '../../core/db/seed.js';
import type { AccountResolution, PostingPurpose, Side } from '../../core/posting/sources.js';
import { parseBusinessDate, businessDateToDb } from '../../core/time/dates.js';
import { BOOTSTRAP_ADMIN_ID } from '../identity/identity.seed.js';
import { POSTING_RULE_AUDIT } from './posting-rules.service.js';

/**
 * The indicative posting map of P1 Table 7.2, with P8 §14's accounts (P3 §31.2, D-3.03-10). INACTIVE: the
 * accountant reviews every line before a rule is activated (P8 §5.4).
 *
 * Loaded once, into an empty table, like the chart: afterwards the rules are the client's. A rule whose
 * fixed account is missing from the chart (the estate replaced it) is skipped and logged in the result.
 */

type L = readonly [Side, AccountResolution, string, string];
const fixed = (side: Side, code: string, amount: string): L => [side, 'fixed', code, amount];
const field = (side: Side, key: string, amount: string): L => [side, 'from_account_field', key, amount];
const component = (side: Side, key: string, amount: string): L => [side, 'from_component', key, amount];
const category = (side: Side, key: string, amount: string): L => [side, 'from_category', key, amount];
const charge = (side: Side, key: string, amount: string): L => [side, 'from_charge_type', key, amount];

interface SeedRule {
  readonly code: string;
  readonly name: string;
  readonly source: string;
  readonly purpose: PostingPurpose;
  readonly lines: readonly L[];
}
const rule = (
  code: string,
  name: string,
  source: string,
  purpose: PostingPurpose,
  lines: readonly L[],
): SeedRule => ({
  code,
  name,
  source,
  purpose,
  lines,
});

export const SEED_RULES: readonly SeedRule[] = [
  rule('SALE-REVENUE', 'Tea sale — revenue, VAT and charges (P8 §14.3)', 'sale', 'revenue', [
    fixed('debit', '1210', 'receivable'),
    field('credit', 'revenue_account', 'revenue'),
    fixed('credit', '2310', 'vat'),
    charge('debit', 'charge_type', 'charges'),
    fixed('credit', '1210', 'charges'),
  ]),
  rule('SALE-COGS', 'Tea sale — cost of goods sold (P8 §14.3)', 'sale', 'cost_of_goods_sold', [
    fixed('debit', '5010', 'cost'),
    fixed('credit', '1320', 'cost'),
  ]),
  rule('COLLECTION', 'Collection received (P8 §14.3)', 'collection', 'receivable', [
    field('debit', 'bank_account', 'amount'),
    fixed('credit', '1210', 'amount'),
  ]),
  rule('LEASE-DUE', 'Lease instalment due (P8 §14.3)', 'lease_schedule', 'receivable', [
    fixed('debit', '1215', 'amount'),
    fixed('credit', '4210', 'amount'),
  ]),
  rule('LEAF-PURCHASE', 'Green leaf purchase (P8 §14.1)', 'leaf_purchase', 'inventory_in', [
    fixed('debit', '1310', 'value'),
    fixed('credit', '2115', 'value'),
  ]),
  rule(
    'PRODUCTION',
    'Production batch — leaf consumed, conversion absorbed (P8 §14.2)',
    'production_batch',
    'inventory_in',
    [
      fixed('debit', '1320', 'output_value'),
      fixed('credit', '1310', 'leaf_value'),
      field('credit', 'absorbed_account', 'conversion_cost'),
    ],
  ),
  rule('GOODS-RECEIPT', 'Goods receipt — stocked material (P8 §14.5)', 'goods_receipt', 'inventory_in', [
    category('debit', 'material_category', 'value'),
    fixed('credit', '2120', 'value'),
  ]),
  rule(
    'SUPPLIER-INVOICE',
    'Supplier invoice — matched, direct expense, VAT, withholding (P8 §14.5)',
    'supplier_invoice',
    'payable',
    [
      fixed('debit', '2120', 'matched'),
      field('debit', 'expense_account', 'expense'),
      fixed('debit', '2315', 'input_vat'),
      fixed('credit', '2110', 'payable'),
      fixed('debit', '2110', 'withholding'),
      fixed('credit', '2325', 'withholding'),
    ],
  ),
  rule('PAYMENT', 'Payment made (P8 §14.5, §14.4)', 'payment', 'payable', [
    field('debit', 'payable_account', 'amount'),
    field('credit', 'bank_account', 'amount'),
  ]),
  rule(
    'PAYROLL-EXPENSE',
    'Payroll run — earnings by component and cost centre (P8 §14.4)',
    'payroll_run',
    'payroll_expense',
    [component('debit', 'component', 'earnings'), fixed('credit', '2210', 'gross')],
  ),
  rule(
    'PAYROLL-DEDUCTIONS',
    'Payroll run — deductions from pay (P8 §14.4)',
    'payroll_run',
    'payroll_liability',
    [
      fixed('debit', '2210', 'pf_employee'),
      fixed('credit', '2220', 'pf_employee'),
      fixed('debit', '2210', 'tax'),
      fixed('credit', '2235', 'tax'),
      fixed('debit', '2210', 'advance'),
      fixed('credit', '1220', 'advance'),
      fixed('debit', '2210', 'other_deductions'),
      fixed('credit', '2240', 'other_deductions'),
    ],
  ),
  rule(
    'PAYROLL-PF-EMPLOYER',
    'Payroll run — employer provident fund (P8 §14.4)',
    'payroll_run',
    'pf_liability',
    [fixed('debit', '6125', 'pf_employer'), fixed('credit', '2225', 'pf_employer')],
  ),
  rule('ADVANCE', 'Employee advance disbursed (P8 §14.4)', 'advance', 'receivable', [
    fixed('debit', '1220', 'amount'),
    field('credit', 'bank_account', 'amount'),
  ]),
  rule('GRATUITY', 'Gratuity accrued (P8 §14.4)', 'gratuity_accrual', 'expense', [
    fixed('debit', '6130', 'amount'),
    fixed('credit', '2230', 'amount'),
  ]),
  rule('DEPRECIATION', 'Depreciation run (P8 §14.7)', 'depreciation_run', 'depreciation', [
    field('debit', 'expense_account', 'amount'),
    category('credit', 'asset_category:accumulated_account', 'amount'),
  ]),
  rule('STOCK-ADJUSTMENT', 'Stock count shortage or surplus (P8 §14.6)', 'stock_adjustment', 'variance', [
    fixed('debit', '5090', 'loss'),
    category('credit', 'material_category', 'loss'),
    category('debit', 'material_category', 'gain'),
    fixed('credit', '5090', 'gain'),
  ]),
  rule('ASSET-DISPOSAL', 'Asset disposal (P8 §14.7)', 'asset_disposal', 'disposal', [
    field('debit', 'bank_account', 'proceeds'),
    category('debit', 'asset_category:accumulated_account', 'accumulated'),
    fixed('debit', '7220', 'loss'),
    category('credit', 'asset_category:cost_account', 'cost'),
    fixed('credit', '7120', 'gain'),
  ]),
];

const SEED_EFFECTIVE_FROM = parseBusinessDate('2020-01-01');

export const postingRuleSeeder: Seeder = {
  name: 'accounting: the indicative posting rules, inactive (once, into an empty table)',
  async run(tx) {
    if ((await tx.postingRule.count()) > 0) return { inserted: 0, updated: 0 };
    let inserted = 0;
    for (const r of SEED_RULES) {
      const codes = r.lines.flatMap(([, res, key]) => (res === 'fixed' ? [key] : []));
      const accounts = new Map(
        (await tx.account.findMany({ where: { code: { in: codes } }, select: { id: true, code: true } })).map(
          (a) => [a.code, a.id],
        ),
      );
      if (codes.some((c) => !accounts.has(c))) continue;
      const created = await tx.postingRule.create({
        data: {
          ruleCode: r.code,
          name: r.name,
          description:
            'Seeded from P1 Table 7.2 and P8 §14. Inactive until the accountant reviews and activates it.',
          sourceType: r.source,
          purpose: r.purpose,
          conditionJson: [],
          effectiveFrom: businessDateToDb(SEED_EFFECTIVE_FROM),
          createdBy: BOOTSTRAP_ADMIN_ID,
          lines: {
            create: r.lines.map(([side, res, key, amount], i) => ({
              side,
              accountResolution: res,
              accountId: res === 'fixed' ? (accounts.get(key) ?? null) : null,
              resolutionKey: res === 'fixed' ? null : key,
              amountSource: amount,
              sequence: i + 1,
              createdBy: BOOTSTRAP_ADMIN_ID,
            })),
          },
        },
        select: { id: true },
      });
      await tx.statusHistory.create({
        data: {
          recordType: POSTING_RULE_AUDIT.type,
          recordId: created.id.toString(),
          fromState: null,
          toState: 'inactive',
          changedBy: BOOTSTRAP_ADMIN_ID,
          comment: 'Seeded; inactive until the accountant activates it',
        },
      });
      inserted += 1;
    }
    return { inserted, updated: 0 };
  },
};
