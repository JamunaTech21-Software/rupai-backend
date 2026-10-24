import { z } from 'zod';

import { OPERATORS } from '../../core/approval/conditions.js';
import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { ACCOUNT_RESOLUTIONS, POSTING_PURPOSES, SIDES } from '../../core/posting/sources.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of posting rules (Spec P3 §27.7, D-3.03-9). */

const zKey = z
  .string()
  .trim()
  .min(1)
  .max(50)
  .regex(/^[a-z][a-z0-9_]*$/, 'lower_snake_case');

export const ConditionBody = z.strictObject({
  field: zKey,
  operator: z.enum(OPERATORS),
  value: z.union([z.string().max(100), z.array(z.string().max(100)).max(50), z.null()]),
});

export const RuleLineBody = z.strictObject({
  side: z.enum(SIDES),
  account_resolution: z.enum(ACCOUNT_RESOLUTIONS),
  /** fixed only. */
  account_id: zId.nullable().optional(),
  /**
   * Every resolution except fixed: the account field, or the component / category / charge type key the
   * document supplies, optionally with the record's account field ("asset_category:accumulated_account").
   */
  resolution_key: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[a-z][a-z0-9_]*(:[a-z][a-z0-9_]*)?$/, 'lower_snake_case, optionally key:field')
    .nullable()
    .optional(),
  amount_source: zKey,
  narration: z.string().trim().max(300).nullable().optional(),
});

const ruleFields = {
  rule_code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Z0-9][A-Z0-9_.-]*$/, 'Upper case letters, digits, ".", "_" or "-".'),
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).nullable(),
  source_type: zKey,
  purpose: z.enum(POSTING_PURPOSES),
  conditions: z.array(ConditionBody).max(10),
  sequence: z.number().int().min(1).max(1000),
  effective_from: zBusinessDate,
  effective_to: zBusinessDate.nullable(),
  /** In order: their position is their sequence. Replaced as a whole on edit. */
  lines: z.array(RuleLineBody).min(2).max(30),
};

export const CreateRuleBody = z.strictObject(ruleFields).partial().required({
  rule_code: true,
  name: true,
  source_type: true,
  purpose: true,
  effective_from: true,
  lines: true,
});
export const PatchRuleBody = z.strictObject(ruleFields).partial();

export const RuleLineOut = z.object({
  sequence: z.number().int(),
  side: z.enum(SIDES),
  account_resolution: z.enum(ACCOUNT_RESOLUTIONS),
  account_id: z.string().nullable(),
  account_code: z.string().nullable(),
  account_name: z.string().nullable(),
  resolution_key: z.string().nullable(),
  amount_source: z.string(),
  narration: z.string().nullable(),
  /** Whether this resolution can be used yet (D-3.03-4). */
  resolution_available: z.boolean(),
});

export const RuleOut = z.object({
  id: z.string(),
  rule_code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  source_type: z.string(),
  source_label: z.string(),
  purpose: z.enum(POSTING_PURPOSES),
  conditions: z.array(ConditionBody),
  sequence: z.number().int(),
  is_active: z.boolean(),
  effective_from: z.string(),
  effective_to: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.string().nullable(),
  lines: z.array(RuleLineOut),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type RuleOutT = z.infer<typeof RuleOut>;

const zAmount = zDecimal('money', { min: '0' });
export const PreviewBody = z.strictObject({
  date: zBusinessDate.optional(),
  amounts: z.record(
    zKey,
    z.union([
      zAmount,
      z
        .array(
          z.strictObject({
            amount: zAmount,
            accounts: z.record(zKey, zId).optional(),
            refs: z.record(zKey, zId).optional(),
            cost_centre_id: zId.optional(),
            estate_id: zId.optional(),
          }),
        )
        .max(100),
    ]),
  ),
  accounts: z.record(zKey, zId).optional(),
  cost_centre_id: zId.optional(),
  estate_id: zId.optional(),
});

export const PreviewOut = z.object({
  lines: z.array(
    z.object({
      rule_line: z.number().int(),
      side: z.enum(SIDES),
      account_id: z.string().nullable(),
      account_code: z.string().nullable(),
      account_name: z.string().nullable(),
      amount: z.string(),
      cost_centre_id: z.string().nullable(),
      estate_id: z.string().nullable(),
    }),
  ),
  total_debit: z.string(),
  total_credit: z.string(),
  balanced: z.boolean(),
  /** Accounts a resolver will find when its phase arrives. */
  unresolved: z.number().int(),
});

const named = z.object({ name: z.string(), label: z.string() });
export const SourceOut = z.object({
  key: z.string(),
  label: z.string(),
  phase: z.string(),
  purposes: z.array(z.enum(POSTING_PURPOSES)),
  amounts: z.array(named),
  account_fields: z.array(named),
  refs: z.array(named),
  condition_fields: z.array(named),
});
