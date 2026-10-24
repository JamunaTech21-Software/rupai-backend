import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoSeeders } from '../../prisma/seed/demo-seeders.js';
import { buildSeeders } from '../../prisma/seed/seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { buildModules } from '../../src/modules/index.js';
import { LOOKUP_TYPES, type LookupType } from '../../src/modules/lookups/lookup-types.js';
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

/** P1.10 — the 25 reference masters, through the HTTP API on real MySQL. */

const ADMIN = '1';
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

const withVersion = (r: request.Test, version?: number) =>
  version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
const api = {
  get: (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = MANAGER, version?: number) =>
    withVersion(as(request(app).post(`/api/v1${path}`), actor), version).send(body),
  patch: (path: string, body: object, version: number, actor = MANAGER) =>
    withVersion(as(request(app).patch(`/api/v1${path}`), actor), version).send(body),
  del: (path: string, actor = MANAGER) => as(request(app).delete(`/api/v1${path}`), actor),
};

interface Node {
  id: string;
  version: number;
  [k: string]: unknown;
}
interface Failure {
  error: { code: string; details: { field?: string; message: string }[] };
}
const one = (res: { body: unknown }) => (res.body as { data: Node }).data;
const many = (res: { body: unknown }) => (res.body as { data: Node[] }).data;
const failure = (res: { body: unknown }) => (res.body as Failure).error;
const created = async (r: request.Test): Promise<Node> => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return one(res);
};
const byCode = async (path: string, code: string, field = 'code'): Promise<Node> => {
  const [row] = many(await api.get(`${path}?filter[${field}]=${code}`));
  if (!row) throw new Error(`${path} ${code} not found`);
  return row;
};

async function actorWith(permissions: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const role = await created(
    api.post('/roles', { code: unique('R_'), name: 'Lookup probe', permissions }, ADMIN),
  );
  const assign = async (authorisations?: object[]) => {
    const current = await api.get(`/users/${id}`, ADMIN);
    return api.post(
      `/users/${id}/roles`,
      { roles: [{ role_id: role.id }], ...(authorisations ? { authorisations } : {}) },
      ADMIN,
      one(current).version,
    );
  };
  // P3.01: cost centres are under accounting.*, and accounting.edit is sensitive (P6 §10).
  let set = await assign();
  if (set.status === 422) {
    const details = (set.body as { error: { details: { context: { key: string } }[] } }).error.details;
    set = await assign(details.map((d) => ({ key: d.context.key, reason: 'Lookup test manager' })));
  }
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  for (const g of grants) expect((await api.post(`/users/${id}/scopes`, g, ADMIN)).status).toBe(201);
  return id;
}
const CRUD = (m: string) => ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`);
const MODULES = [...new Set(LOOKUP_TYPES.map((t) => t.permission))];

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
  MANAGER = await actorWith(
    [...MODULES.flatMap(CRUD), ...CRUD('estate'), 'organisation.view', 'organisation.edit'],
    [{ scope_type: 'all_estates' }],
  );
});
afterAll(async () => {
  await mdb.drop();
});

describe('seed data (P3 Table 31.1)', () => {
  const codes = async (path: string, field = 'code') =>
    many(await api.get(`${path}?per_page=500`)).map((r) => r[field]);

  it('ships the reference lists, and leaves the client-specific ones empty', async () => {
    expect((await codes('/lookups/uom_category')).sort()).toEqual(['COUNT', 'LENGTH', 'VOLUME', 'WEIGHT']);
    expect((await codes('/uoms')).sort()).toEqual([
      'bag',
      'box',
      'carton',
      'g',
      'kg',
      'ltr',
      'm',
      'pc',
      'roll',
      'ton',
    ]);
    expect((await codes('/lookups/currency')).sort()).toEqual(['BDT', 'EUR', 'GBP', 'USD']);
    expect(await codes('/tea-types')).toEqual(['CTC', 'ORTHODOX', 'GREEN', 'OOLONG', 'WHITE']);
    expect(await codes('/tea-grades')).toEqual(
      expect.arrayContaining(['BOP', 'BOPF', 'BP', 'PF', 'PD', 'DUST', 'OF', 'OP', 'FOP']),
    );
    expect(await codes('/lookups/activity_type')).toHaveLength(12);
    expect(await codes('/lookups/land_type')).toHaveLength(7);
    expect(await codes('/lookups/adjustment_reason')).toContain('OPENING_BALANCE');
    expect((await api.get('/lookups/country?per_page=1')).body.meta.pagination.total).toBe(249);
    for (const empty of ['department', 'designation', 'worker_category']) {
      expect(await codes(`/lookups/${empty}`), empty).toEqual([]);
    }
    expect(await codes('/shifts')).toEqual([]);
  });

  it('units: each category has its base unit; kg and pc are system units', async () => {
    const kg = await byCode('/uoms', 'kg');
    const ton = await byCode('/uoms', 'ton');
    const weight = await byCode('/lookups/uom_category', 'WEIGHT');
    expect(kg).toMatchObject({
      is_base: true,
      is_system: true,
      conversion_factor: '1.0000',
      decimal_precision: 3,
    });
    expect(ton).toMatchObject({ is_base: false, conversion_factor: '1000.0000', uom_category_id: weight.id });
    expect(await byCode('/uoms', 'g')).toMatchObject({ conversion_factor: '0.0010' });
    expect(weight).toMatchObject({ base_uom_id: kg.id, is_system: true });
    expect(await byCode('/uoms', 'bag')).toMatchObject({ conversion_factor: null, is_base: false });
  });

  it('BDT is the base currency, and the organisation is seeded with it and Bangladesh', async () => {
    const bdt = await byCode('/lookups/currency', 'BDT');
    const bd = await byCode('/lookups/country', 'BD', 'iso2');
    expect(bdt).toMatchObject({ is_base: true, symbol: '৳', decimal_places: 2 });
    expect(bd).toMatchObject({ iso3: 'BGD', name: 'Bangladesh', dialling_code: '+880' });
    expect(one(await api.get('/organisation'))).toMatchObject({
      base_currency_id: bdt.id,
      country_id: bd.id,
    });
  });

  it('a re-seed adds nothing and never undoes a client change', async () => {
    const ctc = await byCode('/tea-types', 'CTC');
    expect((await api.patch(`/tea-types/${ctc.id}`, { name: 'Crush, tear, curl' }, ctc.version)).status).toBe(
      200,
    );
    const results = await runSeeders(
      mdb.migrator,
      buildSeeders({ BOOTSTRAP_ADMIN_PASSWORD: TEST_BOOTSTRAP_PASSWORD }),
      silentLogger(),
    );
    const lookups = Object.entries(results).find(([name]) => name.startsWith('lookups:'))?.[1];
    expect(lookups).toEqual({ inserted: 0, updated: 0 });
    expect(await byCode('/tea-types', 'CTC')).toMatchObject({ name: 'Crush, tear, curl' });
  });
});

describe('one engine, every type (P4 §7.3)', () => {
  /** The smallest valid body of a type. */
  async function minimal(t: LookupType): Promise<Record<string, unknown>> {
    switch (t.key) {
      case 'activity_type':
        return { code: unique('A'), name: 'Activity', cost_category: 'other' };
      case 'benefit_type':
        return { code: unique('B'), name: 'Benefit', benefit_category: 'other' };
      case 'evaluation_criteria':
        return { code: unique('C'), name: 'Criterion', criteria_group: 'other' };
      case 'cost_centre':
        return { code: unique('CC'), name: 'Cost centre', centre_type: 'project' };
      case 'budget_head':
        return { code: unique('BH'), name: 'Budget head', head_type: 'expense' };
      case 'shift':
        return { code: unique('S'), name: 'Shift', start_time: '06:00', end_time: '14:00' };
      case 'uom':
        return {
          code: unique('u'),
          name: 'Unit',
          uom_category_id: (await byCode('/lookups/uom_category', 'COUNT')).id,
        };
      case 'currency':
        return { code: 'XTS', name: 'Test currency' };
      case 'country':
        return { iso2: 'ZZ', iso3: 'ZZZ', name: 'Testland' };
      default:
        return { code: unique('C'), name: `A ${t.label}` };
    }
  }

  it.each(LOOKUP_TYPES.map((t) => [t.key, t] as const))(
    '%s: create, read, list, edit, deactivate, reactivate, delete',
    async (_key, t) => {
      const body = await minimal(t);
      const row = await created(api.post(t.path, body));
      expect(row).toMatchObject({ ...body, status: 'active', version: 1 });
      if (t.hasSystem) expect(row.is_system).toBe(false);

      expect(one(await api.get(`${t.path}/${row.id}`))).toEqual(row);
      const key = String(row[t.keyField]);
      expect(many(await api.get(`${t.path}?filter[${t.keyField}]=${key}`)).map((r) => r.id)).toEqual([
        row.id,
      ]);
      expect(failure(await api.post(t.path, body))).toMatchObject({
        code: 'DUPLICATE_KEY',
        details: [{ field: t.keyField }],
      });

      expect((await api.patch(`${t.path}/${row.id}`, { name: 'Renamed' }, 9)).status).toBe(409);
      const edited = one(await api.patch(`${t.path}/${row.id}`, { name: 'Renamed' }, 1));
      expect(edited).toMatchObject({ name: 'Renamed', version: 2 });
      expect(one(await api.post(`${t.path}/${row.id}/deactivate`, {}, MANAGER, 2))).toMatchObject({
        status: 'inactive',
      });
      expect(one(await api.post(`${t.path}/${row.id}/reactivate`, {}, MANAGER, 3))).toMatchObject({
        status: 'active',
      });

      const audit = await mdb.db.auditChange.findMany({
        where: { recordType: t.key, recordId: row.id },
        orderBy: { id: 'asc' },
      });
      expect(audit.map((a) => a.action)).toEqual(['create', 'update', 'update', 'update']);
      expect((await api.del(`${t.path}/${row.id}`)).status).toBe(204);
      expect((await api.get(`${t.path}/${row.id}`)).status).toBe(404);
    },
  );
});

describe('system rows and references (P3 §5.1)', () => {
  it('an is_system row is renamed, but never deleted, deactivated or re-coded: 422 SYSTEM_RECORD', async () => {
    const kg = await byCode('/uoms', 'kg');
    const del = await api.del(`/uoms/${kg.id}`);
    expect(del.status).toBe(422);
    expect(failure(del).code).toBe('SYSTEM_RECORD');
    const off = await api.post(`/uoms/${kg.id}/deactivate`, {}, MANAGER, kg.version);
    expect(off.status).toBe(422);
    expect(failure(off).code).toBe('SYSTEM_RECORD');
    const recode = await api.patch(`/uoms/${kg.id}`, { code: 'kilo' }, kg.version);
    expect(failure(recode)).toMatchObject({ code: 'SYSTEM_RECORD', details: [{ field: 'code' }] });
    expect((await api.patch(`/uoms/${kg.id}`, { name: 'Kilo' }, kg.version)).status).toBe(200);

    const opening = await byCode('/lookups/adjustment_reason', 'OPENING_BALANCE');
    expect(failure(await api.del(`/lookups/adjustment_reason/${opening.id}`)).code).toBe('SYSTEM_RECORD');
    // is_system is the seed's to set, never the API's.
    expect(
      (await api.post('/lookups/department', { code: unique('D'), name: 'x', is_system: true })).status,
    ).toBe(422);
  });

  it('tea grades filter by tea type; a grade must name a real type; a type in use is not deleted', async () => {
    const ctc = await byCode('/tea-types', 'CTC');
    const orthodox = await byCode('/tea-types', 'ORTHODOX');
    const codes = async (q: string) =>
      many(await api.get(`/tea-grades?per_page=100&${q}`)).map((g) => g.code);
    expect((await codes(`filter[tea_type_id]=${ctc.id}`)).sort()).toEqual(['BP', 'DUST', 'OF', 'PD', 'PF']);
    expect(await codes(`filter[tea_type_id]=${orthodox.id}&filter[grade_category]=broken`)).toEqual(['FBOP']);
    // What may be chosen for a CTC lot: its own grades and the ones valid for every type.
    expect((await codes(`filter[valid_for_tea_type_id]=${ctc.id}`)).sort()).toEqual([
      'BOP',
      'BOPF',
      'BP',
      'DUST',
      'OF',
      'PD',
      'PF',
    ]);
    expect((await codes('filter[tea_type_id][null]=true')).sort()).toEqual(['BOP', 'BOPF']);

    const bad = await api.post('/tea-grades', { code: unique('G'), name: 'x', tea_type_id: '999999' });
    expect(failure(bad).details[0]).toMatchObject({ field: 'tea_type_id', message: 'No such tea type.' });
    const inUse = await api.del(`/tea-types/${ctc.id}`);
    expect(inUse.status).toBe(422);
    expect(failure(inUse)).toMatchObject({
      code: 'REFERENCED_RECORD',
      details: [{ message: 'Deactivate it instead.' }],
    });
  });
});

describe('units and currency (P3 §5.3–§5.4)', () => {
  it('a category gets its base unit from its own units; the base converts to itself and cannot be retired', async () => {
    const category = await created(api.post('/lookups/uom_category', { code: unique('AREA'), name: 'Area' }));
    expect(
      (await api.post('/lookups/uom_category', { code: unique('X'), name: 'x', base_uom_id: '1' })).status,
    ).toBe(422); // no units yet
    const ha = await created(
      api.post('/uoms', {
        uom_category_id: category.id,
        code: unique('ha'),
        name: 'Hectare',
        conversion_factor: '2.4711',
      }),
    );
    const acre = await created(
      api.post('/uoms', { uom_category_id: category.id, code: unique('ac'), name: 'Acre' }),
    );
    const kg = await byCode('/uoms', 'kg');

    const foreign = await api.patch(`/lookups/uom_category/${category.id}`, { base_uom_id: kg.id }, 1);
    expect(failure(foreign).details[0]).toMatchObject({
      field: 'base_uom_id',
      message: 'must be a unit of this category',
    });

    expect(
      (await api.patch(`/lookups/uom_category/${category.id}`, { base_uom_id: acre.id }, 1)).status,
    ).toBe(200);
    expect(one(await api.get(`/uoms/${acre.id}`))).toMatchObject({
      is_base: true,
      conversion_factor: '1.0000',
    });
    // The base keeps factor 1 whatever is sent, stays in its category, and is not deactivated or deleted.
    const base = one(await api.get(`/uoms/${acre.id}`));
    expect(
      one(await api.patch(`/uoms/${acre.id}`, { conversion_factor: '5.0000' }, base.version)),
    ).toMatchObject({ conversion_factor: '1.0000' });
    expect(failure(await api.del(`/uoms/${acre.id}`)).code).toBe('INVARIANT_VIOLATED');
    // Another unit already has a factor against this base: switching the base would make it wrong.
    const switched = await api.patch(`/lookups/uom_category/${category.id}`, { base_uom_id: ha.id }, 2);
    expect(failure(switched).code).toBe('INVARIANT_VIOLATED');
    // Once the factor is cleared the base may change; the old base no longer claims factor 1.
    const haNow = one(await api.get(`/uoms/${ha.id}`));
    expect((await api.patch(`/uoms/${ha.id}`, { conversion_factor: null }, haNow.version)).status).toBe(200);
    expect((await api.patch(`/lookups/uom_category/${category.id}`, { base_uom_id: ha.id }, 2)).status).toBe(
      200,
    );
    expect(one(await api.get(`/uoms/${ha.id}`))).toMatchObject({
      is_base: true,
      conversion_factor: '1.0000',
    });
    expect(one(await api.get(`/uoms/${acre.id}`))).toMatchObject({ is_base: false, conversion_factor: null });
    await expect(
      mdb.migrator.$executeRawUnsafe(
        `UPDATE uom SET is_base = 1, conversion_factor = 1 WHERE id = ${acre.id}`,
      ),
    ).rejects.toThrow(/ux_uom_base/);
  });

  it('currency codes are upper-case ISO; there is one base currency and it stays', async () => {
    const c = await created(
      api.post('/lookups/currency', { code: 'xaf', name: 'CFA franc', decimal_places: 0 }),
    );
    expect(c).toMatchObject({ code: 'XAF', is_base: false, decimal_places: 0 });
    expect((await api.post('/lookups/currency', { code: 'EURO', name: 'x' })).status).toBe(422);
    const bdt = await byCode('/lookups/currency', 'BDT');
    expect(
      failure(await api.post(`/lookups/currency/${bdt.id}/deactivate`, {}, MANAGER, bdt.version)).code,
    ).toBe('INVARIANT_VIOLATED');
    expect(failure(await api.del(`/lookups/currency/${bdt.id}`)).code).toBe('INVARIANT_VIOLATED');
    await expect(
      mdb.migrator.$executeRawUnsafe(`UPDATE currency SET is_base = 1 WHERE id = ${c.id}`),
    ).rejects.toThrow(/ux_currency_base/);
  });

  it('the organisation country can be changed to a real country; the base currency is not editable', async () => {
    const org = one(await api.get('/organisation'));
    const india = await byCode('/lookups/country', 'IN', 'iso2');
    expect(one(await api.patch('/organisation', { country_id: india.id }, org.version))).toMatchObject({
      country_id: india.id,
    });
    expect((await api.patch('/organisation', { country_id: '999999' }, org.version + 1)).status).toBe(422);
    expect((await api.patch('/organisation', { base_currency_id: '2' }, org.version + 1)).status).toBe(422);
    // The organisation's country is referenced, so it cannot be deleted.
    expect(failure(await api.del(`/lookups/country/${india.id}`)).code).toBe('REFERENCED_RECORD');
  });
});

describe('shifts (P3 §5.2.4): times and estate scope', () => {
  it('a night shift is overnight by its times, never by a flag the caller sends', async () => {
    const day = await created(
      api.post('/shifts', {
        code: unique('D'),
        name: 'Day',
        start_time: '06:00',
        end_time: '14:00',
        break_minutes: 30,
      }),
    );
    expect(day).toMatchObject({
      is_overnight: false,
      start_time: '06:00',
      end_time: '14:00',
      estate_id: null,
      grace_minutes: 0,
    });
    const night = await created(
      api.post('/shifts', {
        code: unique('N'),
        name: 'Night',
        start_time: '22:00',
        end_time: '06:00',
        half_day_hours: '4.5',
      }),
    );
    expect(night).toMatchObject({ is_overnight: true, half_day_hours: '4.5000' });
    expect(one(await api.patch(`/shifts/${night.id}`, { end_time: '23:30' }, 1))).toMatchObject({
      is_overnight: false,
    });
    expect(
      (await api.post('/shifts', { code: unique('X'), name: 'x', start_time: '6am', end_time: '14:00' }))
        .status,
    ).toBe(422);
    expect(
      (
        await api.post('/shifts', {
          code: unique('X'),
          name: 'x',
          start_time: '06:00',
          end_time: '14:00',
          is_overnight: true,
        })
      ).status,
    ).toBe(422);
    expect(
      failure(
        await api.post('/shifts', {
          code: unique('X'),
          name: 'x',
          start_time: '06:00',
          end_time: '14:00',
          estate_id: '999999',
        }),
      ).details[0],
    ).toMatchObject({
      field: 'estate_id',
      message: 'No such estate.',
    });
  });

  it('an estate user sees organisation-wide shifts and their estate’s, and manages only their estate’s', async () => {
    const mine = await created(api.post('/estates', { code: unique('E'), name: 'Mine' }));
    const theirs = await created(api.post('/estates', { code: unique('E'), name: 'Theirs' }));
    const shift = (over: object) =>
      created(
        api.post('/shifts', {
          code: unique('S'),
          name: 'Shift',
          start_time: '06:00',
          end_time: '14:00',
          ...over,
        }),
      );
    const wide = await shift({});
    const own = await shift({ estate_id: mine.id });
    const hidden = await shift({ estate_id: theirs.id });
    const user = await actorWith(
      [...CRUD('shift'), 'lookup.view'],
      [{ scope_type: 'estate', scope_id: mine.id }],
    );

    const seen = many(await api.get('/shifts?per_page=500', user)).map((s) => s.id);
    expect(seen).toEqual(expect.arrayContaining([wide.id, own.id]));
    expect(seen).not.toContain(hidden.id);
    expect((await api.get(`/shifts/${hidden.id}`, user)).status).toBe(404);
    expect((await api.patch(`/shifts/${own.id}`, { name: 'Ours' }, 1, user)).status).toBe(200);
    expect((await api.patch(`/shifts/${wide.id}`, { name: 'No' }, 1, user)).status).toBe(403); // organisation-wide: all estates only
    expect(
      (
        await api.post(
          '/shifts',
          { code: unique('S'), name: 'x', start_time: '06:00', end_time: '14:00' },
          user,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api.post(
          '/shifts',
          { code: unique('S'), name: 'x', start_time: '06:00', end_time: '14:00', estate_id: theirs.id },
          user,
        )
      ).status,
    ).toBe(403);
    await expect(
      created(
        api.post(
          '/shifts',
          { code: unique('S'), name: 'x', start_time: '06:00', end_time: '14:00', estate_id: mine.id },
          user,
        ),
      ),
    ).resolves.toMatchObject({ estate_id: mine.id });

    // The bulk fetch follows the same scope.
    const bulk = (await api.get('/lookups?types=shift', user)).body as { data: { shift: Node[] } };
    expect(bulk.data.shift.map((s) => s.id)).not.toContain(hidden.id);
    expect(bulk.data.shift.map((s) => s.id)).toContain(wide.id);
  });
});

describe('GET /lookups: every active row in one response (P4 §7.3)', () => {
  it('returns all 25 types, active rows only, in display order', async () => {
    const off = await created(
      api.post('/lookups/department', { code: unique('OFF'), name: 'Closed department' }),
    );
    await api.post(`/lookups/department/${off.id}/deactivate`, {}, MANAGER, 1);
    const res = await api.get('/lookups');
    expect(res.status).toBe(200);
    const data = (res.body as { data: Record<string, Node[]> }).data;
    expect(Object.keys(data).sort()).toEqual(LOOKUP_TYPES.map((t) => t.key).sort());
    expect(data.country).toHaveLength(249);
    expect(data.tea_type?.map((t) => t.code)).toEqual(['CTC', 'ORTHODOX', 'GREEN', 'OOLONG', 'WHITE']);
    expect(data.department?.map((d) => d.id)).not.toContain(off.id);
    expect(
      Object.values(data)
        .flat()
        .every((r) => r.status === 'active'),
    ).toBe(true);
  });

  it('narrows by ?types=, refuses an unknown type, and needs lookup.view', async () => {
    const res = await api.get('/lookups?types=uom,tea_grade');
    expect(Object.keys((res.body as { data: object }).data).sort()).toEqual(['tea_grade', 'uom']);
    expect((await api.get('/lookups?types=uom,nonsense')).status).toBe(422);
    const user = await actorWith(['uom.view'], []);
    expect((await api.get('/lookups', user)).status).toBe(403);
    expect((await api.get('/uoms', user)).status).toBe(200);
    expect((await api.get('/tea-types', user)).status).toBe(403);
  });
});

describe('demo data for the manager check (P1.10)', () => {
  it('is idempotent; the viewer sees the DEMO-A shift, not DEMO-B’s', async () => {
    const seeders = demoSeeders('Demo-password-123');
    await runSeeders(mdb.migrator, seeders, silentLogger());
    const results = await runSeeders(mdb.migrator, seeders, silentLogger());
    expect(Object.entries(results).find(([n]) => n.startsWith('demo: departments'))?.[1]).toEqual({
      inserted: 0,
      updated: 0,
    });
    const viewer = (
      await mdb.db.user.findUniqueOrThrow({ where: { username: 'viewer' }, select: { id: true } })
    ).id.toString();
    const shifts = many(
      await api.get('/shifts?per_page=500&filter[code][in]=DAY,A-NIGHT,B-LATE', viewer),
    ).map((s) => s.code);
    expect(shifts.sort()).toEqual(['A-NIGHT', 'DAY']);
    expect(
      many(await api.get('/lookups/department?filter[code][in]=FIELD,FACTORY,ACCOUNTS', viewer)).map(
        (d) => d.code,
      ),
    ).toEqual(['FIELD', 'FACTORY', 'ACCOUNTS']);
    expect((await api.post('/lookups/department', { code: 'NEW', name: 'x' }, viewer)).status).toBe(403);
  });
});
