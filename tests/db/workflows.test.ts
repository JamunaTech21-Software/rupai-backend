import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSeeders } from '../../prisma/seed/seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { APPROVABLE_DOCUMENTS } from '../../src/core/approval/document-types.js';
import { selectWorkflow } from '../../src/core/approval/select.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { addDays, todayIn, type BusinessDate } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import {
  createMigratedDatabase,
  silentLogger,
  TEST_BOOTSTRAP_PASSWORD,
  url,
  type MigratedDatabase,
} from './helpers.js';

/** P1.13 — approval workflow definitions through the HTTP API, on real MySQL. */

/** The Administrator: drafts and edits workflows, approves none (P6 §5.5). */
const ADMIN = '1';
/** Holds workflow.approve, organisation-wide. */
let APPROVER = '';
let mdb: MigratedDatabase;
let app: Express;
let today: BusinessDate;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Step {
  step_number: number;
  approver_rule: string;
  role_id: string | null;
  condition: unknown;
  [k: string]: unknown;
}
interface Workflow {
  id: string;
  version: number;
  state: string;
  code: string;
  steps: Step[];
  warnings?: { code: string; step_number: number | null }[];
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Workflow }).data;
const many = <T = Workflow>(res: { body: unknown }): T[] => (res.body as { data: T[] }).data;
const err = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { code: string; field?: string }[] } }).error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;

const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object = {}, actor = ADMIN) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);
const patch = (path: string, body: object, version: number, actor = ADMIN) =>
  as(request(app).patch(`/api/v1${path}`), actor)
    .set('If-Match', `"${String(version)}"`)
    .send(body);
async function ok<T = Workflow>(r: request.Test, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
}

async function role(permissions: string[] = []): Promise<string> {
  return (
    await ok<{ id: string }>(post('/roles', { code: unique('R_'), name: 'Workflow probe', permissions }), 201)
  ).id;
}
async function user(roleId: string, grants: object[], authorisations?: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('wf'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const current = await get(`/users/${id}`);
  const set = await as(request(app).post(`/api/v1/users/${id}/roles`), ADMIN)
    .set('If-Match', `"${String(one(current).version)}"`)
    .send({ roles: [{ role_id: roleId }], ...(authorisations ? { authorisations } : {}) });
  expect(set.status, json(set)).toBe(200);
  for (const g of grants) expect((await post(`/users/${id}/scopes`, g)).status).toBe(201);
  return id;
}
const estate = async () =>
  (await ok<{ id: string }>(post('/estates', { code: unique('E'), name: 'Estate' }, ESTATES), 201)).id;
let ESTATES = '';

const amount = (operator: string, value: unknown) => ({ field: 'total_base_amount', operator, value });
/** P7 Table 6.1: the standard expenditure ladder, on the four roles given. */
const ladder = (roles: string[]) => [
  { name: 'Estate manager', approver_rule: 'by_role', role_id: roles[0] },
  { name: 'Accounts', approver_rule: 'by_role', role_id: roles[1], condition: amount('gte', '50001') },
  {
    name: 'General manager',
    approver_rule: 'by_role',
    role_id: roles[2],
    condition: amount('gte', '250001'),
  },
  {
    name: 'Managing director',
    approver_rule: 'by_role',
    role_id: roles[3],
    condition: amount('gte', '1000001'),
  },
];
const draft = (over: object = {}) => ({
  code: unique('WF'),
  name: 'Purchase orders',
  document_type: 'purchase_order',
  effective_from: today,
  steps: [{ approver_rule: 'by_reporting_line', reporting_level: 1 }],
  ...over,
});
const seeded = async (documentType: string) => {
  const [w] = many(await get(`/workflows?filter[document_type]=${documentType}&filter[state]=active`));
  if (!w) throw new Error(`no seeded workflow for ${documentType}`);
  return w;
};
/** draft → submitted (by its creator) → active (by the approver). */
async function activate(id: string): Promise<Workflow> {
  await ok(post(`/workflows/${id}/submit`));
  return ok(post(`/workflows/${id}/approve`, {}, APPROVER));
}

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  today = todayIn(config.timezone);
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
  APPROVER = await user(await role(['workflow.view', 'workflow.approve']), [{ scope_type: 'all_estates' }]);
  ESTATES = await user(await role(['estate.view', 'estate.create']), [{ scope_type: 'all_estates' }]);
});
afterAll(async () => {
  await mdb.drop();
});

describe('seeded workflows (P3 §31.2, P7 §15.3)', () => {
  it('gives every approvable document type one active single-step workflow', async () => {
    const types = many<{
      key: string;
      active_workflows: number;
      fields: { name: string; operators: string[] }[];
    }>(await get('/workflows/document-types'));
    expect(types.map((t) => t.key)).toEqual(APPROVABLE_DOCUMENTS.map((d) => d.key));
    expect(types.filter((t) => t.active_workflows !== 1).map((t) => t.key)).toEqual([]);
    const po = types.find((t) => t.key === 'purchase_order');
    expect(po?.fields.find((f) => f.name === 'total_base_amount')?.operators).toEqual([
      'lt',
      'lte',
      'gt',
      'gte',
      'between',
    ]);

    const w = await seeded('sale');
    expect(w).toMatchObject({
      code: 'WF_SALE',
      state: 'active',
      is_active: true,
      estate_id: null,
      department_id: null,
      specificity: 0,
      effective_from: '2020-01-01',
      effective_to: null,
    });
    // No role exists to name, and the Administrator approves nothing: the supervisor approves.
    expect(w.steps).toMatchObject([
      {
        step_number: 1,
        approver_rule: 'by_reporting_line',
        reporting_level: 1,
        condition: null,
        allow_self_approval: false,
      },
    ]);
  });

  it('is seeded once: running the seed again adds nothing', async () => {
    const before = await mdb.migrator.workflow.count();
    await runSeeders(
      mdb.migrator,
      buildSeeders({ BOOTSTRAP_ADMIN_PASSWORD: TEST_BOOTSTRAP_PASSWORD }),
      silentLogger(),
    );
    expect(await mdb.migrator.workflow.count()).toBe(before);
    expect(before).toBe(APPROVABLE_DOCUMENTS.length);
  });
});

describe('definition-time validation (P7 §15.2)', () => {
  it('refuses a workflow whose every step is conditional, at save', async () => {
    const r = await role();
    const res = await post(
      '/workflows',
      draft({
        steps: [
          { approver_rule: 'by_role', role_id: r, condition: amount('lt', '50001') },
          { approver_rule: 'by_role', role_id: r, condition: amount('gte', '50001') },
        ],
      }),
    );
    expect(res.status, json(res)).toBe(422);
    expect(err(res).details).toMatchObject([{ field: 'steps', code: 'WORKFLOW_NO_UNCONDITIONAL_STEP' }]);
    expect(await mdb.migrator.workflow.count({ where: { state: 'draft' } })).toBe(0);
  });

  it('refuses unknown fields, a broken ladder, forbidden self-approval and missing references', async () => {
    const r = await role();
    const inactive = await role();
    const current = await get(`/roles/${inactive}`);
    expect(
      (await post(`/roles/${inactive}/deactivate`, {}).set('If-Match', `"${String(one(current).version)}"`))
        .status,
    ).toBe(200);
    const always = { approver_rule: 'by_role', role_id: r };
    const cases: [object, string, string][] = [
      [
        {
          steps: [
            always,
            { ...always, condition: { field: 'sale_channel', operator: 'eq', value: 'export' } },
          ],
        },
        'steps.1.condition.field',
        'WORKFLOW_CONDITION_INVALID',
      ],
      [
        { steps: [always, { ...always, condition: amount('eq', '5') }] },
        'steps.1.condition.operator',
        'WORKFLOW_CONDITION_INVALID',
      ],
      [
        { conditions: [{ field: 'estate_id', operator: 'gte', value: '1' }] },
        'conditions.0.operator',
        'WORKFLOW_CONDITION_INVALID',
      ],
      [
        {
          steps: [
            always,
            { ...always, condition: amount('gte', '250001') },
            { ...always, condition: amount('gte', '50001') },
          ],
        },
        'steps.2.condition',
        'WORKFLOW_LADDER_INVALID',
      ],
      [
        { steps: [{ ...always, allow_self_approval: true }] },
        'steps.0.allow_self_approval',
        'WORKFLOW_SELF_APPROVAL_FORBIDDEN',
      ],
      [{ steps: [{ approver_rule: 'by_role' }] }, 'steps.0.role_id', 'WORKFLOW_STEP_INVALID'],
      [
        { steps: [{ approver_rule: 'by_role', role_id: '999999' }] },
        'steps.0.role_id',
        'WORKFLOW_REFERENCE_INVALID',
      ],
      [
        { steps: [{ approver_rule: 'by_role', role_id: inactive }] },
        'steps.0.role_id',
        'WORKFLOW_REFERENCE_INVALID',
      ],
      [
        { steps: [{ approver_rule: 'by_named_user', user_id: '999999' }] },
        'steps.0.user_id',
        'WORKFLOW_REFERENCE_INVALID',
      ],
      [{ estate_id: '999999' }, 'estate_id', 'WORKFLOW_REFERENCE_INVALID'],
      [{ department_id: '999999' }, 'department_id', 'WORKFLOW_REFERENCE_INVALID'],
    ];
    for (const [over, field, code] of cases) {
      const res = await post('/workflows', draft(over));
      expect(res.status, `${field} ${json(res)}`).toBe(422);
      expect(err(res).details, field).toMatchObject([{ field, code }]);
    }
    // Shape errors come from the request schema.
    for (const over of [
      { document_type: 'time_machine' },
      { steps: [] },
      { code: 'has space' },
      { extra: 1 },
    ]) {
      expect((await post('/workflows', draft(over))).status).toBe(422);
    }
    // Self-approval may be allowed on a routine operational record.
    const routine = await post(
      '/workflows',
      draft({ document_type: 'field_activity', steps: [{ ...always, allow_self_approval: true }] }),
    );
    expect(routine.status, json(routine)).toBe(201);
  });

  it('warns, without refusing, about a role nobody holds, one that cannot approve, and one that can also create', async () => {
    const empty = await role();
    // Nobody holds either role: assigning create + approve together needs a named authorisation (P1.04).
    const creator = await role(['purchase_order.create', 'purchase_order.approve']);
    const w = await ok(
      post(
        '/workflows',
        draft({
          steps: [
            { approver_rule: 'by_role', role_id: empty },
            { approver_rule: 'by_role', role_id: creator, condition: amount('gte', '50001') },
          ],
        }),
      ),
      201,
    );
    expect(w.warnings?.map((x) => [x.step_number, x.code])).toEqual([
      [1, 'ROLE_HAS_NO_HOLDER'],
      [1, 'APPROVER_LACKS_PERMISSION'],
      [2, 'ROLE_HAS_NO_HOLDER'],
      [2, 'APPROVER_CAN_CREATE'],
    ]);
    // Lists carry no warnings.
    const [listed] = many(await get(`/workflows?filter[code]=${w.code}`));
    expect(listed?.warnings).toBeUndefined();
    expect(listed?.steps).toHaveLength(2);
  });
});

describe('versions: draft, approval, supersede (P7 §15.1)', () => {
  it('edits a draft with If-Match, replacing its steps as a set', async () => {
    const roles = [await role(), await role(), await role(), await role()];
    const w = await ok(post('/workflows', draft({ document_type: 'payment', notes: 'first' })), 201);
    expect(w).toMatchObject({ state: 'draft', is_active: false, version: 1, document_type_label: 'Payment' });

    expect(
      err(await as(request(app).patch(`/api/v1/workflows/${w.id}`), ADMIN).send({ name: 'x' })).code,
    ).toBe('PRECONDITION_REQUIRED');
    expect(err(await patch(`/workflows/${w.id}`, { name: 'x' }, 9)).code).toBe('VERSION_CONFLICT');
    const payment = (i: number, value: string) => ({
      approver_rule: 'by_role',
      role_id: roles[i],
      condition: { field: 'amount', operator: 'gte', value },
    });
    const edited = await ok(
      patch(
        `/workflows/${w.id}`,
        {
          name: 'Payments',
          conditions: [{ field: 'budget_exceeded', operator: 'is_false' }],
          steps: [{ approver_rule: 'by_role', role_id: roles[0] }, payment(1, '50001'), payment(2, '250001')],
        },
        1,
      ),
    ).catch((e: unknown) => e);
    // A payment has no budget_exceeded flag: the whole edit is refused and nothing changes.
    expect(edited).toBeInstanceOf(Error);
    expect(one(await get(`/workflows/${w.id}`))).toMatchObject({ name: 'Purchase orders', version: 1 });

    const good = await ok(
      patch(
        `/workflows/${w.id}`,
        {
          name: 'Payments',
          steps: [{ approver_rule: 'by_role', role_id: roles[0] }, payment(1, '50001'), payment(2, '250001')],
        },
        1,
      ),
    );
    expect(good).toMatchObject({ name: 'Payments', version: 2, notes: 'first' });
    expect(good.steps.map((s) => [s.step_number, s.role_id, s.condition])).toEqual([
      [1, roles[0], null],
      [2, roles[1], { field: 'amount', operator: 'gte', value: '50001' }],
      [3, roles[2], { field: 'amount', operator: 'gte', value: '250001' }],
    ]);
    // A steps-only edit still moves the version, so a stale editor is caught.
    const fewer = await ok(
      patch(`/workflows/${w.id}`, { steps: [{ approver_rule: 'by_role', role_id: roles[3] }] }, 2),
    );
    expect(fewer).toMatchObject({ version: 3 });
    expect(fewer.steps).toHaveLength(1);
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'workflow', recordId: w.id, field: 'steps' },
      orderBy: { id: 'asc' },
    });
    expect(audit).toHaveLength(3);
    expect(JSON.parse(audit[2]?.newValue ?? '[]')).toMatchObject([{ step_number: 1, role_id: roles[3] }]);
  });

  it('takes effect only when approved by someone other than its creator', async () => {
    const e = await estate();
    const w = await ok(post('/workflows', draft({ estate_id: e })), 201);
    expect(w).toMatchObject({ estate_id: e, specificity: 2 });

    expect(err(await post(`/workflows/${w.id}/approve`, {}, APPROVER)).code).toBe('NOT_SUBMITTED');
    const submitted = await ok(post(`/workflows/${w.id}/submit`));
    expect(submitted).toMatchObject({ state: 'submitted', submitted_by: ADMIN });
    // Only a draft is edited.
    expect(err(await patch(`/workflows/${w.id}`, { name: 'x' }, submitted.version)).code).toBe(
      'INVALID_TRANSITION',
    );
    // The Administrator may draft and submit, never approve (P6 §5.5).
    const admin = await post(`/workflows/${w.id}/approve`);
    expect(admin.status).toBe(403);
    expect(err(admin).code).toBe('PERMISSION_DENIED');

    const back = await ok(post(`/workflows/${w.id}/return`, { comment: 'Add an accounts step.' }, APPROVER));
    expect(back).toMatchObject({ state: 'draft', submitted_by: null });
    expect((await post(`/workflows/${w.id}/return`, {}, APPROVER)).status).toBe(422);
    await ok(post(`/workflows/${w.id}/submit`));
    const active = await ok(post(`/workflows/${w.id}/approve`, {}, APPROVER));
    expect(active).toMatchObject({ state: 'active', is_active: true, approved_by: APPROVER });
    expect(err(await post(`/workflows/${w.id}/approve`, {}, APPROVER)).code).toBe('ALREADY_APPROVED');

    const history = await mdb.migrator.statusHistory.findMany({
      where: { recordType: 'workflow', recordId: w.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toState)).toEqual(['draft', 'submitted', 'draft', 'submitted', 'active']);
  });

  it('refuses a creator approving their own workflow, and requires a reason to reject', async () => {
    const maker = await user(
      await role(['workflow.view', 'workflow.create', 'workflow.edit', 'workflow.approve']),
      [{ scope_type: 'all_estates' }],
      // Create and approve together is a separation-of-duties conflict: it needs a named authorisation.
      [
        {
          key: 'SOD-1:workflow.approve+workflow.create',
          reason: 'Test: one person holds both to prove the engine still refuses.',
        },
      ],
    );
    const e = await estate();
    const w = await ok(post('/workflows', draft({ estate_id: e }), maker), 201);
    await ok(post(`/workflows/${w.id}/submit`, {}, maker));
    const own = await post(`/workflows/${w.id}/approve`, {}, maker);
    expect(own.status).toBe(403);
    expect(err(own).code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await post(`/workflows/${w.id}/reject`, {}, APPROVER)).status).toBe(422);
    const rejected = await ok(post(`/workflows/${w.id}/reject`, { reason: 'Not agreed.' }, APPROVER));
    expect(rejected).toMatchObject({
      state: 'rejected',
      rejection_reason: 'Not agreed.',
      rejected_by: APPROVER,
    });
    expect(err(await post(`/workflows/${w.id}/submit`, {}, maker)).code).toBe('INVALID_TRANSITION');
  });

  it('refuses a second active workflow at the same scope, and replaces one by superseding it', async () => {
    const roles = [await role(), await role(), await role(), await role()];
    const old = await seeded('purchase_order');

    // A new code at the same scope would give purchase orders two workflows on the same day.
    const rival = await ok(post('/workflows', draft()), 201);
    const overlap = await post(`/workflows/${rival.id}/submit`);
    expect(overlap.status, json(overlap)).toBe(422);
    expect(err(overlap).code).toBe('RULE_OVERLAP');
    expect((await post('/workflows', draft({ code: old.code }))).status).toBe(422); // DUPLICATE_KEY

    const tomorrow = addDays(today, 1);
    const next = await ok(
      post(`/workflows/${old.id}/supersede`, {
        name: 'Expenditure ladder',
        effective_from: tomorrow,
        steps: ladder(roles),
      }),
      201,
    );
    expect(next).toMatchObject({
      code: old.code,
      state: 'draft',
      supersedes_id: old.id,
      document_type: 'purchase_order',
    });
    expect(next.steps).toHaveLength(4);
    // Until it is approved the current version stays in force.
    expect(one(await get(`/workflows/${old.id}`))).toMatchObject({ state: 'active', effective_to: null });
    await activate(next.id);
    expect(one(await get(`/workflows/${old.id}`))).toMatchObject({ state: 'active', effective_to: today });

    const inForce = async (date: string) =>
      many(await get(`/workflows?filter[document_type]=purchase_order&filter[as_of]=${date}`))
        .filter((w) => w.estate_id === null)
        .map((w) => w.id);
    expect(await inForce(today)).toEqual([old.id]);
    expect(await inForce(tomorrow)).toEqual([next.id]);
    // An active version is fixed: its steps cannot be edited, only superseded.
    expect(
      err(
        await patch(
          `/workflows/${next.id}`,
          { steps: [{ approver_rule: 'by_role', role_id: roles[0] }] },
          next.version + 2,
        ),
      ).code,
    ).toBe('INVALID_TRANSITION');
    // Superseding copies the steps unless new ones are sent.
    const copy = await ok(
      post(`/workflows/${next.id}/supersede`, { effective_from: addDays(today, 30) }),
      201,
    );
    expect(copy.steps.map((s) => s.role_id)).toEqual(roles);
    expect(
      err(await post(`/workflows/${copy.id}/supersede`, { effective_from: addDays(today, 60) })).code,
    ).toBe('INVALID_TRANSITION');
  });
});

describe('selection (P7 §3.2)', () => {
  it('picks the most specific workflow in force on the submission date', async () => {
    const e = await estate();
    const other = await estate();
    const org = await seeded('leave');
    const forEstate = await ok(post('/workflows', draft({ document_type: 'leave', estate_id: e })), 201);
    await activate(forEstate.id);
    const pick = async (estateId: string | null, date: BusinessDate, values = {}) =>
      (await selectWorkflow(mdb.db, 'leave', { estateId }, date, values))?.id.toString() ?? null;

    expect(await pick(e, today)).toBe(forEstate.id);
    expect(await pick(other, today)).toBe(org.id);
    expect(await pick(null, today)).toBe(org.id);
    // A document submitted before the estate workflow started follows the one in force that day.
    expect(await pick(e, addDays(today, -1))).toBe(org.id);
    // Before any workflow existed: no approval is required.
    expect(await pick(e, '2019-12-31' as BusinessDate)).toBeNull();
    expect(await selectWorkflow(mdb.db, 'time_machine', {}, today, {})).toBeNull();
  });

  it('skips a workflow whose own condition does not hold, falling back to the next', async () => {
    const e = await estate();
    const org = await seeded('contractor_contract');
    const big = await ok(
      post(
        '/workflows',
        draft({
          document_type: 'contractor_contract',
          estate_id: e,
          conditions: [{ field: 'contract_value', operator: 'gte', value: '1000000' }],
        }),
      ),
      201,
    );
    expect(big.conditions).toEqual([{ field: 'contract_value', operator: 'gte', value: '1000000' }]);
    await activate(big.id);
    const pick = async (value: string) =>
      (
        await selectWorkflow(mdb.db, 'contractor_contract', { estateId: e }, today, { contract_value: value })
      )?.id.toString();
    expect(await pick('999999.99')).toBe(org.id);
    expect(await pick('1000000')).toBe(big.id);
  });
});

describe('preview (P7 §15.1)', () => {
  it('shows which steps fire at each threshold and who could approve them', async () => {
    const e = await estate();
    const elsewhere = await estate();
    const roles = [await role(), await role(), await role(), await role()];
    const manager = await user(roles[0] ?? '', [{ scope_type: 'estate', scope_id: e }]);
    await user(roles[0] ?? '', [{ scope_type: 'estate', scope_id: elsewhere }]);
    const everywhere = await user(roles[1] ?? '', [{ scope_type: 'all_estates' }]);
    const w = await ok(post('/workflows', draft({ estate_id: e, steps: ladder(roles) })), 201);

    const preview = async (sample: Record<string, string>) => {
      const query = Object.entries(sample)
        .map(([k, v]) => `sample[${k}]=${v}`)
        .join('&');
      return ok<{
        applies: boolean;
        steps: {
          step_number: number;
          fires: boolean;
          path_position: number | null;
          approvers: { id: string }[];
          unresolved: boolean;
          approvers_deferred: boolean;
        }[];
      }>(get(`/workflows/${w.id}/preview?${query}`));
    };
    const fired = async (value: string) =>
      (await preview({ total_base_amount: value })).steps.filter((s) => s.fires).map((s) => s.step_number);
    expect(await fired('40000')).toEqual([1]);
    expect(await fired('50000')).toEqual([1]);
    expect(await fired('50001')).toEqual([1, 2]);
    expect(await fired('250001')).toEqual([1, 2, 3]);
    expect(await fired('3000000.00')).toEqual([1, 2, 3, 4]);

    const p = await preview({ total_base_amount: '300000', estate_id: e });
    expect(p.applies).toBe(true);
    expect(p.steps.map((s) => s.path_position)).toEqual([1, 2, 3, null]);
    // Only the manager of THIS estate is offered step 1; the organisation-wide accountant step 2.
    expect(p.steps[0]?.approvers.map((a) => a.id)).toEqual([manager]);
    expect(p.steps[1]?.approvers.map((a) => a.id)).toEqual([everywhere]);
    // Nobody holds the third role: the step would raise an exception. The fourth does not fire.
    expect(p.steps.map((s) => s.unresolved)).toEqual([false, false, true, false]);

    const bad = await get(
      `/workflows/${w.id}/preview?sample[sale_channel]=export&sample[total_base_amount]=lots`,
    );
    expect(bad.status).toBe(422);
    expect(err(bad).details.map((d) => d.field)).toEqual(['sample.sale_channel', 'sample.total_base_amount']);

    const supervisor = await ok<{ steps: { approvers_deferred: boolean; unresolved: boolean }[] }>(
      get(`/workflows/${(await seeded('attendance')).id}/preview`),
    );
    expect(supervisor.steps).toMatchObject([{ fires: true, approvers_deferred: true, unresolved: false }]);
  });
});

describe('permission and scope', () => {
  it('needs the workflow permissions', async () => {
    const nobody = await user(await role(['estate.view']), [{ scope_type: 'all_estates' }]);
    const viewer = await user(await role(['workflow.view']), [{ scope_type: 'all_estates' }]);
    const w = await seeded('sale');
    for (const res of [
      await get('/workflows', nobody),
      await get('/workflows/document-types', nobody),
      await get(`/workflows/${w.id}`, nobody),
      await get(`/workflows/${w.id}/preview`, nobody),
      await post('/workflows', draft(), viewer),
      await post(`/workflows/${w.id}/supersede`, { effective_from: today }, viewer),
      await post(`/workflows/${w.id}/submit`, {}, viewer),
      await post(`/workflows/${w.id}/approve`, {}, viewer),
    ]) {
      expect(res.status, json(res)).toBe(403);
      expect(err(res).code).toBe('PERMISSION_DENIED');
    }
    expect((await get(`/workflows/${w.id}`, viewer)).status).toBe(200);
    expect((await request(app).get('/api/v1/workflows')).status).toBe(401);
    expect((await get('/workflows/999999', viewer)).status).toBe(404);
  });

  it('lets an estate-scoped user manage that estate’s workflows only', async () => {
    const mine = await estate();
    const other = await estate();
    const local = await user(await role(['workflow.view', 'workflow.create', 'workflow.edit']), [
      { scope_type: 'estate', scope_id: mine },
    ]);
    const foreign = await ok(post('/workflows', draft({ estate_id: other })), 201);

    const own = await post('/workflows', draft({ estate_id: mine }), local);
    expect(own.status, json(own)).toBe(201);
    // Organisation-wide workflows are visible to all and changed only with all_estates.
    expect((await get(`/workflows/${(await seeded('sale')).id}`, local)).status).toBe(200);
    for (const res of [
      await post('/workflows', draft(), local),
      await post('/workflows', draft({ estate_id: other }), local),
    ]) {
      expect(res.status, json(res)).toBeGreaterThanOrEqual(403);
      expect(res.status).toBeLessThan(423);
    }
    expect((await get(`/workflows/${foreign.id}`, local)).status).toBe(404);
    expect(many(await get('/workflows?per_page=200', local)).some((w) => w.id === foreign.id)).toBe(false);
  });
});
