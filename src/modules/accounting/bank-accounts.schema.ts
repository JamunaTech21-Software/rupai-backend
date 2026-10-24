import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { STATUSES } from './accounts.schema.js';

/** Request and response schemas of bank accounts (Spec P3 §27.2, P4 §13.3, D-3.02-6). */

export const ACCOUNT_KINDS = ['bank', 'cash', 'mobile_money'] as const;

const zCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');
const text = (max: number) => z.string().trim().min(1).max(max);

/** current_balance and last_reconciled_on are maintained by the system and never written. */
const bankFields = {
  code: zCode,
  name: text(150),
  account_id: zId,
  account_kind: z.enum(ACCOUNT_KINDS),
  bank_name: text(150).nullable(),
  branch_name: text(150).nullable(),
  account_number: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 .\-/]*$/, 'Letters, digits, spaces, ".", "-" or "/".')
    .nullable(),
  /** Omitted: the chart account's currency (the base currency when it has none). */
  currency_id: zId,
  estate_id: zId.nullable(),
  opening_balance: zDecimal('money'),
};

export const CreateBankAccountBody = z
  .strictObject(bankFields)
  .partial()
  .required({ code: true, name: true, account_id: true, account_kind: true });
export const ReplaceBankAccountBody = z.strictObject(bankFields);
export const PatchBankAccountBody = z.strictObject(bankFields).partial();

export const BankAccountOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  account_id: z.string(),
  account_code: z.string(),
  account_name: z.string(),
  account_kind: z.enum(ACCOUNT_KINDS),
  bank_name: z.string().nullable(),
  branch_name: z.string().nullable(),
  account_number: z.string().nullable(),
  currency_id: z.string(),
  currency_code: z.string(),
  estate_id: z.string().nullable(),
  opening_balance: z.string(),
  current_balance: z.string(),
  last_reconciled_on: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type BankAccountOutT = z.infer<typeof BankAccountOut>;
