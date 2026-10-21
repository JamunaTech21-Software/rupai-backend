import type { Server } from 'node:http';

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
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.09 — training on real MySQL: a programme planned, approved, run and completed; participants unique per
 * programme (the verification), within capacity and the estate; attendance and results recorded with
 * their rules; cancellation; a profile's training history.
 */

const ADMIN = '1';
let HR = '';
let APPROVER = '';
let WF = '';
let mdb: MigratedDatabase;
let server: Server;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
const today = todayIn(loadConfig({ ...TEST_ENV }).timezone);

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = HR) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = HR,
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
async function refused(r: request.Test, status: number, code: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}

let estate = '';
let other = '';

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: roleId }] }, current.version, ADMIN));
  await ok(send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  return id;
}
async function profile(estateId = estate) {
  const p = await ok(
    send('post', '/persons', { first_name: unique('T'), registered_estate_id: estateId }),
    201,
  );
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estateId,
      employment_type: 'worker',
      engagement_type: 'permanent',
      joining_date: '2015-01-01',
    }),
    201,
  );
}
async function approved(over: object = {}) {
  const p = await ok(
    send('post', '/training-programs', {
      estate_id: estate,
      title: 'Safe pesticide handling',
      training_type: 'safety',
      trainer_type: 'external',
      trainer_name: 'BTRI',
      start_date: addDays(today, -10),
      end_date: addDays(today, -9),
      cost: '15000',
      ...over,
    }),
    201,
  );
  const s = await ok(send('post', `/training-programs/${p.id}/submit`, {}, p.version));
  const q = await many(get('/approvals/pending', APPROVER));
  const item = q.find((x) => x.approval_id === s.approval_id);
  await ok(
    send(
      'post',
      `/approvals/${String(s.approval_id)}/approve`,
      { step_number: item?.step_number },
      undefined,
      APPROVER,
    ),
  );
  return ok(get(`/training-programs/${p.id}`));
}
const enrol = (programId: string, ids: string[]) =>
  send('post', `/training-programs/${programId}/participants`, { employment_profile_ids: ids });

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
  HR = await user(
    'th',
    (
      await role([
        ...['view', 'create', 'edit', 'delete', 'submit'].map((a) => `training.${a}`),
        'person.view',
        'person.create',
        'employment.view',
        'employment.create',
        'estate.view',
        'estate.create',
      ])
    ).id,
  );
  const approverRole = await role(['training.view', 'training.approve']);
  APPROVER = await user('ta', approverRole.id);
  WF = await user('tw', (await role(['workflow.view', 'workflow.approve'])).id);
  estate = (await ok(send('post', '/estates', { code: unique('E'), name: 'Training estate' }), 201)).id;
  other = (await ok(send('post', '/estates', { code: unique('O'), name: 'Other estate' }), 201)).id;
  const w = await ok(
    send(
      'post',
      '/workflows',
      {
        code: unique('WF'),
        name: 'Training',
        document_type: 'training_program',
        estate_id: estate,
        effective_from: today,
        steps: [{ name: 'Estate manager', approver_rule: 'by_role', role_id: approverRole.id }],
      },
      undefined,
      ADMIN,
    ),
    201,
  );
  await ok(send('post', `/workflows/${w.id}/submit`, {}, undefined, ADMIN));
  await ok(send('post', `/workflows/${w.id}/approve`, {}, undefined, WF));
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('training (P2.09)', () => {
  it('participants are unique per programme (the verification), within capacity and the estate', async () => {
    const p = await approved({ capacity: 3 });
    expect(String(p.program_code)).toMatch(/^TP-/);
    const [a, b, c, dd] = [await profile(), await profile(), await profile(), await profile()];
    await many(enrol(p.id, [a.id, b.id]));
    await refused(enrol(p.id, [a.id]), 422, 'DUPLICATE_KEY');
    await refused(enrol(p.id, [c.id, dd.id]), 422, 'VALIDATION_FAILED');
    await refused(enrol(p.id, [c.id, c.id]), 422, 'VALIDATION_FAILED');
    const away = await profile(other);
    await refused(enrol(p.id, [away.id]), 422, 'VALIDATION_FAILED');
    expect(await ok(get(`/training-programs/${p.id}`))).toMatchObject({
      participant_count: 2,
      seats_left: 1,
    });
  });

  it('attendance and results: only someone who attended is assessed; completion needs every attendance', async () => {
    const p = await approved();
    const [a, b] = [await profile(), await profile()];
    const [pa, pb] = await many(enrol(p.id, [a.id, b.id]));
    await refused(
      send('post', `/training-programs/${p.id}/complete`, {}, p.version),
      422,
      'VALIDATION_FAILED',
    );
    const ra = await ok(
      send(
        'patch',
        `/training-programs/${p.id}/participants/${String(pa?.id)}`,
        {
          attendance_status: 'attended',
          score: '82.5',
          result: 'pass',
          certificate_number: 'BTRI-2026-0412',
          certificate_issued_on: today,
          feedback_rating: 5,
        },
        pa?.version,
      ),
    );
    expect(ra).toMatchObject({
      attendance_status: 'attended',
      score: '82.5000',
      result: 'pass',
      certificate_number: 'BTRI-2026-0412',
    });
    await refused(
      send(
        'patch',
        `/training-programs/${p.id}/participants/${String(pb?.id)}`,
        { attendance_status: 'absent', result: 'fail' },
        pb?.version,
      ),
      422,
      'VALIDATION_FAILED',
    );
    await ok(
      send(
        'patch',
        `/training-programs/${p.id}/participants/${String(pb?.id)}`,
        { attendance_status: 'absent' },
        pb?.version,
      ),
    );
    const done = await ok(send('post', `/training-programs/${p.id}/complete`, {}, p.version));
    expect(done.state).toBe('completed');
    await refused(enrol(done.id, [(await profile()).id]), 409, 'INVALID_TRANSITION');
    const history = await many(get(`/employment-profiles/${a.id}/trainings`));
    expect(history).toEqual([
      expect.objectContaining({ result: 'pass', program: expect.objectContaining({ id: p.id }) }),
    ]);
  });

  it('attendance waits for the start date; only a draft is changed; cancellation takes a reason', async () => {
    const future = await approved({ start_date: addDays(today, 20), end_date: addDays(today, 21) });
    const [x] = await many(enrol(future.id, [(await profile()).id]));
    await refused(
      send(
        'patch',
        `/training-programs/${future.id}/participants/${String(x?.id)}`,
        { attendance_status: 'attended' },
        x?.version,
      ),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('patch', `/training-programs/${future.id}`, { venue: 'Hall' }, future.version),
      409,
      'INVALID_TRANSITION',
    );
    const c = await ok(
      send(
        'post',
        `/training-programs/${future.id}/cancel`,
        { reason: 'Trainer unavailable' },
        future.version,
      ),
    );
    expect(c).toMatchObject({ state: 'cancelled', cancellation_reason: 'Trainer unavailable' });
    const draft = await ok(
      send('post', '/training-programs', {
        estate_id: estate,
        title: 'Plucking technique',
        training_type: 'skill',
        start_date: today,
        end_date: today,
      }),
      201,
    );
    await refused(
      send('post', '/training-programs', {
        estate_id: estate,
        program_code: draft.program_code,
        title: 'Again',
        training_type: 'skill',
        start_date: today,
        end_date: today,
      }),
      422,
      'DUPLICATE_KEY',
    );
    await ok(send('delete', `/training-programs/${draft.id}`, {}, draft.version), 204);
  });
});
