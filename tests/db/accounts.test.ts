import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { importType } from '../../src/core/imports/registry.js';
import { chartOfAccountsSeeder } from '../../src/modules/accounting/accounts.seed.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P3.01 — the chart of accounts on real MySQL: the P8 seed (199 accounts, inactive, once); the tree rules
 * (a group is never postable — the verification —, nothing under a postable account, four levels, a
 * child of its parent's type, moves rewrite the subtree's paths); system accounts; references from
 * benefit types; the sign-off interlock; replacing the seed (remove-unused + import).
 *
 * The tests run in order: structure first, then the seed is replaced, then the chart is signed off.
 */

const ADMIN = '1';
/** The Administrator holds the system set only (R-01), so an accountant does the chart's work. */
let ACCT = '';
let VIEWER = '';
let SYS = '';
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
const get = (path: string, actor = ACCT) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = ACCT,
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
async function refused(r: PromiseLike<request.Response>, status: number, code: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}
async function account(code: string): Promise<Body> {
  const [a] = await many(get(`/accounts?filter[code]=${code}`));
  if (!a) throw new Error(`no account ${code}`);
  return a;
}
const create = (body: object) => send('post', '/accounts', body);
const patch = async (code: string, body: object) => {
  const a = await account(code);
  return send('patch', `/accounts/${a.id}`, body, a.version);
};

/** A user holding a new role with these permissions; sensitive ones get their named authorisation (P6 §10). */
async function user(permissions: string[]): Promise<string> {
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
    res = await assign(
      details.map((d) => ({ key: d.context.key, reason: 'Chart of accounts test accountant' })),
    );
  }
  expect(res.status, json(res)).toBe(200);
  // The audit trail covers every estate (D-1.19-2).
  await ok(send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
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
  VIEWER = await user(['accounting.view']);
  SYS = await user(['system.view', 'system.create', 'audit.view']);
  ACCT = await user([
    ...['view', 'create', 'edit', 'delete'].map((a) => `accounting.${a}`),
    ...['view', 'create', 'edit'].map((a) => `benefit.${a}`),
  ]);
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('the seed (P3 §31.2, D-3.01-1)', () => {
  it('loads the P8 chart: 199 accounts, all inactive, not signed off', async () => {
    const status = await ok(get('/accounts/chart-status'));
    expect(status).toMatchObject({
      signed_off: false,
      sign_off: null,
      accounts: { total: 199, active: 0, inactive: 199, postable: 169, groups: 30 },
    });
    const ar = await account('1210');
    expect(ar).toMatchObject({
      account_type: 'asset',
      account_subtype: 'current_asset',
      normal_balance: 'debit',
      is_postable: true,
      is_control_account: true,
      control_subledger: 'receivable',
      system_key: 'ar_tea_sales',
      is_system: true,
      level: 4,
      status: 'inactive',
    });
    expect(ar.path).toMatch(/^\/\d+\/\d+\/\d+\/\d+\/$/);
  });

  it('serves the tree: 13 roots, children nested by code', async () => {
    const roots = await many(get('/accounts/tree'));
    expect(roots.map((r) => r.code)).toEqual([
      '1000',
      '2000',
      '3000',
      '4000',
      '5000',
      '6000',
      '7100',
      '7200',
      '7300',
      '9100',
      '9200',
      '9300',
      '9900',
    ]);
    const assets = roots[0] as unknown as { children: { code: string; children: { code: string }[] }[] };
    expect(assets.children.map((c) => c.code)).toEqual(['1100', '1500', '1600']);
    expect(assets.children[0]?.children.map((c) => c.code)).toEqual(['1110', '1200', '1300']);
    const expense = await many(get('/accounts/tree?account_type=expense'));
    expect(expense.map((r) => r.code)).toEqual(['5000', '6000', '7200', '7300']);
  });

  it('lists with filters and search; a viewer reads but cannot write', async () => {
    const control = await many(get('/accounts?filter[is_control_account]=true&per_page=100'));
    expect(control).toHaveLength(16);
    const found = await many(get('/accounts?filter[q]=Plucking', VIEWER));
    expect(found.map((a) => a.code)).toEqual(['5110', '5115']);
    await refused(
      send('post', '/accounts', { code: 'X1', name: 'x', account_type: 'asset' }, undefined, VIEWER),
      403,
      'PERMISSION_DENIED',
    );
  });

  it('runs again without adding anything', async () => {
    const results = await runSeeders(mdb.migrator, [chartOfAccountsSeeder], silentLogger());
    expect(Object.values(results)).toEqual([{ inserted: 0, updated: 0 }]);
    expect((await ok(get('/accounts/chart-status'))).accounts).toMatchObject({ total: 199 });
  });
});

describe('the tree rules (P3 §27.1, P8 §2–§4)', () => {
  it('never makes a group postable while it has children (the verification)', async () => {
    await refused(patch('1110', { is_postable: true }), 422, 'ACCOUNT_HAS_CHILDREN');
    expect((await account('1110')).is_postable).toBe(false);
  });

  it('adds nothing under a postable account', async () => {
    const cash = await account('1111');
    await refused(
      create({ code: unique('C'), name: 'Petty cash', parent_id: cash.id }),
      422,
      'PARENT_IS_POSTABLE',
    );
  });

  it('creates a child with its parent’s type, subtype and the derived balance; inactive before sign-off', async () => {
    const admin = await account('6300');
    const a = await ok(create({ code: '6395', name: 'Estate office sundries', parent_id: admin.id }), 201);
    expect(a).toMatchObject({
      account_type: 'expense',
      account_subtype: 'operating_expense',
      normal_balance: 'debit',
      is_postable: true,
      requires_cost_centre: true,
      level: 3,
      status: 'inactive',
      path: `${String(admin.path)}${a.id}/`,
    });
    await refused(
      create({ code: unique('T'), name: 'Wrong', parent_id: admin.id, account_type: 'asset' }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(create({ code: '6395', name: 'Twice', parent_id: admin.id }), 422, 'DUPLICATE_KEY');
  });

  it('allows four levels and no fifth', async () => {
    const cashBank = await account('1110');
    const group = await ok(
      create({ code: '1120', name: 'Mobile money', parent_id: cashBank.id, is_postable: false }),
      201,
    );
    expect(group.level).toBe(4);
    await refused(
      create({ code: '1121', name: 'bKash', parent_id: group.id }),
      422,
      'ACCOUNT_DEPTH_EXCEEDED',
    );
  });

  it('checks the flags: control with sub-ledger, cash and bank on assets, contra on create', async () => {
    const recv = await account('1200');
    await refused(
      create({ code: unique('K'), name: 'x', parent_id: recv.id, is_control_account: true }),
      422,
      'VALIDATION_FAILED',
    );
    const fx = await account('7200');
    await refused(
      create({ code: unique('B'), name: 'x', parent_id: fx.id, is_bank_or_cash: true }),
      422,
      'VALIDATION_FAILED',
    );
    const contra = await ok(
      create({
        code: '1245',
        name: 'Provision — lease debtors',
        parent_id: recv.id,
        normal_balance: 'credit',
      }),
      201,
    );
    expect(contra.normal_balance).toBe('credit');
    await refused(
      send('patch', `/accounts/${contra.id}`, { normal_balance: 'debit' }, contra.version),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('moves a subtree and rewrites its levels and paths; never under itself or past four levels', async () => {
    const other = await account('1600');
    const group = await ok(
      create({ code: '1650', name: 'Long-term receivables', parent_id: other.id, is_postable: false }),
      201,
    );
    const leaf = await ok(create({ code: '1651', name: 'Staff loans', parent_id: group.id }), 201);
    expect(leaf.level).toBe(4);
    const recv = await account('1200');
    await refused(
      send('patch', `/accounts/${group.id}`, { parent_id: leaf.id }, group.version),
      422,
      'VALIDATION_FAILED',
    );
    const cash = await account('1111');
    await refused(
      send('patch', `/accounts/${group.id}`, { parent_id: cash.id }, group.version),
      422,
      'PARENT_IS_POSTABLE',
    );
    await refused(
      send('patch', `/accounts/${group.id}`, { parent_id: recv.id }, group.version),
      422,
      'ACCOUNT_DEPTH_EXCEEDED',
    );
    const assets = await account('1000');
    const moved = await ok(send('patch', `/accounts/${group.id}`, { parent_id: assets.id }, group.version));
    expect(moved).toMatchObject({ level: 2, path: `${String(assets.path)}${group.id}/` });
    const after = await ok(get(`/accounts/${leaf.id}`));
    expect(after).toMatchObject({ level: 3, path: `${String(assets.path)}${group.id}/${leaf.id}/` });
    const self = await ok(get(`/accounts/${group.id}`));
    await refused(
      send('patch', `/accounts/${group.id}`, { parent_id: group.id }, self.version),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('protects system accounts: kept, active, of their type', async () => {
    const ar = await account('1210');
    await refused(send('delete', `/accounts/${ar.id}`, {}), 422, 'SYSTEM_RECORD');
    await refused(
      patch('1210', { is_control_account: false, control_subledger: null }),
      422,
      'SYSTEM_RECORD',
    );
    const cyr = await account('9900');
    await refused(
      send('patch', `/accounts/${cyr.id}`, { account_type: 'asset' }, cyr.version),
      422,
      'SYSTEM_RECORD',
    );
    // Renamed and re-coded freely before the sign-off.
    const renamed = await ok(
      send('patch', `/accounts/${cyr.id}`, { name: 'Year-end closing account' }, cyr.version),
    );
    expect(renamed.name).toBe('Year-end closing account');
  });

  it('activates nothing before the sign-off, and keeps the sign-off out of /settings', async () => {
    const a = await account('6395');
    await refused(send('post', `/accounts/${a.id}/reactivate`, {}, a.version), 422, 'CHART_NOT_SIGNED_OFF');
    await refused(
      send(
        'post',
        '/settings',
        { key: 'accounting.chart_sign_off', value_type: 'json', value: { forged: true } },
        undefined,
        SYS,
      ),
      422,
      'SYSTEM_RECORD',
    );
    expect((await ok(get('/accounts/chart-status'))).signed_off).toBe(false);
  });
});

describe('references (P8 §2.5)', () => {
  let benefit = '';

  it('benefit types post to a postable expense account only', async () => {
    const housing = await account('6210');
    const group = await account('6200');
    const cash = await account('1111');
    const bt = await ok(
      send('post', '/lookups/benefit_type', {
        code: unique('BT'),
        name: 'Line housing',
        benefit_category: 'housing',
        expense_account_id: housing.id,
      }),
      201,
    );
    benefit = bt.id;
    expect(bt.expense_account_id).toBe(housing.id);
    await refused(
      send('patch', `/lookups/benefit_type/${bt.id}`, { expense_account_id: group.id }, bt.version),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('patch', `/lookups/benefit_type/${bt.id}`, { expense_account_id: cash.id }, bt.version),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('a referenced account is never deleted, made a group, moved or re-typed', async () => {
    const housing = await account('6210');
    expect(benefit).not.toBe('');
    await refused(send('delete', `/accounts/${housing.id}`, {}), 422, 'REFERENCED_RECORD');
    await refused(patch('6210', { is_postable: false }), 422, 'REFERENCED_RECORD');
    const est = await account('6100');
    await refused(patch('6210', { parent_id: est.id }), 422, 'REFERENCED_RECORD');
    // A rename is fine.
    await ok(patch('6210', { name: 'Housing and accommodation — labour lines' }));
  });

  it('deletes an unused leaf, never a group with accounts under it', async () => {
    const a = await account('6395');
    await ok(send('delete', `/accounts/${a.id}`, {}), 204);
    const group = await account('6300');
    await refused(send('delete', `/accounts/${group.id}`, {}), 422, 'REFERENCED_RECORD');
  });
});

describe('replacing the seed with the estate’s chart (O-39, D-3.01-11)', () => {
  it('removes every unused, non-system account; keeps system accounts, their groups and referenced ones', async () => {
    const r = await ok(send('post', '/accounts/remove-unused', {}));
    const remaining = await many(get('/accounts?per_page=500'));
    expect(r.remaining).toBe(remaining.length);
    expect(Number(r.removed)).toBeGreaterThan(100);
    const codes = remaining.map((a) => a.code);
    expect(codes).toContain('1210'); // system
    expect(codes).toContain('1200'); // its group
    expect(codes).toContain('6210'); // used by a benefit type
    expect(codes).not.toContain('1111');
    expect(remaining.filter((a) => !a.is_system && a.is_postable).map((a) => a.code)).toEqual(['6210']);
  });

  it('imports accounts parents first, and re-codes a system account by its key', async () => {
    const t = importType('accounting.account');
    if (!t) throw new Error('accounting.account is not registered');
    const rows: Record<string, string>[] = [
      { code: 'A100', name: 'Debtors', parent: '1100', account_type: '', is_postable: 'no' },
      { code: 'A110', name: 'Tea debtors', parent: 'A100', system_key: 'ar_tea_sales' },
      { code: 'A120', name: 'Sundry debtors', parent: 'A100', is_postable: 'yes' },
      { code: 'A130', name: 'USD account', parent: '1100', is_bank_or_cash: 'yes', currency: 'BDT' },
    ];
    for (const row of rows) {
      const checked = await withTransaction(mdb.db, (tx) => t.check(row, tx));
      expect(checked.ok, JSON.stringify(checked)).toBe(true);
      if (!checked.ok) continue;
      await withTransaction(mdb.db, (tx) => t.commit(checked.value, tx, 1n));
    }
    expect(await account('A110')).toMatchObject({
      system_key: 'ar_tea_sales',
      name: 'Tea debtors',
      level: 4,
    });
    expect(await account('A120')).toMatchObject({ account_type: 'asset', account_subtype: 'current_asset' });
    const bad = await withTransaction(mdb.db, (tx) =>
      t.check({ code: 'A120', name: 'Again', parent: 'A100', is_postable: 'maybe' }, tx),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.map((e) => e.column).sort()).toEqual(['is_postable']);
    const orphan = await withTransaction(mdb.db, (tx) =>
      t.check({ code: 'Z1', name: 'Orphan', parent: '' }, tx),
    );
    expect(orphan.ok).toBe(false);
  });
});

describe('the sign-off interlock (P3 §31.3, D-3.01-9)', () => {
  it('records the sign-off once and activates the chart', async () => {
    const before = await ok(get('/accounts/chart-status'));
    const r = await ok(
      send('post', '/accounts/activate-chart', {
        signed_off_by: 'A. Rahman FCA',
        signed_off_on: '2026-10-24',
        reference: 'AUD/2026/014',
      }),
    );
    expect(r).toMatchObject({ signed_off: true, activated: (before.accounts as { total: number }).total });
    const status = await ok(get('/accounts/chart-status'));
    expect(status).toMatchObject({ signed_off: true, accounts: { inactive: 0 } });
    expect(status.sign_off).toMatchObject({
      signed_off_by: 'A. Rahman FCA',
      reference: 'AUD/2026/014',
      recorded_by: ACCT,
    });
    await refused(
      send('post', '/accounts/activate-chart', {
        signed_off_by: 'B',
        signed_off_on: '2026-10-25',
        reference: 'X',
      }),
      409,
      'ALREADY_APPROVED',
    );
    const history = await mdb.db.statusHistory.count({ where: { recordType: 'account', toState: 'active' } });
    expect(history).toBe((before.accounts as { total: number }).total);
  });

  it('afterwards: new accounts are active, single accounts activate and deactivate, system codes are fixed', async () => {
    const a120 = await account('A120');
    const off = await ok(send('post', `/accounts/${a120.id}/deactivate`, {}, a120.version));
    expect(off.status).toBe('inactive');
    const on = await ok(send('post', `/accounts/${a120.id}/reactivate`, {}, off.version));
    expect(on.status).toBe('active');
    const parent = await account('A100');
    expect(
      (await ok(create({ code: 'A140', name: 'Staff debtors', parent_id: parent.id }), 201)).status,
    ).toBe('active');
    await refused(
      send('post', `/accounts/${parent.id}/deactivate`, {}, parent.version),
      422,
      'INVARIANT_VIOLATED',
    );
    const ar = await account('A110');
    await refused(send('post', `/accounts/${ar.id}/deactivate`, {}, ar.version), 422, 'SYSTEM_RECORD');
    await refused(send('patch', `/accounts/${ar.id}`, { code: 'A111' }, ar.version), 422, 'SYSTEM_RECORD');
    await refused(send('post', '/accounts/remove-unused', {}), 409, 'INVALID_TRANSITION');
  });

  it('audits account changes', async () => {
    const a = await account('A120');
    const changes = await many(
      get(
        `/audit/changes?filter[record_type]=account&filter[record_id]=${a.id}&filter[changed_at][from]=2026-01-01T00:00:00Z&filter[changed_at][to]=2030-01-01T00:00:00Z`,
        SYS,
      ),
    );
    expect(changes.map((c) => c.action)).toContain('create');
  });
});
