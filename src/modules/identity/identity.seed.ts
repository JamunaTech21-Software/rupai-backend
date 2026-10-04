import { hashPassword } from '../../core/auth/password.js';
import { seedRows, type Seeder } from '../../core/db/seed.js';
import type { Tx } from '../../core/db/transaction.js';
import { ADMINISTRATOR_PERMISSIONS, ADMINISTRATOR_ROLE_CODE, PERMISSIONS } from './permission-catalogue.js';

/**
 * Identity seed data (Spec P3 §31.2, §32.2, P6 §12.1). Mechanism, not policy, so it ships active:
 *
 *   1. the permission catalogue: every module.action the application enforces (system rows)
 *   2. the bootstrap administrator: user id 1, created by itself, must change password at first login
 *   3. the Administrator role (is_system) with exactly the R-01 permission set, granted to the
 *      bootstrap administrator when nobody holds it
 *
 * The other seventeen roles of P6 §7 are NOT seeded. They are created once the client confirms them.
 */

export const BOOTSTRAP_ADMIN_ID = 1n;

export const permissionCatalogueSeeder: Seeder = {
  name: 'identity: permission catalogue',
  run: (tx) =>
    seedRows(
      tx,
      'permission',
      ['module', 'action'],
      PERMISSIONS.map((p) => ({ module: p.module, action: p.action, description: p.description })),
    ),
};

export interface BootstrapAdmin {
  readonly username: string;
  readonly email: string | null;
  /** Needed only when the bootstrap user does not exist yet. Never logged, never stored in plain text. */
  readonly password: string | undefined;
}

async function ensureBootstrapUser(tx: Tx, admin: BootstrapAdmin): Promise<number> {
  const existing = await tx.user.findUnique({ where: { id: BOOTSTRAP_ADMIN_ID }, select: { id: true } });
  if (existing) return 0;
  if (!admin.password || admin.password.length < 12) {
    throw new Error(
      'BOOTSTRAP_ADMIN_PASSWORD (at least 12 characters) is required to create the first administrator',
    );
  }
  // P3 §32.2: the first user is created with a known id and references itself in its audit column.
  await tx.user.create({
    data: {
      id: BOOTSTRAP_ADMIN_ID,
      username: admin.username,
      email: admin.email,
      passwordHash: await hashPassword(admin.password),
      mustChangePassword: true,
      status: 'active',
      createdBy: BOOTSTRAP_ADMIN_ID,
    },
  });
  return 1;
}

export function administratorSeeder(admin: BootstrapAdmin): Seeder {
  return {
    name: 'identity: bootstrap administrator and Administrator role',
    async run(tx) {
      let inserted = await ensureBootstrapUser(tx, admin);
      let updated = 0;

      const role = await seedRows(tx, 'role', 'code', [
        {
          code: ADMINISTRATOR_ROLE_CODE,
          name: 'System Administrator',
          is_system: true,
          status: 'active',
          created_by: BOOTSTRAP_ADMIN_ID,
        },
      ]);
      inserted += role.inserted;
      const roleId = (
        await tx.role.findUniqueOrThrow({ where: { code: ADMINISTRATOR_ROLE_CODE }, select: { id: true } })
      ).id;

      // The system role's permission set is mechanism: the seed keeps it EXACTLY at R-01, adding what is
      // missing and removing anything else (the API refuses to change it).
      const wanted = await tx.permission.findMany({
        where: {
          OR: ADMINISTRATOR_PERMISSIONS.map((k) => {
            const [module = '', action = ''] = k.split('.');
            return { module, action };
          }),
        },
        select: { id: true },
      });
      if (wanted.length !== ADMINISTRATOR_PERMISSIONS.length) {
        throw new Error('the Administrator permission set names permissions missing from the catalogue');
      }
      const wantedIds = wanted.map((p) => p.id);
      updated += (
        await tx.rolePermission.deleteMany({ where: { roleId, permissionId: { notIn: wantedIds } } })
      ).count;
      inserted += (
        await tx.rolePermission.createMany({
          data: wantedIds.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        })
      ).count;

      // Grant the role to the bootstrap administrator only when NOBODY holds it: once administrators
      // manage it themselves, re-seeding must not undo their decisions.
      const holders = await tx.userRole.count({ where: { roleId } });
      if (holders === 0) {
        await tx.userRole.create({
          data: { userId: BOOTSTRAP_ADMIN_ID, roleId, grantedBy: BOOTSTRAP_ADMIN_ID },
        });
        inserted += 1;
      }
      return { inserted, updated };
    },
  };
}

export function identitySeeders(admin: BootstrapAdmin): Seeder[] {
  return [permissionCatalogueSeeder, administratorSeeder(admin)];
}
