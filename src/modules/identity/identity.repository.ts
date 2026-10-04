import type { Prisma } from '../../generated/prisma/client.js';
import type { Tx } from '../../core/db/transaction.js';
import { ADMINISTRATOR_ROLE_CODE } from './permission-catalogue.js';

/**
 * The only layer of the identity module that touches Prisma. No business rules here.
 *
 * Users, roles and permissions are organisation-tier records: they are outside data scope by design
 * (P6 §4.2), so these queries carry no scope filter. Permission is the only gate.
 */

const userWithRoles = {
  roles: {
    include: { role: { select: { id: true, code: true, name: true, status: true } } },
    orderBy: { role: { code: 'asc' } },
  },
} as const satisfies Prisma.UserInclude;

export type UserRow = Prisma.UserGetPayload<{ include: typeof userWithRoles }>;

const roleWithPermissions = {
  permissions: { include: { permission: { select: { module: true, action: true } } } },
  _count: { select: { users: true } },
} as const satisfies Prisma.RoleInclude;

export type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleWithPermissions }>;

// ---- users -------------------------------------------------------------------------------------

export function findUser(tx: Tx, id: bigint): Promise<UserRow | null> {
  return tx.user.findUnique({ where: { id }, include: userWithRoles });
}

export async function listUsers(
  tx: Tx,
  args: {
    where: Prisma.UserWhereInput;
    orderBy: Prisma.UserOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
): Promise<{ rows: UserRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    tx.user.findMany({ ...args, include: userWithRoles }),
    tx.user.count({ where: args.where }),
  ]);
  return { rows, total };
}

export function insertUser(tx: Tx, data: Prisma.UserUncheckedCreateInput): Promise<{ id: bigint }> {
  return tx.user.create({ data, select: { id: true } });
}

/** Conditional update (P4 §5.1): applies only if the row is still at `version`. Returns rows changed. */
export async function updateUserAtVersion(
  tx: Tx,
  id: bigint,
  version: number,
  data: Prisma.UserUncheckedUpdateManyInput,
  actorId: bigint,
): Promise<boolean> {
  const { count } = await tx.user.updateMany({
    where: { id, version },
    data: { ...data, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
  });
  return count === 1;
}

export async function deleteUser(tx: Tx, id: bigint): Promise<void> {
  await tx.user.delete({ where: { id } });
}

export async function replaceUserRoles(
  tx: Tx,
  userId: bigint,
  grants: readonly { roleId: bigint; expiresAt: Date | null }[],
  actorId: bigint,
): Promise<void> {
  const keep = grants.map((g) => g.roleId);
  await tx.userRole.deleteMany({ where: { userId, roleId: { notIn: keep } } });
  const existing = await tx.userRole.findMany({ where: { userId } });
  const byRole = new Map(existing.map((e) => [e.roleId, e]));
  for (const g of grants) {
    const current = byRole.get(g.roleId);
    if (!current) {
      await tx.userRole.create({
        data: { userId, roleId: g.roleId, grantedBy: actorId, expiresAt: g.expiresAt },
      });
    } else if ((current.expiresAt?.getTime() ?? null) !== (g.expiresAt?.getTime() ?? null)) {
      // A changed expiry is a new grant decision: record who made it and when.
      await tx.userRole.update({
        where: { userId_roleId: { userId, roleId: g.roleId } },
        data: { expiresAt: g.expiresAt, grantedBy: actorId, grantedAt: new Date() },
      });
    }
  }
}

/**
 * Serialises every change that could affect who administers the system, so two concurrent changes
 * cannot each leave "one other" administrator and together leave none.
 */
export async function lockAdministratorRole(tx: Tx): Promise<bigint | null> {
  const rows = await tx.$queryRaw<{ id: bigint }[]>`
    SELECT id FROM role WHERE code = ${ADMINISTRATOR_ROLE_CODE} FOR UPDATE`;
  return rows[0]?.id ?? null;
}

/** Active users holding the Administrator role PERMANENTLY (a lapsing grant cannot be the last one). */
export function countPermanentAdministrators(tx: Tx, adminRoleId: bigint): Promise<number> {
  return tx.user.count({
    where: { status: 'active', roles: { some: { roleId: adminRoleId, expiresAt: null } } },
  });
}

// ---- roles -------------------------------------------------------------------------------------

export function findRole(tx: Tx, id: bigint): Promise<RoleRow | null> {
  return tx.role.findUnique({ where: { id }, include: roleWithPermissions });
}

export function findRolesByIds(tx: Tx, ids: readonly bigint[]) {
  return tx.role.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } });
}

export async function listRoles(
  tx: Tx,
  args: {
    where: Prisma.RoleWhereInput;
    orderBy: Prisma.RoleOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
): Promise<{ rows: RoleRow[]; total: number }> {
  const [rows, total] = await Promise.all([
    tx.role.findMany({ ...args, include: roleWithPermissions }),
    tx.role.count({ where: args.where }),
  ]);
  return { rows, total };
}

export function insertRole(tx: Tx, data: Prisma.RoleUncheckedCreateInput): Promise<{ id: bigint }> {
  return tx.role.create({ data, select: { id: true } });
}

export async function updateRoleAtVersion(
  tx: Tx,
  id: bigint,
  version: number,
  data: Prisma.RoleUncheckedUpdateManyInput,
  actorId: bigint,
): Promise<boolean> {
  const { count } = await tx.role.updateMany({
    where: { id, version },
    data: { ...data, version: { increment: 1 }, updatedAt: new Date(), updatedBy: actorId },
  });
  return count === 1;
}

export async function deleteRole(tx: Tx, id: bigint): Promise<void> {
  await tx.role.delete({ where: { id } });
}

export async function replaceRolePermissions(
  tx: Tx,
  roleId: bigint,
  permissionIds: readonly bigint[],
): Promise<void> {
  await tx.rolePermission.deleteMany({ where: { roleId } });
  if (permissionIds.length > 0) {
    await tx.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
    });
  }
}

// ---- permissions -------------------------------------------------------------------------------

export function findPermissionIds(tx: Tx, keys: readonly { module: string; action: string }[]) {
  return tx.permission.findMany({
    where: { OR: keys.map((k) => ({ module: k.module, action: k.action })) },
    select: { id: true, module: true, action: true },
  });
}

export async function listPermissions(
  tx: Tx,
  args: {
    where: Prisma.PermissionWhereInput;
    orderBy: Prisma.PermissionOrderByWithRelationInput[];
    skip: number;
    take: number;
  },
) {
  const [rows, total] = await Promise.all([
    tx.permission.findMany(args),
    tx.permission.count({ where: args.where }),
  ]);
  return { rows, total };
}

// ---- data scope grants (P1.03) -----------------------------------------------------------------

export function listScopeGrants(tx: Tx, userId: bigint) {
  return tx.userScope.findMany({
    where: { userId },
    orderBy: [{ scopeType: 'asc' }, { scopeId: 'asc' }, { id: 'asc' }],
  });
}

export type ScopeGrantRow = Awaited<ReturnType<typeof listScopeGrants>>[number];

export function findScopeGrant(tx: Tx, userId: bigint, grantId: bigint) {
  return tx.userScope.findFirst({ where: { id: grantId, userId } });
}

export function insertScopeGrant(
  tx: Tx,
  data: {
    userId: bigint;
    scopeType: string;
    scopeId: bigint | null;
    expiresAt: Date | null;
    actorId: bigint;
  },
): Promise<{ id: bigint }> {
  return tx.userScope.create({
    data: {
      userId: data.userId,
      scopeType: data.scopeType,
      scopeId: data.scopeId,
      expiresAt: data.expiresAt,
      grantedBy: data.actorId,
      createdBy: data.actorId,
    },
    select: { id: true },
  });
}

/** Conditional update (P4 §5.1). A changed expiry is a new grant decision: who and when are recorded. */
export async function updateScopeGrantExpiryAtVersion(
  tx: Tx,
  grantId: bigint,
  version: number,
  expiresAt: Date | null,
  actorId: bigint,
): Promise<boolean> {
  const now = new Date();
  const { count } = await tx.userScope.updateMany({
    where: { id: grantId, version },
    data: {
      expiresAt,
      grantedAt: now,
      grantedBy: actorId,
      version: { increment: 1 },
      updatedAt: now,
      updatedBy: actorId,
    },
  });
  return count === 1;
}

export async function deleteScopeGrant(tx: Tx, userId: bigint, grantId: bigint): Promise<number> {
  const { count } = await tx.userScope.deleteMany({ where: { id: grantId, userId } });
  return count;
}

export function userExists(tx: Tx, id: bigint) {
  return tx.user.findUnique({ where: { id }, select: { id: true } });
}
