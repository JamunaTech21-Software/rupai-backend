/**
 * What a notification rule can listen for (Spec P3 §28.5, P2 §5.23). The set is the system's: each
 * trigger is evaluated by the module that owns the data, in a job, never inside the business
 * transaction (P1 §4.3, §7.1). Rules (notification_rule) say who hears of it, how far ahead and how.
 *
 * Triggers whose module does not exist yet are listed, seeded and editable, but nothing evaluates them
 * until that module arrives (`evaluated: false`).
 */

export const TRIGGER_TYPES = [
  'approval_pending',
  'approval_unresolved',
  'document_expiry',
  'access_review',
  'budget_threshold',
  'payment_due',
  'abnormal_yield',
  'low_stock',
  'contract_expiry',
  'lease_due',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const RECIPIENT_RULES = ['approvers', 'by_role', 'by_scope', 'by_named_user'] as const;
export type RecipientRule = (typeof RECIPIENT_RULES)[number];

export const CHANNELS = ['in_app', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface TriggerDefinition {
  readonly key: TriggerType;
  readonly label: string;
  readonly description: string;
  /** Which recipient rules make sense: `approvers` only where the event names its approvers. */
  readonly recipientRules: readonly RecipientRule[];
  /** Whether lead_days means anything (a due or expiry date to look ahead to). */
  readonly usesLeadDays: boolean;
  /** Whether anything evaluates it yet, and if not, what brings it. */
  readonly evaluated: boolean;
  readonly arrivesWith: string | null;
}

const PEOPLE: readonly RecipientRule[] = ['by_role', 'by_scope', 'by_named_user'];

export const TRIGGERS: readonly TriggerDefinition[] = [
  {
    key: 'approval_pending',
    label: 'Approval pending',
    description: 'A document reached an approval step: its approvers (and their delegates) are told.',
    recipientRules: ['approvers'],
    usesLeadDays: false,
    evaluated: true,
    arrivesWith: null,
  },
  {
    key: 'approval_unresolved',
    label: 'Approval nobody can act on',
    description:
      'A step resolves to nobody (P7 §4.3): the administrators, and the approvers of the next step, are told.',
    recipientRules: PEOPLE,
    usesLeadDays: false,
    evaluated: true,
    arrivesWith: null,
  },
  {
    key: 'document_expiry',
    label: 'Document expiring',
    description: 'A licence, certificate or agreement on file expires within lead_days, or has expired.',
    recipientRules: PEOPLE,
    usesLeadDays: true,
    evaluated: true,
    arrivesWith: null,
  },
  {
    key: 'access_review',
    label: 'Access review findings',
    description:
      'The weekly access review (P6 §9.1) found conflicting or sensitive permissions held without authorisation.',
    recipientRules: PEOPLE,
    usesLeadDays: false,
    evaluated: true,
    arrivesWith: null,
  },
  {
    key: 'budget_threshold',
    label: 'Budget threshold reached',
    description: 'A budget line’s consumption reached its warning threshold.',
    recipientRules: PEOPLE,
    usesLeadDays: false,
    // P3.06: the nightly budget.notify_thresholds job (budget.jobs.ts).
    evaluated: true,
    arrivesWith: 'Budgets (Planning)',
  },
  {
    key: 'payment_due',
    label: 'Payment due or overdue',
    description: 'A receivable or payable falls due within lead_days, or is overdue.',
    recipientRules: PEOPLE,
    usesLeadDays: true,
    // P3.05: the nightly ageing job (accounting.jobs.ts) evaluates it; items arrive with their sources.
    evaluated: true,
    arrivesWith: 'Receivables and payables',
  },
  {
    key: 'abnormal_yield',
    label: 'Abnormal yield',
    description: 'A field’s plucking yield is outside its expected range.',
    recipientRules: PEOPLE,
    usesLeadDays: false,
    evaluated: false,
    arrivesWith: 'Plucking and yield',
  },
  {
    key: 'low_stock',
    label: 'Low stock',
    description: 'An item’s stock fell to or below its reorder level.',
    recipientRules: PEOPLE,
    usesLeadDays: false,
    // P4.04: raw materials, daily (inventory.jobs.ts); made tea joins with its module.
    evaluated: true,
    arrivesWith: 'Inventory',
  },
  {
    key: 'contract_expiry',
    label: 'Contract expiring',
    description: 'A contractor or supply contract ends within lead_days.',
    recipientRules: PEOPLE,
    usesLeadDays: true,
    // P2.05: contractor contracts (contractor.jobs.ts); supply contracts join with procurement.
    evaluated: true,
    arrivesWith: 'Contractors (Phase 2)',
  },
  {
    key: 'lease_due',
    label: 'Lease payment due',
    description: 'A land lease payment falls due within lead_days.',
    recipientRules: PEOPLE,
    usesLeadDays: true,
    evaluated: false,
    arrivesWith: 'Land and lease',
  },
];

export const TRIGGER_BY_KEY: ReadonlyMap<string, TriggerDefinition> = new Map(
  TRIGGERS.map((t) => [t.key, t]),
);
