import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { postDocument, reverseJournal, type PostingRequest } from '../../src/core/posting/index.js';
import { registerPostableSource } from '../../src/core/posting/sources.js';
import { parseBusinessDate } from '../../src/core/time/dates.js';
import { verifyLedgerJob } from '../../src/modules/accounting/accounting.jobs.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P3.03 — the posting engine on real MySQL: posting rules (shape, preview, the activation interlock, no
 * self-activation, inactive-only edits); a document posting through its rule into a gapless numbered
 * journal with its posting link, ledger balances and the bank balance; a retry is a no-op; every failed
 * assertion aborts the caller's transaction (cost centre, closed period, no rule); foreign currency;
 * reversal; the nightly verification.
 */

const ADMIN = '1';
let ACCT = '';
let CHECKER = '';
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
  method: 'post' | 'patch' | 'delete',
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
async function refused(r: PromiseLike<request.Response>, status: number, code: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}
/** The engine's error code, from a rejected call. */
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return 'resolved';
}
const accountId = async (code: string) =>
  (await mdb.db.account.findUniqueOrThrow({ where: { code }, select: { id: true } })).id;

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
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Posting test accountant' })));
  }
  expect(res.status, json(res)).toBe(200);
  return id;
}

// A test document: a bank charge, paid from a bank account, on a cost centre.
registerPostableSource({
  key: 'test_bank_charge',
  label: 'Test bank charge',
  phase: 'test',
  purposes: ['expense'],
  amounts: [{ name: 'amount', label: 'Charge' }],
  accountFields: [{ name: 'bank_account', label: 'Paid from' }],
  refs: [],
  conditionFields: [
    { name: 'estate_id', label: 'Estate' },
    { name: 'kind', label: 'Kind' },
  ],
});

let costCentre = 0n;
let bank = 0n;
let usd = 0n;
let ruleId = '';
let fy = { start: '', periods: [] as { id: bigint; number: number; start: string }[] };
let docs = 0n;
const DATE = (offsetMonths: number, day = 10) => {
  const [y, m] = fy.start.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + offsetMonths, day));
  return parseBusinessDate(d.toISOString().slice(0, 10));
};
const charge = (over: Partial<PostingRequest> = {}): PostingRequest => ({
  sourceType: 'test_bank_charge',
  sourceId: (docs += 1n),
  purpose: 'expense',
  date: DATE(0),
  reference: `BC-${docs.toString()}`,
  narration: 'Bank charge',
  amounts: { amount: '250.00' },
  accounts: { bank_account: bank },
  dimensions: { costCentreId: costCentre },
  actorId: 1n,
  ...over,
});
const post = (req: PostingRequest) => withTransaction(mdb.db, (tx) => postDocument(tx, req));

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
  const crud = ['view', 'create', 'edit', 'delete'].map((a) => `accounting.${a}`);
  ACCT = await user(crud);
  CHECKER = await user(['accounting.view', 'accounting.edit']);

  // A fiscal year with periods 1–3 open, the rest future.
  const org = await mdb.migrator.organisation.findFirstOrThrow({
    select: { id: true, fiscalYearStartMonth: true },
  });
  const { start, end } = fiscalYearDates(2030, org.fiscalYearStartMonth);
  const year = await mdb.migrator.fiscalYear.create({
    data: {
      organisationId: org.id,
      code: fiscalYearCode(2030, org.fiscalYearStartMonth),
      name: 'Test year',
      startDate: new Date(`${start}T00:00:00Z`),
      endDate: new Date(`${end}T00:00:00Z`),
      state: 'open',
      createdBy: 1n,
    },
  });
  await mdb.migrator.accountingPeriod.createMany({
    data: periodsOf(start).map((p) => ({
      fiscalYearId: year.id,
      periodNumber: p.number,
      name: p.name,
      startDate: new Date(`${p.start}T00:00:00Z`),
      endDate: new Date(`${p.end}T00:00:00Z`),
      state: p.number <= 3 ? 'open' : 'future',
      createdBy: 1n,
    })),
  });
  fy = {
    start,
    periods: (
      await mdb.migrator.accountingPeriod.findMany({
        where: { fiscalYearId: year.id },
        orderBy: { periodNumber: 'asc' },
      })
    ).map((p) => ({ id: p.id, number: p.periodNumber, start: p.startDate.toISOString().slice(0, 10) })),
  };
  costCentre = (
    await mdb.migrator.costCentre.create({
      data: { code: 'CC-T', name: 'Test centre', centreType: 'department', createdBy: 1n },
    })
  ).id;
  const bdt = await mdb.migrator.currency.findFirstOrThrow({ where: { isBase: true } });
  usd = (await mdb.migrator.currency.findFirstOrThrow({ where: { code: 'USD' } })).id;
  bank = await accountId('1115');
  await mdb.migrator.bankAccount.create({
    data: {
      code: 'BANK-T',
      name: 'Test bank',
      accountId: bank,
      accountKind: 'bank',
      bankName: 'Test Bank',
      accountNumber: '1',
      currencyId: bdt.id,
      createdBy: 1n,
    },
  });
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('posting rules (P3 §27.7, D-3.03-9)', () => {
  it('ships the indicative map, inactive', async () => {
    const rules = (await (await get('/posting-rules?per_page=100')).body) as { data: Body[] };
    expect(rules.data).toHaveLength(17);
    expect(rules.data.every((r) => r.is_active === false)).toBe(true);
    const sources = ((await get('/posting-rules/sources')).body as { data: Body[] }).data.map((s) => s.key);
    expect(sources).toEqual(expect.arrayContaining(['sale', 'payroll_run', 'test_bank_charge']));
  });

  it('checks a rule against its source', async () => {
    const base = {
      rule_code: unique('BAD'),
      name: 'Bad',
      source_type: 'test_bank_charge',
      effective_from: '2020-01-01',
    };
    await refused(
      send('post', '/posting-rules', {
        ...base,
        purpose: 'revenue',
        lines: [
          {
            side: 'debit',
            account_resolution: 'fixed',
            account_id: (await accountId('6360')).toString(),
            amount_source: 'amount',
          },
          {
            side: 'credit',
            account_resolution: 'from_account_field',
            resolution_key: 'bank_account',
            amount_source: 'amount',
          },
        ],
      }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('post', '/posting-rules', {
        ...base,
        purpose: 'expense',
        lines: [
          { side: 'debit', account_resolution: 'fixed', amount_source: 'amount' },
          {
            side: 'credit',
            account_resolution: 'from_account_field',
            resolution_key: 'nowhere',
            amount_source: 'fee',
          },
        ],
      }),
      422,
      'VALIDATION_FAILED',
    );
  });

  it('previews, refuses activation before the sign-off and by its own author, then activates', async () => {
    const rule = await ok(
      send('post', '/posting-rules', {
        rule_code: 'TEST-BANK-CHARGE',
        name: 'Bank charge',
        source_type: 'test_bank_charge',
        purpose: 'expense',
        effective_from: '2020-01-01',
        lines: [
          {
            side: 'debit',
            account_resolution: 'fixed',
            account_id: (await accountId('6360')).toString(),
            amount_source: 'amount',
          },
          {
            side: 'credit',
            account_resolution: 'from_account_field',
            resolution_key: 'bank_account',
            amount_source: 'amount',
          },
        ],
      }),
      201,
    );
    ruleId = rule.id;
    const preview = await ok(
      send('post', `/posting-rules/${rule.id}/preview`, {
        amounts: { amount: '100' },
        accounts: { bank_account: bank.toString() },
      }),
    );
    expect(preview).toMatchObject({
      total_debit: '100.0000',
      total_credit: '100.0000',
      balanced: true,
      unresolved: 0,
    });
    expect((preview.lines as { account_code: string }[]).map((l) => l.account_code)).toEqual([
      '6360',
      '1115',
    ]);

    await refused(
      send('post', `/posting-rules/${rule.id}/activate`, {}, rule.version, CHECKER),
      422,
      'CHART_NOT_SIGNED_OFF',
    );
    await ok(
      send('post', '/accounts/activate-chart', {
        signed_off_by: 'Test FCA',
        signed_off_on: '2026-10-24',
        reference: 'T-1',
      }),
    );
    await refused(
      send('post', `/posting-rules/${rule.id}/activate`, {}, rule.version, ACCT),
      403,
      'SELF_APPROVAL_FORBIDDEN',
    );
    const active = await ok(send('post', `/posting-rules/${rule.id}/activate`, {}, rule.version, CHECKER));
    expect(active).toMatchObject({ is_active: true, approved_by: CHECKER });
    await refused(
      send('patch', `/posting-rules/${rule.id}`, { name: 'Changed' }, active.version),
      409,
      'INVALID_TRANSITION',
    );
  });

  it('a rule using a resolver that has not arrived cannot be activated', async () => {
    const payroll = ((await get('/posting-rules?filter[rule_code]=PAYROLL-EXPENSE')).body as { data: Body[] })
      .data[0];
    if (!payroll) throw new Error('seeded payroll rule missing');
    await refused(
      send('post', `/posting-rules/${payroll.id}/activate`, {}, payroll.version, CHECKER),
      422,
      'VALIDATION_FAILED',
    );
  });
});

describe('posting a document (P1 §7.2, D-3.03-1, D-3.03-2)', () => {
  it('writes a numbered, balanced journal with its link, ledger balance and bank balance', async () => {
    const req = charge();
    const r = await post(req);
    expect(r.alreadyPosted).toBe(false);
    expect(r.journalNumber).toMatch(/^JV/);
    const j = await mdb.db.journal.findUniqueOrThrow({
      where: { id: r.journalId },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    expect(j).toMatchObject({
      state: 'posted',
      journalType: 'automatic',
      sourceType: 'test_bank_charge',
      postingRuleId: BigInt(ruleId),
    });
    expect(j.totalDebit.toFixed(2)).toBe('250.00');
    expect(j.lines.map((l) => [l.debit.toFixed(2), l.credit.toFixed(2), l.costCentreId])).toEqual([
      ['250.00', '0.00', costCentre],
      ['0.00', '250.00', costCentre],
    ]);
    const link = await mdb.db.postingLink.count({
      where: { sourceType: 'test_bank_charge', sourceId: req.sourceId, purpose: 'expense' },
    });
    expect(link).toBe(1);
    const lb = await mdb.db.ledgerBalance.findFirstOrThrow({
      where: { accountId: await accountId('6360'), accountingPeriodId: j.accountingPeriodId },
    });
    expect(lb.periodDebit.toFixed(2)).toBe('250.00');
    const b = await mdb.db.bankAccount.findFirstOrThrow({ where: { accountId: bank } });
    expect(b.currentBalance.toFixed(2)).toBe('-250.00');

    // The retry is a no-op (P1 §7.7).
    const again = await post(req);
    expect(again).toMatchObject({ journalId: r.journalId, alreadyPosted: true });
    expect(
      await mdb.db.journal.count({ where: { sourceType: 'test_bank_charge', sourceId: req.sourceId } }),
    ).toBe(1);
  });

  it('aborts the caller’s transaction on any failed assertion', async () => {
    const before = await mdb.db.journal.count();
    const code_ = unique('CC-PROBE-');
    const code = await codeOf(
      withTransaction(mdb.db, async (tx) => {
        await tx.costCentre.create({
          data: { code: code_, name: 'Probe', centreType: 'project', createdBy: 1n },
        });
        await postDocument(tx, charge({ dimensions: {} }));
      }),
    );
    expect(code).toBe('COST_CENTRE_REQUIRED');
    expect(await mdb.db.costCentre.count({ where: { code: code_ } })).toBe(0);
    expect(await mdb.db.journal.count()).toBe(before);
  });

  it('posts only into an open period (D-3.03-5)', async () => {
    expect(await codeOf(post(charge({ date: DATE(5) })))).toBe('PERIOD_CLOSED'); // future
    const p2 = fy.periods[1];
    if (!p2) throw new Error('no period 2');
    await mdb.migrator.accountingPeriod.update({ where: { id: p2.id }, data: { state: 'closed' } });
    expect(await codeOf(post(charge({ date: DATE(1) })))).toBe('PERIOD_CLOSED');
    await mdb.migrator.accountingPeriod.update({ where: { id: p2.id }, data: { state: 'open' } });
    expect(await codeOf(post(charge({ date: parseBusinessDate('2024-01-01') })))).toBe('PERIOD_CLOSED');
  });

  it('finds no rule when none is active or the conditions do not hold', async () => {
    const rule = await ok(get(`/posting-rules/${ruleId}`));
    await ok(send('post', `/posting-rules/${ruleId}/deactivate`, {}, rule.version, CHECKER));
    expect(await codeOf(post(charge()))).toBe('RULE_NOT_FOUND');
    const off = await ok(get(`/posting-rules/${ruleId}`));
    await ok(
      send(
        'patch',
        `/posting-rules/${ruleId}`,
        { conditions: [{ field: 'kind', operator: 'eq', value: 'fee' }] },
        off.version,
      ),
    );
    const edited = await ok(get(`/posting-rules/${ruleId}`));
    await ok(send('post', `/posting-rules/${ruleId}/activate`, {}, edited.version, CHECKER));
    expect(await codeOf(post(charge({ values: { kind: 'interest' } })))).toBe('RULE_NOT_FOUND');
    expect((await post(charge({ values: { kind: 'fee' } }))).alreadyPosted).toBe(false);
  });

  it('carries a later posting into the openings of the following periods (D-3.03-6)', async () => {
    const acc = await accountId('6360');
    const [p1, p2, p3] = fy.periods;
    if (!p1 || !p2 || !p3) throw new Error('periods missing');
    await post(charge({ date: DATE(2), values: { kind: 'fee' }, amounts: { amount: '40' } }));
    await post(charge({ date: DATE(1), values: { kind: 'fee' }, amounts: { amount: '10' } }));
    const row = (periodId: bigint) =>
      mdb.db.ledgerBalance.findFirstOrThrow({
        where: { accountId: acc, accountingPeriodId: periodId, costCentreId: costCentre },
      });
    const r1 = await row(p1.id);
    const r2 = await row(p2.id);
    const r3 = await row(p3.id);
    expect(r2.openingDebit.toFixed(2)).toBe(r1.closingDebit.toFixed(2));
    expect(r3.openingDebit.toFixed(2)).toBe(r2.closingDebit.toFixed(2));
    expect(r3.closingDebit.minus(r3.openingDebit).toFixed(2)).toBe('40.00');
  });

  it('converts foreign currency at the document’s rate (D-3.03-8)', async () => {
    const r = await post(
      charge({
        values: { kind: 'fee' },
        currencyId: usd,
        exchangeRate: '110.12345678',
        amounts: { amount: '10' },
      }),
    );
    const j = await mdb.db.journal.findUniqueOrThrow({
      where: { id: r.journalId },
      include: { lines: true },
    });
    expect(j.exchangeRate.toFixed(8)).toBe('110.12345678');
    expect(j.totalDebit.toFixed(4)).toBe('1101.2346');
    expect(j.lines.every((l) => l.transactionDebit.plus(l.transactionCredit).toFixed(2) === '10.00')).toBe(
      true,
    );
  });

  it('reverses a journal once, with the lines swapped (D-3.03-7)', async () => {
    const r = await post(charge({ values: { kind: 'fee' }, amounts: { amount: '75' } }));
    const rev = await withTransaction(mdb.db, (tx) =>
      reverseJournal(tx, r.journalId, { date: DATE(0, 20), actorId: 1n }),
    );
    const original = await mdb.db.journal.findUniqueOrThrow({ where: { id: r.journalId } });
    const reversal = await mdb.db.journal.findUniqueOrThrow({
      where: { id: rev.id },
      include: { lines: { orderBy: { lineNumber: 'asc' } } },
    });
    expect(original.isReversed).toBe(true);
    expect(reversal).toMatchObject({ journalType: 'reversal', reversalOfId: r.journalId });
    expect(reversal.lines.map((l) => l.credit.toFixed(2))).toEqual(['75.00', '0.00']);
    expect(
      await codeOf(
        withTransaction(mdb.db, (tx) => reverseJournal(tx, r.journalId, { date: DATE(0, 20), actorId: 1n })),
      ),
    ).toBe('INVALID_TRANSITION');
  });

  it('fixes an account once it has postings (P8 §2.5)', async () => {
    const a = await ok(get(`/accounts/${(await accountId('6360')).toString()}`));
    await refused(send('delete', `/accounts/${a.id}`, {}), 422, 'REFERENCED_RECORD');
    await refused(send('patch', `/accounts/${a.id}`, { code: '6361' }, a.version), 422, 'REFERENCED_RECORD');
    const other = await ok(get(`/accounts/${(await accountId('6100')).toString()}`));
    await refused(
      send('patch', `/accounts/${a.id}`, { parent_id: other.id }, a.version),
      422,
      'REFERENCED_RECORD',
    );
  });
});

describe('the nightly verification (P3 §27.6)', () => {
  const run = () =>
    verifyLedgerJob(mdb.db).run({
      jobId: 1n,
      type: 'accounting.verify_ledger',
      payload: {},
      attempt: 1,
      checkpoint: null,
      requestedBy: null,
      logger: silentLogger(),
      signal: new AbortController().signal,
      progress: () => Promise.resolve(),
      once: () => Promise.resolve(true),
    });

  it('finds every journal balanced and every balance equal to its lines; reports a divergence', async () => {
    const clean = (await run()) as {
      state?: string;
      result: { journals_checked: number; diverging_balances: unknown[] };
    };
    expect(clean.state).toBeUndefined();
    expect(clean.result.journals_checked).toBeGreaterThan(3);
    expect(clean.result.diverging_balances).toEqual([]);
    const row = await mdb.migrator.ledgerBalance.findFirstOrThrow();
    await mdb.migrator.ledgerBalance.update({
      where: { id: row.id },
      data: { periodDebit: row.periodDebit.plus(1) },
    });
    const broken = (await run()) as { state?: string; result: { diverging_balances: unknown[] } };
    expect(broken.state).toBe('partial');
    expect(broken.result.diverging_balances).toHaveLength(1);
    await mdb.migrator.ledgerBalance.update({
      where: { id: row.id },
      data: { periodDebit: row.periodDebit },
    });
  });
});
