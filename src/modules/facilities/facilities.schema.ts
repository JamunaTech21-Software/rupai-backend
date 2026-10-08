import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of factories, warehouses, parties and contacts (Spec P3 §4.6–§4.7, §6.1–§6.2). */

export const STATUSES = ['active', 'inactive'] as const;
export type Status = (typeof STATUSES)[number];
export const FACTORY_TYPES = ['own', 'external'] as const;
export const WAREHOUSE_TYPES = ['own', 'rented', 'third_party'] as const;
export const PARTY_TYPES = ['individual', 'organisation', 'government'] as const;
export const CONTACT_TYPES = ['primary', 'accounts', 'operations', 'emergency', 'other'] as const;
/** Every owner P3 §6.2 allows. Only those whose table exists have contact endpoints (contacts.service.ts). */
export const CONTACT_OWNER_TYPES = [
  'buyer',
  'broker',
  'supplier',
  'leaf_supplier',
  'contractor',
  'warehouse',
  'party',
  'auction_centre',
] as const;
export type ContactOwnerType = (typeof CONTACT_OWNER_TYPES)[number];

export const IdParams = z.object({ id: zId });
export const ContactParams = z.object({ id: zId, contactId: zId });

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
const zKg = zDecimal('qty', { min: '0' });
const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const required = { code: true, name: true } as const;

// ---- factory ----------------------------------------------------------------------------------------

const factoryFields = {
  code: zCode,
  name: zName,
  factory_type: z.enum(FACTORY_TYPES),
  /** Informational only: never used for scope or production reporting (P3 §4.6). */
  primary_estate_id: nullable(zId),
  location: nullable(text(200)),
  daily_capacity_kg: nullable(zKg),
  /** Checked once employment_profile exists (Phase 2). */
  manager_profile_id: nullable(zId),
  licence_number: nullable(text(50)),
  licence_expiry: nullable(zBusinessDate),
};
export const CreateFactoryBody = z
  .strictObject(factoryFields)
  .partial()
  .required({ ...required, factory_type: true });
export const ReplaceFactoryBody = z.strictObject(factoryFields);
export const PatchFactoryBody = z.strictObject(factoryFields).partial();

export const FactoryOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  factory_type: z.enum(FACTORY_TYPES),
  primary_estate_id: z.string().nullable(),
  location: z.string().nullable(),
  daily_capacity_kg: z.string().nullable(),
  manager_profile_id: z.string().nullable(),
  licence_number: z.string().nullable(),
  licence_expiry: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- warehouse --------------------------------------------------------------------------------------

/** phone is not here: it is the primary contact's, maintained from /warehouses/{id}/contacts. */
const warehouseFields = {
  code: zCode,
  name: zName,
  warehouse_type: z.enum(WAREHOUSE_TYPES),
  location: nullable(text(200)),
  capacity_kg: nullable(zKg),
  keeper_profile_id: nullable(zId),
  licence_number: nullable(text(50)),
  licence_expiry: nullable(zBusinessDate),
  tin: nullable(text(30)),
  vat_registration: nullable(text(30)),
};
export const CreateWarehouseBody = z
  .strictObject(warehouseFields)
  .partial()
  .required({ ...required, warehouse_type: true });
export const ReplaceWarehouseBody = z.strictObject(warehouseFields);
export const PatchWarehouseBody = z.strictObject(warehouseFields).partial();

export const WarehouseOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  warehouse_type: z.enum(WAREHOUSE_TYPES),
  location: z.string().nullable(),
  capacity_kg: z.string().nullable(),
  keeper_profile_id: z.string().nullable(),
  /** The primary contact's phone (read-only here). */
  phone: z.string().nullable(),
  licence_number: z.string().nullable(),
  licence_expiry: z.string().nullable(),
  tin: z.string().nullable(),
  vat_registration: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- party ------------------------------------------------------------------------------------------

const partyFields = {
  party_type: z.enum(PARTY_TYPES),
  code: zCode,
  name: zName,
  national_id: nullable(text(30)),
  registration_number: nullable(text(50)),
  address_line1: nullable(text(200)),
  district: nullable(text(100)),
  phone: nullable(zPhone),
  email: nullable(zEmail),
};
export const CreatePartyBody = z
  .strictObject(partyFields)
  .partial()
  .required({ ...required, party_type: true });
export const ReplacePartyBody = z.strictObject(partyFields);
export const PatchPartyBody = z.strictObject(partyFields).partial();

export const PartyOut = z.object({
  id: z.string(),
  party_type: z.enum(PARTY_TYPES),
  code: z.string(),
  name: z.string(),
  national_id: z.string().nullable(),
  registration_number: z.string().nullable(),
  address_line1: z.string().nullable(),
  district: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- contacts ---------------------------------------------------------------------------------------

const contactFields = {
  contact_name: zName,
  designation: nullable(text(100)),
  contact_type: z.enum(CONTACT_TYPES),
  phone: nullable(zPhone),
  phone_alt: nullable(zPhone),
  email: nullable(zEmail),
};
export const CreateContactBody = z.strictObject({
  ...contactFields,
  designation: contactFields.designation.optional(),
  phone: contactFields.phone.optional(),
  phone_alt: contactFields.phone_alt.optional(),
  email: contactFields.email.optional(),
  /** Make this the owner's primary contact. The first contact of an owner always is. */
  is_primary: z.boolean().optional(),
});
/** is_primary changes only through /make-primary, so the switch is one atomic act. */
export const ReplaceContactBody = z.strictObject(contactFields);
export const PatchContactBody = z.strictObject(contactFields).partial();

export const ContactOut = z.object({
  id: z.string(),
  owner_type: z.enum(CONTACT_OWNER_TYPES),
  owner_id: z.string(),
  contact_name: z.string(),
  designation: z.string().nullable(),
  contact_type: z.enum(CONTACT_TYPES),
  phone: z.string().nullable(),
  phone_alt: z.string().nullable(),
  email: z.string().nullable(),
  is_primary: z.boolean(),
  status: z.enum(STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
