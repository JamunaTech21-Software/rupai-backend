import type { ErrorDetail } from '../errors/app-error.js';
import {
  checkCondition,
  evaluateAll,
  evaluateCondition,
  fieldOf,
  rangeOf,
  rangesDisjoint,
  rangeWithin,
  type Condition,
  type DocumentValues,
} from './conditions.js';
import { approvableDocument, NEVER_SELF_APPROVE, type ApprovableDocument } from './document-types.js';

/**
 * A workflow definition and the checks made on it when it is saved (Spec P7 §3.1, §15.2). Each check
 * catches a configuration error that would otherwise surface as a stuck document weeks later.
 *
 * The checks here need nothing but the definition itself, so they are pure and unit-tested:
 *
 *   1. every condition references a field the document type has, with an operator and value that suit it
 *   2. at least one step is unconditional, so no document can evaluate to an empty path
 *   3. numeric conditions on one field form a sensible ladder across the steps
 *   +  each step names exactly what its approver rule needs
 *   +  self-approval is never switched on where P7 Table 12.1 says "never"
 *
 * The remaining checks of §15.2 need the database and live in the workflows module: that every named
 * role and user exists (4), the separation-of-duties warning (5), and that no two active workflows hold
 * the same scope and date (6, enforced by the rule core on activation).
 */

export const APPROVER_RULES = [
  'by_role',
  'by_reporting_line',
  'by_named_user',
  'by_cost_centre_manager',
] as const;
export type ApproverRule = (typeof APPROVER_RULES)[number];

export const MAX_STEPS = 10;
export const MAX_REPORTING_LEVEL = 5;

export interface StepDefinition {
  readonly name: string | null;
  readonly approverRule: ApproverRule;
  readonly roleId: string | null;
  readonly userId: string | null;
  /** by_reporting_line: 1 is the submitter's supervisor, 2 the supervisor's supervisor … */
  readonly reportingLevel: number | null;
  /** When this step applies. Null: always. */
  readonly condition: Condition | null;
  readonly allowSelfApproval: boolean;
}

export interface WorkflowDefinition {
  readonly documentType: string;
  /** When the workflow applies at all. Every condition must hold. Empty: always. */
  readonly conditions: readonly Condition[];
  readonly steps: readonly StepDefinition[];
}

const err = (
  field: string,
  code: string,
  message: string,
  context?: Record<string, unknown>,
): ErrorDetail => ({
  field,
  code,
  message,
  ...(context ? { context } : {}),
});

function checkApprover(document: ApprovableDocument, s: StepDefinition, path: string): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  const wants = {
    role: s.approverRule === 'by_role',
    user: s.approverRule === 'by_named_user',
    level: s.approverRule === 'by_reporting_line',
  };
  const need = (field: string, wanted: boolean, present: boolean, what: string) => {
    if (wanted && !present)
      out.push(err(`${path}.${field}`, 'WORKFLOW_STEP_INVALID', `${s.approverRule} needs ${what}.`));
    if (!wanted && present) {
      out.push(err(`${path}.${field}`, 'WORKFLOW_STEP_INVALID', `${s.approverRule} takes no ${what}.`));
    }
  };
  need('role_id', wants.role, s.roleId !== null, 'a role');
  need('user_id', wants.user, s.userId !== null, 'a user');
  need('reporting_level', wants.level, s.reportingLevel !== null, 'a reporting level');
  if (
    s.reportingLevel !== null &&
    (!Number.isInteger(s.reportingLevel) || s.reportingLevel < 1 || s.reportingLevel > MAX_REPORTING_LEVEL)
  ) {
    out.push(
      err(
        `${path}.reporting_level`,
        'WORKFLOW_STEP_INVALID',
        `The reporting level is 1 (the submitter's supervisor) to ${String(MAX_REPORTING_LEVEL)}.`,
      ),
    );
  }
  if (s.approverRule === 'by_cost_centre_manager' && !fieldOf(document, 'cost_centre_id')) {
    out.push(
      err(
        `${path}.approver_rule`,
        'WORKFLOW_STEP_INVALID',
        `A ${document.label.toLowerCase()} has no cost centre, so its manager cannot approve it.`,
      ),
    );
  }
  return out;
}

/** Check 3: for one numeric field, a later step's range is disjoint from, or inside, each earlier one. */
function checkLadder(document: ApprovableDocument, steps: readonly StepDefinition[]): ErrorDetail[] {
  const out: ErrorDetail[] = [];
  steps.forEach((later, j) => {
    const c = later.condition;
    const range = c ? rangeOf(c) : null;
    if (!c || !range) return;
    for (let i = 0; i < j; i += 1) {
      const earlier = steps[i]?.condition;
      const earlierRange = earlier?.field === c.field ? rangeOf(earlier) : null;
      if (!earlierRange) continue;
      if (rangesDisjoint(earlierRange, range) || rangeWithin(range, earlierRange)) continue;
      out.push(
        err(
          `steps.${String(j)}.condition`,
          'WORKFLOW_LADDER_INVALID',
          `Step ${String(j + 1)} and step ${String(i + 1)} both test ${fieldOf(document, c.field)?.label ?? c.field}, ` +
            'but their ranges only partly overlap. A later step must cover a higher band inside the earlier ' +
            'one (a ladder), or a band that does not overlap it at all.',
          { step: j + 1, earlier_step: i + 1, field: c.field },
        ),
      );
      return;
    }
  });
  return out;
}

/** Every problem with a definition that can be found without the database. Empty: it is well-formed. */
export function checkDefinition(def: WorkflowDefinition): ErrorDetail[] {
  const document = approvableDocument(def.documentType);
  if (!document) {
    return [
      err(
        'document_type',
        'WORKFLOW_DOCUMENT_TYPE_UNKNOWN',
        `"${def.documentType}" is not an approvable document type.`,
      ),
    ];
  }
  const out: ErrorDetail[] = [];
  def.conditions.forEach((c, i) => out.push(...checkCondition(document, c, `conditions.${String(i)}`)));

  if (def.steps.length === 0 || def.steps.length > MAX_STEPS) {
    out.push(err('steps', 'WORKFLOW_STEP_INVALID', `A workflow has 1 to ${String(MAX_STEPS)} steps.`));
    return out;
  }
  const before = out.length;
  def.steps.forEach((s, i) => {
    const path = `steps.${String(i)}`;
    out.push(...checkApprover(document, s, path));
    if (s.condition) {
      out.push(...checkCondition(document, s.condition, `${path}.condition`));
    }
    if (s.allowSelfApproval && NEVER_SELF_APPROVE.has(document.approvalClass)) {
      out.push(
        err(
          `${path}.allow_self_approval`,
          'WORKFLOW_SELF_APPROVAL_FORBIDDEN',
          `Nobody may approve their own ${document.label.toLowerCase()}: self-approval cannot be allowed on this document type.`,
          { approval_class: document.approvalClass },
        ),
      );
    }
  });
  if (!def.steps.some((s) => s.condition === null)) {
    out.push(
      err(
        'steps',
        'WORKFLOW_NO_UNCONDITIONAL_STEP',
        'Every step has a condition, so a document meeting none of them would have no approver. At least one step must always apply.',
      ),
    );
  }
  // The ladder is judged only once every step is individually sound.
  if (out.length === before) out.push(...checkLadder(document, def.steps));
  return out;
}

/** Whether the workflow applies to this document at all. */
export function workflowApplies(
  def: Pick<WorkflowDefinition, 'conditions'>,
  values: DocumentValues,
): boolean {
  return evaluateAll(def.conditions, values);
}

/**
 * The steps a document would go through (P7 §3.3): every step whose condition holds, in order. Returned
 * as indexes into `steps`. At runtime this is computed once, at submission, and frozen.
 */
export function pathFor(
  steps: readonly Pick<StepDefinition, 'condition'>[],
  values: DocumentValues,
): number[] {
  return steps.flatMap((s, i) => (s.condition === null || evaluateCondition(s.condition, values) ? [i] : []));
}
