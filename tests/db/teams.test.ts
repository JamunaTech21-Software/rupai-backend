import type { Server } from 'node:http';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { addDays, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { describeScopeLeakage } from '../helpers/scope-leakage.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.04 — worker teams and effective-dated membership on real MySQL: teams per estate with a sardar,
 * division and section; members by date (the verification: a past date shows that date's members); one
 * team at a time per worker, moving between teams, one leader, ending and deleting memberships, separation
 * ending them, deactivation and deletion guards, and scope.
 */

const ADMIN = '1';
/** person.*, employment.* (with approve), team.*, estate/division/section.*; all estates. */
let MANAGER = '';
/** team.view; estate B only. */
let OTHER = '';
let mdb: MigratedDatabase;
let server: Server;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 600)}`;
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string; message: string }[] } }).error;
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
async function refused(r: request.Test, code: string, status = 422) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).code).toBe(code);
  return errorOf(res);
}

const today = todayIn(loadConfig({ ...TEST_ENV }).timezone);
let estate = '';
let estateB = '';
let division = '';
let section = '';
let leak = { inTeam: '', outTeam: '' };

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
          ? { authorisations: sensitive.map((key) => ({ key, reason: 'P2.04 tests' })) }
          : {}),
      },
      current.version,
      ADMIN,
    ),
  );
  return id;
}
async function profile(type: 'worker' | 'employee' = 'worker', estateId = estate, joining = '2020-01-01') {
  const p = await ok(
    send('post', '/persons', { first_name: unique('W'), registered_estate_id: estateId }),
    201,
  );
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estateId,
      employment_type: type,
      engagement_type: 'permanent',
      joining_date: joining,
    }),
    201,
  );
}
const team = (over: object = {}) =>
  ok(
    send('post', '/worker-teams', {
      estate_id: estate,
      code: unique('T'),
      name: 'Plucking gang',
      team_type: 'plucking',
      ...over,
    }),
    201,
  );
const add = (teamId: string, members: object[], move = false) =>
  send('post', `/worker-teams/${teamId}/members`, { members, move_from_other_team: move });

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
  const basic = ['person', 'employment', 'team', 'estate', 'division', 'section'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  MANAGER = await user('tm', (await role([...basic, 'employment.approve'])).id, [
    'SOD-1:employment.approve+employment.create',
  ]);
  OTHER = await user('to', (await role(['team.view'])).id);
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  estate = (await ok(send('post', '/estates', { code: unique('A'), name: 'Estate A' }), 201)).id;
  estateB = (await ok(send('post', '/estates', { code: unique('B'), name: 'Estate B' }), 201)).id;
  await ok(
    send('post', `/users/${OTHER}/scopes`, { scope_type: 'estate', scope_id: estateB }, undefined, ADMIN),
    201,
  );
  division = (await ok(send('post', `/estates/${estate}/divisions`, { code: 'N', name: 'North' }), 201)).id;
  section = (await ok(send('post', `/divisions/${division}/sections`, { code: 'N1', name: 'North 1' }), 201))
    .id;
  leak = {
    inTeam: (
      await ok(
        send('post', '/worker-teams', { estate_id: estateB, code: 'B1', name: 'B gang', team_type: 'field' }),
        201,
      )
    ).id,
    outTeam: (await team()).id,
  };
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('worker teams (P2.04)', () => {
  it('creates a team with its sardar, division from the section; code unique per estate', async () => {
    const sardar = await profile('employee');
    const t = await team({ code: 'PG-01', supervisor_profile_id: sardar.id, section_id: section });
    expect(t).toMatchObject({
      code: 'PG-01',
      team_type: 'plucking',
      supervisor: { id: sardar.id },
      division: { id: division },
      section: { id: section },
      member_count: 0,
      leader: null,
      status: 'active',
    });
    await refused(
      send('post', '/worker-teams', { estate_id: estate, code: 'PG-01', name: 'x', team_type: 'field' }),
      'DUPLICATE_KEY',
    );
    await ok(
      send('post', '/worker-teams', { estate_id: estateB, code: 'PG-01', name: 'x', team_type: 'field' }),
      201,
    );
    const foreign = await profile('employee', estateB);
    await refused(
      send('post', '/worker-teams', {
        estate_id: estate,
        code: unique('X'),
        name: 'x',
        team_type: 'field',
        supervisor_profile_id: foreign.id,
      }),
      'VALIDATION_FAILED',
    );
  });

  it('membership resolves by date: a past date shows that date’s members', async () => {
    const t = await team();
    const [a, b, c] = [await profile(), await profile(), await profile()];
    await many(
      add(t.id, [
        { employment_profile_id: a.id, effective_from: '2024-01-01', role_in_team: 'leader' },
        { employment_profile_id: b.id, effective_from: '2024-01-01' },
      ]),
    );
    const [mb] = (await many(get(`/worker-teams/${t.id}/members`))).filter(
      (m) => m.employment_profile_id === b.id,
    );
    await ok(
      send(
        'post',
        `/worker-teams/${t.id}/members/${String(mb?.id)}/end`,
        { effective_to: '2024-03-31' },
        mb?.version,
      ),
    );
    await many(add(t.id, [{ employment_profile_id: c.id, effective_from: '2024-04-01' }]));

    const march = await many(get(`/worker-teams/${t.id}/members?as_of=2024-03-15`));
    expect(march.map((m) => m.employment_profile_id).sort()).toEqual([a.id, b.id].sort());
    const now = await many(get(`/worker-teams/${t.id}/members`));
    expect(now.map((m) => m.employment_profile_id).sort()).toEqual([a.id, c.id].sort());
    expect(now[0]).toMatchObject({ role_in_team: 'leader' });
    const history = await many(get(`/worker-teams/${t.id}/members?history=true`));
    expect(history).toHaveLength(3);
    expect(await ok(get(`/worker-teams/${t.id}`))).toMatchObject({
      member_count: 2,
      leader: { profile_id: a.id },
    });
  });

  it('a worker is in one team at a time; moving ends the other membership the day before', async () => {
    const [t1, t2] = [await team(), await team()];
    const w = await profile();
    await many(add(t1.id, [{ employment_profile_id: w.id, effective_from: '2024-01-01' }]));
    const e = await refused(
      add(t2.id, [{ employment_profile_id: w.id, effective_from: '2025-01-01' }]),
      'DUPLICATE_KEY',
    );
    expect(e.details[0]?.message).toContain('another team');
    await refused(
      add(t1.id, [{ employment_profile_id: w.id, effective_from: '2025-01-01' }]),
      'DUPLICATE_KEY',
    );
    await many(add(t2.id, [{ employment_profile_id: w.id, effective_from: '2025-01-01' }], true));
    const mine = await many(get(`/employment-profiles/${w.id}/teams`));
    expect(mine.map((m) => [m.worker_team_id, m.effective_from, m.effective_to])).toEqual([
      [t2.id, '2025-01-01', null],
      [t1.id, '2024-01-01', '2024-12-31'],
    ]);
  });

  it('members are worker profiles of the estate, from their joining; all or nothing', async () => {
    const t = await team();
    const emp = await profile('employee');
    const foreign = await profile('worker', estateB);
    const late = await profile('worker', estate, '2025-06-01');
    const okWorker = await profile();
    await refused(
      add(t.id, [{ employment_profile_id: emp.id, effective_from: '2025-01-01' }]),
      'VALIDATION_FAILED',
    );
    await refused(
      add(t.id, [{ employment_profile_id: foreign.id, effective_from: '2025-01-01' }]),
      'VALIDATION_FAILED',
    );
    await refused(
      add(t.id, [{ employment_profile_id: late.id, effective_from: '2025-01-01' }]),
      'VALIDATION_FAILED',
    );
    await refused(
      add(t.id, [
        { employment_profile_id: okWorker.id, effective_from: '2025-01-01' },
        { employment_profile_id: emp.id, effective_from: '2025-01-01' },
      ]),
      'VALIDATION_FAILED',
    );
    expect(await many(get(`/worker-teams/${t.id}/members?history=true`))).toHaveLength(0);
  });

  it('one leader at a time; roles change; an ended membership cannot end again', async () => {
    const t = await team();
    const [a, b] = [await profile(), await profile()];
    await many(
      add(t.id, [{ employment_profile_id: a.id, effective_from: '2024-01-01', role_in_team: 'leader' }]),
    );
    await refused(
      add(t.id, [{ employment_profile_id: b.id, effective_from: '2024-06-01', role_in_team: 'leader' }]),
      'VALIDATION_FAILED',
    );
    const [mb] = await many(add(t.id, [{ employment_profile_id: b.id, effective_from: '2024-06-01' }]));
    await refused(
      send(
        'patch',
        `/worker-teams/${t.id}/members/${String(mb?.id)}`,
        { role_in_team: 'leader' },
        mb?.version,
      ),
      'VALIDATION_FAILED',
    );
    const assistant = await ok(
      send(
        'patch',
        `/worker-teams/${t.id}/members/${String(mb?.id)}`,
        { role_in_team: 'assistant' },
        mb?.version,
      ),
    );
    expect(assistant.role_in_team).toBe('assistant');
    const ended = await ok(
      send(
        'post',
        `/worker-teams/${t.id}/members/${assistant.id}/end`,
        { effective_to: '2024-12-31' },
        assistant.version,
      ),
    );
    await refused(
      send(
        'post',
        `/worker-teams/${t.id}/members/${ended.id}/end`,
        { effective_to: '2025-01-31' },
        ended.version,
      ),
      'INVALID_TRANSITION',
      409,
    );
    const [ma] = await many(get(`/worker-teams/${t.id}/members?as_of=2024-01-01`));
    await refused(
      send(
        'post',
        `/worker-teams/${t.id}/members/${String(ma?.id)}/end`,
        { effective_to: '2023-01-01' },
        ma?.version,
      ),
      'VALIDATION_FAILED',
    );
  });

  it('separation ends the worker’s membership on the separation date', async () => {
    const t = await team();
    const w = await profile();
    await many(add(t.id, [{ employment_profile_id: w.id, effective_from: '2024-01-01' }]));
    const p = await ok(get(`/employment-profiles/${w.id}`));
    const sep = addDays(today, -10);
    await ok(
      send(
        'post',
        `/employment-profiles/${w.id}/separate`,
        { separation_date: sep, separation_type: 'resignation', reason: 'Left the estate' },
        p.version,
      ),
    );
    const [m] = await many(get(`/employment-profiles/${w.id}/teams`));
    expect(m).toMatchObject({ effective_to: sep, is_current: false });
    expect((await ok(get(`/worker-teams/${t.id}`))).member_count).toBe(0);
  });

  it('deactivation needs no current members; deletion needs no members ever', async () => {
    const t = await team();
    const w = await profile();
    const [m] = await many(add(t.id, [{ employment_profile_id: w.id, effective_from: '2024-01-01' }]));
    await refused(send('post', `/worker-teams/${t.id}/deactivate`, {}, t.version), 'INVALID_TRANSITION', 409);
    await ok(
      send(
        'post',
        `/worker-teams/${t.id}/members/${String(m?.id)}/end`,
        { effective_to: addDays(today, -1) },
        m?.version,
      ),
    );
    const off = await ok(send('post', `/worker-teams/${t.id}/deactivate`, {}, t.version));
    expect(off.status).toBe('inactive');
    await refused(
      add(t.id, [{ employment_profile_id: w.id, effective_from: today }]),
      'INVALID_TRANSITION',
      409,
    );
    const del = await send('delete', `/worker-teams/${t.id}`, {}, off.version);
    expect(del.status, json(del)).toBe(422);
    const empty = await team();
    await ok(send('delete', `/worker-teams/${empty.id}`, {}, empty.version), 204);
  });

  it('a membership entered in error is deleted', async () => {
    const t = await team();
    const w = await profile();
    const [m] = await many(add(t.id, [{ employment_profile_id: w.id, effective_from: '2024-01-01' }]));
    await ok(send('delete', `/worker-teams/${t.id}/members/${String(m?.id)}`, {}), 204);
    expect(await many(get(`/worker-teams/${t.id}/members?history=true`))).toHaveLength(0);
  });
});

describeScopeLeakage({
  resource: 'worker teams (estate grant)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': OTHER }),
  listPath: '/api/v1/worker-teams',
  itemPath: (id) => `/api/v1/worker-teams/${id}`,
  inScope: () => [leak.inTeam],
  outOfScope: () => [leak.outTeam],
});
