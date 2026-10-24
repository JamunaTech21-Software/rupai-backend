/**
 * The chart of accounts' rules that need no database (P3 §27.1, P8 §2–§4), and the P8 proposed chart the
 * seed loads (P8 §6–§13, D-3.01-1). Everything here is policy the client accountant corrects before
 * sign-off (P8 §1.1): the seed ships INACTIVE (P3 §31.3).
 */

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_SUBTYPES = [
  'current_asset',
  'fixed_asset',
  'current_liability',
  'long_term_liability',
  'operating_revenue',
  'other_revenue',
  'direct_expense',
  'operating_expense',
  'financing',
] as const;
export type AccountSubtype = (typeof ACCOUNT_SUBTYPES)[number];

export const CONTROL_SUBLEDGERS = [
  'receivable',
  'payable',
  'inventory',
  'payroll_liability',
  'pf_liability',
  'advance',
] as const;
export type ControlSubledger = (typeof CONTROL_SUBLEDGERS)[number];

export const NORMAL_BALANCES = ['debit', 'credit'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** P8 §4.2: "Four levels is a deliberate ceiling" (D-3.01-3). */
export const MAX_ACCOUNT_LEVEL = 4;

/** D-3.01-10: which subtypes belong to which type. Equity has none. */
export const SUBTYPES_OF: Readonly<Record<AccountType, readonly AccountSubtype[]>> = {
  asset: ['current_asset', 'fixed_asset'],
  liability: ['current_liability', 'long_term_liability'],
  equity: [],
  revenue: ['operating_revenue', 'other_revenue'],
  expense: ['direct_expense', 'operating_expense', 'financing'],
};

/** P3 §27.1 "derived from account_type on creation" (D-3.01-6). */
export function normalBalanceOf(type: AccountType): NormalBalance {
  return type === 'asset' || type === 'expense' ? 'debit' : 'credit';
}

export function oppositeBalance(b: NormalBalance): NormalBalance {
  return b === 'debit' ? 'credit' : 'debit';
}

/** The materialised path of a node: its ancestors' ids then its own, "/1/5/12/" (P3 §27.1). */
export function pathOf(parentPath: string | null, id: bigint): string {
  return `${parentPath ?? '/'}${id.toString()}/`;
}

/** How many levels a subtree spans, from its node's level and its deepest descendant's (1 for a leaf). */
export function subtreeHeight(nodeLevel: number, deepestLevel: number): number {
  return deepestLevel - nodeLevel + 1;
}

/** The flags of one account as the rules see them. */
export interface AccountShape {
  readonly account_type: AccountType;
  readonly account_subtype: AccountSubtype | null;
  readonly is_postable: boolean;
  readonly is_control_account: boolean;
  readonly control_subledger: ControlSubledger | null;
  readonly is_bank_or_cash: boolean;
  readonly currency_id: string | bigint | null;
}

/**
 * The row-level rules (the migration's CHECKs, D-3.01-7, D-3.01-10), as field errors for the API:
 * subtype within the type, control accounts postable with a sub-ledger, cash and bank postable assets,
 * a currency only on those.
 */
export function shapeErrors(a: AccountShape): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (a.account_subtype !== null && !SUBTYPES_OF[a.account_type].includes(a.account_subtype)) {
    errors.push({
      field: 'account_subtype',
      message:
        a.account_type === 'equity'
          ? 'An equity account has no subtype.'
          : `Must be one of ${SUBTYPES_OF[a.account_type].join(', ')} for a ${a.account_type} account.`,
    });
  }
  if (a.is_control_account !== (a.control_subledger !== null)) {
    errors.push({
      field: 'control_subledger',
      message: a.is_control_account
        ? 'A control account names the sub-ledger it agrees to.'
        : 'Only a control account has a sub-ledger.',
    });
  }
  if (a.is_control_account && !a.is_postable) {
    errors.push({ field: 'is_control_account', message: 'A control account must be postable.' });
  }
  if (a.is_bank_or_cash && !(a.is_postable && a.account_type === 'asset')) {
    errors.push({ field: 'is_bank_or_cash', message: 'Cash and bank accounts are postable asset accounts.' });
  }
  if (a.currency_id !== null && !a.is_bank_or_cash) {
    errors.push({ field: 'currency_id', message: 'Only a cash or bank account has its own currency.' });
  }
  return errors;
}

// ---- the P8 proposed chart ---------------------------------------------------------------------------

/**
 * One seeded account. Type and subtype are inherited from the parent unless given; top-level accounts
 * give their type. Flags:
 *   G   group (not postable)              B  cash or bank             E  requires an estate
 *   X   contra (opposite normal balance)  L  clearing (nil at close)
 *   C:<sub-ledger>  control account       K:<key>  system account reached by key (D-3.01-4)
 * Every postable expense account requires a cost centre (P8 §3.4).
 */
export interface ChartRow {
  readonly code: string;
  readonly name: string;
  readonly parent: string | null;
  readonly flags?: string;
  readonly type?: AccountType;
  readonly subtype?: AccountSubtype | null;
}

const r = (
  code: string,
  name: string,
  parent: string | null,
  flags = '',
  over: { type?: AccountType; subtype?: AccountSubtype | null } = {},
): ChartRow => ({ code, name, parent, flags, ...over });

/** P8 §6–§13 with the class groups of D-3.01-2. 199 accounts. */
export const P8_CHART: readonly ChartRow[] = [
  // ---- 1000 Assets (P8 §6) ----
  r('1000', 'Assets', null, 'G', { type: 'asset' }),
  r('1100', 'Current Assets', '1000', 'G', { subtype: 'current_asset' }),
  r('1110', 'Cash and Bank', '1100', 'G'),
  r('1111', 'Cash in Hand — Head Office', '1110', 'B'),
  r('1112', 'Cash in Hand — Estate', '1110', 'B E'),
  r('1115', 'Bank — Operating Account', '1110', 'B'),
  r('1116', 'Bank — Collection Account', '1110', 'B'),
  r('1117', 'Bank — Payroll Account', '1110', 'B'),
  r('1118', 'Bank — Foreign Currency', '1110', 'B'),
  r('1119', 'Cash in Transit', '1110', 'B L'),
  r('1200', 'Receivables', '1100', 'G'),
  r('1210', 'Accounts Receivable — Tea Sales', '1200', 'C:receivable K:ar_tea_sales'),
  r('1215', 'Accounts Receivable — Lease and Other', '1200', 'C:receivable K:ar_lease_other'),
  r('1220', 'Employee Advances', '1200', 'C:advance K:employee_advances'),
  r('1225', 'Advances to Suppliers', '1200'),
  r('1230', 'Other Receivables', '1200'),
  r('1240', 'Provision for Doubtful Debts', '1200', 'X'),
  r('1300', 'Inventory', '1100', 'G'),
  r('1310', 'Green Leaf Inventory', '1300', 'C:inventory E K:inv_green_leaf'),
  r('1320', 'Made Tea Inventory', '1300', 'C:inventory E K:inv_made_tea'),
  r('1325', 'Made Tea in Transit', '1300', 'C:inventory K:inv_made_tea_in_transit'),
  r('1330', 'Raw Materials and Consumables', '1300', 'C:inventory K:inv_raw_materials'),
  r('1335', 'Packaging Materials', '1300', 'C:inventory K:inv_packaging'),
  r('1340', 'Fuel and Lubricants', '1300', 'C:inventory K:inv_fuel'),
  r('1345', 'Fertiliser and Agrochemicals', '1300', 'C:inventory K:inv_fertiliser'),
  r('1350', 'Spares and Maintenance Materials', '1300', 'C:inventory K:inv_spares'),
  r('1360', 'Goods in Transit', '1300', 'C:inventory K:inv_goods_in_transit'),
  r('1390', 'Inventory Provision', '1300', 'X'),
  r('1500', 'Fixed Assets', '1000', 'G', { subtype: 'fixed_asset' }),
  r('1510', 'Land', '1500'),
  r('1515', 'Tea Plantation — Development Cost', '1500'),
  r('1520', 'Buildings and Structures', '1500'),
  r('1525', 'Factory Building', '1500'),
  r('1530', 'Plant and Machinery', '1500'),
  r('1535', 'Vehicles', '1500'),
  r('1540', 'Furniture and Fixtures', '1500'),
  r('1545', 'Office and IT Equipment', '1500'),
  r('1550', 'Capital Work in Progress', '1500'),
  r('1580', 'Accumulated Depreciation', '1500', 'G'),
  r('1581', 'Acc. Dep. — Buildings', '1580', 'X'),
  r('1582', 'Acc. Dep. — Factory Building', '1580', 'X'),
  r('1583', 'Acc. Dep. — Plant and Machinery', '1580', 'X'),
  r('1584', 'Acc. Dep. — Vehicles', '1580', 'X'),
  r('1585', 'Acc. Dep. — Furniture and Fixtures', '1580', 'X'),
  r('1586', 'Acc. Dep. — Office and IT Equipment', '1580', 'X'),
  // 1620 and 1640 are non-current, but P3 has no such subtype: flagged for the accountant (D-3.01-10).
  r('1600', 'Other Assets', '1000', 'G', { subtype: 'current_asset' }),
  r('1610', 'Prepaid Expenses', '1600'),
  r('1620', 'Security Deposits Paid', '1600'),
  r('1630', 'Advance Income Tax', '1600'),
  r('1640', 'Investments', '1600'),

  // ---- 2000 Liabilities (P8 §7) ----
  r('2000', 'Liabilities', null, 'G', { type: 'liability' }),
  r('2100', 'Current Liabilities', '2000', 'G', { subtype: 'current_liability' }),
  r('2110', 'Accounts Payable — Trade', '2100', 'C:payable K:ap_trade'),
  r('2115', 'Accounts Payable — Leaf Suppliers', '2100', 'C:payable K:ap_leaf_suppliers'),
  r('2120', 'Goods Received Not Invoiced', '2100', 'K:grni'),
  r('2125', 'Contractor Payable', '2100'),
  r('2130', 'Buyer Advances', '2100'),
  r('2140', 'Accrued Expenses', '2100'),
  r('2150', 'Other Payables', '2100'),
  r('2200', 'Payroll Liabilities', '2000', 'G', { subtype: 'current_liability' }),
  r('2210', 'Payroll Payable', '2200', 'C:payroll_liability K:payroll_payable'),
  r('2215', 'Wages Payable — Workers', '2200'),
  r('2220', 'Provident Fund Payable — Employee', '2200', 'C:pf_liability K:pf_payable_employee'),
  r('2225', 'Provident Fund Payable — Employer', '2200'),
  r('2230', 'Gratuity Provision', '2200'),
  r('2235', 'Income Tax Deducted at Source', '2200'),
  r('2240', 'Other Payroll Deductions', '2200'),
  r('2250', 'Leave Encashment Provision', '2200'),
  r('2300', 'Tax and Duty', '2000', 'G', { subtype: 'current_liability' }),
  r('2310', 'VAT Payable', '2300'),
  r('2315', 'VAT Receivable', '2300', 'X'),
  r('2320', 'Tea Cess Payable', '2300'),
  r('2325', 'Withholding Tax Payable', '2300'),
  r('2330', 'Corporate Income Tax Payable', '2300'),
  r('2340', 'Other Statutory Dues', '2300'),
  r('2400', 'Borrowings', '2000', 'G', { subtype: 'current_liability' }),
  r('2410', 'Bank Overdraft', '2400'),
  r('2420', 'Short-Term Loan', '2400'),
  r('2430', 'Working Capital Financing', '2400'),
  r('2500', 'Non-Current Liabilities', '2000', 'G', { subtype: 'long_term_liability' }),
  r('2510', 'Long-Term Loan', '2500'),
  r('2520', 'Lease Liability', '2500'),
  r('2530', 'Security Deposits Received', '2500'),

  // ---- 3000 Equity (P8 §8) ----
  r('3000', 'Equity', null, 'G', { type: 'equity' }),
  r('3100', 'Capital', '3000'),
  r('3200', 'Capital Contribution', '3000'),
  r('3300', 'Retained Earnings', '3000', 'K:retained_earnings'),
  // Never posted to: derived from the year's revenue and expense (P8 §8).
  r('3400', 'Current Year Result', '3000', 'K:current_year_result'),
  r('3500', 'Revaluation Reserve', '3000'),
  r('3600', 'Drawings or Dividend', '3000', 'X'),

  // ---- 4000 Revenue (P8 §9) ----
  r('4000', 'Revenue', null, 'G', { type: 'revenue' }),
  r('4100', 'Operating Revenue', '4000', 'G', { subtype: 'operating_revenue' }),
  r('4110', 'Tea Sales — Auction', '4100', 'E'),
  r('4120', 'Tea Sales — Direct', '4100', 'E'),
  r('4130', 'Tea Sales — Export', '4100'),
  r('4140', 'Sales Returns and Allowances', '4100', 'X'),
  r('4150', 'Green Leaf Sales', '4100', 'E'),
  r('4160', 'Processing Income', '4100'),
  r('4200', 'Other Operating Income', '4000', 'G', { subtype: 'operating_revenue' }),
  r('4210', 'Land and Property Lease Income', '4200'),
  r('4220', 'Sale of Scrap and Waste', '4200'),
  r('4230', 'Nursery and Plant Sales', '4200'),
  r('4240', 'Other Operating Income', '4200'),

  // ---- 5000 Cost of Sales and Production (P8 §10) ----
  r('5000', 'Cost of Sales and Production', null, 'G', { type: 'expense', subtype: 'direct_expense' }),
  r('5010', 'Cost of Goods Sold — Made Tea', '5000', 'E'),
  r('5020', 'Cost of Goods Sold — Green Leaf', '5000'),
  r('5090', 'Inventory Variance', '5000'),
  r('5100', 'Field and Plantation Cost', '5000', 'G'),
  r('5110', 'Plucking Wages', '5100'),
  r('5115', 'Plucking Incentive', '5100'),
  r('5120', 'Field Labour — Cultivation', '5100'),
  r('5125', 'Field Labour — Protection', '5100'),
  r('5130', 'Contractor Labour — Field', '5100'),
  r('5135', 'Fertiliser Consumed', '5100'),
  r('5140', 'Agrochemicals Consumed', '5100'),
  r('5145', 'Irrigation and Water', '5100'),
  r('5150', 'Field Transport', '5100'),
  r('5155', 'Nursery Cost', '5100'),
  r('5160', 'Field Supervision', '5100'),
  r('5170', 'Field Depreciation', '5100'),
  r('5190', 'Other Field Cost', '5100'),
  r('5200', 'Purchased Leaf', '5000', 'G'),
  r('5210', 'Green Leaf Purchases', '5200'),
  r('5220', 'Leaf Purchase Transport', '5200'),
  r('5230', 'Leaf Quality Deductions', '5200', 'X'),
  r('5300', 'Factory and Manufacturing Cost', '5000', 'G'),
  r('5310', 'Factory Labour', '5300'),
  r('5315', 'Contractor Labour — Factory', '5300'),
  r('5320', 'Fuel and Power — Factory', '5300'),
  r('5325', 'Packaging Materials Consumed', '5300'),
  r('5330', 'Factory Consumables', '5300'),
  r('5335', 'Factory Repairs and Maintenance', '5300'),
  r('5340', 'Factory Depreciation', '5300'),
  r('5345', 'Factory Supervision', '5300'),
  r('5350', 'Withering, Processing and Sorting', '5300'),
  r('5390', 'Other Factory Cost', '5300'),
  r('5400', 'Selling and Distribution', '5000', 'G'),
  r('5410', 'Broker Commission', '5400'),
  r('5415', 'Auction Charges', '5400'),
  r('5420', 'Warehouse Charges', '5400'),
  r('5425', 'Tea Cess', '5400'),
  r('5430', 'Transport — Outward', '5400'),
  r('5435', 'Export Charges', '5400'),
  r('5440', 'Sampling and Quality Testing', '5400'),
  r('5490', 'Other Selling Cost', '5400'),

  // ---- 6000 Operating Expense (P8 §11) ----
  r('6000', 'Operating Expense', null, 'G', { type: 'expense', subtype: 'operating_expense' }),
  r('6100', 'Establishment', '6000', 'G'),
  r('6110', 'Salaries — Staff', '6100'),
  r('6115', 'Overtime', '6100'),
  r('6120', 'Bonus and Festival Allowance', '6100'),
  r('6125', 'Provident Fund — Employer Contribution', '6100'),
  r('6130', 'Gratuity Expense', '6100'),
  r('6135', 'Staff Medical', '6100'),
  r('6200', 'Labour Welfare and Benefits', '6000', 'G'),
  r('6210', 'Housing and Accommodation', '6200'),
  r('6215', 'Ration and Food Subsidy', '6200'),
  r('6220', 'Medical and Health', '6200'),
  r('6225', 'Education Support', '6200'),
  r('6230', 'Water, Sanitation and Utilities — Labour Lines', '6200'),
  r('6235', 'Welfare Assistance', '6200'),
  r('6240', 'Training and Development', '6200'),
  r('6250', 'Protective Equipment and Uniform', '6200'),
  r('6300', 'Administration', '6000', 'G'),
  r('6310', 'Office Rent and Rates', '6300'),
  r('6315', 'Utilities — Office', '6300'),
  r('6320', 'Communication', '6300'),
  r('6325', 'Printing and Stationery', '6300'),
  r('6330', 'Travel and Conveyance', '6300'),
  r('6335', 'Vehicle Running and Maintenance', '6300'),
  r('6340', 'Insurance', '6300'),
  r('6345', 'Legal and Professional Fees', '6300'),
  r('6350', 'Audit Fees', '6300'),
  r('6355', 'Licence, Registration and Subscription', '6300'),
  r('6360', 'Bank Charges', '6300'),
  r('6365', 'Repairs and Maintenance — General', '6300'),
  r('6370', 'Security', '6300'),
  r('6375', 'Software and IT', '6300'),
  r('6380', 'Depreciation — Administration', '6300'),
  r('6390', 'Other Administrative Expense', '6300'),

  // ---- 7000 Other income and expense (P8 §12): one top-level group per type (D-3.01-2) ----
  r('7100', 'Other Income', null, 'G', { type: 'revenue', subtype: 'other_revenue' }),
  r('7110', 'Interest Income', '7100'),
  r('7120', 'Gain on Asset Disposal', '7100'),
  r('7130', 'Foreign Exchange Gain', '7100'),
  r('7140', 'Insurance Claims Received', '7100'),
  r('7190', 'Miscellaneous Income', '7100'),
  r('7200', 'Other Expense', null, 'G', { type: 'expense', subtype: 'operating_expense' }),
  r('7210', 'Interest Expense', '7200', '', { subtype: 'financing' }),
  r('7220', 'Loss on Asset Disposal', '7200'),
  r('7230', 'Foreign Exchange Loss', '7200'),
  r('7240', 'Bad Debts Written Off', '7200'),
  r('7250', 'Donations and Corporate Social Responsibility', '7200'),
  r('7290', 'Miscellaneous Expense', '7200'),
  r('7300', 'Taxation', null, 'G', { type: 'expense', subtype: 'operating_expense' }),
  r('7310', 'Current Income Tax', '7300'),
  r('7320', 'Deferred Tax', '7300'),

  // ---- 9000 Clearing and suspense (P8 §13): top-level postable, nil at close (D-3.01-5) ----
  r('9100', 'Opening Balance Suspense', null, 'L K:opening_balance_suspense', { type: 'equity' }),
  r('9200', 'Migration Suspense', null, 'L K:migration_suspense', { type: 'asset' }),
  r('9300', 'Unallocated Receipts', null, 'L K:unallocated_receipts', { type: 'liability' }),
  r('9900', 'Year-End Closing', null, 'L K:year_end_closing', { type: 'equity' }),
];

/** A seeded account with every column worked out. */
export interface SeedAccount {
  readonly code: string;
  readonly name: string;
  readonly parent: string | null;
  readonly level: number;
  readonly account_type: AccountType;
  readonly account_subtype: AccountSubtype | null;
  readonly normal_balance: NormalBalance;
  readonly is_postable: boolean;
  readonly is_control_account: boolean;
  readonly control_subledger: ControlSubledger | null;
  readonly is_bank_or_cash: boolean;
  readonly requires_cost_centre: boolean;
  readonly requires_estate: boolean;
  readonly is_clearing: boolean;
  readonly system_key: string | null;
}

/** Resolves inheritance and flags, parents before children. Throws on an inconsistent table. */
export function resolveChart(rows: readonly ChartRow[]): SeedAccount[] {
  const byCode = new Map<string, SeedAccount>();
  const out: SeedAccount[] = [];
  for (const row of rows) {
    const flags = (row.flags ?? '').split(' ').filter(Boolean);
    const flag = (f: string) => flags.includes(f);
    const valued = (prefix: string) => flags.find((f) => f.startsWith(`${prefix}:`))?.slice(2) ?? null;
    const parent = row.parent === null ? null : byCode.get(row.parent);
    if (row.parent !== null && !parent) throw new Error(`chart: ${row.code} comes before its parent`);
    if (parent?.is_postable) throw new Error(`chart: ${row.code} is under the postable ${parent.code}`);
    const type = row.type ?? parent?.account_type;
    if (!type) throw new Error(`chart: top-level ${row.code} has no type`);
    if (parent && row.type && row.type !== parent.account_type)
      throw new Error(`chart: ${row.code} differs in type from its parent`);
    const subtype = row.subtype !== undefined ? row.subtype : (parent?.account_subtype ?? null);
    const postable = !flag('G');
    const balance = normalBalanceOf(type);
    const control = valued('C') as ControlSubledger | null;
    const account: SeedAccount = {
      code: row.code,
      name: row.name,
      parent: row.parent,
      level: parent ? parent.level + 1 : 1,
      account_type: type,
      account_subtype: subtype,
      normal_balance: flag('X') ? oppositeBalance(balance) : balance,
      is_postable: postable,
      is_control_account: control !== null,
      control_subledger: control,
      is_bank_or_cash: flag('B'),
      requires_cost_centre: postable && type === 'expense',
      requires_estate: flag('E'),
      is_clearing: flag('L'),
      system_key: valued('K'),
    };
    if (account.level > MAX_ACCOUNT_LEVEL) throw new Error(`chart: ${row.code} is deeper than four levels`);
    const errors = shapeErrors({ ...account, currency_id: null });
    if (errors.length > 0) throw new Error(`chart: ${row.code}: ${errors.map((e) => e.message).join(' ')}`);
    if (byCode.has(row.code)) throw new Error(`chart: ${row.code} is listed twice`);
    byCode.set(row.code, account);
    out.push(account);
  }
  return out;
}
