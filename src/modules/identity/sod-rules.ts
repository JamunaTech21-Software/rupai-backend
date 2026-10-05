import { PERMISSION_KEYS, PERMISSIONS, SENSITIVE_PERMISSIONS } from './permission-catalogue.js';

/**
 * Separation of duties (Spec P6 §5.3, Table 5.1, normative) and sensitive permissions (P6 §10).
 *
 * Each rule is expanded into concrete COMBINATIONS: sets of permissions that must not all be held by one
 * user. The check runs on the union of a user's roles (P6 §9.1), because a conflict usually comes from a
 * combination of roles rather than from one role.
 *
 * A conflict does not forbid the assignment; it requires an explicit override with a recorded reason
 * (P6 §9.1). A small estate may not have enough people to honour every rule, and a recorded override
 * makes that a known, reviewable risk rather than an invisible one.
 */

export interface SodRule {
  /** Stable code, recorded on every override. */
  readonly code: string;
  readonly title: string;
  readonly why: string;
  /** Each entry is one combination: holding ALL of its permissions is a conflict. */
  readonly combinations: readonly (readonly string[])[];
}

const MODULE_KEYS = [...new Set(PERMISSIONS.map((p) => p.module))];
const has = (key: string) => PERMISSION_KEYS.has(key);
const pairsOn = (a: string, b: string) =>
  MODULE_KEYS.filter((m) => has(`${m}.${a}`) && has(`${m}.${b}`)).map((m) => [`${m}.${a}`, `${m}.${b}`]);

/** Approve and post on financial documents ("any financial approve or post", P6 Table 5.1 row 4). */
const FINANCIAL_DECISIONS = PERMISSIONS.filter(
  (p) => p.moduleClass === 'financial' && (p.action === 'approve' || p.action === 'post'),
).map((p) => p.key);

/** P6 Table 5.1, in order. */
export const SOD_RULES: readonly SodRule[] = [
  {
    code: 'SOD-1',
    title: 'Create and approve on the same document type',
    why: 'One person could raise and authorise their own document.',
    combinations: pairsOn('create', 'approve'),
  },
  {
    code: 'SOD-2',
    title: 'Approve and post on the same document type',
    why: 'Business authorisation and accounting entry are deliberately separate acts; one person holding both removes the accounting review.',
    combinations: pairsOn('approve', 'post'),
  },
  {
    code: 'SOD-3',
    title: 'Payroll approve or post with employment edit',
    why: 'One person could change a wage assignment, then approve and post the payroll that pays it.',
    combinations: [
      ['employment.edit', 'payroll.approve'],
      ['employment.edit', 'payroll.post'],
    ],
  },
  {
    code: 'SOD-4',
    title: 'User or role administration with any financial approve or post',
    why: 'A user who can grant themselves permissions has, in effect, every permission. The most serious combination.',
    combinations: ['user.edit', 'role.edit'].flatMap((admin) =>
      FINANCIAL_DECISIONS.map((fin) => [admin, fin]),
    ),
  },
  {
    code: 'SOD-5',
    title: 'Stock adjustment approval with inventory export and sale creation',
    why: 'Stock could be written off and disposed of outside the sales process.',
    combinations: [['stock_adjustment.approve', 'inventory.export', 'sale.create']],
  },
  {
    code: 'SOD-6',
    title: 'Supplier edit with payment approval',
    why: 'Bank details could be changed and a payment to them authorised.',
    combinations: [['supplier.edit', 'payment.approve']],
  },
  {
    code: 'SOD-7',
    title: 'Collection with receivable write-off',
    why: 'A receipt could be diverted and the balance written off.',
    combinations: [['collection.create', 'receivable.write_off']],
  },
];

export const SENSITIVE_RULE_CODE = 'SENSITIVE';

/** Why each sensitive permission is sensitive (P6 Table 10.1). */
export const SENSITIVE_WHY: Readonly<Record<string, string>> = {
  'user.edit': 'Grants the ability to grant: effectively confers every other permission.',
  'role.edit': 'Grants the ability to grant: effectively confers every other permission.',
  'payroll.post': 'Writes the largest recurring expense to the ledger.',
  'payroll.export': 'Produces a file containing every worker’s pay.',
  'journal.post': 'Direct ledger entry outside the operational flow.',
  'accounting_period.reopen': 'Reopens a closed period, making published figures changeable.',
  'statutory_rule.approve': 'Activates a legal rate: the last line of defence on statutory correctness.',
  'wage_rule.approve': 'Changes what workers are paid.',
  'receivable.write_off': 'Removes a debt: the classic concealment route.',
  'stock_adjustment.approve': 'Removes stock without a sale.',
  'payment.approve': 'Authorises money leaving the organisation.',
  'person.export': 'Personal data of every worker.',
  'employment.export': 'Personal data of every worker.',
  'audit.view': 'A user who can read the audit log can see who is watching them.',
  'device.revoke': 'Clears a device’s local store at next contact, including unsynced records.',
};

/** Something a user's permissions require a named, recorded authorisation for. */
export interface Requirement {
  /** Stable identity: `SOD-2:payroll.approve+payroll.post` or `SENSITIVE:payroll.post`. */
  readonly key: string;
  readonly kind: 'sod_override' | 'sensitive_grant';
  readonly rule: string;
  readonly title: string;
  readonly why: string;
  readonly permissions: readonly string[];
}

export const requirementKey = (rule: string, permissions: readonly string[]) =>
  `${rule}:${[...permissions].sort().join('+')}`;

/** Every prohibited combination and every sensitive permission in a permission set. */
export function requirementsFor(permissions: ReadonlySet<string>): Requirement[] {
  const out: Requirement[] = [];
  for (const rule of SOD_RULES) {
    for (const combo of rule.combinations) {
      if (combo.every((p) => permissions.has(p))) {
        const sorted = [...combo].sort();
        out.push({
          key: requirementKey(rule.code, sorted),
          kind: 'sod_override',
          rule: rule.code,
          title: rule.title,
          why: rule.why,
          permissions: sorted,
        });
      }
    }
  }
  for (const p of [...SENSITIVE_PERMISSIONS].sort()) {
    if (permissions.has(p)) {
      out.push({
        key: requirementKey(SENSITIVE_RULE_CODE, [p]),
        kind: 'sensitive_grant',
        rule: SENSITIVE_RULE_CODE,
        title: `Sensitive permission ${p}`,
        why: SENSITIVE_WHY[p] ?? 'Listed in P6 Table 10.1.',
        permissions: [p],
      });
    }
  }
  return out;
}
