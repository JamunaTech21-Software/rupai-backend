import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/**
 * Request and response schemas of benefit entitlements, benefit issues and welfare cases (P2.08; Spec P3
 * §23, P7 §7; the design's Ration Card tab of Add New Worker).
 */

export const ENTITLEMENT_STATES = ['draft', 'submitted', 'approved', 'rejected', 'withdrawn'] as const;
export const ISSUE_STATES = ['draft', 'submitted', 'approved', 'rejected'] as const;
export const CASE_STATES = ['draft', 'submitted', 'approved', 'rejected', 'closed'] as const;
export const BENEFICIARY_TYPES = ['employment_profile', 'person', 'community'] as const;
export const WELFARE_CATEGORIES = [
  'medical',
  'education',
  'disaster',
  'bereavement',
  'community',
  'other',
] as const;

export const IdParams = z.object({ id: zId });
const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const money = zDecimal('money', { min: '0' });

const entitlementFields = {
  employment_profile_id: zId,
  /** GET /lookups/benefit_type */
  benefit_type_id: zId,
  /** The design's Issue Date. */
  effective_from: zBusinessDate,
  /** The design's Valid Till; open-ended when null. */
  effective_to: nullable(zBusinessDate),
  quantity_per_period: nullable(zDecimal('qty', { min: '0' })),
  employer_cost_per_period: nullable(money),
  employee_contribution: money,
  /** The design's Ration Card No. (or a quarter / house number). */
  allocation_reference: nullable(z.string().trim().max(50)),
  /** The design's Ration Dealer / Office. */
  issuing_office: nullable(z.string().trim().max(150)),
};
export const CreateEntitlementBody = z
  .strictObject(entitlementFields)
  .partial()
  .required({ employment_profile_id: true, benefit_type_id: true, effective_from: true });
export const PatchEntitlementBody = z
  .strictObject(entitlementFields)
  .omit({ employment_profile_id: true })
  .partial();
export const WithdrawBody = z.strictObject({
  /** The last day of the entitlement. */
  effective_to: zBusinessDate,
  reason: z.string().trim().min(3).max(300),
});

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
const ProfileRef = z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() });
const UserRef = z.object({ id: z.string(), username: z.string() });

export const BenefitEntitlementOut = z.object({
  id: z.string(),
  employment_profile_id: z.string(),
  profile: ProfileRef,
  estate_id: z.string(),
  benefit_type_id: z.string(),
  benefit_type: Ref.extend({ benefit_category: z.string(), payroll_treatment: z.string() }),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
  quantity_per_period: z.string().nullable(),
  employer_cost_per_period: z.string().nullable(),
  employee_contribution: z.string(),
  allocation_reference: z.string().nullable(),
  issuing_office: z.string().nullable(),
  withdrawal_reason: z.string().nullable(),
  state: z.enum(ENTITLEMENT_STATES),
  /** approved and today within its dates. */
  is_current: z.boolean(),
  approval_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: UserRef.nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});

export const CreateIssueBody = z.strictObject({
  benefit_entitlement_id: zId,
  issue_date: zBusinessDate,
  period_reference: z.string().trim().max(30).nullable().optional(),
  /** The entitlement's quantity per period when omitted. */
  quantity: nullable(zDecimal('qty', { min: '0' })).optional(),
  /** The entitlement's cost per period (else the type's default) when omitted. */
  employer_cost: money.optional(),
  employee_contribution: money.optional(),
  issued_by_profile_id: nullable(zId).optional(),
});
export const GenerateIssuesBody = z.strictObject({
  benefit_type_id: zId,
  estate_id: zId,
  issue_date: zBusinessDate,
  period_reference: z.string().trim().max(30).nullable().optional(),
});
export const GenerateIssuesOut = z.object({ created: z.number().int(), existing: z.number().int() });

export const BenefitIssueOut = z.object({
  id: z.string(),
  benefit_entitlement_id: z.string(),
  profile: ProfileRef,
  benefit_type: Ref,
  estate_id: z.string(),
  issue_date: z.string(),
  period_reference: z.string().nullable(),
  quantity: z.string().nullable(),
  employer_cost: z.string(),
  employee_contribution: z.string(),
  issued_by_profile_id: z.string().nullable(),
  state: z.enum(ISSUE_STATES),
  approval_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});

const caseFields = {
  estate_id: zId,
  beneficiary_type: z.enum(BENEFICIARY_TYPES),
  /** A profile or a person of the estate; null for a community case. */
  beneficiary_id: nullable(zId),
  welfare_category: z.enum(WELFARE_CATEGORIES),
  case_date: zBusinessDate,
  description: z.string().trim().min(3).max(500),
  requested_amount: nullable(money),
};
export const CreateCaseBody = z
  .strictObject(caseFields)
  .partial({ beneficiary_id: true, requested_amount: true });
export const PatchCaseBody = z.strictObject(caseFields).omit({ estate_id: true }).partial();
export const DisburseBody = z.strictObject({ amount: zDecimal('money', { positive: true }) });
export const CloseBody = z.strictObject({ outcome: z.string().trim().min(3).max(500) });

export const WelfareCaseOut = z.object({
  id: z.string(),
  case_number: z.string(),
  estate_id: z.string(),
  beneficiary_type: z.enum(BENEFICIARY_TYPES),
  beneficiary_id: z.string().nullable(),
  /** The beneficiary's name (profile or person); null for the community. */
  beneficiary_name: z.string().nullable(),
  welfare_category: z.enum(WELFARE_CATEGORIES),
  case_date: z.string(),
  description: z.string(),
  requested_amount: z.string().nullable(),
  approved_amount: z.string().nullable(),
  disbursed_amount: z.string(),
  /** approved − disbursed. */
  remaining_amount: z.string().nullable(),
  outcome: z.string().nullable(),
  state: z.enum(CASE_STATES),
  approval_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});
