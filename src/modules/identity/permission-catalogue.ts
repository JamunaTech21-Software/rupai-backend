/**
 * The permission catalogue (Spec P6 §3). A permission exists because the application enforces it, so the
 * catalogue lives in code and is seeded as system rows (P3 §31.2). It is not client-editable, and the
 * app account has no UPDATE/DELETE right on `permission`.
 *
 * Every permission is `module.action`. A module's CLASS decides its action set (P6 Table 3.2). Where
 * P6 Table 3.3 gives a group two classes ("Master, operational"), each module's class is decided below
 * by what the module actually is; those decisions are recorded in BACKLOG P1.01.
 */

export const ACTIONS = [
  'view',
  'create',
  'edit',
  'delete',
  'submit',
  'approve',
  'reject',
  'post',
  'export',
  'print',
] as const;
export type StandardAction = (typeof ACTIONS)[number];

/**
 * Actions outside the ten, each named explicitly by the spec for one module: accounting_period.reopen,
 * receivable.write_off (P6 §10) and device.register, device.revoke (P6 §7, CN-01). The migration's
 * CHECK constraint admits exactly these.
 */
export const SPECIAL_ACTIONS = ['reopen', 'write_off', 'register', 'revoke'] as const;
export type SpecialAction = (typeof SPECIAL_ACTIONS)[number];
export type Action = StandardAction | SpecialAction;

export type ModuleClass = 'reference' | 'master' | 'operational' | 'financial' | 'derived' | 'policy';

/** P6 Table 3.2. */
export const CLASS_ACTIONS: Readonly<Record<ModuleClass, readonly StandardAction[]>> = {
  reference: ['view', 'create', 'edit', 'delete'],
  master: ['view', 'create', 'edit', 'delete', 'export', 'print'],
  operational: ['view', 'create', 'edit', 'delete', 'submit', 'approve', 'reject', 'export', 'print'],
  financial: ACTIONS,
  derived: ['view', 'export', 'print'],
  policy: ['view', 'create', 'edit', 'approve', 'reject'],
};

export interface CatalogueModule {
  readonly key: string;
  readonly group: string;
  readonly class: ModuleClass;
  readonly label: string;
  /** Actions beyond the class set. */
  readonly extra?: readonly SpecialAction[] | readonly StandardAction[];
}

const m = (
  group: string,
  cls: ModuleClass,
  entries: readonly (readonly [string, string] | readonly [string, string, readonly Action[]])[],
): CatalogueModule[] =>
  entries.map(([key, label, extra]) => ({
    key,
    group,
    class: cls,
    label,
    ...(extra ? { extra: extra as readonly SpecialAction[] } : {}),
  }));

/** P6 Table 3.3, in navigation order. */
export const MODULES: readonly CatalogueModule[] = [
  ...m('Organisation', 'master', [
    ['organisation', 'Organisation'],
    ['estate', 'Estates'],
    ['division', 'Divisions'],
    ['section', 'Sections'],
    ['field', 'Fields'],
    ['factory', 'Factories'],
    ['warehouse', 'Warehouses'],
    ['season', 'Seasons'],
    ['fiscal_year', 'Fiscal years'],
    ['accounting_period', 'Accounting periods', ['reopen']],
  ]),
  ...m('Reference', 'reference', [
    ['lookup', 'Lookups'],
    ['uom', 'Units of measure'],
    ['tea_type', 'Tea types'],
    ['tea_grade', 'Tea grades'],
    ['activity_type', 'Activity types'],
    ['shift', 'Shifts'],
    ['currency', 'Currencies'],
    ['country', 'Countries'],
  ]),
  ...m('Land', 'master', [['land', 'Land parcels']]),
  ...m('Land', 'operational', [
    ['land_allocation', 'Land allocations'],
    ['lease', 'Leases'],
  ]),
  ...m('Plantation', 'master', [['plantation', 'Plantation records']]),
  ...m('Plantation', 'operational', [['field_activity', 'Field activities']]),
  ...m('Workforce', 'master', [
    ['person', 'People'],
    ['employment', 'Employment profiles'],
    ['team', 'Teams'],
    ['contractor', 'Contractors'],
  ]),
  ...m('Attendance', 'operational', [
    ['attendance', 'Attendance'],
    ['roster', 'Rosters'],
    ['recognition', 'Recognition'],
  ]),
  ...m('Field operations', 'operational', [
    ['labour_allocation', 'Labour allocation'],
    ['plucking', 'Plucking'],
  ]),
  ...m('Green leaf', 'operational', [
    ['leaf_collection', 'Leaf collection'],
    ['leaf_transfer', 'Leaf transfers'],
  ]),
  ...m('Green leaf', 'master', [['leaf_supplier', 'Leaf suppliers']]),
  ...m('Green leaf', 'financial', [['leaf_purchase', 'Leaf purchases']]),
  ...m('Manufacturing', 'operational', [
    ['production', 'Production batches'],
    ['material_issue', 'Material issues'],
  ]),
  ...m('Manufacturing', 'master', [['raw_material', 'Raw materials']]),
  ...m('Inventory', 'derived', [['inventory', 'Stock ledger and balances']]),
  ...m('Inventory', 'operational', [
    ['stock_adjustment', 'Stock adjustments'],
    ['lot', 'Tea lots'],
    ['catalogue', 'Catalogues'],
  ]),
  ...m('Commercial', 'master', [
    ['auction', 'Auctions'],
    ['broker', 'Brokers'],
    ['buyer', 'Buyers'],
  ]),
  ...m('Commercial', 'financial', [['sale', 'Sales']]),
  ...m('Commercial', 'operational', [['sales_order', 'Sales orders']]),
  ...m('Settlement', 'derived', [
    ['receivable', 'Receivables', ['write_off']],
    ['payable', 'Payables'],
  ]),
  ...m('Settlement', 'financial', [
    ['collection', 'Collections'],
    ['payment', 'Payments'],
  ]),
  ...m('Procurement', 'master', [['supplier', 'Suppliers']]),
  ...m('Procurement', 'operational', [
    ['purchase_request', 'Purchase requests'],
    ['purchase_order', 'Purchase orders'],
    ['goods_receipt', 'Goods receipts'],
  ]),
  ...m('Procurement', 'financial', [['supplier_invoice', 'Supplier invoices']]),
  ...m('Payroll', 'financial', [
    ['payroll', 'Payroll'],
    ['gratuity', 'Gratuity'],
    ['advance', 'Employee advances'],
  ]),
  ...m('Payroll', 'reference', [['component_type', 'Pay component types']]),
  ...m('Payroll', 'derived', [['pf', 'Provident fund']]),
  ...m('Rules', 'policy', [
    ['wage_rule', 'Wage rules'],
    ['incentive_rule', 'Incentive rules'],
    ['overtime_rule', 'Overtime rules'],
    ['statutory_rule', 'Statutory rules'],
    ['charge_rule', 'Charge rules'],
  ]),
  ...m('HR', 'operational', [
    ['leave', 'Leave'],
    ['benefit', 'Benefits'],
    ['welfare', 'Welfare'],
    ['training', 'Training'],
    ['goal', 'Goals'],
    ['evaluation', 'Evaluations'],
  ]),
  ...m('Assets', 'master', [['asset', 'Assets']]),
  ...m('Assets', 'financial', [['depreciation', 'Depreciation']]),
  ...m('Planning', 'operational', [
    ['funding', 'Funding plans'],
    ['budget', 'Budgets'],
  ]),
  ...m('Planning', 'policy', [['budget_control', 'Budget control']]),
  ...m('Accounting', 'master', [
    ['accounting', 'Chart of accounts'],
    ['bank_account', 'Bank accounts'],
  ]),
  ...m('Accounting', 'financial', [['journal', 'Journals']]),
  ...m('Platform', 'master', [
    ['user', 'Users'],
    ['role', 'Roles'],
    ['workflow', 'Workflows'],
    ['document', 'Documents'],
    ['notification', 'Notifications'],
    ['system', 'System settings'],
    ['device', 'Devices', ['register', 'revoke']],
  ]),
  ...m('Platform', 'derived', [['audit', 'Audit log']]),
  // sync.submit (P6 R-06, CN-01): the field app submitting a capture batch.
  ...m('Platform', 'derived', [['sync', 'Field sync', ['submit']]]),
  ...m('Output', 'derived', [
    ['dashboard', 'Dashboards'],
    ['report', 'Reports'],
  ]),
];

/** P6 Table 10.1. Each needs named written authorisation before assignment (enforced in P1.04). */
export const SENSITIVE_PERMISSIONS: ReadonlySet<string> = new Set([
  'user.edit',
  'role.edit',
  'payroll.post',
  'payroll.export',
  'journal.post',
  'accounting_period.reopen',
  'statutory_rule.approve',
  'wage_rule.approve',
  'receivable.write_off',
  'stock_adjustment.approve',
  'payment.approve',
  'person.export',
  'employment.export',
  'audit.view',
  'device.revoke',
]);

export interface CataloguePermission {
  readonly key: string;
  readonly module: string;
  readonly action: Action;
  readonly group: string;
  readonly moduleClass: ModuleClass;
  readonly description: string;
  readonly sensitive: boolean;
}

const ACTION_VERB: Readonly<Record<Action, string>> = {
  view: 'View',
  create: 'Create',
  edit: 'Edit',
  delete: 'Delete',
  submit: 'Submit',
  approve: 'Approve',
  reject: 'Reject',
  post: 'Post to the ledger:',
  export: 'Export',
  print: 'Print',
  reopen: 'Reopen',
  write_off: 'Write off',
  register: 'Register',
  revoke: 'Revoke',
};

function build(): readonly CataloguePermission[] {
  const out: CataloguePermission[] = [];
  for (const mod of MODULES) {
    const actions = [...CLASS_ACTIONS[mod.class], ...(mod.extra ?? [])] as Action[];
    for (const action of actions) {
      const key = `${mod.key}.${action}`;
      out.push({
        key,
        module: mod.key,
        action,
        group: mod.group,
        moduleClass: mod.class,
        description: `${ACTION_VERB[action]} ${mod.label.toLowerCase()}`,
        sensitive: SENSITIVE_PERMISSIONS.has(key),
      });
    }
  }
  return out;
}

export const PERMISSIONS: readonly CataloguePermission[] = build();
export const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.key));
export const PERMISSION_BY_KEY: ReadonlyMap<string, CataloguePermission> = new Map(
  PERMISSIONS.map((p) => [p.key, p]),
);

/** Actions that authorise or record a business act. The Administrator holds none (P6 §5.5). */
export const BUSINESS_DECISION_ACTIONS: ReadonlySet<Action> = new Set(['approve', 'reject', 'post']);

export const ADMINISTRATOR_ROLE_CODE = 'ADMINISTRATOR';

/**
 * R-01 System Administrator (P6 §7.1): full user, role, workflow, system, numbering, notification and
 * document-type administration; audit and access-log view; health and job monitoring; view, create and
 * edit on reference lookups; device administration. NO business approve, reject or post, no payroll
 * view, no personal data.
 */
export const ADMINISTRATOR_PERMISSIONS: readonly string[] = [
  ...['user', 'role', 'workflow', 'system', 'notification', 'document'].flatMap((mod) =>
    CLASS_ACTIONS.master.map((a) => `${mod}.${a}`),
  ),
  'audit.view',
  'audit.export',
  ...['lookup', 'uom', 'tea_type', 'tea_grade', 'activity_type', 'shift', 'currency', 'country'].flatMap(
    (mod) => ['view', 'create', 'edit'].map((a) => `${mod}.${a}`),
  ),
  'device.view',
  'device.edit',
  'device.revoke',
  'sync.view',
];
