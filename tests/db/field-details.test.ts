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
 * R.3 — the Division & Section and Field / Block pages of the manager's design on real MySQL: the field
 * details and their reference lists, parent fields and sections, the estate's sections in one request,
 * the figures under the lists; and RUP-625, the Estate Overview figures as entered.
 */

const ADMIN = '1';
let MANAGER = '';
/** Holds the same permissions, granted one section only. */
let NARROW = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

interface Body {
  id: string;
  version: number;
  [k: string]: unknown;
}
const one = (res: { body: unknown }) => (res.body as { data: Body }).data;
const many = (res: { body: unknown }) => (res.body as { data: Body[] }).data;
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string; message: string }[] } }).error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;
const get = (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put',
  path: string,
  body: object,
  version?: number,
  actor = MANAGER,
) => {
  const r = as(request(app)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return one(res);
}
async function refused(r: request.Test, field: string, status = 422) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).details.map((d) => d.field)).toContain(field);
}

const lookup: Record<string, Record<string, string>> = {};
let variety = '';

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
  const lists = {
    irrigationSource: await mdb.migrator.irrigationSource.findMany(),
    soilType: await mdb.migrator.soilType.findMany(),
    drainageClass: await mdb.migrator.drainageClass.findMany(),
  };
  for (const [t, rows] of Object.entries(lists)) {
    lookup[t] = Object.fromEntries(rows.map((r) => [r.code, r.id.toString()]));
  }
  variety = (
    await mdb.migrator.teaVariety.create({ data: { code: unique('TV'), name: 'TV-1', createdBy: 1n } })
  ).id.toString();
  const permissions = ['estate', 'division', 'section', 'field'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'Field probe', permissions }, undefined, ADMIN),
    201,
  );
  for (const name of ['mgr', 'narrow']) {
    const u = await mdb.migrator.user.create({
      data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
    });
    const id = u.id.toString();
    const current = await ok(get(`/users/${id}`, ADMIN));
    await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: role.id }] }, current.version, ADMIN));
    if (name === 'mgr') {
      MANAGER = id;
      await ok(send('post', `/users/${id}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
    } else NARROW = id;
  }
}, 180_000);

afterAll(async () => {
  await mdb.drop();
});

/** An estate with one division of two sections. */
async function estate(total: string | null = '100.000') {
  const e = await ok(send('post', '/estates', { code: unique('E'), name: 'Estate', total_area: total }), 201);
  const d = await ok(
    send('post', `/estates/${e.id}/divisions`, {
      code: 'DIV-01',
      name: 'Rangpur Division',
      area: '60.000',
      description: 'Hill slopes',
    }),
    201,
  );
  const s1 = await ok(
    send('post', `/divisions/${d.id}/sections`, { code: 'SEC-A', name: 'A', area: '30.000' }),
    201,
  );
  const s2 = await ok(
    send('post', `/divisions/${d.id}/sections`, { code: 'SEC-B', name: 'B', area: '20.500' }),
    201,
  );
  return { e, d, s1, s2 };
}

const FIELD = (section: string, over: object = {}) => ({
  section_id: section,
  field_number: unique('BLK-'),
  name: 'Block 01',
  gross_area: '25.500',
  planted_area: '23.750',
  field_status: 'producing',
  field_type: 'tea_field',
  planting_year: 2018,
  tea_variety_id: variety,
  spacing: '4ft × 2.5ft',
  altitude: '240.00',
  average_slope: '5.00',
  irrigation_source_id: lookup.irrigationSource?.NATURAL_RAIN,
  soil_type_id: lookup.soilType?.LOAMY,
  drainage_class_id: lookup.drainageClass?.GOOD,
  remarks: 'Main tea block',
  ...over,
});

describe('field / block details (R.3)', () => {
  it('saves and returns every detail of the design, with names for display', async () => {
    const { s1 } = await estate();
    const f = await ok(send('post', '/fields', FIELD(s1.id)), 201);
    expect(f).toMatchObject({
      field_type: 'tea_field',
      planting_year: 2018,
      tea_variety_id: variety,
      tea_variety: { name: 'TV-1' },
      spacing: '4ft × 2.5ft',
      altitude: '240.00',
      average_slope: '5.00',
      irrigation_source: { code: 'NATURAL_RAIN' },
      soil_type: { code: 'LOAMY' },
      drainage_class: { code: 'GOOD' },
      remarks: 'Main tea block',
      parent_field: null,
      created_by: { id: MANAGER },
    });
    // PUT without the R.3 fields (a client written before R.3) leaves them as they are.
    const put = await ok(
      send(
        'put',
        `/fields/${f.id}`,
        {
          field_number: f.field_number,
          name: 'Renamed',
          gross_area: '25.500',
          planted_area: '23.750',
          field_status: 'producing',
          remarks: null,
        },
        f.version,
      ),
    );
    expect(put).toMatchObject({ name: 'Renamed', altitude: '240.00', soil_type: { code: 'LOAMY' } });
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'field', recordId: f.id, action: 'create' },
    });
    expect(audit).toHaveLength(1);
  });

  it('defaults to a tea field, and filters by type', async () => {
    const { e, s1 } = await estate();
    const plain = await ok(
      send('post', '/fields', {
        section_id: s1.id,
        field_number: unique('F'),
        gross_area: '5.000',
        field_status: 'producing',
      }),
      201,
    );
    expect(plain.field_type).toBe('tea_field');
    await ok(send('post', '/fields', FIELD(s1.id, { field_type: 'nursery', field_status: 'nursery' })), 201);
    const nurseries = many(await get(`/fields?filter[estate_id]=${e.id}&filter[field_type]=nursery`));
    expect(nurseries).toHaveLength(1);
  });

  it('refuses what the form must not accept', async () => {
    const { s1 } = await estate();
    const post = (over: object) => send('post', '/fields', FIELD(s1.id, over));
    await refused(post({ field_type: 'garden' }), 'field_type');
    await refused(post({ planting_year: new Date().getUTCFullYear() + 1 }), 'planting_year');
    await refused(post({ average_slope: '91.00' }), 'average_slope');
    await refused(post({ altitude: '240.123' }), 'altitude');
    await refused(post({ soil_type_id: '999999' }), 'soil_type_id');
    await refused(post({ tea_variety_id: '999999' }), 'tea_variety_id');
    await refused(post({ parent_field_id: '999999' }), 'parent_field_id');
  });

  it('refuses an inactive list entry for a new choice, but keeps one the field already has', async () => {
    const { s1 } = await estate();
    const clay = lookup.soilType?.CLAY ?? '';
    const f = await ok(send('post', '/fields', FIELD(s1.id, { soil_type_id: clay })), 201);
    await mdb.migrator.soilType.update({ where: { id: BigInt(clay) }, data: { status: 'inactive' } });
    try {
      await refused(send('post', '/fields', FIELD(s1.id, { soil_type_id: clay })), 'soil_type_id');
      await ok(send('patch', `/fields/${f.id}`, { name: 'Still clay', soil_type_id: clay }, f.version));
    } finally {
      await mdb.migrator.soilType.update({ where: { id: BigInt(clay) }, data: { status: 'active' } });
    }
  });

  it('nests blocks inside a field of the same estate, never in a circle', async () => {
    const { e, s1, s2 } = await estate();
    const parent = await ok(send('post', '/fields', FIELD(s1.id)), 201);
    const block = await ok(send('post', '/fields', FIELD(s2.id, { parent_field_id: parent.id })), 201);
    expect(block.parent_field).toMatchObject({ id: parent.id, field_number: parent.field_number });
    expect(many(await get(`/fields?filter[parent_field_id]=${parent.id}`)).map((f) => f.id)).toEqual([
      block.id,
    ]);
    // Not inside itself, nor inside its own block.
    await refused(
      send('patch', `/fields/${parent.id}`, { parent_field_id: parent.id }, parent.version),
      'parent_field_id',
    );
    await refused(
      send('patch', `/fields/${parent.id}`, { parent_field_id: block.id }, parent.version),
      'parent_field_id',
    );
    // Not in another estate.
    const other = await estate();
    await refused(
      send('post', '/fields', FIELD(other.s1.id, { parent_field_id: parent.id })),
      'parent_field_id',
    );
    // A field with blocks cannot be deleted.
    const del = await as(request(app).delete(`/api/v1/fields/${parent.id}`), MANAGER).set(
      'If-Match',
      `"${String(parent.version)}"`,
    );
    expect(del.status, json(del)).toBe(422);
    expect(errorOf(del).code).toBe('REFERENCED_RECORD');
    expect(e.id).toBeTruthy();
  });

  it('turned the fields recorded as nurseries into nursery blocks', async () => {
    const sql = await import('node:fs').then((fs) =>
      fs.readFileSync('prisma/migrations/20261017072455_r3_field_details_overview/migration.sql', 'utf8'),
    );
    expect(sql).toContain("UPDATE `field` SET `field_type` = 'nursery' WHERE `field_status` = 'nursery'");
    const { s1 } = await estate();
    const f = await ok(send('post', '/fields', FIELD(s1.id)), 201);
    await expect(
      mdb.migrator.$executeRaw`UPDATE field SET field_type = 'garden' WHERE id = ${BigInt(f.id)}`,
    ).rejects.toThrow(/ck_field_type/);
  });
});

describe('divisions and sections (R.3)', () => {
  it('gives a division its description and its number of active sections', async () => {
    const { e, d, s2 } = await estate();
    expect(await ok(get(`/divisions/${d.id}`))).toMatchObject({
      description: 'Hill slopes',
      section_count: 2,
    });
    await ok(send('post', `/sections/${s2.id}/deactivate`, {}, s2.version));
    const [listed] = many(await get(`/estates/${e.id}/divisions`));
    expect(listed).toMatchObject({ section_count: 1 });
  });

  it('nests a section inside another of the same division, never in a circle', async () => {
    const { d, s1, s2 } = await estate();
    const child = await ok(
      send('post', `/divisions/${d.id}/sections`, {
        code: 'SEC-A1',
        name: 'A1',
        parent_section_id: s1.id,
        description: 'Lower slope',
      }),
      201,
    );
    expect(child).toMatchObject({ parent_section: { id: s1.id, code: 'SEC-A' }, description: 'Lower slope' });
    await refused(
      send('patch', `/sections/${s1.id}`, { parent_section_id: child.id }, s1.version),
      'parent_section_id',
    );
    await refused(
      send('patch', `/sections/${s2.id}`, { parent_section_id: s2.id }, s2.version),
      'parent_section_id',
    );
    const other = await estate();
    await refused(
      send('post', `/divisions/${other.d.id}/sections`, { code: 'X', name: 'X', parent_section_id: s1.id }),
      'parent_section_id',
    );
  });

  it('lists every section of an estate in one request, within the caller’s scope', async () => {
    const { e, s1 } = await estate();
    const d2 = await ok(send('post', `/estates/${e.id}/divisions`, { code: 'DIV-02', name: 'North' }), 201);
    await ok(send('post', `/divisions/${d2.id}/sections`, { code: 'SEC-C', name: 'C' }), 201);
    expect(many(await get(`/sections?filter[estate_id]=${e.id}&per_page=1000`)).map((s) => s.code)).toEqual([
      'SEC-A',
      'SEC-B',
      'SEC-C',
    ]);
    // A user granted one section sees that section only.
    await ok(
      send('post', `/users/${NARROW}/scopes`, { scope_type: 'section', scope_id: s1.id }, undefined, ADMIN),
      201,
    );
    expect(many(await get(`/sections?filter[estate_id]=${e.id}`, NARROW)).map((s) => s.id)).toEqual([s1.id]);
  });
});

describe('the figures under the lists (R.3)', () => {
  it('counts divisions, sections and fields by status and type, and sums their areas', async () => {
    const { e, s1, s2 } = await estate();
    await ok(send('post', '/fields', FIELD(s1.id, { gross_area: '25.500', planted_area: '23.750' })), 201);
    await ok(
      send(
        'post',
        '/fields',
        FIELD(s1.id, { field_type: 'nursery', gross_area: '2.500', planted_area: '2.500' }),
      ),
      201,
    );
    await ok(
      send('post', '/fields', FIELD(s2.id, { field_type: 'drain', gross_area: '1.800', planted_area: null })),
      201,
    );
    const ext = await ok(
      send(
        'post',
        '/fields',
        FIELD(s2.id, { field_type: 'extension', gross_area: '12.400', planted_area: '4.000' }),
      ),
      201,
    );
    await ok(send('post', `/fields/${ext.id}/deactivate`, {}, ext.version));
    const s = await ok(get(`/estates/${e.id}/summary`));
    expect(s.hierarchy).toEqual({
      divisions: { total: 1, active: 1, inactive: 0 },
      sections: { total: 2, active: 2, inactive: 0 },
      fields: { total: 4, active: 3, inactive: 1 },
      field_types: {
        tea_field: 1,
        nursery: 1,
        extension: 0,
        infrastructure: 0,
        drain: 1,
        road_reserve: 0,
        shade_area: 0,
        road_side: 0,
        water_body: 0,
      },
      division_area: '60.000',
      section_area: '50.500',
      average_section_area: '25.25',
      field_area: '29.800',
      planted_area: '26.250',
    });
    // Tea area: tea and extension fields only (the nursery's plants are not tea area).
    expect(s.tea_area).toBe('23.750');
  });
});

describe('the estate overview as entered (RUP-625)', () => {
  it('shows an entered figure instead of the computed one, says which, and keeps the computed one', async () => {
    const { e } = await estate('5250.000');
    const before = await ok(get(`/estates/${e.id}/summary`));
    expect(before).toMatchObject({
      division_count: 1,
      source: { division_count: 'computed', tea_area: 'computed' },
    });
    const est = await ok(get(`/estates/${e.id}`));
    const after = await ok(
      send(
        'patch',
        `/estates/${e.id}`,
        { tea_area: '4120.000', division_count: 5, worker_count: 1248, family_count: 420 },
        est.version,
      ),
    );
    expect(after).toMatchObject({ tea_area: '4120.000', division_count: 5, non_tea_area: null });
    const s = await ok(get(`/estates/${e.id}/summary`));
    expect(s).toMatchObject({
      tea_area: '4120.000',
      // Not entered: total − the (entered) tea area.
      non_tea_area: '1130.000',
      division_count: 5,
      section_count: 2,
      worker_count: 1248,
      family_count: 420,
      source: {
        tea_area: 'entered',
        non_tea_area: 'computed',
        division_count: 'entered',
        section_count: 'computed',
        worker_count: 'entered',
      },
      computed: { tea_area: '0.000', non_tea_area: '5250.000', division_count: 1, section_count: 2 },
    });
    // Clearing a figure goes back to the computed one.
    const cleared = await ok(send('patch', `/estates/${e.id}`, { division_count: null }, after.version));
    expect(cleared.division_count).toBeNull();
    expect(await ok(get(`/estates/${e.id}/summary`))).toMatchObject({
      division_count: 1,
      source: { division_count: 'computed' },
    });
    const audit = await mdb.db.auditChange.count({
      where: { recordType: 'estate', recordId: e.id, action: 'update', field: 'tea_area' },
    });
    expect(audit).toBe(1);
  });

  it('keeps entered areas inside the total land area', async () => {
    const { e } = await estate('100.000');
    const est = await ok(get(`/estates/${e.id}`));
    await refused(send('patch', `/estates/${e.id}`, { tea_area: '100.001' }, est.version), 'tea_area');
    await refused(
      send('patch', `/estates/${e.id}`, { tea_area: '60.000', non_tea_area: '41.000' }, est.version),
      'non_tea_area',
    );
    await refused(send('patch', `/estates/${e.id}`, { worker_count: -1 }, est.version), 'worker_count');
    const fine = await ok(
      send('patch', `/estates/${e.id}`, { tea_area: '60.000', non_tea_area: '40.000' }, est.version),
    );
    // Lowering the total below them is refused too.
    await refused(send('patch', `/estates/${e.id}`, { total_area: '90.000' }, fine.version), 'tea_area');
    await expect(
      mdb.migrator.$executeRaw`UPDATE estate SET family_count = -1 WHERE id = ${BigInt(e.id)}`,
    ).rejects.toThrow(/ck_estate_entered_figures/);
  });
});
