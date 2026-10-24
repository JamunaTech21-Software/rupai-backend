import type { Tx } from '../db/transaction.js';

/**
 * What can post (Spec P1 §7.2, P3 §27.3, §27.5, §27.7, P8 §5, §14).
 *
 *   - POSTABLE_SOURCES: every document that will reach the ledger, declared once, before its module
 *     exists (like APPROVABLE_DOCUMENTS), so posting rules can be defined, reviewed by the accountant and
 *     previewed now. Each names the purposes it posts for, the amounts it supplies, the account fields it
 *     can name and the values its rule conditions may test.
 *   - Account resolvers: how a rule line finds its account (P8 §5.2). `fixed` and `from_account_field` are
 *     built in; `from_component`, `from_category` and `from_charge_type` are registered by the phases that
 *     build component types, categories and charge types (D-3.03-4).
 */

export const POSTING_PURPOSES = [
  'revenue',
  'cost_of_goods_sold',
  'receivable',
  'payable',
  'expense',
  'inventory_in',
  'inventory_out',
  'payroll_expense',
  'payroll_liability',
  'pf_liability',
  'depreciation',
  'variance',
  'disposal',
] as const;
export type PostingPurpose = (typeof POSTING_PURPOSES)[number];
/** posting_link only: a reversal is linked to the journal it reverses (D-3.03-7). */
export const REVERSAL_PURPOSE = 'reversal';

export const ACCOUNT_RESOLUTIONS = [
  'fixed',
  'from_component',
  'from_category',
  'from_charge_type',
  'from_account_field',
] as const;
export type AccountResolution = (typeof ACCOUNT_RESOLUTIONS)[number];

export const SIDES = ['debit', 'credit'] as const;
export type Side = (typeof SIDES)[number];

export const PARTY_TYPES = ['buyer', 'supplier', 'leaf_supplier', 'party', 'employment_profile'] as const;
export type PartyType = (typeof PARTY_TYPES)[number];

interface Named {
  readonly name: string;
  readonly label: string;
}

export interface PostableSource {
  /** P3 §27.3 source_type: the document's table. */
  readonly key: string;
  readonly label: string;
  /** Which phase builds the document. */
  readonly phase: string;
  readonly purposes: readonly PostingPurpose[];
  /** The amounts the document supplies, by the name a rule line's amount_source uses. */
  readonly amounts: readonly Named[];
  /** Accounts the document itself can name (from_account_field resolution keys). */
  readonly accountFields: readonly Named[];
  /** Keys the document supplies for the registered resolvers (component, category, charge type). */
  readonly refs: readonly Named[];
  /** Values a rule's conditions may test (approval grammar, P7 §5). */
  readonly conditionFields: readonly Named[];
}

const n = (name: string, label: string): Named => ({ name, label });
const src = (
  key: string,
  label: string,
  phase: string,
  purposes: readonly PostingPurpose[],
  amounts: readonly Named[],
  extra: {
    accountFields?: readonly Named[];
    refs?: readonly Named[];
    conditionFields?: readonly Named[];
  } = {},
): PostableSource => ({
  key,
  label,
  phase,
  purposes,
  amounts,
  accountFields: extra.accountFields ?? [],
  refs: extra.refs ?? [],
  conditionFields: [n('estate_id', 'Estate'), ...(extra.conditionFields ?? [])],
});

const BANK = n('bank_account', 'The cash or bank account paid into or from');

/** P1 Table 7.2 and P8 §14, by document. */
export const POSTABLE_SOURCES: PostableSource[] = [
  src(
    'sale',
    'Tea sale',
    'Phase 8',
    ['revenue', 'cost_of_goods_sold'],
    [
      n('receivable', 'Gross amount the buyer owes'),
      n('revenue', 'Sale value'),
      n('vat', 'Output VAT'),
      n('charges', 'Charges deducted, per charge type'),
      n('cost', 'Cost of the tea sold'),
    ],
    {
      accountFields: [n('revenue_account', 'The sales account of the channel (auction, direct, export)')],
      refs: [n('charge_type', 'The charge type of a deducted charge')],
      conditionFields: [n('channel', 'Sales channel')],
    },
  ),
  src('collection', 'Collection', 'Phase 8', ['receivable'], [n('amount', 'Amount collected')], {
    accountFields: [BANK],
  }),
  src('lease_schedule', 'Lease instalment due', 'Phase 5', ['receivable'], [n('amount', 'Instalment')], {
    accountFields: [n('income_account', 'An income account overriding the default (the agreement)')],
  }),
  src(
    'leaf_purchase',
    'Green leaf purchase',
    'Phase 6',
    ['inventory_in'],
    [n('value', 'Leaf value payable')],
  ),
  src(
    'production_batch',
    'Production batch',
    'Phase 6',
    ['inventory_in'],
    [
      n('output_value', 'Value of the made tea'),
      n('leaf_value', 'Green leaf consumed'),
      n('conversion_cost', 'Conversion cost absorbed'),
    ],
    { accountFields: [n('absorbed_account', 'The factory cost absorbed account (P8 5399)')] },
  ),
  src('goods_receipt', 'Goods receipt', 'Phase 4', ['inventory_in'], [n('value', 'Value received')], {
    refs: [n('material_category', 'The material category')],
  }),
  src(
    'supplier_invoice',
    'Supplier invoice',
    'Phase 4',
    ['payable'],
    [
      n('matched', 'Amount matched to goods received'),
      n('expense', 'Direct expense, per line'),
      n('input_vat', 'Input VAT'),
      n('payable', 'Gross amount payable'),
      n('withholding', 'Withholding tax deducted'),
    ],
    { accountFields: [n('expense_account', 'The expense account of a direct-expense line')] },
  ),
  src('payment', 'Payment', 'Phase 4', ['payable'], [n('amount', 'Amount paid')], {
    accountFields: [BANK, n('payable_account', 'The payable cleared (trade, leaf suppliers, payroll)')],
  }),
  src(
    'payroll_run',
    'Payroll run',
    'Phase 9',
    ['payroll_expense', 'payroll_liability', 'pf_liability'],
    [
      n('earnings', 'Earnings, per component and cost centre'),
      n('gross', 'Gross pay'),
      n('pf_employee', 'Provident fund, employee share'),
      n('tax', 'Income tax deducted'),
      n('advance', 'Advance recovered'),
      n('other_deductions', 'Other deductions'),
      n('pf_employer', 'Provident fund, employer share'),
    ],
    { refs: [n('component', 'The pay component type')] },
  ),
  src('advance', 'Employee advance', 'Phase 9', ['receivable'], [n('amount', 'Amount advanced')], {
    accountFields: [BANK],
  }),
  src('gratuity_accrual', 'Gratuity accrual', 'Phase 9', ['expense'], [n('amount', 'Gratuity accrued')]),
  src(
    'depreciation_run',
    'Depreciation run',
    'Phase 10',
    ['depreciation'],
    [n('amount', 'Depreciation, per asset')],
    {
      // P8 §14.7: the expense resolves by cost centre (factory, field, administration); the run supplies it.
      accountFields: [n('expense_account', 'The depreciation expense account of the asset’s cost centre')],
      refs: [n('asset_category', 'The asset category')],
    },
  ),
  src(
    'stock_adjustment',
    'Stock adjustment',
    'Phase 7',
    ['variance'],
    [n('loss', 'Value lost'), n('gain', 'Value found')],
    { refs: [n('material_category', 'The material class')] },
  ),
  src(
    'asset_disposal',
    'Asset disposal',
    'Phase 10',
    ['disposal'],
    [
      n('proceeds', 'Sale proceeds'),
      n('accumulated', 'Accumulated depreciation removed'),
      n('cost', 'Asset cost removed'),
      n('gain', 'Gain on disposal'),
      n('loss', 'Loss on disposal'),
    ],
    { accountFields: [BANK], refs: [n('asset_category', 'The asset category')] },
  ),
];

const byKey = new Map(POSTABLE_SOURCES.map((s) => [s.key, s]));

/** A source added by a later module (or a test). Its key must be new. */
export function registerPostableSource(source: PostableSource): void {
  if (byKey.has(source.key)) throw new Error(`posting: source ${source.key} is already declared`);
  POSTABLE_SOURCES.push(source);
  byKey.set(source.key, source);
}

export function postableSource(key: string): PostableSource | undefined {
  return byKey.get(key);
}

// ---- account resolvers ---------------------------------------------------------------------------------

/**
 * Finds the account for one amount item from the record the item names (a component type, a category…).
 * `field` is the part of the resolution key after ":" — which of the record's accounts (an asset category
 * has a cost account and an accumulated depreciation account); null when the key names none.
 */
export type AccountResolver = (tx: Tx, refId: bigint, field: string | null) => Promise<bigint | null>;

/** "asset_category:accumulated_account" → the ref the document supplies and the record's account field. */
export function splitResolutionKey(key: string): { ref: string; field: string | null } {
  const at = key.indexOf(':');
  return at < 0 ? { ref: key, field: null } : { ref: key.slice(0, at), field: key.slice(at + 1) };
}

const resolvers = new Map<AccountResolution, AccountResolver>();

/** Registered by the phase that builds component types (9), material and asset categories (4, 10), charge types (8). */
export function registerAccountResolver(
  resolution: Exclude<AccountResolution, 'fixed' | 'from_account_field'>,
  resolver: AccountResolver,
): void {
  resolvers.set(resolution, resolver);
}

export function accountResolver(resolution: AccountResolution): AccountResolver | undefined {
  return resolvers.get(resolution);
}

/** Whether a resolution can be used now (D-3.03-4). */
export function resolutionAvailable(resolution: AccountResolution): boolean {
  return resolution === 'fixed' || resolution === 'from_account_field' || resolvers.has(resolution);
}
