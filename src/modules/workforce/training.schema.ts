import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zDecimal } from '../../core/money/decimal.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of training programmes and their participants (P2.09; Spec P3 §24.1). */

export const TRAINING_TYPES = [
  'induction',
  'safety',
  'technical',
  'skill',
  'compliance',
  'health',
  'leadership',
  'other',
] as const;
export const TRAINER_TYPES = ['internal', 'external'] as const;
export const PROGRAM_STATES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'completed',
  'cancelled',
] as const;
export const ATTENDANCE = ['registered', 'attended', 'absent', 'withdrawn'] as const;
export const RESULTS = ['pass', 'fail', 'not_assessed'] as const;

export const IdParams = z.object({ id: zId });
export const ParticipantParams = z.object({ id: zId, participantId: zId });
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const programFields = {
  /** Numbered TP-… per estate and year when omitted. */
  program_code: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, 'Use letters, digits, ".", "_", "-" or "/".'),
  estate_id: zId,
  title: z.string().trim().min(3).max(200),
  training_type: z.enum(TRAINING_TYPES),
  trainer_name: nullable(z.string().trim().max(150)),
  trainer_type: z.enum(TRAINER_TYPES),
  venue: nullable(z.string().trim().max(200)),
  start_date: zBusinessDate,
  end_date: zBusinessDate,
  duration_hours: nullable(zDecimal('pct', { positive: true })),
  capacity: nullable(z.number().int().min(1).max(10000)),
  cost: nullable(zDecimal('money', { min: '0' })),
  /** P3.02: the expense budget head the cost consumes (consumption from P3.06). */
  budget_head_id: nullable(zId),
  description: nullable(z.string().trim().max(1000)),
};
export const CreateProgramBody = z
  .strictObject(programFields)
  .partial()
  .required({ estate_id: true, title: true, training_type: true, start_date: true, end_date: true });
export const PatchProgramBody = z.strictObject(programFields).omit({ estate_id: true }).partial();
export const CancelProgramBody = z.strictObject({ reason: z.string().trim().min(3).max(500) });

export const AddParticipantsBody = z.strictObject({
  /** Profiles of the programme's estate, not separated. */
  employment_profile_ids: z
    .array(zId)
    .min(1)
    .max(500)
    .refine((a) => new Set(a.map(String)).size === a.length, 'Each profile appears once.'),
});
export const RecordParticipantBody = z
  .strictObject({
    attendance_status: z.enum(ATTENDANCE),
    score: nullable(zDecimal('pct', { min: '0', max: '100' })),
    result: z.enum(RESULTS),
    certificate_number: nullable(z.string().trim().max(50)),
    certificate_issued_on: nullable(zBusinessDate),
    feedback_rating: nullable(z.number().int().min(1).max(5)),
    remarks: nullable(z.string().trim().max(500)),
  })
  .partial();

const UserRef = z.object({ id: z.string(), username: z.string() });

export const ProgramOut = z.object({
  id: z.string(),
  program_code: z.string(),
  estate_id: z.string(),
  estate: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  title: z.string(),
  training_type: z.enum(TRAINING_TYPES),
  trainer_name: z.string().nullable(),
  trainer_type: z.enum(TRAINER_TYPES),
  venue: z.string().nullable(),
  start_date: z.string(),
  end_date: z.string(),
  duration_hours: z.string().nullable(),
  capacity: z.number().int().nullable(),
  cost: z.string().nullable(),
  budget_head_id: z.string().nullable(),
  description: z.string().nullable(),
  /** Registered participants (withdrawn ones aside). */
  participant_count: z.number().int(),
  /** Seats left; null without a capacity. */
  seats_left: z.number().int().nullable(),
  state: z.enum(PROGRAM_STATES),
  approval_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  approved_by: UserRef.nullable(),
  rejection_reason: z.string().nullable(),
  cancellation_reason: z.string().nullable(),
  version: z.number().int(),
  created_at: z.string(),
});

export const ParticipantOut = z.object({
  id: z.string(),
  training_program_id: z.string(),
  program: z.object({
    id: z.string(),
    program_code: z.string(),
    title: z.string(),
    start_date: z.string(),
    end_date: z.string(),
  }),
  employment_profile_id: z.string(),
  profile: z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() }),
  attendance_status: z.enum(ATTENDANCE),
  score: z.string().nullable(),
  result: z.enum(RESULTS),
  certificate_number: z.string().nullable(),
  certificate_issued_on: z.string().nullable(),
  feedback_rating: z.number().int().nullable(),
  remarks: z.string().nullable(),
  version: z.number().int(),
});
