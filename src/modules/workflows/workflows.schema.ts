import { z } from 'zod';

import { OPERATORS } from '../../core/approval/conditions.js';
import { APPROVER_RULES, MAX_REPORTING_LEVEL, MAX_STEPS } from '../../core/approval/definition.js';
import { APPROVABLE_DOCUMENTS } from '../../core/approval/document-types.js';
import { zId } from '../../core/ids/ids.js';
import { RULE_STATES } from '../../core/rules/rule-table.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of approval workflows (Spec P7 §3, §5, §15, P3 §28.3). */

export const IdParams = z.object({ id: zId });

const DOCUMENT_KEYS = APPROVABLE_DOCUMENTS.map((d) => d.key);
const zCode = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use letters, digits, ".", "_" or "-".');
const zName = z.string().trim().min(1).max(150);
const zNotes = z.string().trim().max(500);

/** One test on one field of the document. Which operators and values fit depends on the field. */
export const ConditionBody = z.strictObject({
  field: z.string().trim().min(1).max(50),
  operator: z.enum(OPERATORS),
  /** A decimal string, an id or a code; a list for in / not_in; two numbers for between; none for flags. */
  value: z
    .union([z.string().max(60), z.array(z.string().max(60)).max(50)])
    .nullable()
    .optional(),
});

export const StepBody = z.strictObject({
  /** What the step is for, shown on the approval timeline. */
  name: z.string().trim().min(1).max(100).nullable().optional(),
  approver_rule: z.enum(APPROVER_RULES),
  role_id: zId.nullable().optional(),
  user_id: zId.nullable().optional(),
  reporting_level: z.number().int().min(1).max(MAX_REPORTING_LEVEL).nullable().optional(),
  /** When the step applies. Omitted or null: always. */
  condition: ConditionBody.nullable().optional(),
  allow_self_approval: z.boolean().optional(),
});
const zSteps = z.array(StepBody).min(1).max(MAX_STEPS);
const zConditions = z.array(ConditionBody).max(10);

export const CreateWorkflowBody = z.strictObject({
  code: zCode,
  name: zName,
  document_type: z.enum(DOCUMENT_KEYS),
  /** Narrows the workflow to one estate. Null: every estate. */
  estate_id: zId.nullable().optional(),
  department_id: zId.nullable().optional(),
  effective_from: zBusinessDate,
  effective_to: zBusinessDate.nullable().optional(),
  /** When the workflow applies at all. All must hold. */
  conditions: zConditions.optional(),
  notes: zNotes.nullable().optional(),
  /** In order: the first is step 1. */
  steps: zSteps,
});

/** The next version of an active workflow. It keeps the code, document type and scope. */
export const SupersedeWorkflowBody = z.strictObject({
  name: zName.optional(),
  effective_from: zBusinessDate,
  effective_to: zBusinessDate.nullable().optional(),
  conditions: zConditions.optional(),
  notes: zNotes.nullable().optional(),
  /** Omitted: the steps of the version being superseded are copied. */
  steps: zSteps.optional(),
});

export const PatchWorkflowBody = z
  .strictObject({
    code: zCode.optional(),
    name: zName.optional(),
    document_type: z.enum(DOCUMENT_KEYS).optional(),
    estate_id: zId.nullable().optional(),
    department_id: zId.nullable().optional(),
    effective_from: zBusinessDate.optional(),
    effective_to: zBusinessDate.nullable().optional(),
    conditions: zConditions.optional(),
    notes: zNotes.nullable().optional(),
    /** The whole list: steps are replaced as a set. */
    steps: zSteps.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.' });

export const ReturnBody = z.strictObject({ comment: z.string().trim().min(1).max(500) });
export const RejectBody = z.strictObject({ reason: z.string().trim().min(1).max(500) });
export const ApproveBody = z.strictObject({
  /** Required when the version takes effect in the past. */
  reason: z.string().trim().min(1).max(500).nullable().optional(),
});

export const PreviewQuery = z.object({
  /** The sample document: sample[total_base_amount]=300000&sample[estate_id]=3. Flags are true / false. */
  sample: z.record(z.string().max(50), z.string().max(60)).optional(),
});

const ConditionOut = z.object({
  field: z.string(),
  operator: z.enum(OPERATORS),
  value: z.union([z.string(), z.array(z.string())]).nullable(),
});

const StepOut = z.object({
  id: z.string(),
  step_number: z.number().int(),
  name: z.string().nullable(),
  approver_rule: z.enum(APPROVER_RULES),
  role_id: z.string().nullable(),
  role: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  user_id: z.string().nullable(),
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
  reporting_level: z.number().int().nullable(),
  condition: ConditionOut.nullable(),
  allow_self_approval: z.boolean(),
});

const WarningOut = z.object({
  /** ROLE_HAS_NO_HOLDER, APPROVER_CAN_CREATE, APPROVER_LACKS_PERMISSION. */
  code: z.string(),
  message: z.string(),
  /** The step it concerns, when it concerns one. */
  step_number: z.number().int().nullable(),
});

export const WorkflowOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  document_type: z.string(),
  document_type_label: z.string(),
  estate_id: z.string().nullable(),
  department_id: z.string().nullable(),
  /** estate 2 + department 1. The most specific active workflow governs a document. */
  specificity: z.number().int(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
  is_retrospective: z.boolean(),
  supersedes_id: z.string().nullable(),
  notes: z.string().nullable(),
  conditions: z.array(ConditionOut),
  state: z.enum(RULE_STATES),
  /** state is active. */
  is_active: z.boolean(),
  submitted_at: z.string().nullable(),
  submitted_by: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.string().nullable(),
  rejected_at: z.string().nullable(),
  rejected_by: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  created_by: z.string(),
  updated_at: z.string().nullable(),
  steps: z.array(StepOut),
  /** Things to look at that do not stop the workflow being saved. Absent on lists. */
  warnings: z.array(WarningOut).optional(),
});

export const DocumentTypeOut = z.object({
  key: z.string(),
  label: z.string(),
  approval_class: z.string(),
  tier: z.string(),
  /** Whether a step may ever allow self-approval on this document type. */
  self_approval_configurable: z.boolean(),
  fields: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      class: z.string(),
      operators: z.array(z.enum(OPERATORS)),
    }),
  ),
  /** The workflows in force today. None: documents of this type are approved on submission. */
  active_workflows: z.number().int(),
});

export const PreviewOut = z.object({
  workflow_id: z.string(),
  /** Whether the workflow's own condition holds for the sample. */
  applies: z.boolean(),
  sample: z.record(z.string(), z.string()),
  steps: z.array(
    z.object({
      step_number: z.number().int(),
      name: z.string().nullable(),
      approver_rule: z.enum(APPROVER_RULES),
      /** Whether the step is on this document's path. */
      fires: z.boolean(),
      /** Its position on the path (1, 2, …), or null when it does not fire. */
      path_position: z.number().int().nullable(),
      approvers: z.array(z.object({ id: z.string(), username: z.string() })),
      /** True for reporting-line and cost-centre steps: resolved only for a real submission. */
      approvers_deferred: z.boolean(),
      /** True when the step fires and nobody could act on it: it would raise an exception. */
      unresolved: z.boolean(),
    }),
  ),
});
