import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/**
 * Request and response schemas of employment assignments (P2.03; Spec P3 §8.3, P4 §6.5, P7 §9.6; the
 * manager's design, the employment and salary sections of Add New Worker / Add New Employee, BACKLOG
 * D-2-3).
 */

export const WAGE_BASES = ['daily', 'monthly', 'hourly', 'piece_rate', 'quantity', 'fixed'] as const;
export const CHANGE_REASONS = [
  'joining',
  'transfer',
  'promotion',
  'demotion',
  'wage_revision',
  'other',
] as const;
export const ASSIGNMENT_STATES = ['draft', 'submitted', 'approved', 'rejected'] as const;
/** The design's Salary & Payroll lines, in its order. */
export const PAY_COMPONENTS = ['basic', 'house_rent', 'medical', 'conveyance', 'other'] as const;

export const AssignmentParams = z.object({ id: zId });
export const AsOfQuery = z.strictObject({
  /** The date to resolve; today when omitted. */
  as_of: zBusinessDate.optional(),
});

const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const PayLine = z.strictObject({
  component: z.enum(PAY_COMPONENTS),
  amount: zDecimal('money', { min: '0' }),
});

const fields = {
  /** Required for an employee (the design's employee form). */
  department_id: nullable(zId),
  /** Required for an employee. */
  designation_id: nullable(zId),
  /** The design's Garden / Unit: a division of the profile's estate. Taken from the section when omitted. */
  division_id: nullable(zId),
  /** Required for a worker. Within the division when both are given. */
  section_id: nullable(zId),
  /** The design's Job / Task (GET /lookups/activity-types). Required for a worker. */
  activity_type_id: nullable(zId),
  /** Where labour cost is charged: accepted from Phase 3 (cost centres, P3.02). */
  cost_centre_id: nullable(zId),
  default_shift_id: nullable(zId),
  /** daily for a worker, monthly for an employee when omitted. */
  wage_basis: z.enum(WAGE_BASES),
  /** Overrides the category's wage rule; null resolves from wage_rule (exceptional, P3 §8.3). */
  base_rate: nullable(zDecimal('money', { min: '0' })),
  effective_from: zBusinessDate,
  change_reason: z.enum(CHANGE_REASONS),
  remarks: nullable(z.string().trim().max(500)),
  /** The salary structure: one line per component at most; replaced as a whole. */
  pay_lines: z
    .array(PayLine)
    .max(PAY_COMPONENTS.length)
    .refine((l) => new Set(l.map((x) => x.component)).size === l.length, 'Each component appears once.'),
};

/** A new assignment is a draft: submit it to put it into effect. */
export const CreateAssignmentBody = z.strictObject(fields).partial().required({ effective_from: true });
export const ReplaceAssignmentBody = z.strictObject(fields);
export const PatchAssignmentBody = z.strictObject(fields).partial();

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const AssignmentOut = z.object({
  id: z.string(),
  employment_profile_id: z.string(),
  profile: z.object({
    id: z.string(),
    profile_number: z.string(),
    /** worker | employee (profile.schema imports this file, so the list is not imported back). */
    employment_type: z.enum(['worker', 'employee']),
    full_name: z.string(),
  }),
  estate_id: z.string(),
  department_id: z.string().nullable(),
  department: Ref.nullable(),
  designation_id: z.string().nullable(),
  designation: Ref.nullable(),
  division_id: z.string().nullable(),
  division: Ref.nullable(),
  section_id: z.string().nullable(),
  section: Ref.nullable(),
  activity_type_id: z.string().nullable(),
  activity_type: Ref.nullable(),
  cost_centre_id: z.string().nullable(),
  default_shift_id: z.string().nullable(),
  default_shift: Ref.nullable(),
  wage_basis: z.enum(WAGE_BASES),
  base_rate: z.string().nullable(),
  pay_lines: z.array(z.object({ component: z.enum(PAY_COMPONENTS), amount: z.string() })),
  /** The design's "Total Salary (Auto)": the sum of pay_lines; null without lines. */
  total_pay: z.string().nullable(),
  effective_from: z.string(),
  /** null: open-ended. Set when the next assignment is approved. */
  effective_to: z.string().nullable(),
  change_reason: z.enum(CHANGE_REASONS),
  remarks: z.string().nullable(),
  /** Pay differs from the assignment it follows: approval is required (P7 §9.6). */
  is_wage_change: z.boolean(),
  /** Starts before the day it was submitted: arrears may follow (P1 §10.7). */
  is_retrospective: z.boolean(),
  state: z.enum(ASSIGNMENT_STATES),
  /** approved, and today within effective_from … effective_to. */
  is_current: z.boolean(),
  /** The pending approval, while submitted: act on it with POST /approvals/{id}/approve|reject|return. */
  approval_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
  submitted_by: z.object({ id: z.string(), username: z.string() }).nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.object({ id: z.string(), username: z.string() }).nullable(),
  rejected_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/** The few fields of the current assignment the profile lists show (Department, Designation, Section …). */
export const CurrentAssignmentOut = z
  .object({
    id: z.string(),
    effective_from: z.string(),
    department: Ref.nullable(),
    designation: Ref.nullable(),
    division: Ref.nullable(),
    section: Ref.nullable(),
    activity_type: Ref.nullable(),
    wage_basis: z.enum(WAGE_BASES),
  })
  .nullable();
