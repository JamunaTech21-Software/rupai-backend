import type { z } from 'zod';

import { constraintViolation } from '../../core/db/errors.js';
import { toOrderBy, toPaging, toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors, type ErrorDetail } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { CreateRoleBody, PatchRoleBody, RoleOut, RoleStatus } from './identity.schema.js';
import { auditCreate, auditDelete, auditUpdate, recordStatusChange } from '../../core/audit/audit.js';
import { enforceAuthorisations, type ProvidedAuthorisation } from './access.service.js';
import { ROLE_AUDIT, roleAuditValues } from './identity.audit.js';
import * as repo from './identity.repository.js';
import { PERMISSION_KEYS } from './permission-catalogue.js';

/**
 * Roles (Spec P3 §28.1, P6 §5, §11, §12.1).
 *
 *   - Roles describe jobs and are created by the client's administrator (only Administrator is seeded).
 *   - A permission must exist in the catalogue: inventing one achieves nothing (P6 §3.3).
 *   - A system role (is_system) may be renamed and re-described, but not deleted, deactivated, re-coded
 *     or re-permissioned. Its permission set is maintained by the seeder, which keeps the Administrator
 *     free of any business approve, reject or post permission (P6 §5.5).
 *   - A role held by any user cannot be deleted (REFERENCED_RECORD); deactivate it instead. Holders of
 *     an inactive role lose its permissions immediately.
 *
 * Separation-of-duties checks on a role's permissions arrive in P1.04.
 */

type RoleOutT = z.infer<typeof RoleOut>;

export const ROLE_LIST_FIELDS: ListFieldMap = {
  status: { field: 'status' },
  code: { field: 'code' },
  is_system: { field: 'isSystem' },
  name: { field: 'name' },
  sort_order: { field: 'sortOrder' },
};

export function toRoleOut(r: repo.RoleRow): RoleOutT {
  return {
    id: r.id.toString(),
    code: r.code,
    name: r.name,
    description: r.description,
    sort_order: r.sortOrder,
    is_system: r.isSystem,
    status: r.status as RoleStatus,
    permissions: r.permissions.map((p) => `${p.permission.module}.${p.permission.action}`).sort(),
    user_count: r._count.users,
    version: r.version,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt?.toISOString() ?? null,
  };
}

/**
 * A role's new permission set reaches every active holder at once, so the union of each holder's roles
 * is re-checked (P6 §9.1: "broadening a role surfaces conflicts in users who already hold it").
 */
async function checkHolders(
  tx: Tx,
  roleId: bigint,
  rolePermissions: ReadonlySet<string>,
  provided: readonly ProvidedAuthorisation[],
  actorId: bigint,
): Promise<void> {
  const holders = await repo.activeHoldersOfRole(tx, roleId);
  const subjects = [];
  for (const h of holders) {
    const others = (await repo.liveRoleIdsOfUser(tx, h.id)).filter((r) => r !== roleId);
    const permissions = await repo.permissionKeysOfRoles(tx, others);
    for (const p of rolePermissions) permissions.add(p);
    subjects.push({ userId: h.id, username: h.username, permissions });
  }
  await enforceAuthorisations(tx, subjects, provided, actorId);
}

function systemRecord(what: string): AppError {
  return new AppError('SYSTEM_RECORD', `A system role cannot be ${what}.`, [
    { code: 'SYSTEM_RECORD', message: 'System roles may only be renamed or re-described.' },
  ]);
}

function duplicateRole(err: unknown): never {
  if (constraintViolation(err)?.kind === 'unique') {
    throw new AppError('DUPLICATE_KEY', 'This role code is already in use.', [
      { field: 'code', code: 'DUPLICATE_KEY', message: 'Another role already has this code.' },
    ]);
  }
  throw err;
}

async function loadOrNotFound(tx: Tx, id: bigint): Promise<repo.RoleRow> {
  const role = await repo.findRole(tx, id);
  if (!role) throw Errors.notFound('Role not found.');
  return role;
}

/** Catalogue keys → permission ids. Unknown keys are a 422 on the exact list entry. */
async function resolvePermissions(tx: Tx, keys: readonly string[]): Promise<bigint[]> {
  const unique = [...new Set(keys)];
  const unknown: ErrorDetail[] = keys.flatMap((k, i) =>
    PERMISSION_KEYS.has(k)
      ? []
      : [
          {
            field: `permissions.${String(i)}`,
            code: 'VALIDATION_FAILED',
            message: `Unknown permission ${k}.`,
          },
        ],
  );
  if (unknown.length > 0) throw Errors.validation(unknown);
  if (unique.length === 0) return [];

  const rows = await repo.findPermissionIds(
    tx,
    unique.map((k) => {
      const [module = '', action = ''] = k.split('.');
      return { module, action };
    }),
  );
  if (rows.length !== unique.length) {
    // The catalogue knows it but the database does not: the seed has not been run.
    throw new Error('permission catalogue is not seeded; run `npm run db:seed`');
  }
  return rows.map((r) => r.id);
}

export function rolesService(db: Database) {
  return {
    async list(query: ListQuery) {
      const where: Prisma.RoleWhereInput = toWhere(query, ROLE_LIST_FIELDS);
      const { rows, total } = await repo.listRoles(db, {
        where,
        orderBy: [...toOrderBy(query.sort, ROLE_LIST_FIELDS), { id: 'asc' }],
        ...toPaging(query),
      });
      return { items: rows.map(toRoleOut), total };
    },

    async get(id: bigint): Promise<RoleOutT> {
      return toRoleOut(await loadOrNotFound(db, id));
    },

    async create(body: z.infer<typeof CreateRoleBody>, actorId: bigint): Promise<RoleOutT> {
      return withTransaction(db, async (tx) => {
        const permissionIds = await resolvePermissions(tx, body.permissions ?? []);
        const { id } = await repo
          .insertRole(tx, {
            code: body.code,
            name: body.name,
            description: body.description ?? null,
            sortOrder: body.sort_order ?? 0,
            isSystem: false,
            status: 'active',
            createdBy: actorId,
          })
          .catch(duplicateRole);
        await repo.replaceRolePermissions(tx, id, permissionIds);
        const out = toRoleOut(await loadOrNotFound(tx, id));
        await auditCreate(tx, ROLE_AUDIT, id, roleAuditValues(out), { actorId });
        await recordStatusChange(tx, ROLE_AUDIT.type, id, null, out.status, { actorId });
        return out;
      });
    },

    /** PUT (full) and PATCH (partial). */
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchRoleBody>,
      actorId: bigint,
    ): Promise<RoleOutT> {
      return withTransaction(db, async (tx) => {
        const role = await loadOrNotFound(tx, id);
        if (role.version !== expectedVersion) {
          throw Errors.versionConflict({ version: role.version, resource: toRoleOut(role) });
        }
        const current = toRoleOut(role);
        if (role.isSystem) {
          if (changes.code !== undefined && changes.code !== role.code) throw systemRecord('re-coded');
          if (
            changes.permissions !== undefined &&
            [...new Set(changes.permissions)].sort().join() !== current.permissions.join()
          ) {
            throw systemRecord('re-permissioned');
          }
        }
        const data: Prisma.RoleUncheckedUpdateManyInput = {
          ...(changes.code !== undefined ? { code: changes.code } : {}),
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.description !== undefined ? { description: changes.description } : {}),
          ...(changes.sort_order !== undefined ? { sortOrder: changes.sort_order } : {}),
        };
        const ok = await repo
          .updateRoleAtVersion(tx, id, expectedVersion, data, actorId)
          .catch(duplicateRole);
        if (!ok) {
          const now = await loadOrNotFound(tx, id);
          throw Errors.versionConflict({ version: now.version, resource: toRoleOut(now) });
        }
        if (changes.permissions !== undefined && !role.isSystem) {
          if (role.status === 'active') {
            await checkHolders(tx, id, new Set(changes.permissions), changes.authorisations ?? [], actorId);
          }
          await repo.replaceRolePermissions(tx, id, await resolvePermissions(tx, changes.permissions));
        } else if ((changes.authorisations ?? []).length > 0) {
          throw Errors.validation([
            {
              field: 'authorisations',
              code: 'VALIDATION_FAILED',
              message: 'Only needed when permissions change.',
            },
          ]);
        }
        const after = toRoleOut(await loadOrNotFound(tx, id));
        await auditUpdate(tx, ROLE_AUDIT, id, roleAuditValues(current), roleAuditValues(after), { actorId });
        return after;
      });
    },

    async setStatus(
      id: bigint,
      expectedVersion: number,
      status: RoleStatus,
      actorId: bigint,
      authorisations: readonly ProvidedAuthorisation[] = [],
    ): Promise<RoleOutT> {
      return withTransaction(db, async (tx) => {
        const role = await loadOrNotFound(tx, id);
        if (role.version !== expectedVersion) {
          throw Errors.versionConflict({ version: role.version, resource: toRoleOut(role) });
        }
        if (role.isSystem && status !== 'active') throw systemRecord('deactivated');
        if (role.status === status) return toRoleOut(role);
        // Reactivating gives the role's permissions back to every holder at once.
        if (status === 'active') {
          const current = new Set(toRoleOut(role).permissions);
          await checkHolders(tx, id, current, authorisations, actorId);
        }
        const ok = await repo.updateRoleAtVersion(tx, id, expectedVersion, { status }, actorId);
        if (!ok) {
          const now = await loadOrNotFound(tx, id);
          throw Errors.versionConflict({ version: now.version, resource: toRoleOut(now) });
        }
        const after = toRoleOut(await loadOrNotFound(tx, id));
        await auditUpdate(tx, ROLE_AUDIT, id, roleAuditValues(toRoleOut(role)), roleAuditValues(after), {
          actorId,
        });
        await recordStatusChange(tx, ROLE_AUDIT.type, id, role.status, status, { actorId });
        return after;
      });
    },

    async remove(id: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        const role = await loadOrNotFound(tx, id);
        if (role.isSystem) throw systemRecord('deleted');
        const before = roleAuditValues(toRoleOut(role));
        await repo.deleteRole(tx, id).catch((err: unknown) => {
          if (constraintViolation(err)?.kind === 'referenced') {
            throw new AppError('REFERENCED_RECORD', 'This role is held by users, so it cannot be deleted.', [
              { code: 'REFERENCED_RECORD', message: 'Remove it from every user, or deactivate it instead.' },
            ]);
          }
          throw err;
        });
        await auditDelete(tx, ROLE_AUDIT, id, before, { actorId });
      });
    },
  };
}

export type RolesService = ReturnType<typeof rolesService>;
