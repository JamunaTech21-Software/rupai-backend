import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';
import { GENDERS, RELATIONS } from './person.schema.js';

/**
 * Request and response schemas of employment profiles (P2.02; Spec P3 §8.2, P4 §8.3; the manager's
 * design, the employment sections of Add New Worker / Add New Employee and the Worker / Employee
 * Management pages, BACKLOG D-2-2).
 */

export const EMPLOYMENT_TYPES = ['worker', 'employee'] as const;
export const ENGAGEMENT_TYPES = [
  'permanent',
  'temporary',
  'seasonal',
  'casual',
  'probation',
  'contractual',
] as const;
export const EMPLOYMENT_BASES = ['full_time', 'part_time'] as const;
export const JOB_NATURES = [
  'field',
  'factory',
  'office',
  'technical',
  'supervisory',
  'administrative',
  'operational',
] as const;
export const WORKING_LOCATIONS = [
  'field',
  'factory',
  'office',
  'warehouse',
  'nursery',
  'head_office',
] as const;
export const PROFILE_STATUSES = ['active', 'suspended', 'on_leave', 'separated'] as const;
export const SEPARATION_TYPES = [
  'resignation',
  'retirement',
  'termination',
  'death',
  'end_of_contract',
] as const;

export const IdParams = z.object({ id: zId });

const nullable = <T extends z.ZodType>(t: T) => t.nullable();
const text = (max: number) => z.string().trim().max(max);
const zPhone = z
  .string()
  .trim()
  .max(30)
  .regex(/^\+?[0-9][0-9 -]{4,26}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');
const zNumber = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".');

/** What may change on a profile after it is created. The person, estate and type never change. */
const editable = {
  /** The design's Worker ID / Employee ID. Unique within the estate. */
  profile_number: zNumber,
  /** worker_category for a worker, employee_category for an employee (GET /lookups/…). */
  category_id: nullable(zId),
  engagement_type: z.enum(ENGAGEMENT_TYPES),
  employment_basis: nullable(z.enum(EMPLOYMENT_BASES)),
  job_nature: nullable(z.enum(JOB_NATURES)),
  working_location: nullable(z.enum(WORKING_LOCATIONS)),
  job_grade_id: nullable(zId),
  work_email: nullable(z.email().max(150)),
  joining_date: zBusinessDate,
  confirmation_date: nullable(zBusinessDate),
  probation_end_date: nullable(zBusinessDate),
  /** Reporting To: another profile of the same estate. */
  supervisor_profile_id: nullable(zId),
  is_service_continuous: z.boolean(),
  nominee_name: nullable(text(150)),
  nominee_relation: nullable(z.enum(RELATIONS)),
  nominee_date_of_birth: nullable(zBusinessDate),
  nominee_national_id: nullable(text(30)),
  nominee_phone: nullable(zPhone),
  nominee_address: nullable(text(300)),
  remarks: nullable(text(500)),
};

/** A profile is opened for a person at an estate. profile_number is numbered when omitted. */
export const CreateProfileBody = z
  .strictObject({
    person_id: zId,
    estate_id: zId,
    employment_type: z.enum(EMPLOYMENT_TYPES),
    ...editable,
  })
  .partial()
  .required({
    person_id: true,
    estate_id: true,
    employment_type: true,
    engagement_type: true,
    joining_date: true,
  });
export const ReplaceProfileBody = z.strictObject(editable);
export const PatchProfileBody = z.strictObject(editable).partial();

export const SeparateBody = z.strictObject({
  separation_date: zBusinessDate,
  separation_type: z.enum(SEPARATION_TYPES),
  reason: z.string().trim().min(3).max(500),
});
export const SuspendBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });
export const LinkUserBody = z.strictObject({
  /** The user account this profile signs in as (the design's "Reset Password" on the employee list). null unlinks. */
  user_id: nullable(zId),
});

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const ProfileOut = z.object({
  id: z.string(),
  person_id: z.string(),
  /** Enough of the person for the lists: name, father, mobile, photo (Worker / Employee Management). */
  person: z.object({
    id: z.string(),
    person_code: z.string(),
    full_name: z.string(),
    father_name: z.string().nullable(),
    phone: z.string().nullable(),
    gender: z.enum(GENDERS).nullable(),
    date_of_birth: z.string().nullable(),
    national_id: z.string().nullable(),
    /** The latest photograph among the person's documents: GET /documents/{id}/download for the image. */
    photo_document_id: z.string().nullable(),
  }),
  estate_id: z.string(),
  estate: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  employment_type: z.enum(EMPLOYMENT_TYPES),
  profile_number: z.string(),
  category_id: z.string().nullable(),
  category: Ref.nullable(),
  engagement_type: z.enum(ENGAGEMENT_TYPES),
  employment_basis: z.enum(EMPLOYMENT_BASES).nullable(),
  job_nature: z.enum(JOB_NATURES).nullable(),
  working_location: z.enum(WORKING_LOCATIONS).nullable(),
  job_grade_id: z.string().nullable(),
  job_grade: Ref.nullable(),
  work_email: z.string().nullable(),
  joining_date: z.string(),
  confirmation_date: z.string().nullable(),
  probation_end_date: z.string().nullable(),
  /** Today is before probation_end_date: the design's "On Probation". */
  on_probation: z.boolean(),
  separation_date: z.string().nullable(),
  separation_type: z.enum(SEPARATION_TYPES).nullable(),
  separation_reason: z.string().nullable(),
  supervisor_profile_id: z.string().nullable(),
  supervisor: z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() }).nullable(),
  is_service_continuous: z.boolean(),
  /** Whole years of service to today (or to the separation date). */
  service_years: z.number(),
  nominee_name: z.string().nullable(),
  nominee_relation: z.enum(RELATIONS).nullable(),
  nominee_date_of_birth: z.string().nullable(),
  nominee_national_id: z.string().nullable(),
  nominee_phone: z.string().nullable(),
  nominee_address: z.string().nullable(),
  remarks: z.string().nullable(),
  status: z.enum(PROFILE_STATUSES),
  /** The user account linked to this profile, if any. */
  user: z.object({ id: z.string(), username: z.string() }).nullable(),
  created_by: z.object({ id: z.string(), username: z.string() }),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

const Bucket = z.object({ key: z.string(), label: z.string(), count: z.number().int() });
export const SummaryQuery = z.strictObject({
  employment_type: z.enum(EMPLOYMENT_TYPES).optional(),
  estate_id: zId.optional(),
});
/** GET /employment-profiles/summary: the cards and charts of Worker / Employee Management. */
export const WorkforceSummaryOut = z.object({
  employment_type: z.enum(EMPLOYMENT_TYPES).nullable(),
  estate_id: z.string().nullable(),
  as_of: z.string(),
  /** Every profile not separated. */
  total: z.number().int(),
  active: z.number().int(),
  on_leave: z.number().int(),
  suspended: z.number().int(),
  separated: z.number().int(),
  /** Of total, the share active, in percent to 2 places ("89.33% of Total"). */
  active_pct: z.string(),
  on_leave_pct: z.string(),
  new_this_month: z.number().int(),
  exits_this_month: z.number().int(),
  /** Mean years of service of the profiles not separated, to 1 place. */
  average_tenure_years: z.string().nullable(),
  by_category: z.array(Bucket),
  by_engagement_type: z.array(Bucket),
  by_gender: z.array(Bucket),
  by_age_group: z.array(Bucket),
  by_length_of_service: z.array(Bucket),
  /** The design's "Birthday / Anniversary" tab: this month, in day order. */
  birthdays_this_month: z.array(
    z.object({ profile_id: z.string(), full_name: z.string(), date: z.string() }),
  ),
  anniversaries_this_month: z.array(
    z.object({ profile_id: z.string(), full_name: z.string(), date: z.string(), years: z.number().int() }),
  ),
});

export const ServiceSummaryOut = z.object({
  person_id: z.string(),
  profiles: z.number().int(),
  /** Days of service across profiles, continuous ones only (gratuity, O-11). */
  continuous_service_days: z.number().int(),
  total_service_days: z.number().int(),
  first_joining_date: z.string().nullable(),
  current_profile_id: z.string().nullable(),
});
