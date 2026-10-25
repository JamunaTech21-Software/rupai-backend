import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction, type Tx } from '../../src/core/db/transaction.js';
import { dec } from '../../src/core/money/decimal.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import {
  changeStockState,
  moveStock,
  reverseStockMovements,
  transferStock,
  type MovementContext,
  type MovementLine,
} from '../../src/core/stock/index.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
import { buildModules } from '../../src/modules/index.js';
import { lowStockJob, rebuildBalancesJob } from '../../src/modules/inventory/inventory.jobs.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P4.04 — the stock movement ledger on real MySQL: the raw materials master, the movement service (P9 WA.1
 * end to end, cost assignment, the no-negative-stock refusal under the row lock — concurrently too —
 * ownership in the balance key, transfers, state changes, reversals, the closed period), the immutable
 * ledger (the app account cannot UPDATE or DELETE a movement), the read API with facility scope and its
 * bounded cursor list, no write route, the nightly rebuild and the low_stock alert.
 */

const ADMIN = '1';
/** raw_material.* + inventory.view; warehouse W1 only. */
let KEEPER = '';
/** inventory.view + raw_material.view; all estates. */
let ALL = '';
/** inventory.view; an estate grant only (no store). */
let ESTATE_ONLY = '';
let mdb: MigratedDatabase;
let server: Server;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
let timezone = '';
let today = '' as BusinessDate;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = KEEPER) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = KEEPER,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: PromiseLike<request.Response>, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: Body }).data;
}
async function many(r: PromiseLike<request.Response>) {
  const res = await r;
  expect(res.status, json(res)).toBe(200);
  return res.body as { data: Body[]; meta: { cursor?: { next_cursor: string | null } } };
}
async function refusedHttp(r: PromiseLike<request.Response>, status: number, code: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}
async function refused(p: Promise<unknown>, code: string) {
  await expect(p).rejects.toMatchObject({ code });
}
const tx = <T>(fn: (t: Tx) => Promise<T>) => runUnscoped('test', () => withTransaction(mdb.db, fn));
const unscoped = <T>(fn: () => Promise<T>) => runUnscoped('test', fn);

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(roleId: string, scope: object) {
  const u = await mdb.migrator.user.create({
    data: { username: unique('u'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await ok(get(`/users/${id}`, ADMIN));
  await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: roleId }] }, current.version, ADMIN));
  await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}

let w1 = 0n;
let w2 = 0n;
let estate = 0n;
let kg = 0n;
let opening = 0n;
let damage = 0n;
let sourceSeq = 1000n;

const ctx = (over: Partial<MovementContext> = {}): MovementContext => ({
  source: { type: 'goods_receipt', id: (sourceSeq += 1n) },
  date: today,
  actorId: 1n,
  ...over,
});
async function material(over: object = {}): Promise<Body> {
  return ok(
    send('post', '/raw-materials', {
      name: unique('Urea '),
      material_category: 'fertiliser',
      uom_id: kg.toString(),
      ...over,
    }),
    201,
  );
}
const at = (id: bigint) => ({ type: 'warehouse' as const, id });
const item = (m: Body) => ({ materialClass: 'material' as const, rawMaterialId: BigInt(m.id) });
const line = (m: Body, over: Partial<MovementLine> = {}): MovementLine => ({
  movementType: 'receipt_purchase',
  item: item(m),
  location: at(w1),
  quantity: dec('100'),
  unitCost: dec('10'),
  ...over,
});
const balance = (m: Body, loc = w1, ownership = 'owned', state = 'available') =>
  unscoped(() =>
    mdb.migrator.stockBalance.findFirst({
      where: {
        rawMaterialId: BigInt(m.id),
        locationType: 'warehouse',
        locationId: loc,
        ownership,
        stockState: state,
      },
    }),
  );

/** A balance as fixed strings: quantity, value, average. */
async function holding(m: Body, loc = w1, ownership = 'owned', state = 'available') {
  const b = await balance(m, loc, ownership, state);
  return b ? [b.quantity.toFixed(3), b.value.toFixed(4), b.averageUnitCost.toFixed(4)] : null;
}

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  timezone = config.timezone;
  today = todayIn(timezone);
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  server = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  }).listen(0, '127.0.0.1');

  await unscoped(async () => {
    const org = await mdb.migrator.organisation.findFirstOrThrow({
      select: { id: true, fiscalYearStartMonth: true },
    });
    const [y, m] = today.split('-').map(Number) as [number, number];
    const startYear = m >= org.fiscalYearStartMonth ? y : y - 1;
    for (const year of [startYear - 1, startYear]) {
      const { start, end } = fiscalYearDates(year, org.fiscalYearStartMonth);
      const fy = await mdb.migrator.fiscalYear.create({
        data: {
          organisationId: org.id,
          code: fiscalYearCode(year, org.fiscalYearStartMonth),
          name: `Year ${String(year)}`,
          startDate: new Date(`${start}T00:00:00Z`),
          endDate: new Date(`${end}T00:00:00Z`),
          state: 'open',
          createdBy: 1n,
        },
      });
      await mdb.migrator.accountingPeriod.createMany({
        data: periodsOf(start).map((p) => ({
          fiscalYearId: fy.id,
          periodNumber: p.number,
          name: `${p.name} ${String(year)}`,
          startDate: new Date(`${p.start}T00:00:00Z`),
          endDate: new Date(`${p.end}T00:00:00Z`),
          // Last year's periods are closed: nothing moves into them.
          state:
            year < startYear ? 'closed' : p.number === 13 ? 'future' : p.start <= today ? 'open' : 'future',
          createdBy: 1n,
        })),
      });
    }
    const wh = async (code: string) =>
      (
        await mdb.migrator.warehouse.create({
          data: {
            organisationId: org.id,
            code: unique(code),
            name: `Store ${code}`,
            warehouseType: 'own',
            createdBy: 1n,
          },
        })
      ).id;
    w1 = await wh('W1');
    w2 = await wh('W2');
    estate = (
      await mdb.migrator.estate.create({
        data: { organisationId: org.id, code: unique('E'), name: 'Estate', createdBy: 1n },
      })
    ).id;
    kg = (await mdb.migrator.uom.findFirstOrThrow({ where: { code: 'kg' } })).id;
    opening = (await mdb.migrator.adjustmentReason.findFirstOrThrow({ where: { code: 'OPENING_BALANCE' } }))
      .id;
    damage = (await mdb.migrator.adjustmentReason.findFirstOrThrow({ where: { code: 'DAMAGE' } })).id;
  });

  const keeper = await role([
    ...['view', 'create', 'edit', 'delete'].map((a) => `raw_material.${a}`),
    'inventory.view',
  ]);
  KEEPER = await user(keeper.id, { scope_type: 'warehouse', scope_id: w1.toString() });
  ALL = await user((await role(['inventory.view', 'raw_material.view'])).id, { scope_type: 'all_estates' });
  ESTATE_ONLY = await user((await role(['inventory.view'])).id, {
    scope_type: 'estate',
    scope_id: estate.toString(),
  });
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('raw materials (P3 §12.4)', () => {
  it('creates a material: numbered, unit and category checked, permission enforced', async () => {
    const m = await material({ reorder_level: '50' });
    expect(m.code).toMatch(/^RM-/);
    expect(m).toMatchObject({
      material_category: 'fertiliser',
      uom: { code: 'kg' },
      is_stock_tracked: true,
      reorder_level: '50.000',
      stock: { quantity: '0.000', average_rate: '0.0000', total_cost: '0.0000', below_reorder_level: true },
    });
    await refusedHttp(
      send('post', '/raw-materials', { name: 'X', material_category: 'gold', uom_id: kg.toString() }),
      422,
      'VALIDATION_FAILED',
    );
    await refusedHttp(
      send('post', '/raw-materials', { name: 'X', material_category: 'fuel', uom_id: '999999' }),
      422,
      'VALIDATION_FAILED',
    );
    const capital = await unscoped(() =>
      mdb.migrator.account.findFirstOrThrow({ where: { accountType: 'equity', isPostable: true } }),
    );
    await refusedHttp(
      send('post', '/raw-materials', {
        name: 'X',
        material_category: 'fuel',
        uom_id: kg.toString(),
        expense_account_id: capital.id.toString(),
      }),
      422,
      'VALIDATION_FAILED',
    );
    await refusedHttp(
      send('post', '/raw-materials', {
        code: m.code,
        name: 'Twin',
        material_category: 'fuel',
        uom_id: kg.toString(),
      }),
      422,
      'DUPLICATE_KEY',
    );
    await refusedHttp(
      send(
        'post',
        '/raw-materials',
        { name: 'X', material_category: 'fuel', uom_id: kg.toString() },
        undefined,
        ALL,
      ),
      403,
      'PERMISSION_DENIED',
    );
  });
});

describe('the movement service (P1 §7.4, P9 §16.1)', () => {
  it('VERIFY P9 WA.1: average 107.50, issue 21,500.00, closing 64,500.00', async () => {
    const m = await material({ reorder_level: '10' });
    await tx((t) =>
      moveStock(t, ctx({ source: { type: 'opening_balance', id: 1n } }), [
        line(m, {
          movementType: 'adjustment_increase',
          quantity: dec('500'),
          unitCost: dec('100.00'),
          reasonId: opening,
        }),
      ]),
    );
    const [receipt] = await tx((t) =>
      moveStock(t, ctx(), [line(m, { quantity: dec('300'), unitCost: dec('120.00') })]),
    );
    expect(receipt?.balance.averageUnitCost.toFixed(2)).toBe('107.50');
    const [issue] = await tx((t) =>
      moveStock(t, ctx({ source: { type: 'material_issue', id: 7n } }), [
        line(m, { movementType: 'issue_activity', quantity: dec('200'), unitCost: null }),
      ]),
    );
    expect(issue?.unitCost.toFixed(2)).toBe('107.50');
    expect(issue?.value.toFixed(2)).toBe('21500.00');
    expect(issue?.balance.value.toFixed(2)).toBe('64500.00');
    const b = await balance(m);
    expect([b?.quantity.toFixed(3), b?.value.toFixed(2), b?.averageUnitCost.toFixed(2)]).toEqual([
      '600.000',
      '64500.00',
      '107.50',
    ]);
    expect(await ok(get(`/raw-materials/${m.id}`))).toMatchObject({
      stock: {
        quantity: '600.000',
        average_rate: '107.5000',
        total_cost: '64500.0000',
        below_reorder_level: false,
      },
    });
  });

  it('refuses an issue beyond the balance with available and requested, and writes nothing', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('50') })]));
    const before = await unscoped(() => mdb.migrator.stockMovement.count());
    await expect(
      tx((t) =>
        moveStock(t, ctx({ source: { type: 'material_issue', id: 8n } }), [
          line(m, { movementType: 'issue_activity', quantity: dec('50.001'), unitCost: null }),
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ context: { available: '50.000', requested: '50.001' } }],
    });
    expect(await unscoped(() => mdb.migrator.stockMovement.count())).toBe(before);
    expect((await balance(m))?.quantity.toString()).toBe('50');
  });

  it('two documents issuing the same stock at once: the row lock lets exactly one through (P2 §3.7)', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('600') })]));
    const issue = (n: bigint) =>
      tx((t) =>
        moveStock(t, ctx({ source: { type: 'material_issue', id: n } }), [
          line(m, { movementType: 'issue_activity', quantity: dec('400'), unitCost: null }),
        ]),
      );
    const results = await Promise.allSettled([issue(21n), issue(22n)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'INSUFFICIENT_STOCK' },
    });
    expect((await balance(m))?.quantity.toString()).toBe('200');
  });

  it('assigns cost itself: receipts carry theirs, outbound is at the average, adjustments need a reason', async () => {
    const m = await material();
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { unitCost: null })])),
      'VALIDATION_FAILED',
    );
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { movementType: 'issue_activity', unitCost: dec('5') })])),
      'VALIDATION_FAILED',
    );
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { movementType: 'adjustment_increase', unitCost: dec('5') })])),
      'VALIDATION_FAILED',
    );
    // No average yet and no cost given: refused rather than valued at nothing.
    await refused(
      tx((t) =>
        moveStock(t, ctx(), [
          line(m, { movementType: 'adjustment_increase', unitCost: null, reasonId: opening }),
        ]),
      ),
      'VALIDATION_FAILED',
    );
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('0') })])),
      'VALIDATION_FAILED',
    );
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { location: { type: 'collection_point', id: 1n } })])),
      'VALIDATION_FAILED',
    );
  });

  it('keeps ownership in the balance key: held stock carries no value and owned issues never touch it', async () => {
    const m = await material();
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m, { ownership: 'held', unitCost: dec('9') })])),
      'VALIDATION_FAILED',
    );
    await tx((t) =>
      moveStock(t, ctx(), [line(m, { ownership: 'held', unitCost: dec('0'), quantity: dec('80') })]),
    );
    expect(await holding(m, w1, 'held')).toEqual(['80.000', '0.0000', '0.0000']);
    await refused(
      tx((t) =>
        moveStock(t, ctx(), [
          line(m, { movementType: 'issue_activity', unitCost: null, quantity: dec('1') }),
        ]),
      ),
      'INSUFFICIENT_STOCK',
    );
  });

  it('transfers at the average with no gain or loss, and changes state without a cost effect', async () => {
    const m = await material();
    await tx((t) =>
      moveStock(t, ctx(), [
        line(m, { quantity: dec('3'), unitCost: dec('10') }),
        line(m, { quantity: dec('7'), unitCost: dec('11') }),
      ]),
    );
    const moved = await tx((t) =>
      transferStock(t, ctx({ source: { type: 'leaf_transfer', id: 5n } }), {
        item: item(m),
        from: at(w1),
        to: at(w2),
        quantity: dec('4'),
      }),
    );
    expect(moved.out.unitCost.toFixed(4)).toBe('10.7000');
    expect(moved.in.value.toFixed(4)).toBe(moved.out.value.toFixed(4));
    expect(await holding(m, w2)).toEqual(['4.000', '42.8000', '10.7000']);
    const damaged = await tx((t) =>
      changeStockState(t, ctx(), {
        item: item(m),
        location: at(w1),
        from: 'available',
        to: 'damaged',
        quantity: dec('1'),
        reasonId: damage,
      }),
    );
    expect(damaged.in.value.toFixed(4)).toBe('10.7000');
    expect(await holding(m, w1, 'owned', 'damaged')).toEqual(['1.000', '10.7000', '10.7000']);
    expect((await balance(m))?.quantity.toString()).toBe('5');
  });

  it('reverses a source with compensating movements at their own cost, once', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('500'), unitCost: dec('100') })]));
    const source = { type: 'goods_receipt' as const, id: (sourceSeq += 1n) };
    await tx((t) => moveStock(t, ctx({ source }), [line(m, { quantity: dec('300'), unitCost: dec('120') })]));
    expect((await balance(m))?.averageUnitCost.toString()).toBe('107.5');
    const back = await tx((t) => reverseStockMovements(t, ctx({ source })));
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ direction: 'out' });
    expect(back[0]?.value.toFixed(2)).toBe('36000.00');
    expect(await holding(m)).toEqual(['500.000', '50000.0000', '100.0000']);
    expect(await tx((t) => reverseStockMovements(t, ctx({ source })))).toEqual([]);
    const reversal = await unscoped(() =>
      mdb.migrator.stockMovement.findFirstOrThrow({ where: { id: back[0]?.movementId ?? 0n } }),
    );
    expect(reversal.reversalOfId).not.toBeNull();
  });

  it('refuses a movement into a closed period, and an inactive or untracked material taking stock', async () => {
    const m = await material();
    const lastYear = addDays(today, -400);
    await refused(
      tx((t) => moveStock(t, ctx({ date: lastYear }), [line(m)])),
      'PERIOD_CLOSED',
    );
    const untracked = await material({ is_stock_tracked: false });
    await refused(
      tx((t) => moveStock(t, ctx(), [line(untracked)])),
      'VALIDATION_FAILED',
    );
    const off = await ok(send('post', `/raw-materials/${m.id}/deactivate`, {}, m.version));
    expect(off.status).toBe('inactive');
    await refused(
      tx((t) => moveStock(t, ctx(), [line(m)])),
      'VALIDATION_FAILED',
    );
  });
});

describe('the ledger is immutable and the master protects it (P3 §13.1)', () => {
  it('the app account cannot UPDATE or DELETE a movement', async () => {
    const m = await material();
    const [r] = await tx((t) => moveStock(t, ctx(), [line(m)]));
    const movementId = r?.movementId ?? 0n;
    await expect(
      mdb.db.$executeRaw`UPDATE stock_movement SET quantity = 1 WHERE id = ${movementId}`,
    ).rejects.toThrow();
    await expect(mdb.db.$executeRaw`DELETE FROM stock_movement WHERE id = ${movementId}`).rejects.toThrow();
  });

  it('fixes the unit and tracking once a material has moved, and refuses to delete it', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m)]));
    const ltr = await unscoped(() => mdb.migrator.uom.findFirstOrThrow({ where: { code: 'ltr' } }));
    await refusedHttp(
      send('patch', `/raw-materials/${m.id}`, { uom_id: ltr.id.toString() }, m.version),
      422,
      'VALIDATION_FAILED',
    );
    await refusedHttp(
      send('patch', `/raw-materials/${m.id}`, { is_stock_tracked: false }, m.version),
      422,
      'VALIDATION_FAILED',
    );
    expect(
      (await ok(send('patch', `/raw-materials/${m.id}`, { name: 'Urea (granular)' }, m.version))).name,
    ).toBe('Urea (granular)');
    await refusedHttp(send('delete', `/raw-materials/${m.id}`, {}), 422, 'REFERENCED_RECORD');
    const unused = await material();
    await ok(send('delete', `/raw-materials/${unused.id}`, {}), 204);
  });
});

describe('the read API (P4 §10.3)', () => {
  it('shows balances by the caller’s stores: a W1 grant sees W1, an estate-only grant sees none, all estates sees both', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m), line(m, { location: at(w2) })]));
    const mine = await many(get(`/stock?filter[raw_material_id]=${m.id}`));
    expect(mine.data.map((b) => (b.location as { id: string }).id)).toEqual([w1.toString()]);
    expect((await many(get(`/stock?filter[raw_material_id]=${m.id}`, ESTATE_ONLY))).data).toHaveLength(0);
    const every = await many(get(`/stock?filter[raw_material_id]=${m.id}&filter[in_stock]=true`, ALL));
    expect(every.data).toHaveLength(2);
    expect(every.data[0]).toMatchObject({
      material_class: 'material',
      ownership: 'owned',
      stock_state: 'available',
      quantity: '100.000',
      value: '1000.0000',
      uom_code: 'kg',
    });
    // The design's average rate and total cost follow the same scope.
    expect((await ok(get(`/raw-materials/${m.id}`))).stock).toMatchObject({ quantity: '100.000' });
    expect((await ok(get(`/raw-materials/${m.id}`, ALL))).stock).toMatchObject({ quantity: '200.000' });
  });

  it('lists movements newest first in pages, requires a bounded range, and has no write route', async () => {
    const m = await material();
    await tx((t) =>
      moveStock(t, ctx({ estateId: estate }), [
        line(m, { quantity: dec('1') }),
        line(m, { quantity: dec('2') }),
        line(m, { quantity: dec('3') }),
      ]),
    );
    const range = `filter[moved_at][from]=${addDays(today, -1)}T00:00:00Z&filter[moved_at][to]=${addDays(today, 1)}T00:00:00Z`;
    await refusedHttp(get(`/stock-movements?filter[raw_material_id]=${m.id}`), 422, 'RANGE_REQUIRED');
    const first = await many(get(`/stock-movements?${range}&filter[raw_material_id]=${m.id}&limit=2`));
    expect(first.data.map((x) => x.quantity)).toEqual(['3.000', '2.000']);
    const next = await many(
      get(
        `/stock-movements?${range}&filter[raw_material_id]=${m.id}&limit=2&cursor=${String(first.meta.cursor?.next_cursor)}`,
      ),
    );
    expect(next.data.map((x) => x.quantity)).toEqual(['1.000']);
    // An estate grant sees the movements of its estate (not the store's balance).
    expect(
      (await many(get(`/stock-movements?${range}&filter[raw_material_id]=${m.id}`, ESTATE_ONLY))).data,
    ).toHaveLength(3);
    for (const [method, path] of [
      ['post', '/stock'],
      ['post', '/stock-movements'],
      ['patch', `/stock-movements/1`],
    ] as const) {
      const res = await send(method, path, {}, undefined, ALL);
      expect([404, 405]).toContain(res.status);
    }
  });
});

describe('the nightly jobs', () => {
  const job = (type: string) => ({
    jobId: 1n,
    type,
    payload: {},
    attempt: 1,
    checkpoint: null,
    requestedBy: null,
    logger: silentLogger(),
    signal: new AbortController().signal,
    progress: () => Promise.resolve(),
    once: () => Promise.resolve(true),
  });

  it('rebuilds a balance that diverged from its movements and reports it (P3 §13.2)', async () => {
    const m = await material();
    await tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('10'), unitCost: dec('7') })]));
    const clean = (await rebuildBalancesJob(mdb.db).run(job('inventory.rebuild_balances'))) as {
      state?: string;
    };
    expect(clean.state).toBeUndefined();
    await unscoped(() =>
      mdb.migrator.stockBalance.updateMany({
        where: { rawMaterialId: BigInt(m.id) },
        data: { quantity: '9', value: '1' },
      }),
    );
    const out = (await rebuildBalancesJob(mdb.db).run(job('inventory.rebuild_balances'))) as {
      state?: string;
      result: { discrepancies: { rebuilt: { quantity: string; value: string } }[] };
    };
    expect(out.state).toBe('partial');
    expect(out.result.discrepancies).toEqual([
      expect.objectContaining({ rebuilt: { quantity: '10.000', value: '70.0000' } }),
    ]);
    expect(await holding(m)).toEqual(['10.000', '70.0000', '7.0000']);
    expect((await balance(m))?.lastRebuiltAt).not.toBeNull();
  });

  it('alerts once a day on a material at or below its reorder level', async () => {
    const m = await material({ reorder_level: '20' });
    await tx((t) => moveStock(t, ctx(), [line(m, { quantity: dec('15') })]));
    const rule = await unscoped(() =>
      mdb.migrator.notificationRule.findFirstOrThrow({ where: { triggerType: 'low_stock' } }),
    );
    await unscoped(() =>
      mdb.migrator.notificationRule.update({
        where: { id: rule.id },
        data: { isActive: true, recipientRule: 'by_named_user', userId: BigInt(ALL), roleId: null },
      }),
    );
    await lowStockJob(mdb.db, timezone).run(job('inventory.low_stock'));
    await lowStockJob(mdb.db, timezone).run(job('inventory.low_stock'));
    const sent = await unscoped(() =>
      mdb.migrator.notification.findMany({
        where: { userId: BigInt(ALL), linkType: 'raw_material', linkId: BigInt(m.id) },
      }),
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain(String(m.code));
  });
});
