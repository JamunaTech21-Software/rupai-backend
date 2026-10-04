import { z } from 'zod';

import { zPassword } from '../../core/auth/password.js';
import { zId } from '../../core/ids/ids.js';
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
export const ReplaceRoleBody = z.strictObject(roleFields);
export const PatchRoleBody = z.strictObject(roleFields).partial();

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
