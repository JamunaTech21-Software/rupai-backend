import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoSeeders } from '../../prisma/seed/demo-seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/** P1.08 — factory, warehouse, party, party_contact, through the HTTP API on real MySQL. */

const ADMIN = '1';
/** Holds the facility and party permissions with all_estates (the Administrator holds none, P6 §7.1). */
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

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
const one = (res: { body: unknown }) => (res.body as { data: Node }).data;
const many = (res: { body: unknown }) => (res.body as { data: Node[] }).data;
const ids = (res: { body: unknown }) => many(res).map((x) => x.id);
const created = async (r: request.Test): Promise<Node> => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return one(res);
};
const factory = (over: object = {}) =>
  created(api.post('/factories', { code: unique('F'), name: 'Factory', factory_type: 'own', ...over }));
const warehouse = (over: object = {}) =>
  created(api.post('/warehouses', { code: unique('W'), name: 'Warehouse', warehouse_type: 'own', ...over }));
const party = (over: object = {}) =>
  created(api.post('/parties', { code: unique('P'), name: 'Party', party_type: 'individual', ...over }));
const contact = (owner: string, over: object = {}) =>
  created(
    api.post(`${owner}/contacts`, {
      contact_name: 'Someone',
      contact_type: 'operations',
      phone: '+8801711999000',
      ...over,
    }),
  );

async function actorWith(permissions: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const role = await created(
    api.post('/roles', { code: unique('R_'), name: 'Facility probe', permissions }, ADMIN),
  );
  const current = await api.get(`/users/${id}`, ADMIN);
  const set = await api.post(
    `/users/${id}/roles`,
    { roles: [{ role_id: role.id }] },
    ADMIN,
    one(current).version,
  );
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  for (const g of grants) {
    const res = await api.post(`/users/${id}/scopes`, g, ADMIN);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
  return id;
}
const ALL = ['factory', 'warehouse', 'land', 'estate'].flatMap((m) =>
  ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
);

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

describe('factories (P3 §4.6)', () => {
  it('creates, edits with If-Match, lists with filters, deactivates with history', async () => {
    const estate = await created(api.post('/estates', { code: unique('E'), name: 'Estate' }));
    const f = await factory({
      factory_type: 'external',
      primary_estate_id: estate.id,
      daily_capacity_kg: '45000.000',
      licence_expiry: '2026-12-31',
    });
    expect(f).toMatchObject({
      primary_estate_id: estate.id,
      daily_capacity_kg: '45000.000',
      licence_expiry: '2026-12-31',
      status: 'active',
    });
    expect(
      (await api.post('/factories', { code: f.code as string, name: 'x', factory_type: 'own' })).body.error,
    ).toMatchObject({
      code: 'DUPLICATE_KEY',
      details: [{ field: 'code' }],
    });
    expect(
      (
        await api.post('/factories', {
          code: unique('F'),
          name: 'x',
          factory_type: 'own',
          primary_estate_id: '999999',
        })
      ).body.error.details[0],
    ).toMatchObject({
      field: 'primary_estate_id',
      message: 'No such estate.',
    });
    expect((await api.patch(`/factories/${f.id}`, { name: 'Renamed' }, 9)).status).toBe(409);
    const edited = await api.patch(
      `/factories/${f.id}`,
      { name: 'Renamed', licence_expiry: '2027-06-30' },
      1,
    );
    expect(one(edited)).toMatchObject({ name: 'Renamed', licence_expiry: '2027-06-30', version: 2 });

    const expiring = await api.get(
      `/factories?filter[licence_expiry][to]=2027-12-31&filter[factory_type]=external&per_page=100`,
    );
    expect(ids(expiring)).toContain(f.id);
    expect(ids(await api.get('/factories?filter[licence_expiry][to]=2027-01-01&per_page=100'))).not.toContain(
      f.id,
    );

    expect(one(await api.post(`/factories/${f.id}/deactivate`, {}, MANAGER, 2))).toMatchObject({
      status: 'inactive',
    });
    const history = await mdb.db.statusHistory.findMany({
      where: { recordType: 'factory', recordId: f.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toState)).toEqual(['active', 'inactive']);
  });

  it('deletes only what no scope grant names', async () => {
    const f = await factory();
    await actorWith(['factory.view'], [{ scope_type: 'factory', scope_id: f.id }]);
    const refused = await api.del(`/factories/${f.id}`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({
      code: 'REFERENCED_RECORD',
      details: [{ context: { by: 'user scope grants' } }],
    });
    const free = await factory();
    expect((await api.del(`/factories/${free.id}`)).status).toBe(204);
  });
});

describe('warehouses and their contacts (P3 §4.7, §6.2)', () => {
  it('the first contact is primary and its phone is the warehouse phone; phone is not editable directly', async () => {
    const w = await warehouse({ warehouse_type: 'rented', capacity_kg: '250000.000' });
    expect(w.phone).toBeNull();
    expect((await api.patch(`/warehouses/${w.id}`, { phone: '+8801000000000' }, 1)).status).toBe(422);
    const first = await contact(`/warehouses/${w.id}`, { contact_name: 'Karim', phone: '+8801711000001' });
    expect(first.is_primary).toBe(true);
    const second = await contact(`/warehouses/${w.id}`, {
      contact_name: 'Accounts',
      contact_type: 'accounts',
      phone: '+8801711000002',
    });
    expect(second.is_primary).toBe(false);
    const after = one(await api.get(`/warehouses/${w.id}`));
    expect(after).toMatchObject({ phone: '+8801711000001', version: 1 }); // a derived copy: no version bump
    const list = ids(await api.get(`/warehouses/${w.id}/contacts`));
    expect(list).toEqual([first.id, second.id]); // primary first
  });

  it('make-primary moves the flag atomically and refreshes the cache; the database allows one primary only', async () => {
    const w = await warehouse();
    const a = await contact(`/warehouses/${w.id}`, { phone: '+8801711000011' });
    const b = await contact(`/warehouses/${w.id}`, { phone: '+8801711000012' });
    const res = await api.post(`/warehouses/${w.id}/contacts/${b.id}/make-primary`, {}, MANAGER, b.version);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(one(res)).toMatchObject({ is_primary: true });
    expect(one(await api.get(`/warehouses/${w.id}/contacts/${a.id}`))).toMatchObject({ is_primary: false });
    expect(one(await api.get(`/warehouses/${w.id}`))).toMatchObject({ phone: '+8801711000012' });
    // Editing the primary contact's phone follows through; removing it clears the cache.
    const bNow = one(await api.get(`/warehouses/${w.id}/contacts/${b.id}`));
    expect(
      (await api.patch(`/warehouses/${w.id}/contacts/${b.id}`, { phone: '+8801711000099' }, bNow.version))
        .status,
    ).toBe(200);
    expect(one(await api.get(`/warehouses/${w.id}`))).toMatchObject({ phone: '+8801711000099' });
    await expect(
      mdb.migrator.$executeRawUnsafe(`UPDATE party_contact SET is_primary = 1 WHERE id = ${a.id}`),
    ).rejects.toThrow(/ux_party_contact_primary/);
    expect((await api.del(`/warehouses/${w.id}/contacts/${b.id}`)).status).toBe(204);
    expect(one(await api.get(`/warehouses/${w.id}`))).toMatchObject({ phone: null });
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'party_contact', recordId: a.id, field: 'is_primary' },
    });
    expect(audit.map((x) => [x.oldValue, x.newValue])).toEqual([['true', 'false']]);
  });

  it('a new contact may take over as primary; contacts of another owner are not reachable', async () => {
    const w = await warehouse();
    const other = await warehouse();
    const a = await contact(`/warehouses/${w.id}`);
    const b = await contact(`/warehouses/${w.id}`, { is_primary: true, phone: '+8801711000021' });
    expect(b.is_primary).toBe(true);
    expect(one(await api.get(`/warehouses/${w.id}/contacts/${a.id}`))).toMatchObject({ is_primary: false });
    expect((await api.get(`/warehouses/${other.id}/contacts/${a.id}`)).status).toBe(404);
    expect((await api.get('/warehouses/999999/contacts')).status).toBe(404);
  });

  it('deleting a warehouse removes its contacts, audited', async () => {
    const w = await warehouse();
    const c = await contact(`/warehouses/${w.id}`);
    expect((await api.del(`/warehouses/${w.id}`)).status).toBe(204);
    expect(await mdb.db.partyContact.count({ where: { id: BigInt(c.id) } })).toBe(0);
    expect(
      await mdb.db.auditChange.count({
        where: { recordType: 'party_contact', recordId: c.id, action: 'delete' },
      }),
    ).toBe(1);
  });

  it('the database refuses an owner type P3 does not list', async () => {
    await expect(
      mdb.migrator.$executeRawUnsafe(
        "INSERT INTO party_contact (owner_type, owner_id, contact_name, contact_type, created_by) VALUES ('factory', 1, 'x', 'other', 1)",
      ),
    ).rejects.toThrow(/ck_party_contact_owner_type/);
  });
});

describe('parties (P3 §6.1)', () => {
  it('CRUD, contacts, and the national id never reaches the audit log', async () => {
    const p = await party({ national_id: '1990123456789', district: 'Sylhet' });
    expect(p).toMatchObject({ national_id: '1990123456789', party_type: 'individual' });
    expect(
      (await api.post('/parties', { code: p.code as string, name: 'x', party_type: 'government' })).status,
    ).toBe(422);
    const created = await mdb.db.auditChange.findFirstOrThrow({
      where: { recordType: 'party', recordId: p.id, action: 'create' },
    });
    expect(created.newValue).not.toContain('1990123456789');
    expect(JSON.parse(created.newValue ?? '{}')).toMatchObject({ has_national_id: true });
    expect((await api.patch(`/parties/${p.id}`, { national_id: '2000999999999' }, 1)).status).toBe(200);
    const changes = await mdb.db.auditChange.findMany({
      where: { recordType: 'party', recordId: p.id, action: 'update' },
    });
    expect(changes.map((c) => `${c.oldValue ?? ''}${c.newValue ?? ''}`).join()).not.toContain(
      '2000999999999',
    );
    const c = await contact(`/parties/${p.id}`);
    expect(c).toMatchObject({ owner_type: 'party', owner_id: p.id, is_primary: true });
    expect(one(await api.get(`/parties/${p.id}`))).toMatchObject({ phone: null }); // party.phone is its own, not a cache
  });
});

describe('facility scope (P1 §4.4, P6 §4.2): a facility-scoped user sees only granted facilities', () => {
  it('a factory grant reaches that factory only, and no warehouse', async () => {
    const mine = await factory();
    const theirs = await factory();
    await warehouse();
    const user = await actorWith(
      ['factory.view', 'factory.edit', 'factory.create', 'warehouse.view'],
      [{ scope_type: 'factory', scope_id: mine.id }],
    );
    const list = await api.get('/factories?per_page=100', user);
    expect(ids(list)).toEqual([mine.id]);
    expect((list.body as { meta: { applied_scope: object } }).meta.applied_scope).toMatchObject({
      factories: [mine.id],
      warehouses: [],
    });
    expect((await api.get(`/factories/${theirs.id}`, user)).status).toBe(404);
    expect(ids(await api.get('/warehouses?per_page=100', user))).toEqual([]);
    expect((await api.patch(`/factories/${mine.id}`, { name: 'Ours' }, 1, user)).status).toBe(200);
    expect((await api.patch(`/factories/${theirs.id}`, { name: 'No' }, 1, user)).status).toBe(404);
    expect(
      (await api.post('/factories', { code: unique('F'), name: 'New', factory_type: 'own' }, user)).status,
    ).toBe(403);
    const denial = await mdb.db.accessLog.findFirst({
      where: { eventType: 'scope_denied', userId: BigInt(user), module: 'Factory' },
    });
    expect(denial).not.toBeNull();
  });

  it('an estate grant is no way into the facility masters, even where the factory names that estate', async () => {
    const estate = await created(api.post('/estates', { code: unique('E'), name: 'Estate' }));
    const f = await factory({ primary_estate_id: estate.id });
    const user = await actorWith(['factory.view'], [{ scope_type: 'estate', scope_id: estate.id }]);
    expect(ids(await api.get('/factories?per_page=100', user))).toEqual([]);
    expect((await api.get(`/factories/${f.id}`, user)).status).toBe(404);
  });

  it('a warehouse grant reaches that warehouse and its contacts only', async () => {
    const mine = await warehouse();
    const theirs = await warehouse();
    const c = await contact(`/warehouses/${theirs.id}`);
    const user = await actorWith(
      ['warehouse.view', 'warehouse.edit'],
      [{ scope_type: 'warehouse', scope_id: mine.id }],
    );
    await expect(
      created(
        api.post(`/warehouses/${mine.id}/contacts`, { contact_name: 'Ok', contact_type: 'other' }, user),
      ),
    ).resolves.toMatchObject({
      is_primary: true,
    });
    expect((await api.get(`/warehouses/${theirs.id}/contacts`, user)).status).toBe(404);
    expect((await api.get(`/warehouses/${theirs.id}/contacts/${c.id}`, user)).status).toBe(404);
    expect(
      (
        await api.post(
          `/warehouses/${theirs.id}/contacts`,
          { contact_name: 'No', contact_type: 'other' },
          user,
        )
      ).status,
    ).toBe(404);
  });

  it('a facility grant must name a real factory or warehouse; the old single "facility" type is gone', async () => {
    const user = await actorWith(['factory.view'], []);
    const bad = await api.post(`/users/${user}/scopes`, { scope_type: 'factory', scope_id: '987654' }, ADMIN);
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({ field: 'scope_id', message: 'No such factory.' });
    expect(
      (await api.post(`/users/${user}/scopes`, { scope_type: 'facility', scope_id: '1' }, ADMIN)).status,
    ).toBe(422);
  });
});

describe('demo data for the manager check (P1.08)', () => {
  it('is idempotent; the viewer sees DEMO-F1 and DEMO-W1 only', async () => {
    const seeders = demoSeeders('Demo-password-123');
    await runSeeders(mdb.migrator, seeders, silentLogger());
    const count = () =>
      runUnscoped('test', () => mdb.db.partyContact.count({ where: { ownerType: 'warehouse' } }));
    const before = await count();
    await runSeeders(mdb.migrator, seeders, silentLogger());
    expect(await count()).toBe(before);

    const id = async (username: string) =>
      (await mdb.db.user.findUniqueOrThrow({ where: { username }, select: { id: true } })).id.toString();
    const viewer = await id('viewer');
    const manager = await id('manager');
    const codes = async (path: string, actor: string) =>
      many(await api.get(`${path}?per_page=100&filter[code][like]=DEMO-`, actor)).map((x) => x.code);
    expect(await codes('/factories', manager)).toEqual(['DEMO-F1', 'DEMO-F2']);
    expect(await codes('/factories', viewer)).toEqual(['DEMO-F1']);
    expect(await codes('/warehouses', viewer)).toEqual(['DEMO-W1']);
    const w1 = many(await api.get('/warehouses?filter[code]=DEMO-W1', viewer))[0];
    expect(w1).toMatchObject({ phone: '+8801711000001' });
    expect(many(await api.get(`/warehouses/${w1?.id ?? ''}/contacts`, viewer))).toHaveLength(2);
    expect(await codes('/parties', viewer)).toEqual(['DEMO-P1']);
  });
});
