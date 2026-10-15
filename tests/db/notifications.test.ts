import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { registerApprovalAdapter, type SubmittedDocument } from '../../src/core/approval/adapters.js';
import { submitForApproval } from '../../src/core/approval/engine.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { withTransaction } from '../../src/core/db/transaction.js';
import type { JobContext } from '../../src/core/jobs/registry.js';
import { runJob, type RunnerDeps } from '../../src/core/jobs/runner.js';
import { createJob } from '../../src/core/jobs/store.js';
import type { Mailer } from '../../src/core/mail/mailer.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { addDays, businessDateToDb, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { deliverJob, SEED_RULES } from '../../src/modules/notifications/notifications.jobs.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.16 — notifications on real MySQL: the approval and expiry evaluations, the dedupe key ("the nightly
 * job does not re-notify the same item twice"), email delivery, the personal API and the rules.
 */

const ADMIN = '1';
let mdb: MigratedDatabase;
let app: Express;
let runner: RunnerDeps;
let sent: { to: string; subject: string; text: string }[];
let timezone = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Body }).data;
const many = (res: { body: unknown }) => (res.body as { data: Body[] }).data;
const err = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object = {}, actor = ADMIN) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);
const patch = (path: string, body: object, version: number, actor = ADMIN) =>
  as(request(app).patch(`/api/v1${path}`), actor)
    .set('If-Match', `"${String(version)}"`)
    .send(body);
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return one(res);
}

/** Runs a job now, as a worker would, and returns its row. */
async function run(type: string) {
  const { job } = await createJob(mdb.db, { type, payload: {} });
  await runJob(runner, job.id);
  return mdb.migrator.job.findUniqueOrThrow({ where: { id: job.id } });
}
const result = async (type: string) => (await run(type)).result as Record<string, unknown>;

const notificationsOf = (userId: string) =>
  mdb.migrator.notification.findMany({
    where: { userId: BigInt(userId) },
    include: { rule: { select: { code: true } } },
    orderBy: { id: 'asc' },
  });

// ---- a stand-in approvable document (none exists before Phase 2) --------------------------------

const docs = new Map<bigint, { estateId: bigint; createdBy: bigint }>();
let nextDoc = 100n;
registerApprovalAdapter({
  documentType: 'purchase_order',
  describe: (_tx: unknown, id: bigint): Promise<SubmittedDocument> => {
    const d = docs.get(id);
    if (!d) throw new Error('no such test document');
    return Promise.resolve({
      id,
      number: `PO-${id.toString()}`,
      label: `Purchase order ${id.toString()}`,
      createdBy: d.createdBy,
      estateId: d.estateId,
      values: { total_base_amount: '1000.00', estate_id: d.estateId.toString() },
      amount: '1000.00',
    });
  },
  onApproved: () => Promise.resolve(),
  onRejected: () => Promise.resolve(),
  onReturned: () => Promise.resolve(),
});
async function submitted(estateId: bigint, by: string): Promise<string> {
  const id = (nextDoc += 1n);
  docs.set(id, { estateId, createdBy: BigInt(by) });
  const r = await withTransaction(mdb.db, (tx) =>
    submitForApproval(tx, { timezone }, 'purchase_order', id, { actorId: BigInt(by) }),
  );
  return (r.requestId ?? 0n).toString();
}

// ---- people and places ------------------------------------------------------------------------

async function role(permissions: string[]): Promise<string> {
  return (await ok(post('/roles', { code: unique('R_'), name: 'Notification probe', permissions }), 201)).id;
}
async function user(roleIds: string[], grants: object[], email = true): Promise<string> {
  const username = unique('nt');
  const u = await mdb.migrator.user.create({
    data: { username, email: email ? `${username}@example.test` : null, passwordHash: 'x', createdBy: 1n },
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
const onEstate = (e: bigint) => [{ scope_type: 'estate', scope_id: e.toString() }];
async function estate(): Promise<bigint> {
  return runUnscoped('test', async () => {
    const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
    const e = await mdb.migrator.estate.create({
      data: { organisationId: org.id, code: unique('E'), name: unique('Estate '), createdBy: 1n },
    });
    return e.id;
  });
}
async function workflow(estateId: bigint, steps: object[]): Promise<void> {
  const w = await ok(
    post('/workflows', {
      code: unique('WF'),
      name: 'Notification test workflow',
      document_type: 'purchase_order',
      estate_id: estateId.toString(),
      effective_from: todayIn(timezone),
      steps,
    }),
    201,
  );
  await ok(post(`/workflows/${w.id}/submit`));
  await ok(post(`/workflows/${w.id}/approve`, {}, WF_APPROVER));
}
let LICENCE = 0n;
async function documentOn(estateId: bigint, expiresInDays: number, title: string): Promise<bigint> {
  const d = await mdb.migrator.documentFile.create({
    data: {
      ownerType: 'estate',
      ownerId: estateId,
      documentTypeId: LICENCE,
      seriesNo: (seq += 1),
      title,
      fileName: 'licence.pdf',
      storedPath: `documents/2026/10/${unique('X').padEnd(26, '0').slice(0, 26)}`,
      mimeType: 'application/pdf',
      fileSizeBytes: 100,
      expiryDate: businessDateToDb(addDays(todayIn(timezone), expiresInDays)),
      uploadedBy: 1n,
      createdBy: 1n,
    },
  });
  return d.id;
}

let WF_APPROVER = '';
let PO_APPROVERS = '';
let E = 0n;
let ELSEWHERE = 0n;

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
  sent = deps.mailer.sent;
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(deps),
    authenticate: testActor(),
  });
  runner = { db: mdb.db, logger: silentLogger(), leaseSeconds: 30, retentionDays: 7 };
  WF_APPROVER = await user(
    [await role(['workflow.view', 'workflow.approve'])],
    [{ scope_type: 'all_estates' }],
  );
  PO_APPROVERS = await role(['purchase_order.view', 'purchase_order.approve']);
  E = await estate();
  ELSEWHERE = await estate();
  LICENCE = (await mdb.migrator.documentType.findFirstOrThrow({ where: { code: 'LICENCE' } })).id;
}, 180_000);
afterAll(async () => {
  await mdb.drop();
});

describe('the seeded rules (P3 Table 31.2)', () => {
  it('seeds one active rule per trigger, the administrators’ ones by email, and lists the triggers', async () => {
    const rules = many(await get('/notification-rules?per_page=100'));
    expect(rules.map((r) => r.code).sort()).toEqual(SEED_RULES.map((r) => r.code).sort());
    expect(rules.every((r) => r.is_active)).toBe(true);
    const stuck = rules.find((r) => r.code === 'APPROVAL_UNRESOLVED');
    expect(stuck).toMatchObject({
      recipient_rule: 'by_role',
      role: { code: 'ADMINISTRATOR' },
      channel: 'email',
      trigger: { evaluated: true },
    });
    expect(rules.find((r) => r.code === 'LOW_STOCK')).toMatchObject({
      trigger: { evaluated: false, arrives_with: 'Inventory' },
    });
    const triggers = many(await get('/notification-rules/triggers'));
    expect(triggers).toHaveLength(10);
    expect(triggers.find((t) => t.key === 'approval_pending')).toMatchObject({
      recipient_rules: ['approvers'],
    });
  });
});

describe('approval notifications (P7 §4.2, §4.3)', () => {
  it('tells the step’s approvers in scope and their delegates, never the submitter, once per step', async () => {
    const e = await estate();
    await workflow(e, [
      { name: 'Estate manager', approver_rule: 'by_role', role_id: PO_APPROVERS, allow_self_approval: false },
    ]);
    const manager = await user([PO_APPROVERS], onEstate(e));
    const managerElsewhere = await user([PO_APPROVERS], onEstate(ELSEWHERE));
    const submitter = await user([PO_APPROVERS], onEstate(e));
    const deputy = await user([await role(['purchase_order.view', 'purchase_order.approve'])], onEstate(e));
    const now = Date.now();
    await ok(
      post('/approvals/delegate', {
        from_user_id: manager,
        to_user_id: deputy,
        valid_from: new Date(now - 60_000).toISOString(),
        valid_to: new Date(now + 86_400_000).toISOString(),
        reason: 'Leave',
      }),
      201,
    );

    const approval = await submitted(e, submitter);
    // Nothing is written by the submission itself: notifications are the job's (P1 §4.3).
    expect(await notificationsOf(manager)).toHaveLength(0);

    await run('approval.notify');
    const mine = await notificationsOf(manager);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      linkType: 'approval_request',
      linkId: BigInt(approval),
      severity: 'info',
      deliveryState: 'not_required',
      rule: { code: 'APPROVAL_PENDING' },
    });
    expect(mine[0]?.subject).toContain(`Approval needed: Purchase order PO-`);
    expect(await notificationsOf(deputy)).toHaveLength(1);
    expect(await notificationsOf(submitter)).toHaveLength(0);
    expect(await notificationsOf(managerElsewhere)).toHaveLength(0);

    // Run again, and again: the same step is never announced twice.
    await run('approval.notify');
    await run('approval.notify');
    expect(await notificationsOf(manager)).toHaveLength(1);
    expect(await notificationsOf(deputy)).toHaveLength(1);

    // The bell and the link.
    const list = many(await get('/notifications', manager));
    expect(list[0]).toMatchObject({
      link: { type: 'approval_request', id: approval, route: `/approvals/${approval}` },
      is_read: false,
      email: { state: 'not_required' },
    });
  });

  it('moves on with the approval: the next step’s approvers are told after a decision, which asks for a run', async () => {
    const e = await estate();
    const second = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow(e, [
      { name: 'Manager', approver_rule: 'by_role', role_id: PO_APPROVERS },
      { name: 'Accounts', approver_rule: 'by_role', role_id: second },
    ]);
    const manager = await user([PO_APPROVERS], onEstate(e));
    const accounts = await user([second], onEstate(e));
    const approval = await submitted(e, WF_APPROVER);
    await run('approval.notify');
    expect(await notificationsOf(accounts)).toHaveLength(0);

    await ok(post(`/approvals/${approval}/approve`, { step_number: 1 }, manager));
    // The decision committed, then asked for an evaluation (it never writes notifications itself).
    const asked = await mdb.migrator.job.findFirst({
      where: { type: 'approval.notify', dedupeKey: 'approval:all:notify' },
      orderBy: { id: 'desc' },
    });
    expect(asked?.state).toBe('queued');
    await runJob(runner, asked?.id ?? 0n);
    expect(await notificationsOf(accounts)).toHaveLength(1);
    expect((await notificationsOf(accounts))[0]?.body).toContain('step 2 (Accounts)');
  });

  it('tells the administrators, and the next step’s approvers, about an approval nobody can act on', async () => {
    const e = await estate();
    const nobodyHoldsThis = await role(['purchase_order.view', 'purchase_order.approve']);
    const next = await role(['purchase_order.view', 'purchase_order.approve']);
    await workflow(e, [
      { name: 'Vacant post', approver_rule: 'by_role', role_id: nobodyHoldsThis },
      { name: 'After it', approver_rule: 'by_role', role_id: next },
    ]);
    const nextApprover = await user([next], onEstate(e));
    const approval = await submitted(e, WF_APPROVER);

    const r = await result('approval.notify');
    expect(Number(r.unresolved)).toBeGreaterThanOrEqual(1);
    const admin = (await notificationsOf(ADMIN)).filter((n) => n.linkId === BigInt(approval));
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ severity: 'warning', rule: { code: 'APPROVAL_UNRESOLVED' } });
    expect(admin[0]?.subject).toContain('Nobody can approve');
    expect((await notificationsOf(nextApprover)).map((n) => n.rule.code)).toEqual(['APPROVAL_UNRESOLVED']);

    await run('approval.notify');
    expect((await notificationsOf(ADMIN)).filter((n) => n.linkId === BigInt(approval))).toHaveLength(1);
  });
});

describe('document expiry: the nightly job does not re-notify the same item twice', () => {
  it('reports documents within lead_days or expired, to those who may see the owner, once per document', async () => {
    const e = await estate();
    const viewer = await user([await role(['estate.view'])], onEstate(e));
    const viewerElsewhere = await user([await role(['estate.view'])], onEstate(ELSEWHERE));
    const noPermission = await user([await role(['field.view'])], onEstate(e));
    const soon = await documentOn(e, 10, 'Trade licence');
    const expired = await documentOn(e, -3, 'Fire licence');
    await documentOn(e, 60, 'Far-off licence');

    await run('document.notify_expiry');
    const mine = await notificationsOf(viewer);
    expect(mine.map((n) => n.linkId).sort()).toEqual([soon, expired].sort());
    expect(mine.find((n) => n.linkId === soon)).toMatchObject({ severity: 'warning' });
    expect(mine.find((n) => n.linkId === soon)?.subject).toMatch(/^Trade licence expires in 10 days: /);
    expect(mine.find((n) => n.linkId === expired)).toMatchObject({ severity: 'critical' });
    expect(mine.find((n) => n.linkId === expired)?.subject).toMatch(/^Fire licence has expired: /);
    expect(await notificationsOf(viewerElsewhere)).toHaveLength(0);
    expect(await notificationsOf(noPermission)).toHaveLength(0);

    // Night after night: nothing new.
    for (let night = 0; night < 3; night += 1) await run('document.notify_expiry');
    expect(await notificationsOf(viewer)).toHaveLength(2);
    // The dedupe date is the expiry date, not the night the job ran.
    expect(mine.find((n) => n.linkId === soon)?.generationDate).toEqual(
      businessDateToDb(addDays(todayIn(timezone), 10)),
    );

    // A renewal is a new version: superseded, the old one is reported no more.
    await mdb.migrator.documentFile.update({
      where: { id: soon },
      data: { isCurrent: false, status: 'superseded' },
    });
    await run('document.notify_expiry');
    expect(await notificationsOf(viewer)).toHaveLength(2);
  });

  it('never notifies a disabled user', async () => {
    const e = await estate();
    const disabled = await user([await role(['estate.view'])], onEstate(e));
    await mdb.migrator.user.update({ where: { id: BigInt(disabled) }, data: { status: 'disabled' } });
    await documentOn(e, 5, 'Licence of a disabled user’s estate');
    await run('document.notify_expiry');
    expect(await notificationsOf(disabled)).toHaveLength(0);
  });
});

describe('email delivery', () => {
  it('sends by email when the rule says so, once, and records it', async () => {
    const [expiry] = many(await get('/notification-rules?filter[trigger_type]=document_expiry'));
    const switched = await ok(
      patch(`/notification-rules/${expiry?.id ?? ''}`, { channel: 'email' }, expiry?.version ?? 0),
    );
    expect(switched.channel).toBe('email');

    const e = await estate();
    const viewer = await user([await role(['estate.view'])], onEstate(e));
    const noEmail = await user([await role(['estate.view'])], onEstate(e), false);
    await documentOn(e, 2, 'Boiler certificate');
    await run('document.notify_expiry');
    const [n] = await notificationsOf(viewer);
    expect(n?.deliveryState).toBe('pending');
    expect((await notificationsOf(noEmail))[0]?.deliveryState).toBe('skipped');

    // emit asked for a delivery run; run it.
    const delivery = await mdb.migrator.job.findFirstOrThrow({
      where: { type: 'notification.deliver', dedupeKey: 'notification:email:deliver', state: 'queued' },
    });
    const before = sent.length;
    await runJob(runner, delivery.id);
    // Earlier tests left the stuck-approval emails (that rule is email by default) for this run too.
    const address = (await mdb.migrator.user.findUniqueOrThrow({ where: { id: BigInt(viewer) } })).email;
    const mail = sent.slice(before).filter((m) => m.to === address);
    expect(mail).toHaveLength(1);
    expect(mail[0]?.subject).toMatch(/^\[RupAI\] Boiler certificate expires in 2 days: /);
    expect(mail[0]?.text).toContain('/documents/expiring');
    expect((await notificationsOf(viewer))[0]).toMatchObject({ deliveryState: 'sent', deliveryAttempts: 1 });
    const sentNow = sent.length;
    await result('notification.deliver');
    expect(sent.length).toBe(sentNow);

    await ok(patch(`/notification-rules/${expiry?.id ?? ''}`, { channel: 'in_app' }, switched.version));
  });

  it('retries a refused send, then marks it failed, and never sends a message twice', async () => {
    const e = await estate();
    const viewer = await user([await role(['estate.view'])], onEstate(e));
    const n = await mdb.migrator.notification.create({
      data: {
        notificationRuleId: (
          await mdb.migrator.notificationRule.findUniqueOrThrow({ where: { code: 'ACCESS_REVIEW' } })
        ).id,
        userId: BigInt(viewer),
        subject: 'Refused',
        body: 'x',
        linkType: 'access_review',
        linkId: 0n,
        severity: 'warning',
        generationDate: businessDateToDb(todayIn(timezone)),
        deliveryState: 'pending',
      },
    });
    const refusing: Mailer = { send: () => Promise.reject(new Error('550 mailbox unavailable')) };
    const job = deliverJob(mdb.db, refusing, null);
    const ctx = {
      signal: new AbortController().signal,
      logger: silentLogger(),
      progress: () => Promise.resolve(),
    } as unknown as JobContext<Record<string, never>>;
    for (const expected of ['pending', 'pending', 'failed']) {
      await job.run(ctx);
      expect((await mdb.migrator.notification.findUniqueOrThrow({ where: { id: n.id } })).deliveryState).toBe(
        expected,
      );
    }
    const final = await mdb.migrator.notification.findUniqueOrThrow({ where: { id: n.id } });
    expect(final).toMatchObject({ deliveryAttempts: 3, deliveryError: '550 mailbox unavailable' });

    // A send that never finished (the process died) is marked failed, not sent again.
    const stuck = await mdb.migrator.notification.update({
      where: { id: n.id },
      data: { deliveryState: 'sending', deliveryStartedAt: new Date(Date.now() - 3_600_000) },
    });
    await job.run(ctx);
    expect(
      (await mdb.migrator.notification.findUniqueOrThrow({ where: { id: stuck.id } })).deliveryState,
    ).toBe('failed');
  });
});

describe('my notifications (the bell)', () => {
  let alice = '';
  let bob = '';
  let ids: string[] = [];
  beforeAll(async () => {
    const e = await estate();
    alice = await user([await role(['estate.view'])], onEstate(e));
    bob = await user([await role(['estate.view'])], onEstate(ELSEWHERE));
    await documentOn(e, 1, 'Alpha licence');
    await documentOn(e, -1, 'Beta licence');
    await documentOn(e, 3, 'Gamma licence');
    await run('document.notify_expiry');
    ids = many(await get('/notifications', alice)).map((n) => n.id);
    expect(ids).toHaveLength(3);
  });

  it('counts, reads, dismisses and restores my own, newest first', async () => {
    expect(await ok(get('/notifications/summary', alice))).toMatchObject({ unread: 3, unread_critical: 1 });
    const [newest] = ids;
    const read = await ok(post(`/notifications/${newest ?? ''}/read`, {}, alice));
    expect(read).toMatchObject({ is_read: true });
    expect((await ok(post(`/notifications/${newest ?? ''}/read`, {}, alice))).read_at).toBe(read.read_at);
    expect(await ok(get('/notifications/summary', alice))).toMatchObject({ unread: 2 });
    expect(many(await get('/notifications?filter[is_read]=false', alice))).toHaveLength(2);

    await ok(post(`/notifications/${newest ?? ''}/unread`, {}, alice));
    const dismissed = await ok(post(`/notifications/${ids[1] ?? ''}/dismiss`, {}, alice));
    expect(dismissed).toMatchObject({ is_read: true });
    expect(dismissed.dismissed_at).not.toBeNull();
    expect(many(await get('/notifications', alice)).map((n) => n.id)).not.toContain(ids[1]);
    expect(many(await get('/notifications?filter[is_dismissed]=true', alice)).map((n) => n.id)).toEqual([
      ids[1],
    ]);
    await ok(post(`/notifications/${ids[1] ?? ''}/restore`, {}, alice));
    expect(many(await get('/notifications', alice))).toHaveLength(3);
  });

  it('marks all read up to the newest shown, and keeps one that arrived meanwhile unread', async () => {
    const oldest = ids[ids.length - 1] ?? '';
    const marked = await ok(post('/notifications/read-all', { up_to_id: oldest }, alice));
    expect(marked).toMatchObject({ marked_read: 1 });
    await ok(post('/notifications/read-all', {}, alice));
    expect(await ok(get('/notifications/summary', alice))).toMatchObject({ unread: 0, unread_critical: 0 });
  });

  it('shows nobody else’s: 404 for another user’s notification', async () => {
    expect(many(await get('/notifications', bob))).toHaveLength(0);
    for (const call of [
      get(`/notifications/${ids[0] ?? ''}`, bob),
      post(`/notifications/${ids[0] ?? ''}/read`, {}, bob),
      post(`/notifications/${ids[0] ?? ''}/dismiss`, {}, bob),
    ]) {
      const res = await call;
      expect(res.status, json(res)).toBe(404);
    }
    expect(
      (await mdb.migrator.notification.findUniqueOrThrow({ where: { id: BigInt(ids[0] ?? '0') } }))
        .dismissedAt,
    ).toBeNull();
  });
});

describe('notification rules (administration)', () => {
  it('needs notification.view / create / edit', async () => {
    const plain = await user([await role(['estate.view'])], onEstate(E));
    expect((await get('/notification-rules', plain)).status).toBe(403);
    expect((await get('/notification-rules/triggers', plain)).status).toBe(403);
    expect(
      (
        await post(
          '/notification-rules',
          { code: 'X1', name: 'x', trigger_type: 'document_expiry', recipient_rule: 'by_scope' },
          plain,
        )
      ).status,
    ).toBe(403);
    // Everyone has their own notifications without any permission.
    expect((await get('/notifications', plain)).status).toBe(200);
  });

  it('adds a rule the trigger allows, refuses one it does not, and audits it', async () => {
    const someone = await user([], []);
    const refused = async (body: object, field: string) => {
      const res = await post('/notification-rules', { code: unique('BAD'), name: 'Bad', ...body });
      expect(res.status, json(res)).toBe(422);
      expect(err(res).details.map((d) => d.field)).toContain(field);
    };
    await refused({ trigger_type: 'document_expiry', recipient_rule: 'approvers' }, 'recipient_rule');
    await refused({ trigger_type: 'document_expiry', recipient_rule: 'by_role' }, 'role_id');
    await refused({ trigger_type: 'document_expiry', recipient_rule: 'by_named_user' }, 'user_id');
    await refused(
      { trigger_type: 'approval_pending', recipient_rule: 'approvers', lead_days: 3 },
      'lead_days',
    );
    await refused(
      {
        trigger_type: 'document_expiry',
        recipient_rule: 'by_scope',
        condition: { document_type_codes: ['NOPE'] },
      },
      'condition.document_type_codes',
    );

    const code = unique('LICENCE_7D_');
    const created = await ok(
      post('/notification-rules', {
        code,
        name: 'Licences a week ahead, to the estate secretary',
        trigger_type: 'document_expiry',
        recipient_rule: 'by_named_user',
        user_id: someone,
        lead_days: 7,
        channel: 'email',
        condition: { document_type_codes: ['licence'] },
      }),
      201,
    );
    expect(created).toMatchObject({
      code: code.toUpperCase(),
      user: { id: someone },
      lead_days: 7,
      condition: { document_type_codes: ['LICENCE'] },
    });
    const dup = await post('/notification-rules', {
      code,
      name: 'Again',
      trigger_type: 'document_expiry',
      recipient_rule: 'by_scope',
    });
    expect(dup.status, json(dup)).toBe(422);
    expect(err(dup).code).toBe('DUPLICATE_KEY');

    // Edited under If-Match; switching to by_scope clears the named user.
    const stale = await patch(`/notification-rules/${created.id}`, { lead_days: 14 }, created.version + 5);
    expect(stale.status).toBe(409);
    const edited = await ok(
      patch(
        `/notification-rules/${created.id}`,
        { recipient_rule: 'by_scope', is_active: false },
        created.version,
      ),
    );
    expect(edited).toMatchObject({ recipient_rule: 'by_scope', user: null, is_active: false });
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'notification_rule', recordId: created.id },
    });
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['create', 'update']));
    expect(audit.some((a) => a.field === 'is_active' && a.newValue === 'false')).toBe(true);
  });

  it('an inactive rule notifies nobody', async () => {
    const [pending] = many(await get('/notification-rules?filter[trigger_type]=approval_pending'));
    const off = await ok(
      patch(`/notification-rules/${pending?.id ?? ''}`, { is_active: false }, pending?.version ?? 0),
    );
    const e = await estate();
    await workflow(e, [{ name: 'Manager', approver_rule: 'by_role', role_id: PO_APPROVERS }]);
    const manager = await user([PO_APPROVERS], onEstate(e));
    await submitted(e, WF_APPROVER);
    await run('approval.notify');
    expect(await notificationsOf(manager)).toHaveLength(0);
    await ok(patch(`/notification-rules/${pending?.id ?? ''}`, { is_active: true }, off.version));
    await run('approval.notify');
    expect(await notificationsOf(manager)).toHaveLength(1);
  });
});

describe('the weekly access review (P6 §9.1)', () => {
  it('tells the administrators when it finds unauthorised concentration, once per day it runs', async () => {
    const poster = await role(['journal.view', 'journal.post']);
    const holder = await user([], []);
    // Assigned behind the API's back: the API would refuse a sensitive grant without authorisation.
    await mdb.migrator.userRole.create({
      data: { userId: BigInt(holder), roleId: BigInt(poster), grantedBy: 1n },
    });
    const r = await result('role.concentration_review');
    expect(Number(r.unauthorised)).toBeGreaterThanOrEqual(1);
    expect(Number(r.notifications_created)).toBeGreaterThanOrEqual(1);
    const review = (await notificationsOf(ADMIN)).filter((n) => n.rule.code === 'ACCESS_REVIEW');
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ linkType: 'access_review', severity: 'warning' });
    expect(review[0]?.body).toContain('without a written authorisation');
    expect(one(await get(`/notifications/${review[0]?.id.toString() ?? ''}`))).toMatchObject({
      link: { route: '/admin/access-review' },
    });

    await run('role.concentration_review');
    expect((await notificationsOf(ADMIN)).filter((n) => n.rule.code === 'ACCESS_REVIEW')).toHaveLength(1);
  });
});
