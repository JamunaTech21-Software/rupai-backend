import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import {
  checkAvailability,
  recordConsumption,
  reverseConsumption,
  type RecordInput,
} from '../../src/core/budget/index.js';
import { withTransaction, type Tx } from '../../src/core/db/transaction.js';
import { dec } from '../../src/core/money/decimal.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { budgetControlService } from '../../src/modules/budget/budget-control.service.js';
import { budgetThresholdJob } from '../../src/modules/budget/budget.jobs.js';
import { fiscalYearCode, fiscalYearDates, periodsOf } from '../../src/modules/calendar/fiscal.service.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P3.06 — budgets on real MySQL: drafts (heads of the budget's type, 12 months summing to the annual),
 * the budget workflow and release, one active budget per dimension, P9 BU.1, the two-stage consumption
 * contract (idempotent, partial release, reversal), control modes (warn, require_approval, block —
 * the verification), line resolution (ancestor head, cost centre, organisation-wide), revisions carrying
 * figures, budget controls by approval, manual journals consuming actuals, vs actual and the threshold job.
 */

const ADMIN = '1';
let PLANNER = '';
let APPROVER = '';
let JOURNALIST = '';
let mdb: MigratedDatabase;
let server: Server;
let timezone = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 900)}`;
const get = (path: string, actor = PLANNER) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = PLANNER,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok<T = Body>(r: PromiseLike<request.Response>, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
}
async function refused(r: PromiseLike<request.Response>, status: number, code: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect((res.body as { error: { code: string } }).error.code).toBe(code);
}
const tx = <T>(fn: (t: Tx) => Promise<T>) => runUnscoped('test', () => withTransaction(mdb.db, fn));
const record = (input: Omit<RecordInput, 'actorId' | 'date'> & { date?: BusinessDate }) =>
  tx((t) => recordConsumption(t, { date: today, actorId: 1n, ...input }));

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
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Budget test' })));
  }
  expect(res.status, json(res)).toBe(200);
  expect(
    (await send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN)).status,
  ).toBe(201);
  return id;
}

let today = '' as BusinessDate;
let fy = '';
let estate = 0n;
const e = { bu: 0n, journal: 0n, threshold: 0n };
let cc = '';
let cc2 = '';
const h = { admin: '', stationery: '', welfare: '', revenue: '', capital: '', capital2: '', loose: '' };

/** Approves every pending step of an approval as APPROVER. */
async function approveAll(approvalId: unknown) {
  for (;;) {
    const q = ((await get('/approvals/pending', APPROVER)).body as { data: Body[] }).data;
    const item = q.find((x) => x.approval_id === approvalId);
    if (!item) return;
    await ok(
      send(
        'post',
        `/approvals/${String(approvalId)}/approve`,
        { step_number: item.step_number },
        undefined,
        APPROVER,
      ),
    );
  }
}
const line = (head: string, annual: string, more: object = {}) => ({
  budget_head_id: head,
  annual_amount: annual,
  ...more,
});
const draft = (over: object = {}) =>
  ok(
    send('post', '/budgets', {
      fiscal_year_id: fy,
      name: 'Operating budget',
      budget_type: 'operating',
      lines: [line(h.admin, '120000.00')],
      ...over,
    }),
    201,
  );
/** Draft → submitted → approved → active. */
async function released(over: object = {}): Promise<Body> {
  const d = await draft(over);
  const s = await ok(send('post', `/budgets/${d.id}/submit`, {}, d.version));
  await approveAll(s.approval_id);
  const a = await ok(get(`/budgets/${d.id}`));
  expect(a.state).toBe('approved');
  return ok(send('post', `/budgets/${d.id}/activate`, {}, a.version, APPROVER));
}
const lineOf = async (budgetId: string, head: string) => {
  const b = await ok<{ lines: (Body & { budget_head: { id: string } })[] }>(get(`/budgets/${budgetId}`));
  const l = b.lines.find((x) => x.budget_head.id === head);
  if (!l) throw new Error('line missing');
  return l;
};

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
  const app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  server = app.listen(0, '127.0.0.1');
  PLANNER = await user([
    ...['view', 'create', 'edit', 'delete', 'submit'].map((x) => `budget.${x}`),
    ...['view', 'create', 'edit'].map((x) => `budget_control.${x}`),
    'accounting.view',
    'accounting.edit',
  ]);
  APPROVER = await user([
    'budget.view',
    'budget.approve',
    'budget_control.view',
    'budget_control.approve',
    'journal.view',
    'journal.approve',
  ]);
  JOURNALIST = await user([
    'journal.view',
    'journal.create',
    'journal.edit',
    'journal.submit',
    'journal.post',
  ]);
  const approverRole = (await mdb.migrator.userRole.findFirstOrThrow({ where: { userId: BigInt(APPROVER) } }))
    .roleId;

  today = todayIn(timezone);
  const org = await mdb.migrator.organisation.findFirstOrThrow({
    select: { id: true, fiscalYearStartMonth: true },
  });
  const [y, m] = today.split('-').map(Number) as [number, number];
  const year = m >= org.fiscalYearStartMonth ? y : y - 1;
  const { start, end } = fiscalYearDates(year, org.fiscalYearStartMonth);
  const f = await mdb.migrator.fiscalYear.create({
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
  fy = f.id.toString();
  await mdb.migrator.accountingPeriod.createMany({
    data: periodsOf(start).map((p) => ({
      fiscalYearId: f.id,
      periodNumber: p.number,
      name: `${p.name} ${String(year)}`,
      startDate: new Date(`${p.start}T00:00:00Z`),
      endDate: new Date(`${p.end}T00:00:00Z`),
      state: p.number === 13 ? 'future' : p.start <= today ? 'open' : 'future',
      createdBy: 1n,
    })),
  });
  const newEstate = async (name: string) =>
    (
      await runUnscoped('test', () =>
        mdb.migrator.estate.create({
          data: { organisationId: org.id, code: unique('E'), name, createdBy: 1n },
        }),
      )
    ).id;
  estate = await newEstate('Budget estate');
  e.bu = await newEstate('BU estate');
  e.journal = await newEstate('Journal estate');
  e.threshold = await newEstate('Threshold estate');
  cc = (
    await mdb.migrator.costCentre.create({
      data: { code: 'CC-B', name: 'Budget centre', centreType: 'department', createdBy: 1n },
    })
  ).id.toString();
  cc2 = (
    await mdb.migrator.costCentre.create({
      data: { code: 'CC-B2', name: 'Second centre', centreType: 'department', createdBy: 1n },
    })
  ).id.toString();
  const head = async (code: string, headType: string, parent?: string, isControlled = true) =>
    (
      await mdb.migrator.budgetHead.create({
        data: {
          code,
          name: `${code} head`,
          headType,
          parentHeadId: parent ? BigInt(parent) : null,
          isControlled,
          createdBy: 1n,
        },
      })
    ).id.toString();
  h.admin = await head('BH-ADM', 'expense');
  h.stationery = await head('BH-STAT', 'expense', h.admin);
  h.welfare = await head('BH-WEL', 'expense');
  h.revenue = await head('BH-REV', 'revenue');
  h.capital = await head('BH-CAP', 'capital');
  h.capital2 = await head('BH-CAP2', 'capital');
  h.loose = await head('BH-LOOSE', 'expense', undefined, false);

  // The budget and budget_control workflows, approved by the approver role.
  for (const documentType of ['budget', 'budget_control', 'journal']) {
    const w = await mdb.migrator.workflow.findFirstOrThrow({ where: { documentType } });
    await mdb.migrator.workflowStep.updateMany({
      where: { workflowId: w.id },
      data: { approverRule: 'by_role', roleId: approverRole, reportingLevel: null },
    });
  }
  await ok(
    send('post', '/accounts/activate-chart', {
      signed_off_by: 'Test FCA',
      signed_off_on: '2026-10-24',
      reference: 'T-B',
    }),
  );
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('budget drafts (D-3.06-1 to D-3.06-4)', () => {
  it('spreads the annual amount evenly, numbers the budget, and checks heads, centres and sums', async () => {
    const d = await draft({
      estate_id: estate.toString(),
      lines: [line(h.admin, '1000.00', { cost_centre_id: cc })],
    });
    expect(d.budget_code).toMatch(/^BUD-/);
    const l = await lineOf(d.id, h.admin);
    const months = (l.allocations as { amount: string }[]).map((a) => a.amount);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('83.3300');
    expect(months[11]).toBe('83.3700');
    await refused(
      send('post', '/budgets', {
        fiscal_year_id: fy,
        name: 'x',
        budget_type: 'operating',
        lines: [line(h.revenue, '10')],
      }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('post', '/budgets', {
        fiscal_year_id: fy,
        name: 'x',
        budget_type: 'operating',
        lines: [line(h.capital, '10')],
      }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('post', '/budgets', {
        fiscal_year_id: fy,
        name: 'x',
        budget_type: 'operating',
        lines: [line(h.admin, '10'), line(h.admin, '20')],
      }),
      422,
      'VALIDATION_FAILED',
    );
    await refused(
      send('post', '/budgets', {
        fiscal_year_id: fy,
        name: 'x',
        budget_type: 'operating',
        lines: [line(h.admin, '12.00', { allocations: Array.from({ length: 12 }, () => '0.99') })],
      }),
      422,
      'ALLOCATION_MISMATCH',
    );
    const patched = await ok(
      send(
        'patch',
        `/budgets/${d.id}`,
        { lines: [line(h.welfare, '600.00'), line(h.admin, '400.00')] },
        d.version,
      ),
    );
    expect(patched.total_amount).toBe('1000.0000');
    expect(patched.line_count).toBe(2);
    expect((await send('delete', `/budgets/${d.id}`, {})).status).toBe(204);
  });
});

describe('approval, release and P9 BU.1 (D-3.06-5, D-3.06-8)', () => {
  let budget: Body;
  it('releases an approved budget once; a second active budget of the same dimensions is refused', async () => {
    budget = await released({
      estate_id: e.bu.toString(),
      name: 'BU.1 budget',
      lines: [line(h.welfare, '2400000.00')],
    });
    expect(budget.state).toBe('active');
    const twin = await draft({ estate_id: e.bu.toString(), lines: [line(h.welfare, '1.00')] });
    const s = await ok(send('post', `/budgets/${twin.id}/submit`, {}, twin.version));
    await approveAll(s.approval_id);
    const a = await ok(get(`/budgets/${twin.id}`));
    await refused(
      send('post', `/budgets/${twin.id}/activate`, {}, a.version, APPROVER),
      422,
      'DUPLICATE_KEY',
    );
    // Immutable once submitted.
    await refused(
      send('patch', `/budgets/${budget.id}`, { name: 'x' }, budget.version),
      409,
      'INVALID_TRANSITION',
    );
  });

  it('BU.1: annual 2,400,000, actual 1,850,000, open commitments 300,000 → available 250,000.00, 89.5833 %', async () => {
    const target = { budgetHeadId: BigInt(h.welfare), estateId: e.bu, amount: dec('1850000') };
    await record({ stage: 'actual', sourceType: 'supplier_invoice', sourceId: 1n, lines: [target] });
    await record({
      stage: 'commitment',
      sourceType: 'purchase_order',
      sourceId: 1n,
      lines: [{ ...target, amount: dec('300000') }],
    });
    const l = await lineOf(budget.id, h.welfare);
    expect(l).toMatchObject({
      annual_amount: '2400000.0000',
      actual_amount: '1850000.0000',
      committed_amount: '300000.0000',
      available_amount: '250000.0000',
      utilisation_percentage: '89.5833',
      variance: { amount: '550000.0000', label: 'surplus' },
    });
    const a = await ok(
      get(
        `/budgets/availability?budget_head_id=${h.welfare}&estate_id=${e.bu.toString()}&date=${today}&amount=100000`,
      ),
    );
    expect(a).toMatchObject({
      available: '250000.0000',
      available_after: '150000.0000',
      utilisation: '89.5833',
      exceeded: false,
      outcome: 'ok',
    });
    const vs = await ok<{
      rows: { label: string; variance: { label: string } }[];
      total: { actual: string };
    }>(get(`/budgets/${budget.id}/vs-actual?group_by=period`));
    expect(vs.total.actual).toBe('1850000.0000');
  });

  it('is idempotent per source, releases in parts, and reverses', async () => {
    const t = { budgetHeadId: BigInt(h.welfare), estateId: e.bu, amount: dec('300000') };
    const again = await record({
      stage: 'commitment',
      sourceType: 'purchase_order',
      sourceId: 1n,
      lines: [t],
    });
    expect(again[0]?.created).toBe(false);
    // Invoice 2 releases 120,000 of the order; invoice 3 the rest.
    await record({
      stage: 'release',
      sourceType: 'supplier_invoice',
      sourceId: 2n,
      releases: { sourceType: 'purchase_order', sourceId: 1n },
      lines: [{ ...t, amount: dec('120000') }],
    });
    expect((await lineOf(budget.id, h.welfare)).committed_amount).toBe('180000.0000');
    const rest = await record({
      stage: 'release',
      sourceType: 'supplier_invoice',
      sourceId: 3n,
      releases: { sourceType: 'purchase_order', sourceId: 1n },
      lines: [],
    });
    expect(rest[0]?.amount).toBe('180000.0000');
    const commitment = await mdb.migrator.budgetConsumption.findFirstOrThrow({
      where: { consumptionType: 'commitment', sourceType: 'purchase_order', sourceId: 1n },
    });
    expect(commitment.releasedById).not.toBeNull();
    // Reversing the first invoice's actual.
    await tx((x) =>
      reverseConsumption(x, {
        sourceType: 'supplier_invoice',
        sourceId: 1n,
        by: { sourceType: 'supplier_invoice', sourceId: 99n },
        date: today,
        actorId: 1n,
      }),
    );
    expect(await lineOf(budget.id, h.welfare)).toMatchObject({
      actual_amount: '0.0000',
      committed_amount: '0.0000',
    });
    const rows = await ok<unknown[]>(
      get(`/budget-lines/${(await lineOf(budget.id, h.welfare)).id}/consumption`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
  });
});

describe('budget control (D-3.06-9, D-3.06-10)', () => {
  let budget: Body;
  beforeAll(async () => {
    budget = await released({
      estate_id: estate.toString(),
      name: 'Controlled',
      lines: [line(h.admin, '1000.00'), line(h.loose, '10.00')],
    });
  });
  const control = async (body: object) => {
    const c = await ok(send('post', '/budget-controls', body), 201);
    const s = await ok(send('post', `/budget-controls/${c.id}/submit`, {}, c.version));
    await approveAll(s.approval_id);
    return ok(get(`/budget-controls/${c.id}`));
  };

  it('warns by default; require_approval and block apply over the tolerance; an uncontrolled head is none', async () => {
    const check = (head: string, amount: string) =>
      tx((t) =>
        checkAvailability(t, {
          budgetHeadId: BigInt(head),
          estateId: estate,
          date: today,
          amount: dec(amount),
        }),
      );
    expect((await check(h.admin, '1500')).outcome).toBe('warn');
    expect((await check(h.loose, '1500')).outcome).toBe('ok');
    const c = await control({
      budget_head_id: h.admin,
      estate_id: estate.toString(),
      control_mode: 'block',
      overrun_tolerance_percentage: '10',
    });
    expect(c.state).toBe('active');
    expect((await check(h.admin, '1100')).outcome).toBe('ok');
    expect((await check(h.admin, '1100.01')).outcome).toBe('block');
  });

  it('a block-mode control refuses a commitment beyond the available (the verification)', async () => {
    const l = { budgetHeadId: BigInt(h.admin), estateId: estate };
    await record({
      stage: 'commitment',
      sourceType: 'purchase_order',
      sourceId: 50n,
      lines: [{ ...l, amount: dec('900') }],
    });
    await expect(
      record({
        stage: 'commitment',
        sourceType: 'purchase_order',
        sourceId: 51n,
        lines: [{ ...l, amount: dec('300') }],
      }),
    ).rejects.toMatchObject({
      code: 'BUDGET_EXCEEDED',
    });
    // Approved overruns pass.
    const passed = await record({
      stage: 'commitment',
      sourceType: 'purchase_order',
      sourceId: 52n,
      lines: [{ ...l, amount: dec('300') }],
      overrunApproved: true,
    });
    expect(passed[0]?.created).toBe(true);
    expect((await lineOf(budget.id, h.admin)).committed_amount).toBe('1200.0000');
  });

  it('a revision of a control is a relaxation when it lowers the mode, and supersedes on approval', async () => {
    const active = (
      await ok<Body[]>(get(`/budget-controls?filter[state]=active&filter[budget_head_id]=${h.admin}`))
    )[0];
    if (!active) throw new Error('no active control');
    const rev = await ok(send('post', `/budget-controls/${active.id}/revise`, {}, active.version), 201);
    const changed = await ok(
      send('patch', `/budget-controls/${rev.id}`, { control_mode: 'warn' }, rev.version),
    );
    const s = await ok(send('post', `/budget-controls/${rev.id}/submit`, {}, changed.version));
    const described = await tx((t) =>
      budgetControlService({
        db: mdb.db,
        accessLog: { record: () => Promise.resolve() },
        timezone,
      }).adapter.describe(t, BigInt(rev.id)),
    );
    expect(described.values).toMatchObject({ is_relaxation: 'true' });
    await approveAll(s.approval_id);
    expect((await ok(get(`/budget-controls/${active.id}`))).state).toBe('superseded');
    expect((await ok(get(`/budget-controls/${rev.id}`))).state).toBe('active');
  });
});

describe('line resolution and revisions (D-3.06-4, D-3.06-5, D-3.06-7)', () => {
  it('finds the ancestor head, the cost centre or none, and the organisation-wide budget', async () => {
    const b = await released({
      name: 'Wide',
      budget_type: 'operating',
      lines: [line(h.admin, '500.00', { cost_centre_id: cc2 })],
    });
    const find = (head: string, costCentre?: string, est?: bigint) =>
      tx((t) =>
        checkAvailability(t, {
          budgetHeadId: BigInt(head),
          costCentreId: costCentre ? BigInt(costCentre) : null,
          estateId: est ?? null,
          date: today,
          amount: dec('1'),
        }),
      );
    // The estate budget (Controlled) takes the head for its estate; elsewhere the organisation-wide one.
    expect((await find(h.stationery, cc2)).line?.budgetCode).toBe(b.budget_code);
    const none = await find(h.capital);
    expect(none.line).toBeNull();
    expect(none.outcome).toBe('warn');
  });

  it('a released revision supersedes and takes over the figures; dropping a consumed line is refused', async () => {
    const b = await released({
      name: 'Revisable',
      department_id: null,
      estate_id: null,
      budget_type: 'capital',
      lines: [line(h.capital, '1000.00')],
    });
    await record({
      stage: 'actual',
      sourceType: 'journal',
      sourceId: 700n,
      lines: [{ budgetHeadId: BigInt(h.capital), amount: dec('250') }],
    });
    const r = await ok(
      send('post', `/budgets/${b.id}/revise`, {}, (await ok(get(`/budgets/${b.id}`))).version, PLANNER),
      201,
    );
    expect(r.revision_number).toBe(1);
    expect(r.budget_code).toBe(`${String(b.budget_code)}-R1`);
    const bigger = await ok(
      send('patch', `/budgets/${r.id}`, { lines: [line(h.capital, '1500.00')] }, r.version),
    );
    const s = await ok(send('post', `/budgets/${r.id}/submit`, {}, bigger.version));
    await approveAll(s.approval_id);
    const a = await ok(
      send('post', `/budgets/${r.id}/activate`, {}, (await ok(get(`/budgets/${r.id}`))).version, APPROVER),
    );
    expect(a.state).toBe('active');
    expect((await ok(get(`/budgets/${b.id}`))).state).toBe('superseded');
    expect(await lineOf(r.id, h.capital)).toMatchObject({
      annual_amount: '1500.0000',
      actual_amount: '250.0000',
      available_amount: '1250.0000',
    });
    // New consumption lands on the revision.
    await record({
      stage: 'actual',
      sourceType: 'journal',
      sourceId: 701n,
      lines: [{ budgetHeadId: BigInt(h.capital), amount: dec('50') }],
    });
    expect((await lineOf(r.id, h.capital)).actual_amount).toBe('300.0000');
    // A revision dropping the consumed line cannot be released.
    const r2 = await ok(send('post', `/budgets/${r.id}/revise`, {}, a.version), 201);
    const dropped = await ok(
      send('patch', `/budgets/${r2.id}`, { lines: [line(h.capital2, '10.00')] }, r2.version),
    );
    const s2 = await ok(send('post', `/budgets/${r2.id}/submit`, {}, dropped.version));
    await approveAll(s2.approval_id);
    await refused(
      send('post', `/budgets/${r2.id}/activate`, {}, (await ok(get(`/budgets/${r2.id}`))).version, APPROVER),
      422,
      'VALIDATION_FAILED',
    );
    expect((await ok(get(`/budgets/${r.id}`))).state).toBe('active');
  });
});

describe('manual journals consume actuals (D-3.06-12)', () => {
  it('a posted journal with a budget head records the actual; its reversal undoes it', async () => {
    const b = await released({
      estate_id: e.journal.toString(),
      name: 'Journal budget',
      lines: [line(h.welfare, '5000.00', { cost_centre_id: cc })],
    });
    const account = async (code: string) =>
      (await mdb.migrator.account.findUniqueOrThrow({ where: { code } })).id.toString();
    const j = await ok(
      send(
        'post',
        '/journals',
        {
          journal_type: 'manual',
          journal_date: today,
          narration: 'Welfare spend',
          estate_id: e.journal.toString(),
          lines: [
            {
              account_id: await account('6325'),
              side: 'debit',
              amount: '700.00',
              cost_centre_id: cc,
              budget_head_id: h.welfare,
            },
            { account_id: await account('1115'), side: 'credit', amount: '700.00' },
          ],
        },
        undefined,
        JOURNALIST,
      ),
      201,
    );
    const s = await ok(send('post', `/journals/${j.id}/submit`, {}, j.version, JOURNALIST));
    await approveAll(s.approval_id);
    const approved = await ok(get(`/journals/${j.id}`, JOURNALIST));
    const posted = await ok(send('post', `/journals/${j.id}/post`, {}, approved.version, JOURNALIST));
    expect((await lineOf(b.id, h.welfare)).actual_amount).toBe('700.0000');
    await ok(send('post', `/journals/${j.id}/reverse`, { date: today }, posted.version, JOURNALIST));
    expect((await lineOf(b.id, h.welfare)).actual_amount).toBe('0.0000');
  });
});

describe('the threshold job (D-3.06-14)', () => {
  it('alerts once when a line reaches its warning threshold', async () => {
    await mdb.migrator.budgetControl.create({
      data: {
        controlMode: 'warn',
        warningThresholdPercentage: '50',
        state: 'active',
        createdBy: 1n,
        budgetHeadId: BigInt(h.stationery),
      },
    });
    const b = await released({
      estate_id: e.threshold.toString(),
      name: 'Thresholds',
      lines: [line(h.stationery, '100.00')],
    });
    await record({
      stage: 'actual',
      sourceType: 'journal',
      sourceId: 900n,
      lines: [{ budgetHeadId: BigInt(h.stationery), estateId: e.threshold, amount: dec('60') }],
    });
    const rule = await mdb.migrator.notificationRule.create({
      data: {
        code: unique('BT'),
        name: 'Budget',
        triggerType: 'budget_threshold',
        recipientRule: 'by_named_user',
        userId: BigInt(PLANNER),
        createdBy: 1n,
      },
    });
    const job = budgetThresholdJob(mdb.db, timezone);
    const ctx = {
      signal: new AbortController().signal,
      logger: silentLogger(),
      progress: () => Promise.resolve(),
    } as never;
    await job.run(ctx);
    await job.run(ctx);
    const l = await lineOf(b.id, h.stationery);
    const notes = await runUnscoped('test', () =>
      mdb.migrator.notification.findMany({ where: { notificationRuleId: rule.id, linkId: BigInt(l.id) } }),
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]?.subject).toContain('60.00 %');
  });
});
