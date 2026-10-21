import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { addDays, businessDateToDb, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.07 — leave on real MySQL: entitlements generated pro-rata with carry-forward (LV.1, LV.2), a worker
 * filing their own leave (self scope), the day count, the balance refused with the balance shown (the
 * verification), approval through the reporting line consuming the entitlement, cancellation restoring it,
 * adjustments, and the "on leave" figure.
 */

const ADMIN = '1';
/** person, employment, leave (view, create, approve); all estates: HR. */
let HR = '';
/** leave.view + create only, no scope grant: a worker filing their own leave. */
let WORKER = '';
/** leave.view + approve; all estates; the worker's supervisor through the profiles. */
let BOSS = '';
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

let estate = '';
let fy = '';
let earned = '';
let sick = '';
let maternity = '';
let workerProfile = '';
let joiner = '';
/** The fiscal year: the one around today, April to March. */
const fyStart = (
  today.slice(5, 7) >= '04' ? `${today.slice(0, 4)}-04-01` : `${String(Number(today.slice(0, 4)) - 1)}-04-01`
) as BusinessDate;
const fyEnd = addDays(`${String(Number(fyStart.slice(0, 4)) + 1)}-04-01` as BusinessDate, -1);
/** A Monday at least two weeks ahead, within the year. */
const monday = (() => {
  let d = addDays(today, 14);
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addDays(d, 1);
  return d;
})();

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string, scope?: object, sensitive: string[] = []) {
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
          ? { authorisations: sensitive.map((key) => ({ key, reason: 'P2.07 tests' })) }
          : {}),
      },
      current.version,
      ADMIN,
    ),
  );
  if (scope) await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}
async function profile(type: 'worker' | 'employee', joining: string) {
  const p = await ok(
    send('post', '/persons', { first_name: unique('L'), registered_estate_id: estate, gender: 'female' }),
    201,
  );
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estate,
      employment_type: type,
      engagement_type: 'permanent',
      joining_date: joining,
    }),
    201,
  );
}
const leave = (body: object, actor = WORKER) => send('post', '/leave-requests', body, undefined, actor);
const submit = (l: Body, actor = WORKER) =>
  send('post', `/leave-requests/${l.id}/submit`, {}, l.version, actor);
async function approve(approvalId: string) {
  const q = await many(get('/approvals/pending', BOSS));
  const item = q.find((i) => i.approval_id === approvalId);
  expect(item, JSON.stringify(q)).toBeDefined();
  return ok(
    send('post', `/approvals/${approvalId}/approve`, { step_number: item?.step_number }, undefined, BOSS),
  );
}
const balanceOf = async (profileId: string, typeId: string, actor = HR) =>
  (
    await many(
      get(
        `/leave-entitlements?filter[employment_profile_id]=${profileId}&filter[leave_type_id]=${typeId}&filter[fiscal_year_id]=${fy}`,
        actor,
      ),
    )
  )[0];

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
  const basic = ['person', 'employment', 'leave', 'estate'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  HR = await user('lh', (await role([...basic, 'leave.approve'])).id, { scope_type: 'all_estates' }, [
    'SOD-1:leave.approve+leave.create',
  ]);
  WORKER = await user('lw', (await role(['leave.view', 'leave.create'])).id);
  BOSS = await user('lb', (await role(['leave.view', 'leave.approve'])).id, { scope_type: 'all_estates' });
  estate = (await ok(send('post', '/estates', { code: unique('E'), name: 'Leave estate' }), 201)).id;

  await runUnscoped('test setup', async () => {
    const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
    const existing = await mdb.migrator.fiscalYear.findFirst({
      where: { startDate: businessDateToDb(fyStart) },
    });
    const f =
      existing ??
      (await mdb.migrator.fiscalYear.create({
        data: {
          organisationId: org.id,
          code: unique('FY'),
          name: 'Test year',
          startDate: businessDateToDb(fyStart),
          endDate: businessDateToDb(fyEnd),
          state: 'open',
          createdBy: 1n,
        },
      }));
    fy = f.id.toString();
    const set = async (code: string, data: object) =>
      (await mdb.migrator.leaveType.update({ where: { code }, data })).id.toString();
    earned = await set('EARNED', { annualDays: '18', carryForwardLimitDays: '10' });
    sick = await set('SICK', { annualDays: '14' });
    maternity = await set('MATERNITY', { annualDays: '112', appliesTo: 'employee' });
    await set('UNPAID', { isPaid: false });
  });

  // The worker's account is linked to their profile, which reports to the boss's profile.
  const bossProfile = await profile('employee', '2010-01-01');
  const w = await profile('worker', '2015-01-01');
  workerProfile = w.id;
  await ok(
    send('patch', `/employment-profiles/${w.id}`, { supervisor_profile_id: bossProfile.id }, w.version),
  );
  await mdb.migrator.user.update({
    where: { id: BigInt(WORKER) },
    data: { employmentProfileId: BigInt(w.id) },
  });
  await mdb.migrator.user.update({
    where: { id: BigInt(BOSS) },
    data: { employmentProfileId: BigInt(bossProfile.id) },
  });
  // A mid-year joiner: joined in the year's seventh month.
  joiner = (await profile('worker', addDays(fyStart, 183))).id;
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('leave (P2.07)', () => {
  it('generates entitlements: full year, pro-rata for a joiner (LV.1), only types that apply; once', async () => {
    const g = await ok(
      send('post', '/leave-entitlements/generate', { fiscal_year_id: fy, estate_id: estate }),
    );
    expect(g.created).toBeGreaterThanOrEqual(5);
    expect(await balanceOf(workerProfile, earned)).toMatchObject({
      entitled_days: '18.0000',
      carried_forward_days: '0.0000',
      balance_days: '18.0000',
    });
    expect((await balanceOf(joiner, earned))?.entitled_days).toBe('9.0000');
    expect((await balanceOf(joiner, sick))?.entitled_days).toBe('7.0000');
    // Maternity applies to employees only.
    expect(await balanceOf(workerProfile, maternity)).toBeUndefined();
    const again = await ok(
      send('post', '/leave-entitlements/generate', { fiscal_year_id: fy, estate_id: estate }),
    );
    expect(again).toMatchObject({ created: 0 });
  });

  it('a worker files their own leave: day count without the weekly off; approval through their supervisor consumes it', async () => {
    const d = await ok(
      leave({
        leave_type_id: earned,
        from_date: monday,
        to_date: addDays(monday, 6),
        reason: 'Family wedding',
      }),
      201,
    );
    expect(d).toMatchObject({
      employment_profile_id: workerProfile,
      day_count: '6.0000',
      state: 'draft',
      is_paid: true,
    });
    expect(String(d.request_number)).toMatch(/^LV-/);
    const s = await ok(submit(d));
    expect(s.state).toBe('submitted');
    expect(await balanceOf(workerProfile, earned, WORKER)).toMatchObject({
      pending_days: '6.0000',
      available_to_request: '12.0000',
      balance_days: '18.0000',
    });
    await approve(String(s.approval_id));
    expect(await ok(get(`/leave-requests/${d.id}`, WORKER))).toMatchObject({
      state: 'approved',
      balance_days: '12.0000',
    });
    expect(await balanceOf(workerProfile, earned)).toMatchObject({
      consumed_days: '6.0000',
      balance_days: '12.0000',
      pending_days: '0.0000',
    });
  });

  it('leave beyond the balance is refused with the balance shown, counting what is already pending', async () => {
    const big = await ok(
      leave({ leave_type_id: earned, from_date: addDays(monday, 21), to_date: addDays(monday, 41) }),
      201,
    );
    const res = await submit(big);
    expect(res.status, json(res)).toBe(422);
    const e = (res.body as { error: { code: string; details: { context: Record<string, string> }[] } }).error;
    expect(e.code).toBe('INSUFFICIENT_BALANCE');
    expect(e.details[0]?.context).toMatchObject({
      balance_days: '12.0000',
      available_days: '12.0000',
      requested_days: '18.0000',
    });
    await ok(send('delete', `/leave-requests/${big.id}`, {}, big.version, WORKER), 204);

    const ten = await ok(
      submit(
        await ok(
          leave({ leave_type_id: earned, from_date: addDays(monday, 21), to_date: addDays(monday, 32) }),
          201,
        ),
      ),
    );
    expect(ten.day_count).toBe('10.0000');
    const more = await ok(
      leave({ leave_type_id: earned, from_date: addDays(monday, 35), to_date: addDays(monday, 38) }),
      201,
    );
    const r2 = await submit(more);
    expect(r2.status, json(r2)).toBe(422);
    expect(
      (r2.body as { error: { details: { context: Record<string, string> }[] } }).error.details[0]?.context,
    ).toMatchObject({ pending_days: '10.0000', available_days: '2.0000' });
  });

  it('half days, overlaps, the fiscal-year end and leave types for others are refused or counted right', async () => {
    const half = await ok(
      leave({
        leave_type_id: sick,
        from_date: addDays(monday, 50),
        to_date: addDays(monday, 50),
        is_half_day: true,
      }),
      201,
    );
    expect(half.day_count).toBe('0.5000');
    const bad = async (body: object, field: string) => {
      const res = await leave(body);
      expect(res.status, json(res)).toBe(422);
      expect(
        (res.body as { error: { details: { field: string }[] } }).error.details.map((x) => x.field),
      ).toContain(field);
    };
    await bad(
      { leave_type_id: sick, from_date: addDays(monday, 50), to_date: addDays(monday, 51) },
      'from_date',
    );
    await bad(
      { leave_type_id: sick, from_date: addDays(monday, 2), to_date: addDays(monday, 3), is_half_day: true },
      'is_half_day',
    );
    await bad({ leave_type_id: sick, from_date: addDays(fyEnd, -1), to_date: addDays(fyEnd, 2) }, 'to_date');
    await bad(
      { leave_type_id: maternity, from_date: addDays(monday, 60), to_date: addDays(monday, 61) },
      'leave_type_id',
    );
  });

  it('cancelling approved leave restores the balance; only approved leave is cancelled', async () => {
    const d = await ok(
      leave({ leave_type_id: sick, from_date: addDays(monday, 70), to_date: addDays(monday, 71) }),
      201,
    );
    const s = await ok(submit(d));
    await approve(String(s.approval_id));
    expect((await balanceOf(workerProfile, sick))?.consumed_days).toBe('2.0000');
    const a = await ok(get(`/leave-requests/${d.id}`, WORKER));
    const c = await ok(
      send('post', `/leave-requests/${d.id}/cancel`, { reason: 'Recovered early' }, a.version, WORKER),
    );
    expect(c.state).toBe('cancelled');
    expect((await balanceOf(workerProfile, sick))?.consumed_days).toBe('0.0000');
    const draft = await ok(
      leave({ leave_type_id: sick, from_date: addDays(monday, 80), to_date: addDays(monday, 80) }),
      201,
    );
    const res = await send(
      'post',
      `/leave-requests/${draft.id}/cancel`,
      { reason: 'x y z' },
      draft.version,
      WORKER,
    );
    expect(res.status, json(res)).toBe(409);
  });

  it('a worker sees only their own leave and balances; HR files leave for anyone in the estate', async () => {
    const other = await ok(
      send('post', '/leave-requests', {
        employment_profile_id: joiner,
        leave_type_id: sick,
        from_date: addDays(monday, 90),
        to_date: addDays(monday, 90),
      }),
      201,
    );
    const mine = await many(get('/leave-requests?per_page=100', WORKER));
    expect(mine.every((l) => l.employment_profile_id === workerProfile)).toBe(true);
    expect((await get(`/leave-requests/${other.id}`, WORKER)).status).toBe(404);
    const balances = await many(get('/leave-entitlements?per_page=100', WORKER));
    expect(balances.length).toBeGreaterThan(0);
    expect(balances.every((b) => b.employment_profile_id === workerProfile)).toBe(true);
    // Someone else's profile is not visible to them: "no such profile", disclosing nothing.
    const res = await send(
      'post',
      '/leave-requests',
      {
        employment_profile_id: joiner,
        leave_type_id: sick,
        from_date: addDays(monday, 95),
        to_date: addDays(monday, 95),
      },
      undefined,
      WORKER,
    );
    expect(res.status, json(res)).toBe(422);
  });

  it('an adjustment carries its reason and never leaves a negative balance', async () => {
    const e = await balanceOf(joiner, sick);
    const adj = await ok(
      send(
        'post',
        `/leave-entitlements/${String(e?.id)}/adjust`,
        { adjustment_days: '2.5', reason: 'Long service award' },
        e?.version,
      ),
    );
    expect(adj).toMatchObject({
      adjustment_days: '2.5000',
      adjustment_reason: 'Long service award',
      total_available: '9.5000',
    });
    const res = await send(
      'post',
      `/leave-entitlements/${String(e?.id)}/adjust`,
      { adjustment_days: '-20', reason: 'Correction' },
      adj.version,
    );
    expect(res.status, json(res)).toBe(422);
    const denied = await send(
      'post',
      `/leave-entitlements/${String(e?.id)}/adjust`,
      { adjustment_days: '1', reason: 'Mine' },
      adj.version,
      WORKER,
    );
    expect(denied.status).toBe(403);
  });

  it('approved leave covering today counts as on leave in the workforce figures', async () => {
    const p = await profile('worker', '2018-01-01');
    await ok(
      send('post', '/leave-entitlements/generate', { fiscal_year_id: fy, employment_profile_id: p.id }),
    );
    const before = await ok(get(`/employment-profiles/summary?employment_type=worker&estate_id=${estate}`));
    const l = await ok(
      send('post', '/leave-requests', {
        employment_profile_id: p.id,
        leave_type_id: sick,
        from_date: today,
        to_date: addDays(today, 2),
      }),
      201,
    );
    const s = await ok(send('post', `/leave-requests/${l.id}/submit`, {}, l.version));
    // No supervisor on this profile: approve as the engine would.
    await runUnscoped('test', () =>
      mdb.migrator.leaveRequest.update({
        where: { id: BigInt(s.id) },
        data: { state: 'approved', approvedAt: new Date(), approvedBy: 1n },
      }),
    );
    const after = await ok(get(`/employment-profiles/summary?employment_type=worker&estate_id=${estate}`));
    expect(Number(after.on_leave)).toBe(Number(before.on_leave) + 1);
  });
});
