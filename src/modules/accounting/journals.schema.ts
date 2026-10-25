import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { SIDES } from '../../core/posting/sources.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of journals, the general ledger and opening balances (Spec P3 §27.3–§27.6, P4 §13.3). */

export const JOURNAL_TYPES = ['automatic', 'manual', 'opening', 'closing', 'reversal', 'adjustment'] as const;
/** What /journals creates (D-3.04-2). */
export const MANUAL_TYPES = ['manual', 'adjustment', 'opening'] as const;
export const JOURNAL_STATES = ['draft', 'submitted', 'approved', 'rejected', 'posted'] as const;

export const DraftLineBody = z.strictObject({
  account_id: zId,
  side: z.enum(SIDES),
  /** Transaction currency. */
  amount: zDecimal('money', { positive: true }),
  cost_centre_id: zId.nullable().optional(),
  /** Omitted: the journal's estate. */
  estate_id: zId.nullable().optional(),
  department_id: zId.nullable().optional(),
  budget_head_id: zId.nullable().optional(),
  narration: z.string().trim().max(300).nullable().optional(),
});

const journalFields = {
  journal_type: z.enum(MANUAL_TYPES),
  journal_date: zBusinessDate,
  /** Mandatory, shown in full in the approval queue (P7 §8.9). */
  narration: z.string().trim().min(1).max(500),
  reference: z.string().trim().min(1).max(50).nullable(),
  estate_id: zId.nullable(),
  /** Omitted: the base currency at rate 1. */
  currency_id: zId.nullable(),
  exchange_rate: zDecimal('rate', { positive: true }).nullable(),
  /** In order: their position is their line number. Replaced as a whole on edit. */
  lines: z.array(DraftLineBody).max(500),
};

export const CreateJournalBody = z
  .strictObject(journalFields)
  .partial()
  .required({ journal_type: true, journal_date: true, narration: true });
export const PatchJournalBody = z.strictObject(journalFields).partial();
export const ReverseJournalBody = z.strictObject({
  /** On or after the original's date. */
  date: zBusinessDate,
  narration: z.string().trim().min(1).max(500).optional(),
});

const ref = z.object({ id: z.string(), code: z.string(), name: z.string() });
const userRef = z.object({ id: z.string(), username: z.string() }).nullable();

export const JournalLineOut = z.object({
  line_number: z.number().int(),
  account: ref,
  side: z.enum(SIDES),
  /** Transaction currency. */
  amount: z.string(),
  /** Base currency; null before posting. */
  base_amount: z.string().nullable(),
  cost_centre: ref.nullable(),
  estate: ref.nullable(),
  department_id: z.string().nullable(),
  budget_head_id: z.string().nullable(),
  party_type: z.string().nullable(),
  party_id: z.string().nullable(),
  narration: z.string().nullable(),
});

export const JournalOut = z.object({
  id: z.string(),
  /** Allocated at posting (gapless); null before. */
  journal_number: z.string().nullable(),
  journal_type: z.enum(JOURNAL_TYPES),
  journal_date: z.string(),
  period: z.object({ id: z.string(), name: z.string(), state: z.string() }),
  fiscal_year: z.object({ id: z.string(), code: z.string() }),
  narration: z.string(),
  reference: z.string().nullable(),
  source_type: z.string().nullable(),
  source_id: z.string().nullable(),
  posting_rule_id: z.string().nullable(),
  estate: ref.nullable(),
  currency: z.object({ id: z.string(), code: z.string() }),
  exchange_rate: z.string(),
  /** Transaction currency, from the lines (drafts too). */
  transaction_debit: z.string(),
  transaction_credit: z.string(),
  /** Base currency; set at posting. */
  total_debit: z.string(),
  total_credit: z.string(),
  is_balanced: z.boolean(),
  is_prior_period: z.boolean(),
  reversal_of: z.object({ id: z.string(), journal_number: z.string().nullable() }).nullable(),
  reversed_by: z.object({ id: z.string(), journal_number: z.string().nullable() }).nullable(),
  is_reversed: z.boolean(),
  state: z.enum(JOURNAL_STATES),
  approval_id: z.string().nullable(),
  submitted_at: z.string().nullable(),
  submitted_by: userRef,
  approved_at: z.string().nullable(),
  approved_by: userRef,
  rejection_reason: z.string().nullable(),
  posted_at: z.string().nullable(),
  posted_by: userRef,
  created_by: userRef,
  line_count: z.number().int(),
  /** On GET /journals/{id} and after a write; omitted from lists. */
  lines: z.array(JournalLineOut).optional(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
export type JournalOutT = z.infer<typeof JournalOut>;

// ---- general ledger (D-3.04-8) ------------------------------------------------------------------------

export const LedgerQuery = z.strictObject({
  from: zBusinessDate,
  to: zBusinessDate,
  estate_id: zId.optional(),
  cost_centre_id: zId.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** A balance on the account's normal side: positive is normal, negative is the other side. */
export const LedgerOut = z.object({
  account: z.object({
    id: z.string(),
    code: z.string(),
    name: z.string(),
    account_type: z.string(),
    normal_balance: z.enum(SIDES),
    is_postable: z.boolean(),
  }),
  from: z.string(),
  to: z.string(),
  fiscal_year: z.object({ id: z.string(), code: z.string() }),
  estate_id: z.string().nullable(),
  cost_centre_id: z.string().nullable(),
  opening: z.string(),
  period_debit: z.string(),
  period_credit: z.string(),
  closing: z.string(),
  /** This page: from the first line after the cursor. */
  lines: z.array(
    z.object({
      journal_id: z.string(),
      journal_number: z.string().nullable(),
      journal_type: z.enum(JOURNAL_TYPES),
      journal_date: z.string(),
      line_number: z.number().int(),
      account: z.object({ id: z.string(), code: z.string(), name: z.string() }),
      narration: z.string(),
      reference: z.string().nullable(),
      source_type: z.string().nullable(),
      source_id: z.string().nullable(),
      cost_centre_id: z.string().nullable(),
      estate_id: z.string().nullable(),
      debit: z.string(),
      credit: z.string(),
      balance: z.string(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

// ---- opening balances (D-3.04-9) ----------------------------------------------------------------------

export const OpeningBalanceOut = z.object({
  id: z.string(),
  account: ref,
  fiscal_year: z.object({ id: z.string(), code: z.string() }),
  cost_centre: ref.nullable(),
  estate: ref.nullable(),
  debit: z.string(),
  credit: z.string(),
  source: z.enum(['migration', 'rollover']),
  journal: z.object({ id: z.string(), journal_number: z.string().nullable() }),
  created_at: z.string(),
});

// ---- expenses (D-3.04-10) -----------------------------------------------------------------------------

export const EXPENSE_GROUPS = ['account', 'cost_centre', 'estate', 'period'] as const;
export const ExpensesQuery = z.strictObject({
  /** Periods by date: every monthly period from the one covering `from` to the one covering `to`. */
  from: zBusinessDate,
  to: zBusinessDate,
  group_by: z.enum(EXPENSE_GROUPS).default('account'),
  estate_id: zId.optional(),
  cost_centre_id: zId.optional(),
});
export const ExpensesOut = z.object({
  from: z.string(),
  to: z.string(),
  periods: z.array(z.object({ id: z.string(), name: z.string() })),
  group_by: z.enum(EXPENSE_GROUPS),
  estate_id: z.string().nullable(),
  cost_centre_id: z.string().nullable(),
  /** Net expense (debit − credit) in base currency. */
  total: z.string(),
  rows: z.array(
    z.object({
      key: z.string().nullable(),
      code: z.string().nullable(),
      label: z.string(),
      amount: z.string(),
    }),
  ),
});
