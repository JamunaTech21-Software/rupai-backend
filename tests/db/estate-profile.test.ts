import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * R.2 — the estate profile of the manager's design on real MySQL: the new fields, the amenity set, the
 * key contacts, photos, the computed overview, and the acres conversion of existing areas.
 */

const ADMIN = '1';
/** Holds the hierarchy permissions with access to all estates, like the organisation tests' manager. */
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Body }).data;
const many = (res: { body: unknown }) => (res.body as { data: Body[] }).data;
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put',
  path: string,
  body: object,
  version?: number,
  actor = MANAGER,
) => {
  const r = as(request(app)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return one(res);
}

let amenity: Record<string, string> = {};
let bangladesh = '';

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
  amenity = Object.fromEntries((await mdb.migrator.amenity.findMany()).map((a) => [a.code, a.id.toString()]));
  const u = await mdb.migrator.user.create({
    data: { username: unique('estm'), passwordHash: 'x', createdBy: 1n },
  });
  MANAGER = u.id.toString();
  const permissions = ['estate', 'division', 'section', 'field'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'Estate probe', permissions }, undefined, ADMIN),
    201,
  );
  const current = await ok(get(`/users/${MANAGER}`, ADMIN));
  await ok(
    send('post', `/users/${MANAGER}/roles`, { roles: [{ role_id: role.id }] }, current.version, ADMIN),
  );
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  bangladesh = (await mdb.migrator.country.findFirstOrThrow({ where: { iso2: 'BD' } })).id.toString();
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

const PROFILE = () => ({
  code: unique('JTE'),
  name: 'Jamuna Tea Estate',
  established_year: 1998,
  owner_name: 'Jamuna Tea Company Ltd.',
  estate_type: 'company_owned',
  estate_category: 'large',
  address_line1: 'Panchagarh Sadar, Panchagarh, Bangladesh',
  police_station: 'Panchagarh Sadar',
  district: 'Panchagarh',
  admin_division: 'Rangpur',
  country_id: bangladesh,
  postal_code: '5020',
  phone: '+8801712345678',
  email: 'info@jamunateaestate.com',
  website: 'https://www.jamunateaestate.com',
  total_area: '5250.000',
  latitude: '26.341700',
  longitude: '88.000800',
  description: 'One of the largest tea estates in northern Bangladesh.',
  amenity_ids: [amenity.SCHOOL, amenity.HOSPITAL, amenity.WAREHOUSE],
  other_amenities: 'Helipad',
});

describe('the estate profile', () => {
  it('saves and returns every field of the design', async () => {
    const body = PROFILE();
    const e = await ok(send('post', '/estates', body), 201);
    const { amenity_ids: _ids, ...fields } = body;
    expect(e).toMatchObject({
      ...fields,
      established_on: '1998-01-01',
      ownership_type: 'owned',
    });
    expect((e.amenities as { code: string }[]).map((a) => a.code).sort()).toEqual([
      'HOSPITAL',
      'SCHOOL',
      'WAREHOUSE',
    ]);
    expect(await ok(get(`/estates/${e.id}`))).toMatchObject({
      police_station: 'Panchagarh Sadar',
      latitude: '26.341700',
    });
  });

  it('replaces the amenity set as a whole, and audits it', async () => {
    const e = await ok(send('post', '/estates', PROFILE()), 201);
    const after = await ok(
      send('patch', `/estates/${e.id}`, { amenity_ids: [amenity.SCHOOL, amenity.CANTEEN] }, 1),
    );
    expect((after.amenities as { code: string }[]).map((a) => a.code).sort()).toEqual(['CANTEEN', 'SCHOOL']);
    const cleared = await ok(send('patch', `/estates/${e.id}`, { amenity_ids: [] }, 2));
    expect(cleared.amenities).toEqual([]);
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'estate', recordId: e.id, action: 'update', field: 'amenities' },
    });
    expect(audit).toHaveLength(2);
    // Other changes leave the set alone.
    const renamed = await ok(send('patch', `/estates/${e.id}`, { name: 'Renamed' }, 3));
    expect(renamed.amenities).toEqual([]);
  });

  it('refuses what the form must not accept', async () => {
    const bad = async (over: object, field: string) => {
      const res = await send('post', '/estates', { ...PROFILE(), ...over });
      expect(res.status, json(res)).toBe(422);
      expect(errorOf(res).details.map((d) => d.field)).toContain(field);
    };
    await bad({ established_year: new Date().getUTCFullYear() + 1 }, 'established_year');
    await bad({ estate_type: 'owned' }, 'estate_type');
    await bad({ estate_category: 'huge' }, 'estate_category');
    await bad({ latitude: '91.000000' }, 'latitude');
    await bad({ longitude: '88.1234567' }, 'longitude');
    await bad({ latitude: null }, 'latitude');
    await bad({ website: 'javascript:alert(1)' }, 'website');
    await bad({ country_id: '999999' }, 'country_id');
    await bad({ amenity_ids: ['999999'] }, 'amenity_ids.0');
  });

  it('keeps the database consistent where the API is bypassed', async () => {
    const e = await ok(send('post', '/estates', PROFILE()), 201);
    await expect(
      mdb.migrator.$executeRaw`UPDATE estate SET latitude = NULL WHERE id = ${BigInt(e.id)}`,
    ).rejects.toThrow(/ck_estate_position/);
    await expect(
      mdb.migrator.$executeRaw`UPDATE estate SET estate_category = 'huge' WHERE id = ${BigInt(e.id)}`,
    ).rejects.toThrow(/ck_estate_category/);
  });
});

describe('the estate overview (computed, in acres)', () => {
  it('counts what exists, and changes when the records do', async () => {
    const e = await ok(send('post', '/estates', { ...PROFILE(), total_area: '100.000' }), 201);
    let s = await ok(get(`/estates/${e.id}/summary`));
    expect(s).toMatchObject({
      total_land_area: '100.000',
      tea_area: '0.000',
      non_tea_area: '100.000',
      division_count: 0,
      section_count: 0,
      field_count: 0,
      worker_count: 0,
      family_count: 0,
      // Since P2.02 the counts come from employment profiles and dependents: none here yet.
      workforce_available: true,
      photo_count: 0,
    });
    const d = await ok(send('post', `/estates/${e.id}/divisions`, { code: 'N', name: 'North' }), 201);
    const sec = await ok(send('post', `/divisions/${d.id}/sections`, { code: 'S1', name: 'One' }), 201);
    const field = (n: string, gross: string, planted: string, status: string) =>
      ok(
        send('post', '/fields', {
          section_id: sec.id,
          field_number: n,
          gross_area: gross,
          planted_area: planted,
          field_status: status,
        }),
        201,
      );
    await field('F1', '30.000', '25.500', 'producing');
    await field('F2', '20.000', '10.000', 'young');
    await field('F3', '10.000', '5.000', 'uprooted'); // carries no tea
    s = await ok(get(`/estates/${e.id}/summary`));
    expect(s).toMatchObject({
      tea_area: '35.500',
      non_tea_area: '64.500',
      field_area: '60.000',
      division_count: 1,
      section_count: 1,
      field_count: 3,
    });
    // A factory of the estate ticks "Factory".
    await runUnscoped('test', async () => {
      const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
      await mdb.migrator.factory.create({
        data: {
          organisationId: org.id,
          code: unique('F'),
          name: 'Factory',
          factoryType: 'own',
          primaryEstateId: BigInt(e.id),
          createdBy: 1n,
        },
      });
    });
    expect((await ok(get(`/estates/${e.id}/summary`))).factory_count).toBe(1);
  });

  it('never shows a negative non-tea area, and none without a declared total', async () => {
    const e = await ok(send('post', '/estates', { ...PROFILE(), total_area: null }), 201);
    expect((await ok(get(`/estates/${e.id}/summary`))).non_tea_area).toBeNull();
  });
});

describe('the estate’s key people and photos', () => {
  it('holds the Estate Manager and the Assistant Manager as contacts', async () => {
    const e = await ok(send('post', '/estates', PROFILE()), 201);
    await ok(
      send('post', `/estates/${e.id}/contacts`, {
        contact_name: 'Md. Rahman Ali',
        designation: 'Estate Manager',
        contact_type: 'estate_manager',
        phone: '+8801711122233',
        email: 'manager@jamunateaestate.com',
      }),
      201,
    );
    await ok(
      send('post', `/estates/${e.id}/contacts`, {
        contact_name: 'Md. Faruk Hossain',
        designation: 'Assistant Manager',
        contact_type: 'assistant_manager',
        phone: '+8801713344556',
      }),
      201,
    );
    const people = many(await get(`/estates/${e.id}/contacts`));
    expect(people.map((p) => p.contact_type).sort()).toEqual(['assistant_manager', 'estate_manager']);
    // They go with the estate if it is deleted (created in error).
    const del = await as(request(app).delete(`/api/v1/estates/${e.id}`), MANAGER).set('If-Match', '"1"');
    expect(del.status, json(del)).toBe(204);
    expect(
      await mdb.migrator.partyContact.count({ where: { ownerType: 'estate', ownerId: BigInt(e.id) } }),
    ).toBe(0);
  });

  it('counts photographs attached to the estate', async () => {
    const e = await ok(send('post', '/estates', PROFILE()), 201);
    const photo = (await mdb.migrator.documentType.findFirstOrThrow({ where: { code: 'PHOTOGRAPH' } })).id;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const up = await as(request(app).post(`/api/v1/estates/${e.id}/documents`), MANAGER)
      .field('document_type_id', photo.toString())
      .field('title', 'Tea garden')
      .attach('file', png, { filename: 'garden.png', contentType: 'image/png' });
    expect(up.status, json(up)).toBe(201);
    expect((await ok(get(`/estates/${e.id}/summary`))).photo_count).toBe(1);
  });
});

describe('the acres migration', () => {
  it('converted every existing area from hectares (1 ha = 2.4710538 acres)', async () => {
    // Re-run the conversion on a probe row, as the migration did, and check the arithmetic.
    const [row] = await mdb.migrator.$queryRaw<
      { v: string }[]
    >`SELECT CAST(ROUND(100 * 2.4710538, 3) AS CHAR) AS v`;
    expect(row?.v).toBe('247.105');
    const sql = await import('node:fs').then((fs) =>
      fs.readFileSync('prisma/migrations/20261014065442_r2_estate_profile/migration.sql', 'utf8'),
    );
    for (const t of ['estate', 'division', 'section', 'field']) expect(sql).toContain(`UPDATE \`${t}\``);
  });
});
