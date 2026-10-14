import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of the organisation hierarchy (Spec P3 §4.1–§4.5, P4 §7.1). */

export const STATUSES = ['active', 'inactive'] as const;
export type Status = (typeof STATUSES)[number];
/** DEPRECATED (R.2): still accepted, mapped to estate_type. */
export const OWNERSHIP_TYPES = ['owned', 'leased', 'government_lease', 'other'] as const;
export const ESTATE_TYPES = ['company_owned', 'private_estate', 'government_estate'] as const;
export const ESTATE_CATEGORIES = ['large', 'medium', 'small'] as const;
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
/** Acres (decision of 2026-10-14), DECIMAL(14,3). */
const zArea = zDecimal('qty', { min: '0' });
/** An employment profile id. Checked once employment_profile exists (Phase 2, BACKLOG D-1.07-2). */
const zProfileId = zId;

const nullable = <T extends z.ZodType>(t: T) => t.nullable();
/** A latitude or longitude in decimal degrees, to 6 places (about 10 cm), as a string: "26.341700". */
const zCoordinate = (limit: number) =>
  z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,6})?$/, 'Must be decimal degrees with up to 6 places, e.g. "26.341700".')
    .refine((v) => Math.abs(Number(v)) <= limit, `Must be between -${String(limit)} and ${String(limit)}.`);

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
  country_id: zId,
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
  country_id: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  website: z.string().nullable(),
  logo_path: z.string().nullable(),
  /** The base currency (BDT). Not editable. */
  base_currency_id: z.string(),
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
  remarks: nullable(text(500)),
  // ---- R.2 estate profile ----
  established_year: nullable(z.number().int().min(1800).max(2100)),
  owner_name: nullable(text(150)),
  estate_type: nullable(z.enum(ESTATE_TYPES)),
  estate_category: nullable(z.enum(ESTATE_CATEGORIES)),
  police_station: nullable(text(100)),
  admin_division: nullable(text(100)),
  country_id: nullable(zId),
  postal_code: nullable(text(20)),
  website: nullable(z.url({ protocol: /^https?$/ }).max(150)),
  latitude: nullable(zCoordinate(90)),
  longitude: nullable(zCoordinate(180)),
  description: nullable(text(4000)),
  /** The amenities the estate has: the whole set, replacing the previous one. */
  amenity_ids: z.array(zId).max(50),
  other_amenities: nullable(text(300)),
};
/** DEPRECATED (R.2), accepted for the current screens: established_on sets established_year, ownership_type sets estate_type. */
const legacyEstateFields = {
  established_on: nullable(zBusinessDate),
  ownership_type: nullable(z.enum(OWNERSHIP_TYPES)),
};
/** Create: code and name required, everything else optional (omitted = NULL). */
export const CreateEstateBody = z
  .strictObject({ ...estateFields, ...legacyEstateFields })
  .partial()
  .required({ code: true, name: true });
/**
 * Replace: every P1.07 field. The R.2 profile fields and the deprecated ones may be omitted (left as
 * they are), so a client written before R.2 keeps working.
 */
export const ReplaceEstateBody = z.strictObject({ ...estateFields, ...legacyEstateFields }).partial({
  established_on: true,
  ownership_type: true,
  established_year: true,
  owner_name: true,
  estate_type: true,
  estate_category: true,
  police_station: true,
  admin_division: true,
  country_id: true,
  postal_code: true,
  website: true,
  latitude: true,
  longitude: true,
  description: true,
  amenity_ids: true,
  other_amenities: true,
});
export const PatchEstateBody = z.strictObject({ ...estateFields, ...legacyEstateFields }).partial();

const AmenityRef = z.object({ id: z.string(), code: z.string(), name: z.string() });

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
  /** DEPRECATED (R.2): 1 January of established_year. */
  established_on: z.string().nullable(),
  /** DEPRECATED (R.2): estate_type in the old values. */
  ownership_type: z.enum(OWNERSHIP_TYPES).nullable(),
  status: z.enum(STATUSES),
  remarks: z.string().nullable(),
  established_year: z.number().int().nullable(),
  owner_name: z.string().nullable(),
  estate_type: z.enum(ESTATE_TYPES).nullable(),
  estate_category: z.enum(ESTATE_CATEGORIES).nullable(),
  police_station: z.string().nullable(),
  admin_division: z.string().nullable(),
  country_id: z.string().nullable(),
  postal_code: z.string().nullable(),
  website: z.string().nullable(),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  description: z.string().nullable(),
  amenities: z.array(AmenityRef),
  other_amenities: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/** GET /estates/{id}/summary: computed, never entered (decision of 2026-10-14). Areas in acres. */
export const EstateSummaryOut = z.object({
  estate_id: z.string(),
  /** The declared total land area (the land register will replace it). */
  total_land_area: z.string().nullable(),
  /** Planted area of the estate's active fields. */
  tea_area: z.string(),
  /** total_land_area − tea_area, never below zero. Null while no total is declared. */
  non_tea_area: z.string().nullable(),
  /** Gross area of the active fields. */
  field_area: z.string(),
  division_count: z.number().int(),
  section_count: z.number().int(),
  field_count: z.number().int(),
  factory_count: z.number().int(),
  /** Workers and families come from HR (Phase 2): 0 until then, and `workforce_available` is false. */
  worker_count: z.number().int(),
  family_count: z.number().int(),
  workforce_available: z.boolean(),
  /** Photographs attached to the estate. */
  photo_count: z.number().int(),
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
