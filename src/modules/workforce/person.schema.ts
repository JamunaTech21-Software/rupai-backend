import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';

/**
 * Request and response schemas of the person registry (P2.01; Spec P3 §8.1, P4 §8.3; the manager's
 * design, Add New Worker / Add New Employee, BACKLOG D-2-1).
 *
 * Identity only: the bodies are strict, so an employment attribute (department, designation, wage,
 * joining date, worker type …) is refused with 422, as P4 §8.3 requires. Those belong to the employment
 * profile (P2.02).
 */

export const STATUSES = ['active', 'inactive'] as const;
export const TITLES = ['mr', 'mrs', 'ms', 'other'] as const;
export const GENDERS = ['male', 'female', 'other'] as const;
export const MARITAL_STATUSES = ['single', 'married', 'widowed', 'divorced'] as const;
export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const PAYMENT_METHODS = ['bank', 'cash', 'mobile_banking'] as const;
export const MOBILE_BANKING = ['bkash', 'nagad', 'rocket', 'upay', 'other'] as const;
export const RELATIONS = [
  'father',
  'mother',
  'spouse',
  'son',
  'daughter',
  'brother',
  'sister',
  'other',
] as const;

export const IdParams = z.object({ id: zId });
export const DependentParams = z.object({ id: zId, dependentId: zId });

const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const text = (max: number) => z.string().trim().max(max);
const name = (max: number) => z.string().trim().min(1).max(max);
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 -]{4,26}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');
const zIdNumber = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 /-]*$/, 'Letters, digits, spaces, "/" and "-" only.');

const personFields = {
  /** The estate registering the person: who may see and change them until a profile places them. */
  registered_estate_id: nullable(zId),
  title: nullable(z.enum(TITLES)),
  first_name: name(100),
  middle_name: nullable(text(100)),
  last_name: nullable(text(100)),
  father_name: nullable(text(150)),
  mother_name: nullable(text(150)),
  spouse_name: nullable(text(150)),
  date_of_birth: nullable(zBusinessDate),
  gender: nullable(z.enum(GENDERS)),
  marital_status: nullable(z.enum(MARITAL_STATUSES)),
  blood_group: nullable(z.enum(BLOOD_GROUPS)),
  nationality_country_id: nullable(zId),
  religion_id: nullable(zId),
  /** Unique where present. */
  national_id: nullable(zIdNumber),
  birth_certificate_no: nullable(zIdNumber),
  passport_no: nullable(zIdNumber),
  driving_license_no: nullable(zIdNumber),
  tin: nullable(zIdNumber),
  phone: nullable(zPhone),
  alternate_phone: nullable(zPhone),
  personal_email: nullable(z.email().max(150)),
  present_address: nullable(text(300)),
  present_district: nullable(text(100)),
  present_upazila: nullable(text(100)),
  present_postal_code: nullable(text(20)),
  permanent_address: nullable(text(300)),
  permanent_district: nullable(text(100)),
  permanent_upazila: nullable(text(100)),
  permanent_postal_code: nullable(text(20)),
  education_level_id: nullable(zId),
  /** The whole set, replacing the previous one. */
  skill_ids: z.array(zId).max(50),
  language_ids: z.array(zId).max(20),
  experience_years: nullable(z.number().int().min(0).max(80)),
  emergency_contact_name: nullable(text(150)),
  emergency_contact_phone: nullable(zPhone),
  emergency_contact_alt_phone: nullable(zPhone),
  emergency_contact_relation: nullable(z.enum(RELATIONS)),
  emergency_contact_address: nullable(text(300)),
  payment_method: nullable(z.enum(PAYMENT_METHODS)),
  bank_name: nullable(text(150)),
  bank_branch: nullable(text(150)),
  bank_account_number: nullable(zIdNumber.max(40)),
  mobile_banking_provider: nullable(z.enum(MOBILE_BANKING)),
  mobile_banking_number: nullable(zPhone),
  remarks: nullable(text(500)),
};
export const CreatePersonBody = z.strictObject(personFields).partial().required({ first_name: true });
/** Replace: every field; the sets (skill_ids, language_ids) may be omitted (left as they are). */
export const ReplacePersonBody = z
  .strictObject(personFields)
  .partial({ skill_ids: true, language_ids: true });
export const PatchPersonBody = z.strictObject(personFields).partial();

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const PersonOut = z.object({
  id: z.string(),
  person_code: z.string(),
  registered_estate_id: z.string().nullable(),
  title: z.enum(TITLES).nullable(),
  first_name: z.string(),
  middle_name: z.string().nullable(),
  last_name: z.string().nullable(),
  /** first + middle + last, kept by the server. */
  full_name: z.string(),
  father_name: z.string().nullable(),
  mother_name: z.string().nullable(),
  spouse_name: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  /** Whole years on today's date; null without a date of birth. */
  age: z.number().int().nullable(),
  gender: z.enum(GENDERS).nullable(),
  marital_status: z.enum(MARITAL_STATUSES).nullable(),
  blood_group: z.enum(BLOOD_GROUPS).nullable(),
  nationality_country_id: z.string().nullable(),
  nationality: z.object({ id: z.string(), name: z.string() }).nullable(),
  religion_id: z.string().nullable(),
  religion: Ref.nullable(),
  national_id: z.string().nullable(),
  birth_certificate_no: z.string().nullable(),
  passport_no: z.string().nullable(),
  driving_license_no: z.string().nullable(),
  tin: z.string().nullable(),
  phone: z.string().nullable(),
  alternate_phone: z.string().nullable(),
  personal_email: z.string().nullable(),
  present_address: z.string().nullable(),
  present_district: z.string().nullable(),
  present_upazila: z.string().nullable(),
  present_postal_code: z.string().nullable(),
  permanent_address: z.string().nullable(),
  permanent_district: z.string().nullable(),
  permanent_upazila: z.string().nullable(),
  permanent_postal_code: z.string().nullable(),
  education_level_id: z.string().nullable(),
  education_level: Ref.nullable(),
  skills: z.array(Ref),
  languages: z.array(Ref),
  experience_years: z.number().int().nullable(),
  emergency_contact_name: z.string().nullable(),
  emergency_contact_phone: z.string().nullable(),
  emergency_contact_alt_phone: z.string().nullable(),
  emergency_contact_relation: z.enum(RELATIONS).nullable(),
  emergency_contact_address: z.string().nullable(),
  payment_method: z.enum(PAYMENT_METHODS).nullable(),
  bank_name: z.string().nullable(),
  bank_branch: z.string().nullable(),
  bank_account_number: z.string().nullable(),
  mobile_banking_provider: z.enum(MOBILE_BANKING).nullable(),
  mobile_banking_number: z.string().nullable(),
  remarks: z.string().nullable(),
  dependent_count: z.number().int(),
  status: z.enum(STATUSES),
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- dependents (the design's Dependents tab) -----------------------------------------------------

const dependentFields = {
  name: name(150),
  relation: z.enum(RELATIONS),
  occupation: nullable(text(100)),
  date_of_birth: nullable(zBusinessDate),
  gender: nullable(z.enum(GENDERS)),
};
export const CreateDependentBody = z
  .strictObject(dependentFields)
  .partial({ occupation: true, date_of_birth: true, gender: true });
export const PatchDependentBody = z.strictObject(dependentFields).partial();

export const DependentOut = z.object({
  id: z.string(),
  person_id: z.string(),
  name: z.string(),
  relation: z.enum(RELATIONS),
  occupation: z.string().nullable(),
  date_of_birth: z.string().nullable(),
  age: z.number().int().nullable(),
  gender: z.enum(GENDERS).nullable(),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});
