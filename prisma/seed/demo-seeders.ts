import { hashPassword } from '../../src/core/auth/password.js';
import type { Seeder } from '../../src/core/db/seed.js';
import type { Tx } from '../../src/core/db/transaction.js';
import { ADMINISTRATOR_ROLE_CODE } from '../../src/modules/identity/permission-catalogue.js';
import { BOOTSTRAP_ADMIN_ID } from '../../src/modules/identity/identity.seed.js';

/**
 * DEMO data for staging and local verification (P0.08). Never for production: the entry point refuses
 * APP_ENV=production. Each epic adds the demo records its manager check needs (estates in P1.07, …).
 *
 *   manager  Administrator role, all_estates: the manager's own login for verification
 *   viewer   a read-only "Demo viewer" role and NO scope: shows what a narrow user sees
 *
 * Idempotent: existing users and roles are left exactly as they are (a password changed through the
 * app is never reset by a re-seed).
 */

export const DEMO_VIEWER_ROLE = 'DEMO_VIEWER';
const DEMO_VIEWER_PERMISSIONS = [
  ['user', 'view'],
  ['role', 'view'],
] as const;

async function ensureUser(
  tx: Tx,
  username: string,
  email: string,
  passwordHash: string,
): Promise<{ id: bigint; created: boolean }> {
  const existing = await tx.user.findUnique({ where: { username }, select: { id: true } });
  if (existing) return { id: existing.id, created: false };
  const u = await tx.user.create({
    data: { username, email, passwordHash, mustChangePassword: false, createdBy: BOOTSTRAP_ADMIN_ID },
    select: { id: true },
  });
  return { id: u.id, created: true };
}

export function demoSeeders(password: string): Seeder[] {
  return [
    {
      name: 'demo: manager and viewer accounts',
      async run(tx) {
        let inserted = 0;
        const hash = await hashPassword(password);

        let viewerRole = await tx.role.findUnique({
          where: { code: DEMO_VIEWER_ROLE },
          select: { id: true },
        });
        if (!viewerRole) {
          const created = await tx.role.create({
            data: {
              code: DEMO_VIEWER_ROLE,
              name: 'Demo viewer',
              description: 'Staging demo: may look at users and roles, change nothing.',
              createdBy: BOOTSTRAP_ADMIN_ID,
            },
            select: { id: true },
          });
          const perms = await tx.permission.findMany({
            where: { OR: DEMO_VIEWER_PERMISSIONS.map(([module, action]) => ({ module, action })) },
            select: { id: true },
          });
          await tx.rolePermission.createMany({
            data: perms.map((p) => ({ roleId: created.id, permissionId: p.id })),
          });
          inserted += 1 + perms.length;
          viewerRole = created;
        }
        const admin = await tx.role.findUniqueOrThrow({
          where: { code: ADMINISTRATOR_ROLE_CODE },
          select: { id: true },
        });

        const manager = await ensureUser(tx, 'manager', 'manager@rupai.local', hash);
        if (manager.created) {
          await tx.userRole.create({
            data: { userId: manager.id, roleId: admin.id, grantedBy: BOOTSTRAP_ADMIN_ID },
          });
          await tx.userScope.create({
            data: {
              userId: manager.id,
              scopeType: 'all_estates',
              grantedBy: BOOTSTRAP_ADMIN_ID,
              createdBy: BOOTSTRAP_ADMIN_ID,
            },
          });
          inserted += 3;
        }
        const viewer = await ensureUser(tx, 'viewer', 'viewer@rupai.local', hash);
        if (viewer.created) {
          await tx.userRole.create({
            data: { userId: viewer.id, roleId: viewerRole.id, grantedBy: BOOTSTRAP_ADMIN_ID },
          });
          inserted += 2;
        }
        return { inserted, updated: 0 };
      },
    },
  ];
}
