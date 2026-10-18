import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.02 — employment profiles on real MySQL: opening worker and employee profiles (the design's
 * employment sections), one active per type, separation and suspension, scope and self scope, the
 * workforce figures, and the Phase 1 links made real (estate managers, worker and family counts).
 */

const ADMIN = '1';
/** person.*, employment.* (with approve), estate.*, division.*, section.*, user.edit; all estates. */
let MANAGER = '';
/** The same without employment.approve and user.edit, estate A only. */
let NARROW = '';
let mdb: MigratedDatabase;
let server: Server;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

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

let estateA = { id: '', code: '' };
let estateB = { id: '', code: '' };
let skilled = '';
let officer = '';
let grade = '';
const today = todayIn(loadConfig({ ...TEST_ENV }).timezone);

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string, sensitive: string[] = []) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(
    send(
      'post',
      `/users/${id}/roles`,
      {
        roles: [{ role_id: roleId }],
        ...(sensitive.length
          ? { authorisations: sensitive.map((key) => ({ key, reason: 'P2.02 tests' })) }
          : {}),
      },
      current.version,
      ADMIN,
    ),
  );
  return id;
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
  const app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  server = app.listen(0, '127.0.0.1');
  const basic = ['person', 'employment', 'estate', 'division', 'section'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  const full = await role([...basic, 'employment.approve', 'user.view', 'user.edit']);
  const narrow = await role(basic);
  MANAGER = await user('hrm', full.id, ['SENSITIVE:user.edit', 'SOD-1:employment.approve+employment.create']);
  NARROW = await user('hrn', narrow.id);
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  const estate = async (p: string) => {
    const code = unique(p);
    const e = await ok(send('post', '/estates', { code, name: `Estate ${p}` }), 201);
    return { id: e.id, code };
  };
  estateA = await estate('A');
  estateB = await estate('B');
  await ok(
    send('post', `/users/${NARROW}/scopes`, { scope_type: 'estate', scope_id: estateA.id }, undefined, ADMIN),
    201,
  );
  skilled = (
    await mdb.migrator.workerCategory.create({
      data: { code: unique('SK'), name: 'Skilled worker', createdBy: 1n },
    })
  ).id.toString();
  officer = (
    await mdb.migrator.employeeCategory.create({
      data: { code: unique('OF'), name: 'Officer', createdBy: 1n },
    })
  ).id.toString();
  grade = (await mdb.migrator.jobGrade.findFirstOrThrow({ where: { code: 'GRADE_2' } })).id.toString();
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

const person = async (over: object = {}) =>
  ok(
    send('post', '/persons', {
      first_name: unique('Worker'),
      registered_estate_id: estateA.id,
      gender: 'female',
      date_of_birth: '1990-05-20',
      ...over,
    }),
    201,
  );
const WORKER = (personId: string, over: object = {}) => ({
  person_id: personId,
  estate_id: estateA.id,
  employment_type: 'worker',
  category_id: skilled,
  engagement_type: 'permanent',
  employment_basis: 'full_time',
  job_nature: 'field',
  working_location: 'field',
  joining_date: '2015-03-01',
  ...over,
});

describe('employment profiles (P2.02)', () => {
  it('opens a worker profile with the design’s employment fields, numbered per estate', async () => {
    const p = await person({ father_name: 'Karim' });
    const w = await ok(
      send('post', '/employment-profiles', WORKER(p.id, { probation_end_date: '2999-01-01' })),
      201,
    );
    expect(w).toMatchObject({
      employment_type: 'worker',
      category: { name: 'Skilled worker' },
      engagement_type: 'permanent',
      job_nature: 'field',
      working_location: 'field',
      on_probation: true,
      status: 'active',
      person: { id: p.id, father_name: 'Karim', gender: 'female', photo_document_id: null },
      estate: { code: estateA.code },
    });
    expect(w.profile_number).toMatch(new RegExp(`^WRK-${estateA.code}-`));
    expect(w.service_years).toBeGreaterThanOrEqual(10);
    const listed = await many(
      get(
        `/employment-profiles?filter[employment_type]=worker&filter[q]=${encodeURIComponent(String(w.profile_number))}`,
      ),
    );
    expect(listed.map((x) => x.id)).toEqual([w.id]);
  });

  it('allows one active profile per type: a second worker profile is refused, an employee one is not', async () => {
    const p = await person();
    await ok(send('post', '/employment-profiles', WORKER(p.id)), 201);
    await refused(
      send('post', '/employment-profiles', WORKER(p.id, { profile_number: unique('W') })),
      'person_id',
    );
    const e = await ok(
      send(
        'post',
        '/employment-profiles',
        WORKER(p.id, {
          employment_type: 'employee',
          category_id: officer,
          job_grade_id: grade,
          work_email: 'x@estate.com',
        }),
      ),
      201,
    );
    expect(e).toMatchObject({ employment_type: 'employee', job_grade: { code: 'GRADE_2' } });
    expect(e.profile_number).toMatch(/^EMP-/);
  });

  it('refuses what the form must not accept', async () => {
    const p = await person();
    const post = (over: object) => send('post', '/employment-profiles', WORKER(p.id, over));
    await refused(post({ category_id: '999999' }), 'category_id'); // no such worker category
    await refused(post({ confirmation_date: '2010-01-01' }), 'confirmation_date'); // before joining
    await refused(post({ engagement_type: 'freelance' }), 'engagement_type');
    await refused(post({ person_id: '999999' }), 'person_id');
    await refused(post({ supervisor_profile_id: '999999' }), 'supervisor_profile_id');
    const taken = await ok(post({ profile_number: unique('W') }), 201);
    const other = await person();
    await refused(
      send('post', '/employment-profiles', WORKER(other.id, { profile_number: taken.profile_number })),
      'profile_number',
    );
  });

  it('separates with employment.approve only, and a separated profile is final', async () => {
    const p = await person();
    const w = await ok(send('post', '/employment-profiles', WORKER(p.id)), 201);
    const body = { separation_date: today, separation_type: 'resignation', reason: 'Moved to the city' };
    expect(
      (await send('post', `/employment-profiles/${w.id}/separate`, body, w.version, NARROW)).status,
    ).toBe(403);
    await refused(
      send(
        'post',
        `/employment-profiles/${w.id}/separate`,
        { ...body, separation_date: '2999-01-01' },
        w.version,
      ),
      'separation_date',
    );
    await refused(
      send(
        'post',
        `/employment-profiles/${w.id}/separate`,
        { ...body, separation_date: '2000-01-01' },
        w.version,
      ),
      'separation_date',
    );
    const s = await ok(send('post', `/employment-profiles/${w.id}/separate`, body, w.version));
    expect(s).toMatchObject({ status: 'separated', separation_type: 'resignation', on_probation: false });
    expect((await send('patch', `/employment-profiles/${w.id}`, { remarks: 'x' }, s.version)).status).toBe(
      409,
    );
    // The person may be engaged again: a new profile.
    await ok(send('post', '/employment-profiles', WORKER(p.id, { joining_date: today })), 201);
    const history = await mdb.db.statusHistory.findMany({
      where: { recordType: 'employment_profile', recordId: w.id },
    });
    expect(history.map((h) => h.toState)).toEqual(['active', 'separated']);
  });

  it('suspends and reinstates with a reason', async () => {
    const p = await person();
    const w = await ok(send('post', '/employment-profiles', WORKER(p.id)), 201);
    const s = await ok(
      send('post', `/employment-profiles/${w.id}/suspend`, { reason: 'Inquiry' }, w.version),
    );
    expect(s.status).toBe('suspended');
    expect(
      (await send('post', `/employment-profiles/${w.id}/suspend`, { reason: 'Again' }, s.version)).status,
    ).toBe(409);
    expect(
      (await ok(send('post', `/employment-profiles/${w.id}/reinstate`, { reason: 'Cleared' }, s.version)))
        .status,
    ).toBe('active');
  });
});

describe('scope and self (D-2.02-3)', () => {
  it('shows an estate user only that estate’s profiles; others are 404; opening elsewhere is refused', async () => {
    const pa = await person();
    const pb = await person({ registered_estate_id: estateB.id });
    const a = await ok(send('post', '/employment-profiles', WORKER(pa.id)), 201);
    const b = await ok(send('post', '/employment-profiles', WORKER(pb.id, { estate_id: estateB.id })), 201);
    const seen = (await many(get('/employment-profiles?per_page=500', NARROW))).map((p) => p.id);
    expect(seen).toContain(a.id);
    expect(seen).not.toContain(b.id);
    expect((await get(`/employment-profiles/${b.id}`, NARROW)).status).toBe(404);
    const res = await send(
      'post',
      '/employment-profiles',
      WORKER(pa.id, { estate_id: estateB.id, employment_type: 'employee', category_id: null }),
      undefined,
      NARROW,
    );
    expect([403, 422]).toContain(res.status);
  });

  it('makes a person employed at the estate visible and editable there, wherever registered', async () => {
    const p = await person({ registered_estate_id: estateB.id });
    expect((await get(`/persons/${p.id}`, NARROW)).status).toBe(404);
    await ok(send('post', '/employment-profiles', WORKER(p.id)), 201);
    const seen = await ok(get(`/persons/${p.id}`, NARROW));
    await ok(send('patch', `/persons/${p.id}`, { phone: '+8801711999999' }, seen.version, NARROW));
    expect(await many(get(`/persons/${p.id}/employment-profiles`, NARROW))).toHaveLength(1);
  });

  it('lets a linked user see their own profile with no grant at all (self scope)', async () => {
    const p = await person();
    const w = await ok(send('post', '/employment-profiles', WORKER(p.id)), 201);
    const viewOnly = await role(['employment.view', 'person.view']);
    const self = await user('self', viewOnly.id);
    expect((await get(`/employment-profiles/${w.id}`, self)).status).toBe(404);
    expect(
      (await send('post', `/employment-profiles/${w.id}/link-user`, { user_id: self }, w.version, NARROW))
        .status,
    ).toBe(403);
    const linked = await ok(
      send('post', `/employment-profiles/${w.id}/link-user`, { user_id: self }, w.version),
    );
    expect(linked.user).toMatchObject({ id: self });
    expect((await many(get('/employment-profiles', self))).map((x) => x.id)).toEqual([w.id]);
    expect((await get(`/persons/${p.id}`, self)).status).toBe(200);
  });
});

describe('the workforce figures and the Phase 1 links', () => {
  it('counts the estate’s workers and their families, and names a manager employed there', async () => {
    const e = await ok(send('post', '/estates', { code: unique('C'), name: 'Estate C' }), 201);
    const before = await ok(get(`/estates/${e.id}/summary`));
    expect(before).toMatchObject({ worker_count: 0, family_count: 0, workforce_available: true });
    const p = await person({ registered_estate_id: e.id });
    await ok(send('post', `/persons/${p.id}/dependents`, { name: 'Son', relation: 'son' }), 201);
    await ok(send('post', `/persons/${p.id}/dependents`, { name: 'Wife', relation: 'spouse' }), 201);
    const w = await ok(send('post', '/employment-profiles', WORKER(p.id, { estate_id: e.id })), 201);
    expect(await ok(get(`/estates/${e.id}/summary`))).toMatchObject({
      worker_count: 1,
      family_count: 2,
      source: { worker_count: 'computed' },
      computed: { worker_count: 1, family_count: 2 },
    });
    // A manager must be employed at the estate.
    const other = await ok(send('post', '/employment-profiles', WORKER((await person()).id)), 201);
    const est = await ok(get(`/estates/${e.id}`));
    await refused(
      send('patch', `/estates/${e.id}`, { manager_profile_id: other.id }, est.version),
      'manager_profile_id',
    );
    const named = await ok(send('patch', `/estates/${e.id}`, { manager_profile_id: w.id }, est.version));
    expect(named.manager_profile_id).toBe(w.id);
    // A profile named as a manager cannot be deleted.
    const del = await as(request(server).delete(`/api/v1/employment-profiles/${w.id}`), MANAGER).set(
      'If-Match',
      `"${String(w.version)}"`,
    );
    expect(del.status, json(del)).toBe(422);
    expect(errorOf(del).code).toBe('REFERENCED_RECORD');
  });

  it('gives the management pages their figures, within scope', async () => {
    const e = await ok(send('post', '/estates', { code: unique('D'), name: 'Estate D' }), 201);
    const mk = async (gender: string, dob: string, joined: string) =>
      ok(
        send(
          'post',
          '/employment-profiles',
          WORKER((await person({ registered_estate_id: e.id, gender, date_of_birth: dob })).id, {
            estate_id: e.id,
            joining_date: joined,
          }),
        ),
        201,
      );
    await mk('male', '1990-01-01', '2012-01-01');
    await mk('female', '2002-01-01', today);
    const gone = await mk('female', '1970-01-01', '2000-01-01');
    await ok(
      send(
        'post',
        `/employment-profiles/${gone.id}/separate`,
        { separation_date: today, separation_type: 'retirement', reason: 'Age' },
        gone.version,
      ),
    );
    const s = await ok(get(`/employment-profiles/summary?employment_type=worker&estate_id=${e.id}`));
    expect(s).toMatchObject({
      total: 2,
      active: 2,
      separated: 1,
      active_pct: '100.00',
      new_this_month: 1,
      exits_this_month: 1,
    });
    const count = (b: unknown, key: string) =>
      (b as { key: string; count: number }[]).find((x) => x.key === key)?.count;
    expect(count(s.by_gender, 'male')).toBe(1);
    expect(count(s.by_age_group, 'under_25')).toBe(1);
    expect(count(s.by_length_of_service, '10_plus')).toBe(1);
    // Another estate's figures are not the narrow user's.
    const narrow = await ok(
      get(`/employment-profiles/summary?employment_type=worker&estate_id=${e.id}`, NARROW),
    );
    expect(narrow.total).toBe(0);
  });

  it('sums a person’s service across profiles', async () => {
    const p = await person();
    const old = await ok(
      send('post', '/employment-profiles', WORKER(p.id, { joining_date: '2020-01-01' })),
      201,
    );
    await ok(
      send(
        'post',
        `/employment-profiles/${old.id}/separate`,
        { separation_date: '2020-12-31', separation_type: 'end_of_contract', reason: 'Season ended' },
        old.version,
      ),
    );
    await ok(
      send(
        'post',
        '/employment-profiles',
        WORKER(p.id, { joining_date: today, is_service_continuous: false }),
      ),
      201,
    );
    const s = await ok(get(`/persons/${p.id}/service-summary`));
    expect(s).toMatchObject({
      profiles: 2,
      continuous_service_days: 366,
      total_service_days: 367,
      first_joining_date: '2020-01-01',
    });
  });
});
