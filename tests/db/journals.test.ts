import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { dec } from '../../src/core/money/decimal.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { writeJournal } from '../../src/core/posting/index.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P3.04 — manual journals on real MySQL: drafts (unbalanced allowed, control and group accounts
 * refused), submit (balance, period), the journal workflow (prior period escalates), posting by a holder of
 * journal.post into the ledger, reversal, opening balances, the general ledger with its running balance and
 * cursor, the expense view and the dashboard's Monthly Expense card.
 */

const ADMIN = '1';
let ACCT = '';
let POSTER = '';
let APPROVER = '';
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
const accountId = async (code: string) =>
  (await mdb.db.account.findUniqueOrThrow({ where: { code }, select: { id: true } })).id.toString();

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
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Journal test accountant' })));
  }
  expect(res.status, json(res)).toBe(200);
  // Organisation-wide journals and organisation-tier approvals need all estates.
  expect(
    (await send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN)).status,
  ).toBe(201);
  return id;
}

let today = '' as BusinessDate;
let current = { id: 0n, start: '' as BusinessDate, end: '' as BusinessDate };
let prior = '' as BusinessDate;
let cc = '';
let a = { exp: '', exp2: '', bank: '', accrued: '', control: '', group: '', capital: '' };

const line = (account: string, side: 'debit' | 'credit', amount: string, more: object = {}) => ({
  account_id: account,
  side,
  amount,
  ...more,
});
const draft = (over: object = {}) =>
  ok(
    send('post', '/journals', {
      journal_type: 'manual',
      journal_date: today,
      narration: 'Office expense',
      lines: [line(a.exp, 'debit', '1000.00', { cost_centre_id: cc }), line(a.bank, 'credit', '1000.00')],
      ...over,
    }),
    201,
  );
/** Submits and approves every step as APPROVER; returns the approved journal and the steps taken. */
async function approve(j: Body): Promise<{ journal: Body; steps: number }> {
  const s = await ok(send('post', `/journals/${j.id}/submit`, {}, j.version));
  let steps = 0;
  for (;;) {
    const q = ((await get('/approvals/pending', APPROVER)).body as { data: Body[] }).data;
    const item = q.find((x) => x.approval_id === s.approval_id);
    if (!item) break;
    await ok(
      send(
        'post',
        `/approvals/${String(s.approval_id)}/approve`,
        { step_number: item.step_number },
        undefined,
        APPROVER,
      ),
    );
    steps += 1;
  }
  return { journal: await ok(get(`/journals/${j.id}`)), steps };
}
async function posted(over: object = {}): Promise<Body> {
  const { journal } = await approve(await draft(over));
  return ok(send('post', `/journals/${journal.id}/post`, {}, journal.version, POSTER));
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
  ACCT = await user([
    ...['view', 'create', 'edit', 'delete', 'submit'].map((x) => `journal.${x}`),
    'accounting.view',
    'accounting.edit',
    'dashboard.view',
  ]);
  POSTER = await user(['journal.view', 'journal.post', 'accounting.view']);
  APPROVER = await user(['journal.view', 'journal.approve']);
  const approverRole = {
    id: (await mdb.migrator.userRole.findFirstOrThrow({ where: { userId: BigInt(APPROVER) } })).roleId,
  };

  // The fiscal year covering today (periods up to today's open) and the year before (all open).
  today = todayIn(config.timezone);
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
  const p = await mdb.migrator.accountingPeriod.findFirstOrThrow({
    where: {
      periodNumber: { lt: 13 },
      startDate: { lte: new Date(today) },
      endDate: { gte: new Date(today) },
    },
  });
  current = {
    id: p.id,
    start: p.startDate.toISOString().slice(0, 10) as BusinessDate,
    end: p.endDate.toISOString().slice(0, 10) as BusinessDate,
  };
  prior = addDays(current.start, -5);

  cc = (
    await mdb.migrator.costCentre.create({
      data: { code: 'CC-J', name: 'Journal centre', centreType: 'department', createdBy: 1n },
    })
  ).id.toString();
  a = {
    exp: await accountId('6325'),
    exp2: await accountId('6315'),
    bank: await accountId('1115'),
    accrued: await accountId('2140'),
    control: await accountId('2110'),
    group: await accountId('6300'),
    capital: await accountId('3100'),
  };
  const bdt = await mdb.migrator.currency.findFirstOrThrow({ where: { isBase: true } });
  await mdb.migrator.bankAccount.create({
    data: {
      code: 'BANK-J',
      name: 'Journal bank',
      accountId: BigInt(a.bank),
      accountKind: 'bank',
      bankName: 'Test Bank',
      accountNumber: '1',
      currencyId: bdt.id,
      createdBy: 1n,
    },
  });
  await ok(
    send('post', '/accounts/activate-chart', {
      signed_off_by: 'Test FCA',
      signed_off_on: '2026-10-24',
      reference: 'T-J',
    }),
  );
  // The seeded journal workflow, made the P7 §8.9 ladder: finance manager, then MD for a prior period.
  const w = await mdb.migrator.workflow.findFirstOrThrow({ where: { documentType: 'journal' } });
  await mdb.migrator.workflowStep.updateMany({
    where: { workflowId: w.id },
    data: { approverRule: 'by_role', roleId: approverRole.id, reportingLevel: null },
  });
  await mdb.migrator.workflowStep.create({
    data: {
      workflowId: w.id,
      stepNumber: 2,
      sequence: 2,
      name: 'Managing director',
      approverRule: 'by_role',
      roleId: approverRole.id,
      conditionField: 'is_prior_period',
      conditionOperator: 'eq',
      conditionValue: 'true',
      createdBy: 1n,
    },
  });
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('manual journal drafts (D-3.04-1 to D-3.04-3)', () => {
  it('keeps an unbalanced draft but refuses to submit it (the verification)', async () => {
    const j = await draft({
      lines: [line(a.exp, 'debit', '1000.00', { cost_centre_id: cc }), line(a.bank, 'credit', '999.99')],
    });
    expect(j).toMatchObject({
      state: 'draft',
      journal_number: null,
      is_balanced: false,
      transaction_debit: '1000.0000',
      line_count: 2,
    });
    await refused(send('post', `/journals/${j.id}/submit`, {}, j.version), 422, 'UNBALANCED_JOURNAL');
    const fixed = await ok(
      send(
        'patch',
        `/journals/${j.id}`,
        { lines: [line(a.exp, 'debit', '999.99', { cost_centre_id: cc }), line(a.bank, 'credit', '999.99')] },
        j.version,
      ),
    );
    expect(fixed).toMatchObject({ is_balanced: true, transaction_credit: '999.9900' });
  });

  it('refuses control accounts, groups and automatic journals; needs cost centres at submit', async () => {
    await refused(
      send('post', '/journals', {
        journal_type: 'manual',
        journal_date: today,
        narration: 'Payable by hand',
        lines: [line(a.control, 'credit', '10.00')],
      }),
      422,
      'ACCOUNT_NOT_POSTABLE',
    );
    await refused(
      send('post', '/journals', {
        journal_type: 'manual',
        journal_date: today,
        narration: 'Group',
        lines: [line(a.group, 'debit', '10.00')],
      }),
      422,
      'ACCOUNT_NOT_POSTABLE',
    );
    await refused(
      send('post', '/journals', { journal_type: 'automatic', journal_date: today, narration: 'No' }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('post', '/journals', { journal_type: 'manual', journal_date: today, narration: '' }),
      422,
      'VALIDATION_FAILED',
    );
    const j = await draft({ lines: [line(a.exp, 'debit', '50.00'), line(a.bank, 'credit', '50.00')] });
    await refused(send('post', `/journals/${j.id}/submit`, {}, j.version), 422, 'COST_CENTRE_REQUIRED');
  });

  it('deletes only drafts', async () => {
    const j = await draft();
    const res = await send('delete', `/journals/${j.id}`, {});
    expect(res.status, json(res)).toBe(204);
    await refused(get(`/journals/${j.id}`), 404, 'NOT_FOUND');
  });
});

describe('approval and posting (D-3.04-4, D-3.04-5)', () => {
  it('posts an approved journal into the ledger with a gapless number', async () => {
    const before = await mdb.db.bankAccount.findFirstOrThrow({ where: { code: 'BANK-J' } });
    const j = await draft({ narration: 'Stationery', reference: 'VCH-1' });
    const { journal, steps } = await approve(j);
    expect(steps).toBe(1);
    expect(journal).toMatchObject({ state: 'approved', approved_by: { id: APPROVER } });
    // Approving is not posting: the poster is someone holding journal.post.
    await refused(send('post', `/journals/${j.id}/post`, {}, journal.version), 403, 'PERMISSION_DENIED');
    const p = await ok(send('post', `/journals/${j.id}/post`, {}, journal.version, POSTER));
    expect(p).toMatchObject({
      state: 'posted',
      total_debit: '1000.0000',
      total_credit: '1000.0000',
      posted_by: { id: POSTER },
    });
    expect(String(p.journal_number)).toMatch(/^JV/);
    const lines = p.lines as { base_amount: string; account: { code: string } }[];
    expect(lines.map((l) => [l.account.code, l.base_amount])).toEqual([
      ['6325', '1000.0000'],
      ['1115', '1000.0000'],
    ]);
    const lb = await mdb.db.ledgerBalance.findFirstOrThrow({
      where: { accountId: BigInt(a.exp), accountingPeriodId: current.id, costCentreId: BigInt(cc) },
    });
    expect(lb.periodDebit.toFixed(4)).not.toBe('0.0000');
    const after = await mdb.db.bankAccount.findFirstOrThrow({ where: { code: 'BANK-J' } });
    expect(after.currentBalance.minus(before.currentBalance).toFixed(4)).toBe('-1000.0000');
    // Immutable now.
    await refused(
      send('patch', `/journals/${j.id}`, { narration: 'x' }, p.version),
      409,
      'INVALID_TRANSITION',
    );
    await refused(send('delete', `/journals/${j.id}`, {}), 409, 'INVALID_TRANSITION');
    await refused(send('post', `/journals/${j.id}/post`, {}, p.version, POSTER), 409, 'ALREADY_POSTED');
    const list = (await get('/journals?filter[state]=posted&filter[journal_type]=manual')).body as {
      data: Body[];
    };
    expect(list.data.map((x) => x.id)).toContain(j.id);
  });

  it('escalates a prior-period journal to the second step', async () => {
    const { journal, steps } = await approve(await draft({ journal_date: prior, narration: 'Late bill' }));
    expect(journal.is_prior_period).toBe(true);
    expect(steps).toBe(2);
  });

  it('lets only an adjustment into a soft-closed period', async () => {
    const date = addDays(current.start, -3);
    const manual = await draft({ journal_date: date, narration: 'Manual into soft close' });
    const adj = await draft({ journal_type: 'adjustment', journal_date: date, narration: 'Adjustment' });
    const period = await mdb.migrator.accountingPeriod.findFirstOrThrow({
      where: {
        periodNumber: { lt: 13 },
        startDate: { lte: new Date(date) },
        endDate: { gte: new Date(date) },
      },
    });
    await mdb.migrator.accountingPeriod.update({ where: { id: period.id }, data: { state: 'soft_closed' } });
    try {
      await refused(send('post', `/journals/${manual.id}/submit`, {}, manual.version), 423, 'PERIOD_CLOSED');
      const { journal } = await approve(adj);
      const p = await ok(send('post', `/journals/${adj.id}/post`, {}, journal.version, POSTER));
      expect(p.state).toBe('posted');
    } finally {
      await mdb.migrator.accountingPeriod.update({ where: { id: period.id }, data: { state: 'open' } });
    }
  });
});

describe('reversal (D-3.04-6)', () => {
  it('reverses a posted manual journal once; an automatic journal only through its source', async () => {
    const p = await posted({ narration: 'To reverse' });
    const r = await ok(send('post', `/journals/${p.id}/reverse`, { date: today }, p.version, POSTER));
    expect(r).toMatchObject({ journal_type: 'reversal', state: 'posted', reversal_of: { id: p.id } });
    const lines = r.lines as { side: string; account: { code: string } }[];
    expect(lines.map((l) => [l.account.code, l.side])).toEqual([
      ['6325', 'credit'],
      ['1115', 'debit'],
    ]);
    const original = await ok(get(`/journals/${p.id}`));
    expect(original).toMatchObject({ is_reversed: true, reversed_by: { id: r.id } });
    await refused(
      send('post', `/journals/${p.id}/reverse`, { date: today }, original.version, POSTER),
      409,
      'INVALID_TRANSITION',
    );

    const auto = await withTransaction(mdb.db, (tx) =>
      writeJournal(tx, {
        journalType: 'automatic',
        date: today,
        narration: 'From a document',
        sourceType: 'test_doc',
        sourceId: 1n,
        actorId: 1n,
        lines: [
          { accountId: BigInt(a.exp2), side: 'debit', amount: dec('10'), costCentreId: BigInt(cc) },
          { accountId: BigInt(a.bank), side: 'credit', amount: dec('10') },
        ],
      }),
    );
    const autoOut = await ok(get(`/journals/${auto.id.toString()}`));
    expect(autoOut.journal_type).toBe('automatic');
    await refused(
      send('post', `/journals/${auto.id.toString()}/reverse`, { date: today }, autoOut.version, POSTER),
      409,
      'INVALID_TRANSITION',
    );
  });
});

describe('opening balances (D-3.04-9)', () => {
  it('posting an opening journal writes opening balances, once per combination', async () => {
    const lines = [line(a.bank, 'debit', '500000.00'), line(a.capital, 'credit', '500000.00')];
    const first = await posted({ journal_type: 'opening', narration: 'Opening position', lines });
    const rows = (
      (await get(`/opening-balances?filter[account_id]=${a.bank}`)).body as {
        data: { debit: string; credit: string; source: string; journal: { id: string } }[];
      }
    ).data;
    expect(rows).toEqual([
      expect.objectContaining({
        debit: '500000.0000',
        credit: '0.0000',
        source: 'migration',
        journal: expect.objectContaining({ id: first.id }),
      }),
    ]);
    const { journal } = await approve(await draft({ journal_type: 'opening', narration: 'Again', lines }));
    await refused(
      send('post', `/journals/${journal.id}/post`, {}, journal.version, POSTER),
      422,
      'DUPLICATE_KEY',
    );
    // Reversing the first opening removes its rows; the corrected one then posts.
    await ok(send('post', `/journals/${first.id}/reverse`, { date: today }, first.version, POSTER));
    expect(await mdb.db.openingBalance.count({ where: { journalId: BigInt(first.id) } })).toBe(0);
    const p = await ok(send('post', `/journals/${journal.id}/post`, {}, journal.version, POSTER));
    expect(p.state).toBe('posted');
  });
});

describe('general ledger and expenses (D-3.04-8, D-3.04-10, D-3.04-11)', () => {
  it('shows opening, running balance and closing, page by page', async () => {
    // A fresh account so the figures are this test's own.
    const exp = await accountId('6330');
    await posted({
      narration: 'Travel 1',
      lines: [line(exp, 'debit', '300.00', { cost_centre_id: cc }), line(a.bank, 'credit', '300.00')],
    });
    await posted({
      narration: 'Travel 2',
      lines: [line(exp, 'debit', '200.00', { cost_centre_id: cc }), line(a.bank, 'credit', '200.00')],
    });
    await posted({
      narration: 'Travel refund',
      lines: [line(a.bank, 'debit', '50.00'), line(exp, 'credit', '50.00', { cost_centre_id: cc })],
    });
    const page1 = await ok(get(`/accounts/${exp}/ledger?from=${current.start}&to=${current.end}&limit=2`));
    expect(page1).toMatchObject({
      opening: '0.0000',
      period_debit: '500.0000',
      period_credit: '50.0000',
      closing: '450.0000',
    });
    const l1 = page1.lines as { debit: string; credit: string; balance: string }[];
    expect(l1.map((l) => l.balance)).toEqual(['300.0000', '500.0000']);
    const page2 = await ok(
      get(
        `/accounts/${exp}/ledger?from=${current.start}&to=${current.end}&limit=2&cursor=${String(page1.next_cursor)}`,
      ),
    );
    expect((page2.lines as { balance: string }[]).map((l) => l.balance)).toEqual(['450.0000']);
    expect(page2.next_cursor).toBeNull();
    // A group shows its subtree.
    const group = await ok(get(`/accounts/${a.group}/ledger?from=${current.start}&to=${current.end}`));
    expect(dec(String(group.closing)).greaterThanOrEqualTo(450)).toBe(true);
    await refused(get(`/accounts/${exp}/ledger?from=2000-01-01&to=${current.end}`), 422, 'VALIDATION_FAILED');
  });

  it('groups expenses and makes the Monthly Expense card live', async () => {
    const byAccount = await ok(get(`/accounting/expenses?from=${current.start}&to=${current.end}`));
    const rows = byAccount.rows as { code: string; amount: string }[];
    expect(rows.find((r) => r.code === '6330')?.amount).toBe('450.0000');
    const byCentre = await ok(
      get(`/accounting/expenses?from=${current.start}&to=${current.end}&group_by=cost_centre`),
    );
    expect((byCentre.rows as { code: string }[]).map((r) => r.code)).toContain('CC-J');
    expect(byCentre.total).toBe(byAccount.total);

    const stats = await ok(get('/dashboards/home/panels/stats'));
    const card = (
      stats.data as { metrics: { key: string; value: string | null; available: boolean }[] }
    ).metrics.find((x) => x.key === 'monthly_expense');
    expect(card).toMatchObject({ available: true, value: dec(String(byAccount.total)).toFixed(2) });
  });
});
