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
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.08 — benefits and welfare on real MySQL: the Ration Card entitlement approved, the verification (a
 * benefit cannot become a payroll earning without explicit configuration), issues generated and approved
 * within the entitlement's dates, withdrawal, welfare cases approved, disbursed up to the approved amount
 * and closed, and self scope.
 */

const ADMIN = '1';
/** benefit + welfare: view, create, edit, delete, submit; all estates. */
let HR = '';
/** benefit + welfare: view, approve; all estates. */
let APPROVER = '';
/** benefit.view only, linked to a worker profile. */
let WORKER = '';
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
async function refused(r: request.Test, status: number, field?: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  if (field)
    expect(
      (res.body as { error: { details: { field?: string }[] } }).error.details.map((x) => x.field),
    ).toContain(field);
}

let estate = '';
let other = '';
let ration = '';
let housing = '';
let worker = '';

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string, scope?: object) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: roleId }] }, current.version, ADMIN));
  if (scope) await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}
async function profile(estateId = estate) {
  const p = await ok(
    send('post', '/persons', { first_name: unique('B'), registered_estate_id: estateId }),
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
async function decide(approvalId: unknown) {
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
const submit = (path: string, x: Body) => ok(send('post', `${path}/${x.id}/submit`, {}, x.version));
async function approvedEntitlement(over: object = {}) {
  const e = await ok(
    send('post', '/benefit-entitlements', {
      employment_profile_id: worker,
      benefit_type_id: ration,
      effective_from: '2026-01-01',
      quantity_per_period: '3.500',
      employer_cost_per_period: '120',
      ...over,
    }),
    201,
  );
  const s = await submit('/benefit-entitlements', e);
  await decide(s.approval_id);
  return ok(get(`/benefit-entitlements/${e.id}`));
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
  const crud = ['benefit', 'welfare'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete', 'submit'].map((a) => `${m}.${a}`),
  );
  HR = await user(
    'bh',
    (
      await role([
        ...crud,
        'person.view',
        'person.create',
        'employment.view',
        'employment.create',
        'employment.edit',
        'estate.view',
        'estate.create',
        'lookup.view',
        'lookup.edit',
      ])
    ).id,
    { scope_type: 'all_estates' },
  );
  const approverRole = await role(['benefit.view', 'benefit.approve', 'welfare.view', 'welfare.approve']);
  APPROVER = await user('ba', approverRole.id, { scope_type: 'all_estates' });
  WORKER = await user('bw', (await role(['benefit.view'])).id);
  WF = await user('bf', (await role(['workflow.view', 'workflow.approve'])).id, {
    scope_type: 'all_estates',
  });
  estate = (await ok(send('post', '/estates', { code: unique('E'), name: 'Benefit estate' }), 201)).id;
  other = (await ok(send('post', '/estates', { code: unique('O'), name: 'Other estate' }), 201)).id;
  const ids = await runUnscoped('test', async () => ({
    ration: (await mdb.migrator.benefitType.findUniqueOrThrow({ where: { code: 'RATION' } })).id.toString(),
    housing: (await mdb.migrator.benefitType.findUniqueOrThrow({ where: { code: 'HOUSING' } })).id.toString(),
  }));
  ration = ids.ration;
  housing = ids.housing;
  // One-step workflows on the estate: the approver role decides entitlements, issues and cases.
  for (const type of ['benefit_entitlement', 'benefit_issue', 'welfare_case']) {
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
          steps: [{ name: 'Estate manager', approver_rule: 'by_role', role_id: approverRole.id }],
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
  await mdb.migrator.user.update({
    where: { id: BigInt(WORKER) },
    data: { employmentProfileId: BigInt(w.id) },
  });
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('benefits (P2.08)', () => {
  it('the Ration Card: an entitlement with its card no., dealer and dates, approved', async () => {
    const e = await ok(
      send('post', '/benefit-entitlements', {
        employment_profile_id: worker,
        benefit_type_id: housing,
        effective_from: '2026-01-01',
        effective_to: '2026-12-31',
        allocation_reference: 'Q-12, Line 4',
        issuing_office: 'Estate office',
      }),
      201,
    );
    expect(e).toMatchObject({
      state: 'draft',
      benefit_type: { code: 'HOUSING', payroll_treatment: 'not_payroll' },
      allocation_reference: 'Q-12, Line 4',
    });
    await refused(
      send('post', '/benefit-entitlements', {
        employment_profile_id: worker,
        benefit_type_id: housing,
        effective_from: '2026-06-01',
      }),
      422,
      'effective_from',
    );
    const s = await submit('/benefit-entitlements', e);
    expect(s.state).toBe('submitted');
    await decide(s.approval_id);
    expect(await ok(get(`/benefit-entitlements/${e.id}`))).toMatchObject({
      state: 'approved',
      is_current: true,
    });
    await refused(
      send(
        'patch',
        `/benefit-entitlements/${e.id}`,
        { issuing_office: 'x' },
        (await ok(get(`/benefit-entitlements/${e.id}`))).version,
      ),
      409,
    );
  });

  it('a benefit cannot become a payroll earning without explicit configuration', async () => {
    const t = await ok(get(`/lookups/benefit_type/${ration}`));
    expect(t.payroll_treatment).toBe('not_payroll');
    await refused(
      send('patch', `/lookups/benefit_type/${ration}`, { payroll_treatment: 'cash_component' }, t.version),
      422,
    );
    // Even in the database: a payroll treatment needs its pay component type (P3 §23.1).
    await expect(
      runUnscoped('test', () =>
        mdb.migrator.benefitType.update({
          where: { id: BigInt(ration) },
          data: { payrollTreatment: 'cash_component' },
        }),
      ),
    ).rejects.toThrow();
    expect((await ok(get(`/lookups/benefit_type/${ration}`))).payroll_treatment).toBe('not_payroll');
  });

  it('issues: generated for the period within the entitlement, costed from it, approved once per date', async () => {
    const e = await approvedEntitlement();
    const g = await ok(
      send('post', '/benefit-issues/generate', {
        benefit_type_id: ration,
        estate_id: estate,
        issue_date: '2026-03-02',
        period_reference: '2026-W10',
      }),
    );
    expect(g).toMatchObject({ created: 1, existing: 0 });
    expect(
      await ok(
        send('post', '/benefit-issues/generate', {
          benefit_type_id: ration,
          estate_id: estate,
          issue_date: '2026-03-02',
        }),
      ),
    ).toMatchObject({ created: 0, existing: 1 });
    const [issue] = await many(get(`/benefit-issues?filter[benefit_entitlement_id]=${e.id}`));
    expect(issue).toMatchObject({
      quantity: '3.500',
      employer_cost: '120.0000',
      period_reference: '2026-W10',
      state: 'draft',
    });
    await refused(
      send('post', '/benefit-issues', { benefit_entitlement_id: e.id, issue_date: '2026-03-02' }),
      422,
      'issue_date',
    );
    await refused(
      send('post', '/benefit-issues', { benefit_entitlement_id: e.id, issue_date: '2025-12-01' }),
      422,
      'issue_date',
    );
    if (!issue) throw new Error('the generated issue is missing');
    const s = await submit('/benefit-issues', issue);
    await decide(s.approval_id);
    const done = await ok(get(`/benefit-issues/${issue.id}`));
    expect(done.state).toBe('approved');
    const row = await runUnscoped('test', () =>
      mdb.migrator.benefitIssue.findUniqueOrThrow({ where: { id: BigInt(issue.id) } }),
    );
    expect(row.payrollComponentId).toBeNull();

    // Withdrawal: not before an issue already made.
    const live = await ok(get(`/benefit-entitlements/${e.id}`));
    await refused(
      send(
        'post',
        `/benefit-entitlements/${e.id}/withdraw`,
        { effective_to: '2026-02-28', reason: 'Left the line' },
        live.version,
        APPROVER,
      ),
      422,
      'effective_to',
    );
    const wd = await ok(
      send(
        'post',
        `/benefit-entitlements/${e.id}/withdraw`,
        { effective_to: '2026-03-31', reason: 'Moved to the factory quarters' },
        live.version,
        APPROVER,
      ),
    );
    expect(wd).toMatchObject({ state: 'withdrawn', effective_to: '2026-03-31' });
    await refused(
      send('post', '/benefit-issues', { benefit_entitlement_id: e.id, issue_date: '2026-04-06' }),
      422,
      'issue_date',
    );
  });

  it('a worker sees only their own benefits', async () => {
    const someoneElse = await profile();
    await ok(
      send('post', '/benefit-entitlements', {
        employment_profile_id: someoneElse.id,
        benefit_type_id: housing,
        effective_from: '2026-01-01',
      }),
      201,
    );
    const mine = await many(get('/benefit-entitlements?per_page=100', WORKER));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((x) => x.employment_profile_id === worker)).toBe(true);
  });
});

describe('welfare cases (P2.08)', () => {
  it('a case is approved for its requested amount, disbursed up to it, and closed with its outcome', async () => {
    const c = await ok(
      send('post', '/welfare-cases', {
        estate_id: estate,
        beneficiary_type: 'employment_profile',
        beneficiary_id: worker,
        welfare_category: 'medical',
        case_date: today,
        description: 'Surgery at the district hospital',
      }),
      201,
    );
    expect(String(c.case_number)).toMatch(/^WC-/);
    await refused(send('post', `/welfare-cases/${c.id}/submit`, {}, c.version), 422, 'requested_amount');
    const withAmount = await ok(
      send('patch', `/welfare-cases/${c.id}`, { requested_amount: '25000' }, c.version),
    );
    const s = await submit('/welfare-cases', withAmount);
    await decide(s.approval_id);
    const a = await ok(get(`/welfare-cases/${c.id}`));
    expect(a).toMatchObject({
      state: 'approved',
      approved_amount: '25000.0000',
      remaining_amount: '25000.0000',
    });
    const d1 = await ok(send('post', `/welfare-cases/${c.id}/disburse`, { amount: '15000' }, a.version));
    expect(d1).toMatchObject({ disbursed_amount: '15000.0000', remaining_amount: '10000.0000' });
    await refused(
      send('post', `/welfare-cases/${c.id}/disburse`, { amount: '10000.01' }, d1.version),
      422,
      'amount',
    );
    const closed = await ok(
      send('post', `/welfare-cases/${c.id}/close`, { outcome: 'Recovered; returned to work' }, d1.version),
    );
    expect(closed).toMatchObject({ state: 'closed', outcome: 'Recovered; returned to work' });
  });

  it('beneficiaries belong to the case’s estate; a community case names none', async () => {
    const away = await profile(other);
    await refused(
      send('post', '/welfare-cases', {
        estate_id: estate,
        beneficiary_type: 'employment_profile',
        beneficiary_id: away.id,
        welfare_category: 'education',
        case_date: today,
        description: 'Scholarship',
      }),
      422,
      'beneficiary_id',
    );
    await refused(
      send('post', '/welfare-cases', {
        estate_id: estate,
        beneficiary_type: 'community',
        beneficiary_id: worker,
        welfare_category: 'community',
        case_date: today,
        description: 'Tube well',
      }),
      422,
      'beneficiary_id',
    );
    const c = await ok(
      send('post', '/welfare-cases', {
        estate_id: estate,
        beneficiary_type: 'community',
        welfare_category: 'disaster',
        case_date: today,
        description: 'Flood relief for Line 4',
        requested_amount: '80000',
      }),
      201,
    );
    expect(c).toMatchObject({ beneficiary_id: null, beneficiary_name: null });
    await refused(
      send('post', '/welfare-cases', {
        estate_id: estate,
        beneficiary_type: 'community',
        welfare_category: 'disaster',
        case_date: addDays(today, 3),
        description: 'Future',
      }),
      422,
      'case_date',
    );
  });
});
