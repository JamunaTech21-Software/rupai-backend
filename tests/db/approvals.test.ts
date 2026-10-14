import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { registerApprovalAdapter, type SubmittedDocument } from '../../src/core/approval/adapters.js';
import { bulkApprove, submitForApproval } from '../../src/core/approval/engine.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import { AppError } from '../../src/core/errors/app-error.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { parseBusinessDate, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { PERMISSION_KEYS } from '../../src/modules/identity/permission-catalogue.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.14 — the approval runtime on real MySQL: submission, the frozen path, actions, races, guards,
 * delegation, the queue, exceptions and bulk approval. No approvable document exists before Phase 2, so
 * a test adapter stands in for one, behaving as a real module's would.
 */

const ADMIN = '1';
let WF_APPROVER = '';
let mdb: MigratedDatabase;
let app: Express;
let timezone = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  state: string;
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Body }).data;
const many = (res: { body: unknown }) => (res.body as { data: Body[] }).data;
const err = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { code: string; field?: string; context?: unknown }[] } })
    .error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object = {}, actor = ADMIN) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return one(res);
}

// ---- a stand-in document module ----------------------------------------------------------------

interface TestDoc {
  createdBy: bigint;
  estateId: bigint;
  amount: string;
  state: 'submitted' | 'approved' | 'rejected' | 'draft';
  refuse?: boolean;
  exceptional?: boolean;
  events: string[];
}
const docs = new Map<bigint, TestDoc>();
let nextDoc = 1n;
function adapterFor(documentType: string) {
  return {
    documentType,
    describe: (_tx: unknown, id: bigint): Promise<SubmittedDocument> => {
      const d = docs.get(id);
      if (!d) throw new Error(`no test document ${id.toString()}`);
      return Promise.resolve({
        id,
        number: `T-${id.toString()}`,
        label: `Test document ${id.toString()}`,
        createdBy: d.createdBy,
        estateId: d.estateId,
        values: { total_base_amount: d.amount, amount: d.amount, estate_id: d.estateId.toString() },
        amount: d.amount,
        isExceptional: d.exceptional ?? false,
      });
    },
    onApproved: async (tx: Parameters<Parameters<typeof withTransaction>[1]>[0], id: bigint) => {
      const d = docs.get(id);
      if (!d) throw new Error('missing');
      // A write the effects make, which a refusal must take back with it.
      await tx.statusHistory.create({
        data: {
          recordType: documentType,
          recordId: id.toString(),
          fromState: 'submitted',
          toState: 'approved',
          changedBy: 1n,
          comment: 'effects',
        },
      });
      if (d.refuse) {
        throw new AppError('INSUFFICIENT_STOCK', 'Not enough stock to approve this.', [
          { code: 'INSUFFICIENT_STOCK', message: 'Short by 40 kg.', context: { short_by: '40.000' } },
        ]);
      }
      d.state = 'approved';
      d.events.push('approved');
    },
    onRejected: (_tx: unknown, id: bigint, ctx: { reason: string }) => {
      const d = docs.get(id);
      if (d) {
        d.state = 'rejected';
        d.events.push(`rejected: ${ctx.reason}`);
      }
      return Promise.resolve();
    },
    onReturned: (_tx: unknown, id: bigint, ctx: { comment: string }) => {
      const d = docs.get(id);
      if (d) {
        d.state = 'draft';
        d.events.push(`returned: ${ctx.comment}`);
      }
      return Promise.resolve();
    },
  };
}
for (const t of ['purchase_order', 'field_activity', 'attendance', 'payment'])
  registerApprovalAdapter(adapterFor(t));

function newDoc(over: Partial<TestDoc> & { estateId: bigint; createdBy: bigint }): bigint {
  const id = (nextDoc += 1n);
  docs.set(id, { amount: '40000.00', state: 'submitted', events: [], ...over });
  return id;
}
async function submit(type: string, docId: bigint, submittedBy: string, date?: string) {
  return withTransaction(mdb.db, (tx) =>
    submitForApproval(tx, { timezone }, type, docId, {
      actorId: BigInt(submittedBy),
      ...(date ? { date: parseBusinessDate(date) } : {}),
    }),
  );
}
const requestOf = async (docId: bigint, type = 'purchase_order') =>
  (
    await mdb.migrator.approvalRequest.findFirstOrThrow({
      where: { documentType: type, documentId: docId },
      orderBy: { id: 'desc' },
    })
  ).id.toString();

// ---- people, roles, workflows -------------------------------------------------------------------

async function role(permissions: string[]): Promise<string> {
  return (await ok(post('/roles', { code: unique('R_'), name: 'Approval probe', permissions }), 201)).id;
}
async function user(roleIds: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('ap'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  if (roleIds.length > 0) {
    const current = await get(`/users/${id}`);
    const set = await as(request(app).post(`/api/v1/users/${id}/roles`), ADMIN)
      .set('If-Match', `"${String(one(current).version)}"`)
      .send({ roles: roleIds.map((role_id) => ({ role_id })) });
    expect(set.status, json(set)).toBe(200);
  }
  for (const g of grants) expect((await post(`/users/${id}/scopes`, g)).status).toBe(201);
  return id;
}
async function estate(): Promise<bigint> {
  return runUnscoped('test', async () => {
    const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
    const e = await mdb.migrator.estate.create({
      data: { organisationId: org.id, code: unique('E'), name: 'Estate', createdBy: 1n },
    });
    return e.id;
  });
}
const amount = (field: string, value: string) => ({ field, operator: 'gte', value });
/** An estate workflow, drafted by the Administrator and approved by the workflow approver. */
async function workflow(type: string, estateId: bigint, steps: object[]): Promise<string> {
  const w = await ok(
    post('/workflows', {
      code: unique('WF'),
      name: 'Test workflow',
      document_type: type,
      estate_id: estateId.toString(),
      effective_from: todayIn(timezone),
      steps,
    }),
    201,
  );
  await ok(post(`/workflows/${w.id}/submit`));
  await ok(post(`/workflows/${w.id}/approve`, {}, WF_APPROVER));
  return w.id;
}
const decide = (id: string, kind: string, actor: string, body: object) =>
  post(`/approvals/${id}/${kind}`, body, actor);
const approve = (id: string, actor: string, step: number) =>
  decide(id, 'approve', actor, { step_number: step });

let MANAGERS = '';
let ACCOUNTS = '';
let ACCOUNTANT = '';
let E = 0n;

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
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  WF_APPROVER = await user(
    [await role(['workflow.view', 'workflow.approve'])],
    [{ scope_type: 'all_estates' }],
  );
  MANAGERS = await role(['purchase_order.view', 'purchase_order.approve', 'purchase_order.reject']);
  ACCOUNTS = await role(['purchase_order.view', 'purchase_order.approve', 'purchase_order.reject']);
  ACCOUNTANT = await user([ACCOUNTS], [{ scope_type: 'all_estates' }]);
  E = await estate();
});
afterAll(async () => {
  await mdb.drop();
});

/** The standard ladder on the given roles: step 1 always, 2 from 50,001, 3 from 250,001. */
const ladder = (r1: string, r2: string, r3: string) => [
  { name: 'Estate manager', approver_rule: 'by_role', role_id: r1 },
  {
    name: 'Accounts',
    approver_rule: 'by_role',
    role_id: r2,
    condition: amount('total_base_amount', '50001'),
  },
  {
    name: 'General manager',
    approver_rule: 'by_role',
    role_id: r3,
    condition: amount('total_base_amount', '250001'),
  },
];

describe('submission and the frozen path (P7 §3.3)', () => {
  it('takes the steps whose condition holds, and queues the item for the first step’s approvers only', async () => {
    const e = await estate();
    const elsewhere = await estate();
    const gm = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow('purchase_order', e, ladder(MANAGERS, ACCOUNTS, gm));
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const foreign = await user([MANAGERS], [{ scope_type: 'estate', scope_id: elsewhere.toString() }]);
    const clerk = await user([], [{ scope_type: 'estate', scope_id: e.toString() }]);

    const small = newDoc({ estateId: e, createdBy: BigInt(clerk), amount: '40000.00' });
    const big = newDoc({ estateId: e, createdBy: BigInt(clerk), amount: '300000.00' });
    expect(await submit('purchase_order', small, clerk)).toMatchObject({ outcome: 'pending' });
    await submit('purchase_order', big, clerk);
    const pathOf = async (id: bigint) =>
      (await mdb.migrator.approvalRequest.findFirstOrThrow({ where: { documentId: id } })).path;
    expect(((await pathOf(small)) as { step_number: number }[]).map((p) => p.step_number)).toEqual([1]);
    expect(((await pathOf(big)) as { step_number: number }[]).map((p) => p.step_number)).toEqual([1, 2, 3]);

    const queue = many(await get('/approvals/pending', manager));
    expect(queue.map((i) => i.document_id)).toEqual([small.toString(), big.toString()]);
    expect(queue[1]).toMatchObject({
      step_number: 1,
      step_name: 'Estate manager',
      amount: '300000.00',
      document_number: `T-${big.toString()}`,
      acting_for: null,
      submitted_by: { id: clerk },
    });
    expect(one(await get('/approvals/pending/count', manager))).toEqual({ count: 2 });
    // Another estate's manager, and the step-2 accountant, are not offered it yet.
    expect(many(await get('/approvals/pending', foreign))).toEqual([]);
    expect(
      many(await get('/approvals/pending?filter[document_type]=purchase_order', ACCOUNTANT)).filter(
        (i) => i.document_id === big.toString(),
      ),
    ).toEqual([]);

    // A second submission of a document already pending is refused.
    await expect(submit('purchase_order', big, clerk)).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('approves a document at once when no workflow applies (P7 §3.2)', async () => {
    const id = newDoc({ estateId: E, createdBy: 1n });
    expect(await submit('purchase_order', id, ADMIN, '2019-06-30')).toEqual({
      outcome: 'approved',
      requestId: null,
    });
    expect(docs.get(id)?.state).toBe('approved');
  });
});

describe('acting on a step (P7 §10)', () => {
  it('walks the path step by step and signals the document on the last', async () => {
    const e = await estate();
    const gm = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow('purchase_order', e, ladder(MANAGERS, ACCOUNTS, gm));
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const director = await user([gm], [{ scope_type: 'all_estates' }]);
    const clerk = await user([], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: BigInt(clerk), amount: '300000.00' });
    await submit('purchase_order', doc, clerk);
    const id = await requestOf(doc);

    // The accountant is not an approver of step 1.
    expect(err(await approve(id, ACCOUNTANT, 1)).code).toBe('NOT_AN_APPROVER');
    const after1 = await ok(approve(id, manager, 1));
    expect(after1).toMatchObject({ state: 'pending', current_step_number: 2 });
    expect(err(await approve(id, manager, 2)).code).toBe('NOT_AN_APPROVER');
    await ok(decide(id, 'comment', ACCOUNTANT, { comment: 'Coding checked against budget head 4.' }));
    await ok(approve(id, ACCOUNTANT, 2));
    const done = await ok(approve(id, director, 3));
    expect(done).toMatchObject({
      state: 'approved',
      current_step_number: null,
      completed_at: expect.any(String),
    });
    expect(docs.get(doc)?.events).toEqual(['approved']);
    expect(
      (done.steps as { status: string; decided_by: { id: string } | null }[]).map((s) => [
        s.status,
        s.decided_by?.id,
      ]),
    ).toEqual([
      ['done', manager],
      ['done', ACCOUNTANT],
      ['done', director],
    ]);
    expect((done.actions as { action: string }[]).map((a) => a.action)).toEqual([
      'approve',
      'comment',
      'approve',
      'approve',
    ]);
    expect(err(await approve(id, director, 3)).code).toBe('INVALID_TRANSITION');

    const history = many(
      await get(`/approvals/history?document_type=purchase_order&document_id=${doc.toString()}`, ACCOUNTANT),
    );
    expect(history.filter((h) => h.kind === 'approval').map((h) => h.action)).toEqual([
      'approve',
      'comment',
      'approve',
      'approve',
    ]);
  });

  it('never lets the creator or the submitter decide, unless a routine step allows it (P7 §12)', async () => {
    const e = await estate();
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const creator = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const submitter = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: BigInt(creator) });
    await submit('purchase_order', doc, submitter);
    const id = await requestOf(doc);
    for (const who of [creator, submitter]) {
      const res = await approve(id, who, 1);
      expect(res.status, json(res)).toBe(403);
      expect(err(res).code).toBe('SELF_APPROVAL_FORBIDDEN');
      expect(err(await decide(id, 'reject', who, { step_number: 1, reason: 'no' })).code).toBe(
        'SELF_APPROVAL_FORBIDDEN',
      );
    }
    // The submitter may still comment, and sees the approval without being able to approve it.
    await ok(decide(id, 'comment', submitter, { comment: 'Urgent: harvest starts Monday.' }));
    expect((await ok(get(`/approvals/${id}`, submitter))).can).toEqual({
      approve: false,
      reject: false,
      return: false,
      comment: true,
    });

    // A routine operational record may allow it on a step, and the action is flagged.
    const roleFa = await role(['field_activity.view', 'field_activity.approve']);
    await workflow('field_activity', e, [
      { approver_rule: 'by_role', role_id: roleFa, allow_self_approval: true },
    ]);
    const manager = await user([roleFa], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const fa = newDoc({ estateId: e, createdBy: BigInt(manager) });
    await submit('field_activity', fa, manager);
    const done = await ok(approve(await requestOf(fa, 'field_activity'), manager, 1));
    expect((done.actions as { is_self_approval: boolean }[])[0]?.is_self_approval).toBe(true);
  });

  it('lets exactly one of two simultaneous approvers advance the step (P7 §17)', async () => {
    const e = await estate();
    await workflow('purchase_order', e, ladder(MANAGERS, ACCOUNTS, MANAGERS));
    const a = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const b = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: 1n, amount: '300000.00' });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);
    const [ra, rb] = await Promise.all([approve(id, a, 1), approve(id, b, 1)]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    expect(err(ra.status === 409 ? ra : rb).code).toBe('APPROVAL_STEP_CHANGED');
    const actions = await mdb.migrator.approvalAction.findMany({ where: { approvalRequestId: BigInt(id) } });
    expect(actions.map((x) => [x.action, x.stepNumber])).toEqual([['approve', 1]]);
    expect(one(await get(`/approvals/${id}`))).toMatchObject({ current_step_number: 2 });
  });

  it('restarts from step one after a return; earlier approvals do not carry over (P7 §10.2)', async () => {
    const e = await estate();
    const gm = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow('purchase_order', e, ladder(MANAGERS, ACCOUNTS, gm));
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: 1n, amount: '60000.00' });
    await submit('purchase_order', doc, ADMIN);
    const first = await requestOf(doc);
    await ok(approve(first, manager, 1));
    expect((await decide(first, 'return', ACCOUNTANT, { step_number: 2 })).status).toBe(422);
    const back = await ok(
      decide(first, 'return', ACCOUNTANT, { step_number: 2, comment: 'Attach the quotation.' }),
    );
    expect(back).toMatchObject({ state: 'returned' });
    expect(docs.get(doc)?.events).toEqual(['returned: Attach the quotation.']);

    await submit('purchase_order', doc, ADMIN);
    const second = await requestOf(doc);
    expect(second).not.toBe(first);
    expect(one(await get(`/approvals/${second}`))).toMatchObject({
      state: 'pending',
      current_step_number: 1,
    });
    expect(err(await approve(second, ACCOUNTANT, 2)).code).toBe('APPROVAL_STEP_CHANGED');
    // The first run is history, kept.
    expect(one(await get(`/approvals/${first}`))).toMatchObject({ state: 'returned' });
  });

  it('ends the workflow on rejection, with a reason (P7 §10.1)', async () => {
    const e = await estate();
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: 1n });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);
    expect((await decide(id, 'reject', manager, { step_number: 1 })).status).toBe(422);
    expect(
      await ok(decide(id, 'reject', manager, { step_number: 1, reason: 'Supplier is blacklisted.' })),
    ).toMatchObject({ state: 'rejected' });
    expect(docs.get(doc)?.state).toBe('rejected');
    expect(err(await approve(id, manager, 1)).code).toBe('INVALID_TRANSITION');
    expect(many(await get('/approvals/pending', manager)).some((i) => i.approval_id === id)).toBe(false);
  });
});

describe('the document’s guards at final approval (P7 §2.2)', () => {
  it('records the approval, keeps the document submitted, and lets the approver try again', async () => {
    const e = await estate();
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: 1n, refuse: true });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);

    const refused = await approve(id, manager, 1);
    expect(refused.status, json(refused)).toBe(422);
    expect(err(refused)).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: [{ code: 'INSUFFICIENT_STOCK' }],
    });
    const after = one(await get(`/approvals/${id}`, manager));
    expect(after).toMatchObject({
      state: 'pending',
      current_step_number: 1,
      guard_failure: { code: 'INSUFFICIENT_STOCK', by: manager },
    });
    expect((after.actions as { action: string }[]).map((a) => a.action)).toEqual(['approve']);
    // The effects' own write was taken back with them.
    expect(
      await mdb.migrator.statusHistory.count({
        where: { recordType: 'purchase_order', recordId: doc.toString() },
      }),
    ).toBe(0);
    expect(docs.get(doc)?.state).toBe('submitted');

    const d = docs.get(doc);
    if (d) d.refuse = false;
    expect(await ok(approve(id, manager, 1))).toMatchObject({ state: 'approved', guard_failure: null });
    expect(
      await mdb.migrator.statusHistory.count({
        where: { recordType: 'purchase_order', recordId: doc.toString() },
      }),
    ).toBe(1);
  });

  it('keeps a submitted document on the path it was submitted under, whatever the workflow becomes', async () => {
    const e = await estate();
    const w = await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const doc = newDoc({ estateId: e, createdBy: 1n, amount: '900000.00' });
    await submit('purchase_order', doc, ADMIN);
    // The workflow gains a second step from today. The document in flight is not affected.
    const next = await ok(
      post(`/workflows/${w}/supersede`, {
        effective_from: todayIn(timezone),
        steps: ladder(MANAGERS, ACCOUNTS, MANAGERS),
      }),
      201,
    );
    await ok(post(`/workflows/${next.id}/submit`));
    await ok(post(`/workflows/${next.id}/approve`, {}, WF_APPROVER));
    expect(await ok(approve(await requestOf(doc), manager, 1))).toMatchObject({ state: 'approved' });
    // A document submitted now takes the new path.
    const later = newDoc({ estateId: e, createdBy: 1n, amount: '900000.00' });
    await submit('purchase_order', later, ADMIN);
    expect(await ok(approve(await requestOf(later), manager, 1))).toMatchObject({
      state: 'pending',
      current_step_number: 2,
    });
  });
});

describe('unresolved steps (P7 §4.3)', () => {
  it('lists an approval nobody can act on until somebody is given the role', async () => {
    const e = await estate();
    const vacant = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: vacant }]);
    const doc = newDoc({ estateId: e, createdBy: 1n });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);
    const viewer = await user([await role(['workflow.view'])], [{ scope_type: 'all_estates' }]);
    expect(many(await get('/approvals/exceptions', viewer)).map((a) => a.id)).toContain(id);
    expect(one(await get(`/approvals/${id}`, viewer))).toMatchObject({ is_unresolved: true });

    await user([vacant], [{ scope_type: 'estate', scope_id: e.toString() }]);
    expect(many(await get('/approvals/exceptions', viewer)).map((a) => a.id)).not.toContain(id);
    expect(one(await get(`/approvals/${id}`, viewer))).toMatchObject({ is_unresolved: false });
  });
});

describe('delegation (P7 §11.1)', () => {
  it('lets a delegate act for the approver, recorded as acting-for, one hop only and only while it lasts', async () => {
    const e = await estate();
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const manager = await user([MANAGERS], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const canApprove = await role(['purchase_order.view', 'purchase_order.approve']);
    const deputy = await user([canApprove], [{ scope_type: 'all_estates' }]);
    const deputysDeputy = await user([canApprove], [{ scope_type: 'all_estates' }]);
    const noPermission = await user([], [{ scope_type: 'all_estates' }]);
    const now = Date.now();
    const period = {
      valid_from: new Date(now - 60_000).toISOString(),
      valid_to: new Date(now + 86_400_000).toISOString(),
      reason: 'Annual leave',
    };

    const d1 = await ok(
      post('/approvals/delegate', { from_user_id: manager, to_user_id: deputy, ...period }),
      201,
    );
    expect(d1).toMatchObject({ is_active: true, document_type: null });
    await ok(
      post('/approvals/delegate', { from_user_id: deputy, to_user_id: deputysDeputy, ...period }),
      201,
    );
    await ok(
      post('/approvals/delegate', {
        from_user_id: manager,
        to_user_id: noPermission,
        ...period,
        document_type: 'purchase_order',
      }),
      201,
    );

    const doc = newDoc({ estateId: e, createdBy: 1n });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);
    const [item] = many(await get('/approvals/pending', deputy));
    expect(item).toMatchObject({ approval_id: id, acting_for: { id: manager } });
    // Delegated authority is not delegated onward; and delegation never confers a permission.
    expect(err(await approve(id, deputysDeputy, 1)).code).toBe('NOT_AN_APPROVER');
    expect(err(await approve(id, noPermission, 1)).code).toBe('PERMISSION_DENIED');

    const done = await ok(approve(id, deputy, 1));
    expect((done.actions as { user: { id: string }; acting_for: { id: string } | null }[])[0]).toMatchObject({
      user: { id: deputy },
      acting_for: { id: manager },
    });

    // Once ended, it no longer applies.
    await ok(post(`/approvals/delegations/${d1.id}/end`));
    const doc2 = newDoc({ estateId: e, createdBy: 1n });
    await submit('purchase_order', doc2, ADMIN);
    expect(err(await approve(await requestOf(doc2), deputy, 1)).code).toBe('NOT_AN_APPROVER');
    expect(err(await post(`/approvals/delegations/${d1.id}/end`)).code).toBe('INVALID_TRANSITION');
    const listed = many(
      await get(`/approvals/delegations?filter[user_id]=${manager}&filter[is_active]=true`),
    );
    expect(listed.map((d) => d.id)).not.toContain(d1.id);
  });

  it('refuses self-delegation, an unbounded period, a duplicate and a circular one', async () => {
    const a = await user([], []);
    const b = await user([], []);
    const now = Date.now();
    const from = new Date(now).toISOString();
    const to = new Date(now + 86_400_000).toISOString();
    const body = (over: object) => ({
      from_user_id: a,
      to_user_id: b,
      valid_from: from,
      valid_to: to,
      reason: 'Travel',
      ...over,
    });
    expect((await post('/approvals/delegate', body({ to_user_id: a }))).status).toBe(422);
    expect(
      (await post('/approvals/delegate', body({ valid_to: new Date(now + 91 * 86_400_000).toISOString() })))
        .status,
    ).toBe(422);
    expect((await post('/approvals/delegate', body({ valid_to: from }))).status).toBe(422);
    await ok(post('/approvals/delegate', body({})), 201);
    expect(err(await post('/approvals/delegate', body({}))).code).toBe('DUPLICATE_KEY');
    expect(
      err(await post('/approvals/delegate', body({ from_user_id: b, to_user_id: a }))).details[0]?.code,
    ).toBe('DELEGATION_CIRCULAR');
    const noEdit = await user([await role(['user.view'])], [{ scope_type: 'all_estates' }]);
    expect((await post('/approvals/delegate', body({}), noEdit)).status).toBe(403);
  });
});

describe('visibility', () => {
  it('shows an approval to those involved and to viewers in scope, 404 to anyone else', async () => {
    const e = await estate();
    const elsewhere = await estate();
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    const doc = newDoc({ estateId: e, createdBy: 1n });
    await submit('purchase_order', doc, ADMIN);
    const id = await requestOf(doc);
    const viewers = await role(['purchase_order.view']);
    const inScope = await user([viewers], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const outOfScope = await user([viewers], [{ scope_type: 'estate', scope_id: elsewhere.toString() }]);
    const stranger = await user([], [{ scope_type: 'all_estates' }]);
    expect((await ok(get(`/approvals/${id}`, inScope))).can).toEqual({
      approve: false,
      reject: false,
      return: false,
      comment: false,
    });
    for (const who of [outOfScope, stranger]) expect((await get(`/approvals/${id}`, who)).status).toBe(404);
    expect((await approve(id, stranger, 1)).status).toBe(404);
    expect(
      (await get(`/approvals/history?document_type=purchase_order&document_id=${doc.toString()}`, stranger))
        .status,
    ).toBe(403);
    expect((await get('/approvals', stranger)).status).toBe(403);
    expect((await request(app).get('/api/v1/approvals/pending')).status).toBe(401);
  });
});

describe('bulk approval (P7 §13.2)', () => {
  it('approves the unremarkable, leaves out the exceptional, and writes one action per record', async () => {
    const e = await estate();
    const supervisors = await role(['attendance.view', 'attendance.approve']);
    await workflow('attendance', e, [{ approver_rule: 'by_role', role_id: supervisors }]);
    const assistant = await user([supervisors], [{ scope_type: 'estate', scope_id: e.toString() }]);
    const ids: bigint[] = [];
    for (const exceptional of [false, false, true]) {
      const doc = newDoc({ estateId: e, createdBy: 1n, exceptional });
      await submit('attendance', doc, ADMIN);
      ids.push(BigInt(await requestOf(doc, 'attendance')));
    }
    const po = newDoc({ estateId: e, createdBy: 1n });
    await workflow('purchase_order', e, [{ approver_rule: 'by_role', role_id: MANAGERS }]);
    await submit('purchase_order', po, ADMIN);
    const poRequest = BigInt(await requestOf(po));

    const resolver = dbPermissionResolver(mdb.db);
    const permissions = await resolver.permissionsOf(BigInt(assistant));
    const result = await runUnscoped('test', () =>
      bulkApprove(
        mdb.db,
        { timezone, can: (p) => Promise.resolve(permissions.has(p)), knownPermissions: PERMISSION_KEYS },
        [...ids, poRequest],
        {
          actorId: BigInt(assistant),
        },
      ),
    );
    expect(result.approved).toEqual([ids[0], ids[1]]);
    expect(result.excluded.map((x) => x.requestId)).toEqual([ids[2], poRequest]);
    const actions = await mdb.migrator.approvalAction.findMany({ where: { approvalRequestId: { in: ids } } });
    expect(actions).toHaveLength(2);
    expect(new Set(actions.map((a) => a.bulkReference))).toEqual(new Set([result.bulkReference]));
  });
});
