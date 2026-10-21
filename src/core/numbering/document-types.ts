/**
 * The business documents that carry a number (Spec P1 Table 6.1, §15.2). Each has one number_format row,
 * seeded from here; the client edits the format, never the set.
 *
 *   lifecycle   financial   → gapless: the number is allocated INSIDE the posting transaction (P2 §6.5)
 *               operational → allocated at draft creation; a cancelled draft may leave a gap
 *   components  which optional parts of a number this document can supply. A format may only switch on a
 *               component its document knows (an organisation-level journal has no estate or season).
 *
 * The module that creates a document adds its type here, in the epic that introduces it.
 */
export type NumberComponent = 'estate' | 'fiscal_year' | 'season';

export interface DocumentType {
  readonly key: string;
  readonly label: string;
  readonly lifecycle: 'financial' | 'operational';
  readonly prefix: string;
  readonly components: readonly NumberComponent[];
}

const fin = (
  key: string,
  label: string,
  prefix: string,
  components: readonly NumberComponent[],
): DocumentType => ({
  key,
  label,
  lifecycle: 'financial',
  prefix,
  components,
});
const op = (
  key: string,
  label: string,
  prefix: string,
  components: readonly NumberComponent[],
): DocumentType => ({
  key,
  label,
  lifecycle: 'operational',
  prefix,
  components,
});
const ESTATE_FY: readonly NumberComponent[] = ['estate', 'fiscal_year'];
const ESTATE_SEASON: readonly NumberComponent[] = ['estate', 'fiscal_year', 'season'];
const ORG: readonly NumberComponent[] = ['fiscal_year'];

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  // Green leaf and manufacturing
  fin('leaf_purchase', 'Leaf purchase', 'LP', ESTATE_SEASON),
  op('leaf_transfer', 'Leaf transfer', 'LT', ESTATE_SEASON),
  op('production_batch', 'Production batch', 'PB', ['fiscal_year', 'season']),
  // Inventory and sales
  op('stock_adjustment', 'Stock adjustment', 'SA', ORG),
  op('tea_lot', 'Tea lot', 'LOT', ['fiscal_year', 'season']),
  op('catalogue', 'Catalogue', 'CAT', ORG),
  fin('sale', 'Sale', 'INV', ORG),
  fin('collection', 'Collection', 'RC', ORG),
  // Procurement and payables
  op('purchase_request', 'Purchase request', 'PR', ESTATE_FY),
  op('purchase_order', 'Purchase order', 'PO', ESTATE_FY),
  op('goods_receipt', 'Goods receipt', 'GRN', ESTATE_FY),
  fin('supplier_invoice', 'Supplier invoice', 'BILL', ESTATE_FY),
  fin('payment', 'Payment', 'PV', ESTATE_FY),
  // Workforce and payroll
  op('person', 'Person', 'PRS', []),
  // P2.02: the design's Worker ID and Employee ID, per estate.
  op('worker_profile', 'Worker ID', 'WRK', ['estate']),
  op('employee_profile', 'Employee ID', 'EMP', ['estate']),
  // P2.05: the design's Contractor ID, and contractor contracts per estate and year.
  op('contractor', 'Contractor ID', 'CON', []),
  op('contractor_contract', 'Contractor contract', 'CC', ESTATE_FY),
  op('leave', 'Leave', 'LV', ESTATE_FY),
  // P2.08: welfare cases per estate and year.
  op('welfare_case', 'Welfare case', 'WC', ESTATE_FY),
  // P2.09: training programmes per estate and year.
  op('training_program', 'Training programme', 'TP', ESTATE_FY),
  // P2.10: goals and evaluations per estate and year.
  op('goal', 'Goal', 'GL', ESTATE_FY),
  op('evaluation', 'Evaluation', 'EV', ESTATE_FY),
  fin('payroll_run', 'Payroll run', 'PAY', ESTATE_FY),
  fin('payroll_payment', 'Payroll payment', 'PP', ESTATE_FY),
  fin('employee_advance', 'Employee advance', 'ADV', ESTATE_FY),
  // Planning and accounting
  op('budget', 'Budget', 'BUD', ESTATE_FY),
  fin('journal', 'Journal', 'JV', ORG),
  fin('depreciation_run', 'Depreciation run', 'DEP', ORG),
];

export const DOCUMENT_TYPE_BY_KEY: ReadonlyMap<string, DocumentType> = new Map(
  DOCUMENT_TYPES.map((d) => [d.key, d]),
);
