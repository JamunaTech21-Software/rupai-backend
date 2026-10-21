import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of goals and evaluations (P2.10; Spec P3 §24.2–§24.3, P4 §12.4). */

export const GOAL_OWNER_TYPES = ['employment_profile', 'department', 'estate'] as const;
export const GOAL_STATES = [
  'draft',
  'submitted',
  'active',
  'in_progress',
  'delayed',
  'overdue',
  'completed',
  'rejected',
  'cancelled',
] as const;
export const EVALUATION_TYPES = ['annual', 'probation', 'project'] as const;
export const EVALUATION_STATES = ['draft', 'submitted', 'approved', 'rejected', 'acknowledged'] as const;
export const RATINGS = ['outstanding', 'exceeds', 'meets', 'needs_improvement', 'unsatisfactory'] as const;

export const IdParams = z.object({ id: zId });
const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const pct = zDecimal('pct', { min: '0', max: '100' });

const goalFields = {
  owner_type: z.enum(GOAL_OWNER_TYPES),
  /** The profile, department or estate. */
  owner_id: zId,
  /** Required for a department goal (a department spans estates); otherwise the owner's estate. */
  estate_id: zId,
  parent_goal_id: nullable(zId),
  title: z.string().trim().min(3).max(200),
  description: nullable(z.string().trim().max(500)),
  kpi_name: nullable(z.string().trim().max(150)),
  measure_unit: nullable(z.string().trim().max(50)),
  target_value: nullable(zDecimal('money')),
  weight: nullable(zDecimal('pct', { positive: true })),
  start_date: zBusinessDate,
  due_date: zBusinessDate,
  review_date: nullable(zBusinessDate),
};
export const CreateGoalBody = z
  .strictObject(goalFields)
  .partial()
  .required({ owner_type: true, owner_id: true, title: true, start_date: true, due_date: true });
export const PatchGoalBody = z
  .strictObject(goalFields)
  .omit({ owner_type: true, owner_id: true, estate_id: true })
  .partial();
export const ProgressBody = z.strictObject({
  progress_date: zBusinessDate,
  /** The KPI's value: the percentage is value ÷ target when a target is set. */
  value: nullable(zDecimal('money')).optional(),
  /** Required without a target value. */
  progress_percentage: pct.optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export const CancelGoalBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export const CalendarQuery = z.strictObject({
  from: zBusinessDate,
  to: zBusinessDate,
  estate_id: zId.optional(),
  owner_type: z.enum(GOAL_OWNER_TYPES).optional(),
  owner_id: zId.optional(),
});
export const OverviewQuery = z.strictObject({
  estate_id: zId.optional(),
  owner_type: z.enum(GOAL_OWNER_TYPES).optional(),
  owner_id: zId.optional(),
});

export const GoalOut = z.object({
  id: z.string(),
  goal_code: z.string(),
  owner_type: z.enum(GOAL_OWNER_TYPES),
  owner_id: z.string(),
  /** The profile's name, the department's or the estate's. */
  owner_name: z.string().nullable(),
  estate_id: z.string(),
  parent_goal_id: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  kpi_name: z.string().nullable(),
  measure_unit: z.string().nullable(),
  target_value: z.string().nullable(),
  current_value: z.string(),
  weight: z.string().nullable(),
  start_date: z.string(),
  due_date: z.string(),
  review_date: z.string().nullable(),
  progress_percentage: z.string(),
  state: z.enum(GOAL_STATES),
  approval_id: z.string().nullable(),
  completed_at: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});
export const ProgressOut = z.object({
  id: z.string(),
  goal_id: z.string(),
  progress_date: z.string(),
  value: z.string().nullable(),
  progress_percentage: z.string(),
  note: z.string().nullable(),
  recorded_by: z.object({ id: z.string(), username: z.string() }),
  created_at: z.string(),
});
export const CalendarOut = z.object({
  goal_id: z.string(),
  goal_code: z.string(),
  title: z.string(),
  /** start | review | due */
  kind: z.enum(['start', 'review', 'due']),
  date: z.string(),
  state: z.enum(GOAL_STATES),
});
export const OverviewOut = z.object({
  total: z.number().int(),
  completed: z.number().int(),
  /** active and in progress */
  in_progress: z.number().int(),
  delayed: z.number().int(),
  overdue: z.number().int(),
  draft: z.number().int(),
  cancelled: z.number().int(),
});

const Line = z.strictObject({
  /** GET /lookups/evaluation_criteria */
  criteria_id: zId,
  weight: zDecimal('pct', { positive: true }).optional(),
  /** 0 … the criterion's max_score. */
  score: nullable(zDecimal('pct', { min: '0' })).optional(),
  /** A goal of the evaluated profile, for a goal-linked criterion. */
  goal_id: nullable(zId).optional(),
  comment: z.string().trim().max(500).nullable().optional(),
});
const evaluationFields = {
  employment_profile_id: zId,
  reviewer_profile_id: nullable(zId),
  period_start: zBusinessDate,
  period_end: zBusinessDate,
  evaluation_type: z.enum(EVALUATION_TYPES),
  strengths: nullable(z.string().trim().max(1000)),
  development_needs: nullable(z.string().trim().max(1000)),
  reviewer_comment: nullable(z.string().trim().max(1000)),
};
export const CreateEvaluationBody = z
  .strictObject({ ...evaluationFields, lines: z.array(Line).max(50) })
  .partial()
  .required({ employment_profile_id: true, period_start: true, period_end: true, evaluation_type: true });
export const PatchEvaluationBody = z
  .strictObject(evaluationFields)
  .omit({ employment_profile_id: true })
  .partial();
export const LinesBody = z.strictObject({
  lines: z
    .array(Line)
    .max(50)
    .refine(
      (l) => new Set(l.map((x) => String(x.criteria_id))).size === l.length,
      'Each criterion appears once.',
    ),
});
export const AcknowledgeBody = z.strictObject({
  employee_comment: z.string().trim().max(1000).nullable().optional(),
});

export const EvaluationOut = z.object({
  id: z.string(),
  evaluation_number: z.string(),
  employment_profile_id: z.string(),
  profile: z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() }),
  estate_id: z.string(),
  reviewer_profile_id: z.string().nullable(),
  reviewer: z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() }).nullable(),
  period_start: z.string(),
  period_end: z.string(),
  evaluation_type: z.enum(EVALUATION_TYPES),
  /** Σ weighted scores ÷ Σ weights × 100 over the scored lines. */
  overall_score: z.string().nullable(),
  overall_rating: z.enum(RATINGS).nullable(),
  strengths: z.string().nullable(),
  development_needs: z.string().nullable(),
  reviewer_comment: z.string().nullable(),
  employee_comment: z.string().nullable(),
  acknowledged_at: z.string().nullable(),
  lines: z.array(
    z.object({
      id: z.string(),
      criteria_id: z.string(),
      criteria: z.object({ id: z.string(), code: z.string(), name: z.string(), criteria_group: z.string() }),
      goal_id: z.string().nullable(),
      weight: z.string(),
      score: z.string().nullable(),
      max_score: z.string(),
      weighted_score: z.string().nullable(),
      comment: z.string().nullable(),
      sequence: z.number().int(),
    }),
  ),
  state: z.enum(EVALUATION_STATES),
  /** acknowledged: locked for good. */
  is_locked: z.boolean(),
  approval_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});
