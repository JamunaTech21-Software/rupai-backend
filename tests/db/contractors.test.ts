import type { Server } from 'node:http';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { addDays, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { contractExpiryJob } from '../../src/modules/workforce/contractor.jobs.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { describeScopeLeakage } from '../helpers/scope-leakage.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P2.05 — contractors, contracts and contractor labour on real MySQL: the design's Add New Contractor in one
 * request (contact person and first contract), numbering, the contract lifecycle through the approval engine
 * (the verification: a contract above T2 routes to the finance manager), termination, labour within the
 * contract and never an employment profile, blacklisting, the Contractor Management figures, the
 * contract-expiry alert and scope.
 */

const ADMIN = '1';
/** contractor.* (no approve), estate, division; all estates. Creates and submits. */
let CLERK = '';
/** contractor.view + approve; all estates; holds the "estate manager" role of the ladder. */
let ESTATE_MANAGER = '';
/** contractor.view + approve; all estates; the "finance manager" of the ladder. */
let FINANCE = '';
/** contractor.view; estate B only. */
let OTHER = '';
let WF_APPROVER = '';
let mdb: MigratedDatabase;
let server: Server;
let app: Express;
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
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const get = (path: string, actor = CLERK) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = CLERK,
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
  if (field) expect(errorOf(res).details.map((x) => x.field)).toContain(field);
}

let estate = '';
let estateB = '';
let division = '';
let trade = '';
let leak = { inB: '', inA: '' };

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleId: string, scope: object = { scope_type: 'all_estates' }) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: roleId }] }, current.version, ADMIN));
  await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}

const CONTRACTOR = (over: object = {}) => ({
  name: unique('M/S Green Leaf '),
  contractor_type: 'company',
  trade_category_id: trade,
  phone: '+8801712345678',
  address_line1: 'House 12, Tea Garden Road, Sreemangal',
  present_district: 'Moulvibazar',
  trade_licence_number: unique('TL-'),
  bank_name: 'Islami Bank Bangladesh Ltd.',
  bank_branch: 'Sreemangal',
  bank_account_name: 'Green Leaf Services',
  bank_account_number: '05012345678901',
  emergency_contact_name: 'Jahangir Alam',
  emergency_relation: 'brother',
  emergency_phone: '+8801711000099',
  contact_person: { contact_name: 'Mr. Jahangir Alam', designation: 'Proprietor', phone: '+8801712000000' },
  ...over,
});
const CONTRACT = (over: object = {}) => ({
  estate_id: estate,
  work_type: 'plucking',
  rate_basis: 'per_kg',
  rate: '4.50',
  start_date: '2026-01-01',
  end_date: '2026-12-31',
  contract_value: '120000',
  payment_terms: 'monthly',
  work_location: 'field',
  division_id: division,
  ...over,
});
const contractor = (over: object = {}) => ok(send('post', '/contractors', CONTRACTOR(over)), 201);
const contract = (contractorId: string, over: object = {}) =>
  ok(send('post', '/contractor-contracts', { contractor_id: contractorId, ...CONTRACT(over) }), 201);
const submit = (c: Body) => ok(send('post', `/contractor-contracts/${c.id}/submit`, {}, c.version));
async function stepOf(approvalId: string, actor: string) {
  const q = await many(get('/approvals/pending', actor));
  return q.find((i) => i.approval_id === approvalId)?.step_number as number | undefined;
}
const approve = async (approvalId: string, actor: string) =>
  ok(
    send(
      'post',
      `/approvals/${approvalId}/approve`,
      { step_number: await stepOf(approvalId, actor) },
      undefined,
      actor,
    ),
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
  server = app.listen(0, '127.0.0.1');
  const basic = ['contractor', 'estate', 'division'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  CLERK = await user('cc', (await role(basic)).id);
  const em = await role(['contractor.view', 'contractor.approve']);
  const fm = await role(['contractor.view', 'contractor.approve']);
  ESTATE_MANAGER = await user('cem', em.id);
  FINANCE = await user('cfm', fm.id);
  WF_APPROVER = await user('cwf', (await role(['workflow.view', 'workflow.approve'])).id);
  estate = (
    await ok(send('post', '/estates', { code: unique('A'), name: 'Estate A' }, undefined, CLERK), 201)
  ).id;
  estateB = (
    await ok(send('post', '/estates', { code: unique('B'), name: 'Estate B' }, undefined, CLERK), 201)
  ).id;
  OTHER = await user('cot', (await role(['contractor.view'])).id, {
    scope_type: 'estate',
    scope_id: estateB,
  });
  division = (
    await ok(
      send('post', `/estates/${estate}/divisions`, { code: 'N', name: 'North Division' }, undefined, CLERK),
      201,
    )
  ).id;
  trade = (await mdb.migrator.tradeCategory.findFirstOrThrow({ where: { code: 'PLUCKING' } })).id.toString();

  // P7 §9.5 on estate A: the estate manager always, the finance manager from T2 (the proposed 250,001).
  const w = await ok(
    send(
      'post',
      '/workflows',
      {
        code: unique('WF'),
        name: 'Contracts and agreements',
        document_type: 'contractor_contract',
        estate_id: estate,
        effective_from: today,
        steps: [
          { name: 'Estate manager', approver_rule: 'by_role', role_id: em.id },
          {
            name: 'Finance manager',
            approver_rule: 'by_role',
            role_id: fm.id,
            condition: { field: 'contract_value', operator: 'gte', value: '250001' },
          },
        ],
      },
      undefined,
      ADMIN,
    ),
    201,
  );
  await ok(send('post', `/workflows/${w.id}/submit`, {}, undefined, ADMIN));
  await ok(send('post', `/workflows/${w.id}/approve`, {}, undefined, WF_APPROVER));

  const b = await contractor({ registered_estate_id: estateB });
  const a = await contractor();
  await contract(a.id);
  leak = { inB: b.id, inA: a.id };
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('contractors (P2.05)', () => {
  it('registers the design’s form in one request: numbered, contact person primary, first contract drafted', async () => {
    const c = await contractor({
      short_name: 'GLS',
      legal_status: 'proprietorship',
      trade_licence_expiry: addDays(today, 10),
      mobile_banking_provider: 'bkash',
      mobile_banking_number: '+8801712345678',
      safety_compliance: 'compliant',
      quality_rating: 'good',
      first_contract: CONTRACT({ reference_number: 'GL/2026/01' }),
    });
    expect(c.code).toMatch(/^CON-/);
    expect(c).toMatchObject({
      contractor_type: 'company',
      trade_category: { code: 'PLUCKING' },
      contact_person: 'Mr. Jahangir Alam',
      designation: 'Proprietor',
      licence_expiring: true,
      status: 'active',
      current_contract: { status: 'pending', work_location: 'field', division: { name: 'North Division' } },
      number_of_workers: 0,
    });
    const contacts = await many(get(`/contractors/${c.id}/contacts`));
    expect(contacts).toEqual([
      expect.objectContaining({ contact_name: 'Mr. Jahangir Alam', is_primary: true }),
    ]);
    const [k] = await many(get(`/contractors/${c.id}/contracts`));
    expect(k).toMatchObject({
      reference_number: 'GL/2026/01',
      state: 'draft',
      duration_months: 12,
      contract_value: '120000.0000',
    });
    expect(String(k?.contract_number)).toMatch(/^CC-/);
  });

  it('the design’s required fields and the payment checks are enforced', async () => {
    await refused(
      send('post', '/contractors', { ...CONTRACTOR(), trade_licence_number: undefined }),
      'VALIDATION_FAILED',
      'trade_licence_number',
    );
    await refused(
      send('post', '/contractors', CONTRACTOR({ mobile_banking_provider: 'nagad' })),
      'VALIDATION_FAILED',
      'mobile_banking_number',
    );
    await refused(
      send(
        'post',
        '/contractors',
        CONTRACTOR({ first_contract: CONTRACT({ rate_basis: 'lump_sum', contract_value: null }) }),
      ),
      'VALIDATION_FAILED',
      'first_contract.contract_value',
    );
    await refused(
      send('post', '/contractors', CONTRACTOR({ first_contract: CONTRACT({ end_date: '2025-01-01' }) })),
      'VALIDATION_FAILED',
      'first_contract.end_date',
    );
  });

  it('a contract above T2 routes to the finance manager; below it, the estate manager alone approves', async () => {
    const c = await contractor();
    const big = await submit(await contract(c.id, { contract_value: '300000' }));
    expect(big).toMatchObject({ state: 'submitted', status: 'pending' });
    const approval = await ok(get(`/approvals/${String(big.approval_id)}`, ESTATE_MANAGER));
    expect(
      (approval.steps as { name: string; on_path: boolean }[]).filter((s) => s.on_path).map((s) => s.name),
    ).toEqual(['Estate manager', 'Finance manager']);
    expect(await stepOf(String(big.approval_id), FINANCE)).toBeUndefined();
    await approve(String(big.approval_id), ESTATE_MANAGER);
    expect((await ok(get(`/contractor-contracts/${big.id}`))).state).toBe('submitted');
    await approve(String(big.approval_id), FINANCE);
    expect(await ok(get(`/contractor-contracts/${big.id}`))).toMatchObject({
      state: 'approved',
      status: 'active',
      approval_id: null,
    });

    const small = await submit(await contract(c.id, { contract_value: '50000' }));
    const steps = (await ok(get(`/approvals/${String(small.approval_id)}`, ESTATE_MANAGER))).steps as {
      name: string;
      on_path: boolean;
    }[];
    expect(steps.filter((x) => x.on_path).map((x) => x.name)).toEqual(['Estate manager']);
    await approve(String(small.approval_id), ESTATE_MANAGER);
    expect((await ok(get(`/contractor-contracts/${small.id}`))).state).toBe('approved');
  });

  it('only a draft is changed or deleted; a returned contract is a draft again; rejection is final', async () => {
    const c = await contractor();
    const d = await contract(c.id);
    const changed = await ok(send('patch', `/contractor-contracts/${d.id}`, { rate: '5.00' }, d.version));
    expect(changed.rate).toBe('5.0000');
    const s = await submit(changed);
    await refused(
      send('patch', `/contractor-contracts/${s.id}`, { rate: '6' }, s.version),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
    await ok(
      send(
        'post',
        `/approvals/${String(s.approval_id)}/return`,
        { step_number: await stepOf(String(s.approval_id), ESTATE_MANAGER), comment: 'Attach the agreement' },
        undefined,
        ESTATE_MANAGER,
      ),
    );
    const back = await ok(get(`/contractor-contracts/${s.id}`));
    expect(back).toMatchObject({ state: 'draft', approval_id: null });
    const again = await submit(back);
    await ok(
      send(
        'post',
        `/approvals/${String(again.approval_id)}/reject`,
        { step_number: await stepOf(String(again.approval_id), ESTATE_MANAGER), reason: 'Rate too high' },
        undefined,
        ESTATE_MANAGER,
      ),
    );
    expect(await ok(get(`/contractor-contracts/${s.id}`))).toMatchObject({
      state: 'rejected',
      status: 'rejected',
      rejection_reason: 'Rate too high',
    });
    await refused(
      send('delete', `/contractor-contracts/${s.id}`, {}, again.version + 1),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
    const draft = await contract(c.id);
    await ok(send('delete', `/contractor-contracts/${draft.id}`, {}, draft.version), 204);
  });

  it('labour sits within the contract and is never an employment profile; termination ends it', async () => {
    const c = await contractor();
    const k = await submit(
      await contract(c.id, { start_date: addDays(today, -60), end_date: addDays(today, 300) }),
    );
    await approve(String(k.approval_id), ESTATE_MANAGER);
    const l1 = await ok(
      send('post', `/contractor-contracts/${k.id}/labour`, {
        name: 'Abdul Karim',
        national_id: '1985123456',
      }),
      201,
    );
    expect(l1).toMatchObject({
      labour_code: 'L-0001',
      engaged_from: addDays(today, -60),
      engaged_to: null,
      status: 'active',
    });
    await ok(send('post', `/contractor-contracts/${k.id}/labour`, { name: 'Rafiq' }), 201);
    await refused(
      send('post', `/contractor-contracts/${k.id}/labour`, {
        name: 'Late',
        engaged_from: addDays(today, 400),
      }),
      'VALIDATION_FAILED',
      'engaged_from',
    );
    await refused(
      send('post', `/contractor-contracts/${k.id}/labour`, { name: 'Dup', labour_code: 'L-0001' }),
      'DUPLICATE_KEY',
      'labour_code',
    );
    expect((await ok(get(`/contractors/${c.id}`))).number_of_workers).toBe(2);
    expect(await runUnscoped('test', () => mdb.migrator.employmentProfile.count())).toBe(0);

    const live = await ok(get(`/contractor-contracts/${k.id}`));
    await refused(
      send(
        'post',
        `/contractor-contracts/${k.id}/terminate`,
        { terminated_on: addDays(today, 400), reason: 'Poor work' },
        live.version,
        ESTATE_MANAGER,
      ),
      'VALIDATION_FAILED',
      'terminated_on',
    );
    const t = await ok(
      send(
        'post',
        `/contractor-contracts/${k.id}/terminate`,
        { terminated_on: today, reason: 'Poor quality of plucking' },
        live.version,
        ESTATE_MANAGER,
      ),
    );
    expect(t).toMatchObject({ state: 'terminated', status: 'terminated', terminated_on: today });
    const labour = await many(get(`/contractor-contracts/${k.id}/labour`));
    expect(labour.every((l) => l.engaged_to === today)).toBe(true);
    await refused(
      send('post', `/contractor-contracts/${k.id}/labour`, { name: 'After' }),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
  });

  it('a blacklisted contractor takes no contract; a contractor with contracts is not deleted', async () => {
    const c = await contractor();
    await contract(c.id);
    const bl = await ok(
      send(
        'post',
        `/contractors/${c.id}/blacklist`,
        { reason: 'Safety violations' },
        c.version,
        ESTATE_MANAGER,
      ),
    );
    expect(bl).toMatchObject({ status: 'blacklisted', blacklist_reason: 'Safety violations' });
    await refused(
      send('post', '/contractor-contracts', { contractor_id: c.id, ...CONTRACT() }),
      'INVALID_TRANSITION',
      undefined,
      409,
    );
    await refused(send('delete', `/contractors/${c.id}`, {}, bl.version), 'REFERENCED_RECORD');
    const fresh = await contractor();
    await ok(send('delete', `/contractors/${fresh.id}`, {}, fresh.version), 204);
  });

  it('the Contractor Management figures are computed from the rows', async () => {
    const e = (
      await ok(send('post', '/estates', { code: unique('S'), name: 'Summary estate' }, undefined, CLERK), 201)
    ).id;
    const c1 = await contractor({ registered_estate_id: e, contractor_type: 'individual' });
    const c2 = await contractor({ registered_estate_id: e });
    const k1 = await submit(
      await contract(c1.id, {
        estate_id: e,
        division_id: null,
        start_date: addDays(today, -10),
        end_date: addDays(today, 20),
        contract_value: '100000',
      }),
    );
    const k2 = await submit(
      await contract(c2.id, {
        estate_id: e,
        division_id: null,
        work_type: 'transport',
        start_date: addDays(today, -10),
        end_date: addDays(today, 200),
        contract_value: '50000.50',
      }),
    );
    // No workflow on this estate: the seeded reporting-line step leaves them unresolved; approve as the system would.
    for (const k of [k1, k2]) {
      await runUnscoped('test', () =>
        mdb.migrator.contractorContract.update({
          where: { id: BigInt(k.id) },
          data: { state: 'approved', approvedAt: new Date(), approvedBy: 1n },
        }),
      );
    }
    await ok(send('post', `/contractors/${c2.id}/deactivate`, {}, c2.version));
    const s = await ok(get(`/contractors/summary?estate_id=${e}`));
    expect(s).toMatchObject({
      total: 2,
      active: 1,
      inactive: 1,
      contracts_expiring: 1,
      new_this_month: 2,
      total_contract_value: '150000.5000',
    });
    expect(s.by_work_type).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'plucking', count: 1 }),
        expect.objectContaining({ key: 'transport', count: 1 }),
      ]),
    );
    expect(s.by_contractor_type).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'individual', count: 1, percentage: '50.00' })]),
    );
    expect((s.top_contractors as { contractor_id: string }[])[0]?.contractor_id).toBe(c1.id);
    expect(s.expiry_alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ contract_id: k1.id, status: 'expiring_soon', days_left: 20 }),
      ]),
    );
    const list = await many(get(`/contractors?filter[estate_id]=${e}&filter[status]=active`));
    expect(list.map((x) => x.id)).toEqual([c1.id]);
    expect(list[0]?.current_contract).toMatchObject({ status: 'active', contract_value: '100000.0000' });
  });

  it('the contract-expiry alert tells the people who see the estate, once per end date', async () => {
    const rule = await runUnscoped('test', () =>
      mdb.migrator.notificationRule.findFirstOrThrow({ where: { code: 'CONTRACT_EXPIRY' } }),
    );
    expect(rule.isActive).toBe(true);
    const c = await contractor();
    const k = await contract(c.id, { start_date: addDays(today, -30), end_date: addDays(today, 5) });
    await runUnscoped('test', () =>
      mdb.migrator.contractorContract.update({
        where: { id: BigInt(k.id) },
        data: { state: 'approved', submittedAt: new Date(), approvedAt: new Date(), approvedBy: 1n },
      }),
    );
    const job = contractExpiryJob(mdb.db, timezone);
    const run = () =>
      job.run({
        signal: new AbortController().signal,
        logger: silentLogger(),
        progress: () => Promise.resolve(),
      } as never);
    await run();
    await run();
    const notes = await runUnscoped('test', () =>
      mdb.migrator.notification.findMany({
        where: { linkType: 'contractor_contract', linkId: BigInt(k.id) },
      }),
    );
    const forClerk = notes.filter((n) => n.userId === BigInt(CLERK));
    expect(forClerk).toHaveLength(1);
    expect(forClerk[0]?.subject).toContain('ends in 5 days');
    expect(notes.some((n) => n.userId === BigInt(OTHER))).toBe(false);
  });
});

describeScopeLeakage({
  resource: 'contractors (estate grant: registered there or a contract there)',
  app: () => app,
  headers: () => ({ 'X-Test-Actor': OTHER }),
  listPath: '/api/v1/contractors',
  itemPath: (id) => `/api/v1/contractors/${id}`,
  inScope: () => [leak.inB],
  outOfScope: () => [leak.inA],
});
