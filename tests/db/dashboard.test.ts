import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/**
 * R.5 — the home dashboard of the manager's design on real MySQL: the panels each caller may see, real
 * figures only, the estate parameter refused outside scope, and no figure leaking from another estate.
 */

const ADMIN = '1';
/** Estate permissions, dashboard.view, all estates. */
let MANAGER = '';
/** The same permissions, granted estate B only. */
let NARROW = '';
/** Signed in, no permissions at all. */
let NOBODY = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
interface Panel {
  key: string;
  available: boolean;
  available_from: string | null;
  as_of: string;
  estate_id: string | null;
  data: Record<string, unknown> | null;
}
interface MetricT {
  key: string;
  value: string | null;
  unit: string | null;
  available: boolean;
  available_from: string | null;
  drill_down: { resource: string; filter: Record<string, unknown> } | null;
}
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor);
const send = (method: 'post' | 'patch', path: string, body: object, version?: number, actor = MANAGER) => {
  const r = as(request(app)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok<T = Body>(r: request.Test, status = 200): Promise<T> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: T }).data;
}
const panel = (key: string, actor = MANAGER, query = '') =>
  ok<Panel>(get(`/dashboards/home/panels/${key}${query}`, actor));
const metrics = (p: Panel) => (p.data?.metrics ?? []) as MetricT[];
const byKey = (p: Panel) => Object.fromEntries(metrics(p).map((m) => [m.key, m]));

let estateA = '';
let estateB = '';

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
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
  const permissions = [
    'dashboard.view',
    ...['estate', 'division', 'section', 'field'].flatMap((m) =>
      ['view', 'create', 'edit'].map((a) => `${m}.${a}`),
    ),
  ];
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'Dashboard probe', permissions }, undefined, ADMIN),
    201,
  );
  const user = async (name: string, withRole: boolean) => {
    const u = await mdb.migrator.user.create({
      data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
    });
    const id = u.id.toString();
    if (withRole) {
      const current = await ok(get(`/users/${id}`, ADMIN));
      await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: role.id }] }, current.version, ADMIN));
    }
    return id;
  };
  MANAGER = await user('dmgr', true);
  NARROW = await user('dnarrow', true);
  NOBODY = await user('dnobody', false);
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);

  // Two estates: A with a position, 2 tea fields and a nursery; B with 1 tea field.
  const estate = async (total: string, position: boolean) =>
    (
      await ok(
        send(
          'post',
          '/estates',
          {
            code: unique('E'),
            name: 'Estate',
            total_area: total,
            ...(position ? { latitude: '24.310000', longitude: '91.730000' } : {}),
          },
          undefined,
          MANAGER,
        ),
        201,
      )
    ).id;
  estateA = await estate('100.000', true);
  estateB = await estate('50.500', false);
  await ok(
    send('post', `/users/${NARROW}/scopes`, { scope_type: 'estate', scope_id: estateB }, undefined, ADMIN),
    201,
  );
  const fields = async (estateId: string, types: string[]) => {
    const d = await ok(send('post', `/estates/${estateId}/divisions`, { code: 'D', name: 'D' }), 201);
    const s = await ok(send('post', `/divisions/${d.id}/sections`, { code: 'S', name: 'S' }), 201);
    for (const t of types) {
      await ok(
        send('post', '/fields', {
          section_id: s.id,
          field_number: unique('F'),
          gross_area: '10.000',
          field_status: t === 'nursery' ? 'nursery' : 'producing',
          field_type: t,
        }),
        201,
      );
    }
  };
  await fields(estateA, ['tea_field', 'tea_field', 'nursery']);
  await fields(estateB, ['tea_field']);
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

describe('the home dashboard (R.5)', () => {
  it('lists the design’s panels in order, each with its place in the grid', async () => {
    const d = await ok<{ panels: { key: string; row: number; span: number; available: boolean }[] }>(
      get('/dashboards/home'),
    );
    expect(d.panels.map((p) => p.key)).toEqual([
      'welcome',
      'weather',
      'stats',
      'plucking_trend',
      'field_plucking',
      'top_fields',
      'attendance',
      'recent_activities',
      'estate_map',
      'pending_approvals',
      'notifications',
    ]);
    expect(d.panels[0]).toMatchObject({ row: 1, span: 8, available: true });
    expect(d.panels.find((p) => p.key === 'weather')).toMatchObject({ available: false });
  });

  it('shows a user without permissions only what is theirs, and refuses the rest as unknown', async () => {
    const d = await ok<{ panels: { key: string }[] }>(get('/dashboards/home', NOBODY));
    expect(d.panels.map((p) => p.key)).toEqual(['recent_activities', 'pending_approvals', 'notifications']);
    const res = await get('/dashboards/home/panels/estate_map', NOBODY);
    expect(res.status, json(res)).toBe(404);
    expect((await get('/dashboards/home/panels/nonsense')).status).toBe(404);
  });

  it('counts estates, area and fields; workers only with employment.view', async () => {
    const p = await panel('welcome');
    expect(p.available).toBe(true);
    expect(Date.parse(p.as_of)).toBeGreaterThan(0);
    const m = byKey(p);
    expect(m.estates).toMatchObject({ value: '2', unit: 'count', drill_down: { resource: 'estates' } });
    expect(m.total_area).toMatchObject({ value: '150.500', unit: 'acre' });
    expect(m.fields).toMatchObject({ value: '4', drill_down: { resource: 'fields' } });
    // Live since P2.02, and only with employment.view, which this user does not hold.
    expect(m.workers).toBeUndefined();
    // Narrowed to one estate.
    const a = byKey(await panel('welcome', MANAGER, `?estate_id=${estateA}`));
    expect([a.estates?.value, a.total_area?.value, a.fields?.value]).toEqual(['1', '100.000', '3']);
  });

  it('never invents figures for what has no data yet', async () => {
    const stats = await panel('stats');
    expect(stats.available).toBe(false);
    expect(metrics(stats).map((m) => [m.key, m.value, m.available])).toEqual([
      ['today_plucking', null, false],
      ['plucking_mtd', null, false],
      ['plucking_ytd', null, false],
      ['workers_today', null, false],
      ['daily_wage_cost', null, false],
      ['monthly_expense', null, false],
    ]);
    for (const key of ['weather', 'plucking_trend', 'field_plucking', 'top_fields', 'attendance']) {
      const p = await panel(key);
      expect([p.key, p.available, p.data]).toEqual([key, false, null]);
      expect(p.available_from).toBeTruthy();
    }
  });

  it('maps the positioned estates and counts fields, nurseries and other places', async () => {
    const p = await panel('estate_map');
    const pins = p.data?.pins as { id: string; latitude: string }[];
    expect(pins.map((x) => x.id)).toEqual([estateA]);
    expect(pins[0]?.latitude).toBe('24.310000');
    const legend = Object.fromEntries(
      (p.data?.legend as { key: string; count: number | null; available: boolean }[]).map((l) => [l.key, l]),
    );
    expect(legend.field?.count).toBe(3);
    expect(legend.nursery?.count).toBe(1);
    expect(legend.office).toMatchObject({ count: null, available: false });
  });

  it('lists the caller’s own recent changes, grouped per record', async () => {
    const p = await panel('recent_activities');
    expect(p.data?.showing).toBe('own');
    const items = p.data?.items as { title: string; actor: { id: string }; drill_down: unknown }[];
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(8);
    expect(items.every((i) => i.actor.id === MANAGER)).toBe(true);
    expect(items[0]?.title).toMatch(/^Field F\S+ added$/);
    expect(items[0]?.drill_down).toMatchObject({ resource: 'fields' });
    // Someone who changed nothing sees nothing.
    expect((await panel('recent_activities', NOBODY)).data?.items).toEqual([]);
  });

  it('gives pending approvals and unread notifications', async () => {
    expect(byKey(await panel('pending_approvals', NOBODY)).pending?.value).toBe('0');
    expect(byKey(await panel('notifications', NOBODY)).unread?.value).toBe('0');
  });
});

describe('dashboard scope (P10 §18)', () => {
  it('refuses an estate outside the caller’s scope, and one that does not exist, the same way', async () => {
    for (const id of [estateA, '999999']) {
      const res = await get(`/dashboards/home/panels/welcome?estate_id=${id}`, NARROW);
      expect(res.status, json(res)).toBe(403);
      expect((res.body as { error: { code: string } }).error.code).toBe('SCOPE_DENIED');
    }
  });

  it('includes nothing of another estate in any figure', async () => {
    const w = byKey(await panel('welcome', NARROW));
    expect([w.estates?.value, w.total_area?.value, w.fields?.value]).toEqual(['1', '50.500', '1']);
    const map = await panel('estate_map', NARROW);
    expect(map.data?.pins).toEqual([]);
    const legend = map.data?.legend as { key: string; count: number | null }[];
    expect(legend.find((l) => l.key === 'nursery')?.count).toBe(0);
  });
});
