import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';
import { MOBILE_BANKING, RELATIONS } from './person.schema.js';

/**
 * Request and response schemas of contractors, their contracts and contractor labour (P2.05; Spec P3
 * §8.6–§8.8, P7 §9.5; the manager's design: Add New Contractor and Contractor Management, BACKLOG D-2-4).
 */

export const CONTRACTOR_TYPES = ['individual', 'company', 'supplier'] as const;
export const LEGAL_STATUSES = [
  'proprietorship',
  'partnership',
  'private_ltd',
  'public_ltd',
  'other',
] as const;
export const SAFETY_COMPLIANCE = ['compliant', 'partially_compliant', 'non_compliant'] as const;
export const QUALITY_RATINGS = ['excellent', 'good', 'average', 'poor'] as const;
export const CONTRACTOR_STATUSES = ['active', 'inactive', 'blacklisted'] as const;
export const WORK_TYPES = [
  'labour_supply',
  'plucking',
  'field_work',
  'construction',
  'transport',
  'service',
  'other',
] as const;
export const RATE_BASES = ['per_day', 'per_kg', 'per_unit', 'lump_sum'] as const;
export const PAYMENT_TERMS = ['advance', 'monthly', 'quarterly', 'milestone'] as const;
export const WORK_LOCATIONS = ['estate', 'factory', 'office', 'field'] as const;
export const CONTRACT_STATES = ['draft', 'submitted', 'approved', 'rejected', 'terminated'] as const;
/** The design's Contract Status, from the state and the dates. */
export const CONTRACT_STATUSES = [
  'pending',
  'active',
  'upcoming',
  'completed',
  'terminated',
  'rejected',
] as const;
export const LABOUR_STATUSES = ['active', 'inactive'] as const;

export const IdParams = z.object({ id: zId });
export const LabourParams = z.object({ id: zId, labourId: zId });

const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const text = (max: number) => z.string().trim().max(max);
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 -]{4,26}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');
const zCode = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');

/** The design's form fields, as the contractor keeps them (contact person and first contract aside). */
const editable = {
  /** Numbered by the `contractor` format when omitted (the design's "Auto Generate"). */
  code: zCode(20),
  name: z.string().trim().min(1).max(150),
  short_name: nullable(text(50)),
  contractor_type: z.enum(CONTRACTOR_TYPES),
  /** GET /lookups/trade_category */
  trade_category_id: zId,
  legal_status: nullable(z.enum(LEGAL_STATUSES)),
  registration_type: nullable(text(100)),
  contractor_since: nullable(zBusinessDate),
  description: nullable(text(1000)),
  /** The design's Mobile No. (the contractor's own). */
  phone: zPhone,
  phone_alt: nullable(zPhone),
  email: nullable(z.email().max(150)),
  /** Present address. */
  address_line1: z.string().trim().min(1).max(300),
  present_district: z.string().trim().min(1).max(100),
  present_upazila: nullable(text(100)),
  present_postal_code: nullable(text(10)),
  permanent_address: nullable(text(300)),
  permanent_district: nullable(text(100)),
  permanent_upazila: nullable(text(100)),
  permanent_postal_code: nullable(text(10)),
  national_id: nullable(text(30)),
  registration_number: nullable(text(50)),
  trade_licence_number: z.string().trim().min(1).max(50),
  trade_licence_expiry: nullable(zBusinessDate),
  bin: nullable(text(30)),
  tin: nullable(text(30)),
  vat_registration_number: nullable(text(50)),
  registration_date: nullable(zBusinessDate),
  renewal_date: nullable(zBusinessDate),
  bank_name: z.string().trim().min(1).max(150),
  bank_branch: z.string().trim().min(1).max(150),
  bank_account_name: z.string().trim().min(1).max(150),
  bank_account_number: z.string().trim().min(1).max(40),
  bank_routing_number: nullable(text(20)),
  mobile_banking_provider: nullable(z.enum(MOBILE_BANKING)),
  mobile_banking_number: nullable(zPhone),
  equipment_owned: nullable(text(1000)),
  years_of_experience: nullable(z.number().int().min(0).max(100)),
  safety_compliance: nullable(z.enum(SAFETY_COMPLIANCE)),
  quality_rating: nullable(z.enum(QUALITY_RATINGS)),
  remarks: nullable(text(500)),
  emergency_contact_name: z.string().trim().min(1).max(150),
  emergency_relation: z.enum(RELATIONS),
  emergency_phone: zPhone,
  emergency_phone_alt: nullable(zPhone),
  emergency_address: nullable(text(300)),
};

const ContactPerson = z.strictObject({
  contact_name: z.string().trim().min(1).max(150),
  designation: nullable(text(100)).optional(),
  phone: zPhone,
  email: nullable(z.email().max(150)).optional(),
});

const contractFields = {
  estate_id: zId,
  /** The design's Contract Reference No. */
  reference_number: nullable(text(50)),
  work_type: z.enum(WORK_TYPES),
  rate_basis: z.enum(RATE_BASES),
  rate: zDecimal('money', { min: '0' }),
  start_date: zBusinessDate,
  end_date: zBusinessDate,
  /** Required for lump_sum. */
  contract_value: nullable(zDecimal('money', { min: '0' })),
  retention_percentage: nullable(zDecimal('pct', { min: '0', max: '100' })),
  payment_terms: nullable(z.enum(PAYMENT_TERMS)),
  work_location: nullable(z.enum(WORK_LOCATIONS)),
  /** A division of the contract's estate (the list's Working Location). */
  division_id: nullable(zId),
  /** The design's Reporting To: GET /lookups/designation */
  reporting_to_designation_id: nullable(zId),
  terms: nullable(text(20000)),
};
const contractOptional = [
  'reference_number',
  'contract_value',
  'retention_percentage',
  'payment_terms',
  'work_location',
  'division_id',
  'reporting_to_designation_id',
  'terms',
] as const;

export const CreateContractBody = z
  .strictObject({ contractor_id: zId, ...contractFields })
  .partial(
    Object.fromEntries(contractOptional.map((k) => [k, true])) as Record<
      (typeof contractOptional)[number],
      true
    >,
  );
/** The design's form: the contract fields of Add New Contractor (estate, dates, value, terms …). */
const FirstContract = z
  .strictObject(contractFields)
  .partial(
    Object.fromEntries(contractOptional.map((k) => [k, true])) as Record<
      (typeof contractOptional)[number],
      true
    >,
  );
export const ReplaceContractBody = z.strictObject(contractFields);
export const PatchContractBody = z.strictObject(contractFields).partial();

export const CreateContractorBody = z
  .strictObject({
    ...editable,
    /**
     * The estate registering it (who sees and changes it besides the estates it has contracts in). Omitted:
     * the first contract's estate; with neither, only users with all estates see it.
     */
    registered_estate_id: nullable(zId),
    /** The design's Contact Person: becomes the primary contact (GET /contractors/{id}/contacts). */
    contact_person: ContactPerson,
    /** The design's Contract Information: created as the contractor's first contract (a draft). */
    first_contract: FirstContract.optional(),
  })
  .partial({
    code: true,
    short_name: true,
    legal_status: true,
    registration_type: true,
    contractor_since: true,
    description: true,
    phone_alt: true,
    email: true,
    present_upazila: true,
    present_postal_code: true,
    permanent_address: true,
    permanent_district: true,
    permanent_upazila: true,
    permanent_postal_code: true,
    national_id: true,
    registration_number: true,
    trade_licence_expiry: true,
    bin: true,
    tin: true,
    vat_registration_number: true,
    registration_date: true,
    renewal_date: true,
    bank_routing_number: true,
    mobile_banking_provider: true,
    mobile_banking_number: true,
    equipment_owned: true,
    years_of_experience: true,
    safety_compliance: true,
    quality_rating: true,
    remarks: true,
    emergency_phone_alt: true,
    emergency_address: true,
    registered_estate_id: true,
  });
export const ReplaceContractorBody = z.strictObject(editable);
export const PatchContractorBody = z.strictObject(editable).partial();
export const BlacklistBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

export const TerminateBody = z.strictObject({
  /** The last day of work: within the contract, not in the future. */
  terminated_on: zBusinessDate,
  reason: z.string().trim().min(3).max(500),
});

const labourFields = {
  /** Numbered L-0001 … within the contract when omitted. */
  labour_code: zCode(20),
  name: z.string().trim().min(1).max(150),
  national_id: nullable(text(30)),
  phone: nullable(zPhone),
  /** Within the contract's dates. */
  engaged_from: nullable(zBusinessDate),
  engaged_to: nullable(zBusinessDate),
};
export const CreateLabourBody = z
  .strictObject(labourFields)
  .partial({ labour_code: true, national_id: true, phone: true, engaged_from: true, engaged_to: true });
export const PatchLabourBody = z.strictObject({ ...labourFields, status: z.enum(LABOUR_STATUSES) }).partial();

export const SummaryQuery = z.strictObject({
  estate_id: zId.optional(),
  /** "Contracts Expiring": ending within this many days (default 30, the design's badge). */
  expiring_days: z.coerce.number().int().min(1).max(365).optional(),
});

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

const ContractSummary = z.object({
  id: z.string(),
  contract_number: z.string(),
  estate: Ref,
  work_type: z.enum(WORK_TYPES),
  start_date: z.string(),
  end_date: z.string(),
  contract_value: z.string().nullable(),
  work_location: z.enum(WORK_LOCATIONS).nullable(),
  division: Ref.nullable(),
  status: z.enum(CONTRACT_STATUSES),
});

export const ContractorOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  short_name: z.string().nullable(),
  contractor_type: z.enum(CONTRACTOR_TYPES),
  trade_category_id: z.string().nullable(),
  trade_category: Ref.nullable(),
  legal_status: z.enum(LEGAL_STATUSES).nullable(),
  registration_type: z.string().nullable(),
  contractor_since: z.string().nullable(),
  description: z.string().nullable(),
  /** The primary contact (cache of GET /contractors/{id}/contacts). */
  contact_person: z.string().nullable(),
  designation: z.string().nullable(),
  phone: z.string().nullable(),
  phone_alt: z.string().nullable(),
  email: z.string().nullable(),
  address_line1: z.string().nullable(),
  present_district: z.string().nullable(),
  present_upazila: z.string().nullable(),
  present_postal_code: z.string().nullable(),
  permanent_address: z.string().nullable(),
  permanent_district: z.string().nullable(),
  permanent_upazila: z.string().nullable(),
  permanent_postal_code: z.string().nullable(),
  national_id: z.string().nullable(),
  registration_number: z.string().nullable(),
  trade_licence_number: z.string().nullable(),
  trade_licence_expiry: z.string().nullable(),
  /** The licence has expired, or does within 30 days. */
  licence_expiring: z.boolean(),
  bin: z.string().nullable(),
  tin: z.string().nullable(),
  vat_registration_number: z.string().nullable(),
  registration_date: z.string().nullable(),
  renewal_date: z.string().nullable(),
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_name: z.string().nullable(),
  bank_account_number: z.string().nullable(),
  bank_routing_number: z.string().nullable(),
  mobile_banking_provider: z.enum(MOBILE_BANKING).nullable(),
  mobile_banking_number: z.string().nullable(),
  equipment_owned: z.string().nullable(),
  years_of_experience: z.number().int().nullable(),
  safety_compliance: z.enum(SAFETY_COMPLIANCE).nullable(),
  quality_rating: z.enum(QUALITY_RATINGS).nullable(),
  remarks: z.string().nullable(),
  emergency_contact_name: z.string().nullable(),
  emergency_relation: z.enum(RELATIONS).nullable(),
  emergency_phone: z.string().nullable(),
  emergency_phone_alt: z.string().nullable(),
  emergency_address: z.string().nullable(),
  registered_estate_id: z.string().nullable(),
  /** The list's contract columns: the contract in force today, else the latest. */
  current_contract: ContractSummary.nullable(),
  /** The design's No. of Workers: active labour on its contracts in force today. */
  number_of_workers: z.number().int(),
  status: z.enum(CONTRACTOR_STATUSES),
  blacklist_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const ContractOut = z.object({
  id: z.string(),
  contractor_id: z.string(),
  contractor: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  estate_id: z.string(),
  estate: Ref,
  contract_number: z.string(),
  reference_number: z.string().nullable(),
  work_type: z.enum(WORK_TYPES),
  rate_basis: z.enum(RATE_BASES),
  rate: z.string(),
  start_date: z.string(),
  end_date: z.string(),
  /** Whole months, rounded up (the design's Contract Duration). */
  duration_months: z.number().int(),
  days_left: z.number().int(),
  contract_value: z.string().nullable(),
  retention_percentage: z.string().nullable(),
  payment_terms: z.enum(PAYMENT_TERMS).nullable(),
  work_location: z.enum(WORK_LOCATIONS).nullable(),
  division_id: z.string().nullable(),
  division: Ref.nullable(),
  reporting_to_designation_id: z.string().nullable(),
  reporting_to: Ref.nullable(),
  terms: z.string().nullable(),
  state: z.enum(CONTRACT_STATES),
  /** The design's status: pending (draft / submitted), upcoming, active, completed, terminated, rejected. */
  status: z.enum(CONTRACT_STATUSES),
  /** While submitted: act on it with POST /approvals/{id}/approve|reject|return. */
  approval_id: z.string().nullable(),
  labour_count: z.number().int(),
  terminated_on: z.string().nullable(),
  termination_reason: z.string().nullable(),
  submitted_at: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: z.object({ id: z.string(), username: z.string() }).nullable(),
  rejected_at: z.string().nullable(),
  rejection_reason: z.string().nullable(),
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const LabourOut = z.object({
  id: z.string(),
  contractor_contract_id: z.string(),
  labour_code: z.string(),
  name: z.string(),
  national_id: z.string().nullable(),
  phone: z.string().nullable(),
  engaged_from: z.string().nullable(),
  engaged_to: z.string().nullable(),
  status: z.enum(LABOUR_STATUSES),
  version: z.number().int(),
  created_at: z.string(),
});

const Bucket = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
  percentage: z.string(),
});
export const ContractorSummaryOut = z.object({
  estate_id: z.string().nullable(),
  as_of: z.string(),
  total: z.number().int(),
  active: z.number().int(),
  /** Inactive and blacklisted. */
  inactive: z.number().int(),
  blacklisted: z.number().int(),
  contracts_expiring: z.number().int(),
  expiring_days: z.number().int(),
  new_this_month: z.number().int(),
  /** Of the contracts in force today, decimal string. */
  total_contract_value: z.string(),
  by_contractor_type: z.array(Bucket),
  by_work_type: z.array(Bucket),
  by_trade_category: z.array(Bucket),
  by_status: z.array(Bucket),
  top_contractors: z.array(
    z.object({ contractor_id: z.string(), code: z.string(), name: z.string(), contract_value: z.string() }),
  ),
  /** Approved contracts ending within 90 days or ended without renewal in the last 30, soonest first. */
  expiry_alerts: z.array(
    z.object({
      contract_id: z.string(),
      contract_number: z.string(),
      contractor_id: z.string(),
      contractor_name: z.string(),
      end_date: z.string(),
      days_left: z.number().int(),
      /** expired | expiring_soon (within expiring_days) | safe */
      status: z.enum(['expired', 'expiring_soon', 'safe']),
    }),
  ),
  /** Contractors whose trade licence has expired or does within 30 days. */
  licences_expiring: z.number().int(),
});
