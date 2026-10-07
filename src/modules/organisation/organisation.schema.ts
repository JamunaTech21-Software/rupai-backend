import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of the organisation hierarchy (Spec P3 §4.1–§4.5, P4 §7.1). */

export const STATUSES = ['active', 'inactive'] as const;
export type Status = (typeof STATUSES)[number];
export const OWNERSHIP_TYPES = ['owned', 'leased', 'government_lease', 'other'] as const;
export const FIELD_STATUSES = ['producing', 'young', 'nursery', 'uprooted', 'fallow', 'abandoned'] as const;

export const IdParams = z.object({ id: zId });

const zCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');
const zName = z.string().trim().min(1).max(150);
const text = (max: number) => z.string().trim().max(max);
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 -]{4,26}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');
const zEmail = z.email().max(150);
/** Hectares, DECIMAL(14,3). */
const zArea = zDecimal('qty', { min: '0' });
/** An employment profile id. Checked once employment_profile exists (Phase 2, BACKLOG D-1.07-2). */
const zProfileId = zId;

const nullable = <T extends z.ZodType>(t: T) => t.nullable();

// ---- organisation (singleton) ---------------------------------------------------------------------

const organisationFields = {
  name: zName,
  short_name: z.string().trim().min(1).max(50),
  registration_number: nullable(text(50)),
  tin: nullable(text(30)),
  vat_registration: nullable(text(30)),
  address_line1: nullable(text(200)),
  address_line2: nullable(text(200)),
  city: nullable(text(100)),
  postal_code: nullable(text(20)),
  phone: nullable(zPhone),
  email: nullable(zEmail),
  website: nullable(text(150)),
  fiscal_year_start_month: z.number().int().min(1).max(12),
};
export const ReplaceOrganisationBody = z.strictObject(organisationFields);
export const PatchOrganisationBody = z.strictObject(organisationFields).partial();

export const OrganisationOut = z.object({
  id: z.string(),
  name: z.string(),
  short_name: z.string(),
  registration_number: z.string().nullable(),
  tin: z.string().nullable(),
  vat_registration: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  city: z.string().nullable(),
  postal_code: z.string().nullable(),
  /** Set once country exists (P1.10). */
  country_id: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  logo_path: z.string().nullable(),
  /** Set once currency exists (P1.10). */
  base_currency_id: z.string().nullable(),
  fiscal_year_start_month: z.number().int(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  updated_at: z.string().nullable(),
});

// ---- estate -----------------------------------------------------------------------------------------

const estateFields = {
  code: zCode,
  name: zName,
  location: nullable(text(200)),
  address_line1: nullable(text(200)),
  district: nullable(text(100)),
  total_area: nullable(zArea),
  manager_profile_id: nullable(zProfileId),
  phone: nullable(zPhone),
  email: nullable(zEmail),
  established_on: nullable(zBusinessDate),
  ownership_type: nullable(z.enum(OWNERSHIP_TYPES)),
  remarks: nullable(text(500)),
};
/** Create: code and name required, everything else optional (omitted = NULL). */
export const CreateEstateBody = z.strictObject(estateFields).partial().required({ code: true, name: true });
export const ReplaceEstateBody = z.strictObject(estateFields);
export const PatchEstateBody = z.strictObject(estateFields).partial();

export const EstateOut = z.object({
  id: z.string(),
  organisation_id: z.string(),
  code: z.string(),
  name: z.string(),
  location: z.string().nullable(),
  address_line1: z.string().nullable(),
  district: z.string().nullable(),
  total_area: z.string().nullable(),
  manager_profile_id: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  established_on: z.string().nullable(),
  ownership_type: z.enum(OWNERSHIP_TYPES).nullable(),
  status: z.enum(STATUSES),
  remarks: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- division ---------------------------------------------------------------------------------------

const divisionFields = {
  code: zCode,
  name: zName,
  manager_profile_id: nullable(zProfileId),
  area: nullable(zArea),
};
export const CreateDivisionBody = z
  .strictObject(divisionFields)
  .partial()
  .required({ code: true, name: true });
export const ReplaceDivisionBody = z.strictObject(divisionFields);
export const PatchDivisionBody = z.strictObject(divisionFields).partial();

export const DivisionOut = z.object({
  id: z.string(),
  estate_id: z.string(),
  code: z.string(),
  name: z.string(),
  manager_profile_id: z.string().nullable(),
  area: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- section ----------------------------------------------------------------------------------------

const sectionFields = {
  code: zCode,
  name: zName,
  supervisor_profile_id: nullable(zProfileId),
  area: nullable(zArea),
};
export const CreateSectionBody = z.strictObject(sectionFields).partial().required({ code: true, name: true });
export const ReplaceSectionBody = z.strictObject(sectionFields);
export const PatchSectionBody = z.strictObject(sectionFields).partial();

export const SectionOut = z.object({
  id: z.string(),
  division_id: z.string(),
  /** Reached through the division (P3 §4.4: not stored on section). */
  estate_id: z.string(),
  code: z.string(),
  name: z.string(),
  supervisor_profile_id: z.string().nullable(),
  area: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- field ------------------------------------------------------------------------------------------

const fieldFields = {
  field_number: zCode,
  name: nullable(zName),
  gross_area: zDecimal('qty', { positive: true }),
  planted_area: nullable(zArea),
  field_status: z.enum(FIELD_STATUSES),
  remarks: nullable(text(500)),
};
/** The section decides the estate; estate_id is never sent (P3 §4.5: kept consistent by the server). */
export const CreateFieldBody = z.strictObject({
  section_id: zId,
  field_number: fieldFields.field_number,
  name: fieldFields.name.optional(),
  gross_area: fieldFields.gross_area,
  planted_area: fieldFields.planted_area.optional(),
  field_status: fieldFields.field_status,
  section_effective_from: zBusinessDate.optional(),
  remarks: fieldFields.remarks.optional(),
});
/** The section changes only through /reassign-section, which is effective-dated. */
export const ReplaceFieldBody = z.strictObject(fieldFields);
export const PatchFieldBody = z.strictObject(fieldFields).partial();

export const ReassignSectionBody = z.strictObject({
  section_id: zId,
  /** The date the field joins the new section. Not in the future; not before it joined the current one. */
  effective_from: zBusinessDate,
  reason: z.string().trim().min(3).max(500).optional(),
});

export const FieldOut = z.object({
  id: z.string(),
  estate_id: z.string(),
  division_id: z.string(),
  section_id: z.string(),
  field_number: z.string(),
  name: z.string().nullable(),
  gross_area: z.string(),
  planted_area: z.string().nullable(),
  field_status: z.enum(FIELD_STATUSES),
  section_effective_from: z.string().nullable(),
  status: z.enum(STATUSES),
  remarks: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
