import { z } from 'zod';

import { zPassword } from '../../core/auth/password.js';
import { UserOut } from './identity.schema.js';

/** Request and response schemas of /auth (Spec P4 §2.2.3). */

export const LoginBody = z.strictObject({
  username: z.string().trim().min(1).max(50),
  // The policy (length) applies when a password is SET, not when one is presented: an old password
  // that predates the policy must still be able to sign in and then be changed.
  password: z.string().min(1).max(128).meta({ format: 'password' }),
});

export const TokenOut = z.object({
  access_token: z
    .string()
    .meta({ description: 'Send as `Authorization: Bearer <token>`. Keep it in memory only.' }),
  token_type: z.literal('Bearer'),
  expires_in: z.number().meta({ description: 'Seconds until the access token expires.' }),
  expires_at: z.string(),
  session_id: z.string(),
  must_change_password: z.boolean().meta({
    description:
      'When true, every other endpoint answers 403 PASSWORD_CHANGE_REQUIRED until the password is changed.',
  }),
  user: z.object({ id: z.string(), username: z.string() }),
});

export const MeOut = z.object({
  user: UserOut,
  /** Flattened effective permissions, for permission-aware UI. Every endpoint still enforces its own. */
  permissions: z.array(z.string()),
  /** Resolved data scope. Arrives with P1.03; null until then. */
  scope: z.object({}).loose().nullable(),
  session_id: z.string().nullable(),
  must_change_password: z.boolean(),
});

export const SessionOut = z.object({
  id: z.string(),
  created_at: z.string(),
  last_used_at: z.string(),
  expires_at: z.string(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  current: z.boolean(),
});

export const AcceptedOut = z.object({ message: z.string() });

export const ForgotPasswordBody = z.strictObject({ email: z.email().max(254) });

export const ResetPasswordBody = z.strictObject({
  token: z.string().min(20).max(200),
  new_password: zPassword,
});

export const ChangePasswordBody = z.strictObject({
  current_password: z.string().min(1).max(128).meta({ format: 'password' }),
  new_password: zPassword,
});
