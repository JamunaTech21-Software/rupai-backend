import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { SOD_RULES } from '../../src/modules/identity/sod-rules.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.04 — separation of duties (P6 §5.3, §9) and sensitive permissions (P6 §10), against the real
 * migrations and seed.
 */

const ADMIN = '1';
const REASON = 'Small estate: only two office staff available';
let mdb: MigratedDatabase;
let app: Express;

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const authz = dbPermissionResolver(mdb.db);
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules: buildModules(testModuleDeps({ config, db: mdb.db, authz })),
    authenticate: testActor(),
  });
});
afterAll(async () => {
  await mdb.drop();
});

// ---- helpers -------------------------------------------------------------------------------------

let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
const get = (path: string, actor = ADMIN) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object, version?: number, actor = ADMIN) => {
  const r = as(request(app).post(`/api/v1${path}`), actor).send(body);
  return version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
};
const patch = (path: string, body: object, version: number) =>
  as(request(app).patch(`/api/v1${path}`), ADMIN)
    .send(body)
    .set('If-Match', `"${String(version)}"`);

async function role(permissions: string[]): Promise<{ id: string; version: number }> {
  const res = await post('/roles', { code: unique('R_'), name: 'Test role', permissions });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; version: number };
}

async function user(): Promise<{ id: string }> {
  const res = await post('/users', { username: unique('u'), initial_password: 'Temporary-Password-1' });
  expect(res.status).toBe(201);
  return res.body.data as { id: string };
}

async function assign(userId: string, roleIds: string[], authorisations?: object[]) {
  const current = await get(`/users/${userId}`);
  return post(
    `/users/${userId}/roles`,
    { roles: roleIds.map((role_id) => ({ role_id })), ...(authorisations ? { authorisations } : {}) },
    current.body.data.version as number,
  );
}

interface Detail {
  code: string;
  context: { key: string; rule: string; user_id: string };
}
const detailsOf = (res: request.Response) => res.body.error.details as Detail[];

// ---- the check -----------------------------------------------------------------------------------

describe('conflict detection at assignment (P6 §9.1)', () => {
  it('P6 Fig 9.1: Payroll Clerk + Finance Manager needs an override with a reason', async () => {
    const clerk = await role(['payroll.view', 'payroll.create', 'payroll.edit', 'payroll.submit']);
    const finance = await role(['payroll.view', 'payroll.approve']);
    const u = await user();

    // Each role alone is fine: the conflict comes from the union.
    expect((await assign(u.id, [clerk.id])).status).toBe(200);

    const refused = await assign(u.id, [clerk.id, finance.id]);
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('AUTHORISATION_REQUIRED');
    expect(detailsOf(refused)).toEqual([
      expect.objectContaining({
        code: 'SOD_CONFLICT',
        context: expect.objectContaining({ key: 'SOD-1:payroll.approve+payroll.create', rule: 'SOD-1' }),
      }),
    ]);
    // Nothing changed.
    expect((await get(`/users/${u.id}`)).body.data.roles).toHaveLength(1);

    const ok = await assign(
      u.id,
      [clerk.id, finance.id],
      [{ key: 'SOD-1:payroll.approve+payroll.create', reason: REASON }],
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const recorded = (await get(`/users/${u.id}/authorisations`)).body.data as {
      kind: string;
      rule: string;
      permissions: string[];
      reason: string;
      authorised_by: string;
      active: boolean;
    }[];
    expect(recorded).toEqual([
      expect.objectContaining({
        kind: 'sod_override',
        rule: 'SOD-1',
        permissions: ['payroll.approve', 'payroll.create'],
        reason: REASON,
        authorised_by: ADMIN,
        active: true,
      }),
    ]);

    // Already authorised: the same union needs nothing more.
    expect((await assign(u.id, [finance.id, clerk.id])).status).toBe(200);
  });

  it.each(SOD_RULES.map((r) => [r.code, r.combinations[0] ?? []] as const))(
    'every prohibited combination triggers the conflict (P6 §12.2): %s',
    async (code, combination) => {
      const r = await role([...combination]);
      const res = await assign((await user()).id, [r.id]);
      expect(res.body.error.code).toBe('AUTHORISATION_REQUIRED');
      expect(detailsOf(res).some((d) => d.context.rule === code)).toBe(true);
    },
  );

  it('a sensitive permission needs a named authorisation too (P6 §10)', async () => {
    const r = await role(['payroll.view', 'payroll.export']);
    const u = await user();
    const refused = await assign(u.id, [r.id]);
    expect(detailsOf(refused)).toEqual([
      expect.objectContaining({
        code: 'SENSITIVE_PERMISSION',
        context: expect.objectContaining({ key: 'SENSITIVE:payroll.export' }),
      }),
    ]);
    expect((await assign(u.id, [r.id], [{ key: 'SENSITIVE:payroll.export', reason: REASON }])).status).toBe(
      200,
    );
  });

  it('refuses a vague reason, and an authorisation the change does not need', async () => {
    const r = await role(['payroll.export']);
    const u = await user();
    const vague = await assign(u.id, [r.id], [{ key: 'SENSITIVE:payroll.export', reason: 'ok' }]);
    expect(vague.status).toBe(422);
    expect(vague.body.error.details[0].field).toBe('authorisations.0.reason');
    const stray = await assign(
      u.id,
      [r.id],
      [
        { key: 'SENSITIVE:payroll.export', reason: REASON },
        { key: 'SOD-6:payment.approve+supplier.edit', reason: REASON },
      ],
    );
    expect(stray.status).toBe(422);
    expect(stray.body.error.details[0].field).toBe('authorisations.1.key');
  });

  it('previews the check without changing anything', async () => {
    const r = await role(['sale.create', 'sale.approve', 'sale.post']);
    const u = await user();
    const res = await post(`/users/${u.id}/roles/check`, { roles: [{ role_id: r.id }] });
    expect(res.status).toBe(200);
    expect(res.body.data.missing).toBe(2);
    expect((res.body.data.requirements as { key: string }[]).map((x) => x.key).sort()).toEqual([
      'SOD-1:sale.approve+sale.create',
      'SOD-2:sale.approve+sale.post',
    ]);
    expect((await get(`/users/${u.id}`)).body.data.roles).toEqual([]);
  });
});

describe('re-checking holders when a role changes (P6 §9.1)', () => {
  it('broadening a role surfaces the conflict in users who already hold it', async () => {
    const r = await role(['journal.view', 'journal.create']);
    const a = await user();
    const b = await user();
    await assign(a.id, [r.id]);
    await assign(b.id, [r.id]);

    const broaden = await patch(
      `/roles/${r.id}`,
      { permissions: ['journal.view', 'journal.create', 'journal.approve'] },
      r.version,
    );
    expect(broaden.body.error.code).toBe('AUTHORISATION_REQUIRED');
    expect(
      detailsOf(broaden)
        .map((d) => d.context.user_id)
        .sort(),
    ).toEqual([a.id, b.id].sort());
    expect((await get(`/roles/${r.id}`)).body.data.permissions).toEqual(['journal.create', 'journal.view']);

    const key = 'SOD-1:journal.approve+journal.create';
    const ok = await patch(
      `/roles/${r.id}`,
      {
        permissions: ['journal.view', 'journal.create', 'journal.approve'],
        authorisations: [a.id, b.id].map((user_id) => ({ user_id, key, reason: REASON })),
      },
      r.version,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('reactivating a role re-checks its holders', async () => {
    const r = await role(['supplier.edit', 'payment.approve']);
    const u = await user();
    const keys = ['SOD-6:payment.approve+supplier.edit', 'SENSITIVE:payment.approve'];
    expect(
      (
        await assign(
          u.id,
          [r.id],
          keys.map((key) => ({ key, reason: REASON })),
        )
      ).status,
    ).toBe(200);
    const off = await post(`/roles/${r.id}/deactivate`, {}, r.version);
    // Remove the override while the role is inactive: reactivation must ask again.
    const auths = (await get(`/users/${u.id}/authorisations`)).body.data as { id: string; key: string }[];
    const sod = auths.find((x) => x.key === keys[0]);
    expect(
      (await as(request(app).delete(`/api/v1/users/${u.id}/authorisations/${sod?.id ?? ''}`), ADMIN)).status,
    ).toBe(204);

    const refused = await post(`/roles/${r.id}/reactivate`, {}, off.body.data.version as number);
    expect(refused.body.error.code).toBe('AUTHORISATION_REQUIRED');
    expect(detailsOf(refused).map((d) => d.context.key)).toEqual([keys[0]]);
    const ok = await post(
      `/roles/${r.id}/reactivate`,
      { authorisations: [{ user_id: u.id, key: keys[0], reason: REASON }] },
      off.body.data.version as number,
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});

describe('removing an authorisation', () => {
  it('is recorded, never deleted; the user then shows as unauthorised on the review', async () => {
    const r = await role(['receivable.write_off', 'collection.create']);
    const u = await user();
    const keys = ['SOD-7:collection.create+receivable.write_off', 'SENSITIVE:receivable.write_off'];
    await assign(
      u.id,
      [r.id],
      keys.map((key) => ({ key, reason: REASON })),
    );
    const list = (await get(`/users/${u.id}/authorisations`)).body.data as { id: string; key: string }[];
    const target = list.find((x) => x.key === keys[0])?.id ?? '';
    const del = () => as(request(app).delete(`/api/v1/users/${u.id}/authorisations/${target}`), ADMIN);
    expect((await del()).status).toBe(204);
    expect((await del()).status).toBe(404);

    const after = (await get(`/users/${u.id}/authorisations`)).body.data as {
      key: string;
      active: boolean;
      removed_by: string;
    }[];
    expect(after.find((x) => x.key === keys[0])).toMatchObject({ active: false, removed_by: ADMIN });
    const report = (await get('/access/concentration-report')).body.data;
    const mine = (report.unauthorised as { id: string; requirements: { key: string }[] }[]).find(
      (x) => x.id === u.id,
    );
    expect(mine?.requirements.map((x) => x.key)).toEqual([keys[0]]);
  });
});

// ---- the concentration report --------------------------------------------------------------------

describe('concentration report (P6 §9.2)', () => {
  it('lists overrides, sensitive holders, many-role users and approve+post holders', async () => {
    const roles = await Promise.all([
      role(['journal.view']),
      role(['estate.view']),
      role(['lookup.view']),
      role(['journal.approve', 'journal.post']),
    ]);
    const u = await user();
    const keys = ['SOD-2:journal.approve+journal.post', 'SENSITIVE:journal.post'];
    expect(
      (
        await assign(
          u.id,
          roles.map((r) => r.id),
          keys.map((key) => ({ key, reason: REASON })),
        )
      ).status,
    ).toBe(200);

    const res = await get('/access/concentration-report');
    expect(res.status).toBe(200);
    const report = res.body.data as {
      active_overrides: { user: { id: string }; key: string; still_held: boolean }[];
      sensitive_holders: { permission: string; holders: { id: string; authorised: boolean }[] }[];
      users_with_many_roles: { id: string; roles: string[] }[];
      approve_and_post: { id: string; modules: string[] }[];
    };
    expect(report.active_overrides).toContainEqual(
      expect.objectContaining({
        user: expect.objectContaining({ id: u.id }),
        key: keys[0],
        still_held: true,
      }),
    );
    const journalPost = report.sensitive_holders.find((s) => s.permission === 'journal.post');
    expect(journalPost?.holders).toContainEqual(expect.objectContaining({ id: u.id, authorised: true }));
    expect(report.users_with_many_roles.find((x) => x.id === u.id)?.roles).toHaveLength(4);
    expect(report.approve_and_post.find((x) => x.id === u.id)?.modules).toEqual(['journal']);
    // The seeded administrator's sensitive permissions are authorised.
    const userEdit = report.sensitive_holders.find((s) => s.permission === 'user.edit');
    expect(userEdit?.holders).toContainEqual(expect.objectContaining({ id: ADMIN, authorised: true }));
  });

  it('needs user.view', async () => {
    const r = await role(['role.view']);
    const u = await user();
    await assign(u.id, [r.id]);
    expect((await get('/access/concentration-report', u.id)).status).toBe(403);
    expect((await get('/access/sod-rules', u.id)).status).toBe(200);
  });
});

describe('database rules', () => {
  it('one active authorisation per user and key; a real reason; never deleted by the app', async () => {
    const insert = (reason: string) =>
      mdb.migrator.$executeRaw`INSERT INTO access_authorisation
        (user_id, kind, rule_code, authorisation_key, permissions, reason, authorised_by)
        VALUES (1, 'sensitive_grant', 'SENSITIVE', 'SENSITIVE:user.edit', 'user.edit', ${reason}, 1)`;
    await expect(insert('Another reason that is long enough')).rejects.toThrow(
      /ux_access_authorisation_active|Duplicate/i,
    );
    await expect(insert('short')).rejects.toThrow(/ck_access_authorisation_reason/);
    await expect(mdb.db.$executeRaw`DELETE FROM access_authorisation`).rejects.toThrow(/denied/i);
  });

  it('the bootstrap administrator’s sensitive permissions are seeded as authorised', async () => {
    const rows = await mdb.db.accessAuthorisation.findMany({
      where: { userId: 1n },
      orderBy: { authorisationKey: 'asc' },
    });
    expect(rows.map((r) => r.authorisationKey)).toEqual([
      'SENSITIVE:audit.view',
      'SENSITIVE:device.revoke',
      'SENSITIVE:role.edit',
      'SENSITIVE:user.edit',
    ]);
  });
});
