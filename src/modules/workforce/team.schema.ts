import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';

/**
 * Request and response schemas of worker teams and their membership (P2.04; Spec P3 §8.4–§8.5, P4 §8.3).
 * The design has no team page: teams feed Labour Allocation (Supervisor / Incharge, allocated workers,
 * Phase 5) and team distribution of plucking (Phase 5).
 */

export const TEAM_TYPES = ['plucking', 'field', 'factory', 'general'] as const;
export const TEAM_ROLES = ['member', 'leader', 'assistant'] as const;
export const TEAM_STATUSES = ['active', 'inactive'] as const;

export const TeamParams = z.object({ id: zId });
export const MemberParams = z.object({ id: zId, memberId: zId });

const zCode = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'Use letters, digits, ".", "_" or "-".');
const nullable = <T extends z.ZodType>(t: T) => t.nullable();

const editable = {
  code: zCode,
  name: z.string().trim().min(1).max(150),
  team_type: z.enum(TEAM_TYPES),
  /** The sardar or supervisor: a profile of the team's estate, not separated. */
  supervisor_profile_id: nullable(zId),
  division_id: nullable(zId),
  /** Within the division when both are given; the division is taken from it when omitted. */
  section_id: nullable(zId),
  description: nullable(z.string().trim().max(500)),
};

export const CreateTeamBody = z
  .strictObject({ estate_id: zId, ...editable })
  .partial()
  .required({ estate_id: true, code: true, name: true, team_type: true });
export const ReplaceTeamBody = z.strictObject(editable);
export const PatchTeamBody = z.strictObject(editable).partial();

const NewMember = z.strictObject({
  /** A WORKER profile of the team's estate, not separated. */
  employment_profile_id: zId,
  effective_from: zBusinessDate,
  role_in_team: z.enum(TEAM_ROLES).default('member'),
});
export const AddMembersBody = z.strictObject({
  members: z
    .array(NewMember)
    .min(1)
    .max(200)
    .refine(
      (m) => new Set(m.map((x) => x.employment_profile_id.toString())).size === m.length,
      'Each worker appears once.',
    ),
  /**
   * A worker still in another team is refused (422) unless this is true: their current membership there is
   * then ended the day before (moving them to this team).
   */
  move_from_other_team: z.boolean().default(false),
});
export const EndMemberBody = z.strictObject({
  /** The last day in the team: not before effective_from. */
  effective_to: zBusinessDate,
});
export const PatchMemberBody = z.strictObject({ role_in_team: z.enum(TEAM_ROLES) });

export const MembersQuery = z.strictObject({
  /** The members on this date (today when omitted). */
  as_of: zBusinessDate.optional(),
  /** true: every membership, past and future, latest first (the history). */
  history: z.enum(['true', 'false']).optional(),
});

const Ref = z.object({ id: z.string(), code: z.string(), name: z.string() });

export const TeamOut = z.object({
  id: z.string(),
  estate_id: z.string(),
  estate: Ref,
  code: z.string(),
  name: z.string(),
  team_type: z.enum(TEAM_TYPES),
  supervisor_profile_id: z.string().nullable(),
  supervisor: z.object({ id: z.string(), profile_number: z.string(), full_name: z.string() }).nullable(),
  division_id: z.string().nullable(),
  division: Ref.nullable(),
  section_id: z.string().nullable(),
  section: Ref.nullable(),
  description: z.string().nullable(),
  /** Members today. */
  member_count: z.number().int(),
  /** The leader today, if any. */
  leader: z.object({ profile_id: z.string(), profile_number: z.string(), full_name: z.string() }).nullable(),
  status: z.enum(TEAM_STATUSES),
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const MemberOut = z.object({
  id: z.string(),
  worker_team_id: z.string(),
  team: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  employment_profile_id: z.string(),
  profile: z.object({
    id: z.string(),
    profile_number: z.string(),
    full_name: z.string(),
    status: z.string(),
  }),
  effective_from: z.string(),
  /** null: still a member. */
  effective_to: z.string().nullable(),
  role_in_team: z.enum(TEAM_ROLES),
  /** A member on the date asked (today for the history). */
  is_current: z.boolean(),
  version: z.number().int(),
  created_at: z.string(),
});
