import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSeeders } from '../../prisma/seed/seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { createDatabase, type Database } from '../../src/core/db/prisma.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { DOCUMENT_TYPES } from '../../src/core/numbering/document-types.js';
import { allocateNumber } from '../../src/core/numbering/numbering.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { readSetting, settingsCipher } from '../../src/core/settings/settings.js';
import type { BusinessDate } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import {
  createMigratedDatabase,
  silentLogger,
  TEST_BOOTSTRAP_PASSWORD,
  url,
  type MigratedDatabase,
} from './helpers.js';

/** P1.11 — number_format, number_sequence, system_setting, on real MySQL. */

/** The System Administrator holds system.* (P6 §7.1 R-01). */
const ADMIN = '1';
const KEY = 'test-only-settings-key-0123456789abcdef';
const d = (s: string) => s as BusinessDate;
let mdb: MigratedDatabase;
/** A wider pool than the suite default, so concurrent allocations really overlap. */
let pool: Database;
let app: Express;
/** The same API on a server with no encryption key. */
let appWithoutKey: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

const withVersion = (r: request.Test, version?: number) =>
  version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
const api = {
  get: (path: string, actor = ADMIN, on = app) => as(request(on).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = ADMIN, on = app) =>
    as(request(on).post(`/api/v1${path}`), actor).send(body),
  patch: (path: string, body: object, version: number, actor = ADMIN) =>
    withVersion(as(request(app).patch(`/api/v1${path}`), actor), version).send(body),
  del: (path: string, actor = ADMIN) => as(request(app).delete(`/api/v1${path}`), actor),
};

interface Node {
  id: string;
  version: number;
  [k: string]: unknown;
}
interface Failure {
  error: { code: string; details: { field?: string; message: string }[] };
}
const one = (res: { body: unknown }) => (res.body as { data: Node }).data;
const many = (res: { body: unknown }) => (res.body as { data: Node[] }).data;
const failure = (res: { body: unknown }) => (res.body as Failure).error;
const created = async (r: request.Test): Promise<Node> => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return one(res);
};
const formatOf = async (documentType: string): Promise<Node> => {
  const [f] = many(await api.get(`/number-formats?filter[document_type]=${documentType}`));
  if (!f) throw new Error(documentType);
  return f;
};

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  pool = createDatabase({
    database: { url: url('app', mdb.name), poolSize: 12, allowPublicKeyRetrieval: true },
  });
  const build = (env: Record<string, string>) => {
    const config = loadConfig({
      ...TEST_ENV,
      DATABASE_URL: url('app', mdb.name),
      RATE_LIMIT_ENABLED: 'false',
      ...env,
    });
    const deps = testModuleDeps({
      config,
      db: mdb.db,
      authz: dbPermissionResolver(mdb.db),
      logger: silentLogger(),
    });
    return createApp({
      config,
      logger: silentLogger(),
      db: mdb.db,
      platform: memoryPlatform(),
      modules: buildModules(deps),
      authenticate: testActor(),
    });
  };
  app = build({ SETTINGS_ENCRYPTION_KEY: KEY });
  appWithoutKey = build({});
});
afterAll(async () => {
  await pool.$disconnect();
  await mdb.drop();
});

describe('number allocation (P2 §6.5, P1 §15.2)', () => {
  const journal = { date: d('2026-10-13'), fiscalYearCode: 'FY2026-27' };

  it('50 concurrent allocations produce 50 unique, gapless numbers', async () => {
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        withTransaction(pool, (tx) => allocateNumber(tx, 'journal', journal, 'posting'), {
          maxWait: 30_000,
          timeout: 30_000,
        }),
      ),
    );
    const sequences = results.map((r) => Number(r.sequence)).sort((a, b) => a - b);
    expect(sequences).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(new Set(results.map((r) => r.number)).size).toBe(50);
    expect(results.map((r) => r.number)).toContain('JV-FY2026-27-00050');
    expect(new Set(results.map((r) => r.scopeKey))).toEqual(new Set(['FY:FY2026-27']));
  });

  it('a rolled-back transaction leaves no gap', async () => {
    const before = await withTransaction(pool, (tx) => allocateNumber(tx, 'journal', journal, 'posting'));
    await expect(
      withTransaction(pool, async (tx) => {
        const lost = await allocateNumber(tx, 'journal', journal, 'posting');
        expect(lost.sequence).toBe(before.sequence + 1n);
        throw new Error('posting failed');
      }),
    ).rejects.toThrow('posting failed');
    const after = await withTransaction(pool, (tx) => allocateNumber(tx, 'journal', journal, 'posting'));
    expect(after.sequence).toBe(before.sequence + 1n); // the number the failed posting had taken
  });

  it('each scope has its own counter: fiscal year, estate, calendar year', async () => {
    const next = (
      type: string,
      ctx: Parameters<typeof allocateNumber>[2],
      at: 'draft' | 'posting' = 'draft',
    ) => withTransaction(pool, (tx) => allocateNumber(tx, type, ctx, at));
    expect(
      (await next('journal', { date: d('2027-08-01'), fiscalYearCode: 'FY2027-28' }, 'posting')).number,
    ).toBe('JV-FY2027-28-00001');
    // An operational document: by estate, restarting each calendar year.
    const a1 = await next('purchase_order', { date: d('2026-10-13'), estateCode: 'DEMO-A' });
    const a2 = await next('purchase_order', { date: d('2026-11-01'), estateCode: 'DEMO-A' });
    const b1 = await next('purchase_order', { date: d('2026-10-13'), estateCode: 'DEMO-B' });
    const a2027 = await next('purchase_order', { date: d('2027-01-02'), estateCode: 'DEMO-A' });
    expect([a1.number, a2.number, b1.number, a2027.number]).toEqual([
      'PO-DEMO-A-2026-00001',
      'PO-DEMO-A-2026-00002',
      'PO-DEMO-B-2026-00001',
      'PO-DEMO-A-2027-00001',
    ]);
  });

  it('a gapless number is never allocated at draft time; unknown types and missing parts are refused', async () => {
    const run = (type: string, ctx: Parameters<typeof allocateNumber>[2], at: 'draft' | 'posting') =>
      withTransaction(pool, (tx) => allocateNumber(tx, type, ctx, at));
    await expect(run('journal', journal, 'draft')).rejects.toThrow(
      /gapless; allocate its number in the posting transaction/,
    );
    await expect(run('made_up_document', journal, 'draft')).rejects.toThrow(/unknown document type/);
    await expect(run('purchase_order', { date: d('2026-10-13') }, 'draft')).rejects.toThrow(/estate code/);
  });

  it('the app account can count a sequence up but never delete one', async () => {
    await expect(mdb.db.$executeRawUnsafe('DELETE FROM number_sequence WHERE id = 0')).rejects.toThrow(
      /DELETE command denied/,
    );
    await expect(mdb.db.$executeRawUnsafe('DELETE FROM number_format WHERE id = 0')).rejects.toThrow(
      /DELETE command denied/,
    );
  });
});

describe('/number-formats (P4 §14)', () => {
  it('the seed gives every document type one format; financial ones are gapless within the fiscal year', async () => {
    const formats = many(await api.get('/number-formats?per_page=200'));
    expect(formats.map((f) => f.document_type).sort()).toEqual(DOCUMENT_TYPES.map((t) => t.key).sort());
    expect(await formatOf('journal')).toMatchObject({
      label: 'Journal',
      lifecycle: 'financial',
      prefix: 'JV',
      is_gapless: true,
      include_fiscal_year: true,
      include_estate_code: false,
      reset_frequency: 'never',
      available_components: ['fiscal_year'],
      example: 'JV-FY2026-27-00001',
    });
    expect(await formatOf('purchase_order')).toMatchObject({
      lifecycle: 'operational',
      is_gapless: false,
      include_estate_code: true,
      reset_frequency: 'yearly',
    });
    expect(
      many(await api.get('/number-formats?filter[is_gapless]=true&per_page=200')).every(
        (f) => f.lifecycle === 'financial',
      ),
    ).toBe(true);
  });

  it('the format is edited with If-Match and audited; a re-seed keeps the edit', async () => {
    const f = await formatOf('goods_receipt');
    expect((await api.patch(`/number-formats/${f.id}`, { prefix: 'gr' }, 99)).status).toBe(409);
    const edited = one(
      await api.patch(
        `/number-formats/${f.id}`,
        { prefix: 'gr', separator: '/', sequence_width: 6, reset_frequency: 'monthly' },
        f.version,
      ),
    );
    expect(edited).toMatchObject({ prefix: 'GR', separator: '/', sequence_width: 6, version: f.version + 1 });
    expect(String(edited.example)).toMatch(/^GR\/EST\/\d{6}\/000001$/);
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'number_format', recordId: f.id },
    });
    expect(audit.map((a) => a.field).sort()).toEqual([
      'prefix',
      'reset_frequency',
      'separator',
      'sequence_width',
    ]);
    const results = await runSeeders(
      mdb.migrator,
      buildSeeders({ BOOTSTRAP_ADMIN_PASSWORD: TEST_BOOTSTRAP_PASSWORD }),
      silentLogger(),
    );
    expect(Object.entries(results).find(([n]) => n.startsWith('numbering:'))?.[1]).toEqual({
      inserted: 0,
      updated: 0,
    });
    expect(await formatOf('goods_receipt')).toMatchObject({ prefix: 'GR' });
  });

  it('only components the document has can be switched on; the type and gapless are not editable', async () => {
    const journal = await formatOf('journal');
    const res = await api.patch(
      `/number-formats/${journal.id}`,
      { include_estate_code: true, include_season: true },
      journal.version,
    );
    expect(res.status).toBe(422);
    expect(
      failure(res)
        .details.map((x) => x.field)
        .sort(),
    ).toEqual(['include_estate_code', 'include_season']);
    expect(
      (await api.patch(`/number-formats/${journal.id}`, { is_gapless: false }, journal.version)).status,
    ).toBe(422);
    expect(
      (await api.patch(`/number-formats/${journal.id}`, { document_type: 'x' }, journal.version)).status,
    ).toBe(422);
    expect(
      (await api.patch(`/number-formats/${journal.id}`, { prefix: 'J V' }, journal.version)).status,
    ).toBe(422);
    expect(
      (await api.patch(`/number-formats/${journal.id}`, { sequence_width: 2 }, journal.version)).status,
    ).toBe(422);
  });

  it('preview shows the next number without allocating it; sequences lists the counters', async () => {
    const f = await formatOf('leave');
    const ctx = { date: d('2026-10-13'), estateCode: 'DEMO-A' };
    const query = 'estate_code=DEMO-A&date=2026-10-13';
    expect(one(await api.get(`/number-formats/${f.id}/preview?${query}`))).toMatchObject({
      next_number: 'LV-DEMO-A-2026-00001',
      last_number: '0',
    });
    expect(one(await api.get(`/number-formats/${f.id}/preview?${query}`))).toMatchObject({
      next_number: 'LV-DEMO-A-2026-00001',
    }); // still 1
    await withTransaction(pool, (tx) => allocateNumber(tx, 'leave', ctx, 'draft'));
    expect(one(await api.get(`/number-formats/${f.id}/preview?${query}`))).toMatchObject({
      next_number: 'LV-DEMO-A-2026-00002',
      scope_key: 'E:DEMO-A|Y:2026',
      last_number: '1',
    });
    expect(many(await api.get(`/number-formats/${f.id}/sequences`))).toEqual([
      expect.objectContaining({ scope_key: 'E:DEMO-A|Y:2026', last_number: '1' }),
    ]);
  });
});

describe('/settings (P3 §28.6, P4 §14)', () => {
  it('typed values: created, read, edited with If-Match, cleared, deleted, audited', async () => {
    const key = `attendance.${unique('grace_minutes')}`;
    const s = await created(
      api.post('/settings', { key, value_type: 'integer', value: 10, description: 'Lateness grace' }),
    );
    expect(s).toMatchObject({
      key,
      group: 'attendance',
      value: 10,
      has_value: true,
      is_encrypted: false,
      version: 1,
    });
    expect(failure(await api.post('/settings', { key, value_type: 'integer', value: 5 }))).toMatchObject({
      code: 'DUPLICATE_KEY',
    });
    expect((await api.patch(`/settings/${s.id}`, { value: 15 }, 9)).status).toBe(409);
    expect(one(await api.patch(`/settings/${s.id}`, { value: 15 }, 1))).toMatchObject({
      value: 15,
      version: 2,
      updated_by: ADMIN,
    });
    expect(failure(await api.patch(`/settings/${s.id}`, { value: '15' }, 2)).details[0]).toMatchObject({
      field: 'value',
      message: 'must be a whole number',
    });
    expect(one(await api.patch(`/settings/${s.id}`, { value: null }, 2))).toMatchObject({
      value: null,
      has_value: false,
    });
    expect(await readSetting(mdb.db, null, key)).toBeNull();
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'system_setting', recordId: s.id, field: 'value' },
      orderBy: { id: 'asc' },
    });
    expect(audit.map((a) => [a.oldValue, a.newValue])).toEqual([
      ['10', '15'],
      ['15', null],
    ]);
    expect((await api.del(`/settings/${s.id}`)).status).toBe(204);
    expect(await readSetting(mdb.db, null, key)).toBeUndefined();
  });

  it('each value type accepts its own form only: a decimal is a string, never a float', async () => {
    const make = (value_type: string, value: unknown) =>
      api.post('/settings', { key: `demo.${unique('k')}`, value_type, value });
    expect(one(await make('decimal', '12.50'))).toMatchObject({ value: '12.50' });
    expect((await make('decimal', 12.5)).status).toBe(422);
    expect(one(await make('boolean', false))).toMatchObject({ value: false, has_value: true });
    expect((await make('boolean', 'yes')).status).toBe(422);
    expect(one(await make('json', { days: ['fri', 'sat'] }))).toMatchObject({
      value: { days: ['fri', 'sat'] },
    });
    expect(one(await make('string', 'Asia/Dhaka'))).toMatchObject({ value: 'Asia/Dhaka' });
    expect((await api.post('/settings', { key: 'NoDots', value_type: 'string', value: 'x' })).status).toBe(
      422,
    );
    expect((await api.post('/settings', { key: 'a.b', value_type: 'date', value: 'x' })).status).toBe(422);
  });

  it('an encrypted setting is write-only: stored as ciphertext, never returned, never in the audit', async () => {
    const key = `integration.${unique('api_secret')}`;
    const secret = 'sk-live-0123456789';
    const s = await created(
      api.post('/settings', { key, value_type: 'string', is_encrypted: true, value: secret }),
    );
    expect(s).toMatchObject({ is_encrypted: true, value: null, has_value: true });
    expect(one(await api.get(`/settings/${s.id}`))).toMatchObject({ value: null, has_value: true });
    expect(JSON.stringify((await api.get('/settings?per_page=200')).body)).not.toContain(secret);

    const row = await mdb.db.systemSetting.findUniqueOrThrow({ where: { settingKey: key } });
    expect(row.settingValue).toMatch(/^enc:v1:/);
    expect(row.settingValue).not.toContain(secret);
    // Server code that needs it reads it with the key.
    expect(await readSetting(mdb.db, settingsCipher(KEY), key)).toBe(secret);

    expect(one(await api.patch(`/settings/${s.id}`, { value: 'sk-live-rotated' }, 1))).toMatchObject({
      value: null,
      has_value: true,
      version: 2,
    });
    expect(await readSetting(mdb.db, settingsCipher(KEY), key)).toBe('sk-live-rotated');
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'system_setting', recordId: s.id },
    });
    const text = audit.map((a) => `${a.oldValue ?? ''}|${a.newValue ?? ''}`).join('\n');
    expect(text).not.toContain(secret);
    expect(text).not.toContain('sk-live-rotated');
    const change = audit.find((a) => a.action === 'update' && a.field === 'value');
    expect(change?.oldValue).toMatch(/^\[encrypted [0-9a-f]{8}\]$/);
    expect(change?.newValue).not.toBe(change?.oldValue); // the audit shows THAT it changed
    // is_encrypted cannot be switched off afterwards.
    expect((await api.patch(`/settings/${s.id}`, { is_encrypted: false }, 2)).status).toBe(422);
  });

  it('a server without the encryption key refuses encrypted settings, clearly', async () => {
    const res = await api.post(
      '/settings',
      { key: `integration.${unique('k')}`, value_type: 'string', is_encrypted: true, value: 'x' },
      ADMIN,
      appWithoutKey,
    );
    expect(res.status).toBe(422);
    expect(failure(res)).toMatchObject({
      code: 'INVARIANT_VIOLATED',
      details: [{ message: 'SETTINGS_ENCRYPTION_KEY is not configured.' }],
    });
    await expect(
      created(
        api.post(
          '/settings',
          { key: `demo.${unique('plain')}`, value_type: 'string', value: 'x' },
          ADMIN,
          appWithoutKey,
        ),
      ),
    ).resolves.toMatchObject({
      value: 'x',
    });
  });

  it('lists by group, and needs system.* to read or change', async () => {
    const group = unique('grp');
    await created(api.post('/settings', { key: `${group}.b`, value_type: 'string', value: '2' }));
    await created(api.post('/settings', { key: `${group}.a`, value_type: 'string', value: '1' }));
    expect(many(await api.get(`/settings?filter[group]=${group}`)).map((s) => s.key)).toEqual([
      `${group}.a`,
      `${group}.b`,
    ]);
    const u = await mdb.migrator.user.create({
      data: { username: unique('nobody'), passwordHash: 'x', createdBy: 1n },
    });
    expect((await api.get('/settings', u.id.toString())).status).toBe(403);
    expect((await api.get('/number-formats', u.id.toString())).status).toBe(403);
  });
});

describe('seed additions', () => {
  it('leave types ship seeded (P3 Table 31.2)', async () => {
    const rows = await mdb.db.leaveType.findMany({ orderBy: { sortOrder: 'asc' }, select: { code: true } });
    expect(rows.map((r) => r.code)).toEqual(['CASUAL', 'SICK', 'EARNED', 'MATERNITY', 'UNPAID']);
  });
});
