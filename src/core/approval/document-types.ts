/**
 * The documents that can be routed through an approval workflow (Spec P7 §2.1, §7–§9), and for each one
 * the fields a workflow condition may test (P7 §5.1: "validating the condition against the document
 * type's field list").
 *
 * The engine knows nothing about what a sale or a payroll run MEANS. It knows a document type by this
 * description only: its fields, its scope tier, and whether self-approval may ever be allowed.
 *
 *   approvalClass   decides self-approval (P7 Table 12.1):
 *                     financial, capture, policy, leave → never, not configurable
 *                     operational, master               → configurable per step, off by default
 *   tier            which scope an approver must hold to be resolved (P7 §4.4):
 *                     estate → the document's estate; facility → its factory or warehouse;
 *                     organisation → all_estates
 *   module          the permission module of the document: {module}.create and {module}.approve are what
 *                   the separation-of-duties check of P7 §15.2 looks at
 *
 * A module that introduces a document adds or refines its entry here, in the epic that builds it. The
 * field names are the names its submission hands to the engine; amounts are ALWAYS in base currency
 * (P7 §5.1), whatever currency the document is in.
 */

export type ApprovalClass = 'financial' | 'capture' | 'policy' | 'leave' | 'operational' | 'master';
export type DocumentTier = 'estate' | 'facility' | 'organisation';

/** P7 Table 5.1. */
export type FieldClass = 'amount' | 'organisational' | 'attribute' | 'flag' | 'submitter' | 'quantity';

export interface ConditionField {
  readonly name: string;
  readonly class: FieldClass;
  readonly label: string;
}

export interface ApprovableDocument {
  readonly key: string;
  readonly label: string;
  readonly approvalClass: ApprovalClass;
  readonly tier: DocumentTier;
  readonly module: string;
  /** The permission that lets a user approve it, when it is not {module}.approve. */
  readonly approvePermission?: string;
  readonly fields: readonly ConditionField[];
}

/** The classes on which nobody may ever approve their own document (P7 Table 12.1). */
export const NEVER_SELF_APPROVE: ReadonlySet<ApprovalClass> = new Set([
  'financial',
  'capture',
  'policy',
  'leave',
]);

const f =
  (cls: FieldClass) =>
  (name: string, label: string): ConditionField => ({ name, class: cls, label });
const amount = f('amount');
const org = f('organisational');
const attr = f('attribute');
const flag = f('flag');
const qty = f('quantity');
const submitter = f('submitter');

/** On every document: who submitted it, and where it belongs. */
const SUBMITTER: readonly ConditionField[] = [
  submitter('submitter_role', 'Submitter’s role'),
  submitter('submitter_department', 'Submitter’s department'),
];
const DEPARTMENT = org('department_id', 'Department');
const COST = [org('cost_centre_id', 'Cost centre'), org('budget_head_id', 'Budget head')];
const TIER_FIELDS: Readonly<Record<DocumentTier, readonly ConditionField[]>> = {
  estate: [org('estate_id', 'Estate'), DEPARTMENT],
  facility: [org('factory_id', 'Factory'), org('warehouse_id', 'Warehouse'), DEPARTMENT],
  organisation: [DEPARTMENT],
};

function doc(
  key: string,
  label: string,
  approvalClass: ApprovalClass,
  tier: DocumentTier,
  module: string,
  fields: readonly ConditionField[] = [],
  approvePermission?: string,
): ApprovableDocument {
  return {
    key,
    label,
    approvalClass,
    tier,
    module,
    ...(approvePermission ? { approvePermission } : {}),
    fields: [...TIER_FIELDS[tier], ...fields, ...SUBMITTER],
  };
}

export const APPROVABLE_DOCUMENTS: readonly ApprovableDocument[] = [
  // ---- operational capture (P7 §7.1–§7.3): the supervisor captures, somebody else approves ---------
  doc('attendance', 'Attendance', 'capture', 'estate', 'attendance'),
  doc('plucking', 'Plucking work record', 'capture', 'estate', 'plucking', [
    qty('total_quantity', 'Total quantity (kg)'),
    flag('has_variance', 'Field variance beyond tolerance'),
  ]),
  doc('team_distribution', 'Team distribution', 'capture', 'estate', 'plucking', [
    attr('distribution_method', 'Distribution method'),
  ]),

  // ---- operational documents (P7 §7.4–§7.11) -------------------------------------------------------
  doc('leaf_collection', 'Leaf collection', 'operational', 'estate', 'leaf_collection'),
  doc('leaf_transfer', 'Leaf transfer', 'operational', 'estate', 'leaf_transfer', [
    flag('is_inter_estate', 'Source and destination estates differ'),
  ]),
  doc('production_batch', 'Production batch', 'operational', 'facility', 'production', [
    flag('is_within_tolerance', 'Yield within the configured band'),
    amount('abnormal_loss', 'Abnormal loss (value)'),
  ]),
  doc('tea_lot', 'Tea lot', 'operational', 'facility', 'lot', [
    qty('total_quantity', 'Quantity (kg)'),
    flag('has_variance', 'Quantity differs from its composition'),
  ]),
  doc('catalogue', 'Catalogue', 'operational', 'organisation', 'catalogue'),
  doc('land_allocation', 'Land allocation', 'operational', 'estate', 'land_allocation', [
    qty('allocated_area', 'Allocated area (acres)'),
    attr('recipient_type', 'Recipient type'),
  ]),
  doc('lease', 'Lease agreement', 'operational', 'estate', 'lease', [
    amount('total_amount', 'Lease total'),
    qty('term_months', 'Term (months)'),
  ]),
  doc('contractor_contract', 'Contractor contract', 'operational', 'estate', 'contractor', [
    amount('contract_value', 'Contract value'),
    qty('term_months', 'Term (months)'),
  ]),
  doc('field_activity', 'Field activity', 'operational', 'estate', 'field_activity'),
  doc('labour_allocation', 'Labour allocation', 'operational', 'estate', 'labour_allocation'),
  doc('material_issue', 'Material issue', 'operational', 'facility', 'material_issue'),
  doc('goods_receipt', 'Goods receipt', 'operational', 'estate', 'goods_receipt'),
  doc('benefit_entitlement', 'Benefit entitlement', 'operational', 'estate', 'benefit'),
  doc('training_program', 'Training programme', 'operational', 'estate', 'training', [
    amount('cost', 'Cost'),
    ...COST,
  ]),
  doc('goal', 'Goal', 'operational', 'estate', 'goal'),
  doc('evaluation', 'Evaluation', 'operational', 'estate', 'evaluation'),

  // ---- leave (P7 §7.9) -------------------------------------------------------------------------------
  doc('leave', 'Leave', 'leave', 'estate', 'leave', [
    qty('day_count', 'Days'),
    flag('balance_negative', 'Balance would go negative'),
  ]),

  // ---- financial documents (P7 §7.6–§7.7, §8) --------------------------------------------------------
  doc('leaf_purchase', 'Leaf purchase', 'financial', 'estate', 'leaf_purchase', [
    amount('net_amount', 'Net amount'),
  ]),
  doc('stock_adjustment', 'Stock adjustment', 'financial', 'facility', 'stock_adjustment', [
    amount('total_value_impact', 'Total value impact'),
    attr('adjustment_type', 'Adjustment type'),
  ]),
  doc('purchase_request', 'Purchase request', 'financial', 'estate', 'purchase_request', [
    amount('estimated_amount', 'Estimated amount'),
    flag('budget_exceeded', 'Budget exceeded'),
    ...COST,
  ]),
  doc('purchase_order', 'Purchase order', 'financial', 'estate', 'purchase_order', [
    amount('total_base_amount', 'Total amount'),
    flag('budget_exceeded', 'Budget exceeded'),
    ...COST,
  ]),
  doc('supplier_invoice', 'Supplier invoice', 'financial', 'estate', 'supplier_invoice', [
    amount('total_base_amount', 'Total amount'),
    attr('match_status', 'Three-way match status'),
    flag('has_variance', 'Match variance beyond tolerance'),
    ...COST,
  ]),
  doc('payment', 'Payment', 'financial', 'estate', 'payment', [amount('amount', 'Amount'), ...COST]),
  doc('sale', 'Sale', 'financial', 'organisation', 'sale', [
    amount('net_base_amount', 'Net amount'),
    attr('sale_channel', 'Sale channel'),
  ]),
  doc('collection', 'Collection', 'financial', 'organisation', 'collection', [amount('amount', 'Amount')]),
  doc(
    'receivable_write_off',
    'Receivable write-off',
    'financial',
    'organisation',
    'receivable',
    [amount('amount', 'Amount')],
    'receivable.write_off',
  ),
  doc('payroll_run', 'Payroll run', 'financial', 'estate', 'payroll', [
    amount('total_net', 'Total net pay'),
    attr('run_type', 'Run type'),
  ]),
  doc('employee_advance', 'Employee advance', 'financial', 'estate', 'advance', [
    amount('approved_amount', 'Approved amount'),
  ]),
  doc('gratuity_payment', 'Gratuity payment', 'financial', 'estate', 'gratuity', [
    amount('amount', 'Amount'),
  ]),
  doc('journal', 'Manual journal', 'financial', 'organisation', 'journal', [
    amount('total_debit', 'Total debit'),
    attr('journal_type', 'Journal type'),
    flag('is_prior_period', 'Affects a prior period'),
  ]),
  doc(
    'period_reopen',
    'Period reopen',
    'financial',
    'organisation',
    'accounting_period',
    [],
    'accounting_period.reopen',
  ),
  doc('depreciation_run', 'Depreciation run', 'financial', 'organisation', 'depreciation'),
  doc('asset_disposal', 'Asset disposal', 'financial', 'estate', 'asset', [
    amount('book_value_at_disposal', 'Book value at disposal'),
    attr('disposal_type', 'Disposal type'),
  ]),
  doc('welfare_case', 'Welfare case', 'financial', 'estate', 'welfare', [
    amount('requested_amount', 'Requested amount'),
    ...COST,
  ]),
  doc('benefit_issue', 'Benefit issue', 'financial', 'estate', 'benefit', [
    amount('employer_cost', 'Employer cost'),
  ]),
  doc('budget', 'Budget', 'financial', 'estate', 'budget', [
    amount('total_amount', 'Total amount'),
    flag('is_single_estate', 'Budget of a single estate'),
  ]),

  // ---- policy (P7 §9.1–§9.3, §15.1) ------------------------------------------------------------------
  ...(
    [
      ['wage_rule', 'Wage rule'],
      ['incentive_rule', 'Incentive rule'],
      ['overtime_rule', 'Overtime rule'],
      ['statutory_rule', 'Statutory rule'],
      ['charge_rule', 'Charge rule'],
    ] as const
  ).map(([key, label]) =>
    doc(key, label, 'policy', 'estate', key, [
      flag('is_retrospective', 'Takes effect in the past'),
      flag('is_organisation_wide', 'Applies organisation-wide'),
    ]),
  ),
  doc('budget_control', 'Budget control', 'policy', 'estate', 'budget_control', [
    flag('is_relaxation', 'Control switched off or a threshold raised'),
  ]),
  doc('workflow', 'Approval workflow', 'policy', 'estate', 'workflow', [
    flag('is_organisation_wide', 'Applies organisation-wide'),
  ]),

  // ---- master records that need approval (P7 §9.6) ---------------------------------------------------
  doc('employment_assignment', 'Employment assignment', 'master', 'estate', 'employment', [
    flag('is_wage_change', 'Changes the wage basis or rate'),
  ]),
  doc('supplier_bank_change', 'Supplier bank detail change', 'master', 'organisation', 'supplier'),
  doc('buyer_credit_limit', 'Buyer credit limit change', 'master', 'organisation', 'buyer', [
    amount('credit_limit', 'New credit limit'),
  ]),
];

export const APPROVABLE_BY_KEY: ReadonlyMap<string, ApprovableDocument> = new Map(
  APPROVABLE_DOCUMENTS.map((d) => [d.key, d]),
);

export function approvableDocument(key: string): ApprovableDocument | undefined {
  return APPROVABLE_BY_KEY.get(key);
}

export function approvePermissionOf(document: ApprovableDocument): string {
  return document.approvePermission ?? `${document.module}.approve`;
}
