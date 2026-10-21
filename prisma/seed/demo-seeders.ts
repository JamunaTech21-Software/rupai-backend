import { hashPassword } from '../../src/core/auth/password.js';
import type { Seeder } from '../../src/core/db/seed.js';
import type { Tx } from '../../src/core/db/transaction.js';
import { figuresOf, parseGeometry, type Geometry } from '../../src/core/geo/geometry.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { businessDateToDb, type BusinessDate } from '../../src/core/time/dates.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
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
 * P1.08 adds two factories and two warehouses (the viewer is granted DEMO-F1 and DEMO-W1 only), warehouse
 * contacts and a party. "Demo estate administration" covers facilities and parties too.
 * P1.09 adds seasons (2025-26 closed and 2026-27 active on DEMO-A, 2026-27 active on DEMO-B) and fiscal
 * year FY2026-27 with its 13 periods, July to October open.
 * P1.10 adds a few of the client's own lookups (departments, designations, worker categories) and three
 * shifts: one organisation-wide, one per demo estate (the viewer sees DEMO-A's, not DEMO-B's).
 *
 * Idempotent: existing users and roles are left exactly as they are (a password changed through the
 * app is never reset by a re-seed).
 */

export const DEMO_VIEWER_ROLE = 'DEMO_VIEWER';
const DEMO_VIEWER_PERMISSIONS = [
  // R.5: the home dashboard's layout, including the panels waiting for their phase.
  ['dashboard', 'view'],
  ['workflow', 'view'],
  ['document', 'view'],
  ['user', 'view'],
  ['role', 'view'],
  ['organisation', 'view'],
  ['estate', 'view'],
  ['division', 'view'],
  ['section', 'view'],
  ['field', 'view'],
  ['factory', 'view'],
  ['warehouse', 'view'],
  ['land', 'view'],
  ['season', 'view'],
  ['fiscal_year', 'view'],
  ['accounting_period', 'view'],
  ['lookup', 'view'],
  ['uom', 'view'],
  ['tea_type', 'view'],
  ['tea_grade', 'view'],
  ['activity_type', 'view'],
  ['shift', 'view'],
  ['currency', 'view'],
  ['country', 'view'],
  ['person', 'view'],
  ['employment', 'view'],
  ['team', 'view'],
] as const;

export const DEMO_ESTATE_ADMIN_ROLE = 'DEMO_ESTATE_ADMIN';
const DEMO_ESTATE_ADMIN_PERMISSIONS = [
  ['dashboard', 'view'],
  ['document', 'view'],
  ['organisation', 'view'],
  ['organisation', 'edit'],
  ...[
    'estate',
    'division',
    'section',
    'field',
    'factory',
    'warehouse',
    'land',
    'season',
    'fiscal_year',
    'lookup',
    'uom',
    'tea_type',
    'tea_grade',
    'activity_type',
    'shift',
    'currency',
    'country',
    'person',
    'employment',
    'team',
  ].flatMap((m) => ['view', 'create', 'edit', 'delete'].map((a) => [m, a] as const)),
  ['accounting_period', 'view'],
  ['accounting_period', 'edit'],
] as const;

/** P1.13: approves workflow changes and, as an approver role, purchase orders (the demo ladder). */
export const DEMO_APPROVER_ROLE = 'DEMO_APPROVER';
const DEMO_APPROVER_PERMISSIONS = [
  ['dashboard', 'view'],
  // P2.02: separations are approved by someone other than whoever opens profiles (SOD-1).
  ['employment', 'view'],
  ['employment', 'approve'],
  ['person', 'view'],
  ['team', 'view'],
  ['workflow', 'view'],
  ['workflow', 'approve'],
  ['purchase_order', 'view'],
  ['purchase_order', 'approve'],
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

        // P1.13: a second person, because nobody approves what they created.
        const approverRole = await ensureRole(
          tx,
          DEMO_APPROVER_ROLE,
          'Demo approver',
          'Staging demo: approves workflow changes; an approver role on the demo expenditure ladder.',
          DEMO_APPROVER_PERMISSIONS,
        );
        inserted += approverRole.inserted;
        const approver = await ensureUser(tx, 'approver', 'approver@rupai.local', hash);
        if (approver.created) {
          await tx.userScope.create({
            data: {
              userId: approver.id,
              scopeType: 'all_estates',
              grantedBy: BOOTSTRAP_ADMIN_ID,
              createdBy: BOOTSTRAP_ADMIN_ID,
            },
          });
          inserted += 2;
        }
        inserted += await ensureUserRole(tx, approver.id, approverRole.id);
        return { inserted, updated: 0 };
      },
    },
    demoHierarchySeeder,
    demoFacilitiesSeeder,
    demoCalendarSeeder,
    demoLookupSeeder,
    demoWorkflowSeeder,
    demoFieldDetailsSeeder,
    demoPersonsSeeder,
    demoProfilesSeeder,
    demoShapesSeeder,
    demoAssignmentsSeeder,
    demoTeamsSeeder,
  ];
}

/**
 * P2.01: five people registered by DEMO-A (the design's worker and employee forms), with dependents, and
 * one by DEMO-B that the viewer must not see. Numbered by the person format; added once.
 */
const DEMO_PERSONS = [
  {
    nid: '1990123456789',
    first: 'Rahim',
    last: 'Uddin',
    father: 'Karim Uddin',
    gender: 'male',
    dob: '1988-04-12',
    estate: 'DEMO-A',
    phone: '+8801711000001',
    kids: 2,
  },
  {
    nid: '1990123456790',
    first: 'Salma',
    last: 'Begum',
    father: 'Abdul Haque',
    gender: 'female',
    dob: '1992-09-03',
    estate: 'DEMO-A',
    phone: '+8801711000002',
    kids: 1,
  },
  {
    nid: '1990123456791',
    first: 'Jalal',
    last: 'Mia',
    father: 'Rashid Mia',
    gender: 'male',
    dob: '1979-01-25',
    estate: 'DEMO-A',
    phone: '+8801711000003',
    kids: 3,
  },
  {
    nid: '1990123456792',
    first: 'Md. Faruk',
    last: 'Hossain',
    father: 'Ali Hossain',
    gender: 'male',
    dob: '1983-06-30',
    estate: 'DEMO-A',
    phone: '+8801711000004',
    kids: 0,
  },
  {
    nid: '1990123456793',
    first: 'Rubina',
    last: 'Akter',
    father: 'Nur Islam',
    gender: 'female',
    dob: '1995-11-17',
    estate: 'DEMO-A',
    phone: '+8801711000005',
    kids: 1,
  },
  {
    nid: '1990123456794',
    first: 'Tariqul',
    last: 'Islam',
    father: 'Abul Kalam',
    gender: 'male',
    dob: '1986-02-08',
    estate: 'DEMO-B',
    phone: '+8801711000006',
    kids: 2,
  },
] as const;

const demoPersonsSeeder: Seeder = {
  name: 'demo: people of DEMO-A (and one of DEMO-B), with dependents',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const bd = await tx.country.findFirst({ where: { iso2: 'BD' }, select: { id: true } });
      const islam = await tx.religion.findUnique({ where: { code: 'ISLAM' }, select: { id: true } });
      for (const [i, p] of DEMO_PERSONS.entries()) {
        if (await tx.person.findUnique({ where: { nationalId: p.nid }, select: { id: true } })) continue;
        const estate = await tx.estate.findFirst({ where: { code: p.estate }, select: { id: true } });
        const person = await tx.person.create({
          data: {
            personCode: `PRS-DEMO-${String(i + 1)}`,
            registeredEstateId: estate?.id ?? null,
            title: p.gender === 'female' ? 'ms' : 'mr',
            firstName: p.first,
            lastName: p.last,
            fullName: `${p.first} ${p.last}`,
            fatherName: p.father,
            gender: p.gender,
            maritalStatus: p.kids > 0 ? 'married' : 'single',
            dateOfBirth: businessDateToDb(p.dob as BusinessDate),
            nationalId: p.nid,
            nationalityCountryId: bd?.id ?? null,
            religionId: islam?.id ?? null,
            phone: p.phone,
            presentAddress: 'Line 4, Labour Quarter',
            presentDistrict: 'Moulvibazar',
            presentUpazila: 'Sreemangal',
            paymentMethod: 'mobile_banking',
            mobileBankingProvider: 'bkash',
            mobileBankingNumber: p.phone,
            createdBy: by,
          },
        });
        inserted += 1;
        for (let k = 0; k < p.kids; k += 1) {
          await tx.personDependent.create({
            data: {
              personId: person.id,
              name: `${p.first} child ${String(k + 1)}`,
              relation: k % 2 === 0 ? 'son' : 'daughter',
              occupation: 'Student',
              createdBy: by,
            },
          });
          inserted += 1;
        }
      }
      return { inserted, updated: 0 };
    }),
};

/**
 * R.3 GIS (RUP-655): shapes for DEMO-A, so the Field / Block map shows something real: each section a row
 * of fields east of the estate's position, its outline around them, the drain as a line. Measured by the
 * same code as the API. Only fields and sections without a shape are drawn.
 */
const demoShapesSeeder: Seeder = {
  name: 'demo: field and section shapes of DEMO-A',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let updated = 0;
      const estate = await tx.estate.findFirst({
        where: { code: 'DEMO-A' },
        select: { id: true, latitude: true, longitude: true },
      });
      if (!estate) return { inserted: 0, updated };
      const lat0 = estate.latitude ? Number(estate.latitude) : 26.3417;
      const lng0 = estate.longitude ? Number(estate.longitude) : 88.0008;
      const sections = await tx.section.findMany({
        where: { division: { estateId: estate.id } },
        orderBy: [{ divisionId: 'asc' }, { code: 'asc' }],
        include: { fields: { orderBy: { fieldNumber: 'asc' } } },
      });
      const W = 0.0042; // ≈ 420 m
      const H = 0.0032; // ≈ 355 m
      const rect = (x: number, y: number, w: number, h: number): Geometry => ({
        type: 'Polygon',
        coordinates: [
          [
            [x, y],
            [x + w, y],
            [x + w, y + h],
            [x, y + h],
            [x, y],
          ],
        ],
      });
      const write = (g: Geometry) => {
        const f = figuresOf(parseGeometry(g, g.type === 'LineString'));
        return {
          boundary: g as unknown as Prisma.InputJsonValue,
          centroidLatitude: f.centroid.latitude.toFixed(6),
          centroidLongitude: f.centroid.longitude.toFixed(6),
          perimeterKm: f.perimeterKm.toFixed(3),
          mappedAreaAcres: f.areaAcres === null ? null : f.areaAcres.toFixed(3),
        };
      };
      for (const [row, section] of sections.entries()) {
        const y = lat0 - 0.002 - row * (H + 0.0012);
        const fields = section.fields.filter((f) => f.parentFieldId === null);
        for (const [col, field] of fields.entries()) {
          if (field.boundary !== null) continue;
          const x = lng0 + 0.002 + col * (W + 0.0004);
          const g: Geometry =
            field.fieldType === 'drain'
              ? {
                  type: 'LineString',
                  coordinates: [
                    [x, y + H / 2],
                    [x + W, y + H / 2],
                  ],
                }
              : rect(x, y, W, H);
          await tx.field.update({ where: { id: field.id }, data: write(g) });
          updated += 1;
        }
        // A block inside its parent field: the parent's south-west quarter.
        for (const block of section.fields.filter((f) => f.parentFieldId !== null && f.boundary === null)) {
          const col = fields.findIndex((f) => f.id === block.parentFieldId);
          if (col < 0) continue;
          await tx.field.update({
            where: { id: block.id },
            data: write(rect(lng0 + 0.002 + col * (W + 0.0004) + 0.0003, y + 0.0003, W / 2.5, H / 2.5)),
          });
          updated += 1;
        }
        if (section.boundary === null && fields.length > 0) {
          const o = rect(lng0 + 0.0018, y - 0.0002, fields.length * (W + 0.0004), H + 0.0004);
          const fig = figuresOf(o);
          await tx.section.update({
            where: { id: section.id },
            data: {
              boundary: o as unknown as Prisma.InputJsonValue,
              mappedAreaAcres: (fig.areaAcres ?? 0).toFixed(3),
            },
          });
          updated += 1;
        }
      }
      return { inserted: 0, updated };
    }),
};

/**
 * P2.02: the design's worker categories, an employee category, and a profile for each demo person: four
 * workers and an employee (the field manager) at DEMO-A, one separated worker at DEMO-B.
 */
const demoProfilesSeeder: Seeder = {
  name: 'demo: worker categories and employment profiles of the demo people',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const cats = new Map<string, bigint>();
      for (const [i, [code, name]] of (
        [
          ['GENERAL', 'General worker'],
          ['SKILLED', 'Skilled worker'],
          ['SEMI_SKILLED', 'Semi skilled worker'],
          ['TECHNICAL', 'Technical worker'],
        ] as const
      ).entries()) {
        const found = await tx.workerCategory.findUnique({ where: { code }, select: { id: true } });
        const row =
          found ??
          (await tx.workerCategory.create({ data: { code, name, sortOrder: (i + 1) * 10, createdBy: by } }));
        if (!found) inserted += 1;
        cats.set(code, row.id);
      }
      const officer =
        (await tx.employeeCategory.findFirst({ where: { code: 'OFFICER' }, select: { id: true } })) ??
        (await tx.employeeCategory.create({ data: { code: 'OFFICER', name: 'Officer', createdBy: by } }));
      const grade = await tx.jobGrade.findUnique({ where: { code: 'GRADE_2' }, select: { id: true } });
      // The employee first: the workers report to them.
      const plan = [
        ['1990123456792', 'employee', 'EMP-A-0001', null, 'permanent', '2010-05-01'],
        ['1990123456789', 'worker', 'WRK-A-0001', 'GENERAL', 'permanent', '2012-03-01'],
        ['1990123456790', 'worker', 'WRK-A-0002', 'SKILLED', 'permanent', '2016-07-15'],
        ['1990123456791', 'worker', 'WRK-A-0003', 'GENERAL', 'seasonal', '2026-10-01'],
        ['1990123456793', 'worker', 'WRK-A-0004', 'SEMI_SKILLED', 'casual', '2021-01-10'],
        ['1990123456794', 'worker', 'WRK-B-0001', 'GENERAL', 'permanent', '2015-02-01'],
      ] as const;
      let supervisor: bigint | null = null;
      for (const [nid, type, number, cat, engagement, joined] of plan) {
        const person = await tx.person.findUnique({
          where: { nationalId: nid },
          select: { id: true, registeredEstateId: true },
        });
        if (!person?.registeredEstateId) continue;
        const exists = await tx.employmentProfile.findFirst({
          where: { estateId: person.registeredEstateId, profileNumber: number },
          select: { id: true },
        });
        if (exists) {
          if (type === 'employee') supervisor = exists.id;
          continue;
        }
        const separated = number === 'WRK-B-0001';
        const created = await tx.employmentProfile.create({
          data: {
            personId: person.id,
            estateId: person.registeredEstateId,
            employmentType: type,
            profileNumber: number,
            workerCategoryId: type === 'worker' ? (cats.get(cat) ?? null) : null,
            employeeCategoryId: type === 'employee' ? officer.id : null,
            engagementType: engagement,
            employmentBasis: 'full_time',
            jobNature: type === 'employee' ? 'supervisory' : 'field',
            workingLocation: type === 'employee' ? 'office' : 'field',
            jobGradeId: type === 'employee' ? (grade?.id ?? null) : null,
            joiningDate: businessDateToDb(joined as BusinessDate),
            supervisorProfileId: type === 'worker' && !separated ? supervisor : null,
            nomineeName: type === 'employee' ? 'Nasrin Hossain' : null,
            nomineeRelation: type === 'employee' ? 'spouse' : null,
            status: separated ? 'separated' : 'active',
            separationDate: separated ? businessDateToDb('2026-06-30' as BusinessDate) : null,
            separationType: separated ? 'resignation' : null,
            separationReason: separated ? 'Moved to another estate' : null,
            createdBy: by,
          },
        });
        if (type === 'employee') supervisor = created.id;
        inserted += 1;
      }
      return { inserted, updated: 0 };
    }),
};

/**
 * P2.03: departments and designations (the client's own lists, seeded empty), an approved joining
 * assignment for each demo profile of DEMO-A (the worker form's section and job / task, the employee
 * form's department, designation and salary structure), one transfer in the timeline, and a reporting
 * line for the approval engine: the `manager` login is an HR officer reporting to the field supervisor,
 * whose profile the `approver` login holds, so a wage change the manager submits reaches the approver.
 * Added once; a reviewer's changes stay.
 */
const demoAssignmentsSeeder: Seeder = {
  name: 'demo: P2.03 departments, designations, assignments and a reporting line on DEMO-A',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const estate = await tx.estate.findFirst({ where: { code: 'DEMO-A' }, select: { id: true } });
      if (!estate) return { inserted, updated: 0 };
      const ensure = async (
        model: 'department' | 'designation',
        rows: readonly (readonly [string, string])[],
      ) => {
        const ids = new Map<string, bigint>();
        const m = tx[model] as unknown as typeof tx.department;
        for (const [i, [code, name]] of rows.entries()) {
          const found = await m.findUnique({ where: { code }, select: { id: true } });
          const row =
            found ?? (await m.create({ data: { code, name, sortOrder: (i + 1) * 10, createdBy: by } }));
          if (!found) inserted += 1;
          ids.set(code, row.id);
        }
        return ids;
      };
      const dept = await ensure('department', [
        ['ESTATE_MGMT', 'Estate Management'],
        ['HR_ADMIN', 'HR & Admin'],
        ['FIELD_OPS', 'Field Operations'],
        ['ACCOUNTS', 'Accounts & Finance'],
        ['FACTORY', 'Factory'],
      ]);
      const desig = await ensure('designation', [
        ['ESTATE_MANAGER', 'Estate Manager'],
        ['HR_MANAGER', 'HR Manager'],
        ['HR_OFFICER', 'HR Officer'],
        ['FIELD_SUPERVISOR', 'Field Supervisor'],
        ['ACCOUNTS_OFFICER', 'Accounts Officer'],
      ]);
      const sections = await tx.section.findMany({
        where: { division: { estateId: estate.id }, status: 'active' },
        select: { id: true, divisionId: true },
        orderBy: { id: 'asc' },
      });
      const activity = async (code: string) =>
        (await tx.activityType.findUnique({ where: { code }, select: { id: true } }))?.id ?? null;
      const plucking = await activity('PLUCKING');
      const pruning = await activity('PRUNING');
      const profile = (number: string) =>
        tx.employmentProfile.findFirst({
          where: { estateId: estate.id, profileNumber: number },
          select: { id: true, personId: true, joiningDate: true, employmentType: true, status: true },
        });

      // The reporting line: an HR officer (the `manager` login) under the field supervisor (`approver`).
      const supervisor = await profile('EMP-A-0001');
      let officer = await profile('EMP-A-0002');
      if (supervisor && !officer) {
        const person = await tx.person.create({
          data: {
            personCode: 'PRS-DEMO-MGR',
            registeredEstateId: estate.id,
            title: 'ms',
            firstName: 'Farhana',
            lastName: 'Akter',
            fullName: 'Farhana Akter',
            gender: 'female',
            dateOfBirth: businessDateToDb('1991-02-14' as BusinessDate),
            createdBy: by,
          },
        });
        const created = await tx.employmentProfile.create({
          data: {
            personId: person.id,
            estateId: estate.id,
            employmentType: 'employee',
            profileNumber: 'EMP-A-0002',
            engagementType: 'permanent',
            employmentBasis: 'full_time',
            jobNature: 'administrative',
            workingLocation: 'office',
            joiningDate: businessDateToDb('2019-04-01' as BusinessDate),
            supervisorProfileId: supervisor.id,
            createdBy: by,
          },
        });
        inserted += 2;
        officer = await profile(created.profileNumber);
      }
      const link = async (username: string, p: { id: bigint; personId: bigint } | null) => {
        if (!p) return;
        const u = await tx.user.findUnique({
          where: { username },
          select: { id: true, employmentProfileId: true },
        });
        if (u?.employmentProfileId === null) {
          await tx.user.update({
            where: { id: u.id },
            data: { employmentProfileId: p.id, personId: p.personId },
          });
          inserted += 1;
        }
      };
      await link('approver', supervisor);
      await link('manager', officer);

      const salary = (basic: number) => [
        { component: 'basic', amount: String(basic) },
        { component: 'house_rent', amount: String(basic / 2) },
        { component: 'medical', amount: '3000' },
        { component: 'conveyance', amount: '2000' },
      ];
      const plan: readonly {
        number: string;
        section?: number;
        activity?: bigint | null;
        dept?: string;
        desig?: string;
        pay?: { component: string; amount: string }[];
        transfer?: { from: string; section: number };
      }[] = [
        { number: 'EMP-A-0001', dept: 'FIELD_OPS', desig: 'FIELD_SUPERVISOR', pay: salary(35000) },
        { number: 'EMP-A-0002', dept: 'HR_ADMIN', desig: 'HR_OFFICER', pay: salary(28000) },
        { number: 'WRK-A-0001', section: 0, activity: plucking },
        {
          number: 'WRK-A-0002',
          section: 1,
          activity: plucking,
          transfer: { from: '2025-01-01', section: 2 },
        },
        { number: 'WRK-A-0003', section: 0, activity: plucking },
        { number: 'WRK-A-0004', section: 2, activity: pruning },
      ];
      const now = new Date();
      for (const item of plan) {
        const p = await profile(item.number);
        if (!p || p.status === 'separated') continue;
        if ((await tx.employmentAssignment.count({ where: { employmentProfileId: p.id } })) > 0) continue;
        const place = (i: number | undefined) => {
          const s = i === undefined ? undefined : sections[i % Math.max(sections.length, 1)];
          return s ? { sectionId: s.id, divisionId: s.divisionId } : {};
        };
        const create = async (from: Date, to: Date | null, reason: string, i: number | undefined) => {
          const a = await tx.employmentAssignment.create({
            data: {
              employmentProfileId: p.id,
              estateId: estate.id,
              departmentId: item.dept ? (dept.get(item.dept) ?? null) : null,
              designationId: item.desig ? (desig.get(item.desig) ?? null) : null,
              ...place(i),
              activityTypeId: item.activity ?? null,
              wageBasis: p.employmentType === 'worker' ? 'daily' : 'monthly',
              effectiveFrom: from,
              effectiveTo: to,
              changeReason: reason,
              isWageChange: reason === 'joining' && (item.pay?.length ?? 0) > 0,
              state: 'approved',
              stateChangedAt: now,
              submittedAt: now,
              submittedBy: by,
              approvedAt: now,
              approvedBy: by,
              createdBy: by,
              payLines: { create: item.pay ?? [] },
            },
          });
          await tx.statusHistory.create({
            data: {
              recordType: 'employment_assignment',
              recordId: a.id.toString(),
              fromState: null,
              toState: 'approved',
              changedBy: by,
              comment: 'Demo seed',
            },
          });
          inserted += 1;
        };
        if (item.transfer) {
          const from = businessDateToDb(item.transfer.from as BusinessDate);
          await create(p.joiningDate, new Date(from.getTime() - 86_400_000), 'joining', item.section);
          await create(from, null, 'transfer', item.transfer.section);
        } else {
          await create(p.joiningDate, null, 'joining', item.section);
        }
      }
      return { inserted, updated: 0 };
    }),
};

/**
 * P2.04: two teams on DEMO-A under the field supervisor: a plucking gang in the first section (WRK-A-0001
 * its leader, WRK-A-0003) and a field team (WRK-A-0002, and WRK-A-0004, who moved over from the plucking
 * gang on 2025-07-01: the members of a date in the first half of 2025 differ). Added once.
 */
const demoTeamsSeeder: Seeder = {
  name: 'demo: P2.04 worker teams and memberships on DEMO-A',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const estate = await tx.estate.findFirst({ where: { code: 'DEMO-A' }, select: { id: true } });
      if (!estate) return { inserted, updated: 0 };
      if ((await tx.workerTeam.count({ where: { estateId: estate.id } })) > 0)
        return { inserted, updated: 0 };
      const profile = async (number: string) =>
        (
          await tx.employmentProfile.findFirst({
            where: { estateId: estate.id, profileNumber: number, status: { not: 'separated' } },
            select: { id: true },
          })
        )?.id ?? null;
      const sections = await tx.section.findMany({
        where: { division: { estateId: estate.id } },
        select: { id: true, divisionId: true },
        orderBy: { id: 'asc' },
      });
      const supervisor = await profile('EMP-A-0001');
      const date = (d: string) => businessDateToDb(d as BusinessDate);
      const make = async (
        code: string,
        name: string,
        teamType: string,
        s: (typeof sections)[number] | undefined,
      ) => {
        const t = await tx.workerTeam.create({
          data: {
            estateId: estate.id,
            code,
            name,
            teamType,
            supervisorProfileId: supervisor,
            divisionId: s?.divisionId ?? null,
            sectionId: s?.id ?? null,
            createdBy: by,
          },
        });
        await tx.statusHistory.create({
          data: {
            recordType: 'worker_team',
            recordId: t.id.toString(),
            toState: 'active',
            changedBy: by,
            comment: 'Demo seed',
          },
        });
        inserted += 1;
        return t.id;
      };
      const gang = await make('PG-NORTH', 'Plucking Gang North', 'plucking', sections[0]);
      const field = await make('FT-SOUTH', 'Field Team South', 'field', sections[2] ?? sections[1]);
      const plan = [
        [gang, 'WRK-A-0001', '2020-01-01', null, 'leader'],
        [gang, 'WRK-A-0003', '2026-10-01', null, 'member'],
        [gang, 'WRK-A-0004', '2021-01-10', '2025-06-30', 'member'],
        [field, 'WRK-A-0004', '2025-07-01', null, 'member'],
        [field, 'WRK-A-0002', '2025-01-01', null, 'leader'],
      ] as const;
      for (const [teamId, number, from, to, roleInTeam] of plan) {
        const p = await profile(number);
        if (p === null) continue;
        await tx.teamMember.create({
          data: {
            workerTeamId: teamId,
            employmentProfileId: p,
            effectiveFrom: date(from),
            effectiveTo: to === null ? null : date(to),
            roleInTeam,
            createdBy: by,
          },
        });
        inserted += 1;
      }
      return { inserted, updated: 0 };
    }),
};

/**
 * R.3: the Field / Block page's details on DEMO-A (the manager's design): the design's bush types as tea
 * varieties, the details on each field, a nursery, an extension, a road reserve and a drain, a block
 * inside a field, division descriptions. Fills only what is empty, so a reviewer's edits stay.
 */
const demoFieldDetailsSeeder: Seeder = {
  name: 'demo: R.3 field / block details on DEMO-A',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      let updated = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      for (const [i, [code, name, varietyType]] of (
        [
          ['TV-1', 'TV-1', 'clonal'],
          ['TV-18', 'TV-18', 'clonal'],
          ['BT-2', 'BT-2', 'clonal'],
          ['CLONE-6', 'Clone 6', 'clonal'],
          ['SEEDLING', 'Seedling', 'seedling'],
        ] as const
      ).entries()) {
        if (await tx.teaVariety.findUnique({ where: { code }, select: { id: true } })) continue;
        await tx.teaVariety.create({
          data: { code, name, varietyType, sortOrder: (i + 1) * 10, createdBy: by },
        });
        inserted += 1;
      }
      const estate = await tx.estate.findFirst({ where: { code: 'DEMO-A' }, select: { id: true } });
      if (!estate) return { inserted, updated };
      const one = { select: { id: true } } as const;
      const id = async (table: 'irrigationSource' | 'soilType' | 'drainageClass', code: string) =>
        (table === 'irrigationSource'
          ? await tx.irrigationSource.findUnique({ where: { code }, ...one })
          : table === 'soilType'
            ? await tx.soilType.findUnique({ where: { code }, ...one })
            : await tx.drainageClass.findUnique({ where: { code }, ...one })
        )?.id ?? null;
      const variety = async (code: string) =>
        (await tx.teaVariety.findUnique({ where: { code }, select: { id: true } }))?.id ?? null;
      const details = {
        irrigationSourceId: await id('irrigationSource', 'NATURAL_RAIN'),
        soilTypeId: await id('soilType', 'LOAMY'),
        drainageClassId: await id('drainageClass', 'GOOD'),
      };
      const fields = await tx.field.findMany({
        where: { estateId: estate.id, plantingYear: null, fieldType: 'tea_field' },
        orderBy: { fieldNumber: 'asc' },
      });
      const clones = ['TV-1', 'TV-18', 'BT-2', 'CLONE-6'];
      for (const [i, f] of fields.entries()) {
        await tx.field.update({
          where: { id: f.id },
          data: {
            ...details,
            plantingYear: f.fieldStatus === 'young' ? 2022 : 2008 + i,
            teaVarietyId: await variety(clones[i % clones.length] ?? 'TV-1'),
            spacing: '4ft × 2.5ft',
            altitude: String(220 + i * 5),
            averageSlope: String(3 + (i % 4)),
          },
        });
        updated += 1;
      }
      const section = await tx.section.findFirst({
        where: { division: { estateId: estate.id }, code: 'N1' },
        select: { id: true },
      });
      if (section) {
        const extra = [
          ['A-NUR-01', 'Nursery Block', 'nursery', '2.500', '2.500', 'nursery'],
          ['A-EXT-01', 'Extension Field', 'extension', '12.400', null, 'young'],
          ['A-RD-01', 'Road Reserve', 'infrastructure', '3.200', null, 'fallow'],
          ['A-DR-01', 'Drain Area', 'drain', '1.800', null, 'fallow'],
        ] as const;
        for (const [fieldNumber, name, fieldType, gross, planted, fieldStatus] of extra) {
          if (await tx.field.findFirst({ where: { estateId: estate.id, fieldNumber }, select: { id: true } }))
            continue;
          await tx.field.create({
            data: {
              sectionId: section.id,
              estateId: estate.id,
              fieldNumber,
              name,
              fieldType,
              grossArea: gross,
              plantedArea: planted,
              fieldStatus,
              createdBy: by,
            },
          });
          inserted += 1;
        }
        // A block inside a field: A-N1-1 holds block A-N1-1B.
        const parent = await tx.field.findFirst({
          where: { estateId: estate.id, fieldNumber: 'A-N1-1' },
          select: { id: true },
        });
        if (
          parent &&
          !(await tx.field.findFirst({
            where: { estateId: estate.id, fieldNumber: 'A-N1-1B' },
            select: { id: true },
          }))
        ) {
          await tx.field.create({
            data: {
              sectionId: section.id,
              estateId: estate.id,
              fieldNumber: 'A-N1-1B',
              name: 'Block 1B',
              parentFieldId: parent.id,
              grossArea: '4.000',
              plantedArea: '3.800',
              fieldStatus: 'producing',
              plantingYear: 2015,
              teaVarietyId: await variety('BT-2'),
              ...details,
              createdBy: by,
            },
          });
          inserted += 1;
        }
      }
      for (const [code, description] of [
        ['NORTH', 'Hill slopes north of the factory road.'],
        ['SOUTH', 'Low-lying fields along the river.'],
      ] as const) {
        const { count } = await tx.division.updateMany({
          where: { estateId: estate.id, code, description: null },
          data: { description },
        });
        updated += count;
      }
      return { inserted, updated };
    }),
};

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

/** P1.08: facilities, contacts and a party. The viewer may see DEMO-F1 and DEMO-W1, nothing else. */
const demoFacilitiesSeeder: Seeder = {
  name: 'demo: factories, warehouses, contacts and a party; the viewer sees DEMO-F1 and DEMO-W1 only',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const org = await tx.organisation.findFirstOrThrow({ select: { id: true } });
      const demoA = await tx.estate.findFirst({ where: { code: 'DEMO-A' }, select: { id: true } });

      const factory = async (
        code: string,
        data: { name: string; factoryType: string; primaryEstateId?: bigint | null },
      ) => {
        const found = await tx.factory.findFirst({ where: { code }, select: { id: true } });
        if (found) return found.id;
        inserted += 1;
        return (
          await tx.factory.create({
            data: { organisationId: org.id, code, dailyCapacityKg: '45000.000', createdBy: by, ...data },
            select: { id: true },
          })
        ).id;
      };
      const warehouse = async (
        code: string,
        data: { name: string; warehouseType: string; location: string },
      ) => {
        const found = await tx.warehouse.findFirst({ where: { code }, select: { id: true } });
        if (found) return found.id;
        inserted += 1;
        return (
          await tx.warehouse.create({
            data: { organisationId: org.id, code, capacityKg: '250000.000', createdBy: by, ...data },
            select: { id: true },
          })
        ).id;
      };
      const f1 = await factory('DEMO-F1', {
        name: 'Rupai Central Factory',
        factoryType: 'own',
        primaryEstateId: demoA?.id ?? null,
      });
      await factory('DEMO-F2', { name: 'Jamuna Bought-leaf Factory', factoryType: 'external' });
      const w1 = await warehouse('DEMO-W1', {
        name: 'Chattogram Auction Warehouse',
        warehouseType: 'rented',
        location: 'Chattogram',
      });
      await warehouse('DEMO-W2', {
        name: 'Srimangal Estate Store',
        warehouseType: 'own',
        location: 'Srimangal',
      });

      if ((await tx.partyContact.count({ where: { ownerType: 'warehouse', ownerId: w1 } })) === 0) {
        await tx.partyContact.createMany({
          data: [
            {
              ownerType: 'warehouse',
              ownerId: w1,
              contactName: 'Karim Uddin',
              designation: 'Warehouse in-charge',
              contactType: 'primary',
              phone: '+8801711000001',
              isPrimary: true,
              createdBy: by,
            },
            {
              ownerType: 'warehouse',
              ownerId: w1,
              contactName: 'Accounts desk',
              contactType: 'accounts',
              phone: '+8801711000002',
              email: 'accounts@example.com',
              createdBy: by,
            },
          ],
        });
        // warehouse.phone is the primary contact's (P3 §8 note).
        await tx.warehouse.update({ where: { id: w1 }, data: { phone: '+8801711000001' } });
        inserted += 2;
      }
      if (!(await tx.party.findFirst({ where: { code: 'DEMO-P1' }, select: { id: true } }))) {
        await tx.party.create({
          data: {
            partyType: 'individual',
            code: 'DEMO-P1',
            name: 'Abdul Haque (lessee)',
            district: 'Moulvibazar',
            createdBy: by,
          },
        });
        inserted += 1;
      }

      const viewer = await tx.user.findUnique({ where: { username: 'viewer' }, select: { id: true } });
      if (viewer) {
        for (const [scopeType, scopeId] of [
          ['factory', f1],
          ['warehouse', w1],
        ] as const) {
          const has = await tx.userScope.findFirst({ where: { userId: viewer.id, scopeType, scopeId } });
          if (has) continue;
          await tx.userScope.create({
            data: { userId: viewer.id, scopeType, scopeId, grantedBy: by, createdBy: by },
          });
          inserted += 1;
        }
      }
      return { inserted, updated: 0 };
    }),
};

/** P1.09: seasons for the demo estates and one fiscal year with its periods. */
const demoCalendarSeeder: Seeder = {
  name: 'demo: seasons, fiscal year FY2026-27 and its periods (July to October open)',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const day = (d: string) => businessDateToDb(d as BusinessDate);

      const season = async (
        estateCode: string,
        code: string,
        start: string,
        end: string,
        state: 'active' | 'closed',
      ) => {
        const estate = await tx.estate.findFirst({ where: { code: estateCode }, select: { id: true } });
        if (!estate) return;
        if (await tx.season.findFirst({ where: { estateId: estate.id, code }, select: { id: true } })) return;
        await tx.season.create({
          data: {
            estateId: estate.id,
            code,
            name: `Season ${code}`,
            startDate: day(start),
            endDate: day(end),
            state,
            ...(state === 'closed' ? { closedAt: new Date(), closedBy: by } : {}),
            createdBy: by,
          },
        });
        inserted += 1;
      };
      await season('DEMO-A', '2025-26', '2025-03-01', '2026-02-28', 'closed');
      await season('DEMO-A', '2026-27', '2026-03-01', '2027-02-28', 'active');
      await season('DEMO-B', '2026-27', '2026-03-01', '2027-02-28', 'active');

      const org = await tx.organisation.findFirstOrThrow({
        select: { id: true, fiscalYearStartMonth: true },
      });
      const code = fiscalYearCode(2026, org.fiscalYearStartMonth);
      if (!(await tx.fiscalYear.findFirst({ where: { code }, select: { id: true } }))) {
        const { start, end } = fiscalYearDates(2026, org.fiscalYearStartMonth);
        const year = await tx.fiscalYear.create({
          data: {
            organisationId: org.id,
            code,
            name: `Fiscal year ${code.replace(/^FY/, '')}`,
            startDate: businessDateToDb(start),
            endDate: businessDateToDb(end),
            state: 'open',
            createdBy: by,
          },
          select: { id: true },
        });
        await tx.accountingPeriod.createMany({
          data: periodsOf(start).map((p) => ({
            fiscalYearId: year.id,
            periodNumber: p.number,
            name: p.name,
            startDate: businessDateToDb(p.start),
            endDate: businessDateToDb(p.end),
            state: p.number <= 4 ? 'open' : 'future',
            createdBy: by,
          })),
        });
        inserted += 14;
      }
      return { inserted, updated: 0 };
    }),
};

/** P1.10: the lists that ship empty (they are the client's own), filled for the demo, and shifts. */
const demoLookupSeeder: Seeder = {
  name: 'demo: departments, designations, worker categories and shifts',
  run: (tx) =>
    runUnscoped('demo seed', async () => {
      let inserted = 0;
      const by = BOOTSTRAP_ADMIN_ID;
      const rows = { code: true } as const;
      const lists = [
        [
          tx.department,
          [
            ['FIELD', 'Field'],
            ['FACTORY', 'Factory'],
            ['ACCOUNTS', 'Accounts'],
          ],
        ],
        [
          tx.designation,
          [
            ['MANAGER', 'Manager'],
            ['SUPERVISOR', 'Supervisor'],
            ['CLERK', 'Clerk'],
          ],
        ],
        [
          tx.workerCategory,
          [
            ['PERMANENT', 'Permanent worker'],
            ['CASUAL', 'Casual worker'],
          ],
        ],
      ] as const;
      for (const [model, values] of lists) {
        for (const [i, [code, name]] of values.entries()) {
          const delegate = model as unknown as {
            findFirst(a: object): Promise<unknown>;
            create(a: object): Promise<unknown>;
          };
          if (await delegate.findFirst({ where: { code }, select: rows })) continue;
          await delegate.create({ data: { code, name, sortOrder: (i + 1) * 10, createdBy: by } });
          inserted += 1;
        }
      }
      const time = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);
      const estate = async (code: string) =>
        (await tx.estate.findFirst({ where: { code }, select: { id: true } }))?.id ?? null;
      const shifts = [
        ['DAY', 'Day shift', null, '06:00', '14:00', false],
        ['A-NIGHT', 'DEMO-A night shift', await estate('DEMO-A'), '22:00', '06:00', true],
        ['B-LATE', 'DEMO-B late shift', await estate('DEMO-B'), '14:00', '22:00', false],
      ] as const;
      for (const [code, name, estateId, start, end, overnight] of shifts) {
        if (code !== 'DAY' && estateId === null) continue;
        if (await tx.shift.findFirst({ where: { code }, select: { id: true } })) continue;
        await tx.shift.create({
          data: {
            code,
            name,
            estateId,
            startTime: time(start),
            endTime: time(end),
            isOvernight: overnight,
            breakMinutes: 30,
            graceMinutes: 10,
            createdBy: by,
          },
        });
        inserted += 1;
      }
      return { inserted, updated: 0 };
    }),
};

/**
 * P1.13: the standard expenditure ladder (P7 Table 6.1) as the next version of the seeded purchase-order
 * workflow, left SUBMITTED so the manager can preview it and the `approver` account can approve it. Only
 * while the purchase-order workflow is still the seeded one.
 */
const demoWorkflowSeeder: Seeder = {
  name: 'demo: a submitted expenditure ladder for purchase orders, awaiting the approver',
  async run(tx) {
    const existing = await tx.workflow.findMany({
      where: { documentType: 'purchase_order' },
      select: { id: true, ruleCode: true },
    });
    const [seeded] = existing;
    if (existing.length !== 1 || !seeded) return { inserted: 0, updated: 0 };
    const role = async (code: string) =>
      (await tx.role.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;
    const estateAdmin = await role(DEMO_ESTATE_ADMIN_ROLE);
    const approver = await role(DEMO_APPROVER_ROLE);
    const manager = await tx.user.findUniqueOrThrow({ where: { username: 'manager' }, select: { id: true } });
    const now = new Date();
    // Tomorrow (UTC), so the version is never retrospective in the organisation's timezone.
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
    const by = BOOTSTRAP_ADMIN_ID;
    const amount = (value: string) => ({
      conditionField: 'total_base_amount',
      conditionOperator: 'gte',
      conditionValue: value,
    });
    const w = await tx.workflow.create({
      data: {
        ruleCode: seeded.ruleCode,
        name: 'Purchase order: expenditure ladder (demo)',
        documentType: 'purchase_order',
        method: 'sequential',
        parameters: {},
        effectiveFrom: from,
        supersedesId: seeded.id,
        notes: 'Demo of P7 Table 6.1. The thresholds are the proposed T1 to T3, not confirmed figures.',
        state: 'submitted',
        stateChangedAt: now,
        submittedAt: now,
        submittedBy: by,
        createdBy: by,
        steps: {
          create: [
            {
              stepNumber: 1,
              sequence: 1,
              name: 'Estate manager',
              approverRule: 'by_role',
              roleId: estateAdmin,
              createdBy: by,
            },
            {
              stepNumber: 2,
              sequence: 2,
              name: 'Accounts verification',
              approverRule: 'by_role',
              roleId: approver,
              ...amount('50001'),
              createdBy: by,
            },
            {
              stepNumber: 3,
              sequence: 3,
              name: 'General manager',
              approverRule: 'by_role',
              roleId: approver,
              ...amount('250001'),
              createdBy: by,
            },
            {
              stepNumber: 4,
              sequence: 4,
              name: 'Managing director',
              approverRule: 'by_named_user',
              userId: manager.id,
              ...amount('1000001'),
              createdBy: by,
            },
          ],
        },
      },
      select: { id: true },
    });
    for (const [fromState, toState] of [
      [null, 'draft'],
      ['draft', 'submitted'],
    ] as const) {
      await tx.statusHistory.create({
        data: {
          recordType: 'workflow',
          recordId: w.id.toString(),
          fromState,
          toState,
          changedBy: by,
          comment: 'Demo seed',
        },
      });
    }
    return { inserted: 5, updated: 0 };
  },
};
