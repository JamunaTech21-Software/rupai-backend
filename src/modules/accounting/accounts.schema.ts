import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  CONTROL_SUBLEDGERS,
  NORMAL_BALANCES,
  type AccountSubtype,
  type AccountType,
  type ControlSubledger,
  type NormalBalance,
} from './chart.js';

/** Request and response schemas of the chart of accounts (Spec P3 §27.1, P4 §13.3, D-3.01-*). */

export const STATUSES = ['active', 'inactive'] as const;
export type Status = (typeof STATUSES)[number];

export const IdParams = z.object({ id: zId });

/** P3 §27.1 code(30): the estate's own codes may carry separators ("01-1110", "A.1110"). */
const zCode = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');
const zName = z.string().trim().min(1).max(150);

/** What may be written. system_key, is_system, level, path and status are never written by a client. */
const accountFields = {
  code: zCode,
  name: zName,
  parent_id: zId.nullable(),
  account_type: z.enum(ACCOUNT_TYPES),
  account_subtype: z.enum(ACCOUNT_SUBTYPES).nullable(),
  is_postable: z.boolean(),
  is_control_account: z.boolean(),
  control_subledger: z.enum(CONTROL_SUBLEDGERS).nullable(),
  is_bank_or_cash: z.boolean(),
  currency_id: zId.nullable(),
  requires_cost_centre: z.boolean(),
  requires_estate: z.boolean(),
  is_clearing: z.boolean(),
};

/**
 * normal_balance is given only on creation, and only to make a contra account (D-3.01-6); omitted, it
 * follows the type. A top-level account gives its type; a child takes its parent's when omitted.
 */
export const CreateAccountBody = z
  .strictObject({ ...accountFields, normal_balance: z.enum(NORMAL_BALANCES) })
  .partial()
  .required({ code: true, name: true });
export const ReplaceAccountBody = z.strictObject(accountFields);
export const PatchAccountBody = z.strictObject(accountFields).partial();

export const AccountOut = z.object({
  id: z.string(),
  parent_id: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  account_type: z.enum(ACCOUNT_TYPES),
  account_subtype: z.enum(ACCOUNT_SUBTYPES).nullable(),
  normal_balance: z.enum(NORMAL_BALANCES),
  is_postable: z.boolean(),
  is_control_account: z.boolean(),
  control_subledger: z.enum(CONTROL_SUBLEDGERS).nullable(),
  is_bank_or_cash: z.boolean(),
  currency_id: z.string().nullable(),
  requires_cost_centre: z.boolean(),
  requires_estate: z.boolean(),
  is_clearing: z.boolean(),
  system_key: z.string().nullable(),
  is_system: z.boolean(),
  level: z.number().int(),
  path: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type AccountOutT = z.infer<typeof AccountOut>;

/** One node of GET /accounts/tree: the account and its children, nested. */
export interface AccountNode extends AccountOutT {
  children: AccountNode[];
}
export const AccountNodeOut: z.ZodType<AccountNode> = AccountOut.extend({
  get children() {
    return z.array(AccountNodeOut);
  },
});

/** POST /accounts/activate-chart: the accountant's sign-off of P8 (P3 §31.3, D-3.01-9). */
export const SignOffBody = z.strictObject({
  signed_off_by: zName,
  signed_off_on: zBusinessDate,
  reference: z.string().trim().min(1).max(100),
  note: z.string().trim().max(500).optional(),
});
export type SignOff = z.infer<typeof SignOffBody>;

export const SignOffOut = SignOffBody.extend({
  note: z.string().nullable(),
  recorded_by: z.string(),
  recorded_at: z.string(),
});
export type SignOffOutT = z.infer<typeof SignOffOut>;

export const ChartStatusOut = z.object({
  signed_off: z.boolean(),
  sign_off: SignOffOut.nullable(),
  accounts: z.object({
    total: z.number().int(),
    active: z.number().int(),
    inactive: z.number().int(),
    postable: z.number().int(),
    groups: z.number().int(),
  }),
});

export const RemoveUnusedOut = z.object({ removed: z.number().int(), remaining: z.number().int() });

export type { AccountSubtype, AccountType, ControlSubledger, NormalBalance };
