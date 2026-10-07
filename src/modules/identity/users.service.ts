import type { z } from 'zod';

import type { PermissionResolver } from '../../core/auth/authorize.js';
import { hashPassword } from '../../core/auth/password.js';
import type { SessionStore } from '../../core/auth/sessions.js';
import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  AssignRolesBody,
  CreateUserBody,
  EffectivePermissionsOut,
  PatchUserBody,
  UserOut,
  UserStatus,
} from './identity.schema.js';
import { auditCreate, auditDelete, auditUpdate, recordStatusChange } from '../../core/audit/audit.js';
import { enforceAuthorisations } from './access.service.js';
import { USER_AUDIT, userAuditValues } from './identity.audit.js';
import * as repo from './identity.repository.js';

/**
 * Users (Spec P3 §28.1, P4 §14.1, P6 §11.1).
 *
 *   - A new user has NO roles: a default role is granted by inattention rather than decision (P6 §11.1).
 *   - A new user's password is temporary: must_change_password is set (P3 §32.2).
 *   - The password hash, the two-factor secret and the failed-attempt counter never leave the server.
 *   - Users are retired by DISABLING them. Disabling ends every session at once (P6 §11.1, P4 §2.2.1).
 *     Roles are kept on a disabled account so that history stays interpretable. DELETE exists only for
 *     an account created in error and never used.
 *   - The system can never be left without an active, permanently granted Administrator.
 */

type UserOutT = z.infer<typeof UserOut>;

export const USER_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  username: { field: 'username' },
  email: { field: 'email' },
};

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function toUserOut(u: repo.UserRow): UserOutT {
  return {
    id: u.id.toString(),
    username: u.username,
    email: u.email,
    phone: u.phone,
    status: u.status as UserStatus,
    must_change_password: u.mustChangePassword,
    two_factor_enabled: u.twoFactorEnabled,
    last_login_at: iso(u.lastLoginAt),
    locked_until: iso(u.lockedUntil),
    person_id: u.personId?.toString() ?? null,
    employment_profile_id: u.employmentProfileId?.toString() ?? null,
    roles: u.roles.map((ur) => ({
      id: ur.role.id.toString(),
      code: ur.role.code,
      name: ur.role.name,
      status: ur.role.status as 'active' | 'inactive',
      granted_at: ur.grantedAt.toISOString(),
      expires_at: iso(ur.expiresAt),
    })),
    version: u.version,
    created_at: u.createdAt.toISOString(),
    updated_at: iso(u.updatedAt),
  };
}

/** Unique-key violations become 422 DUPLICATE_KEY on the right field. */
function duplicateUser(err: unknown): never {
  const v = constraintViolation(err);
  if (v?.kind === 'unique') {
    const field = v.index === 'ux_user_email' ? 'email' : 'username';
    throw new AppError('DUPLICATE_KEY', `This ${field} is already in use.`, [
      { field, code: 'DUPLICATE_KEY', message: `Another user already has this ${field}.` },
    ]);
  }
  throw err;
}

async function loadOrNotFound(tx: Tx, id: bigint): Promise<repo.UserRow> {
  const user = await repo.findUser(tx, id);
  if (!user) throw Errors.notFound('User not found.');
  return user;
}

/** After a failed conditional update: 404 if the user is gone, otherwise 409 with the current state. */
async function versionConflict(tx: Tx, id: bigint): Promise<never> {
  const current = await loadOrNotFound(tx, id);
  throw Errors.versionConflict({ version: current.version, resource: toUserOut(current) });
}

function assertVersion(user: repo.UserRow, expected: number): void {
  if (user.version !== expected) {
    throw Errors.versionConflict({ version: user.version, resource: toUserOut(user) });
  }
}

/**
 * Refuses a change after which no active user would hold the Administrator role permanently.
 * `change` runs between the lock and the count, inside the same transaction.
 */
async function guardLastAdministrator(tx: Tx, change: () => Promise<void>): Promise<void> {
  const adminRoleId = await repo.lockAdministratorRole(tx);
  if (adminRoleId === null) return change(); // not seeded yet (tests that build their own data)
  const before = await repo.countPermanentAdministrators(tx, adminRoleId);
  await change();
  const after = await repo.countPermanentAdministrators(tx, adminRoleId);
  if (before > 0 && after === 0) {
    throw new AppError(
      'LAST_ADMINISTRATOR',
      'This would leave no active user holding the Administrator role.',
      [
        {
          code: 'LAST_ADMINISTRATOR',
          message: 'Grant the Administrator role permanently to another active user first.',
        },
      ],
    );
  }
}

export function usersService(db: Database, permissions: PermissionResolver, sessions: SessionStore) {
  return {
    async list(query: ListQuery) {
      const roleFilter = query.filters.find((f) => f.field === 'role_id');
      const rest = { ...query, filters: query.filters.filter((f) => f.field !== 'role_id') };
      const where: Prisma.UserWhereInput = toWhere(rest, USER_LIST_FIELDS);
      if (roleFilter) {
        const ids = (Array.isArray(roleFilter.value) ? roleFilter.value : [roleFilter.value]).map((v) =>
          BigInt(String(v)),
        );
        where.roles = { some: { roleId: { in: ids } } };
      }
      const { rows, total } = await repo.listUsers(db, {
        where,
        orderBy: [...toOrderBy(query.sort, USER_LIST_FIELDS), { id: 'asc' }],
        ...toPaging(query),
      });
      return { items: rows.map(toUserOut), total };
    },

    async get(id: bigint): Promise<UserOutT> {
      return toUserOut(await loadOrNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateUserBody>, actorId: bigint): Promise<UserOutT> {
      const passwordHash = await hashPassword(body.initial_password);
      return withTransaction(db, async (tx) => {
        const { id } = await repo
          .insertUser(tx, {
            username: body.username,
            email: body.email ?? null,
            phone: body.phone ?? null,
            passwordHash,
            mustChangePassword: true,
            status: 'active',
            createdBy: actorId,
          })
          .catch(duplicateUser);
        const out = toUserOut(await loadOrNotFound(tx, id));
        await auditCreate(tx, USER_AUDIT, id, userAuditValues(out), { actorId });
        await recordStatusChange(tx, USER_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    /** PUT (full) and PATCH (partial) both land here. Username, email and phone only. */
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchUserBody>,
      actorId: bigint,
    ): Promise<UserOutT> {
      return withTransaction(db, async (tx) => {
        const data: Prisma.UserUncheckedUpdateManyInput = {
          ...(changes.username !== undefined ? { username: changes.username } : {}),
          ...(changes.email !== undefined ? { email: changes.email } : {}),
          ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
        };
        const before = toUserOut(await loadOrNotFound(tx, id));
        const ok = await repo
          .updateUserAtVersion(tx, id, expectedVersion, data, actorId)
          .catch(duplicateUser);
        if (!ok) await versionConflict(tx, id);
        const after = toUserOut(await loadOrNotFound(tx, id));
        await auditUpdate(tx, USER_AUDIT, id, userAuditValues(before), userAuditValues(after), { actorId });
        return after;
      });
    },

    async setStatus(
      id: bigint,
      expectedVersion: number,
      status: UserStatus,
      actorId: bigint,
    ): Promise<UserOutT> {
      const { out, revoked } = await withTransaction(db, async (tx) => {
        const user = await loadOrNotFound(tx, id);
        assertVersion(user, expectedVersion);
        if (user.status === status) return { out: toUserOut(user), revoked: [] }; // nothing to change
        await guardLastAdministrator(tx, async () => {
          const ok = await repo.updateUserAtVersion(tx, id, expectedVersion, { status }, actorId);
          if (!ok) await versionConflict(tx, id);
        });
        // Disabling ends every session in the same transaction, so access ends on the next request
        // rather than at token expiry.
        const ended = status === 'disabled' ? await sessions.revokeForUser(tx, id, 'user_disabled') : [];
        const after = toUserOut(await loadOrNotFound(tx, id));
        await auditUpdate(tx, USER_AUDIT, id, userAuditValues(toUserOut(user)), userAuditValues(after), {
          actorId,
        });
        await recordStatusChange(tx, USER_AUDIT.type, id, user.status, status, { actorId });
        return { out: after, revoked: ended };
      });
      await sessions.markRevoked(revoked);
      return out;
    },

    async assignRoles(
      id: bigint,
      expectedVersion: number,
      body: z.infer<typeof AssignRolesBody>,
      actorId: bigint,
    ): Promise<UserOutT> {
      const now = Date.now();
      const problems = [];
      const seen = new Set<bigint>();
      for (const [i, g] of body.roles.entries()) {
        if (seen.has(g.role_id)) {
          problems.push({
            field: `roles.${String(i)}.role_id`,
            code: 'VALIDATION_FAILED',
            message: 'Listed twice.',
          });
        }
        seen.add(g.role_id);
        if (g.expires_at && g.expires_at.getTime() <= now) {
          problems.push({
            field: `roles.${String(i)}.expires_at`,
            code: 'VALIDATION_FAILED',
            message: 'Must be in the future.',
          });
        }
      }
      if (problems.length > 0) throw Errors.validation(problems);

      return withTransaction(db, async (tx) => {
        const user = await loadOrNotFound(tx, id);
        assertVersion(user, expectedVersion);

        const found = new Map((await repo.findRolesByIds(tx, [...seen])).map((r) => [r.id, r.status]));
        const bad = body.roles.flatMap((g, i) => {
          const status = found.get(g.role_id);
          if (status === 'active') return [];
          return [
            {
              field: `roles.${String(i)}.role_id`,
              code: 'VALIDATION_FAILED',
              message: status ? 'This role is inactive.' : 'No such role.',
            },
          ];
        });
        if (bad.length > 0) throw Errors.validation(bad);

        // Separation of duties (P6 §9.1): the union of the new roles, checked before anything changes.
        await enforceAuthorisations(
          tx,
          [
            {
              userId: id,
              username: user.username,
              permissions: await repo.permissionKeysOfRoles(tx, [...seen]),
            },
          ],
          body.authorisations ?? [],
          actorId,
        );

        await guardLastAdministrator(tx, async () => {
          await repo.replaceUserRoles(
            tx,
            id,
            body.roles.map((g) => ({ roleId: g.role_id, expiresAt: g.expires_at ?? null })),
            actorId,
          );
          // The user's authority changed, so its version moves: a stale editor of this user gets 409.
          const ok = await repo.updateUserAtVersion(tx, id, expectedVersion, {}, actorId);
          if (!ok) await versionConflict(tx, id);
        });
        const after = toUserOut(await loadOrNotFound(tx, id));
        await auditUpdate(tx, USER_AUDIT, id, userAuditValues(toUserOut(user)), userAuditValues(after), {
          actorId,
        });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint): Promise<void> {
      if (id === actorId) {
        throw new AppError('INVARIANT_VIOLATED', 'You cannot delete your own account.', [
          { code: 'INVARIANT_VIOLATED', message: 'Ask another administrator.' },
        ]);
      }
      await withTransaction(db, async (tx) => {
        const user = await loadOrNotFound(tx, id);
        if (user.lastLoginAt) {
          throw new AppError('REFERENCED_RECORD', 'This user has signed in, so it cannot be deleted.', [
            { code: 'REFERENCED_RECORD', message: 'Disable the account instead.' },
          ]);
        }
        await guardLastAdministrator(tx, async () => {
          await repo.deleteUser(tx, id).catch((err: unknown) => {
            if (constraintViolation(err)?.kind === 'referenced') {
              throw new AppError('REFERENCED_RECORD', 'This user is referenced by other records.', [
                { code: 'REFERENCED_RECORD', message: 'Disable the account instead.' },
              ]);
            }
            throw err;
          });
        });
        await auditDelete(tx, USER_AUDIT, id, userAuditValues(toUserOut(user)), { actorId });
      });
    },

    async effectivePermissions(id: bigint): Promise<z.infer<typeof EffectivePermissionsOut>> {
      const user = await loadOrNotFound(db, id);
      const keys = await permissions.permissionsOf(id);
      return {
        user_id: user.id.toString(),
        status: user.status as UserStatus,
        permissions: [...keys].sort(),
      };
    },
  };
}

export type UsersService = ReturnType<typeof usersService>;
