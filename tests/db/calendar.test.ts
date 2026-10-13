import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoSeeders } from '../../prisma/seed/demo-seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { AppError } from '../../src/core/errors/app-error.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import type { BusinessDate } from '../../src/core/time/dates.js';
import { periodOn } from '../../src/modules/calendar/fiscal.service.js';
import { assertSeasonOpenOn, seasonOn } from '../../src/modules/calendar/seasons.service.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/** P1.09 — season, fiscal_year, accounting_period, through the HTTP API on real MySQL. */

const ADMIN = '1';
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;
const d = (s: string) => s as BusinessDate;

const withVersion = (r: request.Test, version?: number) =>
  version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
const api = {
  get: (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = MANAGER, version?: number) =>
    withVersion(as(request(app).post(`/api/v1${path}`), actor), version).send(body),
  patch: (path: string, body: object, version: number, actor = MANAGER) =>
    withVersion(as(request(app).patch(`/api/v1${path}`), actor), version).send(body),
  del: (path: string, actor = MANAGER) => as(request(app).delete(`/api/v1${path}`), actor),
};

interface Node {
  id: string;
  version: number;
  [k: string]: unknown;
}
interface Failure {
  error: { code: string; details: { field?: string; message: string; context?: Record<string, unknown> }[] };
}
const one = (res: { body: unknown }) => (res.body as { data: Node }).data;
const many = (res: { body: unknown }) => (res.body as { data: Node[] }).data;
const failure = (res: { body: unknown }) => (res.body as Failure).error;
const created = async (r: request.Test): Promise<Node> => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return one(res);
};
const estate = () => created(api.post('/estates', { code: unique('E'), name: 'Estate' }));
const season = (estateId: string, start: string, end: string, over: object = {}) =>
  api.post('/seasons', {
    estate_id: estateId,
    code: unique('S'),
    name: 'Season',
    start_date: start,
    end_date: end,
    ...over,
  });

async function actorWith(permissions: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const role = await created(
    api.post('/roles', { code: unique('R_'), name: 'Calendar probe', permissions }, ADMIN),
  );
  const current = await api.get(`/users/${id}`, ADMIN);
  const set = await api.post(
    `/users/${id}/roles`,
    { roles: [{ role_id: role.id }] },
    ADMIN,
    one(current).version,
  );
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  for (const g of grants) expect((await api.post(`/users/${id}/scopes`, g, ADMIN)).status).toBe(201);
  return id;
}
const CRUD = (m: string) => ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`);
const ALL = [
  ...CRUD('season'),
  ...CRUD('fiscal_year'),
  ...CRUD('estate'),
  ...CRUD('division'),
  'accounting_period.view',
  'accounting_period.edit',
  'organisation.view',
  'organisation.edit',
];

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
  MANAGER = await actorWith(ALL, [{ scope_type: 'all_estates' }]);
});
afterAll(async () => {
  await mdb.drop();
});

describe('seasons (P3 §4.8, P1 §5.2)', () => {
  it('an overlapping season is refused, in any state; adjacent ones and other estates are fine', async () => {
    const e = await estate();
    const first = await created(season(e.id, '2026-03-01', '2027-02-28', { code: '2026-27' }));
    expect(first).toMatchObject({
      state: 'planned',
      start_date: '2026-03-01',
      end_date: '2027-02-28',
      closed_at: null,
    });

    for (const [start, end] of [
      ['2026-06-01', '2026-09-30'], // inside
      ['2025-12-01', '2026-03-01'], // touches the first day
      ['2027-02-28', '2027-12-31'], // touches the last day
      ['2025-01-01', '2028-01-01'], // contains it
    ] as const) {
      const res = await season(e.id, start, end);
      expect(res.status, `${start}..${end}`).toBe(422);
      expect(failure(res).details[0]).toMatchObject({
        field: 'start_date',
        message: 'overlaps season 2026-27 (2026-03-01 to 2027-02-28)',
        context: { season_id: first.id, code: '2026-27' },
      });
    }
    await expect(created(season(e.id, '2027-03-01', '2028-02-29'))).resolves.toMatchObject({
      state: 'planned',
    });
    await expect(created(season(e.id, '2025-03-01', '2026-02-28'))).resolves.toMatchObject({
      state: 'planned',
    });
    const other = await estate();
    await expect(
      created(season(other.id, '2026-03-01', '2027-02-28', { code: '2026-27' })),
    ).resolves.toMatchObject({ estate_id: other.id });

    expect(failure(await season(e.id, '2030-01-01', '2030-12-31', { code: '2026-27' }))).toMatchObject({
      code: 'DUPLICATE_KEY',
      details: [{ field: 'code' }],
    });
    expect(failure(await season(e.id, '2031-05-01', '2031-05-01')).details[0]).toMatchObject({
      field: 'end_date',
    });
    await expect(
      mdb.migrator.$executeRawUnsafe(`UPDATE season SET end_date = start_date WHERE id = ${first.id}`),
    ).rejects.toThrow(/ck_season_dates/);
  });

  it('two overlapping seasons created at the same moment: one is refused', async () => {
    const e = await estate();
    const results = await Promise.all([
      season(e.id, '2026-01-01', '2026-12-31'),
      season(e.id, '2026-06-01', '2027-05-31'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 422]);
  });

  it('planned → active → closed, with what may be edited in each state', async () => {
    const e = await estate();
    const s = await created(season(e.id, '2026-03-01', '2027-02-28'));
    await created(season(e.id, '2027-06-01', '2028-02-29'));

    expect((await api.post(`/seasons/${s.id}/close`, {}, MANAGER, 1)).status).toBe(409); // not active yet
    expect((await api.patch(`/seasons/${s.id}`, { start_date: '2026-02-01', name: 'Main' }, 1)).status).toBe(
      200,
    );
    expect((await api.post(`/seasons/${s.id}/activate`, {}, MANAGER, 9)).status).toBe(409); // stale version
    const active = one(await api.post(`/seasons/${s.id}/activate`, {}, MANAGER, 2));
    expect(active).toMatchObject({ state: 'active', version: 3 });

    // Active: name and end_date only; the end may be extended but never into another season.
    const fixed = await api.patch(`/seasons/${s.id}`, { start_date: '2026-01-01', code: 'X' }, 3);
    expect(fixed.status).toBe(422);
    expect(
      failure(fixed)
        .details.map((x) => x.field)
        .sort(),
    ).toEqual(['code', 'start_date']);
    expect((await api.patch(`/seasons/${s.id}`, { end_date: '2027-05-31' }, 3)).status).toBe(200);
    expect((await api.patch(`/seasons/${s.id}`, { end_date: '2027-06-01' }, 4)).status).toBe(422);
    expect((await api.del(`/seasons/${s.id}`)).status).toBe(409); // active: not deletable

    const closed = one(await api.post(`/seasons/${s.id}/close`, {}, MANAGER, 4));
    expect(closed).toMatchObject({ state: 'closed', closed_by: MANAGER });
    expect(closed.closed_at).not.toBeNull();
    expect((await api.patch(`/seasons/${s.id}`, { name: 'No' }, closed.version)).status).toBe(409);
    expect((await api.post(`/seasons/${s.id}/activate`, {}, MANAGER, closed.version)).status).toBe(409);

    const history = await mdb.db.statusHistory.findMany({
      where: { recordType: 'season', recordId: s.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toState)).toEqual(['planned', 'active', 'closed']);
  });

  it('only a planned season is deleted', async () => {
    const e = await estate();
    const s = await created(season(e.id, '2026-03-01', '2027-02-28'));
    expect((await api.del(`/seasons/${s.id}`)).status).toBe(204);
    expect((await api.get(`/seasons/${s.id}`)).status).toBe(404);
  });

  it('a closed season rejects operational dates inside it (SEASON_CLOSED), others pass', async () => {
    const e = await estate();
    const s = await created(season(e.id, '2025-03-01', '2026-02-28'));
    await api.post(`/seasons/${s.id}/activate`, {}, MANAGER, 1);
    const estateId = BigInt(e.id);
    const found = await runUnscoped('test', () => seasonOn(mdb.db, estateId, d('2025-06-12')));
    expect(found?.id.toString()).toBe(s.id);
    await expect(
      runUnscoped('test', () => assertSeasonOpenOn(mdb.db, estateId, d('2025-06-12'))),
    ).resolves.toMatchObject({ state: 'active' });
    await api.post(`/seasons/${s.id}/close`, {}, MANAGER, 2);
    const err = await runUnscoped('test', () => assertSeasonOpenOn(mdb.db, estateId, d('2025-06-12'))).catch(
      (x: unknown) => x,
    );
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'SEASON_CLOSED', status: 423 });
    // A date no season covers is the caller's decision, not an error here.
    await expect(
      runUnscoped('test', () => assertSeasonOpenOn(mdb.db, estateId, d('2030-01-01'))),
    ).resolves.toBeNull();
  });

  it('lists by estate and state, and finds the season of a date', async () => {
    const e = await estate();
    const a = await created(season(e.id, '2025-03-01', '2026-02-28'));
    const b = await created(season(e.id, '2026-03-01', '2027-02-28'));
    const ids = async (q: string) =>
      many(await api.get(`/seasons?filter[estate_id]=${e.id}&${q}`)).map((x) => x.id);
    expect(await ids('per_page=10')).toEqual([b.id, a.id]); // latest first
    expect(await ids('filter[start_date][to]=2025-06-12&filter[end_date][from]=2025-06-12')).toEqual([a.id]);
    expect(await ids('filter[state]=active')).toEqual([]);
  });
});

describe('season scope (P1 §12.3)', () => {
  it('an estate grant sees and manages its own seasons only; a division grant only reads', async () => {
    const mine = await estate();
    const theirs = await estate();
    const div = await created(
      api.post(`/estates/${mine.id}/divisions`, { code: unique('D'), name: 'Division' }),
    );
    const s = await created(season(mine.id, '2026-03-01', '2027-02-28'));
    const hidden = await created(season(theirs.id, '2026-03-01', '2027-02-28'));

    const estateUser = await actorWith(CRUD('season'), [{ scope_type: 'estate', scope_id: mine.id }]);
    expect(many(await api.get('/seasons?per_page=100', estateUser)).map((x) => x.id)).toEqual([s.id]);
    expect((await api.get(`/seasons/${hidden.id}`, estateUser)).status).toBe(404);
    expect((await api.post(`/seasons/${hidden.id}/activate`, {}, estateUser, 1)).status).toBe(404);
    expect((await api.post(`/seasons/${s.id}/activate`, {}, estateUser, 1)).status).toBe(200);
    const elsewhere = await season(theirs.id, '2028-03-01', '2029-02-28').then(() =>
      api.post(
        '/seasons',
        {
          estate_id: theirs.id,
          code: unique('S'),
          name: 'x',
          start_date: '2029-03-01',
          end_date: '2030-02-28',
        },
        estateUser,
      ),
    );
    expect(elsewhere.status).toBe(422);
    expect(failure(elsewhere).details[0]).toMatchObject({ field: 'estate_id', message: 'No such estate.' });

    const divisionUser = await actorWith(CRUD('season'), [{ scope_type: 'division', scope_id: div.id }]);
    expect(many(await api.get('/seasons?per_page=100', divisionUser)).map((x) => x.id)).toEqual([s.id]);
    expect((await api.post(`/seasons/${s.id}/close`, {}, divisionUser, 2)).status).toBe(403);
    const add = await api.post(
      '/seasons',
      { estate_id: mine.id, code: unique('S'), name: 'x', start_date: '2030-03-01', end_date: '2031-02-28' },
      divisionUser,
    );
    expect(add.status).toBe(403);
    expect(failure(add).code).toBe('SCOPE_DENIED');
  });
});

describe('fiscal years and accounting periods (P3 §4.9–§4.10, P1 §14, O-17)', () => {
  let year: Node;

  it('a fiscal year takes its dates from the organisation start month; years never overlap', async () => {
    year = await created(api.post('/fiscal-years', { start_year: 2026 }));
    expect(year).toMatchObject({
      code: 'FY2026-27',
      name: 'Fiscal year 2026-27',
      start_date: '2026-07-01',
      end_date: '2027-06-30',
      state: 'future',
      period_count: 0,
    });
    const again = await api.post('/fiscal-years', { start_year: 2026, code: 'OTHER' });
    expect(again.status).toBe(422);
    expect(failure(again).details[0]).toMatchObject({ field: 'start_year', context: { code: 'FY2026-27' } });
    // Organisation tier: there is no estate parameter (O-17).
    expect((await api.post('/fiscal-years', { start_year: 2031, estate_id: '1' })).status).toBe(422);
    const edited = one(await api.patch(`/fiscal-years/${year.id}`, { name: 'FY 26/27' }, 1));
    expect(edited).toMatchObject({ name: 'FY 26/27', start_date: '2026-07-01', version: 2 });
    year = edited;
  });

  it('the start month is fixed once a fiscal year exists', async () => {
    const org = one(await api.get('/organisation'));
    const res = await api.patch('/organisation', { fiscal_year_start_month: 1 }, org.version);
    expect(res.status).toBe(422);
    expect(failure(res)).toMatchObject({
      code: 'INVARIANT_VIOLATED',
      details: [{ field: 'fiscal_year_start_month' }],
    });
    expect(
      (await api.patch('/organisation', { fiscal_year_start_month: 7, city: 'Sylhet' }, org.version)).status,
    ).toBe(200);
  });

  it('generate-periods creates 12 contiguous months and period 13, once', async () => {
    const res = await api.post(`/fiscal-years/${year.id}/generate-periods`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const periods = many(res);
    expect(periods.map((p) => p.period_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(periods.every((p) => p.state === 'future')).toBe(true);
    expect(periods[0]).toMatchObject({
      name: 'July 2026',
      start_date: '2026-07-01',
      end_date: '2026-07-31',
      is_adjustment: false,
    });
    expect(periods[7]).toMatchObject({ name: 'February 2027', end_date: '2027-02-28' });
    expect(periods[11]).toMatchObject({ name: 'June 2027', end_date: '2027-06-30' });
    expect(periods[12]).toMatchObject({
      name: 'Year-end adjustments',
      start_date: '2027-06-30',
      end_date: '2027-06-30',
      is_adjustment: true,
    });
    for (let i = 1; i < 12; i += 1) {
      const gap =
        (Date.parse(String(periods[i]?.start_date)) - Date.parse(String(periods[i - 1]?.end_date))) /
        86_400_000;
      expect(gap, `period ${String(i + 1)}`).toBe(1);
    }
    const twice = await api.post(`/fiscal-years/${year.id}/generate-periods`, {});
    expect(twice.status).toBe(422);
    expect(failure(twice).code).toBe('INVARIANT_VIOLATED');
    expect(one(await api.get(`/fiscal-years/${year.id}`))).toMatchObject({ period_count: 13 });
    await expect(
      mdb.migrator.$executeRawUnsafe(
        `UPDATE accounting_period SET period_number = 14 WHERE fiscal_year_id = ${year.id} AND period_number = 13`,
      ),
    ).rejects.toThrow(/ck_accounting_period_number/);
  });

  it('periods open in order; the first one opens the fiscal year', async () => {
    const periods = many(await api.get(`/accounting-periods?filter[fiscal_year_id]=${year.id}&per_page=50`));
    const [p1, p2] = periods;
    const p12 = periods[11];
    const p13 = periods[12];
    if (!p1 || !p2 || !p12 || !p13) throw new Error('periods missing');

    const early = await api.post(`/accounting-periods/${p2.id}/open`, {}, MANAGER, 1);
    expect(early.status).toBe(422);
    expect(failure(early).details[0]).toMatchObject({
      message: 'Open period 1 (July 2026) first.',
      context: { period_number: 1 },
    });
    expect((await api.post(`/accounting-periods/${p1.id}/open`, {}, MANAGER, 7)).status).toBe(409);
    const opened = one(await api.post(`/accounting-periods/${p1.id}/open`, {}, MANAGER, 1));
    expect(opened).toMatchObject({ state: 'open', version: 2 });
    expect(one(await api.get(`/fiscal-years/${year.id}`))).toMatchObject({ state: 'open' });
    expect(one(await api.post(`/accounting-periods/${p1.id}/open`, {}, MANAGER, 2))).toMatchObject({
      state: 'open',
      version: 2,
    }); // idempotent
    expect((await api.post(`/accounting-periods/${p2.id}/open`, {}, MANAGER, 1)).status).toBe(200);
    expect((await api.post(`/accounting-periods/${p13.id}/open`, {}, MANAGER, 1)).status).toBe(422); // 3–12 still future

    const open = many(
      await api.get(`/accounting-periods?filter[fiscal_year_id]=${year.id}&filter[state]=open`),
    );
    expect(open.map((p) => p.period_number)).toEqual([1, 2]);
    const history = await mdb.db.statusHistory.findMany({
      where: { recordType: 'fiscal_year', recordId: year.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toState)).toEqual(['future', 'open']);
    // An opened fiscal year is never deleted.
    expect(failure(await api.del(`/fiscal-years/${year.id}`)).code).toBe('INVARIANT_VIOLATED');
  });

  it('a date resolves to its monthly period, never to period 13', async () => {
    const on = async (date: string) => (await periodOn(mdb.db, d(date)))?.periodNumber ?? null;
    expect(await on('2026-07-01')).toBe(1);
    expect(await on('2026-10-13')).toBe(4);
    expect(await on('2027-06-30')).toBe(12); // shared with period 13, which is never found by date
    expect(await on('2027-07-01')).toBeNull();
    const byFilter = many(
      await api.get(
        '/accounting-periods?filter[start_date][to]=2027-06-30&filter[end_date][from]=2027-06-30&filter[period_number][to]=12',
      ),
    );
    expect(byFilter.map((p) => p.period_number)).toEqual([12]);
  });

  it('a fiscal year nothing has happened in is deleted with its periods', async () => {
    const y = await created(api.post('/fiscal-years', { start_year: 2027 }));
    expect(y).toMatchObject({ code: 'FY2027-28', start_date: '2027-07-01', end_date: '2028-06-30' });
    const periods = many(await api.post(`/fiscal-years/${y.id}/generate-periods`, {}));
    expect(periods[7]).toMatchObject({ name: 'February 2028', end_date: '2028-02-29' }); // leap year
    expect((await api.del(`/fiscal-years/${y.id}`)).status).toBe(204);
    expect(await mdb.db.accountingPeriod.count({ where: { fiscalYearId: BigInt(y.id) } })).toBe(0);
  });

  it('without the permission: 403', async () => {
    const user = await actorWith(['season.view'], [{ scope_type: 'all_estates' }]);
    expect((await api.get('/fiscal-years', user)).status).toBe(403);
    expect((await api.get('/accounting-periods', user)).status).toBe(403);
    expect((await api.get('/seasons', user)).status).toBe(200);
  });
});

describe('demo data for the manager check (P1.09)', () => {
  it('is idempotent; the viewer sees DEMO-A seasons only and the shared fiscal calendar', async () => {
    // The fiscal year tests above already created FY2026-27, so the demo seed must leave it alone.
    const seeders = demoSeeders('Demo-password-123');
    await runSeeders(mdb.migrator, seeders, silentLogger());
    const count = () =>
      runUnscoped('test', () =>
        mdb.db.season.count({
          where: { code: { in: ['2025-26', '2026-27'] }, estate: { code: { startsWith: 'DEMO-' } } },
        }),
      );
    expect(await count()).toBe(3);
    await runSeeders(mdb.migrator, seeders, silentLogger());
    expect(await count()).toBe(3);
    expect(await mdb.db.fiscalYear.count({ where: { code: 'FY2026-27' } })).toBe(1);

    const viewer = (
      await mdb.db.user.findUniqueOrThrow({ where: { username: 'viewer' }, select: { id: true } })
    ).id.toString();
    const seasons = many(await api.get('/seasons?per_page=100', viewer));
    expect(seasons.map((s) => [s.code, s.state])).toEqual([
      ['2026-27', 'active'],
      ['2025-26', 'closed'],
    ]);
    expect(many(await api.get('/fiscal-years', viewer)).map((y) => y.code)).toContain('FY2026-27');
    expect((await api.post('/fiscal-years', { start_year: 2040 }, viewer)).status).toBe(403);
  });
});
