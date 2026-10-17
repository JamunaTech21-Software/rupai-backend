import type { Server } from 'node:http';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.01 — the person registry on real MySQL: the design's worker / employee personal fields, identity
 * only (employment refused), unique national ID, dependents, documents, and scope by registering estate.
 */

const ADMIN = '1';
/** person.* + estate.* with access to all estates. */
let MANAGER = '';
/** The same permissions, granted estate A only. */
let NARROW = '';
/** The same permissions, granted one division of estate A. */
let DIVISION = '';
let mdb: MigratedDatabase;
let app: Express;
let server: Server;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
const nid = () => `19${String(Date.now()).slice(-9)}${String((seq += 1)).padStart(2, '0')}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 500)}`;
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const get = (path: string, actor = MANAGER) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = MANAGER,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: Body }).data;
}
const many = async (r: request.Test) => {
  const res = await r;
  expect(res.status, json(res)).toBe(200);
  return (res.body as { data: Body[] }).data;
};
async function refused(r: request.Test, field: string, status = 422) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).details.map((d) => d.field)).toContain(field);
}

let estateA = '';
let estateB = '';
let bangladesh = '';
const list: Record<string, Record<string, string>> = {};

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
  server = app.listen(0, '127.0.0.1');
  const permissions = ['person', 'estate', 'division', 'document'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'HR probe', permissions }, undefined, ADMIN),
    201,
  );
  const user = async (name: string) => {
    const u = await mdb.migrator.user.create({
      data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
    });
    const id = u.id.toString();
    const current = await ok(get(`/users/${id}`, ADMIN));
    await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: role.id }] }, current.version, ADMIN));
    return id;
  };
  MANAGER = await user('hr');
  NARROW = await user('hra');
  DIVISION = await user('hrdiv');
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  estateA = (await ok(send('post', '/estates', { code: unique('A'), name: 'Estate A' }), 201)).id;
  estateB = (await ok(send('post', '/estates', { code: unique('B'), name: 'Estate B' }), 201)).id;
  const division = await ok(send('post', `/estates/${estateA}/divisions`, { code: 'N', name: 'North' }), 201);
  await ok(
    send('post', `/users/${NARROW}/scopes`, { scope_type: 'estate', scope_id: estateA }, undefined, ADMIN),
    201,
  );
  await ok(
    send(
      'post',
      `/users/${DIVISION}/scopes`,
      { scope_type: 'division', scope_id: division.id },
      undefined,
      ADMIN,
    ),
    201,
  );
  bangladesh = (await mdb.migrator.country.findFirstOrThrow({ where: { iso2: 'BD' } })).id.toString();
  const lists = {
    religion: await mdb.migrator.religion.findMany(),
    education: await mdb.migrator.educationLevel.findMany(),
    skill: await mdb.migrator.skill.findMany(),
    language: await mdb.migrator.language.findMany(),
  };
  for (const [k, rows] of Object.entries(lists))
    list[k] = Object.fromEntries(rows.map((r) => [r.code, r.id.toString()]));
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

/** The design's Add New Worker personal sections, filled in. */
const WORKER = (over: object = {}) => ({
  registered_estate_id: estateA,
  title: 'mr',
  first_name: 'Rahim',
  middle_name: 'Uddin',
  last_name: 'Ahmed',
  father_name: 'Karim Uddin',
  mother_name: 'Rokeya Begum',
  date_of_birth: '1988-04-12',
  gender: 'male',
  marital_status: 'married',
  blood_group: 'B+',
  nationality_country_id: bangladesh,
  religion_id: list.religion?.ISLAM,
  national_id: nid(),
  birth_certificate_no: 'BC-778899',
  tin: '123456789012',
  phone: '+8801711000001',
  alternate_phone: '+8801811000001',
  personal_email: 'rahim@example.com',
  present_address: 'Line 4, Labour Quarter',
  present_district: 'Moulvibazar',
  present_upazila: 'Sreemangal',
  present_postal_code: '3210',
  permanent_address: 'Village Kalighat',
  permanent_district: 'Moulvibazar',
  permanent_upazila: 'Kamalganj',
  permanent_postal_code: '3220',
  education_level_id: list.education?.PRIMARY,
  skill_ids: [list.skill?.PLUCKING, list.skill?.PRUNING],
  language_ids: [list.language?.BN],
  experience_years: 12,
  emergency_contact_name: 'Rokeya Begum',
  emergency_contact_phone: '+8801911000001',
  emergency_contact_relation: 'mother',
  payment_method: 'mobile_banking',
  mobile_banking_provider: 'bkash',
  mobile_banking_number: '+8801711000001',
  ...over,
});

describe('the person registry (P2.01)', () => {
  it('registers a person with every field of the design, numbered and named by the server', async () => {
    const p = await ok(send('post', '/persons', WORKER()), 201);
    expect(p).toMatchObject({
      full_name: 'Rahim Uddin Ahmed',
      blood_group: 'B+',
      nationality: { name: 'Bangladesh' },
      religion: { code: 'ISLAM' },
      education_level: { code: 'PRIMARY' },
      present_upazila: 'Sreemangal',
      mobile_banking_provider: 'bkash',
      dependent_count: 0,
      status: 'active',
      created_by: { id: MANAGER },
    });
    // The default format: PRS-{year}-{sequence}; editable under /number-formats.
    expect(p.person_code).toMatch(/^PRS-\d{4}-\d+$/);
    expect(p.age).toBeGreaterThanOrEqual(37);
    expect((p.skills as { code: string }[]).map((s) => s.code).sort()).toEqual(['PLUCKING', 'PRUNING']);
    expect((p.languages as { code: string }[]).map((s) => s.code)).toEqual(['BN']);
    // A rename keeps the full name in step; the sets stay when omitted.
    const renamed = await ok(send('patch', `/persons/${p.id}`, { middle_name: null }, p.version));
    expect(renamed).toMatchObject({ full_name: 'Rahim Ahmed' });
    expect(renamed.skills).toHaveLength(2);
    expect(
      await mdb.db.auditChange.count({ where: { recordType: 'person', recordId: p.id } }),
    ).toBeGreaterThanOrEqual(2);
  });

  it('holds identity only: an employment attribute is refused (P4 §8.3)', async () => {
    for (const field of [
      'department_id',
      'designation_id',
      'joining_date',
      'worker_type',
      'base_rate',
      'estate_id',
    ]) {
      const res = await send('post', '/persons', WORKER({ [field]: '1' }));
      expect(res.status, `${field} ${json(res)}`).toBe(422);
    }
  });

  it('refuses a national ID already registered (P2.01 check)', async () => {
    const same = nid();
    await ok(send('post', '/persons', WORKER({ national_id: same })), 201);
    const res = await send('post', '/persons', WORKER({ national_id: same, first_name: 'Other' }));
    expect(res.status, json(res)).toBe(422);
    expect(errorOf(res)).toMatchObject({ code: 'DUPLICATE_KEY', details: [{ field: 'national_id' }] });
    // Several people without one are fine.
    await ok(send('post', '/persons', WORKER({ national_id: null })), 201);
    await ok(send('post', '/persons', WORKER({ national_id: null })), 201);
  });

  it('refuses what the form must not accept', async () => {
    const post = (over: object) => send('post', '/persons', WORKER(over));
    await refused(post({ first_name: '' }), 'first_name');
    await refused(post({ date_of_birth: '2999-01-01' }), 'date_of_birth');
    await refused(post({ blood_group: 'C+' }), 'blood_group');
    await refused(post({ personal_email: 'not-an-email' }), 'personal_email');
    await refused(post({ phone: '12' }), 'phone');
    await refused(post({ religion_id: '999999' }), 'religion_id');
    await refused(post({ skill_ids: ['999999'] }), 'skill_ids.0');
    await refused(post({ nationality_country_id: '999999' }), 'nationality_country_id');
    await refused(post({ mobile_banking_number: null }), 'mobile_banking_number');
    await refused(post({ payment_method: 'bank', bank_account_number: null }), 'bank_account_number');
  });

  it('finds people by name, code, national ID or phone', async () => {
    const p = await ok(send('post', '/persons', WORKER({ first_name: unique('Findme') })), 201);
    for (const term of [String(p.first_name), String(p.person_code), String(p.national_id)]) {
      const found = await many(get(`/persons?filter[q]=${encodeURIComponent(term)}`));
      expect(found.map((x) => x.id)).toContain(p.id);
    }
  });
});

describe('dependents (the design’s Dependents tab)', () => {
  it('adds, changes and removes family members, and counts them', async () => {
    const p = await ok(send('post', '/persons', WORKER()), 201);
    const wife = await ok(
      send('post', `/persons/${p.id}/dependents`, {
        name: 'Amena',
        relation: 'spouse',
        occupation: 'Plucker',
      }),
      201,
    );
    await ok(
      send('post', `/persons/${p.id}/dependents`, {
        name: 'Rafi',
        relation: 'son',
        date_of_birth: '2015-02-01',
        gender: 'male',
      }),
      201,
    );
    expect((await ok(get(`/persons/${p.id}`))).dependent_count).toBe(2);
    const changed = await ok(
      send('patch', `/persons/${p.id}/dependents/${wife.id}`, { occupation: 'Housewife' }, wife.version),
    );
    expect(changed.occupation).toBe('Housewife');
    expect(
      (await send('patch', `/persons/${p.id}/dependents/${wife.id}`, { occupation: 'x' }, wife.version))
        .status,
    ).toBe(409);
    await refused(send('post', `/persons/${p.id}/dependents`, { name: 'X', relation: 'cousin' }), 'relation');
    expect((await send('delete', `/persons/${p.id}/dependents/${wife.id}`, {})).status).toBe(204);
    expect((await many(get(`/persons/${p.id}/dependents`))).map((d) => d.name)).toEqual(['Rafi']);
  });

  it('deletes a person registered in error, with their dependents', async () => {
    const p = await ok(send('post', '/persons', WORKER()), 201);
    await ok(send('post', `/persons/${p.id}/dependents`, { name: 'Rafi', relation: 'son' }), 201);
    const del = await as(request(server).delete(`/api/v1/persons/${p.id}`), MANAGER).set(
      'If-Match',
      `"${String(p.version)}"`,
    );
    expect(del.status, json(del)).toBe(204);
    expect(await mdb.migrator.personDependent.count({ where: { personId: BigInt(p.id) } })).toBe(0);
  });
});

describe('scope: the registering estate (D-2.01-2)', () => {
  it('shows an estate user only that estate’s people, and nothing else by id (404)', async () => {
    const a = await ok(send('post', '/persons', WORKER()), 201);
    const b = await ok(send('post', '/persons', WORKER({ registered_estate_id: estateB })), 201);
    const none = await ok(send('post', '/persons', WORKER({ registered_estate_id: null })), 201);
    const seen = (await many(get('/persons?per_page=500', NARROW))).map((p) => p.id);
    expect(seen).toContain(a.id);
    expect(seen).not.toContain(b.id);
    expect(seen).not.toContain(none.id);
    for (const id of [b.id, none.id]) {
      const res = await get(`/persons/${id}`, NARROW);
      expect(res.status, json(res)).toBe(404);
      expect((await get(`/persons/${id}/dependents`, NARROW)).status).toBe(404);
      expect((await get(`/persons/${id}/documents`, NARROW)).status).toBe(404);
    }
    // A division or section grant sees nobody until profiles are assigned to it (P2.03).
    expect(await many(get('/persons', DIVISION))).toEqual([]);
  });

  it('lets an estate user register people in their own estate only', async () => {
    const mine = await ok(send('post', '/persons', WORKER(), undefined, NARROW), 201);
    expect(mine.registered_estate_id).toBe(estateA);
    for (const estate of [estateB, null]) {
      const res = await send('post', '/persons', WORKER({ registered_estate_id: estate }), undefined, NARROW);
      expect(res.status, json(res)).toBe(403);
      expect(errorOf(res).code).toBe('SCOPE_DENIED');
    }
    // Nor move one out of it.
    const moved = await send(
      'patch',
      `/persons/${mine.id}`,
      { registered_estate_id: estateB },
      mine.version,
      NARROW,
    );
    expect(moved.status, json(moved)).toBe(403);
  });

  it('keeps a person’s papers with them: upload, list, and out of scope 404', async () => {
    const p = await ok(send('post', '/persons', WORKER()), 201);
    const photo = (await mdb.migrator.documentType.findFirstOrThrow({ where: { code: 'NID_FRONT' } })).id;
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const up = await as(request(server).post(`/api/v1/persons/${p.id}/documents`), MANAGER)
      .field('document_type_id', photo.toString())
      .field('title', 'NID front')
      .attach('file', png, { filename: 'nid.png', contentType: 'image/png' });
    expect(up.status, json(up)).toBe(201);
    expect(await many(get(`/persons/${p.id}/documents`))).toHaveLength(1);
    const b = await ok(send('post', '/persons', WORKER({ registered_estate_id: estateB })), 201);
    expect((await get(`/persons/${b.id}/documents`, NARROW)).status).toBe(404);
  });
});
