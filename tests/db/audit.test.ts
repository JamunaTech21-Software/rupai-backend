import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { auditCreate } from '../../src/core/audit/audit.js';
import { logIntegration } from '../../src/core/audit/integration-log.js';
import { authenticate } from '../../src/core/auth/authenticate.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runWithRequestContext } from '../../src/core/context/request-context.js';
import { createDatabase, type Database } from '../../src/core/db/prisma.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { EMPTY_SCOPE } from '../../src/core/scope/scope.js';
import { byColumn, ScopeRegistry } from '../../src/core/scope/scoped-models.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import {
  createMigratedDatabase,
  ensureEstates,
  silentLogger,
  TEST_BOOTSTRAP_PASSWORD,
  url,
  type MigratedDatabase,
} from './helpers.js';

/** P1.05 — audit_change, status_history, access_log, integration_log, and /audit. */

const ADMIN = '1';
const RANGE = 'filter[changed_at][from]=2020-01-01T00:00:00Z&filter[changed_at][to]=2099-01-01T00:00:00Z';
const SINCE = () =>
  `filter[changed_at][from]=${new Date(Date.now() - 3_600_000).toISOString()}&filter[changed_at][to]=${new Date(Date.now() + 3_600_000).toISOString()}`;
const ACCESS_RANGE = () =>
  `filter[occurred_at][from]=${new Date(Date.now() - 3_600_000).toISOString()}&filter[occurred_at][to]=${new Date(Date.now() + 3_600_000).toISOString()}`;

let mdb: MigratedDatabase;
let app: Express; // acts with the test actor header
let authApp: Express; // real sign-in
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  await ensureEstates(mdb.migrator, [42n]);
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  const base = {
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
  };
  app = createApp({ ...base, authenticate: testActor() });
  authApp = createApp({ ...base, authenticate: authenticate(deps) });
});
afterAll(async () => {
  await mdb.drop();
});

const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object, version?: number, actor = ADMIN) => {
  const r = as(request(app).post(`/api/v1${path}`), actor).send(body);
  return version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
};

interface Change {
  record_type: string;
  record_id: string;
  action: string;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: { id: string; username: string } | null;
  ip_address: string | null;
  reason: string | null;
}
async function changesOf(type: string, id: string): Promise<Change[]> {
  const res = await get(
    `/audit/changes?filter[record_type]=${type}&filter[record_id]=${id}&${RANGE}&limit=200`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as Change[];
}

// ---- integrity -------------------------------------------------------------------------------------

describe('append-only (P3 §29, P1 §13.3)', () => {
  it.each(['audit_change', 'status_history', 'access_log', 'integration_log'])(
    'the app account cannot UPDATE or DELETE %s',
    async (table) => {
      await expect(mdb.db.$executeRawUnsafe(`UPDATE \`${table}\` SET id = id`)).rejects.toThrow(/denied/i);
      await expect(mdb.db.$executeRawUnsafe(`DELETE FROM \`${table}\``)).rejects.toThrow(/denied/i);
    },
  );

  it('an audited action whose audit write fails fails entirely (same transaction)', async () => {
    const username = unique('atomic');
    await expect(
      runWithRequestContext({ requestId: 't', actorId: '1' }, () =>
        withTransaction(mdb.db, async (tx) => {
          const u = await tx.user.create({ data: { username, passwordHash: 'x', createdBy: 1n } });
          // record_type violates ck_audit_change_record_type: the audit write fails.
          await auditCreate(tx, { type: 'Bad-Type', class: 'master', fields: [] }, u.id, {});
        }),
      ),
    ).rejects.toThrow(/ck_audit_change_record_type/);
    expect(await mdb.db.user.findUnique({ where: { username } })).toBeNull();
  });
});

// ---- audit of identity changes -----------------------------------------------------------------------

describe('every user and role change is audited (P1.05 verify)', () => {
  it('user: create, edit, roles, disable, delete — with status history', async () => {
    const created = await post('/users', {
      username: unique('aud'),
      initial_password: 'Temporary-Password-1',
    });
    const id = created.body.data.id as string;
    await as(request(app).patch(`/api/v1/users/${id}`), ADMIN)
      .set('If-Match', '"1"')
      .send({ phone: '+8801711000000' });
    const role = await post('/roles', { code: unique('AUDR_'), name: 'Viewer', permissions: ['user.view'] });
    await post(`/users/${id}/roles`, { roles: [{ role_id: role.body.data.id as string }] }, 2);
    await post(`/users/${id}/deactivate`, {}, 3);

    const changes = await changesOf('user', id);
    // Newest first.
    expect(changes.map((c) => `${c.action}:${c.field ?? '*'}`)).toEqual([
      'update:status',
      'update:roles',
      'update:phone',
      'create:*',
    ]);
    expect(JSON.parse(changes[3]?.new_value ?? '{}')).toMatchObject({
      status: 'active',
      must_change_password: true,
    });
    expect(JSON.stringify(changes)).not.toMatch(/password_hash|argon2/);
    expect(changes[1]).toMatchObject({ old_value: '[]', new_value: JSON.stringify([role.body.data.code]) });
    expect(changes[0]).toMatchObject({
      old_value: 'active',
      new_value: 'disabled',
      changed_by: { id: ADMIN, username: 'admin' },
    });
    // Masters do not carry the client address (P1 Table 13.1).
    expect(changes[0]?.ip_address).toBeNull();

    const history = await get(
      `/audit/status-history?filter[record_type]=user&filter[record_id]=${id}&${RANGE}`,
    );
    expect(
      (history.body.data as { from_state: string | null; to_state: string }[]).map((h) => [
        h.from_state,
        h.to_state,
      ]),
    ).toEqual([
      ['active', 'disabled'],
      [null, 'active'],
    ]);

    // A never-used account can be deleted; the deletion is audited with a snapshot.
    const other = await post('/users', {
      username: unique('gone'),
      initial_password: 'Temporary-Password-1',
    });
    expect(
      (await as(request(app).delete(`/api/v1/users/${other.body.data.id as string}`), ADMIN)).status,
    ).toBe(204);
    const del = await changesOf('user', other.body.data.id as string);
    expect(del[0]).toMatchObject({ action: 'delete' });
    expect(JSON.parse(del[0]?.old_value ?? '{}')).toMatchObject({ username: other.body.data.username });
  });

  it('a failed change writes nothing', async () => {
    const before = await mdb.db.auditChange.count();
    const dup = await post('/users', { username: 'admin', initial_password: 'Temporary-Password-1' });
    expect(dup.body.error.code).toBe('DUPLICATE_KEY');
    expect(await mdb.db.auditChange.count()).toBe(before);
  });

  it('role: create, permissions, deactivate, delete — with status history', async () => {
    const created = await post('/roles', {
      code: unique('AUDR_'),
      name: 'Clerk',
      permissions: ['lookup.view'],
    });
    const id = created.body.data.id as string;
    await as(request(app).patch(`/api/v1/roles/${id}`), ADMIN)
      .set('If-Match', '"1"')
      .send({ permissions: ['lookup.view', 'lookup.create'] });
    await post(`/roles/${id}/deactivate`, {}, 2);
    expect((await as(request(app).delete(`/api/v1/roles/${id}`), ADMIN)).status).toBe(204);

    const changes = await changesOf('role', id);
    expect(changes.map((c) => `${c.action}:${c.field ?? '*'}`)).toEqual([
      'delete:*',
      'update:status',
      'update:permissions',
      'create:*',
    ]);
    expect(changes[2]).toMatchObject({
      old_value: JSON.stringify(['lookup.view']),
      new_value: JSON.stringify(['lookup.create', 'lookup.view']),
    });
  });

  it('scope grants and authorisations (with reason and client address) are audited', async () => {
    const u = await post('/users', { username: unique('scp'), initial_password: 'Temporary-Password-1' });
    const uid = u.body.data.id as string;
    const grant = await post(`/users/${uid}/scopes`, { scope_type: 'estate', scope_id: '42' });
    expect((await changesOf('user_scope', grant.body.data.id as string))[0]).toMatchObject({
      action: 'create',
    });

    const role = await post('/roles', {
      code: unique('AUDS_'),
      name: 'Exporter',
      permissions: ['payroll.export'],
    });
    const reason = 'Payroll officer needs the bank file each month';
    const assigned = await as(request(app).post(`/api/v1/users/${uid}/roles`), ADMIN)
      .set('If-Match', '"1"')
      .set('User-Agent', 'audit-test-agent')
      .send({
        roles: [{ role_id: role.body.data.id as string }],
        authorisations: [{ key: 'SENSITIVE:payroll.export', reason }],
      });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    const auth = (await get(`/users/${uid}/authorisations`)).body.data[0] as { id: string };
    const created = (await changesOf('access_authorisation', auth.id))[0];
    // Policy class: the reason, the client address and the user agent are kept (P1 §13.2).
    expect(created).toMatchObject({ action: 'create', reason });
    expect(created?.ip_address).toBeTruthy();

    await as(request(app).delete(`/api/v1/users/${uid}/authorisations/${auth.id}`), ADMIN);
    expect((await changesOf('access_authorisation', auth.id))[0]).toMatchObject({
      action: 'cancel',
      field: 'removed_at',
    });
  });
});

// ---- access log ---------------------------------------------------------------------------------------

describe('access log (P1 §12.4, P6 §11.4)', () => {
  const events = async (type: string) => {
    const res = await get(`/audit/access-log?filter[event_type]=${type}&${ACCESS_RANGE()}&limit=200`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data as {
      user: { id: string } | null;
      module: string | null;
      detail: Record<string, unknown> | null;
      ip_address: string | null;
    }[];
  };

  it('records sign-in success, failure (even for an unknown user), password change and logout', async () => {
    const login = (username: string, password: string) =>
      request(authApp).post('/api/v1/auth/login').send({ username, password });
    expect((await login('nobody-here', 'x')).status).toBe(401);
    expect((await login('admin', 'wrong-password')).status).toBe(401);
    const ok = await login('admin', TEST_BOOTSTRAP_PASSWORD);
    expect(ok.status).toBe(200);
    const bearer = { Authorization: `Bearer ${ok.body.data.access_token as string}` };
    await request(authApp)
      .post('/api/v1/auth/password/change')
      .set(bearer)
      .send({ current_password: TEST_BOOTSTRAP_PASSWORD, new_password: 'Audit-Admin-Password-1' });
    expect((await request(authApp).post('/api/v1/auth/logout').set(bearer)).status).toBe(204);

    const failed = await events('failed_login');
    expect(failed.some((e) => e.user === null && e.detail?.username === 'nobody-here')).toBe(true);
    expect(failed.some((e) => e.user?.id === ADMIN && e.detail?.reason === 'bad_password')).toBe(true);
    expect((await events('login'))[0]).toMatchObject({ user: { id: ADMIN }, module: 'auth' });
    expect((await events('login'))[0]?.ip_address).toBeTruthy();
    expect((await events('password_changed'))[0]).toMatchObject({ user: { id: ADMIN } });
    expect((await events('logout'))[0]).toMatchObject({ user: { id: ADMIN } });

    // The password change is in the user's history, without any value.
    const pw = (await changesOf('user', ADMIN)).find((c) => c.field === 'password');
    expect(pw).toMatchObject({ old_value: null, new_value: '(changed)' });
  });

  it('records permission denials', async () => {
    const u = await post('/users', { username: unique('deny'), initial_password: 'Temporary-Password-1' });
    const uid = u.body.data.id as string;
    expect((await get('/roles', uid)).status).toBe(403);
    const denied = await events('permission_denied');
    expect(denied.find((e) => e.user?.id === uid)).toMatchObject({
      module: 'role',
      detail: { permission: 'role.view', method: 'GET', path: '/api/v1/roles' },
    });
  });

  it('records scope denials: an out-of-scope record is 404 to the caller but logged (P4 §4.3)', async () => {
    const standIn: Database = createDatabase(
      { database: { url: url('app', mdb.name), poolSize: 2, allowPublicKeyRetrieval: true } },
      { scopedModels: new ScopeRegistry().register('User', { estate: byColumn('personId') }) },
    );
    try {
      const outside = await mdb.migrator.user.create({
        data: { username: unique('far'), passwordHash: 'x', personId: 999n, createdBy: 1n },
      });
      const ctx = {
        requestId: 'scope-test',
        actorId: ADMIN,
        loadScope: () => Promise.resolve({ ...EMPTY_SCOPE, estates: [101n] }),
      };
      await runWithRequestContext(ctx, async () => {
        expect(await standIn.user.findUnique({ where: { id: outside.id } })).toBeNull();
        expect(await standIn.user.findUnique({ where: { id: 987654321n } })).toBeNull(); // does not exist
        await expect(
          standIn.user.create({
            data: { username: unique('x'), passwordHash: 'x', personId: 5n, createdBy: 1n },
          }),
        ).rejects.toMatchObject({ code: 'SCOPE_DENIED' });
      });
      const logged = await mdb.db.accessLog.findMany({
        where: { eventType: 'scope_denied' },
        orderBy: { id: 'asc' },
      });
      expect(logged.map((l) => (l.detail as { operation: string }).operation)).toEqual([
        'findUnique',
        'create',
      ]);
      expect(logged[0]).toMatchObject({ userId: 1n, module: 'User' });
      expect(logged[0]?.recordReference).toContain(outside.id.toString());
    } finally {
      await standIn.$disconnect();
    }
  });
});

// ---- the /audit API ------------------------------------------------------------------------------------

describe('/audit API', () => {
  it('requires a bounded range, at most 366 days unless one record is named', async () => {
    expect((await get('/audit/changes')).body.error.code).toBe('RANGE_REQUIRED');
    const wide = await get(`/audit/changes?${RANGE}`);
    expect(wide.status).toBe(422);
    expect(wide.body.error.details[0].field).toBe('filter[changed_at]');
    expect((await get(`/audit/changes?${SINCE()}`)).status).toBe(200);
    expect((await get(`/audit/changes?filter[record_type]=user&filter[record_id]=1&${RANGE}`)).status).toBe(
      200,
    );
  });

  it('pages newest first with an opaque cursor', async () => {
    const first = await get(`/audit/changes?${SINCE()}&limit=2`);
    expect(first.body.data).toHaveLength(2);
    const next = first.body.meta.cursor.next_cursor as string;
    expect(next).toBeTruthy();
    const second = await get(`/audit/changes?${SINCE()}&limit=2&cursor=${next}`);
    const ids = [...first.body.data, ...second.body.data].map((r: { id: string }) => BigInt(r.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort((a, b) => (a > b ? -1 : 1))).toEqual(ids);
    expect((await get(`/audit/changes?${SINCE()}&cursor=bm90LWEtY3Vyc29y`)).body.error.details[0].field).toBe(
      'cursor',
    );
  });

  it('needs audit.view', async () => {
    const u = await post('/users', { username: unique('nov'), initial_password: 'Temporary-Password-1' });
    expect((await get(`/audit/changes?${SINCE()}`, u.body.data.id as string)).status).toBe(403);
  });
});

describe('integration log', () => {
  it('records a call by reference only', async () => {
    await logIntegration(mdb.db, {
      integrationKey: 'face_recognition',
      direction: 'outbound',
      outcome: 'failure',
      endpoint: 'https://face.example/api/match',
      statusCode: 503,
      durationMs: 1200,
      errorMessage: 'upstream unavailable',
      related: { type: 'attendance', id: '01J0000000000000000000000A' },
    });
    const row = await mdb.db.integrationLog.findFirstOrThrow({ orderBy: { id: 'desc' } });
    expect(row).toMatchObject({
      integrationKey: 'face_recognition',
      statusCode: 503,
      relatedType: 'attendance',
    });
  });
});
