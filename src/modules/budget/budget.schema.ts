import { z } from 'zod';

import { CONSUMPTION_SOURCES, CONSUMPTION_TYPES, CONTROL_MODES } from '../../core/budget/budget.js';
import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of budgets, budget lines and budget controls (Spec P3 §26.3–§26.6, P4 §13). */

export const BUDGET_TYPES = ['operating', 'capital'] as const;
export const BUDGET_STATES = ['draft', 'submitted', 'approved', 'rejected', 'active', 'superseded'] as const;
export const CONTROL_STATES = ['draft', 'submitted', 'active', 'rejected', 'superseded'] as const;
export const VARIANCE_LABELS = ['surplus', 'overrun', 'on_budget'] as const;

export const BudgetLineBody = z.strictObject({
  budget_head_id: zId,
  cost_centre_id: zId.nullable().optional(),
  annual_amount: zDecimal('money', { positive: true }),
  /** 12 amounts, month 1 to 12 of the fiscal year, summing to annual_amount. Omitted: spread evenly. */
  allocations: z
    .array(zDecimal('money', { min: '0' }))
    .length(12)
    .optional(),
  notes: z.string().trim().max(300).nullable().optional(),
});

const budgetFields = {
  fiscal_year_id: zId,
  /** Empty: an organisation-wide budget. */
  estate_id: zId.nullable(),
  department_id: zId.nullable(),
  name: z.string().trim().min(1).max(150),
  budget_type: z.enum(BUDGET_TYPES),
  notes: z.string().trim().max(500).nullable(),
  /** One per (budget head, cost centre). Replaced as a whole on edit. */
  lines: z.array(BudgetLineBody).max(500),
};
export const CreateBudgetBody = z
  .strictObject(budgetFields)
  .partial()
  .required({ fiscal_year_id: true, name: true, budget_type: true });
export const PatchBudgetBody = z.strictObject(budgetFields).partial();

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
const userRef = z.object({ id: z.string(), username: z.string() }).nullable();
const docRef = z.object({ id: z.string(), budget_code: z.string() }).nullable();
const variance = z.object({
  /** annual − actual, as a positive amount. */
  amount: z.string(),
  /** Never a bare signed number (P9 §19.2). */
  label: z.enum(VARIANCE_LABELS),
});

export const BudgetLineOut = z.object({
  id: z.string(),
  budget: z.object({ id: z.string(), budget_code: z.string(), state: z.enum(BUDGET_STATES) }),
  budget_head: ref.extend({ head_type: z.string() }),
  cost_centre: ref.nullable(),
  estate: ref.nullable(),
  annual_amount: z.string(),
  committed_amount: z.string(),
  actual_amount: z.string(),
  available_amount: z.string(),
  /** null: not applicable (annual 0). */
  utilisation_percentage: z.string().nullable(),
  variance,
  allocations: z.array(
    z.object({
      month_number: z.number().int(),
      period: z.object({ id: z.string(), name: z.string() }),
      amount: z.string(),
    }),
  ),
  notes: z.string().nullable(),
  sequence: z.number().int(),
});
export type BudgetLineOutT = z.infer<typeof BudgetLineOut>;

export const BudgetOut = z.object({
  id: z.string(),
  budget_code: z.string(),
  fiscal_year: z.object({ id: z.string(), code: z.string() }),
  estate: ref.nullable(),
  department: ref.nullable(),
  name: z.string(),
  budget_type: z.enum(BUDGET_TYPES),
  revision_number: z.number().int(),
  supersedes: docRef,
  /** The revision that replaced or is replacing this budget. */
  revised_by: docRef,
  total_amount: z.string(),
  committed_amount: z.string(),
  actual_amount: z.string(),
  available_amount: z.string(),
  utilisation_percentage: z.string().nullable(),
  notes: z.string().nullable(),
  state: z.enum(BUDGET_STATES),
  approval_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
  submitted_by: userRef,
  approved_at: z.string().nullable(),
  approved_by: userRef,
  rejection_reason: z.string().nullable(),
  activated_at: z.string().nullable(),
  activated_by: userRef,
  line_count: z.number().int(),
  /** On GET /budgets/{id} and after a write. */
  lines: z.array(BudgetLineOut).optional(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type BudgetOutT = z.infer<typeof BudgetOut>;

export const ConsumptionOut = z.object({
  id: z.string(),
  budget_line_id: z.string(),
  consumption_type: z.enum(CONSUMPTION_TYPES),
  source_type: z.enum(CONSUMPTION_SOURCES),
  source_id: z.string(),
  consumption_date: z.string(),
  period: z.object({ id: z.string(), name: z.string() }),
  amount: z.string(),
  /** A release: the commitment it releases. */
  releases_id: z.string().nullable(),
  /** A commitment: the release that closed it. */
  released_by_id: z.string().nullable(),
  /** Set on a reversal row (which counts negative). */
  reversal_of_id: z.string().nullable(),
  created_at: z.string(),
});

export const AvailabilityQuery = z.strictObject({
  budget_head_id: zId,
  cost_centre_id: zId.optional(),
  estate_id: zId.optional(),
  department_id: zId.optional(),
  date: zBusinessDate,
  /** Omitted: 0 (the line's figures only). */
  amount: zDecimal('money', { min: '0' }).optional(),
});
const controlOut = z.object({
  mode: z.enum(CONTROL_MODES),
  /** null: no control row applies (organisation default warn) or the head is not controlled. */
  control_id: z.string().nullable(),
  warning_threshold_percentage: z.string().nullable(),
  critical_threshold_percentage: z.string().nullable(),
  overrun_tolerance_percentage: z.string().nullable(),
  escalation_role_id: z.string().nullable(),
});
export const AvailabilityOut = z.object({
  /** null: no active budget line covers the head (no consumption; the control decides). */
  line: z.object({ id: z.string(), budget_id: z.string(), budget_code: z.string() }).nullable(),
  annual: z.string().nullable(),
  committed: z.string().nullable(),
  actual: z.string().nullable(),
  available: z.string().nullable(),
  utilisation: z.string().nullable(),
  available_after: z.string().nullable(),
  control: controlOut,
  exceeded: z.boolean(),
  /** ok, or the control mode that applies to the overrun. */
  outcome: z.enum(['ok', ...CONTROL_MODES]),
});

export const VS_ACTUAL_GROUPS = ['head', 'cost_centre', 'period'] as const;
export const VsActualQuery = z.strictObject({ group_by: z.enum(VS_ACTUAL_GROUPS).default('head') });
const vsRow = z.object({
  key: z.string().nullable(),
  code: z.string().nullable(),
  label: z.string(),
  /** By head or cost centre: the annual amount; by period: the month's allocation. */
  budget: z.string(),
  committed: z.string(),
  actual: z.string(),
  available: z.string(),
  utilisation_percentage: z.string().nullable(),
  variance,
});
export const VsActualOut = z.object({
  budget: z.object({ id: z.string(), budget_code: z.string(), name: z.string() }),
  group_by: z.enum(VS_ACTUAL_GROUPS),
  rows: z.array(vsRow),
  total: vsRow,
});

// ---- budget controls (D-3.06-10) ------------------------------------------------------------------------

const controlFields = {
  /** Empty: the organisation default. */
  budget_head_id: zId.nullable(),
  estate_id: zId.nullable(),
  fiscal_year_id: zId.nullable(),
  control_mode: z.enum(CONTROL_MODES),
  warning_threshold_percentage: zDecimal('pct', { positive: true }).nullable(),
  critical_threshold_percentage: zDecimal('pct', { positive: true }).nullable(),
  overrun_tolerance_percentage: zDecimal('pct', { min: '0' }).nullable(),
  escalation_role_id: zId.nullable(),
};
export const CreateControlBody = z.strictObject(controlFields).partial().required({ control_mode: true });
export const PatchControlBody = z.strictObject(controlFields).partial();

export const ControlOut = z.object({
  id: z.string(),
  budget_head: ref.nullable(),
  estate: ref.nullable(),
  fiscal_year: z.object({ id: z.string(), code: z.string() }).nullable(),
  control_mode: z.enum(CONTROL_MODES),
  warning_threshold_percentage: z.string().nullable(),
  critical_threshold_percentage: z.string().nullable(),
  overrun_tolerance_percentage: z.string().nullable(),
  escalation_role: ref.nullable(),
  supersedes_id: z.string().nullable(),
  state: z.enum(CONTROL_STATES),
  approval_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type ControlOutT = z.infer<typeof ControlOut>;
