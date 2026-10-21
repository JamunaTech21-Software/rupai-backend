import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/**
 * Request and response schemas of leave entitlements and leave requests (P2.07; Spec P3 §22, P9 §12,
 * P7 §7.9, P4 §8.3).
 */

export const LEAVE_STATES = ['draft', 'submitted', 'approved', 'rejected', 'cancelled'] as const;

export const IdParams = z.object({ id: zId });

export const GenerateBody = z.strictObject({
  fiscal_year_id: zId,
  /** Only this estate's profiles; every estate you may change when omitted. */
  estate_id: zId.optional(),
  /** Only this profile (a new joiner during the year). */
  employment_profile_id: zId.optional(),
});
export const GenerateOut = z.object({
  fiscal_year_id: z.string(),
  /** New entitlements. Existing ones are never regenerated (adjust them instead). */
  created: z.number().int(),
  existing: z.number().int(),
});

export const AdjustBody = z.strictObject({
  /** Replaces the adjustment (may be negative). 0 clears it. */
  adjustment_days: zDecimal('pct', { min: '-366', max: '366' }),
  reason: z.string().trim().min(3).max(300),
});

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
const ProfileRef = z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() });

export const EntitlementOut = z.object({
  id: z.string(),
  employment_profile_id: z.string(),
  profile: ProfileRef,
  leave_type_id: z.string(),
  leave_type: Ref,
  fiscal_year_id: z.string(),
  fiscal_year: z.object({ id: z.string(), code: z.string() }),
  entitled_days: z.string(),
  carried_forward_days: z.string(),
  adjustment_days: z.string(),
  adjustment_reason: z.string().nullable(),
  /** entitled + carried forward + adjustment. */
  total_available: z.string(),
  consumed_days: z.string(),
  encashed_days: z.string(),
  /** Submitted, not yet decided. */
  pending_days: z.string(),
  /** total available − consumed − encashed. */
  balance_days: z.string(),
  /** balance − pending: what a new request may still take. */
  available_to_request: z.string(),
  allows_negative_balance: z.boolean(),
  version: z.number().int(),
});

const requestFields = {
  /** Whose leave: your own when omitted. */
  employment_profile_id: zId,
  leave_type_id: zId,
  from_date: zBusinessDate,
  to_date: zBusinessDate,
  /** A half day: from_date = to_date, counts 0.5. */
  is_half_day: z.boolean(),
  reason: z.string().trim().max(500).nullable(),
  contact_during_leave: z.string().trim().max(30).nullable(),
  /** Who covers: a profile of the same estate. */
  covering_profile_id: zId.nullable(),
};
export const CreateLeaveBody = z
  .strictObject(requestFields)
  .partial()
  .required({ leave_type_id: true, from_date: true, to_date: true });
export const PatchLeaveBody = z.strictObject(requestFields).omit({ employment_profile_id: true }).partial();
export const CancelBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

export const LeaveOut = z.object({
  id: z.string(),
  request_number: z.string(),
  employment_profile_id: z.string(),
  profile: ProfileRef,
  estate_id: z.string(),
  leave_type_id: z.string(),
  leave_type: Ref,
  from_date: z.string(),
  to_date: z.string(),
  /** Working days: weekly offs excluded (setting leave.weekly_off_days); holidays from P5.01. */
  day_count: z.string(),
  is_half_day: z.boolean(),
  is_paid: z.boolean(),
  reason: z.string().nullable(),
  contact_during_leave: z.string().nullable(),
  covering_profile_id: z.string().nullable(),
  covering: ProfileRef.nullable(),
  leave_entitlement_id: z.string().nullable(),
  /** The balance of the entitlement now (null for a type without entitlement). */
  balance_days: z.string().nullable(),
  state: z.enum(LEAVE_STATES),
  /** While submitted: act on it with POST /approvals/{id}/approve|reject|return. */
  approval_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.object({ id: z.string(), username: z.string() }).nullable(),
  rejected_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
