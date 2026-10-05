import { z } from 'zod';

import { zPassword } from '../../core/auth/password.js';
import { zId } from '../../core/ids/ids.js';
import { SCOPE_TYPES } from '../../core/scope/scope.js';
import { zTimestamp } from '../../core/time/dates.js';
import { ACTIONS, SPECIAL_ACTIONS } from './permission-catalogue.js';

/** Request and response schemas of the identity module (users, roles, permissions). */

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export const ROLE_STATUSES = ['active', 'inactive'] as const;
export type RoleStatus = (typeof ROLE_STATUSES)[number];

export const IdParams = z.object({ id: zId });

// ---- users -------------------------------------------------------------------------------------

const zUsername = z
  .string()
  .trim()
  .min(3)
  .max(50)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Use letters, digits, dot, dash or underscore.');
const zEmail = z.email().max(254);
const zPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 -]{4,18}[0-9]$/, 'Must be a phone number, e.g. +8801711000000.');

const userFields = {
  username: zUsername,
  email: zEmail.nullable(),
  phone: zPhone.nullable(),
};

export const CreateUserBody = z.strictObject({
  username: userFields.username,
  email: userFields.email.optional(),
  phone: userFields.phone.optional(),
  /** A temporary password. The user must change it at first login (must_change_password). */
  initial_password: zPassword,
});
/** PUT: the full editable representation. */
export const ReplaceUserBody = z.strictObject(userFields);
/** PATCH: omitted means unchanged. */
export const PatchUserBody = z.strictObject(userFields).partial();

// ---- separation of duties (P1.04) ----------------------------------------------------------------

/** A named, written authorisation for one conflict or sensitive permission (P6 §9.1, §10). */
export const AuthorisationInput = z.strictObject({
  /** The `key` of a requirement, as returned by AUTHORISATION_REQUIRED or /roles/check. */
  key: z.string().min(3).max(255),
  /** Why this concentration of authority is accepted. Shown on the concentration report. */
  reason: z.string().trim().min(10, 'Give a real reason (at least 10 characters).').max(1000),
});

/** On a role change, each authorisation names the affected user. */
export const RoleAuthorisationInput = AuthorisationInput.extend({ user_id: zId });

export const AssignRolesBody = z.strictObject({
  /** The user's complete set of roles after the call. An empty list removes every role. */
  roles: z
    .array(
      z.strictObject({
        role_id: zId,
        /** For temporary cover (P6 §11.2): the grant lapses by itself at this time. */
        expires_at: zTimestamp.nullable().optional(),
      }),
    )
    .max(20),
  /** Authorisations for the conflicts and sensitive permissions this assignment brings (P1.04). */
  authorisations: z.array(AuthorisationInput).max(100).optional(),
});

/** Preview: the same roles as AssignRolesBody, without changing anything. */
export const CheckRolesBody = z.strictObject({
  roles: z.array(z.strictObject({ role_id: zId, expires_at: zTimestamp.nullable().optional() })).max(20),
});

const RoleRef = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.enum(ROLE_STATUSES),
  granted_at: z.string(),
  expires_at: z.string().nullable(),
});

export const UserOut = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(USER_STATUSES),
  must_change_password: z.boolean(),
  two_factor_enabled: z.boolean(),
  last_login_at: z.string().nullable(),
  locked_until: z.string().nullable(),
  person_id: z.string().nullable(),
  employment_profile_id: z.string().nullable(),
  roles: z.array(RoleRef),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const EffectivePermissionsOut = z.object({
  user_id: z.string(),
  status: z.enum(USER_STATUSES),
  permissions: z.array(z.string()),
});

// ---- roles -------------------------------------------------------------------------------------

const zPermissionKey = z
  .string()
  .regex(/^[a-z][a-z_]*\.[a-z_]+$/, 'Must be module.action, e.g. sale.view.')
  .max(61);

const roleFields = {
  code: z
    .string()
    .trim()
    .regex(/^[A-Z][A-Z0-9_]{1,19}$/, 'Use 2–20 capital letters, digits or underscores, e.g. ESTATE_MANAGER.'),
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(500).nullable(),
  sort_order: z.int().min(0).max(1_000_000),
  /** The role's complete permission set, as module.action keys. */
  permissions: z.array(zPermissionKey).max(1000),
};

export const CreateRoleBody = z.strictObject({
  ...roleFields,
  description: roleFields.description.optional(),
  sort_order: roleFields.sort_order.optional(),
  permissions: roleFields.permissions.optional(),
});
/** Authorisations for conflicts a broadened role brings to the users who already hold it (P6 §9.1). */
const roleAuthorisations = { authorisations: z.array(RoleAuthorisationInput).max(200).optional() };
export const ReplaceRoleBody = z.strictObject({ ...roleFields, ...roleAuthorisations });
export const PatchRoleBody = z.strictObject(roleFields).partial().extend(roleAuthorisations);
/** Reactivating a role gives its permissions back to every holder, so it is checked the same way. */
export const ReactivateRoleBody = z.strictObject(roleAuthorisations);

export const RoleOut = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sort_order: z.number(),
  is_system: z.boolean(),
  status: z.enum(ROLE_STATUSES),
  permissions: z.array(z.string()),
  user_count: z.number(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

// ---- permissions -------------------------------------------------------------------------------

export const ALL_ACTIONS = [...ACTIONS, ...SPECIAL_ACTIONS] as const;

export const PermissionOut = z.object({
  id: z.string(),
  key: z.string(),
  module: z.string(),
  action: z.enum(ALL_ACTIONS),
  group: z.string(),
  module_class: z.enum(['reference', 'master', 'operational', 'financial', 'derived', 'policy']),
  description: z.string().nullable(),
  sensitive: z.boolean(),
});

// ---- data scope (P1.03) ------------------------------------------------------------------------

export const ScopeGrantParams = z.object({ id: zId, grantId: zId });

export const CreateScopeGrantBody = z
  .strictObject({
    scope_type: z.enum(SCOPE_TYPES),
    /** The estate, division, section, department or facility. Omitted for all_estates. */
    scope_id: zId.nullable().optional(),
    /** For temporary cover (P6 §11.2): the grant lapses by itself at this time. */
    expires_at: zTimestamp.nullable().optional(),
  })
  .superRefine((b, ctx) => {
    if (b.scope_type === 'self') {
      ctx.addIssue({
        code: 'custom',
        path: ['scope_type'],
        message: 'Every user already has self scope; it cannot be granted.',
      });
    } else if (b.scope_type === 'all_estates') {
      if (b.scope_id !== null && b.scope_id !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['scope_id'], message: 'all_estates names no target.' });
      }
    } else if (b.scope_id === null || b.scope_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['scope_id'], message: `Required for ${b.scope_type}.` });
    }
  });

export const PatchScopeGrantBody = z.strictObject({
  /** Change or remove (null) the expiry. The target of a grant never changes: revoke and grant instead. */
  expires_at: zTimestamp.nullable(),
});

export const ScopeGrantOut = z.object({
  id: z.string(),
  user_id: z.string(),
  scope_type: z.enum(SCOPE_TYPES),
  scope_id: z.string().nullable(),
  granted_at: z.string(),
  granted_by: z.string(),
  expires_at: z.string().nullable(),
  /** false once expires_at has passed: the grant is kept but confers nothing. */
  active: z.boolean(),
  version: z.number(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

/** The resolved (effective) scope: the union of live grants plus implicit self. */
export const ScopeViewOut = z.object({
  all_estates: z.boolean(),
  estates: z.array(z.string()),
  divisions: z.array(z.string()),
  sections: z.array(z.string()),
  departments: z.array(z.string()),
  facilities: z.array(z.string()),
  self_employment_profile_id: z.string().nullable(),
});

// ---- separation of duties (P1.04): outputs -----------------------------------------------------------

export const AUTHORISATION_KINDS = ['sod_override', 'sensitive_grant'] as const;

export const RequirementOut = z.object({
  key: z.string(),
  kind: z.enum(AUTHORISATION_KINDS),
  rule: z.string(),
  title: z.string(),
  why: z.string(),
  permissions: z.array(z.string()),
  /** true when an active authorisation already covers it. */
  authorised: z.boolean(),
});

export const AccessCheckOut = z.object({
  user_id: z.string(),
  /** The effective permissions the user would hold. */
  permissions: z.array(z.string()),
  requirements: z.array(RequirementOut),
  /** How many requirements still need an authorisation (send them as `authorisations`). */
  missing: z.number(),
});

export const AuthorisationOut = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(AUTHORISATION_KINDS),
  rule: z.string(),
  key: z.string(),
  permissions: z.array(z.string()),
  reason: z.string(),
  authorised_by: z.string(),
  authorised_at: z.string(),
  removed_at: z.string().nullable(),
  removed_by: z.string().nullable(),
  active: z.boolean(),
});

export const AuthorisationParams = z.object({ id: zId, authorisationId: zId });

export const SodRuleOut = z.object({
  code: z.string(),
  title: z.string(),
  why: z.string(),
  combinations: z.array(z.array(z.string())),
});

const UserRef = z.object({ id: z.string(), username: z.string() });

export const ConcentrationReportOut = z.object({
  generated_at: z.string(),
  /** Every active override, and whether the user still holds the combination. */
  active_overrides: z.array(AuthorisationOut.extend({ user: UserRef, still_held: z.boolean() })),
  /** Each sensitive permission currently held, by whom, and whether it was authorised. */
  sensitive_holders: z.array(
    z.object({
      permission: z.string(),
      why: z.string(),
      holders: z.array(UserRef.extend({ authorised: z.boolean() })),
    }),
  ),
  /** Users holding four or more active roles (P6 §5.4). */
  users_with_many_roles: z.array(UserRef.extend({ roles: z.array(z.string()) })),
  /** Users holding both approve and post in the same domain. */
  approve_and_post: z.array(UserRef.extend({ modules: z.array(z.string()) })),
  /** The review: conflicts and sensitive permissions held WITHOUT an authorisation. */
  unauthorised: z.array(UserRef.extend({ requirements: z.array(RequirementOut) })),
});
