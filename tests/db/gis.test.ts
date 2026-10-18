import type { Server } from 'node:http';

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
 * R.3 GIS (RUP-655) on real MySQL: field and section boundaries (GeoJSON, KML, GPS walk), the server's
 * figures and the area warning, and the estate map the Field / Block page draws — scope-filtered.
 */

const ADMIN = '1';
let MANAGER = '';
/** field / section / estate view and edit, estate A only. */
let NARROW = '';
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
  `${String(res.status)} ${JSON.stringify(res.body).slice(0, 500)}`;
const errorOf = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { field?: string }[] } }).error;
const get = (path: string, actor = MANAGER) => as(request(server).get(`/api/v1${path}`), actor);
const send = (
  method: 'post' | 'patch' | 'put',
  path: string,
  body: object,
  version?: number,
  actor = MANAGER,
) => {
  const r = as(request(server)[method](`/api/v1${path}`), actor);
  return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
};
async function ok(r: request.Test, status = 200): Promise<Body> {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  return (res.body as { data: Body }).data;
}
async function refused(r: request.Test, field: string, status = 422) {
  const res = await r;
  expect(res.status, json(res)).toBe(status);
  expect(errorOf(res).details.map((d) => d.field)).toContain(field);
}

// A 0.001° square at Sreemangal: about 2.79 acres.
const SQUARE = [
  [91.73, 24.31],
  [91.731, 24.31],
  [91.731, 24.311],
  [91.73, 24.311],
  [91.73, 24.31],
];
const polygon = (ring = SQUARE) => ({ type: 'Polygon', coordinates: [ring] });

let estateA = '';
let estateB = '';
let sectionA = '';
let sectionB = '';

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
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
  const perms = ['estate', 'division', 'section', 'field'].flatMap((m) =>
    ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
  );
  const role = await ok(
    send('post', '/roles', { code: unique('R_'), name: 'GIS probe', permissions: perms }, undefined, ADMIN),
    201,
  );
  const user = async (name: string) => {
    const u = await mdb.migrator.user.create({
      data: { username: unique(name), passwordHash: 'x', createdBy: 1n },
    });
    const id = u.id.toString();
    const cur = await ok(get(`/users/${id}`, ADMIN));
    await ok(send('post', `/users/${id}/roles`, { roles: [{ role_id: role.id }] }, cur.version, ADMIN));
    return id;
  };
  MANAGER = await user('gis');
  NARROW = await user('gisa');
  await ok(send('post', `/users/${MANAGER}/scopes`, { scope_type: 'all_estates' }, undefined, ADMIN), 201);
  const tree = async (p: string) => {
    const e = await ok(
      send('post', '/estates', {
        code: unique(p),
        name: `Estate ${p}`,
        latitude: '24.310000',
        longitude: '91.730000',
      }),
      201,
    );
    const d = await ok(
      send('post', `/estates/${e.id}/divisions`, { code: 'N', name: 'North Division' }),
      201,
    );
    const s = await ok(send('post', `/divisions/${d.id}/sections`, { code: 'S1', name: 'Section A' }), 201);
    return [e.id, s.id] as const;
  };
  [estateA, sectionA] = await tree('A');
  [estateB, sectionB] = await tree('B');
  await ok(
    send('post', `/users/${NARROW}/scopes`, { scope_type: 'estate', scope_id: estateA }, undefined, ADMIN),
    201,
  );
}, 180_000);

afterAll(async () => {
  await new Promise((done) => server.close(done));
  await mdb.drop();
});

const field = (over: object = {}, section = sectionA) =>
  ok(
    send('post', '/fields', {
      section_id: section,
      field_number: unique('BLK-'),
      gross_area: '2.800',
      field_status: 'producing',
      ...over,
    }),
    201,
  );

describe('field boundaries (RUP-655)', () => {
  it('stores a drawn polygon and measures it: centroid, perimeter, mapped area', async () => {
    const f = await field();
    const b = await ok(send('put', `/fields/${f.id}/boundary`, { boundary: polygon() }, f.version));
    expect(b).toMatchObject({
      centroid: { latitude: '24.310500', longitude: '91.730500' },
      gross_area: '2.800',
      boundary_warning: null,
    });
    expect(Number(b.mapped_area_acres)).toBeCloseTo(2.79, 1);
    expect(Number(b.perimeter_km)).toBeCloseTo(0.426, 2);
    expect((b.boundary as { type: string }).type).toBe('Polygon');
    // Every field read carries the figures (not the shape).
    const read = await ok(get(`/fields/${f.id}`));
    expect(read).toMatchObject({ has_boundary: true, mapped_area_acres: b.mapped_area_acres });
    expect(read.boundary).toBeUndefined();
    expect(
      await mdb.db.auditChange.count({
        where: { recordType: 'field', recordId: f.id, field: 'mapped_area_acres' },
      }),
    ).toBe(1);
  });

  it('warns when the mapped area is far from the gross area', async () => {
    const f = await field({ gross_area: '10.000' });
    const b = await ok(send('put', `/fields/${f.id}/boundary`, { boundary: polygon() }, f.version));
    expect(Number(b.area_difference_pct)).toBeLessThan(-70);
    expect(b.boundary_warning).toMatch(/differs from the gross area/);
  });

  it('takes a KML file’s polygon and a GPS walk, and clears with null', async () => {
    const f = await field();
    const kml = `<kml><Placemark><Polygon><outerBoundaryIs><LinearRing><coordinates>
      91.73,24.31,0 91.731,24.31,0 91.731,24.311,0 91.73,24.311,0 91.73,24.31,0
      </coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark></kml>`;
    const k = await ok(send('put', `/fields/${f.id}/boundary`, { kml }, f.version));
    expect(Number(k.mapped_area_acres)).toBeCloseTo(2.79, 1);
    const walk = SQUARE.slice(0, 4).map(([longitude, latitude]) => ({ latitude, longitude }));
    const w = await ok(send('put', `/fields/${f.id}/boundary`, { points: walk }, k.version));
    expect(w.mapped_area_acres).toBe(k.mapped_area_acres);
    const cleared = await ok(send('put', `/fields/${f.id}/boundary`, { boundary: null }, w.version));
    expect(cleared).toMatchObject({
      boundary: null,
      centroid: null,
      perimeter_km: null,
      mapped_area_acres: null,
    });
  });

  it('draws a road or drain as a line, and only those', async () => {
    const tea = await field();
    const line = {
      type: 'LineString',
      coordinates: [
        [91.73, 24.31],
        [91.731, 24.31],
      ],
    };
    await refused(send('put', `/fields/${tea.id}/boundary`, { boundary: line }, tea.version), 'boundary');
    const drain = await field({ field_type: 'drain', field_status: 'fallow', gross_area: '0.500' });
    const d = await ok(send('put', `/fields/${drain.id}/boundary`, { boundary: line }, drain.version));
    expect(d).toMatchObject({ mapped_area_acres: null, area_difference_pct: null });
    expect(Number(d.perimeter_km)).toBeCloseTo(0.101, 2);
  });

  it('refuses a shape that cannot be a boundary, and exactly one source', async () => {
    const f = await field();
    const put = (body: object) => send('put', `/fields/${f.id}/boundary`, body, f.version);
    await refused(
      put({
        boundary: polygon([
          [91.73, 24.31],
          [91.731, 24.311],
          [91.731, 24.31],
          [91.73, 24.311],
        ]),
      }),
      'boundary',
    ); // crosses itself
    await refused(put({ boundary: polygon(SQUARE.map(([lng, lat]) => [lat ?? 0, lng ?? 0])) }), 'boundary'); // lat/lng swapped
    await refused(put({ kml: '<kml></kml>' }), 'kml');
    const both = await put({
      boundary: polygon(),
      points: [
        { latitude: 24.31, longitude: 91.73 },
        { latitude: 24.311, longitude: 91.731 },
      ],
    });
    expect(both.status, json(both)).toBe(422);
    expect((await put({ boundary: polygon() })).status).toBe(200);
    expect((await put({ boundary: polygon() })).status).toBe(409); // the version moved on
  });

  it('keeps shapes in scope: another estate’s field is 404, and the database refuses figures without a shape', async () => {
    const b = await field({}, sectionB);
    expect((await get(`/fields/${b.id}/boundary`, NARROW)).status).toBe(404);
    expect(
      (await send('put', `/fields/${b.id}/boundary`, { boundary: polygon() }, b.version, NARROW)).status,
    ).toBe(404);
    await expect(
      mdb.migrator.$executeRaw`UPDATE field SET perimeter_km = 1 WHERE id = ${BigInt(b.id)}`,
    ).rejects.toThrow(/ck_field_boundary_figures/);
  });
});

describe('section outlines and the estate map', () => {
  it('outlines a section and draws the estate: fields, roads, drains and sections, layered for the legend', async () => {
    const e = await ok(send('post', '/estates', { code: unique('M'), name: 'Mapped' }), 201);
    const d = await ok(send('post', `/estates/${e.id}/divisions`, { code: 'D', name: 'Div' }), 201);
    const s = await ok(send('post', `/divisions/${d.id}/sections`, { code: 'S', name: 'Sec' }), 201);
    const tea = await field({}, s.id);
    await ok(send('put', `/fields/${tea.id}/boundary`, { boundary: polygon() }, tea.version));
    const road = await field(
      { field_type: 'road_reserve', field_status: 'fallow', gross_area: '0.300' },
      s.id,
    );
    await ok(
      send(
        'put',
        `/fields/${road.id}/boundary`,
        {
          boundary: {
            type: 'LineString',
            coordinates: [
              [91.7299, 24.3099],
              [91.7311, 24.3099],
            ],
          },
        },
        road.version,
      ),
    );
    const unmapped = await field({}, s.id);
    const sec = await ok(get(`/sections/${s.id}`));
    const outline = polygon([
      [91.7298, 24.3098],
      [91.7312, 24.3098],
      [91.7312, 24.3112],
      [91.7298, 24.3112],
      [91.7298, 24.3098],
    ]);
    const sb = await ok(send('put', `/sections/${s.id}/boundary`, { boundary: outline }, sec.version));
    expect(Number(sb.mapped_area_acres)).toBeGreaterThan(2.79);
    expect((await ok(get(`/sections/${s.id}`))).has_boundary).toBe(true);
    await refused(
      send(
        'put',
        `/sections/${s.id}/boundary`,
        {
          boundary: {
            type: 'LineString',
            coordinates: [
              [91.73, 24.31],
              [91.731, 24.31],
            ],
          },
        },
        sb.version,
      ),
      'boundary',
    );

    const map = await ok(get(`/estates/${e.id}/map`));
    const features = map.features as { id: string; properties: { layer: string; code: string } }[];
    expect(features.map((f) => [f.properties.layer, f.properties.code]).sort()).toEqual(
      [
        ['field', String(tea.field_number)],
        ['road', String(road.field_number)],
        ['section', 'S'],
      ].sort(),
    );
    expect(map.type).toBe('FeatureCollection');
    expect(map.unmapped_field_ids).toEqual([unmapped.id]);
    const [west, south, east, north] = map.bbox as number[];
    expect([west, south, east, north]).toEqual([91.7298, 24.3098, 91.7312, 24.3112]);
  });

  it('shows a narrow user only their estate’s map', async () => {
    const mine = await field();
    await ok(send('put', `/fields/${mine.id}/boundary`, { boundary: polygon() }, mine.version));
    const map = await ok(get(`/estates/${estateA}/map`, NARROW));
    expect((map.features as unknown[]).length).toBeGreaterThan(0);
    expect((await get(`/estates/${estateB}/map`, NARROW)).status).toBe(404);
  });
});
