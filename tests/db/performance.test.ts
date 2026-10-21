import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { addDays, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { goalStatesJob } from '../../src/modules/workforce/performance.jobs.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.10 — goals and evaluations on real MySQL: goals approved and progressed (value against target), the
 * delayed / overdue states computed (after progress and nightly), the overview and calendar; evaluations
 * scored and rated, approved, and acknowledged by the evaluated employee, after which they are locked for
 * good (the verification).
 */

const ADMIN = '1';
let HR = '';
let APPROVER = '';
let WORKER = '';
let WF = '';
let mdb: MigratedDatabase;
let server: Server;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
const timezone = loadConfig({ ...TEST_ENV }).timezone;
const today = todayIn(timezone);

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = HR) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
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
let worker = '';
let reviewer = '';
const criteria: Record<string, string> = {};

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string, scope = true) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: roleId }] }, current.version, ADMIN));
  if (scope)
    await ok(send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  return id;
}
async function profile(type = 'worker') {
  const p = await ok(
    send('post', '/persons', { first_name: unique('G'), registered_estate_id: estate }),
    201,
  );
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estate,
      employment_type: type,
      engagement_type: 'permanent',
      joining_date: '2015-01-01',
    }),
    201,
  );
}
async function approveDoc(approvalId: unknown) {
  const q = await many(get('/approvals/pending', APPROVER));
  const item = q.find((x) => x.approval_id === approvalId);
  expect(item, JSON.stringify(q)).toBeDefined();
  return ok(
    send(
      'post',
      `/approvals/${String(approvalId)}/approve`,
      { step_number: item?.step_number },
      undefined,
      APPROVER,
    ),
  );
}
async function activeGoal(over: object = {}) {
  const g = await ok(
    send('post', '/goals', {
      owner_type: 'employment_profile',
      owner_id: worker,
      title: 'Pluck 6,000 kg this season',
      kpi_name: 'Green leaf plucked',
      measure_unit: 'kg',
      target_value: '6000',
      start_date: addDays(today, -30),
      due_date: addDays(today, 150),
      ...over,
    }),
    201,
  );
  const s = await ok(send('post', `/goals/${g.id}/submit`, {}, g.version));
  await approveDoc(s.approval_id);
  return ok(get(`/goals/${g.id}`));
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
  const crud = ['goal', 'evaluation'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete', 'submit'].map((a) => `${m}.${a}`),
  );
  HR = await user(
    'ph',
    (
      await role([
        ...crud,
        'person.view',
        'person.create',
        'employment.view',
        'employment.create',
        'estate.view',
        'estate.create',
      ])
    ).id,
  );
  const approverRole = await role(['goal.view', 'goal.approve', 'evaluation.view', 'evaluation.approve']);
  APPROVER = await user('pa', approverRole.id);
  WORKER = await user('pw', (await role(['goal.view', 'evaluation.view'])).id, false);
  WF = await user('pf', (await role(['workflow.view', 'workflow.approve'])).id);
  estate = (await ok(send('post', '/estates', { code: unique('E'), name: 'Goals estate' }), 201)).id;
  for (const type of ['goal', 'evaluation']) {
    const w = await ok(
      send(
        'post',
        '/workflows',
        {
          code: unique('WF'),
          name: type,
          document_type: type,
          estate_id: estate,
          effective_from: today,
          steps: [{ name: 'Manager', approver_rule: 'by_role', role_id: approverRole.id }],
        },
        undefined,
        ADMIN,
      ),
      201,
    );
    await ok(send('post', `/workflows/${w.id}/submit`, {}, undefined, ADMIN));
    await ok(send('post', `/workflows/${w.id}/approve`, {}, undefined, WF));
  }
  const w = await profile();
  worker = w.id;
  reviewer = (await profile('employee')).id;
  await mdb.migrator.user.update({
    where: { id: BigInt(WORKER) },
    data: { employmentProfileId: BigInt(w.id) },
  });
  for (const c of await runUnscoped('test', () =>
    mdb.migrator.evaluationCriteria.findMany({ select: { id: true, code: true } }),
  ))
    criteria[c.code] = c.id.toString();
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('goals (P2.10)', () => {
  it('a goal is approved, then progressed against its target; delayed when it trails its dates', async () => {
    const g = await activeGoal();
    expect(g).toMatchObject({
      state: 'active',
      owner_type: 'employment_profile',
      progress_percentage: '0.0000',
    });
    expect(String(g.goal_code)).toMatch(/^GL-/);
    await refused(send('patch', `/goals/${g.id}`, { title: 'x y z' }, g.version), 409, 'INVALID_TRANSITION');
    // 30 of 180 days elapsed (17 %): 1,200 of 6,000 kg is 20 % — on track.
    const p1 = await ok(
      send('post', `/goals/${g.id}/progress`, { progress_date: today, value: '1200', note: 'First month' }),
    );
    expect(p1).toMatchObject({
      progress_percentage: '20.0000',
      current_value: '1200.0000',
      state: 'in_progress',
    });
    const late = await activeGoal({ start_date: addDays(today, -120), due_date: addDays(today, 60) });
    const p2 = await ok(
      send('post', `/goals/${late.id}/progress`, { progress_date: today, progress_percentage: '20' }),
    );
    expect(p2.state).toBe('delayed');
    expect(await many(get(`/goals/${late.id}/progress`))).toHaveLength(1);
    await refused(
      send('post', `/goals/${g.id}/progress`, {
        progress_date: addDays(today, 2),
        progress_percentage: '30',
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('the nightly job marks a goal past its due date overdue; overview and calendar count it', async () => {
    const g = await activeGoal({ start_date: addDays(today, -60), due_date: addDays(today, 5) });
    await runUnscoped('test', () =>
      mdb.migrator.goal.update({
        where: { id: BigInt(g.id) },
        data: { dueDate: new Date(`${addDays(today, -1)}T00:00:00Z`) },
      }),
    );
    const job = goalStatesJob(mdb.db, deps().accessLog, timezone);
    await job.run({
      signal: new AbortController().signal,
      logger: silentLogger(),
      progress: () => Promise.resolve(),
    } as never);
    expect((await ok(get(`/goals/${g.id}`))).state).toBe('overdue');
    const o = await ok(get(`/goals/overview?estate_id=${estate}`));
    expect(Number(o.overdue)).toBeGreaterThanOrEqual(1);
    expect(Number(o.total)).toBeGreaterThanOrEqual(3);
    const cal = await many(
      get(`/goals/calendar?from=${addDays(today, -90)}&to=${addDays(today, 200)}&estate_id=${estate}`),
    );
    expect(cal.some((e) => e.goal_id === g.id && e.kind === 'due')).toBe(true);
    const done = await ok(
      send('post', `/goals/${g.id}/complete`, {}, (await ok(get(`/goals/${g.id}`))).version),
    );
    expect(done.state).toBe('completed');
  });

  it('a worker sees their own goals only', async () => {
    const other = await profile();
    await ok(
      send('post', '/goals', {
        owner_type: 'employment_profile',
        owner_id: other.id,
        title: 'Someone else',
        start_date: today,
        due_date: addDays(today, 30),
      }),
      201,
    );
    const mine = await many(get('/goals?per_page=100', WORKER));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.owner_id === worker)).toBe(true);
  });
});

describe('evaluations (P2.10)', () => {
  it('scores, rates, approves; the employee acknowledges; then it cannot be edited (the verification)', async () => {
    await refused(
      send('post', '/evaluations', {
        employment_profile_id: worker,
        period_start: '2026-01-01',
        period_end: '2026-06-30',
        evaluation_type: 'annual',
        lines: [{ criteria_id: criteria.QUALITY, score: '6' }],
      }),
      422,
      'VALIDATION_FAILED',
    );
    const e = await ok(
      send('post', '/evaluations', {
        employment_profile_id: worker,
        reviewer_profile_id: reviewer,
        period_start: '2026-01-01',
        period_end: '2026-06-30',
        evaluation_type: 'annual',
        strengths: 'Careful plucker',
        lines: [
          { criteria_id: criteria.JOB_KNOWLEDGE, score: '4', weight: '2' },
          { criteria_id: criteria.QUALITY, score: '3' },
        ],
      }),
      201,
    );
    // (4/5 × 2 + 3/5 × 1) ÷ 3 × 100 = 73.3333
    expect(e).toMatchObject({
      overall_score: '73.3333',
      overall_rating: 'meets',
      state: 'draft',
      is_locked: false,
    });
    expect(String(e.evaluation_number)).toMatch(/^EV-/);
    await refused(
      send('post', `/evaluations/${e.id}/acknowledge`, {}, e.version, WORKER),
      409,
      'INVALID_TRANSITION',
    );
    const s = await ok(send('post', `/evaluations/${e.id}/submit`, {}, e.version));
    await approveDoc(s.approval_id);
    const a = await ok(get(`/evaluations/${e.id}`));
    expect(a.state).toBe('approved');
    await refused(send('post', `/evaluations/${e.id}/acknowledge`, {}, a.version), 403, 'PERMISSION_DENIED');
    const ack = await ok(
      send(
        'post',
        `/evaluations/${e.id}/acknowledge`,
        { employee_comment: 'Agreed; I will improve quality' },
        a.version,
        WORKER,
      ),
    );
    expect(ack).toMatchObject({
      state: 'acknowledged',
      is_locked: true,
      employee_comment: 'Agreed; I will improve quality',
    });
    await refused(
      send('patch', `/evaluations/${e.id}`, { strengths: 'Changed' }, ack.version),
      409,
      'INVALID_TRANSITION',
    );
    await refused(
      send(
        'put',
        `/evaluations/${e.id}/lines`,
        { lines: [{ criteria_id: criteria.QUALITY, score: '5' }] },
        ack.version,
      ),
      409,
      'INVALID_TRANSITION',
    );
    const del = await send('delete', `/evaluations/${e.id}`, {}, ack.version);
    expect(del.status).toBe(404);
    expect(await many(get('/evaluations?per_page=100', WORKER))).toEqual([
      expect.objectContaining({ id: e.id }),
    ]);
  });

  it('submission needs every criterion scored; goal-linked lines name the profile’s own goal', async () => {
    const e = await ok(
      send('post', '/evaluations', {
        employment_profile_id: worker,
        period_start: '2026-07-01',
        period_end: '2026-12-31',
        evaluation_type: 'probation',
        lines: [{ criteria_id: criteria.ATTENDANCE }],
      }),
      201,
    );
    await refused(send('post', `/evaluations/${e.id}/submit`, {}, e.version), 422, 'VALIDATION_FAILED');
    const someone = await profile();
    const theirs = await ok(
      send('post', '/goals', {
        owner_type: 'employment_profile',
        owner_id: someone.id,
        title: 'Not yours',
        start_date: today,
        due_date: addDays(today, 10),
      }),
      201,
    );
    await refused(
      send(
        'put',
        `/evaluations/${e.id}/lines`,
        { lines: [{ criteria_id: criteria.GOALS, score: '4', goal_id: theirs.id }] },
        e.version,
      ),
      422,
      'VALIDATION_FAILED',
    );
  });
});

function deps() {
  return testModuleDeps({
    config: loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name) }),
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
}
