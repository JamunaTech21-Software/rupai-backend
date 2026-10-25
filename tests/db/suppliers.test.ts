import type { Server } from 'node:http';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { partyLabels } from '../../src/core/settlement/parties.js';
import { buildModules } from '../../src/modules/index.js';
import {
  BANK_CHANGE_RECENT_SETTING,
  bankDetailsRecentlyChanged,
} from '../../src/modules/procurement/suppliers.service.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P4.01 — suppliers on real MySQL: the master (numbering, organisation tier, approval flag, contacts with the
 * cached primary), bank details that change only through an approved bank detail change (the verification:
 * the change routes to finance), its lifecycle (one open per supplier, reject, return, resubmit, withdraw,
 * no self-approval), the recent-change flag the payment workflow will test (P7 §8.4), deletion and the
 * payable party resolver.
 */

const ADMIN = '1';
/** supplier.* without approve; estate A only (suppliers are organisation-wide all the same). */
let CLERK = '';
/** supplier.view + approve: the finance manager of the bank detail ladder. */
let FINANCE = '';
/** supplier.* including approve, also in the finance role: may not approve what they proposed. */
let BOTH = '';
/** supplier.view only. */
let VIEWER = '';
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
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const get = (path: string, actor = CLERK) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body: object,
  version?: number,
  actor = CLERK,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: PromiseLike<request.Response>, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: Body }).data;
}
const many = async (r: request.Test) => {
  const res = await r;
  expect(res.status, json(res)).toBe(200);
  return (res.body as { data: Body[] }).data;
};
async function refused(r: PromiseLike<request.Response>, code: string, status = 422, field?: string) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).code).toBe(code);
  if (field) expect(errorOf(res).details.map((x) => x.field)).toContain(field);
}

async function role(permissions: string[]) {
  return ok(
    send('post', '/roles', { code: unique('R_'), name: 'Probe', permissions }, undefined, ADMIN),
    201,
  );
}
async function user(name: string, roleIds: string[], scope: object = { scope_type: 'all_estates' }) {
  const u = await mdb.migrator.user.create({
    data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const assign = async (authorisations?: object[]) => {
    const current = await ok(get(`/users/${id}`, ADMIN));
    return send(
      'post',
      `/users/${id}/roles`,
      { roles: roleIds.map((r) => ({ role_id: r })), ...(authorisations ? { authorisations } : {}) },
      current.version,
      ADMIN,
    );
  };
  let res = await assign();
  if (res.status === 422) {
    const details = (res.body as { error: { details: { context: { key: string } }[] } }).error.details;
    res = await assign(details.map((d) => ({ key: d.context.key, reason: 'Supplier test' })));
  }
  expect(res.status, json(res)).toBe(200);
  await ok(send('post', `/users/${id}/scopes`, scope, undefined, ADMIN), 201);
  return id;
}

const BANK = {
  bank_name: 'Sonali Bank PLC',
  bank_branch: 'Srimangal',
  bank_account_name: 'Meghna Fuel Supply',
  bank_account_number: '0101-3300-4471',
  bank_routing_number: '200591234',
};
const NEW_BANK = {
  bank_name: 'BRAC Bank PLC',
  bank_branch: 'Zindabazar',
  bank_account_name: 'Meghna Fuel Supply',
  bank_account_number: '1501203345566001',
  bank_routing_number: '060911489',
};
const supplier = (over: object = {}) =>
  ok(
    send('post', '/suppliers', {
      name: unique('Meghna Fuel '),
      business_type: 'distributor',
      phone: '+8801713000101',
      tin: '123456789012',
      payment_terms_days: 30,
      ...BANK,
      ...over,
    }),
    201,
  );
const propose = (supplierId: string, over: object = {}, actor = CLERK) =>
  ok(
    send(
      'post',
      `/suppliers/${supplierId}/bank-changes`,
      { ...NEW_BANK, reason: 'New account', ...over },
      undefined,
      actor,
    ),
    201,
  );
async function stepOf(approvalId: string, actor: string) {
  const q = await many(get('/approvals/pending', actor));
  return q.find((i) => i.approval_id === approvalId)?.step_number as number | undefined;
}
async function decide(
  approvalId: unknown,
  actor: string,
  action: 'approve' | 'reject' | 'return',
  extra = {},
) {
  const id = String(approvalId);
  const step = await stepOf(id, actor);
  return send('post', `/approvals/${id}/${action}`, { step_number: step ?? 1, ...extra }, undefined, actor);
}

let estate = '';

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
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

  const org = await mdb.migrator.organisation.findFirstOrThrow({ select: { id: true } });
  estate = (
    await runUnscoped('test', () =>
      mdb.migrator.estate.create({
        data: { organisationId: org.id, code: unique('A'), name: 'Estate A', createdBy: 1n },
      }),
    )
  ).id.toString();
  const clerk = await role(['view', 'create', 'edit', 'delete'].map((a) => `supplier.${a}`));
  const fm = await role(['supplier.view', 'supplier.approve']);
  CLERK = await user('sc', [clerk.id], { scope_type: 'estate', scope_id: estate });
  FINANCE = await user('sfm', [fm.id]);
  BOTH = await user('sboth', [clerk.id, fm.id]);
  VIEWER = await user('sv', [(await role(['supplier.view'])).id]);

  // P7 §9.6: the seeded organisation-wide workflow, made one step: the finance manager.
  const w = await runUnscoped('test', () =>
    mdb.migrator.workflow.findFirstOrThrow({ where: { documentType: 'supplier_bank_change' } }),
  );
  await runUnscoped('test', () =>
    mdb.migrator.workflowStep.updateMany({
      where: { workflowId: w.id },
      data: { approverRule: 'by_role', roleId: BigInt(fm.id), reportingLevel: null, name: 'Finance manager' },
    }),
  );
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

describe('suppliers (P4.01)', () => {
  it('creates a supplier: numbered, bank details as entered, not approved, not recently changed', async () => {
    const s = await supplier();
    expect(s.code).toMatch(/^SUP-/);
    expect(s).toMatchObject({
      business_type: 'distributor',
      ...BANK,
      bank_details_changed_at: null,
      bank_details_recently_changed: false,
      pending_bank_change_id: null,
      is_approved_supplier: false,
      status: 'active',
      payment_terms_days: 30,
    });
    await refused(send('post', '/suppliers', { name: 'X', business_type: 'importer' }), 'VALIDATION_FAILED');
    await refused(
      send('post', '/suppliers', { code: s.code, name: 'Twin', business_type: 'service' }),
      'DUPLICATE_KEY',
    );
    await refused(
      send('post', '/suppliers', { name: 'X', business_type: 'service' }, undefined, VIEWER),
      'PERMISSION_DENIED',
      403,
    );
  });

  it('is organisation-wide: an estate-scoped user sees and filters every supplier', async () => {
    const s = await supplier({ name: unique('Zebra Packaging '), business_type: 'manufacturer' });
    const byQ = await many(get(`/suppliers?filter[q]=${encodeURIComponent(String(s.name).slice(0, 12))}`));
    expect(byQ.map((x) => x.id)).toContain(s.id);
    const unapproved = await many(get('/suppliers?filter[is_approved_supplier]=false&per_page=200'));
    expect(unapproved.map((x) => x.id)).toContain(s.id);
    expect(
      (await many(get('/suppliers?filter[business_type]=manufacturer'))).every(
        (x) => x.business_type === 'manufacturer',
      ),
    ).toBe(true);
  });

  it('edits the details, accepts the bank details repeated, refuses a bank detail change outside approval', async () => {
    const s = await supplier();
    const whole = {
      code: s.code,
      name: 'Meghna Fuel Supply Ltd',
      business_type: s.business_type,
      contact_person: null,
      phone: s.phone,
      email: null,
      address_line1: 'Station Road, Srimangal',
      tin: s.tin,
      vat_registration: null,
      ...BANK,
      payment_terms_days: 45,
    };
    const put = await ok(send('put', `/suppliers/${s.id}`, whole, s.version));
    expect(put).toMatchObject({ name: 'Meghna Fuel Supply Ltd', ...BANK });
    await refused(
      send('patch', `/suppliers/${s.id}`, { bank_account_number: '999' }, put.version),
      'VALIDATION_FAILED',
      422,
      'bank_account_number',
    );
    await refused(send('patch', `/suppliers/${s.id}`, { name: 'Stale' }, s.version), 'VERSION_CONFLICT', 409);
    await refused(send('patch', `/suppliers/${s.id}`, { name: 'No If-Match' }), 'PRECONDITION_REQUIRED');
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'supplier', recordId: s.id, field: 'name' },
    });
    expect(audit.map((a) => a.newValue)).toContain('Meghna Fuel Supply Ltd');
  });

  it('approves a supplier with supplier.approve only, never an inactive one; idempotent', async () => {
    const s = await supplier();
    await refused(send('post', `/suppliers/${s.id}/approve`, {}, s.version), 'PERMISSION_DENIED', 403);
    const a = await ok(send('post', `/suppliers/${s.id}/approve`, {}, s.version, FINANCE));
    expect(a.is_approved_supplier).toBe(true);
    expect((await ok(send('post', `/suppliers/${s.id}/approve`, {}, a.version, FINANCE))).version).toBe(
      a.version,
    );
    const r = await ok(
      send(
        'post',
        `/suppliers/${s.id}/revoke-approval`,
        { reason: 'Quality complaints' },
        a.version,
        FINANCE,
      ),
    );
    expect(r.is_approved_supplier).toBe(false);
    const off = await ok(send('post', `/suppliers/${s.id}/deactivate`, {}, r.version));
    await refused(
      send('post', `/suppliers/${s.id}/approve`, {}, off.version, FINANCE),
      'INVALID_TRANSITION',
      409,
    );
  });

  it('VERIFY: a bank detail change routes to finance, and on approval replaces the details and raises the payment flag', async () => {
    const s = await supplier();
    const c = await propose(s.id);
    expect(c).toMatchObject({ state: 'submitted', proposed: NEW_BANK, previous: BANK });
    expect(c.approval_request_id).toEqual(expect.any(String));
    // Waiting: the supplier keeps its details, and names the pending change.
    expect(await ok(get(`/suppliers/${s.id}`))).toMatchObject({ ...BANK, pending_bank_change_id: c.id });
    // In the finance manager's queue, not the clerk's.
    expect(await stepOf(String(c.approval_request_id), FINANCE)).toBe(1);
    expect(await stepOf(String(c.approval_request_id), CLERK)).toBeUndefined();
    expect((await decide(c.approval_request_id, CLERK, 'approve')).status).toBe(403);

    await ok(decide(c.approval_request_id, FINANCE, 'approve'));
    const after = await ok(get(`/suppliers/${s.id}`));
    expect(after).toMatchObject({
      ...NEW_BANK,
      bank_details_recently_changed: true,
      pending_bank_change_id: null,
    });
    expect(after.bank_details_changed_at).toEqual(expect.any(String));
    const done = await ok(get(`/supplier-bank-changes/${c.id}`));
    expect(done).toMatchObject({
      state: 'approved',
      previous: BANK,
      proposed: NEW_BANK,
      approved_by: FINANCE,
    });
    expect(await runUnscoped('test', () => bankDetailsRecentlyChanged(mdb.db, BigInt(s.id)))).toBe(true);
    // The audit trail of the supplier shows the account replaced, with the change's reason.
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'supplier', recordId: s.id, field: 'bank_account_number' },
    });
    expect(audit.at(-1)).toMatchObject({
      oldValue: BANK.bank_account_number,
      newValue: NEW_BANK.bank_account_number,
      reason: 'New account',
    });
  });

  it('the recent window comes from the setting: a change older than the window no longer counts', async () => {
    const s = await supplier();
    const c = await propose(s.id);
    await ok(decide(c.approval_request_id, FINANCE, 'approve'));
    await mdb.migrator.supplier.update({
      where: { id: BigInt(s.id) },
      data: { bankDetailsChangedAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    expect(await runUnscoped('test', () => bankDetailsRecentlyChanged(mdb.db, BigInt(s.id)))).toBe(true);
    await mdb.migrator.systemSetting.create({
      data: {
        settingKey: BANK_CHANGE_RECENT_SETTING,
        settingGroup: 'procurement',
        settingValue: '30',
        valueType: 'integer',
        createdBy: 1n,
      },
    });
    try {
      expect(await runUnscoped('test', () => bankDetailsRecentlyChanged(mdb.db, BigInt(s.id)))).toBe(false);
      expect((await ok(get(`/suppliers/${s.id}`))).bank_details_recently_changed).toBe(false);
    } finally {
      await mdb.migrator.systemSetting.delete({ where: { settingKey: BANK_CHANGE_RECENT_SETTING } });
    }
  });

  it('allows one open change per supplier, and refuses a proposal that changes nothing', async () => {
    const s = await supplier();
    await refused(
      send('post', `/suppliers/${s.id}/bank-changes`, { ...BANK, reason: 'Same' }),
      'VALIDATION_FAILED',
    );
    await propose(s.id);
    await refused(
      send('post', `/suppliers/${s.id}/bank-changes`, {
        ...NEW_BANK,
        bank_account_number: '777',
        reason: 'Another',
      }),
      'INVALID_TRANSITION',
      409,
    );
    await refused(
      send('post', `/suppliers/${s.id}/bank-changes`, { ...NEW_BANK, reason: 'x' }, undefined, VIEWER),
      'PERMISSION_DENIED',
      403,
    );
  });

  it('a rejected change leaves the supplier as it was; a returned one is corrected and resubmitted; a draft is withdrawn', async () => {
    const s = await supplier();
    const rejected = await propose(s.id);
    await ok(decide(rejected.approval_request_id, FINANCE, 'reject', { reason: 'Letter not on letterhead' }));
    expect(await ok(get(`/supplier-bank-changes/${rejected.id}`))).toMatchObject({
      state: 'rejected',
      rejection_reason: 'Letter not on letterhead',
    });
    expect(await ok(get(`/suppliers/${s.id}`))).toMatchObject({ ...BANK, bank_details_changed_at: null });

    const back = await propose(s.id);
    await ok(decide(back.approval_request_id, FINANCE, 'return', { comment: 'Routing number is wrong' }));
    const draft = await ok(get(`/supplier-bank-changes/${back.id}`));
    expect(draft).toMatchObject({ state: 'draft', approval_request_id: null });
    const fixed = await ok(
      send('patch', `/supplier-bank-changes/${back.id}`, { bank_routing_number: '060911490' }, draft.version),
    );
    const again = await ok(send('post', `/supplier-bank-changes/${back.id}/submit`, {}, fixed.version));
    expect(again.state).toBe('submitted');
    await refused(send('delete', `/supplier-bank-changes/${back.id}`, {}), 'INVALID_TRANSITION', 409);
    await refused(
      send('patch', `/supplier-bank-changes/${back.id}`, { reason: 'x' }, again.version),
      'INVALID_TRANSITION',
      409,
    );
    await ok(decide(again.approval_request_id, FINANCE, 'approve'));
    expect((await ok(get(`/suppliers/${s.id}`))).bank_routing_number).toBe('060911490');

    const kept = await propose(s.id, { bank_account_number: '42', submit: false });
    expect(kept).toMatchObject({ state: 'draft', approval_request_id: null });
    await ok(send('delete', `/supplier-bank-changes/${kept.id}`, {}), 204);
    await refused(get(`/supplier-bank-changes/${kept.id}`), 'NOT_FOUND', 404);
    const history = await many(get(`/suppliers/${s.id}/bank-changes`));
    expect(history.map((h) => h.state)).toEqual(['approved', 'rejected']);
  });

  it('nobody approves the bank change they proposed (P7 §12.2)', async () => {
    const s = await supplier();
    const c = await propose(s.id, {}, BOTH);
    const res = await decide(c.approval_request_id, BOTH, 'approve');
    expect(res.status, json(res)).toBe(403);
    expect(errorOf(res).code).toBe('SELF_APPROVAL_FORBIDDEN');
    expect((await ok(get(`/supplier-bank-changes/${c.id}`))).state).toBe('submitted');
  });

  it('keeps contact_person, phone and email in step with the primary contact', async () => {
    const s = await supplier();
    const contact = await ok(
      send('post', `/suppliers/${s.id}/contacts`, {
        contact_name: 'Ms. Farhana Akter',
        contact_type: 'accounts',
        phone: '+8801713000202',
        email: 'accounts@sylhetpack.example',
      }),
      201,
    );
    expect(contact.is_primary).toBe(true);
    expect(await ok(get(`/suppliers/${s.id}`))).toMatchObject({
      contact_person: 'Ms. Farhana Akter',
      phone: '+8801713000202',
      email: 'accounts@sylhetpack.example',
    });
    expect((await many(get(`/suppliers/${s.id}/contacts`, VIEWER))).length).toBe(1);
  });

  it('deletes only a supplier created in error; a payable names its supplier through the resolver', async () => {
    const fresh = await supplier();
    await ok(
      send('post', `/suppliers/${fresh.id}/contacts`, { contact_name: 'Someone', contact_type: 'primary' }),
      201,
    );
    await ok(send('delete', `/suppliers/${fresh.id}`, {}), 204);
    expect(
      await mdb.migrator.partyContact.count({ where: { ownerType: 'supplier', ownerId: BigInt(fresh.id) } }),
    ).toBe(0);

    const used = await supplier();
    await propose(used.id, { submit: false });
    await refused(send('delete', `/suppliers/${used.id}`, {}), 'REFERENCED_RECORD');

    const labels = await runUnscoped('test', () =>
      partyLabels(mdb.db, [{ type: 'supplier', id: BigInt(used.id) }]),
    );
    expect(labels.get(`supplier:${used.id}`)).toMatchObject({
      code: used.code,
      name: used.name,
      estateId: null,
    });
  });
});
