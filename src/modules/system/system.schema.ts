import { z } from 'zod';

import { RESET_FREQUENCIES } from '../../core/numbering/numbering.js';
import { zId } from '../../core/ids/ids.js';
import { SETTING_TYPES } from '../../core/settings/settings.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of number formats and system settings (Spec P3 §28.6, P4 §14). */

export const IdParams = z.object({ id: zId });
export const SEPARATORS = ['-', '/', '.', ''] as const;
export const NUMBER_COMPONENTS = ['estate', 'fiscal_year', 'season'] as const;

// ---- number formats ---------------------------------------------------------------------------------

const formatFields = {
  prefix: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{1,20}$/, 'Use 1–20 letters or digits.')
    .transform((v) => v.toUpperCase()),
  include_fiscal_year: z.boolean(),
  include_season: z.boolean(),
  include_estate_code: z.boolean(),
  separator: z.enum(SEPARATORS),
  sequence_width: z.number().int().min(3).max(12),
  reset_frequency: z.enum(RESET_FREQUENCIES),
};
/** document_type and is_gapless are the system's, not the client's: one row per document type. */
export const ReplaceNumberFormatBody = z.strictObject(formatFields);
export const PatchNumberFormatBody = z.strictObject(formatFields).partial();

export const NumberFormatOut = z.object({
  id: z.string(),
  document_type: z.string(),
  /** The document's name, for display. */
  label: z.string(),
  /** financial: gapless, numbered at posting. operational: numbered at draft creation. */
  lifecycle: z.enum(['financial', 'operational']),
  /** The optional parts this document can carry; only these may be switched on. */
  available_components: z.array(z.enum(NUMBER_COMPONENTS)),
  prefix: z.string(),
  include_fiscal_year: z.boolean(),
  include_season: z.boolean(),
  include_estate_code: z.boolean(),
  separator: z.string(),
  sequence_width: z.number().int(),
  reset_frequency: z.enum(RESET_FREQUENCIES),
  is_gapless: z.boolean(),
  /** What a number looks like with this format (sample estate, fiscal year and season codes). */
  example: z.string(),
  version: z.number().int(),
  updated_at: z.string().nullable(),
});

export const PreviewQuery = z.object({
  date: zBusinessDate.optional(),
  estate_code: z.string().trim().min(1).max(20).optional(),
  fiscal_year_code: z.string().trim().min(1).max(20).optional(),
  season_code: z.string().trim().min(1).max(20).optional(),
});
export const NumberPreviewOut = z.object({
  /** The number the next allocation in this scope would get. Nothing is allocated by asking. */
  next_number: z.string(),
  scope_key: z.string(),
  last_number: z.string(),
});
export const NumberSequenceOut = z.object({
  scope_key: z.string(),
  last_number: z.string(),
  updated_at: z.string(),
});

// ---- system settings --------------------------------------------------------------------------------

const zKey = z
  .string()
  .trim()
  .max(100)
  .regex(
    /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/,
    'Use lower-case dotted names, e.g. attendance.grace_minutes.',
  );
/** Checked against value_type by the service: a string, number, boolean, JSON value, or null to clear. */
const zValue = z.unknown();
const zGroup = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{0,49}$/, 'Use a lower-case name.');
const zDescription = z.string().trim().max(500).nullable();

export const CreateSettingBody = z.strictObject({
  key: zKey,
  value_type: z.enum(SETTING_TYPES),
  /** Defaults to the first part of the key. */
  group: zGroup.optional(),
  /** Stored encrypted and never returned. Fixed at creation. */
  is_encrypted: z.boolean().optional(),
  value: zValue,
  description: zDescription.optional(),
});
/** key, value_type and is_encrypted are fixed at creation. */
export const ReplaceSettingBody = z.strictObject({ group: zGroup, value: zValue, description: zDescription });
export const PatchSettingBody = z.strictObject({
  group: zGroup.optional(),
  value: zValue.optional(),
  description: zDescription.optional(),
});

export const SettingOut = z.object({
  id: z.string(),
  key: z.string(),
  group: z.string(),
  value_type: z.enum(SETTING_TYPES),
  is_encrypted: z.boolean(),
  /** Always null for an encrypted setting (write-only): see has_value. */
  value: z.unknown(),
  has_value: z.boolean(),
  description: z.string().nullable(),
  version: z.number().int(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
});
