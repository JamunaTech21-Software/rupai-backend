import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of the calendars (Spec P3 §4.8–§4.10, P4 §7.2). */

export const SEASON_STATES = ['planned', 'active', 'closed'] as const;
export type SeasonState = (typeof SEASON_STATES)[number];
export const FISCAL_YEAR_STATES = ['future', 'open', 'closed'] as const;
export type FiscalYearState = (typeof FISCAL_YEAR_STATES)[number];
/** P1 Table 14.1. soft_closed, closed and reopened are reached in P10.02 (period close). */
export const PERIOD_STATES = ['future', 'open', 'soft_closed', 'closed', 'reopened'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

/** Period 13 is reserved for year-end adjustments (P3 §4.10). */
export const ADJUSTMENT_PERIOD = 13;

export const IdParams = z.object({ id: zId });

const zCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');
const zName = z.string().trim().min(1).max(150);

// ---- season -----------------------------------------------------------------------------------------

const seasonFields = {
  code: zCode,
  name: zName,
  start_date: zBusinessDate,
  end_date: zBusinessDate,
};
export const CreateSeasonBody = z.strictObject({ estate_id: zId, ...seasonFields });
/** A planned season: everything. An active one: name and end_date only. A closed one: nothing. */
export const ReplaceSeasonBody = z.strictObject(seasonFields);
export const PatchSeasonBody = z.strictObject(seasonFields).partial();

export const SeasonOut = z.object({
  id: z.string(),
  estate_id: z.string(),
  code: z.string(),
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  state: z.enum(SEASON_STATES),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- fiscal year ------------------------------------------------------------------------------------

export const CreateFiscalYearBody = z.strictObject({
  /** The calendar year the fiscal year STARTS in. Its dates follow from the organisation's start month. */
  start_year: z.number().int().min(1990).max(2200),
  /** Defaults to FY2026-27 (or FY2026 when the fiscal year is the calendar year). */
  code: zCode.optional(),
  name: zName.optional(),
});
const fiscalYearFields = { code: zCode, name: zName };
export const ReplaceFiscalYearBody = z.strictObject(fiscalYearFields);
export const PatchFiscalYearBody = z.strictObject(fiscalYearFields).partial();

export const FiscalYearOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  state: z.enum(FISCAL_YEAR_STATES),
  /** 0 until generate-periods has run, then 13. */
  period_count: z.number().int(),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- accounting period ------------------------------------------------------------------------------

export const AccountingPeriodOut = z.object({
  id: z.string(),
  fiscal_year_id: z.string(),
  period_number: z.number().int(),
  name: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  state: z.enum(PERIOD_STATES),
  /** Period 13: year-end adjustments. Never chosen by date, only named explicitly. */
  is_adjustment: z.boolean(),
  closed_at: z.string().nullable(),
  closed_by: z.string().nullable(),
  reopened_at: z.string().nullable(),
  reopened_by: z.string().nullable(),
  reopen_reason: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string().nullable(),
});
