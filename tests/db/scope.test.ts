import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runWithRequestContext } from '../../src/core/context/request-context.js';
import { createDatabase, type Database } from '../../src/core/db/prisma.js';
import { AppError } from '../../src/core/errors/app-error.js';
import { getValidated } from '../../src/core/http/validate.js';
import { sendOne, sendPage } from '../../src/core/http/response.js';
import { defineModule } from '../../src/core/http/route.js';
import { getListQuery } from '../../src/core/http/list-query.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { appliedScope, EMPTY_SCOPE, runUnscoped, type ResolvedScope } from '../../src/core/scope/scope.js';
import { byColumn, ScopeRegistry } from '../../src/core/scope/scoped-models.js';
import { SCOPE_TARGETS } from '../../src/core/scope/targets.js';
import { buildModules } from '../../src/modules/index.js';
import { IdParams } from '../../src/modules/identity/identity.schema.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { describeScopeLeakage } from '../helpers/scope-leakage.js';
import { TEST_ENV } from '../helpers/test-app.js';
import {
  createMigratedDatabase,
  silentLogger,
  url,
  withRollback,
  type MigratedDatabase,
  ensureEstates,
} from './helpers.js';

/**
 * P1.03 — data scope: the user_scope table and its API, scope resolution, and enforcement in the
 * data-access layer.
 *
 * No scoped business table exists yet (estates arrive in P1.07), so the enforcement tests use a STAND-IN:
 * a client on which the `user` table is registered as if it were estate-tier, with person_id playing
 * the estate column and employment_profile_id the self column. The mechanism under test is exactly the
 * one every real scoped model will use.
 */

const ADMIN = '1';
const ESTATE_A = 101n;
const ESTATE_B = 102n;
const SELF_PROFILE = 555n;

let mdb: MigratedDatabase;
let app: Express;
let standIn: Database;
const rows: Record<'a1' | 'a2' | 'b1' | 'mine', string> = { a1: '', a2: '', b1: '', mine: '' };
const actors: Record<'estateA' | 'everywhere' | 'selfOnly' | 'noEdit', string> = {
  estateA: '',
  everywhere: '',
  selfOnly: '',
  noEdit: '',
};

let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

const api = {
  get: (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = ADMIN) =>
    as(request(app).post(`/api/v1${path}`), actor).send(body),
  patch: (path: string, body: object, version: number | undefined, actor = ADMIN) => {
    const r = as(request(app).patch(`/api/v1${path}`), actor).send(body);
    return version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
  },
  del: (path: string, actor = ADMIN) => as(request(app).delete(`/api/v1${path}`), actor),
};

/** A row in the stand-in "estate-tier" table: a user whose person_id plays the estate. */
async function record(estate: bigint | null, profile: bigint | null = null): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: {
      username: unique('rec'),
      passwordHash: 'x',
      personId: estate,
      employmentProfileId: profile,
      createdBy: 1n,
    },
  });
  return u.id.toString();
}

async function actorWith(permissions: string[], grants: object[], profile: bigint | null = null) {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', employmentProfileId: profile, createdBy: 1n },
  });
  const id = u.id.toString();
  if (permissions.length > 0) {
    const role = await api.post('/roles', { code: unique('R_'), name: 'Probe', permissions });
    expect(role.status).toBe(201);
    const current = await api.get(`/users/${id}`);
    const set = await as(request(app).post(`/api/v1/users/${id}/roles`), ADMIN)
      .set('If-Match', `"${String(current.body.data.version)}"`)
      .send({ roles: [{ role_id: role.body.data.id as string }] });
    expect(set.status).toBe(200);
  }
  for (const g of grants) expect((await api.post(`/users/${id}/scopes`, g)).status).toBe(201);
  return id;
}

/** A small module over the stand-in: list, single, and an aggregate, all through the scoped client. */
function probeModule(db: Database, authz: ReturnType<typeof dbPermissionResolver>) {
  const m = defineModule({
    name: 'probes',
    path: '/probes',
    tag: 'Probes',
    platform: memoryPlatform(),
    authz,
  });
  m.route({
    method: 'get',
    path: '/',
    summary: 'List',
    auth: { permission: 'user.view' },
    list: { pagination: 'page', filters: {}, sorts: [] },
    errors: [],
    success: { status: 200, description: 'ok' },
    handler: async (req, res) => {
      const q = getListQuery(res);
      const items = await db.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
      sendPage(
        req,
        res,
        items.map((r) => ({ id: r.id.toString() })),
        {
          pagination: q.page ?? { page: 1, perPage: 25 },
          total: items.length,
          appliedScope: await appliedScope(),
        },
      );
    },
  });
  m.route({
    method: 'get',
    path: '/summary',
    summary: 'Aggregate',
    auth: { permission: 'user.view' },
    errors: [],
    success: { status: 200, description: 'ok' },
    handler: async (_req, res) => {
      const agg = await db.user.aggregate({ _count: { _all: true } });
      sendOne(res, { total: agg._count._all });
    },
  });
  m.route({
    method: 'get',
    path: '/:id',
    summary: 'One',
    auth: { permission: 'user.view' },
    params: IdParams,
    errors: [],
    success: { status: 200, description: 'ok' },
    handler: async (_req, res) => {
      const { params } = getValidated(res, { params: IdParams });
      const r = await db.user.findUnique({ where: { id: params.id }, select: { id: true } });
      if (!r) throw new AppError('NOT_FOUND', 'Not found.');
      sendOne(res, { id: r.id.toString() });
    },
  });
  return m.build();
}

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  await ensureEstates(mdb.migrator, [ESTATE_A, ESTATE_B, 4n, 7n, 8n, 9n]);
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const authz = dbPermissionResolver(mdb.db);
  standIn = createDatabase(
    { database: { url: url('app', mdb.name), poolSize: 3, allowPublicKeyRetrieval: true } },
    {
      scopedModels: new ScopeRegistry().register('User', {
        estate: byColumn('personId'),
        self: byColumn('employmentProfileId'),
      }),
    },
  );
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: [probeModule(standIn, authz), ...buildModules(testModuleDeps({ config, db: mdb.db, authz }))],
    authenticate: testActor(),
  });

  rows.a1 = await record(ESTATE_A);
  rows.a2 = await record(ESTATE_A);
  rows.b1 = await record(ESTATE_B);
  rows.mine = await record(ESTATE_B, SELF_PROFILE);
  actors.estateA = await actorWith(['user.view'], [{ scope_type: 'estate', scope_id: String(ESTATE_A) }]);
  actors.everywhere = await actorWith(['user.view'], [{ scope_type: 'all_estates' }]);
  actors.selfOnly = await actorWith(['user.view'], [], SELF_PROFILE);
  actors.noEdit = await actorWith(['user.view'], []);
});
afterAll(async () => {
  await standIn.$disconnect();
  await mdb.drop();
});

// ---- table ---------------------------------------------------------------------------------------

describe('user_scope table (P3 §28.2)', () => {
  it('holds one all_estates grant per user, although its scope_id is NULL (generated key)', async () => {
    const insert = () =>
      mdb.migrator.$executeRaw`INSERT INTO user_scope (user_id, scope_type, granted_by, created_by)
                               VALUES (${BigInt(actors.noEdit)}, 'all_estates', 1, 1)`;
    await insert();
    await expect(insert()).rejects.toThrow(/ux_user_scope|Duplicate/i);
    await mdb.migrator.userScope.deleteMany({ where: { userId: BigInt(actors.noEdit) } });
  });

  it('a targeted type needs scope_id and all_estates/self refuse one, even by direct SQL', async () => {
    await expect(
      mdb.migrator.$executeRaw`INSERT INTO user_scope (user_id, scope_type, granted_by, created_by)
                               VALUES (1, 'estate', 1, 1)`,
    ).rejects.toThrow(/ck_user_scope_target/);
    await expect(
      mdb.migrator.$executeRaw`INSERT INTO user_scope (user_id, scope_type, scope_id, granted_by, created_by)
                               VALUES (1, 'self', 3, 1, 1)`,
    ).rejects.toThrow(/ck_user_scope_target/);
    await expect(
      mdb.migrator.$executeRaw`INSERT INTO user_scope (user_id, scope_type, scope_id, granted_by, created_by)
                               VALUES (1, 'region', 3, 1, 1)`,
    ).rejects.toThrow(/ck_user_scope_type/);
  });

  it('the bootstrap administrator is seeded with all_estates (R-01)', async () => {
    const grants = await mdb.db.userScope.findMany({ where: { userId: 1n } });
    expect(grants.map((g) => g.scopeType)).toEqual(['all_estates']);
    const me = await api.get('/auth/me');
    expect(me.body.data.scope.all_estates).toBe(true);
  });
});

// ---- API -------------------------------------------------------------------------------------------

describe('/users/{id}/scopes', () => {
  it('grants, lists and resolves into the user’s effective scope', async () => {
    const id = await actorWith([], []);
    const grant = await api.post(`/users/${id}/scopes`, { scope_type: 'estate', scope_id: '7' });
    expect(grant.status).toBe(201);
    expect(grant.headers.etag).toBe('"1"');
    expect(grant.headers.location).toBe(`/api/v1/users/${id}/scopes/${grant.body.data.id as string}`);
    expect(grant.body.data).toMatchObject({
      scope_type: 'estate',
      scope_id: '7',
      granted_by: '1',
      active: true,
    });
    await api.post(`/users/${id}/scopes`, { scope_type: 'department', scope_id: '3' });

    const list = await api.get(`/users/${id}/scopes`);
    expect((list.body.data as { scope_type: string }[]).map((g) => g.scope_type)).toEqual([
      'department',
      'estate',
    ]);
    const me = await api.get('/auth/me', id);
    expect(me.body.data.scope).toEqual({
      all_estates: false,
      estates: ['7'],
      divisions: [],
      sections: [],
      departments: ['3'],
      factories: [],
      warehouses: [],
      self_employment_profile_id: null,
    });
  });

  it('refuses a duplicate, self, a misplaced or missing target, and a past expiry', async () => {
    const id = await actorWith([], [{ scope_type: 'all_estates' }]);
    const field = async (body: object) => {
      const res = await api.post(`/users/${id}/scopes`, body);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      return [res.body.error.code as string, res.body.error.details[0].field as string];
    };
    expect(await field({ scope_type: 'all_estates' })).toEqual(['DUPLICATE_KEY', 'scope_id']);
    expect(await field({ scope_type: 'self' })).toEqual(['VALIDATION_FAILED', 'scope_type']);
    expect(await field({ scope_type: 'all_estates', scope_id: '4' })).toEqual([
      'VALIDATION_FAILED',
      'scope_id',
    ]);
    expect(await field({ scope_type: 'estate' })).toEqual(['VALIDATION_FAILED', 'scope_id']);
    expect(await field({ scope_type: 'estate', scope_id: '4', expires_at: '2020-01-01T00:00:00Z' })).toEqual([
      'VALIDATION_FAILED',
      'expires_at',
    ]);
    expect((await api.post('/users/999999/scopes', { scope_type: 'all_estates' })).status).toBe(404);
  });

  it('checks the target exists once its table registers a check (P1.07)', async () => {
    // department has no table until Phase 2, so a stand-in check shows the mechanism.
    SCOPE_TARGETS.set('department', (_tx, id) => Promise.resolve(id === 1n));
    try {
      const id = await actorWith([], []);
      expect(
        (await api.post(`/users/${id}/scopes`, { scope_type: 'department', scope_id: '1' })).status,
      ).toBe(201);
      const res = await api.post(`/users/${id}/scopes`, { scope_type: 'department', scope_id: '2' });
      expect(res.status).toBe(422);
      expect(res.body.error.details[0]).toMatchObject({ field: 'scope_id', message: 'No such department.' });
    } finally {
      SCOPE_TARGETS.delete('department');
    }
  });

  it('changes an expiry with If-Match; a lapsed grant is listed inactive and confers nothing', async () => {
    const id = await actorWith([], [{ scope_type: 'estate', scope_id: '8' }]);
    const grant = (await api.get(`/users/${id}/scopes`)).body.data[0] as { id: string; version: number };
    const path = `/users/${id}/scopes/${grant.id}`;
    const soon = new Date(Date.now() + 3_600_000).toISOString();

    expect((await api.patch(path, { expires_at: soon }, undefined)).body.error.code).toBe(
      'PRECONDITION_REQUIRED',
    );
    const ok = await api.patch(path, { expires_at: soon }, grant.version);
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
    expect((await api.patch(path, { expires_at: null }, grant.version)).body.error.code).toBe(
      'VERSION_CONFLICT',
    );

    await mdb.migrator.$executeRaw`UPDATE user_scope SET granted_at = UTC_TIMESTAMP() - INTERVAL 2 DAY,
      expires_at = UTC_TIMESTAMP() - INTERVAL 1 DAY WHERE id = ${BigInt(grant.id)}`;
    expect((await api.get(`/users/${id}/scopes`)).body.data[0].active).toBe(false);
    expect((await api.get('/auth/me', id)).body.data.scope.estates).toEqual([]);
  });

  it('revokes; another user’s grant id is 404', async () => {
    const id = await actorWith([], [{ scope_type: 'estate', scope_id: '9' }]);
    const other = await actorWith([], []);
    const grant = (await api.get(`/users/${id}/scopes`)).body.data[0] as { id: string };
    expect((await api.del(`/users/${other}/scopes/${grant.id}`)).status).toBe(404);
    expect((await api.del(`/users/${id}/scopes/${grant.id}`)).status).toBe(204);
    expect((await api.del(`/users/${id}/scopes/${grant.id}`)).status).toBe(404);
    expect((await api.get('/auth/me', id)).body.data.scope.estates).toEqual([]);
  });

  it('needs user.view to read and user.edit to change', async () => {
    expect((await api.get(`/users/${actors.estateA}/scopes`, actors.noEdit)).status).toBe(200);
    const res = await api.post(
      `/users/${actors.noEdit}/scopes`,
      { scope_type: 'all_estates' },
      actors.noEdit,
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
  });

  it('a disabled user has no scope at all', async () => {
    const id = await actorWith([], [{ scope_type: 'all_estates' }]);
    await mdb.migrator.user.update({ where: { id: BigInt(id) }, data: { status: 'disabled' } });
    expect(await dbPermissionResolver(mdb.db).scopeOf(BigInt(id))).toEqual(EMPTY_SCOPE);
  });
});

// ---- enforcement in the data-access layer -----------------------------------------------------------

describe('scope enforcement in the data-access layer (P1 §12.3)', () => {
  const inScope = <T>(scope: Partial<ResolvedScope>, work: () => Promise<T>) =>
    runWithRequestContext(
      { requestId: 'test', loadScope: () => Promise.resolve({ ...EMPTY_SCOPE, ...scope }) },
      work,
    );
  const ids = (list: { id: bigint }[]) => list.map((r) => r.id.toString()).sort();
  const estateA = { estates: [ESTATE_A] };

  it('a scoped query with no scope in context fails instead of running unfiltered', async () => {
    await expect(standIn.user.findMany()).rejects.toThrow(/no data scope is set/);
    await expect(runWithRequestContext({ requestId: 'x' }, () => standIn.user.count())).rejects.toThrow(
      /no data scope/,
    );
  });

  it('runUnscoped(reason) is the explicit way to read across scope', async () => {
    const all = await runUnscoped('test', () => standIn.user.count());
    expect(all).toBeGreaterThanOrEqual(4);
  });

  it('lists, single reads and aggregates see only in-scope rows', async () => {
    await inScope(estateA, async () => {
      expect(ids(await standIn.user.findMany({ select: { id: true } }))).toEqual([rows.a1, rows.a2].sort());
      expect(await standIn.user.findUnique({ where: { id: BigInt(rows.b1) } })).toBeNull();
      expect(await standIn.user.findFirst({ where: { id: BigInt(rows.b1) } })).toBeNull();
      await expect(standIn.user.findUniqueOrThrow({ where: { id: BigInt(rows.b1) } })).rejects.toThrow();
      expect(await standIn.user.count()).toBe(2);
      expect((await standIn.user.aggregate({ _count: { _all: true } }))._count._all).toBe(2);
      const groups = await standIn.user.groupBy({ by: ['personId'], _count: { _all: true } });
      expect(groups).toEqual([{ personId: ESTATE_A, _count: { _all: 2 } }]);
    });
  });

  it('cannot update or delete an out-of-scope row', async () => {
    await inScope(estateA, async () => {
      const many = await standIn.user.updateMany({
        where: { id: BigInt(rows.b1) },
        data: { phone: '+880100000' },
      });
      expect(many.count).toBe(0);
      await expect(
        standIn.user.update({ where: { id: BigInt(rows.b1) }, data: { phone: '+880100000' } }),
      ).rejects.toMatchObject({ code: 'P2025' });
      await expect(standIn.user.delete({ where: { id: BigInt(rows.b1) } })).rejects.toMatchObject({
        code: 'P2025',
      });
      expect((await standIn.user.deleteMany({ where: { personId: ESTATE_B } })).count).toBe(0);
    });
    expect((await mdb.db.user.findUnique({ where: { id: BigInt(rows.b1) } }))?.phone).toBeNull();
  });

  it('refuses to create a row outside the scope (403 SCOPE_DENIED), allows one inside', async () => {
    await inScope(estateA, async () => {
      await expect(
        standIn.user.create({
          data: { username: unique('x'), passwordHash: 'x', personId: ESTATE_B, createdBy: 1n },
        }),
      ).rejects.toMatchObject({ code: 'SCOPE_DENIED', status: 403 });
      await withRollback(standIn, async (tx) => {
        const r = await tx.user.create({
          data: { username: unique('x'), passwordHash: 'x', personId: ESTATE_A, createdBy: 1n },
        });
        expect(r.personId).toBe(ESTATE_A);
      });
    });
  });

  it('applies inside interactive transactions too', async () => {
    await inScope(estateA, () =>
      withRollback(standIn, async (tx) => {
        expect(await tx.user.count()).toBe(2);
      }),
    );
  });

  it('is the union of grants: an estate plus the implicit self', async () => {
    await inScope({ estates: [ESTATE_A], selfEmploymentProfileId: SELF_PROFILE }, async () => {
      expect(ids(await standIn.user.findMany({ select: { id: true } }))).toEqual(
        // The self-only actor is itself about profile 555, so its own row is in self scope too.
        [rows.a1, rows.a2, rows.mine, actors.selfOnly].sort(),
      );
    });
  });

  it('all_estates sees everything; no grant sees nothing', async () => {
    const all = await runUnscoped('count', () => standIn.user.count());
    await inScope({ allEstates: true }, async () => {
      expect(await standIn.user.count()).toBe(all);
    });
    await inScope({}, async () => {
      expect(await standIn.user.count()).toBe(0);
      expect(
        await standIn.user.count({ where: { OR: [{ status: 'active' }, { status: 'disabled' }] } }),
      ).toBe(0);
      expect(await standIn.user.findUnique({ where: { id: BigInt(rows.a1) } })).toBeNull();
      expect((await standIn.user.aggregate({ _count: { _all: true } }))._count._all).toBe(0);
      expect(await standIn.user.groupBy({ by: ['personId'], _count: { _all: true } })).toEqual([]);
      expect((await standIn.user.updateMany({ data: { phone: null } })).count).toBe(0);
    });
  });

  it('organisation-tier models are never filtered', async () => {
    await inScope({}, async () => {
      expect(await mdb.db.user.count()).toBeGreaterThan(0);
      expect(await standIn.role.count()).toBeGreaterThan(0);
    });
  });
});

// ---- the reusable leakage suite, run against the stand-in through the API -------------------------

describeScopeLeakage({
  resource: 'stand-in estate-tier records (estate grant)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': actors.estateA }),
  listPath: '/api/v1/probes',
  itemPath: (id) => `/api/v1/probes/${id}`,
  inScope: () => [rows.a1, rows.a2],
  outOfScope: () => [rows.b1, rows.mine],
  aggregate: {
    path: '/api/v1/probes/summary',
    read: (b) => (b as { data: { total: number } }).data.total,
    expected: () => 2,
  },
});

describeScopeLeakage({
  resource: 'stand-in estate-tier records (implicit self only)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': actors.selfOnly }),
  listPath: '/api/v1/probes',
  itemPath: (id) => `/api/v1/probes/${id}`,
  inScope: () => [rows.mine, actors.selfOnly],
  outOfScope: () => [rows.a1, rows.b1],
  aggregate: {
    path: '/api/v1/probes/summary',
    read: (b) => (b as { data: { total: number } }).data.total,
    expected: () => 2,
  },
});

describe('applied scope in list meta', () => {
  it('tells the client which scope the rows were filtered by', async () => {
    const res = await api.get('/probes', actors.estateA);
    expect(res.body.meta.applied_scope).toMatchObject({ all_estates: false, estates: [String(ESTATE_A)] });
    const all = await api.get('/probes', actors.everywhere);
    expect(all.body.meta.applied_scope.all_estates).toBe(true);
  });
});
