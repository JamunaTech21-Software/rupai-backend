import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { readSheet, writeSheets } from '../../src/core/imports/sheets.js';
import { runJob, type RunnerDeps } from '../../src/core/jobs/runner.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.17 — the import framework on real MySQL, with the first importers (the reference lists): template,
 * upload, the validation job, the error report, commit of the valid rows only, and the refusals.
 */

/** The Administrator holds lookup.view and lookup.create (P6 R-01). */
const ADMIN = '1';
let NOBODY = '';
let mdb: MigratedDatabase;
let app: Express;
let runner: RunnerDeps;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

interface Batch {
  id: string;
  state: string;
  row_count: number;
  valid_count: number;
  error_count: number;
  committed_count: number;
  failed_count: number;
  problems: { code: string; message: string }[];
  can_commit: boolean;
  job: { id: string } | null;
  validate_job_id: string | null;
  commit_job_id: string | null;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 600)}`;
const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, actor = ADMIN) => as(request(app).post(`/api/v1${path}`), actor).send({});
async function data<T>(r: request.Test, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
}
/** Binary responses come back as a Buffer. */
const binary = (r: request.Test) =>
  r.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      done(null, Buffer.concat(chunks));
    });
  });

const upload = (type: string, body: Buffer, name: string, actor = ADMIN) =>
  as(request(app).post(`/api/v1/imports/${type}`), actor).attach('file', body, { filename: name });
const csv = (lines: string[]) => Buffer.from(lines.join('\n'), 'utf8');

async function runBatchJob(batchId: string, which: 'validate_job_id' | 'commit_job_id') {
  const b = await mdb.migrator.importBatch.findUniqueOrThrow({ where: { id: BigInt(batchId) } });
  const id = which === 'validate_job_id' ? b.validateJobId : b.commitJobId;
  expect(id).not.toBeNull();
  await runJob(runner, id ?? 0n);
  return mdb.migrator.job.findUniqueOrThrow({ where: { id: id ?? 0n } });
}
async function uploadAndValidate(type: string, body: Buffer, name = 'list.csv') {
  const b = await data<Batch>(upload(type, body, name), 202);
  expect(b).toMatchObject({ state: 'validating' });
  expect(b.job).not.toBeNull();
  await runBatchJob(b.id, 'validate_job_id');
  return data<Batch>(get(`/imports/${b.id}`));
}

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
  runner = { db: mdb.db, logger: silentLogger(), leaseSeconds: 60, retentionDays: 7 };
  NOBODY = (
    await mdb.migrator.user.create({ data: { username: unique('nobody'), passwordHash: 'x', createdBy: 1n } })
  ).id.toString();
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

describe('templates (P1.17)', () => {
  it('lists the importable reference lists with their columns', async () => {
    const types = await data<{ key: string; columns: { name: string; required: boolean }[] }[]>(
      get('/imports/types'),
    );
    const amenity = types.find((t) => t.key === 'lookup.amenity');
    expect(amenity?.columns.map((c) => [c.name, c.required])).toEqual([
      ['code', true],
      ['name', true],
      ['description', false],
      ['sort_order', false],
    ]);
    // Estate-scoped lists are not importable yet.
    expect(types.some((t) => t.key === 'lookup.shift')).toBe(false);
    expect(await data<unknown[]>(get('/imports/types', NOBODY))).toEqual([]);
  });

  it('gives the template as xlsx (with instructions) and as csv', async () => {
    const x = await binary(get('/imports/templates/lookup.tea_grade'));
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toContain('spreadsheetml');
    const sheet = await readSheet(x.body as Buffer, 'xlsx', 10);
    expect(sheet.header).toEqual([
      'code',
      'name',
      'description',
      'sort_order',
      'tea_type',
      'grade_category',
      'is_primary_grade',
    ]);
    const c = await binary(get('/imports/templates/lookup.amenity?format=csv'));
    expect((c.body as Buffer).toString('utf8')).toBe('﻿code,name,description,sort_order\r\n');
    expect((await get('/imports/templates/lookup.amenity', NOBODY)).status).toBe(403);
    expect((await get('/imports/templates/lookup.nonsense')).status).toBe(404);
  });
});

describe('an import with three bad rows (the P1.17 check)', () => {
  it('reports the bad rows, commits only the valid ones, and keeps the staging', async () => {
    const a = unique('AM');
    const b = unique('AM');
    const batch = await uploadAndValidate(
      'lookup.amenity',
      csv([
        'Code,Name,Description,Sort_Order', // headers match regardless of case
        `${a},Fire station,,10`,
        `${b},"Guest house, north",Two rooms,20`,
        `${unique('AM')},,missing name,30`, // 4: no name
        `${unique('AM')},Bad order,,ten`, // 5: not a number
        'WAREHOUSE,Warehouse again,,', // 6: already in the list (seeded)
        `${a},Fire station again,,`, // 7: the same code as row 2
      ]),
    );
    expect(batch).toMatchObject({
      state: 'validated',
      row_count: 6,
      valid_count: 2,
      error_count: 4,
      can_commit: true,
    });

    const lines = await data<{ row_number: number; column: string | null; code: string }[]>(
      get(`/imports/${batch.id}/errors`),
    );
    expect(lines.map((l) => [l.row_number, l.column, l.code])).toEqual([
      [4, 'name', 'VALIDATION_FAILED'],
      [5, 'sort_order', 'VALIDATION_FAILED'],
      [6, 'code', 'DUPLICATE_KEY'],
      [7, null, 'DUPLICATE_IN_FILE'],
    ]);
    // The downloadable report carries the row as it was read, to correct it.
    const file = await binary(get(`/imports/${batch.id}/errors/file`));
    const report = await readSheet(file.body as Buffer, 'xlsx', 100);
    expect(report.header).toEqual([
      'row',
      'column',
      'code',
      'message',
      'code',
      'name',
      'description',
      'sort_order',
    ]);
    expect(report.rows[1]?.cells.slice(0, 2)).toEqual(['5', 'sort_order']);
    expect(report.rows[1]?.cells[7]).toBe('ten');

    // Nothing is saved before commit.
    expect(await mdb.migrator.amenity.count({ where: { code: { in: [a, b] } } })).toBe(0);

    const committing = await data<Batch>(post(`/imports/${batch.id}/commit`), 202);
    expect(committing.state).toBe('committing');
    const job = await runBatchJob(batch.id, 'commit_job_id');
    expect(job.state).toBe('completed');
    const done = await data<Batch>(get(`/imports/${batch.id}`));
    expect(done).toMatchObject({
      state: 'committed',
      committed_count: 2,
      failed_count: 0,
      can_commit: false,
    });
    const made = await mdb.migrator.amenity.findMany({
      where: { code: { in: [a, b] } },
      orderBy: { code: 'asc' },
    });
    expect(made.map((m) => m.name).sort()).toEqual(['Fire station', 'Guest house, north']);
    // Audited as entries typed in would be, by the person who imported them.
    expect(
      await mdb.migrator.auditChange.count({
        where: {
          recordType: 'amenity',
          action: 'create',
          recordId: { in: made.map((m) => m.id.toString()) },
          changedBy: 1n,
        },
      }),
    ).toBe(2);
    // The staging rows stay, each with what it became.
    const rows = await data<{ row_number: number; state: string; target_id: string | null }[]>(
      get(`/imports/${batch.id}/rows?filter[state]=committed`),
    );
    expect(rows.map((r) => r.row_number)).toEqual([2, 3]);
    expect(rows.every((r) => r.target_id !== null)).toBe(true);

    // Running the commit job again saves nothing twice; committing again is refused.
    await runJob(runner, BigInt(done.commit_job_id ?? '0'));
    expect(await mdb.migrator.amenity.count({ where: { code: { in: [a, b] } } })).toBe(2);
    expect((await post(`/imports/${batch.id}/commit`)).status).toBe(409);
    expect((await post(`/imports/${batch.id}/cancel`)).status).toBe(409);
  });

  it('fails a row refused at commit and commits the rest (partial)', async () => {
    const a = unique('AM');
    const b = unique('AM');
    const batch = await uploadAndValidate('lookup.amenity', csv(['code,name', `${a},One`, `${b},Two`]));
    expect(batch.valid_count).toBe(2);
    // Someone adds b by hand between validation and commit.
    await mdb.migrator.amenity.create({ data: { code: b, name: 'Typed in', createdBy: 1n } });
    await data(post(`/imports/${batch.id}/commit`), 202);
    const job = await runBatchJob(batch.id, 'commit_job_id');
    expect(job.state).toBe('partial');
    expect(await data<Batch>(get(`/imports/${batch.id}`))).toMatchObject({
      committed_count: 1,
      failed_count: 1,
    });
    const lines = await data<{ row_number: number; code: string }[]>(get(`/imports/${batch.id}/errors`));
    expect(lines).toEqual([expect.objectContaining({ row_number: 3, code: 'DUPLICATE_KEY' })]);
  });
});

describe('files that cannot be used', () => {
  it('rejects a file whose header is not the template’s, and lets it be cancelled', async () => {
    const batch = await uploadAndValidate('lookup.amenity', csv(['code,title', 'X,Y']));
    expect(batch.state).toBe('rejected');
    expect(batch.problems.map((p) => p.code).sort()).toEqual(['MISSING_COLUMN', 'UNKNOWN_COLUMN']);
    expect((await post(`/imports/${batch.id}/commit`)).status).toBe(409);
    const cancelled = await data<Batch>(post(`/imports/${batch.id}/cancel`));
    expect(cancelled.state).toBe('cancelled');
  });

  it('rejects a file with no rows, and refuses what is not xlsx or csv', async () => {
    expect((await uploadAndValidate('lookup.amenity', csv(['code,name']))).problems[0]?.code).toBe('NO_ROWS');
    const res = await upload('lookup.amenity', Buffer.from('%PDF-1.4'), 'list.pdf');
    expect(res.status, json(res)).toBe(422);
    const fake = await upload('lookup.amenity', Buffer.from('code,name\n'), 'list.xlsx');
    expect(fake.status, json(fake)).toBe(422);
  });

  it('cancels a validated batch, discarding its staging rows', async () => {
    const batch = await uploadAndValidate('lookup.amenity', csv(['code,name', `${unique('AM')},One`]));
    await data(post(`/imports/${batch.id}/cancel`));
    expect(await mdb.migrator.importRow.count({ where: { importBatchId: BigInt(batch.id) } })).toBe(0);
  });
});

describe('xlsx, references and permissions', () => {
  it('imports an Excel workbook, with a reference written as a code', async () => {
    const tt = await mdb.migrator.teaType.findFirstOrThrow({ where: { code: 'CTC' } });
    const code = unique('G');
    const body = await writeSheets(
      [
        {
          name: 'Data',
          header: ['code', 'name', 'tea_type', 'grade_category', 'is_primary_grade'],
          rows: [
            [code, 'Broken Orange Pekoe', 'CTC', 'broken', 'yes'],
            [unique('G'), 'Nowhere', 'NOPE', 'leaf', 'no'],
          ],
        },
      ],
      'xlsx',
    );
    const batch = await uploadAndValidate('lookup.tea_grade', body, 'grades.xlsx');
    expect(batch).toMatchObject({ state: 'validated', valid_count: 1, error_count: 1 });
    const [line] = await data<{ column: string; message: string }[]>(get(`/imports/${batch.id}/errors`));
    expect(line).toMatchObject({ column: 'tea_type' });
    await data(post(`/imports/${batch.id}/commit`), 202);
    await runBatchJob(batch.id, 'commit_job_id');
    const grade = await mdb.migrator.teaGrade.findFirstOrThrow({ where: { code } });
    expect([grade.teaTypeId, grade.gradeCategory, grade.isPrimaryGrade]).toEqual([tt.id, 'broken', true]);
  });

  it('refuses an upload without the permission, and hides other people’s batches', async () => {
    const res = await upload('lookup.amenity', csv(['code,name', 'A,B']), 'x.csv', NOBODY);
    expect(res.status, json(res)).toBe(403);
    const batch = await uploadAndValidate('lookup.amenity', csv(['code,name', `${unique('AM')},One`]));
    expect((await get(`/imports/${batch.id}`, NOBODY)).status).toBe(404);
    expect(await data<unknown[]>(get('/imports', NOBODY))).toEqual([]);
    const mine = await data<{ id: string }[]>(get('/imports?filter[import_type]=lookup.amenity'));
    expect(mine.map((b) => b.id)).toContain(batch.id);
  });
});
