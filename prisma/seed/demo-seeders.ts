import { hashPassword } from '../../src/core/auth/password.js';
import type { Seeder } from '../../src/core/db/seed.js';
import type { Tx } from '../../src/core/db/transaction.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { ADMINISTRATOR_ROLE_CODE } from '../../src/modules/identity/permission-catalogue.js';
import {
  BOOTSTRAP_ADMIN_ID,
  seedAdministratorAuthorisations,
} from '../../src/modules/identity/identity.seed.js';

/**
 * DEMO data for staging and local verification (P0.08). Never for production: the entry point refuses
 * APP_ENV=production. Each epic adds the demo records its manager check needs (estates in P1.07, …).
 *
 *   manager  Administrator role + "Demo estate administration" (P1.07), all_estates: the manager's own
 *            login for verification. The Administrator alone holds no business masters (P6 §7.1 R-01).
 *   viewer   a read-only "Demo viewer" role, scoped to estate DEMO-A only: shows what a narrow user sees
 *            (P1.07 check: the other estate is invisible)
 *
 * P1.07 adds two demo estates (DEMO-A, DEMO-B), each with divisions, sections and fields.
 *
 * Idempotent: existing users and roles are left exactly as they are (a password changed through the
 * app is never reset by a re-seed).
 */

export const DEMO_VIEWER_ROLE = 'DEMO_VIEWER';
const DEMO_VIEWER_PERMISSIONS = [
  ['user', 'view'],
  ['role', 'view'],
  ['organisation', 'view'],
  ['estate', 'view'],
  ['division', 'view'],
  ['section', 'view'],
  ['field', 'view'],
] as const;

export const DEMO_ESTATE_ADMIN_ROLE = 'DEMO_ESTATE_ADMIN';
const DEMO_ESTATE_ADMIN_PERMISSIONS = [
  ['organisation', 'view'],
  ['organisation', 'edit'],
  ...['estate', 'division', 'section', 'field'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => [m, a] as const),
  ),
] as const;

/** A demo role holding at least these permissions: created if missing, missing permissions added. */
async function ensureRole(
  tx: Tx,
  code: string,
  name: string,
  description: string,
  permissions: readonly (readonly [string, string])[],
): Promise<{ id: bigint; inserted: number }> {
  let inserted = 0;
  let role = await tx.role.findUnique({ where: { code }, select: { id: true } });
  if (!role) {
    role = await tx.role.create({
      data: { code, name, description, createdBy: BOOTSTRAP_ADMIN_ID },
      select: { id: true },
    });
    inserted += 1;
  }
  const perms = await tx.permission.findMany({
    where: { OR: permissions.map(([module, action]) => ({ module, action })) },
    select: { id: true },
  });
  if (perms.length !== permissions.length)
    throw new Error(`${code}: a permission is missing from the catalogue`);
  const { count } = await tx.rolePermission.createMany({
    data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
    skipDuplicates: true,
  });
  return { id: role.id, inserted: inserted + count };
}

async function ensureUserRole(tx: Tx, userId: bigint, roleId: bigint): Promise<number> {
  const has = await tx.userRole.findFirst({ where: { userId, roleId }, select: { userId: true } });
  if (has) return 0;
  await tx.userRole.create({ data: { userId, roleId, grantedBy: BOOTSTRAP_ADMIN_ID } });
  return 1;
}

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

        const viewerRole = await ensureRole(
          tx,
          DEMO_VIEWER_ROLE,
          'Demo viewer',
          'Staging demo: may look at users, roles and the estate hierarchy, change nothing.',
          DEMO_VIEWER_PERMISSIONS,
        );
        inserted += viewerRole.inserted;
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
        inserted += await seedAdministratorAuthorisations(
          tx,
          manager.id,
          'Staging demo account for manager verification. Seeded, never in production.',
        );
        const estateAdmin = await ensureRole(
          tx,
          DEMO_ESTATE_ADMIN_ROLE,
          'Demo estate administration',
          'Staging demo: manages the organisation and the estate hierarchy (P1.07).',
          DEMO_ESTATE_ADMIN_PERMISSIONS,
        );
        inserted += estateAdmin.inserted + (await ensureUserRole(tx, manager.id, estateAdmin.id));

        const viewer = await ensureUser(tx, 'viewer', 'viewer@rupai.local', hash);
        if (viewer.created) inserted += 1;
        inserted += await ensureUserRole(tx, viewer.id, viewerRole.id);
        return { inserted, updated: 0 };
      },
    },
    demoHierarchySeeder,
  ];
}

/** Two demo estates, each with two divisions of two sections of three fields (P1.07). */
const DEMO_ESTATES = [
  { code: 'DEMO-A', name: 'Rupai Hills Tea Estate', district: 'Moulvibazar', prefix: 'A' },
  { code: 'DEMO-B', name: 'Jamuna Valley Tea Estate', district: 'Sylhet', prefix: 'B' },
] as const;

const demoHierarchySeeder: Seeder = {
  name: 'demo: estates, divisions, sections and fields; the viewer sees DEMO-A only',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const org = await tx.organisation.findFirstOrThrow({ select: { id: true } });
      const by = BOOTSTRAP_ADMIN_ID;
      const estateIds: bigint[] = [];
      for (const e of DEMO_ESTATES) {
        let estate = await tx.estate.findFirst({ where: { code: e.code }, select: { id: true } });
        if (!estate) {
          estate = await tx.estate.create({
            data: {
              organisationId: org.id,
              code: e.code,
              name: e.name,
              district: e.district,
              ownershipType: 'owned',
              createdBy: by,
            },
            select: { id: true },
          });
          inserted += 1;
        }
        estateIds.push(estate.id);
        for (const div of ['NORTH', 'SOUTH']) {
          let division = await tx.division.findFirst({
            where: { estateId: estate.id, code: div },
            select: { id: true },
          });
          if (!division) {
            division = await tx.division.create({
              data: {
                estateId: estate.id,
                code: div,
                name: `${div === 'NORTH' ? 'North' : 'South'} Division`,
                createdBy: by,
              },
              select: { id: true },
            });
            inserted += 1;
          }
          for (const n of [1, 2]) {
            const code = `${div.charAt(0)}${String(n)}`;
            let section = await tx.section.findFirst({
              where: { divisionId: division.id, code },
              select: { id: true },
            });
            if (!section) {
              section = await tx.section.create({
                data: { divisionId: division.id, code, name: `Section ${code}`, createdBy: by },
                select: { id: true },
              });
              inserted += 1;
            }
            for (const f of [1, 2, 3]) {
              const fieldNumber = `${e.prefix}-${code}-${String(f)}`;
              const exists = await tx.field.findFirst({
                where: { estateId: estate.id, fieldNumber },
                select: { id: true },
              });
              if (exists) continue;
              await tx.field.create({
                data: {
                  sectionId: section.id,
                  estateId: estate.id,
                  fieldNumber,
                  grossArea: `${String(10 + f * 2)}.500`,
                  plantedArea: `${String(9 + f * 2)}.750`,
                  fieldStatus: f === 3 ? 'young' : 'producing',
                  createdBy: by,
                },
              });
              inserted += 1;
            }
          }
        }
      }
      // The viewer sees DEMO-A and nothing of DEMO-B.
      const viewer = await tx.user.findUnique({ where: { username: 'viewer' }, select: { id: true } });
      const [demoA] = estateIds;
      if (viewer && demoA !== undefined) {
        const grant = await tx.userScope.findFirst({
          where: { userId: viewer.id, scopeType: 'estate', scopeId: demoA },
        });
        if (!grant) {
          await tx.userScope.create({
            data: { userId: viewer.id, scopeType: 'estate', scopeId: demoA, grantedBy: by, createdBy: by },
          });
          inserted += 1;
        }
      }
      return { inserted, updated: 0 };
    }),
};
