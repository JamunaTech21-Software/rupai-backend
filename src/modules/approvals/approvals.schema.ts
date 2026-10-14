import { z } from 'zod';

import { APPROVER_RULES } from '../../core/approval/definition.js';
import { APPROVABLE_DOCUMENTS } from '../../core/approval/document-types.js';
import { zId } from '../../core/ids/ids.js';
import { zTimestamp } from '../../core/time/dates.js';

/** Request and response schemas of the approval runtime (Spec P7 §4, §10–§14, P4 §14.1). */

export const IdParams = z.object({ id: zId });
export const REQUEST_STATES = ['pending', 'approved', 'rejected', 'returned'] as const;
const DOCUMENT_KEYS = APPROVABLE_DOCUMENTS.map((d) => d.key);

/** The step you are deciding on, as you saw it: if someone else got there first, you are told. */
const zStep = z.number().int().min(1).max(20);
export const ApproveBody = z.strictObject({
  step_number: zStep,
  comment: z.string().trim().max(1000).optional(),
});
export const RejectBody = z.strictObject({ step_number: zStep, reason: z.string().trim().min(1).max(1000) });
export const ReturnBody = z.strictObject({ step_number: zStep, comment: z.string().trim().min(1).max(1000) });
export const CommentBody = z.strictObject({ comment: z.string().trim().min(1).max(1000) });

export const DelegateBody = z.strictObject({
  from_user_id: zId,
  to_user_id: zId,
  /** Only this document type. Omitted or null: every type. */
  document_type: z.enum(DOCUMENT_KEYS).nullable().optional(),
  valid_from: zTimestamp,
  valid_to: zTimestamp,
  reason: z.string().trim().min(5).max(500),
});

export const HistoryQuery = z.object({
  document_type: z.enum(DOCUMENT_KEYS),
  document_id: zId,
});

const UserRef = z.object({ id: z.string(), username: z.string() });

export const QueueItemOut = z.object({
  approval_id: z.string(),
  document_type: z.string(),
  document_type_label: z.string(),
  document_id: z.string(),
  document_number: z.string().nullable(),
  document_label: z.string(),
  amount: z.string().nullable(),
  quantity: z.string().nullable(),
  estate_id: z.string().nullable(),
  submitted_by: UserRef,
  submitted_at: z.string(),
  /** The step you are asked to complete. Send it back as step_number. */
  step_number: z.number().int(),
  step_name: z.string().nullable(),
  /** When this step became current; the queue is sorted by it, oldest first. */
  waiting_since: z.string(),
  waiting_hours: z.number().int(),
  /** Set when you would act under a delegation. */
  acting_for: UserRef.nullable(),
  /** The document refused its final approval last time; see the approval for why. */
  has_guard_failure: z.boolean(),
});

const ActionOut = z.object({
  id: z.string(),
  action: z.enum(['approve', 'reject', 'return', 'comment']),
  step_number: z.number().int().nullable(),
  user: UserRef,
  acting_for: UserRef.nullable(),
  comment: z.string().nullable(),
  acted_at: z.string(),
  is_self_approval: z.boolean(),
  bulk_reference: z.string().nullable(),
});

export const ApprovalOut = z.object({
  id: z.string(),
  document_type: z.string(),
  document_type_label: z.string(),
  document_id: z.string(),
  document_number: z.string().nullable(),
  document_label: z.string(),
  amount: z.string().nullable(),
  quantity: z.string().nullable(),
  estate_id: z.string().nullable(),
  /** The workflow version that governed it, and the code of its chain. */
  workflow_id: z.string(),
  workflow_code: z.string(),
  state: z.enum(REQUEST_STATES),
  current_step_number: z.number().int().nullable(),
  /** The current step resolves to nobody: on the exception list (P7 §4.3). */
  is_unresolved: z.boolean(),
  is_exceptional: z.boolean(),
  /** The document's refusal at final approval, if the last attempt failed. */
  guard_failure: z
    .object({ code: z.string(), message: z.string(), at: z.string(), by: z.string() })
    .nullable(),
  submitted_by: UserRef,
  submitted_at: z.string(),
  completed_at: z.string().nullable(),
  version: z.number().int(),
  /** Every step of the workflow, in order. `on_path` false: its condition did not hold (P7 §3.3). */
  steps: z.array(
    z.object({
      step_number: z.number().int(),
      name: z.string().nullable(),
      approver_rule: z.enum(APPROVER_RULES),
      role: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
      user: UserRef.nullable(),
      on_path: z.boolean(),
      /** done | current | upcoming | skipped | not_reached */
      status: z.enum(['done', 'current', 'upcoming', 'skipped', 'not_reached']),
      /** Who completed it. */
      decided_by: UserRef.nullable(),
      decided_at: z.string().nullable(),
      /** For the current step: who may act now. */
      approvers: z.array(UserRef),
    }),
  ),
  actions: z.array(ActionOut),
  /** What the caller may do now. */
  can: z.object({ approve: z.boolean(), reject: z.boolean(), return: z.boolean(), comment: z.boolean() }),
});

export const ActResultOut = ApprovalOut;

export const DelegationOut = z.object({
  id: z.string(),
  from_user: UserRef,
  to_user: UserRef,
  document_type: z.string().nullable(),
  valid_from: z.string(),
  valid_to: z.string(),
  ended_at: z.string().nullable(),
  /** In force now. */
  is_active: z.boolean(),
  reason: z.string(),
  created_by: z.string(),
  created_at: z.string(),
});

export const HistoryOut = z.object({
  /** approval: an approval_action; status: a status_history transition of the document. */
  kind: z.enum(['approval', 'status']),
  at: z.string(),
  user: UserRef.nullable(),
  acting_for: UserRef.nullable(),
  action: z.string(),
  from_state: z.string().nullable(),
  to_state: z.string().nullable(),
  step_number: z.number().int().nullable(),
  comment: z.string().nullable(),
  approval_id: z.string().nullable(),
});
