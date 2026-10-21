import type { Server } from 'node:http';

import type { Express } from 'express';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { describeScopeLeakage } from '../helpers/scope-leakage.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.03 — employment assignments on real MySQL: the joining assignment, transfers that carry over what
 * they do not change and close the one before on approval, resolution by date (P13 §12.1 step 2: last
 * month's register shows last month's division), wage changes routed through the approval engine to the
 * submitter's supervisor (by_reporting_line), reject and return, drafts only editable, one pending
 * change, scope through the current assignment, and the profile lists' columns and figures.
 */

const ADMIN = '1';
/** person.*, employment.* (no approve), estate/division/section.*; all estates. Linked to a profile. */
let MANAGER = '';
/** employment.view + approve; all estates. MANAGER's supervisor through the profiles. */
let BOSS = '';
/** employment.view, person.view; a grant on one section only. */
let SECTION_USER = '';
let mdb: MigratedDatabase;
let server: Server;
let app: Express;
/** For the leakage suite: one worker placed in the section user's section, one elsewhere. */
const leak = { inProfile: '', inAssignment: '', outProfile: '', outAssignment: '' };
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
async function refused(r: request.Test, code: string, field?: string, status = 422) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).code).toBe(code);
  if (field) expect(errorOf(res).details.map((d) => d.field)).toContain(field);
}

const today = todayIn(loadConfig({ ...TEST_ENV }).timezone);
let estate = { id: '', code: '' };
let other = { id: '', code: '' };
const div: Record<string, string> = {};
const sec: Record<string, string> = {};
let pruning = '';
let weeding = '';
let otherSection = '';
let dept = { hr: '', field: '' };
let desig = { officer: '', manager: '' };

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
          ? { authorisations: sensitive.map((key) => ({ key, reason: 'P2.03 tests' })) }
          : {}),
      },
      current.version,
      ADMIN,
    ),
  );
  return id;
}
const scope = (userId: string, body: object) =>
  ok(send('post', `/users/${userId}/scopes`, body, undefined, ADMIN), 201);

async function person() {
  return ok(
    send('post', '/persons', { first_name: unique('P'), registered_estate_id: estate.id, gender: 'male' }),
    201,
  );
}
async function worker(joining = '2020-01-01') {
  const p = await person();
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estate.id,
      employment_type: 'worker',
      engagement_type: 'permanent',
      joining_date: joining,
    }),
    201,
  );
}
async function employee(joining = '2020-01-01') {
  const p = await person();
  return ok(
    send('post', '/employment-profiles', {
      person_id: p.id,
      estate_id: estate.id,
      employment_type: 'employee',
      engagement_type: 'permanent',
      joining_date: joining,
    }),
    201,
  );
}
const post = (profileId: string, body: object) =>
  send('post', `/employment-profiles/${profileId}/assignments`, body);
const draft = (profileId: string, body: object) => ok(post(profileId, body), 201);
const submit = (a: Body, actor = MANAGER) =>
  ok(send('post', `/employment-assignments/${a.id}/submit`, {}, a.version, actor));
async function joined(profileId: string, body: object = {}, from = '2020-01-01') {
  const a = await draft(profileId, {
    effective_from: from,
    section_id: sec.n1,
    activity_type_id: pruning,
    ...body,
  });
  return submit(a);
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
  app = createApp({
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
  MANAGER = await user('asm', (await role(basic)).id);
  BOSS = await user('asb', (await role(['employment.view', 'employment.approve', 'person.view'])).id);
  SECTION_USER = await user('ass', (await role(['employment.view', 'person.view'])).id);
  await scope(MANAGER, { scope_type: 'all_estates' });
  await scope(BOSS, { scope_type: 'all_estates' });

  const mk = async (p: string) => {
    const code = unique(p);
    const e = await ok(send('post', '/estates', { code, name: `Estate ${p}` }), 201);
    return { id: e.id, code };
  };
  estate = await mk('A');
  other = await mk('B');
  for (const d of ['N', 'S']) {
    div[d] = (
      await ok(send('post', `/estates/${estate.id}/divisions`, { code: d, name: `Division ${d}` }), 201)
    ).id;
  }
  sec.n1 = (await ok(send('post', `/divisions/${div.N}/sections`, { code: 'N1', name: 'North 1' }), 201)).id;
  sec.s1 = (await ok(send('post', `/divisions/${div.S}/sections`, { code: 'S1', name: 'South 1' }), 201)).id;
  const dB = (await ok(send('post', `/estates/${other.id}/divisions`, { code: 'X', name: 'Other' }), 201)).id;
  otherSection = (await ok(send('post', `/divisions/${dB}/sections`, { code: 'X1', name: 'Other 1' }), 201))
    .id;
  await scope(SECTION_USER, { scope_type: 'section', scope_id: sec.s1 });

  pruning = (await mdb.migrator.activityType.findFirstOrThrow({ where: { code: 'PRUNING' } })).id.toString();
  weeding = (await mdb.migrator.activityType.findFirstOrThrow({ where: { code: 'WEEDING' } })).id.toString();
  const lookup = async (model: 'department' | 'designation', code: string, name: string) =>
    (
      await (mdb.migrator[model] as typeof mdb.migrator.department).create({
        data: { code: unique(code), name, createdBy: 1n },
      })
    ).id.toString();
  dept = {
    hr: await lookup('department', 'HR', 'HR & Admin'),
    field: await lookup('department', 'FO', 'Field Operations'),
  };
  desig = {
    officer: await lookup('designation', 'OFF', 'HR Officer'),
    manager: await lookup('designation', 'MGR', 'HR Manager'),
  };

  // The reporting line: MANAGER's profile reports to BOSS's profile (P7 §4: by_reporting_line).
  const bossProfile = await employee('2010-01-01');
  const mgrProfile = await employee('2012-01-01');
  await ok(
    send(
      'patch',
      `/employment-profiles/${mgrProfile.id}`,
      { supervisor_profile_id: bossProfile.id },
      mgrProfile.version,
    ),
  );
  await mdb.migrator.user.update({
    where: { id: BigInt(BOSS) },
    data: { employmentProfileId: BigInt(bossProfile.id) },
  });
  await mdb.migrator.user.update({
    where: { id: BigInt(MANAGER) },
    data: { employmentProfileId: BigInt(mgrProfile.id) },
  });

  const placed = await worker();
  const elsewhere = await worker();
  leak.inProfile = placed.id;
  leak.inAssignment = (await joined(placed.id, { section_id: sec.s1 })).id;
  leak.outProfile = elsewhere.id;
  leak.outAssignment = (await joined(elsewhere.id)).id;
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('employment assignments (P2.03)', () => {
  it('starts a worker on the joining date; a section names its division; no wage change takes effect at once', async () => {
    const w = await worker();
    await refused(
      post(w.id, { effective_from: '2020-02-01', section_id: sec.n1, activity_type_id: pruning }),
      'VALIDATION_FAILED',
      'effective_from',
    );
    await refused(
      post(w.id, { effective_from: '2020-01-01', activity_type_id: pruning }),
      'VALIDATION_FAILED',
      'section_id',
    );
    await refused(
      post(w.id, { effective_from: '2020-01-01', section_id: otherSection, activity_type_id: pruning }),
      'VALIDATION_FAILED',
      'section_id',
    );
    const d = await draft(w.id, {
      effective_from: '2020-01-01',
      section_id: sec.n1,
      activity_type_id: pruning,
    });
    expect(d).toMatchObject({
      state: 'draft',
      change_reason: 'joining',
      wage_basis: 'daily',
      division: { id: div.N },
      section: { id: sec.n1 },
      activity_type: { code: 'PRUNING' },
      is_current: false,
    });
    const a = await submit(d);
    expect(a).toMatchObject({
      state: 'approved',
      is_wage_change: false,
      is_current: true,
      effective_to: null,
      approval_id: null,
    });
    const p = await ok(get(`/employment-profiles/${w.id}`));
    expect(p.current_assignment).toMatchObject({
      id: a.id,
      section: { id: sec.n1 },
      division: { id: div.N },
    });
  });

  it('a transfer carries over what it does not change and closes the one before; resolution by date', async () => {
    const w = await worker();
    const first = await joined(w.id);
    await refused(
      post(w.id, { effective_from: '2020-01-01', section_id: sec.s1, change_reason: 'transfer' }),
      'VALIDATION_FAILED',
      'effective_from',
    );
    await refused(
      post(w.id, { effective_from: '2024-03-01', section_id: sec.s1, change_reason: 'joining' }),
      'VALIDATION_FAILED',
      'change_reason',
    );
    const t = await draft(w.id, {
      effective_from: '2024-03-01',
      section_id: sec.s1,
      change_reason: 'transfer',
    });
    expect(t).toMatchObject({
      division: { id: div.S },
      section: { id: sec.s1 },
      activity_type: { id: pruning },
    });
    await submit(t);
    const timeline = await many(get(`/employment-profiles/${w.id}/assignments`));
    expect(timeline.map((x) => [x.effective_from, x.effective_to, x.state])).toEqual([
      ['2024-03-01', null, 'approved'],
      ['2020-01-01', '2024-02-29', 'approved'],
    ]);
    expect(timeline[1]?.id).toBe(first.id);
    // P13 §12.1 step 2: February's register shows February's division.
    expect(await ok(get(`/employment-profiles/${w.id}/assignments/resolve?as_of=2024-02-15`))).toMatchObject({
      division: { id: div.N },
    });
    expect(await ok(get(`/employment-profiles/${w.id}/assignments/resolve?as_of=2024-03-01`))).toMatchObject({
      division: { id: div.S },
    });
    expect(await ok(get(`/employment-profiles/${w.id}/assignments/resolve`))).toMatchObject({
      division: { id: div.S },
    });
    const before = await get(`/employment-profiles/${w.id}/assignments/resolve?as_of=2019-12-31`);
    expect(before.status, json(before)).toBe(404);
  });

  it('only a draft is changed or deleted; one pending change per profile', async () => {
    const w = await worker();
    const a = await joined(w.id);
    await refused(
      send('patch', `/employment-assignments/${a.id}`, { remarks: 'x' }, a.version),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
    await refused(
      send('delete', `/employment-assignments/${a.id}`, {}, a.version),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
    const d = await draft(w.id, {
      effective_from: '2023-05-01',
      activity_type_id: weeding,
      change_reason: 'other',
    });
    await refused(
      post(w.id, { effective_from: '2023-06-01', change_reason: 'other' }),
      'DUPLICATE_KEY',
      'employment_profile_id',
    );
    const changed = await ok(
      send('patch', `/employment-assignments/${d.id}`, { remarks: 'Moved to weeding gang' }, d.version),
    );
    expect(changed).toMatchObject({
      remarks: 'Moved to weeding gang',
      activity_type: { code: 'WEEDING' },
      version: d.version + 1,
    });
    const stale = await send('patch', `/employment-assignments/${d.id}`, { remarks: 'y' }, d.version);
    expect(stale.status, json(stale)).toBe(409);
    await ok(send('delete', `/employment-assignments/${d.id}`, {}, changed.version), 204);
    await draft(w.id, { effective_from: '2023-06-01', change_reason: 'other' });
  });

  it('an employee needs department and designation; the salary structure totals', async () => {
    const e = await employee();
    await refused(post(e.id, { effective_from: '2020-01-01' }), 'VALIDATION_FAILED', 'department_id');
    await refused(
      post(e.id, {
        effective_from: '2020-01-01',
        department_id: dept.hr,
        designation_id: desig.officer,
        pay_lines: [{ component: 'house_rent', amount: '5000' }],
      }),
      'VALIDATION_FAILED',
      'pay_lines',
    );
    await refused(
      post(e.id, {
        effective_from: '2020-01-01',
        department_id: dept.hr,
        designation_id: desig.officer,
        cost_centre_id: '5',
      }),
      'VALIDATION_FAILED',
      'cost_centre_id',
    );
    const d = await draft(e.id, {
      effective_from: '2020-01-01',
      department_id: dept.hr,
      designation_id: desig.officer,
      pay_lines: [
        { component: 'basic', amount: '30000' },
        { component: 'house_rent', amount: '15000' },
        { component: 'medical', amount: '2500.50' },
      ],
    });
    expect(d).toMatchObject({
      wage_basis: 'monthly',
      total_pay: '47500.5000',
      department: { name: 'HR & Admin' },
    });
    expect(d.pay_lines).toHaveLength(3);
  });

  it('a wage change goes to the submitter’s supervisor (reporting line); the submitter cannot approve it', async () => {
    const e = await employee();
    const d = await draft(e.id, {
      effective_from: '2020-01-01',
      department_id: dept.hr,
      designation_id: desig.officer,
      pay_lines: [{ component: 'basic', amount: '30000' }],
    });
    const s = await submit(d);
    expect(s).toMatchObject({ state: 'submitted', is_wage_change: true, is_retrospective: true });
    expect(s.approval_id).toEqual(expect.any(String));
    // Until approved the profile has no assignment in force.
    expect((await ok(get(`/employment-profiles/${e.id}`))).current_assignment).toBeNull();

    const queue = await many(get('/approvals/pending', BOSS));
    const item = queue.find((q) => q.approval_id === s.approval_id);
    expect(item, JSON.stringify(queue)).toMatchObject({ document_type: 'employment_assignment' });
    const mine = await many(get('/approvals/pending', MANAGER));
    expect(mine.find((q) => q.approval_id === s.approval_id)).toBeUndefined();
    const self = await send(
      'post',
      `/approvals/${String(s.approval_id)}/approve`,
      { step_number: item?.step_number },
      undefined,
      MANAGER,
    );
    expect(self.status, json(self)).toBeGreaterThanOrEqual(403);

    await ok(
      send(
        'post',
        `/approvals/${String(s.approval_id)}/approve`,
        { step_number: item?.step_number },
        undefined,
        BOSS,
      ),
    );
    const done = await ok(get(`/employment-assignments/${d.id}`));
    expect(done).toMatchObject({
      state: 'approved',
      approval_id: null,
      approved_by: { id: BOSS },
      is_current: true,
    });

    // A promotion with the same pay is no wage change: in effect at once.
    const promo = await draft(e.id, {
      effective_from: '2022-07-01',
      designation_id: desig.manager,
      change_reason: 'promotion',
    });
    expect(promo.pay_lines).toEqual([{ component: 'basic', amount: '30000.0000' }]);
    expect(await submit(promo)).toMatchObject({ state: 'approved', is_wage_change: false });
  });

  it('a rejected wage revision leaves the timeline alone; a returned one is a draft again', async () => {
    const w = await worker();
    const first = await joined(w.id);
    const rev = await draft(w.id, {
      effective_from: '2025-01-01',
      base_rate: '250',
      change_reason: 'wage_revision',
    });
    const s = await submit(rev);
    expect(s.state).toBe('submitted');
    const step = (await many(get('/approvals/pending', BOSS))).find(
      (q) => q.approval_id === s.approval_id,
    )?.step_number;
    await ok(
      send(
        'post',
        `/approvals/${String(s.approval_id)}/return`,
        { step_number: step, comment: 'Attach the board minute' },
        undefined,
        BOSS,
      ),
    );
    const back = await ok(get(`/employment-assignments/${rev.id}`));
    expect(back).toMatchObject({ state: 'draft', approval_id: null });
    const again = await submit(
      await ok(
        send('patch', `/employment-assignments/${rev.id}`, { remarks: 'Board minute 12' }, back.version),
      ),
    );
    const step2 = (await many(get('/approvals/pending', BOSS))).find(
      (q) => q.approval_id === again.approval_id,
    )?.step_number;
    await ok(
      send(
        'post',
        `/approvals/${String(again.approval_id)}/reject`,
        { step_number: step2, reason: 'Not in the budget' },
        undefined,
        BOSS,
      ),
    );
    expect(await ok(get(`/employment-assignments/${rev.id}`))).toMatchObject({
      state: 'rejected',
      rejection_reason: 'Not in the budget',
    });
    expect(await ok(get(`/employment-assignments/${first.id}`))).toMatchObject({
      effective_to: null,
      is_current: true,
    });
    // The date is free again after a rejection.
    await draft(w.id, { effective_from: '2025-01-01', base_rate: '240', change_reason: 'wage_revision' });
  });

  it('the joining date is fixed once the profile has an assignment', async () => {
    const w = await worker();
    await joined(w.id);
    const p = await ok(get(`/employment-profiles/${w.id}`));
    const res = await send(
      'patch',
      `/employment-profiles/${w.id}`,
      { joining_date: '2019-06-01' },
      p.version,
    );
    expect(res.status, json(res)).toBe(422);
    expect(errorOf(res).details.map((x) => x.field)).toContain('joining_date');
  });

  it('a section grant sees the profiles assigned there today, and their assignments', async () => {
    const north = await worker();
    await joined(north.id);
    const south = await worker();
    await joined(south.id, { section_id: sec.s1 });
    const moved = await worker();
    await joined(moved.id, { section_id: sec.s1 });
    await submit(
      await draft(moved.id, {
        effective_from: addDays(today, -1),
        section_id: sec.n1,
        change_reason: 'transfer',
      }),
    );

    const seen = (await many(get('/employment-profiles?per_page=500', SECTION_USER))).map((p) => p.id);
    expect(seen).toContain(south.id);
    expect(seen).not.toContain(north.id);
    expect(seen).not.toContain(moved.id);
    expect((await get(`/employment-profiles/${north.id}`, SECTION_USER)).status).toBe(404);
    const rows = await many(get('/employment-assignments?per_page=500', SECTION_USER));
    expect(rows.every((r) => r.section_id === sec.s1)).toBe(true);
    expect(rows.map((r) => r.employment_profile_id)).toContain(moved.id);
  });

  it('the profile list filters by the current assignment; the summary counts by department', async () => {
    const e = await employee();
    await submit(
      await draft(e.id, {
        effective_from: '2020-01-01',
        department_id: dept.field,
        designation_id: desig.officer,
      }),
    );
    const byDept = await many(get(`/employment-profiles?filter[department_id]=${dept.field}`));
    expect(byDept.map((p) => p.id)).toEqual([e.id]);
    const bySection = await many(get(`/employment-profiles?filter[section_id]=${sec.s1}&per_page=500`));
    expect(bySection.length).toBeGreaterThan(0);
    const sum = await ok(get(`/employment-profiles/summary?employment_type=employee&estate_id=${estate.id}`));
    expect(sum.by_department).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Field Operations', count: 1 })]),
    );
  });

  it('a list across profiles answers the pending changes', async () => {
    const w = await worker();
    await joined(w.id);
    const s = await submit(
      await draft(w.id, {
        effective_from: '2026-01-01' as BusinessDate,
        base_rate: '300',
        change_reason: 'wage_revision',
      }),
    );
    const pending = await many(get('/employment-assignments?filter[state]=submitted&per_page=500'));
    expect(pending.find((p) => p.id === s.id)).toMatchObject({
      approval_id: s.approval_id,
      is_wage_change: true,
    });
  });
});

describeScopeLeakage({
  resource: 'employment assignments (section grant)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': SECTION_USER }),
  listPath: '/api/v1/employment-assignments',
  itemPath: (id) => `/api/v1/employment-assignments/${id}`,
  inScope: () => [leak.inAssignment],
  outOfScope: () => [leak.outAssignment],
});

describeScopeLeakage({
  resource: 'employment profiles through the current assignment (section grant)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': SECTION_USER }),
  listPath: '/api/v1/employment-profiles',
  itemPath: (id) => `/api/v1/employment-profiles/${id}`,
  inScope: () => [leak.inProfile],
  outOfScope: () => [leak.outProfile],
});
