import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { verifyPassword } from '../../src/core/auth/password.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { buildSeeders } from '../../prisma/seed/seeders.js';
import { runSeeders } from '../../src/core/db/seed.js';
import {
  ADMINISTRATOR_PERMISSIONS,
  BUSINESS_DECISION_ACTIONS,
  PERMISSIONS,
} from '../../src/modules/identity/permission-catalogue.js';
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

/**
 * P1.01 — users, roles and the permission catalogue, against a database built from the real migrations
 * and seeders. Acting users are named with the test actor header until real sign-in arrives (P1.02).
 */

const ADMIN = '1';
let mdb: MigratedDatabase;
let app: Express;

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const authz = dbPermissionResolver(mdb.db);
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(testModuleDeps({ config, db: mdb.db, authz })),
    authenticate: testActor(),
  });
});
afterAll(async () => {
  await mdb.drop();
});

// ---- helpers -----------------------------------------------------------------------------------

let seq = 0;
const unique = (prefix: string) => `${prefix}${String(Date.now() % 100000)}${String((seq += 1))}`;

const api = {
  get: (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = ADMIN, version?: number) => {
    const r = as(request(app).post(`/api/v1${path}`), actor).send(body);
    return version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
  },
  patch: (path: string, body: object, version: number | undefined, actor = ADMIN) => {
    const r = as(request(app).patch(`/api/v1${path}`), actor).send(body);
    return version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
  },
  del: (path: string, actor = ADMIN) => as(request(app).delete(`/api/v1${path}`), actor),
};

interface UserBody {
  id: string;
  version: number;
  roles: { code: string }[];
  status: string;
}
interface RoleBody {
  id: string;
  version: number;
  permissions: string[];
}

async function createUser(): Promise<UserBody> {
  const res = await api.post('/users', {
    username: unique('user'),
    initial_password: 'Temporary-Password-1',
  });
  expect(res.status).toBe(201);
  return res.body.data as UserBody;
}

async function createRole(permissions: string[]): Promise<RoleBody> {
  const res = await api.post('/roles', { code: unique('ROLE_'), name: 'Test role', permissions });
  expect(res.status).toBe(201);
  return res.body.data as RoleBody;
}

async function setRoles(
  user: { id: string },
  roles: { role_id: string; expires_at?: string | null }[],
): Promise<UserBody> {
  const current = (await api.get(`/users/${user.id}`)).body.data as UserBody;
  const res = await api.post(`/users/${user.id}/roles`, { roles }, ADMIN, current.version);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as UserBody;
}

async function adminRoleId(): Promise<string> {
  const res = await api.get('/roles?filter[code]=ADMINISTRATOR');
  return (res.body.data as RoleBody[])[0]?.id ?? '';
}

// ---- seed --------------------------------------------------------------------------------------

describe('seed (P3 §31.2, §32.2)', () => {
  it('seeds the whole permission catalogue as system rows', async () => {
    expect(await mdb.db.permission.count()).toBe(PERMISSIONS.length);
  });

  it('seeds only the Administrator role, as a system role holding exactly R-01', async () => {
    const roles = await mdb.db.role.findMany({ include: { permissions: { include: { permission: true } } } });
    expect(roles.map((r) => r.code)).toEqual(['ADMINISTRATOR']);
    const admin = roles[0];
    expect(admin?.isSystem).toBe(true);
    const keys = admin?.permissions.map((p) => `${p.permission.module}.${p.permission.action}`).sort();
    expect(keys).toEqual([...ADMINISTRATOR_PERMISSIONS].sort());
  });

  it('gives the Administrator no business approve, reject or post permission (P6 §5.5)', async () => {
    const res = await api.get(`/users/${ADMIN}/permissions`);
    const actions = (res.body.data.permissions as string[]).map((k) => k.split('.')[1] ?? '');
    expect(actions.filter((a) => BUSINESS_DECISION_ACTIONS.has(a as never))).toEqual([]);
    expect(res.body.data.permissions).not.toContain('payroll.view');
  });

  it('creates the bootstrap administrator: id 1, self-created, must change password, hashed', async () => {
    const u = await mdb.migrator.user.findUniqueOrThrow({ where: { id: 1n }, include: { roles: true } });
    expect(u.createdBy).toBe(1n);
    expect(u.mustChangePassword).toBe(true);
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(u.passwordHash, TEST_BOOTSTRAP_PASSWORD)).toBe(true);
    expect(u.roles).toHaveLength(1);
  });

  it('is idempotent: a second run changes nothing', async () => {
    const results = await runSeeders(mdb.migrator, buildSeeders({}), silentLogger());
    for (const r of Object.values(results)) expect(r).toEqual({ inserted: 0, updated: 0 });
  });
});

describe('database rights (append-only by default)', () => {
  it('the app account cannot alter or delete the permission catalogue', async () => {
    await expect(mdb.db.$executeRaw`UPDATE permission SET description = 'x' WHERE id = 1`).rejects.toThrow(
      /denied/i,
    );
    await expect(mdb.db.$executeRaw`DELETE FROM permission WHERE id = 1`).rejects.toThrow(/denied/i);
  });

  it('a system role can never be inactive, even by direct SQL', async () => {
    await expect(
      mdb.migrator.$executeRaw`UPDATE role SET status = 'inactive' WHERE code = 'ADMINISTRATOR'`,
    ).rejects.toThrow(/ck_role_system_active/);
  });
});

// ---- authorisation -----------------------------------------------------------------------------

describe('authorisation at the API boundary (P4 §4.1)', () => {
  it('401 without an authenticated user', async () => {
    const res = await request(app).get('/api/v1/users');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('403 PERMISSION_DENIED for a user without the permission, before the body is even validated', async () => {
    const u = await createUser();
    const list = await api.get('/users', u.id);
    expect(list.status).toBe(403);
    expect(list.body.error.code).toBe('PERMISSION_DENIED');
    const create = await api.post('/users', { nonsense: true }, u.id);
    expect(create.status).toBe(403);
  });

  it('a new user has no roles and therefore no permissions (P6 §11.1)', async () => {
    const u = await createUser();
    expect(u.roles).toEqual([]);
    const res = await api.get(`/users/${u.id}/permissions`);
    expect(res.body.data.permissions).toEqual([]);
  });
});

// ---- users -------------------------------------------------------------------------------------

describe('users', () => {
  it('creates a user: 201, Location, ETag, must change password, and never returns the password', async () => {
    const username = unique('clerk');
    const res = await api.post('/users', {
      username,
      email: `${username}@example.com`,
      phone: '+8801711000000',
      initial_password: 'Temporary-Password-1',
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`/api/v1/users/${String(res.body.data.id)}`);
    expect(res.headers.etag).toBe('"1"');
    expect(res.body.data).toMatchObject({
      username,
      status: 'active',
      must_change_password: true,
      roles: [],
    });
    expect(res.text).not.toMatch(/password_hash|two_factor_secret|Temporary-Password-1|argon2/);
  });

  it('refuses a duplicate username, case-insensitively, as DUPLICATE_KEY on the field', async () => {
    const res = await api.post('/users', { username: 'ADMIN', initial_password: 'Temporary-Password-1' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('DUPLICATE_KEY');
    expect(res.body.error.details[0].field).toBe('username');
  });

  it('validates the body: password length, unknown fields', async () => {
    const res = await api.post('/users', { username: 'ok_name', initial_password: 'short', extra: 1 });
    expect(res.status).toBe(422);
    const fields = (res.body.error.details as { field?: string }[]).map((d) => d.field);
    expect(fields).toContain('initial_password');
  });

  it('updates with If-Match: missing → 422, stale → 409 with the current version, current → 200', async () => {
    const u = await createUser();
    const missing = await api.patch(`/users/${u.id}`, { phone: '+8801711000001' }, undefined);
    expect(missing.body.error.code).toBe('PRECONDITION_REQUIRED');
    const ok = await api.patch(`/users/${u.id}`, { phone: '+8801711000001' }, 1);
    expect(ok.status).toBe(200);
    expect(ok.body.data.version).toBe(2);
    expect(ok.headers.etag).toBe('"2"');
    const stale = await api.patch(`/users/${u.id}`, { phone: '+8801711000002' }, 1);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details[0].context.version).toBe(2);
  });

  it('404 for a user that does not exist', async () => {
    expect((await api.get('/users/999999')).status).toBe(404);
  });

  it('lists with filters, sorting and pagination', async () => {
    const role = await createRole(['user.view']);
    const u = await createUser();
    await setRoles(u, [{ role_id: role.id }]);
    const byRole = await api.get(`/users?filter[role_id]=${role.id}`);
    expect((byRole.body.data as UserBody[]).map((x) => x.id)).toEqual([u.id]);
    const page = await api.get('/users?per_page=1&sort=-username');
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta.pagination.total).toBeGreaterThan(1);
    const unknown = await api.get('/users?filter[password_hash]=x');
    expect(unknown.body.error.code).toBe('UNKNOWN_FILTER');
  });

  it('deletes only an account created in error; not yourself, not one that is referenced', async () => {
    const u = await createUser();
    expect((await api.del(`/users/${u.id}`)).status).toBe(204);
    expect((await api.del(`/users/${ADMIN}`)).body.error.code).toBe('INVARIANT_VIOLATED');

    // A user who has created something is referenced by it.
    const creator = await createUser();
    const role = await createRole(['role.create', 'role.view']);
    await setRoles(creator, [{ role_id: role.id }]);
    const made = await api.post('/roles', { code: unique('MADE_'), name: 'x' }, creator.id);
    expect(made.status).toBe(201);
    const refused = await api.del(`/users/${creator.id}`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('REFERENCED_RECORD');
  });
});

// ---- roles and the effect of assignment --------------------------------------------------------

describe('roles and assignment', () => {
  it('assigning a role makes its permissions effective; the user can then act', async () => {
    const role = await createRole(['user.view', 'role.view']);
    const u = await createUser();
    expect((await api.get('/users', u.id)).status).toBe(403);
    const updated = await setRoles(u, [{ role_id: role.id }]);
    expect(updated.roles.map((r) => r.code)).toHaveLength(1);
    expect(updated.version).toBe(2);
    const perms = await api.get(`/users/${u.id}/permissions`);
    expect(perms.body.data.permissions).toEqual(['role.view', 'user.view']);
    expect((await api.get('/users', u.id)).status).toBe(200);
  });

  it('refuses unknown permissions, duplicate codes, inactive or missing roles', async () => {
    const bad = await api.post('/roles', {
      code: unique('R_'),
      name: 'x',
      permissions: ['user.view', 'sale.fly'],
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0].field).toBe('permissions.1');

    const dup = await api.post('/roles', { code: 'ADMINISTRATOR', name: 'x' });
    expect(dup.body.error.code).toBe('DUPLICATE_KEY');

    const u = await createUser();
    const missing = await api.post(
      `/users/${u.id}/roles`,
      { roles: [{ role_id: '999999' }] },
      ADMIN,
      u.version,
    );
    expect(missing.status).toBe(422);
    expect(missing.body.error.details[0].field).toBe('roles.0.role_id');
  });

  it('deactivating a role removes its permissions from every holder IMMEDIATELY', async () => {
    const role = await createRole(['user.view']);
    const u = await createUser();
    await setRoles(u, [{ role_id: role.id }]);
    expect((await api.get('/users', u.id)).status).toBe(200);

    const off = await api.post(`/roles/${role.id}/deactivate`, {}, ADMIN, role.version);
    expect(off.status).toBe(200);
    expect((await api.get('/users', u.id)).status).toBe(403);

    const on = await api.post(`/roles/${role.id}/reactivate`, {}, ADMIN, off.body.data.version as number);
    expect(on.status).toBe(200);
    expect((await api.get('/users', u.id)).status).toBe(200);
  });

  it('a role held by a user cannot be deleted; once released it can', async () => {
    const role = await createRole(['user.view']);
    const u = await createUser();
    await setRoles(u, [{ role_id: role.id }]);
    const refused = await api.del(`/roles/${role.id}`);
    expect(refused.body.error.code).toBe('REFERENCED_RECORD');
    await setRoles(u, []);
    expect((await api.del(`/roles/${role.id}`)).status).toBe(204);
  });

  it('a temporary grant lapses by itself, and an expiry in the past is refused', async () => {
    const role = await createRole(['user.view']);
    const u = await createUser();
    const current = (await api.get(`/users/${u.id}`)).body.data as UserBody;
    const past = await api.post(
      `/users/${u.id}/roles`,
      { roles: [{ role_id: role.id, expires_at: '2020-01-01T00:00:00Z' }] },
      ADMIN,
      current.version,
    );
    expect(past.body.error.details[0].field).toBe('roles.0.expires_at');

    await setRoles(u, [{ role_id: role.id, expires_at: '2099-01-01T00:00:00Z' }]);
    expect((await api.get('/users', u.id)).status).toBe(200);
    // Time passes: the grant's expiry is now behind us.
    await mdb.migrator.$executeRaw`
      UPDATE user_role SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 MINUTE WHERE user_id = ${BigInt(u.id)}`;
    expect((await api.get('/users', u.id)).status).toBe(403);
  });
});

describe('the Administrator role and the last administrator', () => {
  it('cannot be deleted, deactivated, re-coded or re-permissioned, but can be renamed', async () => {
    const id = await adminRoleId();
    const role = (await api.get(`/roles/${id}`)).body.data as RoleBody & { name: string };
    expect((await api.del(`/roles/${id}`)).body.error.code).toBe('SYSTEM_RECORD');
    expect((await api.post(`/roles/${id}/deactivate`, {}, ADMIN, role.version)).body.error.code).toBe(
      'SYSTEM_RECORD',
    );
    const grant = await api.patch(
      `/roles/${id}`,
      { permissions: [...role.permissions, 'sale.approve'] },
      role.version,
    );
    expect(grant.body.error.code).toBe('SYSTEM_RECORD');
    expect((await api.patch(`/roles/${id}`, { code: 'ROOT' }, role.version)).body.error.code).toBe(
      'SYSTEM_RECORD',
    );

    const renamed = await api.patch(`/roles/${id}`, { name: 'Platform Administrator' }, role.version);
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.permissions).toEqual(role.permissions);
  });

  it('refuses to disable or strip the last administrator; allows it once another exists', async () => {
    const admin = (await api.get(`/users/${ADMIN}`)).body.data as UserBody;
    const disable = await api.post(`/users/${ADMIN}/deactivate`, {}, ADMIN, admin.version);
    expect(disable.status).toBe(422);
    expect(disable.body.error.code).toBe('LAST_ADMINISTRATOR');
    const strip = await api.post(`/users/${ADMIN}/roles`, { roles: [] }, ADMIN, admin.version);
    expect(strip.body.error.code).toBe('LAST_ADMINISTRATOR');

    // A lapsing grant does not count as a second administrator.
    const deputy = await createUser();
    const adminRole = await adminRoleId();
    await setRoles(deputy, [{ role_id: adminRole, expires_at: '2099-01-01T00:00:00Z' }]);
    expect(
      (await api.post(`/users/${ADMIN}/roles`, { roles: [] }, ADMIN, admin.version)).body.error.code,
    ).toBe('LAST_ADMINISTRATOR');

    // A permanent one does: now user 1 may be stripped, and is restored afterwards by the deputy.
    await setRoles(deputy, [{ role_id: adminRole }]);
    const stripped = await api.post(`/users/${ADMIN}/roles`, { roles: [] }, ADMIN, admin.version);
    expect(stripped.status).toBe(200);
    const back = await api.post(
      `/users/${ADMIN}/roles`,
      { roles: [{ role_id: adminRole }] },
      deputy.id,
      stripped.body.data.version as number,
    );
    expect(back.status).toBe(200);
  });

  it('a disabled user is refused immediately, and re-enabling restores access', async () => {
    const role = await createRole(['user.view']);
    const u = await setRoles(await createUser(), [{ role_id: role.id }]);
    expect((await api.get('/users', u.id)).status).toBe(200);
    const off = await api.post(`/users/${u.id}/deactivate`, {}, ADMIN, u.version);
    expect(off.body.data.status).toBe('disabled');
    expect((await api.get('/users', u.id)).status).toBe(403);
    expect((await api.get(`/users/${u.id}/permissions`)).body.data.permissions).toEqual([]);
    // Roles are kept on a disabled account (P6 §11.1).
    expect(off.body.data.roles).toHaveLength(1);
    const on = await api.post(`/users/${u.id}/reactivate`, {}, ADMIN, off.body.data.version as number);
    expect(on.body.data.status).toBe('active');
    expect((await api.get('/users', u.id)).status).toBe(200);
  });

  it('a retried deactivation with the same Idempotency-Key is replayed, not repeated', async () => {
    const u = await createUser();
    const send = () =>
      api.post(`/users/${u.id}/deactivate`, {}, ADMIN, u.version).set('Idempotency-Key', `deact-${u.id}`);
    const first = await send();
    const retry = await send();
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.data).toEqual(first.body.data);
  });
});

// ---- permissions -------------------------------------------------------------------------------

describe('GET /permissions', () => {
  it('pages the full catalogue (per_page clamped to 200)', async () => {
    const res = await api.get('/permissions?per_page=500');
    expect(res.body.meta.pagination.total).toBe(PERMISSIONS.length);
    expect(res.body.data).toHaveLength(200);
  });

  it('filters by module and action, with group, class and sensitivity', async () => {
    const res = await api.get('/permissions?filter[module]=user');
    expect((res.body.data as { key: string }[]).map((p) => p.key)).toEqual([
      'user.create',
      'user.delete',
      'user.edit',
      'user.export',
      'user.print',
      'user.view',
    ]);
    expect(res.body.data[2]).toMatchObject({ group: 'Platform', module_class: 'master', sensitive: true });
    const approvals = await api.get('/permissions?filter[action]=approve&per_page=200');
    expect((approvals.body.data as { action: string }[]).every((p) => p.action === 'approve')).toBe(true);
  });

  it('requires role.view', async () => {
    const u = await createUser();
    expect((await api.get('/permissions', u.id)).status).toBe(403);
  });
});
