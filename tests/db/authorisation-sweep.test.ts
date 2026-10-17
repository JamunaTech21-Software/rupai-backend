import type { Server } from 'node:http';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoSeeders } from '../../prisma/seed/demo-seeders.js';
import type { ApiModule } from '../../src/app.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import type { DeclaredRoute } from '../../src/core/http/route.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * P1.19 — the Phase 1 authorisation sweep (Spec P13 §12.6, BACKLOG P1.19): every route of the API, every
 * demo role, every scope type, on real MySQL with the demo data.
 *
 *   A. Route inventory: every route says who may call it; nobody gets in unauthenticated; a user without
 *      permissions is refused everywhere, writes nothing, and never sees another user's own records.
 *   B. A negative test per role: each demo role is refused every route whose permission it lacks.
 *   C. Scope leakage per scope type (estate, division, section, factory, warehouse): lists, records,
 *      sub-resources, summaries and dashboard figures show nothing outside the grant; a record outside it
 *      is 404, not 403 (§12.6 step 3); the audit trail is refused to an estate-scoped reader.
 *
 * §12.6 step 4 (no self-approval) is tested in approvals.test.ts and workflows.test.ts; step 5 (own payslip,
 * own leave) waits for Phases 9 and 2. See BACKLOG D-1.19-*.
 */

const ADMIN = '1';
const PASSWORD = 'Demo-password-sweep-1';
let mdb: MigratedDatabase;
let app: Express;
/**
 * One server for the whole sweep: supertest would otherwise listen on a new ephemeral port per request, and
 * across a thousand requests another local process occasionally answers one of them.
 */
let server: Server;
let routes: DeclaredRoute[] = [];
let NOBODY = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 100000)}${String((seq += 1))}`;
const json = (res: { status: number; body: unknown }) =>
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 300)}`;

/** Fills a route's parameters with plausible values, so the request reaches the authorisation check. */
function pathOf(r: DeclaredRoute, ids: Partial<Record<string, string>> = {}): string {
  const fill: Record<string, string> = {
    id: ids.id ?? '1',
    authorisationId: '1',
    grantId: '1',
    contactId: '1',
    name: 'jobs.purge',
    dashboard: 'home',
    panel: 'welcome',
    type: 'lookup.amenity',
  };
  return r.fullPath.replace(/:(\w+)/g, (_m, p: string) => fill[p] ?? '1');
}
function call(r: DeclaredRoute, actor: string | null, path = pathOf(r)) {
  const req = request(server)[r.method](path);
  const authed = actor === null ? req : as(req, actor);
  return r.method === 'get' || r.method === 'delete' ? authed : authed.send({});
}
const label = (r: DeclaredRoute) => `${r.method.toUpperCase()} ${r.fullPath}`;

async function grantRole(userId: string, roleId: string, sensitive: readonly string[] = []) {
  const u = await as(request(server).get(`/api/v1/users/${userId}`), ADMIN);
  const res = await as(request(server).post(`/api/v1/users/${userId}/roles`), ADMIN)
    .set('If-Match', `"${String((u.body as { data: { version: number } }).data.version)}"`)
    .send({
      roles: [{ role_id: roleId }],
      // A sensitive permission needs a named authorisation (P6 Table 10.1, P1.04).
      ...(sensitive.length > 0
        ? {
            authorisations: sensitive.map((p) => ({
              key: `SENSITIVE:${p}`,
              reason: 'Authorisation sweep (P1.19)',
            })),
          }
        : {}),
    });
  expect(res.status, json(res)).toBe(200);
}
async function grantScope(userId: string, scope: { scope_type: string; scope_id?: string }) {
  const res = await as(request(server).post(`/api/v1/users/${userId}/scopes`), ADMIN).send(scope);
  expect(res.status, json(res)).toBe(201);
}
async function newUser(name: string): Promise<string> {
  return (
    await mdb.migrator.user.create({ data: { username: unique(name), passwordHash: 'x', createdBy: 1n } })
  ).id.toString();
}

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  await runSeeders(mdb.migrator, demoSeeders(PASSWORD), silentLogger());
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
  });
  const modules: ApiModule[] = buildModules(deps);
  routes = modules.flatMap((m) => [...(m.routes ?? [])]);
  app = createApp({
    config,
    logger: silentLogger(),
    db: mdb.db,
    platform: memoryPlatform(),
    modules,
    authenticate: testActor(),
  });
  server = app.listen(0, '127.0.0.1');
  NOBODY = await newUser('nobody');
}, 240_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

// ---- A. the route inventory ------------------------------------------------------------------------------

describe('A. every route (P1.19)', () => {
  it('covers the whole API, and every permission named exists in the catalogue', async () => {
    expect(routes.length).toBeGreaterThan(400);
    const catalogue = new Set(
      (await mdb.migrator.permission.findMany({ select: { module: true, action: true } })).map(
        (p) => `${p.module}.${p.action}`,
      ),
    );
    const unknown = routes.flatMap((r) =>
      'permission' in r.auth && !catalogue.has(r.auth.permission)
        ? [`${label(r)} → ${r.auth.permission}`]
        : [],
    );
    expect(unknown).toEqual([]);
  });

  it('opens only the sign-in flow and signed download links to the public', () => {
    const open = routes
      .filter((r) => 'public' in r.auth)
      .map(label)
      .sort();
    expect(open).toEqual([
      'GET /api/v1/documents/:id/content',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/refresh',
    ]);
  });

  it('refuses every other route without a signed-in user (401)', async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => !('public' in x.auth))) {
      const res = await call(r, null);
      if (res.status !== 401) wrong.push(`${label(r)} → ${json(res)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('refuses a user without permissions on every permission route (403), and nothing is written', async () => {
    const audited = await mdb.migrator.auditChange.count();
    const wrong: string[] = [];
    for (const r of routes.filter((x) => 'permission' in x.auth)) {
      const res = await call(r, NOBODY);
      const code = (res.body as { error?: { code?: string } }).error?.code;
      if (res.status !== 403 || code !== 'PERMISSION_DENIED') wrong.push(`${label(r)} → ${json(res)}`);
    }
    expect(wrong).toEqual([]);
    expect(await mdb.migrator.auditChange.count()).toBe(audited);
    expect(await mdb.migrator.auditChange.count({ where: { changedBy: BigInt(NOBODY) } })).toBe(0);
  });

  it('never errors on a signed-in route for a user without permissions', async () => {
    const wrong: string[] = [];
    for (const r of routes.filter((x) => 'signedIn' in x.auth)) {
      const res = await call(r, NOBODY);
      if (res.status >= 500) wrong.push(`${label(r)} → ${json(res)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('shows nobody another user’s own records: jobs, notifications, imports, documents', async () => {
    const job = await mdb.migrator.job.create({
      data: { type: 'system.self_test', payload: { steps: 1 }, maxAttempts: 1, requestedBy: 1n },
    });
    const rule = await mdb.migrator.notificationRule.findFirstOrThrow();
    const note = await mdb.migrator.notification.create({
      data: {
        notificationRuleId: rule.id,
        userId: 1n,
        subject: 'For the administrator only',
        body: 'x',
        linkType: 'estate',
        linkId: 1n,
        severity: 'info',
        generationDate: new Date('2026-10-17'),
        deliveryState: 'not_required',
      },
    });
    const batch = await mdb.migrator.importBatch.create({
      data: {
        importType: 'lookup.amenity',
        fileName: 'a.csv',
        fileFormat: 'csv',
        fileSha256: '0'.repeat(64),
        fileSize: 1,
        state: 'validated',
        createdBy: 1n,
      },
    });
    const owned: Record<string, string> = {
      '/api/v1/jobs/': job.id.toString(),
      '/api/v1/notifications/': note.id.toString(),
      '/api/v1/imports/': batch.id.toString(),
    };
    const wrong: string[] = [];
    for (const r of routes.filter((x) => 'signedIn' in x.auth && x.fullPath.includes(':id'))) {
      const prefix = Object.keys(owned).find((p) => r.fullPath.startsWith(p));
      if (!prefix) continue;
      const res = await call(r, NOBODY, pathOf(r, { id: owned[prefix] }));
      if (res.status < 400) wrong.push(`${label(r)} → ${json(res)}`);
    }
    expect(wrong).toEqual([]);
    const listed = async (path: string) => JSON.stringify((await as(request(server).get(path), NOBODY)).body);
    expect(await listed('/api/v1/jobs')).not.toContain(`"id":"${job.id.toString()}"`);
    expect(await listed('/api/v1/notifications')).not.toContain('For the administrator only');
    expect(await listed('/api/v1/imports')).not.toContain(`"id":"${batch.id.toString()}"`);
    // A document is read through its owner: outside the owner's permission it is not there.
    const doc = await mdb.migrator.documentFile.findFirst({ select: { id: true } });
    if (doc) {
      const res = await as(request(server).get(`/api/v1/documents/${doc.id.toString()}`), NOBODY);
      expect([403, 404]).toContain(res.status);
    }
  });
});

// ---- B. a negative test per role ---------------------------------------------------------------------

describe('B. each demo role is refused what it does not hold', () => {
  for (const username of ['viewer', 'approver', 'manager']) {
    it(`${username}: 403 on every permission route outside its role, and in on the ones it holds`, async () => {
      const u = await mdb.migrator.user.findUniqueOrThrow({ where: { username } });
      const held = await dbPermissionResolver(mdb.db).permissionsOf(u.id);
      expect(held.size).toBeGreaterThan(0);
      const wrong: string[] = [];
      for (const r of routes.filter((x) => 'permission' in x.auth)) {
        const permission = (r.auth as { permission: string }).permission;
        if (held.has(permission)) {
          // Only reads, so the sweep changes nothing: the permission check lets it through.
          if (r.method !== 'get') continue;
          const res = await call(r, u.id.toString());
          const code = (res.body as { error?: { code?: string } }).error?.code;
          if (code === 'PERMISSION_DENIED' || res.status >= 500)
            wrong.push(`held ${label(r)} → ${json(res)}`);
        } else {
          const res = await call(r, u.id.toString());
          if (res.status !== 403) wrong.push(`${label(r)} → ${json(res)}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }
});

// ---- C. scope leakage per scope type -------------------------------------------------------------------

interface Fixture {
  estates: { id: bigint; code: string; totalArea: string | null; latitude: unknown }[];
  divisions: { id: bigint; estateId: bigint }[];
  sections: { id: bigint; divisionId: bigint; estateId: bigint }[];
  fields: { id: bigint; estateId: bigint; sectionId: bigint; divisionId: bigint; status: string }[];
  seasons: { id: bigint; estateId: bigint }[];
  factories: { id: bigint; code: string }[];
  warehouses: { id: bigint; code: string }[];
}
let fx: Fixture;
const users: Record<string, string> = {};
interface Visible {
  estates: Set<bigint>;
  divisions: Set<bigint>;
  sections: Set<bigint>;
  fields: Set<bigint>;
  seasons: Set<bigint>;
  factories: Set<bigint>;
  warehouses: Set<bigint>;
}
const visible: Record<string, Visible> = {};

const ids = <T extends { id: bigint }>(rows: T[], keep: (r: T) => boolean) =>
  new Set(rows.filter(keep).map((r) => r.id));

describe('C. scope leakage per scope type (P13 §12.6 steps 2 and 3)', () => {
  beforeAll(async () => {
    fx = await runUnscoped('sweep fixture', async () => {
      const sections = await mdb.db.section.findMany({
        include: { division: { select: { estateId: true } } },
      });
      const fields = await mdb.db.field.findMany({ include: { section: { select: { divisionId: true } } } });
      return {
        estates: (await mdb.db.estate.findMany()).map((e) => ({
          id: e.id,
          code: e.code,
          totalArea: e.totalArea?.toString() ?? null,
          latitude: e.latitude,
        })),
        divisions: await mdb.db.division.findMany({ select: { id: true, estateId: true } }),
        sections: sections.map((s) => ({
          id: s.id,
          divisionId: s.divisionId,
          estateId: s.division.estateId,
        })),
        fields: fields.map((f) => ({
          id: f.id,
          estateId: f.estateId,
          sectionId: f.sectionId,
          divisionId: f.section.divisionId,
          status: f.status,
        })),
        seasons: await mdb.db.season.findMany({ select: { id: true, estateId: true } }),
        factories: await mdb.db.factory.findMany({ select: { id: true, code: true } }),
        warehouses: await mdb.db.warehouse.findMany({ select: { id: true, code: true } }),
      };
    });
    const a = fx.estates.find((e) => e.code === 'DEMO-A');
    const division = fx.divisions.find((d) => d.estateId === a?.id);
    const section = fx.sections.find((s) => s.divisionId === division?.id);
    const f1 = fx.factories.find((f) => f.code === 'DEMO-F1');
    const w1 = fx.warehouses.find((w) => w.code === 'DEMO-W1');
    if (!a || !division || !section || !f1 || !w1) throw new Error('the demo data is missing');
    expect(fx.estates.length).toBeGreaterThanOrEqual(2);

    // One user per scope type, with the demo viewer's role (every Phase 1 view permission).
    const viewerRole = await mdb.migrator.role.findUniqueOrThrow({ where: { code: 'DEMO_VIEWER' } });
    const grants: Record<string, { scope_type: string; scope_id: string }> = {
      estate: { scope_type: 'estate', scope_id: a.id.toString() },
      division: { scope_type: 'division', scope_id: division.id.toString() },
      section: { scope_type: 'section', scope_id: section.id.toString() },
      factory: { scope_type: 'factory', scope_id: f1.id.toString() },
      warehouse: { scope_type: 'warehouse', scope_id: w1.id.toString() },
    };
    for (const [kind, grant] of Object.entries(grants)) {
      const id = await newUser(`scope${kind}`);
      await grantRole(id, viewerRole.id.toString());
      await grantScope(id, grant);
      users[kind] = id;
    }
    const none = new Set<bigint>();
    visible.estate = {
      estates: new Set([a.id]),
      divisions: ids(fx.divisions, (d) => d.estateId === a.id),
      sections: ids(fx.sections, (s) => s.estateId === a.id),
      fields: ids(fx.fields, (f) => f.estateId === a.id),
      seasons: ids(fx.seasons, (s) => s.estateId === a.id),
      factories: none,
      warehouses: none,
    };
    // A division or section grant also reads its estate (and division), to name where one works.
    visible.division = {
      estates: new Set([a.id]),
      divisions: new Set([division.id]),
      sections: ids(fx.sections, (s) => s.divisionId === division.id),
      fields: ids(fx.fields, (f) => f.divisionId === division.id),
      seasons: ids(fx.seasons, (s) => s.estateId === a.id),
      factories: none,
      warehouses: none,
    };
    visible.section = {
      estates: new Set([a.id]),
      divisions: new Set([division.id]),
      sections: new Set([section.id]),
      fields: ids(fx.fields, (f) => f.sectionId === section.id),
      seasons: ids(fx.seasons, (s) => s.estateId === a.id),
      factories: none,
      warehouses: none,
    };
    visible.factory = {
      estates: none,
      divisions: none,
      sections: none,
      fields: none,
      seasons: none,
      factories: new Set([f1.id]),
      warehouses: none,
    };
    visible.warehouse = {
      estates: none,
      divisions: none,
      sections: none,
      fields: none,
      seasons: none,
      factories: none,
      warehouses: new Set([w1.id]),
    };
  }, 120_000);

  const RESOURCES: readonly (readonly [keyof Visible, string, string])[] = [
    ['estates', '/api/v1/estates?per_page=200', '/api/v1/estates/'],
    ['sections', '/api/v1/sections?per_page=1000', '/api/v1/sections/'],
    ['fields', '/api/v1/fields?per_page=1000', '/api/v1/fields/'],
    ['seasons', '/api/v1/seasons?per_page=200', '/api/v1/seasons/'],
    ['factories', '/api/v1/factories?per_page=200', '/api/v1/factories/'],
    ['warehouses', '/api/v1/warehouses?per_page=200', '/api/v1/warehouses/'],
    ['divisions', '', '/api/v1/divisions/'],
  ];

  for (const kind of ['estate', 'division', 'section', 'factory', 'warehouse']) {
    describe(`a ${kind}-scoped user`, () => {
      const get = (path: string) => as(request(server).get(path), users[kind] ?? '');

      it('lists exactly what the grant reaches, and finds nothing else by id (404, not 403)', async () => {
        const v = visible[kind];
        if (!v) throw new Error('no fixture');
        const wrong: string[] = [];
        for (const [res, list, item] of RESOURCES) {
          const all = fx[res] as { id: bigint }[];
          if (list) {
            const r = await get(list);
            expect(r.status, `${list} ${json(r)}`).toBe(200);
            const got = new Set((r.body as { data: { id: string }[] }).data.map((x) => BigInt(x.id)));
            const want = v[res];
            for (const id of got) if (!want.has(id)) wrong.push(`${list} shows ${res} ${String(id)}`);
            for (const id of want) if (!got.has(id)) wrong.push(`${list} misses ${res} ${String(id)}`);
          }
          for (const row of all) {
            const r = await get(`${item}${row.id.toString()}`);
            const inScope = v[res].has(row.id);
            if (inScope && r.status !== 200)
              wrong.push(`${item}${String(row.id)} → ${String(r.status)}, expected 200`);
            if (
              !inScope &&
              (r.status !== 404 || (r.body as { error?: { code?: string } }).error?.code !== 'NOT_FOUND')
            ) {
              wrong.push(`${item}${String(row.id)} → ${json(r)}, expected 404`);
            }
          }
        }
        expect(wrong).toEqual([]);
      });

      it('cannot reach an outside estate’s sub-resources or overview', async () => {
        const v = visible[kind];
        const wrong: string[] = [];
        for (const e of fx.estates.filter((x) => !v?.estates.has(x.id))) {
          for (const sub of ['', '/summary', '/divisions', '/documents', '/contacts']) {
            const r = await get(`/api/v1/estates/${e.id.toString()}${sub}`);
            if (r.status !== 404) wrong.push(`/estates/${String(e.id)}${sub} → ${json(r)}`);
          }
        }
        for (const d of fx.divisions.filter((x) => !v?.divisions.has(x.id))) {
          const r = await get(`/api/v1/divisions/${d.id.toString()}/sections`);
          if (r.status !== 404) wrong.push(`/divisions/${String(d.id)}/sections → ${json(r)}`);
        }
        expect(wrong).toEqual([]);
      });

      it('counts only what the grant reaches, in every total', async () => {
        const v = visible[kind];
        if (!v) throw new Error('no fixture');
        // Estate overviews: the hierarchy figures are the visible records of that estate.
        for (const id of v.estates) {
          const r = await get(`/api/v1/estates/${id.toString()}/summary`);
          expect(r.status, json(r)).toBe(200);
          const h = (
            r.body as {
              data: {
                hierarchy: {
                  divisions: { total: number };
                  sections: { total: number };
                  fields: { total: number };
                };
              };
            }
          ).data.hierarchy;
          expect([h.divisions.total, h.sections.total, h.fields.total]).toEqual([
            fx.divisions.filter((d) => d.estateId === id && v.divisions.has(d.id)).length,
            fx.sections.filter((s) => s.estateId === id && v.sections.has(s.id)).length,
            fx.fields.filter((f) => f.estateId === id && v.fields.has(f.id)).length,
          ]);
        }
        // The dashboard's welcome banner and map.
        const w = await get('/api/v1/dashboards/home/panels/welcome');
        expect(w.status, json(w)).toBe(200);
        const metrics = Object.fromEntries(
          (
            w.body as { data: { data: { metrics: { key: string; value: string | null }[] } } }
          ).data.data.metrics.map((m) => [m.key, m.value]),
        );
        expect(metrics.estates).toBe(String(v.estates.size));
        expect(metrics.fields).toBe(
          String(fx.fields.filter((f) => v.fields.has(f.id) && f.status === 'active').length),
        );
        const area = fx.estates
          .filter((e) => v.estates.has(e.id))
          .reduce((n, e) => n + Number(e.totalArea ?? 0), 0);
        expect(Number(metrics.total_area)).toBeCloseTo(area, 3);
        const map = await get('/api/v1/dashboards/home/panels/estate_map');
        const pins = (map.body as { data: { data: { pins: { id: string }[] } } }).data.data.pins.map((p) =>
          BigInt(p.id),
        );
        for (const p of pins) expect(v.estates.has(p)).toBe(true);
        // Asking a panel for an outside estate is refused, not quietly widened (P10 §18).
        for (const e of fx.estates.filter((x) => !v.estates.has(x.id))) {
          const r = await get(`/api/v1/dashboards/home/panels/welcome?estate_id=${e.id.toString()}`);
          expect(r.status, json(r)).toBe(403);
        }
      });
    });
  }

  it('refuses the audit trail to an estate-scoped reader, and gives it to one with all estates', async () => {
    const auditRole = (
      await as(request(server).post('/api/v1/roles'), ADMIN).send({
        code: unique('AUD_'),
        name: 'Audit reader',
        permissions: ['audit.view'],
      })
    ).body as { data: { id: string } };
    const scoped = await newUser('auditscoped');
    await grantRole(scoped, auditRole.data.id, ['audit.view']);
    await grantScope(scoped, { scope_type: 'estate', scope_id: (fx.estates[0]?.id ?? 0n).toString() });
    const range = 'filter[changed_at][from]=2026-01-01T00:00:00Z&filter[changed_at][to]=2027-01-01T00:00:00Z';
    for (const path of [`/api/v1/audit/changes?${range}`, `/api/v1/audit/status-history?${range}`]) {
      const r = await as(request(server).get(path), scoped);
      expect(r.status, json(r)).toBe(403);
      expect((r.body as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    }
    const denials = await mdb.migrator.accessLog.count({
      where: { userId: BigInt(scoped), eventType: 'scope_denied', module: 'audit' },
    });
    expect(denials).toBe(2);
    const all = await newUser('auditall');
    await grantRole(all, auditRole.data.id, ['audit.view']);
    await grantScope(all, { scope_type: 'all_estates' });
    expect((await as(request(server).get(`/api/v1/audit/changes?${range}`), all)).status).toBe(200);
  });
});
