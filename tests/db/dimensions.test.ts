import type { Server } from 'node:http';

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
 * P3.02 — cost centres, budget heads and bank accounts on real MySQL: the two trees on the lookup engine
 * (estate rules, cycles, depth, active parents), a budget head's account of its type, one bank account per
 * cash-or-bank chart account (the verification), bank account scope, the chart accounts they protect, and
 * the training programme's budget head.
 */

const ADMIN = '1';
let FIN = '';
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
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = FIN) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = FIN,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: PromiseLike<request.Response>, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: Body }).data;
}
const many = async (r: PromiseLike<request.Response>) => {
  const res = await r;
  expect(res.status, json(res)).toBe(200);
  return (res.body as { data: Body[] }).data;
};
async function refused(r: PromiseLike<request.Response>, status: number, code: string, field?: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  const error = (res.body as { error: { code: string; details: { field?: string }[] } }).error;
  expect(error.code).toBe(code);
  if (field) expect(error.details.map((d) => d.field)).toContain(field);
}
const accountId = async (code: string) =>
  (await mdb.db.account.findUniqueOrThrow({ where: { code }, select: { id: true } })).id.toString();

async function user(permissions: string[], scope: object): Promise<string> {
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
  const u = await mdb.migrator.user.create({
    data: { username: unique('u'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const assign = async (authorisations?: object[]) => {
    const current = await ok(get(`/users/${id}`, ADMIN));
    return send(
      'post',
      `/users/${id}/roles`,
      { roles: [{ role_id: role.id }], ...(authorisations ? { authorisations } : {}) },
      current.version,
      ADMIN,
    );
  };
  let res = await assign();
  if (res.status === 422) {
    const details = (res.body as { error: { details: { context: { key: string } }[] } }).error.details;
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Dimensions test user' })));
  }
  expect(res.status, json(res)).toBe(200);
  await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}

let estateA = '';
let estateB = '';

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
  const crud = (m: string) => ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`);
  FIN = await user(
    [
      ...crud('accounting'),
      ...crud('budget'),
      ...crud('bank_account'),
      ...crud('training'),
      'estate.view',
      'estate.create',
    ],
    { scope_type: 'all_estates' },
  );
  estateA = (await ok(send('post', '/estates', { code: unique('A'), name: 'Estate A' }), 201)).id;
  estateB = (await ok(send('post', '/estates', { code: unique('B'), name: 'Estate B' }), 201)).id;
  NARROW = await user(['accounting.view', ...crud('bank_account')], {
    scope_type: 'estate',
    scope_id: estateA,
  });
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

const centre = (body: object, actor = FIN) =>
  send('post', '/lookups/cost_centre', { code: unique('CC'), name: 'Centre', ...body }, undefined, actor);
const head = (body: object) =>
  send('post', '/lookups/budget_head', { code: unique('BH'), name: 'Head', ...body });

describe('cost centres (P3 §26.2, D-3.02-3, D-3.02-4)', () => {
  it('an estate or division centre names its estate; children stay in their parent’s estate', async () => {
    await refused(centre({ centre_type: 'estate' }), 422, 'VALIDATION_FAILED', 'estate_id');
    const top = await ok(centre({ centre_type: 'estate', estate_id: estateA }), 201);
    const div = await ok(
      centre({ centre_type: 'division', estate_id: estateA, parent_cost_centre_id: top.id }),
      201,
    );
    expect(div.parent_cost_centre_id).toBe(top.id);
    await refused(
      centre({ centre_type: 'division', estate_id: estateB, parent_cost_centre_id: top.id }),
      422,
      'VALIDATION_FAILED',
      'parent_cost_centre_id',
    );
    // Under an organisation-wide parent, any estate.
    const org = await ok(centre({ centre_type: 'department' }), 201);
    await ok(centre({ centre_type: 'division', estate_id: estateB, parent_cost_centre_id: org.id }), 201);
    // A centre with children keeps its estate.
    await refused(
      send('patch', `/lookups/cost_centre/${top.id}`, { estate_id: estateB }, top.version),
      422,
      'VALIDATION_FAILED',
      'estate_id',
    );
  });

  it('never sits under itself or its own child, and stops at five levels', async () => {
    let parent = await ok(centre({ centre_type: 'project' }), 201);
    const chain = [parent];
    for (let i = 2; i <= 5; i += 1) {
      parent = await ok(centre({ centre_type: 'project', parent_cost_centre_id: parent.id }), 201);
      chain.push(parent);
    }
    await refused(
      centre({ centre_type: 'project', parent_cost_centre_id: parent.id }),
      422,
      'VALIDATION_FAILED',
    );
    const [root, , grandchild] = chain;
    if (!root || !grandchild) throw new Error('the chain was not built');
    const fresh = await ok(get(`/lookups/cost_centre/${root.id}`));
    await refused(
      send(
        'patch',
        `/lookups/cost_centre/${root.id}`,
        { parent_cost_centre_id: grandchild.id },
        fresh.version,
      ),
      422,
      'VALIDATION_FAILED',
      'parent_cost_centre_id',
    );
  });

  it('is not deactivated while a child is active, nor reactivated under an inactive parent', async () => {
    const p = await ok(centre({ centre_type: 'department' }), 201);
    const c = await ok(centre({ centre_type: 'department', parent_cost_centre_id: p.id }), 201);
    await refused(
      send('post', `/lookups/cost_centre/${p.id}/deactivate`, {}, p.version),
      422,
      'INVARIANT_VIOLATED',
    );
    const cOff = await ok(send('post', `/lookups/cost_centre/${c.id}/deactivate`, {}, c.version));
    await ok(send('post', `/lookups/cost_centre/${p.id}/deactivate`, {}, p.version));
    await refused(
      send('post', `/lookups/cost_centre/${c.id}/reactivate`, {}, cOff.version),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      centre({ centre_type: 'department', parent_cost_centre_id: p.id }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('follows estate scope: organisation-wide and own-estate centres only', async () => {
    const mine = await ok(centre({ centre_type: 'department', estate_id: estateA }), 201);
    const theirs = await ok(centre({ centre_type: 'department', estate_id: estateB }), 201);
    const seen = (await many(get('/lookups/cost_centre?per_page=500', NARROW))).map((c) => c.id);
    expect(seen).toContain(mine.id);
    expect(seen).not.toContain(theirs.id);
    expect(
      (await many(get('/lookups/cost_centre?filter[estate_id][null]=true', NARROW))).length,
    ).toBeGreaterThan(0);
  });
});

describe('budget heads (P3 §26.2, D-3.02-5)', () => {
  it('governs an account of its type, a group included; children share the type', async () => {
    const welfare = await ok(head({ head_type: 'expense', account_id: await accountId('6200') }), 201);
    expect(welfare.is_controlled).toBe(true);
    await ok(
      head({ head_type: 'expense', account_id: await accountId('6240'), parent_head_id: welfare.id }),
      201,
    );
    await refused(
      head({ head_type: 'capital', parent_head_id: welfare.id }),
      422,
      'VALIDATION_FAILED',
      'head_type',
    );
    await refused(
      head({ head_type: 'expense', account_id: await accountId('1515') }),
      422,
      'VALIDATION_FAILED',
      'account_id',
    );
    await ok(head({ head_type: 'capital', account_id: await accountId('1515') }), 201);
    await ok(head({ head_type: 'revenue', account_id: await accountId('4110') }), 201);
  });

  it('protects its chart account (D-3.02-7)', async () => {
    await ok(head({ head_type: 'expense', account_id: await accountId('6250') }), 201);
    const a = await ok(get(`/accounts/${await accountId('6250')}`));
    await refused(send('delete', `/accounts/${a.id}`, {}), 422, 'REFERENCED_RECORD');
  });

  it('is what a training programme’s cost consumes: an active expense head', async () => {
    const expense = await ok(head({ head_type: 'expense' }), 201);
    const capital = await ok(head({ head_type: 'capital' }), 201);
    const programme = (budget_head_id: string) =>
      send('post', '/training-programs', {
        estate_id: estateA,
        title: 'Pruning skills',
        training_type: 'skill',
        start_date: '2026-11-01',
        end_date: '2026-11-02',
        budget_head_id,
      });
    await refused(programme(capital.id), 422, 'VALIDATION_FAILED', 'budget_head_id');
    expect((await ok(programme(expense.id), 201)).budget_head_id).toBe(expense.id);
  });
});

describe('bank accounts (P3 §27.2, D-3.02-6)', () => {
  const bank = (body: object, actor = FIN) =>
    send(
      'post',
      '/bank-accounts',
      {
        code: unique('BK'),
        name: 'Account',
        account_kind: 'bank',
        bank_name: 'Sonali Bank PLC',
        account_number: '0112-0100-1',
        ...body,
      },
      undefined,
      actor,
    );

  it('posts to one postable cash-or-bank account each (the verification)', async () => {
    const b = await ok(bank({ account_id: await accountId('1115'), opening_balance: '2500000' }), 201);
    expect(b).toMatchObject({
      account_code: '1115',
      currency_code: 'BDT',
      opening_balance: '2500000.0000',
      current_balance: '0.0000',
      estate_id: null,
      status: 'active',
    });
    await refused(bank({ account_id: await accountId('1115') }), 422, 'DUPLICATE_KEY', 'account_id');
    for (const code of ['1110', '6210', '1210']) {
      await refused(bank({ account_id: await accountId(code) }), 422, 'VALIDATION_FAILED', 'account_id');
    }
  });

  it('a bank names its bank and number; the currency is the chart account’s', async () => {
    await refused(
      bank({ account_id: await accountId('1116'), bank_name: null }),
      422,
      'VALIDATION_FAILED',
      'bank_name',
    );
    const usd = await mdb.db.currency.findFirst({ where: { code: 'USD' }, select: { id: true } });
    if (usd) {
      await refused(
        bank({ account_id: await accountId('1116'), currency_id: usd.id.toString() }),
        422,
        'VALIDATION_FAILED',
        'currency_id',
      );
    }
    const cash = await ok(
      bank({
        account_id: await accountId('1112'),
        account_kind: 'cash',
        bank_name: null,
        account_number: null,
        estate_id: estateA,
      }),
      201,
    );
    const changed = await ok(
      send('patch', `/bank-accounts/${cash.id}`, { opening_balance: '150000' }, cash.version),
    );
    expect(changed.opening_balance).toBe('150000.0000');
  });

  it('follows estate scope; an organisation-wide account needs all estates to change', async () => {
    await refused(bank({ account_id: await accountId('1117') }, NARROW), 403, 'SCOPE_DENIED');
    const own = await ok(bank({ account_id: await accountId('1117'), estate_id: estateA }, NARROW), 201);
    const theirs = await ok(bank({ account_id: await accountId('1118'), estate_id: estateB }), 201);
    const seen = (await many(get('/bank-accounts', NARROW))).map((b) => b.code);
    expect(seen).toContain(own.code);
    expect(seen).not.toContain(theirs.code);
    const res = await get(`/bank-accounts/${theirs.id}`, NARROW);
    expect(res.status).toBe(404);
  });

  it('protects its chart account, and is deleted while unused', async () => {
    const chart = await ok(get(`/accounts/${await accountId('1119')}`));
    const b = await ok(
      bank({ account_id: chart.id, account_kind: 'cash', bank_name: null, account_number: null }),
      201,
    );
    await refused(send('delete', `/accounts/${chart.id}`, {}), 422, 'REFERENCED_RECORD');
    await ok(send('delete', `/bank-accounts/${b.id}`, {}), 204);
  });
});
