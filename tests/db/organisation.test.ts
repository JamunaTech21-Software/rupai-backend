import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { demoSeeders } from '../../prisma/seed/demo-seeders.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { runSeeders } from '../../src/core/db/seed.js';
import { runUnscoped } from '../../src/core/scope/scope.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { addDays, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { organisationStartupProblem } from '../../src/modules/organisation/organisation.service.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/** P1.07 — organisation, estate, division, section, field, through the HTTP API on real MySQL. */

const ADMIN = '1';
/** The System Administrator holds no business masters (P6 §7.1 R-01), so a hierarchy manager does this work. */
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;
let TZ = '';
const today = () => todayIn(TZ);

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  const config = loadConfig({ ...TEST_ENV, DATABASE_URL: url('app', mdb.name), RATE_LIMIT_ENABLED: 'false' });
  TZ = config.timezone;
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
    [...HIERARCHY, 'organisation.view', 'organisation.edit'],
    [{ scope_type: 'all_estates' }],
  );
});
afterAll(async () => {
  await mdb.drop();
});

const withVersion = (r: request.Test, version?: number) =>
  version === undefined ? r : r.set('If-Match', `"${String(version)}"`);
const api = {
  get: (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor),
  post: (path: string, body: object, actor = MANAGER, version?: number) =>
    withVersion(as(request(app).post(`/api/v1${path}`), actor), version).send(body),
  patch: (path: string, body: object, version: number, actor = MANAGER) =>
    withVersion(as(request(app).patch(`/api/v1${path}`), actor), version).send(body),
  put: (path: string, body: object, version: number, actor = MANAGER) =>
    withVersion(as(request(app).put(`/api/v1${path}`), actor), version).send(body),
  del: (path: string, actor = MANAGER) => as(request(app).delete(`/api/v1${path}`), actor),
};

interface Node {
  id: string;
  version: number;
  [k: string]: unknown;
}
const idsOf = (res: { body: unknown }): string[] => (res.body as { data: Node[] }).data.map((x) => x.id);
const created = async (r: request.Test): Promise<Node> => {
  const res = await r;
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as Node;
};
const estate = (over: object = {}) =>
  created(api.post('/estates', { code: unique('E'), name: 'Estate', ...over }));
const division = (estateId: string, over: object = {}) =>
  created(api.post(`/estates/${estateId}/divisions`, { code: unique('D'), name: 'Division', ...over }));
const section = (divisionId: string, over: object = {}) =>
  created(api.post(`/divisions/${divisionId}/sections`, { code: unique('S'), name: 'Section', ...over }));
const field = (sectionId: string, over: object = {}, actor = MANAGER) =>
  created(
    api.post(
      '/fields',
      {
        section_id: sectionId,
        field_number: unique('F'),
        gross_area: '10.000',
        field_status: 'producing',
        ...over,
      },
      actor,
    ),
  );
/** estate → division → section, all fresh. */
async function tree() {
  const e = await estate();
  const d = await division(e.id);
  const s = await section(d.id);
  return { e, d, s };
}

async function actorWith(permissions: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const role = await created(
    api.post('/roles', { code: unique('R_'), name: 'Hierarchy probe', permissions }, ADMIN),
  );
  const current = await api.get(`/users/${id}`, ADMIN);
  const set = await api.post(
    `/users/${id}/roles`,
    { roles: [{ role_id: role.id }] },
    ADMIN,
    current.body.data.version as number,
  );
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  for (const g of grants) expect((await api.post(`/users/${id}/scopes`, g, ADMIN)).status).toBe(201);
  return id;
}
const HIERARCHY = ['estate', 'division', 'section', 'field'].flatMap((m) =>
  ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`),
);

describe('organisation: one row per deployment (P3 §4.1)', () => {
  it('the seed creates exactly one, the API starts on it, and a second row is impossible', async () => {
    expect(await organisationStartupProblem(mdb.db)).toBeNull();
    await expect(
      mdb.migrator.$executeRawUnsafe(
        "INSERT INTO organisation (name, short_name, fiscal_year_start_month, created_by) VALUES ('Second', 'TWO', 1, 1)",
      ),
    ).rejects.toThrow(/ux_organisation_singleton/);
  });

  it('is read and edited without an id, with If-Match, and audited', async () => {
    const got = await api.get('/organisation');
    expect(got.status).toBe(200);
    expect(got.body.data).toMatchObject({ short_name: 'ORG', fiscal_year_start_month: 7, country_id: null });
    const v = got.body.data.version as number;
    expect((await api.patch('/organisation', { name: 'Jamuna Tea' }, v + 5)).status).toBe(409);
    const res = await api.patch(
      '/organisation',
      { name: 'Jamuna Tea', short_name: 'JTL', tin: '123456789012' },
      v,
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Jamuna Tea', short_name: 'JTL', version: v + 1 });
    const audit = await mdb.db.auditChange.findMany({ where: { recordType: 'organisation', field: 'name' } });
    expect(audit.at(-1)).toMatchObject({ oldValue: 'Organisation', newValue: 'Jamuna Tea' });
    expect((await api.patch('/organisation', { fiscal_year_start_month: 13 }, v + 1)).status).toBe(422);
  });

  it('the database refuses a fiscal year starting in month 13', async () => {
    await expect(
      mdb.migrator.$executeRawUnsafe('UPDATE organisation SET fiscal_year_start_month = 13'),
    ).rejects.toThrow(/ck_organisation_fiscal_month/);
  });
});

describe('estates, divisions, sections (P3 §4.2–§4.4)', () => {
  it('creates the hierarchy; codes are unique within their parent only', async () => {
    const e = await estate({ total_area: '1250.500', ownership_type: 'owned', established_on: '1921-03-01' });
    expect(e).toMatchObject({
      status: 'active',
      total_area: '1250.500',
      established_on: '1921-03-01',
      version: 1,
    });
    expect((await api.post('/estates', { code: e.code as string, name: 'Again' })).body.error).toMatchObject({
      code: 'DUPLICATE_KEY',
      details: [{ field: 'code' }],
    });
    const d1 = await division(e.id, { code: 'NORTH' });
    expect(d1).toMatchObject({ estate_id: e.id, code: 'NORTH' });
    expect((await api.post(`/estates/${e.id}/divisions`, { code: 'NORTH', name: 'x' })).status).toBe(422);
    const other = await estate();
    await expect(division(other.id, { code: 'NORTH' })).resolves.toMatchObject({ code: 'NORTH' }); // another estate
    const s = await section(d1.id, { code: 'S1', area: '40.250' });
    expect(s).toMatchObject({ division_id: d1.id, estate_id: e.id, area: '40.250' });

    const divisions = await api.get(`/estates/${e.id}/divisions`);
    expect(idsOf(divisions)).toEqual([d1.id]);
    const sections = await api.get(`/divisions/${d1.id}/sections`);
    expect(idsOf(sections)).toEqual([s.id]);
    expect((await api.get(`/sections/${s.id}`)).body.data).toMatchObject({ code: 'S1', estate_id: e.id });
  });

  it('edits with If-Match, audits the change, lists with filters', async () => {
    const e = await estate({ district: 'Sylhet' });
    expect((await api.patch(`/estates/${e.id}`, { name: 'Renamed' }, 99)).status).toBe(409);
    const res = await api.patch(`/estates/${e.id}`, { name: 'Renamed', district: 'Moulvibazar' }, 1);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', district: 'Moulvibazar', version: 2 });
    expect(res.headers.etag).toBe('"2"');
    const audit = await mdb.db.auditChange.findMany({
      where: { recordType: 'estate', recordId: e.id, action: 'update' },
    });
    expect(audit.map((a) => a.field).sort()).toEqual(['district', 'name']);
    const listed = await api.get(`/estates?filter[district][like]=Moulvi&sort=-code`);
    expect(idsOf(listed)).toContain(e.id);
    expect(listed.body.meta.applied_scope).toMatchObject({ all_estates: true });
    // PUT replaces the whole editable representation.
    const put = await api.put(
      `/estates/${e.id}`,
      {
        code: e.code as string,
        name: 'Whole',
        location: null,
        address_line1: null,
        district: null,
        total_area: null,
        manager_profile_id: null,
        phone: null,
        email: null,
        established_on: null,
        ownership_type: null,
        remarks: null,
      },
      2,
    );
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.data).toMatchObject({ name: 'Whole', district: null });
  });

  it('deactivate and reactivate: nothing new under an inactive parent, history recorded', async () => {
    const { e, d } = await tree();
    const off = await api.post(`/estates/${e.id}/deactivate`, {}, MANAGER, 1);
    expect(off.status).toBe(200);
    expect(off.body.data.status).toBe('inactive');
    const blocked = await api.post(`/estates/${e.id}/divisions`, { code: 'X', name: 'x' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details[0]).toMatchObject({
      field: 'estate_id',
      message: 'The estate is inactive.',
    });
    // A division of an inactive estate cannot be reactivated either.
    expect((await api.post(`/divisions/${d.id}/deactivate`, {}, MANAGER, 1)).status).toBe(200);
    expect((await api.post(`/divisions/${d.id}/reactivate`, {}, MANAGER, 2)).status).toBe(422);
    expect((await api.post(`/estates/${e.id}/reactivate`, {}, MANAGER, 2)).status).toBe(200);
    expect((await api.post(`/divisions/${d.id}/reactivate`, {}, MANAGER, 2)).status).toBe(200);
    const history = await mdb.db.statusHistory.findMany({
      where: { recordType: 'estate', recordId: e.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => [h.fromState, h.toState])).toEqual([
      [null, 'active'],
      ['active', 'inactive'],
      ['inactive', 'active'],
    ]);
  });

  it('deletes only what nothing references (P1 §5.1): a section with fields cannot be deleted', async () => {
    const { e, d, s } = await tree();
    const f = await field(s.id);
    const refused = await api.del(`/sections/${s.id}`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({
      code: 'REFERENCED_RECORD',
      details: [{ message: 'Deactivate it instead.' }],
    });
    expect((await api.del(`/divisions/${d.id}`)).status).toBe(422);
    expect((await api.del(`/estates/${e.id}`)).status).toBe(422);
    expect((await api.del(`/fields/${f.id}`)).status).toBe(204);
    expect((await api.del(`/sections/${s.id}`)).status).toBe(204);
    expect((await api.del(`/divisions/${d.id}`)).status).toBe(204);
    expect((await api.del(`/estates/${e.id}`)).status).toBe(204);
    expect((await api.get(`/estates/${e.id}`)).status).toBe(404);
    const deleted = await mdb.db.auditChange.findFirst({
      where: { recordType: 'estate', recordId: e.id, action: 'delete' },
    });
    expect(deleted).not.toBeNull();
  });

  it('a node named by a scope grant cannot be deleted, and a grant must name a real node', async () => {
    const e = await estate();
    const user = await actorWith(['estate.view'], [{ scope_type: 'estate', scope_id: e.id }]);
    const refused = await api.del(`/estates/${e.id}`);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details[0].context).toEqual({ by: 'user scope grants' });
    const bad = await api.post(
      `/users/${user}/scopes`,
      { scope_type: 'division', scope_id: '987654321' },
      ADMIN,
    );
    expect(bad.status).toBe(422);
    expect(bad.body.error.details[0]).toMatchObject({ field: 'scope_id', message: 'No such division.' });
  });
});

describe('fields (P3 §4.5)', () => {
  it('takes its estate from the section, and keeps planted area within gross area', async () => {
    const { e, d, s } = await tree();
    const f = await field(s.id, { gross_area: '12.500', planted_area: '11.000', name: 'Hill 7' });
    expect(f).toMatchObject({
      estate_id: e.id,
      division_id: d.id,
      section_id: s.id,
      gross_area: '12.500',
      planted_area: '11.000',
    });
    const over = await api.post('/fields', {
      section_id: s.id,
      field_number: unique('F'),
      gross_area: '5.000',
      planted_area: '5.001',
      field_status: 'young',
    });
    expect(over.status).toBe(422);
    expect(over.body.error.details[0]).toMatchObject({
      field: 'planted_area',
      message: 'cannot exceed gross_area',
    });
    expect((await api.patch(`/fields/${f.id}`, { gross_area: '10.000' }, 1)).status).toBe(422); // below planted
    expect(
      (
        await api.post('/fields', {
          section_id: s.id,
          estate_id: e.id,
          field_number: 'X',
          gross_area: '1.000',
          field_status: 'young',
        })
      ).status,
    ).toBe(
      422, // estate_id is never sent
    );
    await expect(
      mdb.migrator.$executeRawUnsafe(`UPDATE field SET planted_area = 99 WHERE id = ${f.id}`),
    ).rejects.toThrow(/ck_field_planted_area/);
  });

  it('field numbers are unique within an estate, not across estates', async () => {
    const a = await tree();
    const b = await tree();
    await field(a.s.id, { field_number: 'F-101' });
    expect(
      (
        await api.post('/fields', {
          section_id: a.s.id,
          field_number: 'F-101',
          gross_area: '1.000',
          field_status: 'young',
        })
      ).body.error,
    ).toMatchObject({
      code: 'DUPLICATE_KEY',
      details: [{ field: 'field_number' }],
    });
    await expect(field(b.s.id, { field_number: 'F-101' })).resolves.toMatchObject({ estate_id: b.e.id });
  });

  it('lists by estate, division, section and field status', async () => {
    const { e, d, s } = await tree();
    const s2 = await section(d.id);
    const f1 = await field(s.id, { field_status: 'producing' });
    const f2 = await field(s2.id, { field_status: 'nursery' });
    const ids = async (q: string) => idsOf(await api.get(`/fields?${q}&per_page=100`));
    expect(await ids(`filter[estate_id]=${e.id}`)).toEqual(
      [f1.id, f2.id].sort((x, y) => (x < y ? -1 : 1)).sort(),
    );
    expect(await ids(`filter[division_id]=${d.id}&filter[field_status]=nursery`)).toEqual([f2.id]);
    expect(await ids(`filter[section_id]=${s.id}`)).toEqual([f1.id]);
  });

  it('reassign-section: effective-dated, within the estate, audited with the reason', async () => {
    const { e, d, s } = await tree();
    const s2 = await section(d.id);
    const elsewhere = await tree();
    const f = await field(s.id, { section_effective_from: addDays(today(), -100) });

    const move = (body: object, version = 1) =>
      api.post(`/fields/${f.id}/reassign-section`, body, MANAGER, version);
    expect(
      (await move({ section_id: elsewhere.s.id, effective_from: today() })).body.error.details[0].message,
    ).toBe('A field can only move to a section of the same estate.');
    expect(
      (await move({ section_id: s2.id, effective_from: addDays(today(), 1) })).body.error.details[0],
    ).toMatchObject({
      field: 'effective_from',
      message: 'cannot be in the future',
    });
    expect((await move({ section_id: s2.id, effective_from: addDays(today(), -100) })).status).toBe(422); // not after joining
    expect((await move({ section_id: s.id, effective_from: today() })).status).toBe(422); // already there
    expect((await move({ section_id: s2.id, effective_from: today() }, 7)).status).toBe(409);

    const ok = await move({
      section_id: s2.id,
      effective_from: addDays(today(), -10),
      reason: 'Section boundary redrawn',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      section_id: s2.id,
      estate_id: e.id,
      section_effective_from: addDays(today(), -10),
      version: 2,
    });
    const audit = await mdb.db.auditChange.findFirst({
      where: { recordType: 'field', recordId: f.id, field: 'section_id' },
    });
    expect(audit).toMatchObject({ oldValue: s.id, newValue: s2.id, reason: 'Section boundary redrawn' });

    const inactive = await section(d.id);
    expect((await api.post(`/sections/${inactive.id}/deactivate`, {}, MANAGER, 1)).status).toBe(200);
    expect(
      (await move({ section_id: inactive.id, effective_from: today() }, 2)).body.error.details[0].message,
    ).toBe('The section is inactive.');
  });

  it('every field’s estate equals its section’s estate (P3 §4.5 denormalisation)', async () => {
    const rows = await mdb.db.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT COUNT(*) AS n FROM field f JOIN section s ON s.id = f.section_id JOIN division d ON d.id = s.division_id WHERE f.estate_id <> d.estate_id',
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe('data scope on the hierarchy (P1 §12.3, P4 §4.3)', () => {
  it('an estate grant: only that estate is visible; others are 404; adding an estate needs all estates', async () => {
    const mine = await tree();
    const theirs = await tree();
    const myField = await field(mine.s.id);
    const theirField = await field(theirs.s.id);
    const user = await actorWith(HIERARCHY, [{ scope_type: 'estate', scope_id: mine.e.id }]);

    const estates = await api.get('/estates?per_page=100', user);
    expect(idsOf(estates)).toEqual([mine.e.id]);
    expect(estates.body.meta.applied_scope).toMatchObject({ all_estates: false, estates: [mine.e.id] });
    expect((await api.get(`/estates/${theirs.e.id}`, user)).status).toBe(404);
    expect((await api.get(`/divisions/${theirs.d.id}`, user)).status).toBe(404);
    expect((await api.get(`/fields/${theirField.id}`, user)).status).toBe(404);
    expect(idsOf(await api.get('/fields?per_page=100', user))).toEqual([myField.id]);

    expect((await api.post('/estates', { code: unique('E'), name: 'Mine?' }, user)).status).toBe(403);
    await expect(
      created(api.post(`/estates/${mine.e.id}/divisions`, { code: unique('D'), name: 'ok' }, user)),
    ).resolves.toMatchObject({
      estate_id: mine.e.id,
    });
    expect(
      (await api.post(`/estates/${theirs.e.id}/divisions`, { code: unique('D'), name: 'no' }, user)).status,
    ).toBe(404);
    const intoTheirs = await api.post(
      '/fields',
      { section_id: theirs.s.id, field_number: 'X1', gross_area: '1.000', field_status: 'young' },
      user,
    );
    expect(intoTheirs.status).toBe(422);
    expect(intoTheirs.body.error.details[0]).toMatchObject({
      field: 'section_id',
      message: 'No such section.',
    });
    const denial = await mdb.db.accessLog.findFirst({
      where: { eventType: 'scope_denied', userId: BigInt(user) },
    });
    expect(denial).not.toBeNull(); // the 404s were logged as scope denials
  });

  it('a division grant: works inside the division, reads its estate, but cannot change the estate', async () => {
    const { e, d, s } = await tree();
    const d2 = await division(e.id);
    const s2 = await section(d2.id);
    const inside = await field(s.id);
    const outside = await field(s2.id);
    const user = await actorWith(HIERARCHY, [{ scope_type: 'division', scope_id: d.id }]);

    expect((await api.get(`/estates/${e.id}`, user)).status).toBe(200);
    const edit = await api.patch(`/estates/${e.id}`, { name: 'Hijacked' }, 1, user);
    expect(edit.status).toBe(403);
    expect(edit.body.error.code).toBe('SCOPE_DENIED');
    expect(
      (await api.post(`/estates/${e.id}/divisions`, { code: unique('D'), name: 'no' }, user)).status,
    ).toBe(403);
    await expect(
      created(api.post(`/divisions/${d.id}/sections`, { code: unique('S'), name: 'ok' }, user)),
    ).resolves.toMatchObject({
      division_id: d.id,
    });
    expect((await api.get(`/divisions/${d2.id}`, user)).status).toBe(404);
    expect(idsOf(await api.get('/fields?per_page=100', user))).toEqual([inside.id]);
    expect((await api.get(`/fields/${outside.id}`, user)).status).toBe(404);
    await expect(field(s.id, {}, user)).resolves.toMatchObject({ division_id: d.id });
  });

  it('a section grant: may change its section and fields, not its division', async () => {
    const { d, s } = await tree();
    const s2 = await section(d.id);
    const f = await field(s.id);
    const user = await actorWith(HIERARCHY, [{ scope_type: 'section', scope_id: s.id }]);

    expect((await api.patch(`/sections/${s.id}`, { name: 'Upper' }, 1, user)).status).toBe(200);
    expect(
      (await api.post(`/divisions/${d.id}/sections`, { code: unique('S'), name: 'no' }, user)).status,
    ).toBe(403);
    expect((await api.patch(`/divisions/${d.id}`, { name: 'no' }, 1, user)).status).toBe(403);
    await expect(field(s.id, {}, user)).resolves.toMatchObject({ section_id: s.id });
    // A section outside the grant is not visible, so it cannot be a target.
    const move = await api.post(
      `/fields/${f.id}/reassign-section`,
      { section_id: s2.id, effective_from: today() },
      user,
      1,
    );
    expect(move.status).toBe(422);
    expect(move.body.error.details[0].message).toBe('No such section.');
  });

  it('without the permission, nothing at all (403 before scope)', async () => {
    const user = await actorWith(['field.view'], [{ scope_type: 'all_estates' }]);
    expect((await api.get('/estates', user)).status).toBe(403);
    expect((await api.get('/fields', user)).status).toBe(200);
  });
});

describe('demo data for the manager check (P0.08 demo seed, P1.07)', () => {
  it('is idempotent, and the viewer sees DEMO-A but not DEMO-B', async () => {
    const seeders = demoSeeders('Demo-password-123');
    await runSeeders(mdb.migrator, seeders, silentLogger());
    const fieldsBefore = await runUnscoped('test', () =>
      mdb.db.field.count({ where: { fieldNumber: { startsWith: 'A-' } } }),
    );
    await runSeeders(mdb.migrator, seeders, silentLogger()); // a re-run adds nothing
    expect(
      await runUnscoped('test', () => mdb.db.field.count({ where: { fieldNumber: { startsWith: 'A-' } } })),
    ).toBe(fieldsBefore);
    expect(fieldsBefore).toBe(12);

    const user = async (username: string) =>
      (await mdb.db.user.findUniqueOrThrow({ where: { username }, select: { id: true } })).id.toString();
    const manager = await user('manager');
    const viewer = await user('viewer');
    const codes = async (actor: string) =>
      (
        (await api.get('/estates?per_page=100&filter[code][like]=DEMO-', actor)).body as { data: Node[] }
      ).data.map((e) => e.code);
    expect(await codes(manager)).toEqual(['DEMO-A', 'DEMO-B']);
    expect(await codes(viewer)).toEqual(['DEMO-A']);
    expect((await api.get('/organisation', viewer)).status).toBe(200);
    const demoA = (await api.get('/estates?filter[code]=DEMO-A', viewer)).body as { data: Node[] };
    expect((await api.patch(`/estates/${demoA.data[0]?.id ?? ''}`, { name: 'x' }, 1, viewer)).status).toBe(
      403,
    );
  });
});
