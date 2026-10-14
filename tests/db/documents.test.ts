import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { dbPermissionResolver } from '../../src/core/auth/authorize.js';
import { memoryPlatform } from '../../src/core/platform.js';
import { localFileStorage } from '../../src/core/storage/storage.js';
import { addDays, todayIn } from '../../src/core/time/dates.js';
import { buildModules } from '../../src/modules/index.js';
import { as, testActor } from '../helpers/actors.js';
import { testModuleDeps } from '../helpers/modules.js';
import { TEST_ENV } from '../helpers/test-app.js';
import { createMigratedDatabase, silentLogger, url, type MigratedDatabase } from './helpers.js';

/** P1.12 — document attachments through the HTTP API, on real MySQL and a real storage directory. */

const ADMIN = '1';
let MANAGER = '';
let mdb: MigratedDatabase;
let app: Express;
let storageDir = '';
let LICENCE = '';
let AGREEMENT = '';
let today = '';
let seq = 0;
const unique = (p: string) => `${p}${String(Date.now() % 10000)}${String((seq += 1))}`;

const pdf = (text: string) => Buffer.from(`%PDF-1.7\n${text}\n%%EOF\n`);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40, 7)]);

interface Doc {
  id: string;
  version: number;
  version_number: number;
  series_no: number;
  [k: string]: unknown;
}
interface FileSpec {
  content: Buffer;
  name?: string;
  type?: string;
}
const one = (res: { body: unknown }) => (res.body as { data: Doc }).data;
const many = (res: { body: unknown }) => (res.body as { data: Doc[] }).data;
const err = (res: { body: unknown }) =>
  (res.body as { error: { code: string; details: { code: string; field?: string }[] } }).error;
const json = (res: { status: number; body: unknown }) => `${String(res.status)} ${JSON.stringify(res.body)}`;

const get = (path: string, actor = MANAGER) => as(request(app).get(`/api/v1${path}`), actor);
const post = (path: string, body: object, actor = MANAGER) =>
  as(request(app).post(`/api/v1${path}`), actor).send(body);

function send(
  path: string,
  fields: Record<string, string>,
  file: FileSpec | null,
  actor = MANAGER,
  version?: number,
) {
  let r = as(request(app).post(`/api/v1${path}`), actor);
  if (version !== undefined) r = r.set('If-Match', `"${String(version)}"`);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  if (file) {
    // `filepath` sends the name as given; `filename` would be cut to its last segment by the test client.
    r = r.attach('file', file.content, {
      filepath: file.name ?? 'licence.pdf',
      contentType: file.type ?? 'application/pdf',
    } as never);
  }
  return r;
}
async function attach(owner: string, fields: Record<string, string> = {}, file?: Partial<FileSpec>) {
  const res = await send(
    `${owner}/documents`,
    { document_type_id: LICENCE, ...fields },
    { content: pdf(unique('doc')), ...file },
  );
  expect(res.status, json(res)).toBe(201);
  return one(res);
}
async function make(path: string, body: object): Promise<string> {
  const res = await post(path, body);
  expect(res.status, json(res)).toBe(201);
  return `${path}/${one(res).id}`;
}
const factory = () => make('/factories', { code: unique('F'), name: 'Factory', factory_type: 'own' });
const warehouse = () => make('/warehouses', { code: unique('W'), name: 'Warehouse', warehouse_type: 'own' });
const party = () => make('/parties', { code: unique('P'), name: 'Party', party_type: 'individual' });
const idOf = (path: string) => path.split('/').pop() ?? '';

async function actorWith(permissions: string[], grants: object[]): Promise<string> {
  const u = await mdb.migrator.user.create({
    data: { username: unique('actor'), passwordHash: 'x', createdBy: 1n },
  });
  const id = u.id.toString();
  const role = await post('/roles', { code: unique('R_'), name: 'Documents probe', permissions }, ADMIN);
  expect(role.status, json(role)).toBe(201);
  const current = await get(`/users/${id}`, ADMIN);
  const set = await as(request(app).post(`/api/v1/users/${id}/roles`), ADMIN)
    .set('If-Match', `"${String(one(current).version)}"`)
    .send({ roles: [{ role_id: one(role).id }] });
  expect(set.status, json(set)).toBe(200);
  for (const g of grants) {
    const res = await post(`/users/${id}/scopes`, g, ADMIN);
    expect(res.status, json(res)).toBe(201);
  }
  return id;
}
const crud = (...modules: string[]) =>
  modules.flatMap((m) => ['view', 'create', 'edit', 'delete'].map((a) => `${m}.${a}`));
/** Temporary files are removed when the response ends, just after the client has its answer. */
async function temporaryFiles(): Promise<string[]> {
  for (let i = 0; i < 40 && storedFiles(join(storageDir, 'tmp')).length > 0; i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  return storedFiles(join(storageDir, 'tmp'));
}
const storedFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

beforeAll(async () => {
  mdb = await createMigratedDatabase();
  storageDir = mkdtempSync(join(tmpdir(), 'rupai-documents-test-'));
  const config = loadConfig({
    ...TEST_ENV,
    DATABASE_URL: url('app', mdb.name),
    RATE_LIMIT_ENABLED: 'false',
    UPLOAD_MAX_MB: '1',
  });
  today = todayIn(config.timezone);
  const deps = testModuleDeps({
    config,
    db: mdb.db,
    authz: dbPermissionResolver(mdb.db),
    logger: silentLogger(),
    storage: localFileStorage(storageDir),
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
    [...crud('factory', 'warehouse', 'land', 'estate', 'division', 'field'), 'document.view'],
    [{ scope_type: 'all_estates' }],
  );
  const types = await mdb.migrator.documentType.findMany({
    where: { code: { in: ['LICENCE', 'AGREEMENT'] } },
  });
  LICENCE = types.find((t) => t.code === 'LICENCE')?.id.toString() ?? '';
  AGREEMENT = types.find((t) => t.code === 'AGREEMENT')?.id.toString() ?? '';
  expect(LICENCE).not.toBe('');
});
afterAll(async () => {
  await mdb.drop();
});

describe('attaching a document (P3 §28.4, P4 §6.6)', () => {
  it('stores the file under a generated key and returns the document', async () => {
    const f = await factory();
    const content = pdf('fire licence');
    const res = await send(
      `${f}/documents`,
      {
        document_type_id: LICENCE,
        title: 'Fire licence',
        issue_date: '2026-01-01',
        expiry_date: '2026-12-31',
      },
      { content, name: 'ফায়ার লাইসেন্স.pdf' },
    );
    expect(res.status, json(res)).toBe(201);
    const d = one(res);
    expect(d).toMatchObject({
      owner_type: 'factory',
      owner_id: idOf(f),
      document_type_id: LICENCE,
      document_type: { code: 'LICENCE' },
      series_no: 1,
      version_number: 1,
      title: 'Fire licence',
      file_name: 'ফায়ার লাইসেন্স.pdf',
      mime_type: 'application/pdf',
      file_size_bytes: content.length,
      checksum: createHash('sha256').update(content).digest('hex'),
      issue_date: '2026-01-01',
      expiry_date: '2026-12-31',
      is_current: true,
      status: 'active',
      uploaded_by: MANAGER,
      version: 1,
    });
    expect(res.headers.location).toBe(`/api/v1/documents/${d.id}`);
    expect(res.headers.etag).toBe('"1"');

    // The database holds a relative key: never the uploaded name, never an absolute path.
    const row = await mdb.migrator.documentFile.findUniqueOrThrow({ where: { id: BigInt(d.id) } });
    expect(row.storedPath).toMatch(/^documents\/\d{4}\/\d{2}\/[0-9A-Z]{26}$/);
    expect(existsSync(join(storageDir, row.storedPath))).toBe(true);
    expect(await temporaryFiles()).toEqual([]);

    expect(one(await get(`/documents/${d.id}`))).toMatchObject({ id: d.id, title: 'Fire licence' });
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'document_file', recordId: d.id },
    });
    expect(audit.map((a) => a.action)).toEqual(['create']);
    const history = await mdb.migrator.statusHistory.findMany({
      where: { recordType: 'document_file', recordId: d.id },
    });
    expect(history.map((h) => [h.fromState, h.toState])).toEqual([[null, 'active']]);
  });

  it('lets an owner hold several documents of one type, each its own series', async () => {
    const f = await factory();
    const a = await attach(f, { title: 'Trade licence' });
    const b = await attach(f, { title: 'Fire licence' });
    const c = await attach(f, { document_type_id: AGREEMENT });
    expect([a.series_no, b.series_no, c.series_no]).toEqual([1, 2, 1]);
    expect(
      many(await get(`${f}/documents`))
        .map((d) => d.id)
        .sort(),
    ).toEqual([a.id, b.id, c.id].sort());
  });

  it('refuses a mismatched extension, a disallowed type and a name with a path', async () => {
    const f = await factory();
    const before = storedFiles(storageDir).length;
    const cases: [FileSpec, string][] = [
      [{ content: PNG, name: 'licence.pdf' }, 'FILE_TYPE_MISMATCH'],
      [{ content: pdf('x'), name: 'photo.png', type: 'image/png' }, 'FILE_TYPE_MISMATCH'],
      [{ content: pdf('x'), name: 'licence.pdf', type: 'image/png' }, 'FILE_TYPE_MISMATCH'],
      [{ content: pdf('x'), name: 'run.exe', type: 'application/octet-stream' }, 'FILE_TYPE_NOT_ALLOWED'],
      [{ content: pdf('x'), name: 'page.html', type: 'text/html' }, 'FILE_TYPE_NOT_ALLOWED'],
      [{ content: pdf('x'), name: '../../etc/cron.d/licence.pdf' }, 'FILE_NAME_INVALID'],
      [{ content: pdf('x'), name: 'dir\\licence.pdf' }, 'FILE_NAME_INVALID'],
    ];
    for (const [file, code] of cases) {
      const res = await send(`${f}/documents`, { document_type_id: LICENCE }, file);
      expect(res.status, `${file.name ?? ''} ${json(res)}`).toBe(422);
      expect(err(res).details[0]).toMatchObject({ field: 'file', code });
    }
    expect(many(await get(`${f}/documents`))).toEqual([]);
    // Nothing of a refused upload is kept, in the documents area or the temporary one.
    await temporaryFiles();
    expect(storedFiles(storageDir).length).toBe(before);
  });

  it('refuses a file over the size limit, a missing file and invalid fields', async () => {
    const f = await factory();
    const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1024 * 1024)]);
    const tooBig = await send(`${f}/documents`, { document_type_id: LICENCE }, { content: big });
    expect(tooBig.status, json(tooBig)).toBe(413);
    expect(err(tooBig).code).toBe('PAYLOAD_TOO_LARGE');

    const noFile = await send(`${f}/documents`, { document_type_id: LICENCE }, null);
    expect(noFile.status, json(noFile)).toBe(422);
    expect(err(noFile).details[0]).toMatchObject({ field: 'file' });

    const file = { content: pdf('x') };
    const bad: [Record<string, string>, string][] = [
      [{}, 'document_type_id'],
      [{ document_type_id: '999999' }, 'document_type_id'],
      [{ document_type_id: LICENCE, issue_date: '2026-05-01', expiry_date: '2026-04-30' }, 'expiry_date'],
      [{ document_type_id: LICENCE, expiry_date: '31/12/2026' }, 'expiry_date'],
      [{ document_type_id: LICENCE, owner_id: '5' }, ''],
    ];
    for (const [fields, field] of bad) {
      const res = await send(`${f}/documents`, fields, file);
      expect(res.status, json(res)).toBe(422);
      if (field) expect(err(res).details.map((d) => d.field)).toContain(field);
    }
    expect(await temporaryFiles()).toEqual([]);

    // Bodies are JSON everywhere else, and an upload route takes nothing but multipart.
    const asJson = await post(`${f}/documents`, { document_type_id: LICENCE });
    expect(asJson.status).toBe(415);
    const multipartElsewhere = await as(request(app).post('/api/v1/factories'), MANAGER)
      .field('code', 'X1')
      .field('name', 'x');
    expect(multipartElsewhere.status).toBe(415);
    expect((await send('/factories/999999/documents', { document_type_id: LICENCE }, file)).status).toBe(404);
  });
});

describe('versions (P3 §28.4: "the previous is retained")', () => {
  it('replaces a file with a new version and keeps the old one', async () => {
    const f = await factory();
    const first = pdf('licence 2025');
    const v1 = await attach(f, { title: 'Trade licence', expiry_date: '2025-12-31' }, { content: first });
    const second = { content: pdf('licence 2026'), name: 'licence-2026.pdf' };

    const noVersion = await send(`/documents/${v1.id}/replace`, {}, second);
    expect(err(noVersion).code).toBe('PRECONDITION_REQUIRED');
    const stale = await send(`/documents/${v1.id}/replace`, {}, second, MANAGER, 9);
    expect(stale.status).toBe(409);
    expect(err(stale).code).toBe('VERSION_CONFLICT');
    const same = await send(`/documents/${v1.id}/replace`, {}, { content: first }, MANAGER, 1);
    expect(same.status, json(same)).toBe(422);
    expect(err(same).details[0]).toMatchObject({ field: 'file', code: 'FILE_UNCHANGED' });

    const res = await send(`/documents/${v1.id}/replace`, { expiry_date: '2026-12-31' }, second, MANAGER, 1);
    expect(res.status, json(res)).toBe(201);
    const v2 = one(res);
    expect(v2).toMatchObject({
      series_no: 1,
      version_number: 2,
      title: 'Trade licence',
      file_name: 'licence-2026.pdf',
      expiry_date: '2026-12-31',
      issue_date: null,
      is_current: true,
      status: 'active',
    });
    expect(v2.id).not.toBe(v1.id);

    expect(one(await get(`/documents/${v1.id}`))).toMatchObject({
      is_current: false,
      status: 'superseded',
      version_number: 1,
      expiry_date: '2025-12-31',
    });
    expect(many(await get(`${f}/documents`)).map((d) => d.id)).toEqual([v2.id]);
    expect(many(await get(`${f}/documents?history=true`)).map((d) => d.id)).toEqual([v2.id, v1.id]);
    expect(many(await get(`/documents/${v1.id}/versions`)).map((d) => d.version_number)).toEqual([2, 1]);

    // The previous file is still there and still downloadable.
    const link = (await get(`/documents/${v1.id}/download`)).body as { data: { url: string } };
    const old = await request(app).get(link.data.url).buffer(true).parse(binary);
    expect(old.status).toBe(200);
    expect((old.body as Buffer).equals(first)).toBe(true);

    // History is fixed: only the current version can be replaced, corrected or removed.
    const again = await send(`/documents/${v1.id}/replace`, {}, { content: pdf('other') }, MANAGER, 2);
    expect(again.status, json(again)).toBe(409);
    expect(err(again).code).toBe('INVALID_TRANSITION');
    const patchOld = await as(request(app).patch(`/api/v1/documents/${v1.id}`), MANAGER)
      .set('If-Match', '"2"')
      .send({ title: 'x' });
    expect(err(patchOld).code).toBe('INVALID_TRANSITION');
    expect(err(await as(request(app).delete(`/api/v1/documents/${v1.id}`), MANAGER)).code).toBe(
      'INVALID_TRANSITION',
    );
    const history = await mdb.migrator.statusHistory.findMany({
      where: { recordType: 'document_file', recordId: v1.id },
      orderBy: { id: 'asc' },
    });
    expect(history.map((h) => h.toState)).toEqual(['active', 'superseded']);
  });

  it('corrects the title and dates of the current version with If-Match', async () => {
    const f = await factory();
    const d = await attach(f, { expiry_date: '2026-06-30' });
    const patch = (body: object, version?: number) => {
      const r = as(request(app).patch(`/api/v1/documents/${d.id}`), MANAGER);
      return (version === undefined ? r : r.set('If-Match', `"${String(version)}"`)).send(body);
    };
    expect(err(await patch({ expiry_date: '2027-06-30' })).code).toBe('PRECONDITION_REQUIRED');
    expect(err(await patch({ expiry_date: '2027-06-30' }, 7)).code).toBe('VERSION_CONFLICT');
    expect((await patch({}, 1)).status).toBe(422);
    expect((await patch({ file_name: 'x.pdf' }, 1)).status).toBe(422);
    expect((await patch({ issue_date: '2026-07-01' }, 1)).status).toBe(422); // after the stored expiry

    const res = await patch({ expiry_date: '2027-06-30', title: 'Corrected' }, 1);
    expect(res.status, json(res)).toBe(200);
    expect(one(res)).toMatchObject({
      expiry_date: '2027-06-30',
      title: 'Corrected',
      version: 2,
      version_number: 1,
    });
    expect(res.headers.etag).toBe('"2"');
    expect(one(await patch({ expiry_date: null, title: null }, 2))).toMatchObject({
      expiry_date: null,
      title: null,
      days_to_expiry: null,
    });
    const audit = await mdb.migrator.auditChange.findMany({
      where: { recordType: 'document_file', recordId: d.id, action: 'update' },
    });
    expect(audit.map((a) => a.field).sort()).toEqual(['expiry_date', 'expiry_date', 'title', 'title']);
  });

  it('removes a document by archiving it: the row and the file stay', async () => {
    const f = await factory();
    const d = await attach(f);
    const link = (await get(`/documents/${d.id}/download`)).body as { data: { url: string } };
    expect((await as(request(app).delete(`/api/v1/documents/${d.id}`), MANAGER)).status).toBe(204);

    expect(many(await get(`${f}/documents`))).toEqual([]);
    expect(many(await get(`${f}/documents?history=true`))[0]).toMatchObject({
      id: d.id,
      status: 'archived',
      is_current: false,
    });
    const row = await mdb.migrator.documentFile.findUniqueOrThrow({ where: { id: BigInt(d.id) } });
    expect(existsSync(join(storageDir, row.storedPath))).toBe(true);
    expect((await request(app).get(link.data.url)).status).toBe(200);
    // The series number is not reused: the next licence is a new document.
    expect((await attach(f)).series_no).toBe(2);
  });

  it('archives the documents of an owner that is deleted', async () => {
    const p = await party();
    const d = await attach(p);
    expect((await as(request(app).delete(`/api/v1${p}`), MANAGER)).status).toBe(204);
    const row = await mdb.migrator.documentFile.findUniqueOrThrow({ where: { id: BigInt(d.id) } });
    expect(row).toMatchObject({ status: 'archived', isCurrent: false });
    expect((await get(`/documents/${d.id}`)).status).toBe(404);
  });
});

/** Collects a binary response body (the test client parses JSON only by default). */
function binary(res: request.Response, done: (err: Error | null, body: Buffer) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  stream.on('end', () => {
    done(null, Buffer.concat(chunks));
  });
}

describe('download (P4 §6.6: a short-lived signed link, never a path)', () => {
  it('serves the file through the signed link, without a session, as an attachment', async () => {
    const f = await factory();
    const content = pdf('download me');
    const d = await attach(f, {}, { content, name: 'চুক্তি final.pdf' });
    const res = await get(`/documents/${d.id}/download`);
    expect(res.status, json(res)).toBe(200);
    const link = (res.body as { data: { url: string; expires_at: string; file_name: string } }).data;
    expect(link.url).toMatch(
      new RegExp(`^/api/v1/documents/${d.id}/content\\?expires=\\d+&signature=[\\w-]+$`),
    );
    expect(link.url).not.toContain('documents/20');
    const ttl = (new Date(link.expires_at).getTime() - Date.now()) / 1000;
    expect(ttl).toBeGreaterThan(200);
    expect(ttl).toBeLessThanOrEqual(300);

    const file = await request(app).get(link.url).buffer(true).parse(binary);
    expect(file.status).toBe(200);
    expect((file.body as Buffer).equals(content)).toBe(true);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.headers['content-length']).toBe(String(content.length));
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['cache-control']).toBe('private, no-store');
    expect(file.headers['content-disposition']).toBe(
      `attachment; filename="______ final.pdf"; filename*=UTF-8''${encodeURIComponent('চুক্তি final.pdf')}`,
    );
  });

  it('refuses an altered link, and a link moved to another document', async () => {
    const f = await factory();
    const a = await attach(f);
    const b = await attach(f);
    const link = ((await get(`/documents/${a.id}/download`)).body as { data: { url: string } }).data.url;
    const [, expires = '', signature = ''] = /expires=(\d+)&signature=([\w-]+)/.exec(link) ?? [];
    const content = (id: string, e: string, s: string) =>
      request(app).get(`/api/v1/documents/${id}/content?expires=${e}&signature=${s}`);

    expect((await content(a.id, expires, signature)).status).toBe(200);
    expect((await content(b.id, expires, signature)).status).toBe(404);
    expect((await content(a.id, String(Number(expires) + 600), signature)).status).toBe(404);
    expect((await content(a.id, expires, signature.split('').reverse().join(''))).status).toBe(404);
    expect((await request(app).get(`/api/v1/documents/${a.id}/content`)).status).toBe(422);
    // The link itself is only issued to a signed-in caller.
    expect((await request(app).get(`/api/v1/documents/${a.id}/download`)).status).toBe(401);
  });
});

describe('permission and scope follow the owner', () => {
  it('needs the owner module’s view, edit and delete permissions', async () => {
    const f = await factory();
    const d = await attach(f);
    const viewer = await actorWith(['factory.view'], [{ scope_type: 'all_estates' }]);
    const stranger = await actorWith(['warehouse.view', 'warehouse.edit'], [{ scope_type: 'all_estates' }]);

    expect((await get(`${f}/documents`, viewer)).status).toBe(200);
    expect((await get(`/documents/${d.id}`, viewer)).status).toBe(200);
    expect((await get(`/documents/${d.id}/download`, viewer)).status).toBe(200);
    const file = { content: pdf('x') };
    for (const res of [
      await send(`${f}/documents`, { document_type_id: LICENCE }, file, viewer),
      await send(`/documents/${d.id}/replace`, {}, file, viewer, 1),
      await as(request(app).patch(`/api/v1/documents/${d.id}`), viewer)
        .set('If-Match', '"1"')
        .send({ title: 'x' }),
      await as(request(app).delete(`/api/v1/documents/${d.id}`), viewer),
      await get(`${f}/documents`, stranger),
      await get(`/documents/${d.id}`, stranger),
      await get(`/documents/${d.id}/versions`, stranger),
      await get(`/documents/${d.id}/download`, stranger),
      await send(`/documents/${d.id}/replace`, {}, file, stranger, 1),
    ]) {
      expect(res.status, json(res)).toBe(403);
      expect(err(res).code).toBe('PERMISSION_DENIED');
    }
    expect(one(await get(`/documents/${d.id}`))).toMatchObject({ status: 'active', version: 1 });
    // A refused upload leaves nothing behind.
    expect(await temporaryFiles()).toEqual([]);
    expect((await request(app).get(`/api/v1/documents/${d.id}`)).status).toBe(401);
    expect((await get('/documents/999999', viewer)).status).toBe(404);
  });

  it('hides the documents of an owner outside the caller’s scope', async () => {
    const mine = await factory();
    const other = await factory();
    const dMine = await attach(mine);
    const dOther = await attach(other);
    const scoped = await actorWith(crud('factory'), [{ scope_type: 'factory', scope_id: idOf(mine) }]);

    expect(many(await get(`${mine}/documents`, scoped)).map((d) => d.id)).toEqual([dMine.id]);
    const file = { content: pdf('scoped') };
    expect((await send(`${mine}/documents`, { document_type_id: LICENCE }, file, scoped)).status).toBe(201);
    for (const res of [
      await get(`${other}/documents`, scoped),
      await get(`/documents/${dOther.id}`, scoped),
      await get(`/documents/${dOther.id}/download`, scoped),
      await send(`${other}/documents`, { document_type_id: LICENCE }, file, scoped),
      await send(`/documents/${dOther.id}/replace`, {}, file, scoped, 1),
      await as(request(app).delete(`/api/v1/documents/${dOther.id}`), scoped),
    ]) {
      expect(res.status, json(res)).toBe(404);
    }
  });

  it('refuses a change to an estate seen only through a division grant', async () => {
    const estate = one(await post('/estates', { code: unique('E'), name: 'Estate' }));
    const division = one(
      await post(`/estates/${estate.id}/divisions`, { code: unique('D'), name: 'Division' }),
    );
    expect(division.id, JSON.stringify(division)).toBeTruthy();
    const d = await attach(`/estates/${estate.id}`);
    const supervisor = await actorWith(crud('estate'), [{ scope_type: 'division', scope_id: division.id }]);

    expect(many(await get(`/estates/${estate.id}/documents`, supervisor)).map((x) => x.id)).toEqual([d.id]);
    const res = await send(
      `/estates/${estate.id}/documents`,
      { document_type_id: LICENCE },
      { content: pdf('x') },
      supervisor,
    );
    expect(res.status, json(res)).toBe(403);
    expect(err(res).code).toBe('SCOPE_DENIED');
    expect(err(await as(request(app).delete(`/api/v1/documents/${d.id}`), supervisor)).code).toBe(
      'SCOPE_DENIED',
    );
  });
});

describe('expiring documents (P4 §6.6)', () => {
  it('lists current documents by expiry across the owners the caller may see', async () => {
    const f1 = await factory();
    const f2 = await factory();
    const w = await warehouse();
    const day = (n: number) => addDays(today as never, n);
    const soon = await attach(f1, { expiry_date: day(10), title: 'soon' });
    const later = await attach(f1, { expiry_date: day(100), title: 'later' });
    const expired = await attach(w, { expiry_date: day(-1), title: 'expired' });
    const other = await attach(f2, { expiry_date: day(5), title: 'other factory' });
    const noExpiry = await attach(f1, { title: 'no expiry' });
    const replaced = await attach(f1, { expiry_date: day(3), title: 'replaced' });
    const renewed = one(
      await send(
        `/documents/${replaced.id}/replace`,
        { expiry_date: day(400) },
        { content: pdf('renewed') },
        MANAGER,
        1,
      ),
    );
    const removed = await attach(f1, { expiry_date: day(2), title: 'removed' });
    await as(request(app).delete(`/api/v1/documents/${removed.id}`), MANAGER);

    const mineOnly = (res: { body: unknown }) => {
      const wanted = new Set(
        [soon, later, expired, other, noExpiry, replaced, renewed, removed].map((d) => d.id),
      );
      return many(res).filter((d) => wanted.has(d.id));
    };
    const res = await get('/documents/expiring?per_page=200');
    expect(res.status, json(res)).toBe(200);
    const listed = mineOnly(res);
    expect(listed.map((d) => d.id)).toEqual([expired.id, other.id, soon.id]);
    expect(listed.map((d) => d.days_to_expiry)).toEqual([-1, 5, 10]);
    expect(listed[1]).toMatchObject({ owner_type: 'factory', owner_id: idOf(f2) });
    expect(String(listed[1]?.owner_label)).toMatch(/ · Factory$/);

    const wide = mineOnly(
      await get(
        `/documents/expiring?per_page=200&filter[expiry_date][from]=${today}&filter[expiry_date][to]=${day(500)}`,
      ),
    );
    expect(wide.map((d) => d.id)).toEqual([other.id, soon.id, later.id, renewed.id]);
    const byOwner = mineOnly(await get('/documents/expiring?per_page=200&filter[owner_type]=warehouse'));
    expect(byOwner.map((d) => d.id)).toEqual([expired.id]);
    expect((await get('/documents/expiring?filter[status]=active')).status).toBe(422);

    // Scope: a factory grant shows that factory's documents and nothing else.
    const scoped = await actorWith(
      ['document.view', 'factory.view', 'warehouse.view'],
      [{ scope_type: 'factory', scope_id: idOf(f1) }],
    );
    expect(mineOnly(await get('/documents/expiring?per_page=200', scoped)).map((d) => d.id)).toEqual([
      soon.id,
    ]);
    // Permission: without warehouse.view the warehouse's document is not listed.
    const noWarehouse = await actorWith(['document.view', 'factory.view'], [{ scope_type: 'all_estates' }]);
    expect(mineOnly(await get('/documents/expiring?per_page=200', noWarehouse)).map((d) => d.id)).toEqual([
      other.id,
      soon.id,
    ]);
    const noDocumentView = await actorWith(['factory.view'], [{ scope_type: 'all_estates' }]);
    expect((await get('/documents/expiring', noDocumentView)).status).toBe(403);

    const page = await get('/documents/expiring?per_page=1&page=2');
    expect(
      (page.body as { meta: { pagination: { per_page: number; page: number } } }).meta.pagination,
    ).toMatchObject({ page: 2, per_page: 1 });
    expect(many(page)).toHaveLength(1);
  });
});
