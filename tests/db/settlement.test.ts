import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction, type Tx } from '../../src/core/db/transaction.js';
import { dec } from '../../src/core/money/decimal.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { writeJournal } from '../../src/core/posting/index.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import {
  adjustSettlement,
  applyAllocations,
  raiseSettlement,
  reverseSettlement,
  saveAllocations,
  unapplyAllocations,
  type RaiseInput,
} from '../../src/core/settlement/index.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { refreshAgeingJob, verifyLedgerJob } from '../../src/modules/accounting/accounting.jobs.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P3.05 — the settlement core on real MySQL: raising items (idempotent per source), draft allocation and
 * its checks, applying under the row lock (the P3 §15.3 invariant, concurrently too), FX per allocation
 * (P9 FX.2, FX.3), reversal of a collection, write-offs and credit notes, reversal of the source, the read
 * API with estate scope and its ageing, no write route, the nightly ageing job with payment_due, and the
 * sub-ledger agreement of the ledger check.
 */

const ADMIN = '1';
let READER = '';
let NARROW = '';
let PAYABLES_ONLY = '';
let mdb: MigratedDatabase;
let server: Server;
let modules: ReturnType<typeof buildModules>;
let timezone = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

interface Body {
  id: string;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 700)}`;
const get = (path: string, actor = READER) => as(request(server).get(`/api/v1${path}`), actor);
async function ok<T = Body>(r: PromiseLike<request.Response>, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
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

async function user(permissions: string[], scope: object = { scope_type: 'all_estates' }): Promise<string> {
  const role = await ok(
    as(request(server).post('/api/v1/roles'), ADMIN).send({ code: unique('R_'), name: 'Probe', permissions }),
    201,
  );
  const u = await mdb.migrator.user.create({
    data: { username: unique('u'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const assign = async (authorisations?: object[]) => {
    const current = await ok<{ version: number }>(get(`/users/${id}`, ADMIN));
    return as(request(server).post(`/api/v1/users/${id}/roles`), ADMIN)
      .set('If-Match', `"${String(current.version)}"`)
      .send({ roles: [{ role_id: role.id }], ...(authorisations ? { authorisations } : {}) });
  };
  let res = await assign();
  if (res.status === 422) {
    const details = (res.body as { error: { details: { context: { key: string } }[] } }).error.details;
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Settlement test' })));
  }
  expect(res.status, json(res)).toBe(200);
  expect((await as(request(server).post(`/api/v1/users/${id}/scopes`), ADMIN).send(scope)).status).toBe(201);
  return id;
}

let today = '' as BusinessDate;
let estateA = 0n;
let estateB = 0n;
let buyer = 0n;
let other = 0n;
let usd = 0n;
let method = 0n;
let sourceSeq = 1000n;
let a = { receivable: 0n, payable: 0n, capital: 0n, bank: 0n };

const raise = (side: 'receivable' | 'payable', over: Partial<RaiseInput> = {}) =>
  tx((t) =>
    raiseSettlement(t, side, {
      sourceType: 'other',
      sourceId: (sourceSeq += 1n),
      party: { type: 'party', id: buyer },
      referenceNumber: unique('REF-'),
      documentDate: addDays(today, -10),
      dueDate: addDays(today, 20),
      amount: dec('1000'),
      actorId: 1n,
      today,
      ...over,
    }),
  );

/** A draft collection (or payment) of `amount` for a party. */
async function document(
  side: 'receivable' | 'payable',
  amount: string,
  over: { partyId?: bigint; currencyId?: bigint; rate?: string; estateId?: bigint | null } = {},
): Promise<bigint> {
  const bdt = await mdb.migrator.currency.findFirstOrThrow({ where: { isBase: true } });
  const period = await mdb.migrator.accountingPeriod.findFirstOrThrow({
    where: {
      periodNumber: { lt: 13 },
      startDate: { lte: new Date(today) },
      endDate: { gte: new Date(today) },
    },
  });
  const rate = over.rate ?? '1';
  const data = {
    partyType: 'party',
    partyId: over.partyId ?? buyer,
    estateId: over.estateId ?? null,
    paymentMethodId: method,
    currencyId: over.currencyId ?? bdt.id,
    exchangeRate: rate,
    amount,
    baseAmount: dec(amount).times(rate).toFixed(4),
    accountingPeriodId: period.id,
    createdBy: 1n,
  };
  const d = new Date(today);
  return side === 'receivable'
    ? (await mdb.db.collection.create({ data: { ...data, collectionDate: d } })).id
    : (await mdb.db.payment.create({ data: { ...data, paymentDate: d } })).id;
}
async function setState(side: 'receivable' | 'payable', id: bigint, state: string) {
  if (side === 'receivable') await mdb.db.collection.update({ where: { id }, data: { state } });
  else await mdb.db.payment.update({ where: { id }, data: { state } });
}
/** Draft → allocations → approved → applied → posted. */
async function settle(
  side: 'receivable' | 'payable',
  docId: bigint,
  allocations: { itemId: bigint; amount: string }[],
) {
  await tx((t) =>
    saveAllocations(
      t,
      side,
      docId,
      allocations.map((x) => ({ itemId: x.itemId, amount: dec(x.amount) })),
      1n,
    ),
  );
  await setState(side, docId, 'approved');
  const applied = await tx((t) => applyAllocations(t, side, docId, { actorId: 1n, today }));
  await setState(side, docId, 'posted');
  return applied;
}
const item = (side: 'receivable' | 'payable', id: bigint) =>
  side === 'receivable'
    ? mdb.migrator.receivable
        .findUniqueOrThrow({ where: { id } })
        .then((r) => ({ ...r, settled: r.receivedAmount }))
    : mdb.migrator.payable
        .findUniqueOrThrow({ where: { id } })
        .then((r) => ({ ...r, settled: r.paidAmount }));

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  timezone = config.timezone;
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  modules = buildModules(deps);
  const app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules,
    authenticate: testActor(),
  });
  server = app.listen(0, '127.0.0.1');

  today = todayIn(timezone);
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
        state: p.number === 13 ? 'future' : p.start <= today ? 'open' : 'future',
        createdBy: 1n,
      })),
    });
  }
  const estate = async (name: string) =>
    (
      await runUnscoped('test', () =>
        mdb.migrator.estate.create({
          data: { organisationId: org.id, code: unique('E'), name, createdBy: 1n },
        }),
      )
    ).id;
  estateA = await estate('Estate A');
  estateB = await estate('Estate B');
  const party = async (name: string) =>
    (
      await mdb.migrator.party.create({
        data: { partyType: 'organisation', code: unique('P'), name, createdBy: 1n },
      })
    ).id;
  buyer = await party('Buyer Ltd');
  other = await party('Other Ltd');
  usd = (await mdb.migrator.currency.findFirstOrThrow({ where: { code: 'USD' } })).id;
  method = (await mdb.migrator.paymentMethod.findFirstOrThrow({ where: { code: 'BANK_TRANSFER' } })).id;

  READER = await user(['receivable.view', 'payable.view', 'accounting.edit']);
  NARROW = await user(['receivable.view'], { scope_type: 'estate', scope_id: estateA.toString() });
  PAYABLES_ONLY = await user(['payable.view']);
  const code = async (c: string) => (await mdb.migrator.account.findUniqueOrThrow({ where: { code: c } })).id;
  a = {
    receivable: await code('1210'),
    payable: await code('2110'),
    capital: await code('3100'),
    bank: await code('1115'),
  };
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('raising a receivable or payable (D-3.05-3 to D-3.05-5)', () => {
  it('raises an open item with its band; the same source again returns it', async () => {
    const first = await raise('receivable', {
      sourceId: 1n,
      documentDate: addDays(today, -75),
      dueDate: addDays(today, -45),
    });
    expect(first.created).toBe(true);
    const again = await raise('receivable', { sourceId: 1n, referenceNumber: 'ANY' });
    expect(again).toEqual({ id: first.id, created: false });
    const r = await item('receivable', first.id);
    expect(r.state).toBe('open');
    expect(r.ageingBand).toBe('31_60');
    expect(r.outstandingAmount?.toString()).toBe('1000');
    expect(r.outstandingBaseAmount?.toString()).toBe('1000');
  });

  it('refuses a foreign source, party type, unknown or unregistered party, and a due date before the document', async () => {
    await refused(raise('receivable', { sourceType: 'supplier_invoice' }), 'VALIDATION_FAILED');
    await refused(raise('receivable', { party: { type: 'contractor', id: buyer } }), 'VALIDATION_FAILED');
    await refused(raise('receivable', { party: { type: 'party', id: 999999n } }), 'VALIDATION_FAILED');
    await refused(raise('receivable', { party: { type: 'buyer', id: 1n } }), 'VALIDATION_FAILED');
    await refused(raise('payable', { dueDate: addDays(today, -30) }), 'VALIDATION_FAILED');
  });
});

describe('allocation (D-3.05-6, P3 §15.3)', () => {
  it('checks a draft, applies at posting and leaves the rest as an advance', async () => {
    const r1 = (await raise('receivable', { amount: dec('600') })).id;
    const r2 = (await raise('receivable', { amount: dec('400') })).id;
    const foreign = (await raise('receivable', { party: { type: 'party', id: other } })).id;
    const c = await document('receivable', '1500');
    const save = (items: { itemId: bigint; amount: string }[]) =>
      tx((t) =>
        saveAllocations(
          t,
          'receivable',
          c,
          items.map((x) => ({ itemId: x.itemId, amount: dec(x.amount) })),
          1n,
        ),
      );
    await refused(save([{ itemId: r1, amount: '600.01' }]), 'ALLOCATION_EXCEEDS_OUTSTANDING');
    await refused(save([{ itemId: foreign, amount: '10' }]), 'ALLOCATION_MISMATCH');
    await refused(
      save([
        { itemId: r1, amount: '10' },
        { itemId: r1, amount: '10' },
      ]),
      'VALIDATION_FAILED',
    );

    const applied = await settle('receivable', c, [
      { itemId: r1, amount: '600' },
      { itemId: r2, amount: '150' },
    ]);
    expect(applied.map((x) => x.amount)).toEqual(['600.0000', '150.0000']);
    const doc = await mdb.migrator.collection.findUniqueOrThrow({ where: { id: c } });
    expect(doc.allocatedAmount.toString()).toBe('750');
    expect(doc.unallocatedAmount?.toString()).toBe('750');
    expect((await item('receivable', r1)).state).toBe('settled');
    expect((await item('receivable', r1)).ageingBand).toBeNull();
    const two = await item('receivable', r2);
    expect(two.state).toBe('partially_settled');
    expect(two.outstandingAmount?.toString()).toBe('250');
    // Posted: its allocations are fixed.
    await refused(save([]), 'INVALID_TRANSITION');
    await refused(
      tx((t) => applyAllocations(t, 'receivable', c, { actorId: 1n, today })),
      'ALREADY_POSTED',
    );
  });

  it('refuses at posting what another collection settled since the draft (under the lock, concurrently)', async () => {
    const r = (await raise('receivable', { amount: dec('500') })).id;
    const c1 = await document('receivable', '500');
    const c2 = await document('receivable', '500');
    for (const c of [c1, c2]) {
      await tx((t) => saveAllocations(t, 'receivable', c, [{ itemId: r, amount: dec('500') }], 1n));
      await setState('receivable', c, 'approved');
    }
    const results = await Promise.allSettled(
      [c1, c2].map((c) => tx((t) => applyAllocations(t, 'receivable', c, { actorId: 1n, today }))),
    );
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((x): x is PromiseRejectedResult => x.status === 'rejected');
    expect(failure?.reason).toMatchObject({ code: 'INVALID_TRANSITION' });
    const after = await item('receivable', r);
    expect(after.settled.toString()).toBe('500');
    expect(after.outstandingAmount?.toString()).toBe('0');
  });

  it('undoes a reversed collection', async () => {
    const r = (await raise('receivable', { amount: dec('800') })).id;
    const c = await document('receivable', '300');
    await settle('receivable', c, [{ itemId: r, amount: '300' }]);
    expect((await item('receivable', r)).state).toBe('partially_settled');
    await tx((t) => unapplyAllocations(t, 'receivable', c, { today }));
    const back = await item('receivable', r);
    expect(back.state).toBe('open');
    expect(back.outstandingAmount?.toString()).toBe('800');
    expect(back.settledBaseAmount.toString()).toBe('0');
  });
});

describe('foreign exchange per allocation (P9 §18, D-3.05-7)', () => {
  it('FX.3 then FX.2: a partial and a final collection of a USD receivable', async () => {
    const r = (
      await raise('receivable', { currencyId: usd, exchangeRate: '121.50000000', amount: dec('12000') })
    ).id;
    expect((await item('receivable', r)).originalBaseAmount.toString()).toBe('1458000');
    const part = await settle(
      'receivable',
      await document('receivable', '5000', { currencyId: usd, rate: '122.3' }),
      [{ itemId: r, amount: '5000' }],
    );
    expect(part[0]).toMatchObject({
      baseAmount: '611500.0000',
      relievedBase: '607500.0000',
      fxGainLoss: '4000.0000',
    });
    const mid = await item('receivable', r);
    expect(mid.outstandingAmount?.toString()).toBe('7000');
    expect(mid.outstandingBaseAmount?.toString()).toBe('850500');
    const rest = await settle(
      'receivable',
      await document('receivable', '7000', { currencyId: usd, rate: '122.3' }),
      [{ itemId: r, amount: '7000' }],
    );
    expect(rest[0]).toMatchObject({ relievedBase: '850500.0000', fxGainLoss: '5600.0000' });
    expect((await item('receivable', r)).outstandingBaseAmount?.toString()).toBe('0');
    // Another currency is refused.
    const bdtDoc = await document('receivable', '10');
    const r2 = (await raise('receivable', { currencyId: usd, exchangeRate: '120', amount: dec('10') })).id;
    await refused(
      tx((t) => saveAllocations(t, 'receivable', bdtDoc, [{ itemId: r2, amount: dec('10') }], 1n)),
      'ALLOCATION_MISMATCH',
    );
  });

  it('a payable paid at a higher rate is a loss', async () => {
    const p = (await raise('payable', { currencyId: usd, exchangeRate: '120', amount: dec('1000') })).id;
    const out = await settle('payable', await document('payable', '1000', { currencyId: usd, rate: '121' }), [
      { itemId: p, amount: '1000' },
    ]);
    expect(out[0]).toMatchObject({
      baseAmount: '121000.0000',
      relievedBase: '120000.0000',
      fxGainLoss: '-1000.0000',
    });
    expect((await item('payable', p)).state).toBe('settled');
  });
});

describe('adjustments and reversal of the source (D-3.05-8, D-3.05-9)', () => {
  it('a credit note reduces, a write-off of the rest closes as written off', async () => {
    const r = (await raise('receivable', { amount: dec('1000') })).id;
    await refused(
      tx((t) => adjustSettlement(t, 'receivable', r, { kind: 'credit_note', amount: dec('1000.01'), today })),
      'ALLOCATION_EXCEEDS_OUTSTANDING',
    );
    const cn = await tx((t) =>
      adjustSettlement(t, 'receivable', r, { kind: 'credit_note', amount: dec('200'), today }),
    );
    expect(cn).toEqual({ relievedBase: '200.0000', state: 'partially_settled' });
    const wo = await tx((t) =>
      adjustSettlement(t, 'receivable', r, { kind: 'write_off', amount: dec('800'), today }),
    );
    expect(wo.state).toBe('written_off');
    const after = await item('receivable', r);
    expect(after.adjustedAmount.toString()).toBe('1000');
    expect(after.outstandingAmount?.toString()).toBe('0');
    await refused(
      tx((t) => adjustSettlement(t, 'receivable', r, { kind: 'write_off', amount: dec('1'), today })),
      'INVALID_TRANSITION',
    );
  });

  it('reverses an untouched item; refuses one with an allocation, even a draft one', async () => {
    const clean = await raise('payable', { sourceType: 'contractor_bill', sourceId: 77n });
    await tx((t) => reverseSettlement(t, 'payable', { sourceType: 'contractor_bill', sourceId: 77n }));
    const gone = await item('payable', clean.id);
    expect(gone.state).toBe('reversed');
    expect(gone.outstandingAmount?.toString()).toBe('0');
    expect(gone.ageingBand).toBeNull();

    const used = await raise('payable', { sourceType: 'contractor_bill', sourceId: 78n });
    const p = await document('payable', '100');
    await tx((t) => saveAllocations(t, 'payable', p, [{ itemId: used.id, amount: dec('100') }], 1n));
    await refused(
      tx((t) => reverseSettlement(t, 'payable', { sourceType: 'contractor_bill', sourceId: 78n })),
      'SETTLEMENT_IN_USE',
    );
  });
});

describe('the read API (D-3.05-14, D-3.05-11)', () => {
  let inA = 0n;
  let inB = 0n;
  let orgWide = 0n;
  beforeAll(async () => {
    inA = (await raise('receivable', { estateId: estateA, dueDate: addDays(today, -5), amount: dec('300') }))
      .id;
    inB = (
      await raise('receivable', {
        estateId: estateB,
        documentDate: addDays(today, -130),
        dueDate: addDays(today, -100),
        amount: dec('700'),
      })
    ).id;
    orgWide = (await raise('receivable', { party: { type: 'party', id: other }, amount: dec('50') })).id;
  });

  it('lists with filters and links to the source; shows one item with its allocations', async () => {
    const res = await get(`/receivables?filter[is_overdue]=true&per_page=200`);
    expect(res.status, json(res)).toBe(200);
    const ids = (res.body as { data: Body[] }).data.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining([inA.toString(), inB.toString()]));
    expect(ids).not.toContain(orgWide.toString());
    const one = await ok(get(`/receivables/${inB.toString()}`));
    expect(one).toMatchObject({
      source_type: 'other',
      party: { type: 'party', name: 'Buyer Ltd' },
      estate: { name: 'Estate B' },
      ageing_band: 'over_90',
      days_overdue: 100,
      received_amount: '0.0000',
      outstanding_amount: '700.0000',
      state: 'open',
    });
    const c = await document('receivable', '100');
    await settle('receivable', c, [{ itemId: inA, amount: '100' }]);
    const allocations = await ok<Body[]>(get(`/receivables/${inA.toString()}/allocations`));
    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      amount: '100.0000',
      applied: true,
      collection: { state: 'posted' },
    });
    const byParty = (
      (await get(`/receivables?filter[party_type]=party&filter[party_id]=${other.toString()}`)).body as {
        data: { id: string; party: { id: string } }[];
      }
    ).data;
    expect(byParty.map((x) => x.id)).toContain(orgWide.toString());
    expect(byParty.every((x) => x.party.id === other.toString())).toBe(true);
  });

  it('applies estate scope: other estates are invisible, organisation-wide items are seen', async () => {
    const list = ((await get('/receivables?per_page=200', NARROW)).body as { data: Body[] }).data.map(
      (x) => x.id,
    );
    expect(list).toContain(inA.toString());
    expect(list).toContain(orgWide.toString());
    expect(list).not.toContain(inB.toString());
    await refusedHttp(get(`/receivables/${inB.toString()}`, NARROW), 404, 'NOT_FOUND');
    await refusedHttp(
      get(`/receivables/ageing?estate_id=${estateB.toString()}`, NARROW),
      403,
      'SCOPE_DENIED',
    );
    await refusedHttp(get('/receivables', PAYABLES_ONLY), 403, 'PERMISSION_DENIED');
    expect((await get('/payables', PAYABLES_ONLY)).status).toBe(200);
  });

  it('sums open items by band, and by party', async () => {
    const ageing = await ok<{
      bands: { band: string; amount: string }[];
      parties: { party: { name: string | null }; total: string; over_90: string }[];
      total: string;
    }>(get(`/receivables/ageing?group_by=party&estate_id=${estateB.toString()}`));
    expect(ageing.bands.find((b) => b.band === 'over_90')?.amount).toBe('700.0000');
    expect(ageing.total).toBe('700.0000');
    expect(ageing.parties).toEqual([
      expect.objectContaining({
        party: expect.objectContaining({ name: 'Buyer Ltd' }),
        over_90: '700.0000',
        total: '700.0000',
      }),
    ]);
  });

  it('declares no write route for receivables or payables (the verification)', () => {
    const routes = modules
      .filter((m) => m.path === '/receivables' || m.path === '/payables')
      .flatMap((m) => (m.routes ?? []).map((r) => r.method));
    expect(routes.length).toBe(8);
    expect(new Set(routes)).toEqual(new Set(['get']));
  });
});

describe('the nightly jobs (D-3.05-11 to D-3.05-13)', () => {
  const ctx = (type: string) => ({
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

  it('re-bands open items and tells people once about payments due and overdue', async () => {
    const r = (await raise('payable', { dueDate: addDays(today, 3), estateId: estateA })).id;
    const late = (await raise('payable', { documentDate: addDays(today, -40), dueDate: addDays(today, -2) }))
      .id;
    // A stale band, as after a day passes.
    await mdb.migrator.payable.update({ where: { id: late }, data: { ageingBand: 'current' } });
    const rule = await mdb.migrator.notificationRule.create({
      data: {
        code: unique('DUE'),
        name: 'Payments due',
        triggerType: 'payment_due',
        leadDays: 7,
        recipientRule: 'by_named_user',
        userId: BigInt(READER),
        createdBy: 1n,
      },
    });
    const job = refreshAgeingJob(mdb.db, timezone);
    await job.run(ctx('accounting.refresh_ageing'));
    await job.run(ctx('accounting.refresh_ageing'));
    expect((await item('payable', late)).ageingBand).toBe('1_30');
    const notes = await runUnscoped('test', () =>
      mdb.migrator.notification.findMany({
        where: { linkType: 'payable', linkId: { in: [r, late] }, notificationRuleId: rule.id },
      }),
    );
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.linkId === r)?.subject).toContain('is due in 3 days');
    expect(notes.find((n) => n.linkId === late)?.subject).toContain('is overdue');
  });

  it('the ledger check compares each sub-ledger with its control accounts', async () => {
    await ok(
      as(request(server).post('/api/v1/accounts/activate-chart'), READER).send({
        signed_off_by: 'Test FCA',
        signed_off_on: '2026-10-24',
        reference: 'T-S',
      }),
    );
    const run = () =>
      verifyLedgerJob(mdb.db).run(ctx('accounting.verify_ledger')) as Promise<{
        state?: string;
        result: { subledgers: { side: string; control: string; subledger: string; agrees: boolean }[] };
      }>;
    // Every item so far was raised without a journal: post what they stand for, side by side.
    const outstanding = async (table: 'receivable' | 'payable') =>
      dec(
        (
          await mdb.db.$queryRawUnsafe<{ t: { toString(): string } | null }[]>(
            `SELECT SUM(outstanding_base_amount) AS t FROM ${table}`,
          )
        )[0]?.t?.toString() ?? '0',
      );
    const ar = await outstanding('receivable');
    const ap = await outstanding('payable');
    await tx((t) =>
      writeJournal(t, {
        journalType: 'opening',
        date: today,
        narration: 'Sub-ledger test',
        actorId: 1n,
        lines: [
          { accountId: a.receivable, side: 'debit', amount: ar, party: { type: 'party', id: buyer } },
          { accountId: a.payable, side: 'credit', amount: ap, party: { type: 'party', id: buyer } },
          { accountId: a.capital, side: ar.greaterThan(ap) ? 'credit' : 'debit', amount: ar.minus(ap).abs() },
        ],
      }),
    );
    const clean = await run();
    expect(
      clean.result.subledgers.every((x) => x.agrees),
      JSON.stringify(clean.result),
    ).toBe(true);
    expect(clean.state).toBeUndefined();
    // A receivable raised without its journal breaks the agreement.
    await raise('receivable', { amount: dec('42') });
    const broken = await run();
    expect(broken.state).toBe('partial');
    expect(broken.result.subledgers.find((x) => x.side === 'receivable')).toMatchObject({ agrees: false });
  });
});
