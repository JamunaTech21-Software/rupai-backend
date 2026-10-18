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
/** R.3: the Field Type list of the manager's design. tea_field and extension count towards the tea area. */
export const FIELD_TYPES = [
  'tea_field',
  'nursery',
  'extension',
  'infrastructure',
  'drain',
  'road_reserve',
  'shade_area',
  'road_side',
  'water_body',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
/** Field types whose planted area is tea area (D-R.3-3). */
export const TEA_FIELD_TYPES: readonly FieldType[] = ['tea_field', 'extension'];

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
const zCount = z.number().int().min(0).max(10_000_000);
/** A measurement to 2 places (altitude, slope: DECIMAL(8,2) and (5,2)). */
const zTwoPlaces = (min: string, max: string) =>
  zDecimal('qty', { min, max }).refine((d) => d.decimalPlaces() <= 2, 'Use at most 2 decimal places.');

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
  // ---- The Estate Overview figures as entered (RUP-625). null = not entered: the computed one is shown ----
  tea_area: nullable(zArea),
  non_tea_area: nullable(zArea),
  division_count: nullable(zCount),
  section_count: nullable(zCount),
  field_count: nullable(zCount),
  worker_count: nullable(zCount),
  family_count: nullable(zCount),
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
  tea_area: true,
  non_tea_area: true,
  division_count: true,
  section_count: true,
  field_count: true,
  worker_count: true,
  family_count: true,
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
  /** The Estate Overview figures as entered (RUP-625); null where not entered. */
  tea_area: z.string().nullable(),
  non_tea_area: z.string().nullable(),
  division_count: z.number().int().nullable(),
  section_count: z.number().int().nullable(),
  field_count: z.number().int().nullable(),
  worker_count: z.number().int().nullable(),
  family_count: z.number().int().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

const SOURCES = ['entered', 'computed'] as const;
const Counts = z.object({ total: z.number().int(), active: z.number().int(), inactive: z.number().int() });

/**
 * GET /estates/{id}/summary. Areas in acres. Each overview figure is the ENTERED value when the estate
 * has one (RUP-625), otherwise the computed one; `source` says which, and `computed` always carries
 * what the records say, so a screen can show a difference.
 */
export const EstateSummaryOut = z.object({
  estate_id: z.string(),
  /** The declared total land area (the land register will replace it). */
  total_land_area: z.string().nullable(),
  /** Entered, or the planted area of active tea fields (types tea_field and extension, still carrying tea). */
  tea_area: z.string(),
  /** Entered, or total_land_area − tea_area, never below zero. Null while neither is known. */
  non_tea_area: z.string().nullable(),
  /** Gross area of the active fields. */
  field_area: z.string(),
  division_count: z.number().int(),
  section_count: z.number().int(),
  field_count: z.number().int(),
  factory_count: z.number().int(),
  /** Entered, or the estate's current workers (P2.02) and their family members (dependents). */
  worker_count: z.number().int(),
  family_count: z.number().int(),
  workforce_available: z.boolean(),
  /** Photographs attached to the estate. */
  photo_count: z.number().int(),
  source: z.object({
    tea_area: z.enum(SOURCES),
    non_tea_area: z.enum(SOURCES),
    division_count: z.enum(SOURCES),
    section_count: z.enum(SOURCES),
    field_count: z.enum(SOURCES),
    worker_count: z.enum(SOURCES),
    family_count: z.enum(SOURCES),
  }),
  /** What the records say, whatever was entered. */
  computed: z.object({
    tea_area: z.string(),
    non_tea_area: z.string().nullable(),
    division_count: z.number().int(),
    section_count: z.number().int(),
    field_count: z.number().int(),
    worker_count: z.number().int(),
    family_count: z.number().int(),
  }),
  /** R.3: the figures under the Division & Section and Field / Block lists. Always computed. */
  hierarchy: z.object({
    divisions: Counts,
    sections: Counts,
    fields: Counts,
    /** Active fields per field type; every type is present. */
    field_types: z.record(z.enum(FIELD_TYPES), z.number().int()),
    /** Sum of the active divisions' areas. */
    division_area: z.string(),
    /** Sum of the active sections' areas. */
    section_area: z.string(),
    /** section_area ÷ active sections with an area, 2 places; null when none has one. */
    average_section_area: z.string().nullable(),
    /** Gross and planted area of the active fields. */
    field_area: z.string(),
    planted_area: z.string(),
  }),
});

// ---- division ---------------------------------------------------------------------------------------

const divisionFields = {
  code: zCode,
  name: zName,
  manager_profile_id: nullable(zProfileId),
  area: nullable(zArea),
  description: nullable(text(1000)),
};
export const CreateDivisionBody = z
  .strictObject(divisionFields)
  .partial()
  .required({ code: true, name: true });
/** description may be omitted on PUT (left as it is), so a client written before R.3 keeps working. */
export const ReplaceDivisionBody = z.strictObject(divisionFields).partial({ description: true });
export const PatchDivisionBody = z.strictObject(divisionFields).partial();

export const DivisionOut = z.object({
  id: z.string(),
  estate_id: z.string(),
  code: z.string(),
  name: z.string(),
  manager_profile_id: z.string().nullable(),
  area: z.string().nullable(),
  description: z.string().nullable(),
  /** Active sections of the division ("Total Section"). */
  section_count: z.number().int(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- section ----------------------------------------------------------------------------------------

const NodeRef = z.object({ id: z.string(), code: z.string(), name: z.string().nullable() });

const sectionFields = {
  code: zCode,
  name: zName,
  supervisor_profile_id: nullable(zProfileId),
  area: nullable(zArea),
  /** Another section of the same division; no cycles. */
  parent_section_id: nullable(zId),
  description: nullable(text(1000)),
};
export const CreateSectionBody = z.strictObject(sectionFields).partial().required({ code: true, name: true });
/** The R.3 fields may be omitted on PUT (left as they are), so a client written before R.3 keeps working. */
export const ReplaceSectionBody = z
  .strictObject(sectionFields)
  .partial({ parent_section_id: true, description: true });
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
  parent_section_id: z.string().nullable(),
  parent_section: NodeRef.nullable(),
  description: z.string().nullable(),
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
  /** "Description / remarks" on the design's form. */
  remarks: nullable(text(500)),
  // ---- R.3 Field / Block details (the manager's design) ----
  field_type: z.enum(FIELD_TYPES),
  /** Another field of the same estate; no cycles. */
  parent_field_id: nullable(zId),
  planting_year: nullable(z.number().int().min(1800).max(2100)),
  /** Bush type / clone: the tea variety list (/lookups/tea_variety). */
  tea_variety_id: nullable(zId),
  spacing: nullable(text(50)),
  /** Feet above sea level, e.g. "240.00". */
  altitude: nullable(zTwoPlaces('-1000', '30000')),
  /** Degrees, 0–90, e.g. "5.00". */
  average_slope: nullable(zTwoPlaces('0', '90')),
  irrigation_source_id: nullable(zId),
  soil_type_id: nullable(zId),
  drainage_class_id: nullable(zId),
};
const R3_FIELD_KEYS = {
  field_type: true,
  parent_field_id: true,
  planting_year: true,
  tea_variety_id: true,
  spacing: true,
  altitude: true,
  average_slope: true,
  irrigation_source_id: true,
  soil_type_id: true,
  drainage_class_id: true,
} as const;
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
  /** Default tea_field. */
  field_type: fieldFields.field_type.optional(),
  parent_field_id: fieldFields.parent_field_id.optional(),
  planting_year: fieldFields.planting_year.optional(),
  tea_variety_id: fieldFields.tea_variety_id.optional(),
  spacing: fieldFields.spacing.optional(),
  altitude: fieldFields.altitude.optional(),
  average_slope: fieldFields.average_slope.optional(),
  irrigation_source_id: fieldFields.irrigation_source_id.optional(),
  soil_type_id: fieldFields.soil_type_id.optional(),
  drainage_class_id: fieldFields.drainage_class_id.optional(),
});
/** The section changes only through /reassign-section, which is effective-dated. */
/** The R.3 fields may be omitted on PUT (left as they are), so a client written before R.3 keeps working. */
export const ReplaceFieldBody = z.strictObject(fieldFields).partial(R3_FIELD_KEYS);
export const PatchFieldBody = z.strictObject(fieldFields).partial();

export const ReassignSectionBody = z.strictObject({
  section_id: zId,
  /** The date the field joins the new section. Not in the future; not before it joined the current one. */
  effective_from: zBusinessDate,
  reason: z.string().trim().min(3).max(500).optional(),
});

const LookupRef = z.object({ id: z.string(), code: z.string(), name: z.string() });

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
  field_type: z.enum(FIELD_TYPES),
  parent_field_id: z.string().nullable(),
  parent_field: z
    .object({ id: z.string(), field_number: z.string(), name: z.string().nullable() })
    .nullable(),
  planting_year: z.number().int().nullable(),
  /** The ids are what a form sends back; the objects are for display. */
  tea_variety_id: z.string().nullable(),
  tea_variety: LookupRef.nullable(),
  spacing: z.string().nullable(),
  altitude: z.string().nullable(),
  average_slope: z.string().nullable(),
  irrigation_source_id: z.string().nullable(),
  irrigation_source: LookupRef.nullable(),
  soil_type_id: z.string().nullable(),
  soil_type: LookupRef.nullable(),
  drainage_class_id: z.string().nullable(),
  drainage_class: LookupRef.nullable(),
  /** Who added the field ("Created By"). */
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
