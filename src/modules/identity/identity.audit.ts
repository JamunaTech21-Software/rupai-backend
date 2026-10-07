import type { z } from 'zod';

import type { AuditedRecord, AuditValues } from '../../core/audit/audit.js';
import type { RoleOut, ScopeGrantOut, UserOut } from './identity.schema.js';

/**
 * What the identity module audits (Spec P1 Table 13.1, P6 §11.1: "every assignment and revocation is an
 * audited change"). Users and roles are masters (significant fields; status history because they are
 * stateful). Authorisations are access-control decisions: audited as policy, so the client address and
 * user agent are kept too.
 *
 * Never audited: the password hash, the two-factor secret, sign-in counters (the access log has those).
 */

export const USER_AUDIT: AuditedRecord = {
  type: 'user',
  class: 'master',
  fields: [
    'username',
    'email',
    'phone',
    'status',
    'must_change_password',
    'person_id',
    'employment_profile_id',
    'roles',
    'password',
  ],
};

export const ROLE_AUDIT: AuditedRecord = {
  type: 'role',
  class: 'master',
  fields: ['code', 'name', 'description', 'sort_order', 'status', 'permissions'],
};

export const SCOPE_AUDIT: AuditedRecord = {
  type: 'user_scope',
  class: 'master',
  fields: ['user_id', 'scope_type', 'scope_id', 'expires_at'],
};

export const AUTHORISATION_AUDIT: AuditedRecord = {
  type: 'access_authorisation',
  class: 'policy',
  fields: ['user_id', 'kind', 'rule', 'key', 'permissions', 'reason', 'removed_at'],
};

/** A user's audited values. Roles are recorded as "CODE" or "CODE until <expiry>". */
export function userAuditValues(u: z.infer<typeof UserOut>): AuditValues {
  return {
    username: u.username,
    email: u.email,
    phone: u.phone,
    status: u.status,
    must_change_password: u.must_change_password,
    person_id: u.person_id,
    employment_profile_id: u.employment_profile_id,
    roles: u.roles.map((r) => (r.expires_at ? `${r.code} until ${r.expires_at}` : r.code)).sort(),
  };
}

export function roleAuditValues(r: z.infer<typeof RoleOut>): AuditValues {
  return {
    code: r.code,
    name: r.name,
    description: r.description,
    sort_order: r.sort_order,
    status: r.status,
    permissions: r.permissions,
  };
}

export function scopeAuditValues(g: z.infer<typeof ScopeGrantOut>): AuditValues {
  return { user_id: g.user_id, scope_type: g.scope_type, scope_id: g.scope_id, expires_at: g.expires_at };
}
