import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runJob, type RunnerDeps } from '../../src/core/jobs/runner.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.06 — workforce bulk import on real MySQL: workers (person + profile + joining assignment per row,
 * the verification: 2,000 workers with a usable error report), an NID already registered reused, the
 * uploader's estate scope, employees with salaries committed (and so approved) by someone else with
 * employment.approve, and contractors with a first contract.
 */

const ADMIN = '1';
/** person, employment (view, create, edit), contractor (view, create); estate A only. */
let CLERK = '';
/** person + employment incl. approve; all estates. */
let APPROVER = '';
let mdb: MigratedDatabase;
let app: Express;
let runner: RunnerDeps;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
let A = '';
let B = '';

interface Batch {
  id: string;
  state: string;
  row_count: number;
  valid_count: number;
  error_count: number;
  committed_count: number;
  failed_count: number;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = CLERK) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object, actor = CLERK) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);
async function data<T>(r: request.Test, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
}
const csv = (rows: readonly (readonly string[])[]) =>
  Buffer.from(
    rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\n'),
    'utf8',
  );
async function runBatchJob(batchId: string, which: 'validateJobId' | 'commitJobId') {
  const b = await mdb.migrator.importBatch.findUniqueOrThrow({ where: { id: BigInt(batchId) } });
  const id = b[which];
  expect(id).not.toBeNull();
  await runJob(runner, id ?? 0n);
}
async function uploadAndValidate(type: string, body: Buffer, actor = CLERK) {
  const b = await data<Batch>(
    as(request(app).post(`/api/v1/imports/${type}`), actor).attach('file', body, { filename: 'rows.csv' }),
    202,
  );
  await runBatchJob(b.id, 'validateJobId');
  return data<Batch>(get(`/imports/${b.id}`, actor));
}
async function commit(batchId: string, actor = CLERK) {
  await data<Batch>(post(`/imports/${batchId}/commit`, {}, actor), 202);
  await runBatchJob(batchId, 'commitJobId');
  return data<Batch>(get(`/imports/${batchId}`, actor));
}
const errorsOf = (batchId: string, actor = CLERK) =>
  data<{ row_number: number; column: string | null; code: string; message: string }[]>(
    get(`/imports/${batchId}/errors`, actor),
  );

async function role(permissions: string[]) {
  return data<{ id: string }>(
    as(request(app).post('/api/v1/roles'), ADMIN).send({ code: unique('R_'), name: 'Probe', permissions }),
    201,
  );
}
async function user(name: string, roleId: string, scope: object, sensitive: string[] = []) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await data<{ version: number }>(get(`/users/${id}`, ADMIN));
  await data(
    as(request(app).post(`/api/v1/users/${id}/roles`), ADMIN)
      .set('If-Match', `"${String(current.version)}"`)
      .send({
        roles: [{ role_id: roleId }],
        ...(sensitive.length
          ? { authorisations: sensitive.map((key) => ({ key, reason: 'P2.06 tests' })) }
          : {}),
      }),
  );
  await data(as(request(app).post(`/api/v1/users/${id}/scopes`), ADMIN).send(scope), 201);
  return id;
}

const WORKER_HEADER = [
  'estate',
  'first_name',
  'last_name',
  'gender',
  'date_of_birth',
  'national_id',
  'mobile',
  'worker_type',
  'category',
  'join_date',
  'division',
  'section',
  'job_task',
];
const workerRow = (n: number, over: Partial<Record<(typeof WORKER_HEADER)[number], string>> = {}) => {
  const base: Record<string, string> = {
    estate: A,
    first_name: `Worker${String(n)}`,
    last_name: 'Tanti',
    gender: n % 2 === 0 ? 'female' : 'male',
    date_of_birth: '15/06/1990',
    national_id: `77${String(n).padStart(11, '0')}`,
    mobile: `+88017${String(10000000 + n)}`,
    worker_type: 'permanent',
    category: 'GENERAL',
    join_date: '2020-01-01',
    division: n % 3 === 0 ? 'S' : 'N',
    section: n % 3 === 0 ? 'S1' : 'N1',
    job_task: 'PLUCKING',
    ...over,
  };
  return WORKER_HEADER.map((h) => base[h] ?? '');
};

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  runner = { db: mdb.db, logger: silentLogger(), leaseSeconds: 600, retentionDays: 7 };
  // Estates and the hierarchy, straight into the database (the import is what is under test).
  await runUnscoped('test setup', async () => {
    const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
    const mk = async (code: string) =>
      (
        await mdb.migrator.estate.create({
          data: { organisationId: org.id, code, name: `Estate ${code}`, createdBy: 1n },
        })
      ).id;
    A = unique('EA');
    B = unique('EB');
    const a = await mk(A);
    await mk(B);
    const n = await mdb.migrator.division.create({
      data: { estateId: a, code: 'N', name: 'North', createdBy: 1n },
    });
    const s = await mdb.migrator.division.create({
      data: { estateId: a, code: 'S', name: 'South', createdBy: 1n },
    });
    await mdb.migrator.section.create({
      data: { divisionId: n.id, code: 'N1', name: 'North 1', createdBy: 1n },
    });
    await mdb.migrator.section.create({
      data: { divisionId: s.id, code: 'S1', name: 'South 1', createdBy: 1n },
    });
    await mdb.migrator.workerCategory.create({
      data: { code: 'GENERAL', name: 'General worker', createdBy: 1n },
    });
    await mdb.migrator.department.create({ data: { code: 'HR_ADMIN', name: 'HR & Admin', createdBy: 1n } });
    await mdb.migrator.designation.create({
      data: { code: 'HR_OFFICER', name: 'HR Officer', createdBy: 1n },
    });
    CLERK_ESTATE = a.toString();
  });
  const clerk = await role([
    'person.view',
    'person.create',
    'person.edit',
    'employment.view',
    'employment.create',
    'employment.edit',
    'contractor.view',
    'contractor.create',
  ]);
  CLERK = await user('ic', clerk.id, { scope_type: 'estate', scope_id: CLERK_ESTATE });
  const approver = await role([
    'person.view',
    'person.create',
    'employment.view',
    'employment.create',
    'employment.approve',
  ]);
  APPROVER = await user('ia', approver.id, { scope_type: 'all_estates' }, [
    'SOD-1:employment.approve+employment.create',
  ]);
}, 180_000);
let CLERK_ESTATE = '';

afterAll(async () => {
  await mdb.drop();
});

describe('workforce import (P2.06)', () => {
  it('imports 2,000 workers with a usable error report; each a person, a profile and a joining assignment', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => workerRow(i + 1));
    rows[10] = workerRow(11, { section: 'X9' }); // no such section
    rows[20] = workerRow(21, { join_date: '' }); // required
    rows[30] = workerRow(31, { national_id: rows[0]?.[5] ?? '' }); // the same person as row 2
    rows[40] = workerRow(41, { estate: B }); // outside the clerk's scope
    rows[50] = workerRow(51, { gender: 'unknown' });
    const b = await uploadAndValidate('workforce.worker', csv([WORKER_HEADER, ...rows]));
    expect(b).toMatchObject({ state: 'validated', row_count: 2000, valid_count: 1995, error_count: 5 });
    const errors = await errorsOf(b.id);
    const at = (row: number) => errors.filter((e) => e.row_number === row).map((e) => [e.column, e.code]);
    expect(at(12)).toEqual([['section', 'VALIDATION_FAILED']]);
    expect(at(22)).toContainEqual(['join_date', 'VALIDATION_FAILED']);
    expect(at(32)).toEqual([[null, 'DUPLICATE_IN_FILE']]);
    expect(at(42)[0]).toEqual(['estate', 'VALIDATION_FAILED']);
    expect(at(52)).toEqual([['gender', 'VALIDATION_FAILED']]);

    const done = await commit(b.id);
    expect(done).toMatchObject({ state: 'committed', committed_count: 1995, failed_count: 0 });
    const counts = await runUnscoped('test', async () => ({
      persons: await mdb.migrator.person.count({ where: { nationalId: { startsWith: '77' } } }),
      profiles: await mdb.migrator.employmentProfile.count({ where: { employmentType: 'worker' } }),
      approved: await mdb.migrator.employmentAssignment.count({
        where: { state: 'approved', changeReason: 'joining' },
      }),
    }));
    expect(counts).toEqual({ persons: 1995, profiles: 1995, approved: 1995 });
    const list = await data<
      {
        profile_number: string;
        current_assignment: {
          section: { code: string };
          division: { code: string };
          activity_type: { code: string };
        };
      }[]
    >(get('/employment-profiles?filter[employment_type]=worker&per_page=1'));
    expect(list[0]?.profile_number).toMatch(/^WRK-/);
    expect(list[0]?.current_assignment).toMatchObject({ activity_type: { code: 'PLUCKING' } });
  }, 600_000);

  it('reuses a person already registered under the NID; refuses a second current profile', async () => {
    const p = await data<{ id: string }>(
      post('/persons', {
        first_name: 'Already',
        national_id: '8800000000001',
        registered_estate_id: CLERK_ESTATE,
      }),
      201,
    );
    const b = await uploadAndValidate(
      'workforce.worker',
      csv([WORKER_HEADER, workerRow(1, { national_id: '8800000000001', first_name: 'Already' })]),
    );
    expect(b.valid_count).toBe(1);
    await commit(b.id);
    const profiles = await data<{ id: string }[]>(get(`/persons/${p.id}/employment-profiles`));
    expect(profiles).toHaveLength(1);
    const again = await uploadAndValidate(
      'workforce.worker',
      csv([WORKER_HEADER, workerRow(2, { national_id: '8800000000001' })]),
    );
    expect(again.error_count).toBe(1);
    expect((await errorsOf(again.id))[0]).toMatchObject({ column: 'national_id', code: 'DUPLICATE_KEY' });
  });

  it('employees with salaries: committing approves them, so another person with employment.approve commits', async () => {
    const header = [
      'estate',
      'first_name',
      'national_id',
      'employee_type',
      'join_date',
      'department',
      'designation',
      'basic_salary',
      'house_rent',
    ];
    const file = csv([
      header,
      [A, 'Farhana', '8800000000101', 'permanent', '2019-04-01', 'HR_ADMIN', 'HR_OFFICER', '28000', '14000'],
      [A, 'Nasrin', '8800000000102', 'permanent', '2019-04-01', 'HR_ADMIN', 'HR_OFFICER', '', '5000'],
    ]);
    const b = await uploadAndValidate('workforce.employee', file);
    expect(b).toMatchObject({ valid_count: 1, error_count: 1 });
    expect((await errorsOf(b.id))[0]).toMatchObject({ row_number: 3, column: 'basic_salary' });
    const refused = await post(`/imports/${b.id}/commit`, {});
    expect(refused.status, json(refused)).toBe(403);
    expect((refused.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
    const done = await commit(b.id, APPROVER);
    expect(done.committed_count).toBe(1);
    const a = await runUnscoped('test', () =>
      mdb.migrator.employmentAssignment.findFirstOrThrow({
        where: { profile: { person: { nationalId: '8800000000101' } } },
        include: { payLines: true },
      }),
    );
    expect(a).toMatchObject({ state: 'approved', isWageChange: true, approvedBy: BigInt(APPROVER) });
    expect(a.payLines.map((l) => [l.component, l.amount.toString()])).toEqual([
      ['basic', '28000'],
      ['house_rent', '14000'],
    ]);

    // The approver uploading their own file cannot also commit (approve) it.
    const own = await uploadAndValidate(
      'workforce.employee',
      csv([
        header,
        [A, 'Sultana', '8800000000103', 'permanent', '2019-04-01', 'HR_ADMIN', 'HR_OFFICER', '30000', ''],
      ]),
      APPROVER,
    );
    const self = await post(`/imports/${own.id}/commit`, {}, APPROVER);
    expect(self.status, json(self)).toBe(403);
    expect((self.body as { error: { code: string } }).error.code).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('imports contractors with their contact person and a first (draft) contract', async () => {
    const header = [
      'contractor_type',
      'trade_category',
      'contractor_name',
      'mobile',
      'present_address',
      'present_district',
      'contact_person_name',
      'contact_person_mobile',
      'trade_licence_no',
      'bank_name',
      'branch_name',
      'account_name',
      'account_no',
      'emergency_contact_name',
      'emergency_relation',
      'emergency_mobile',
      'estate',
      'work_type',
      'rate_basis',
      'rate',
      'contract_start_date',
      'contract_end_date',
      'contract_value',
    ];
    const base = [
      'company',
      'PLUCKING',
      'M/S Import One',
      '+8801712345678',
      'Tea Garden Road',
      'Moulvibazar',
      'Mr. Alam',
      '+8801712000000',
      'TL-IMP-1',
      'Islami Bank',
      'Sreemangal',
      'Import One',
      '0501',
      'Mr. Alam',
      'brother',
      '+8801711000099',
      A,
    ];
    const b = await uploadAndValidate(
      'workforce.contractor',
      csv([
        header,
        [...base, 'Plucking', 'Per Kg', '4.50', '2026-01-01', '2026-12-31', '120000'],
        [
          ...base.map((v, i) => (i === 2 ? 'Rahim Electric' : i === 8 ? 'TL-IMP-2' : v)),
          '',
          '',
          '',
          '',
          '',
          '',
        ],
        [
          ...base.map((v, i) => (i === 8 ? 'TL-IMP-3' : v)),
          'plucking',
          'lump_sum',
          '0',
          '2026-01-01',
          '2026-12-31',
          '',
        ],
      ]),
    );
    expect(b).toMatchObject({ valid_count: 2, error_count: 1 });
    expect((await errorsOf(b.id))[0]).toMatchObject({ row_number: 4, column: 'contract_value' });
    expect((await commit(b.id)).committed_count).toBe(2);
    const list = await data<
      {
        name: string;
        contact_person: string;
        current_contract: { status: string } | null;
        registered_estate_id: string;
      }[]
    >(get('/contractors?filter[q]=M/S Import'));
    expect(list[0]).toMatchObject({
      name: 'M/S Import One',
      contact_person: 'Mr. Alam',
      current_contract: { status: 'pending' },
      registered_estate_id: CLERK_ESTATE,
    });
  });
});
