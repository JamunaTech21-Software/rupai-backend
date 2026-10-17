import type { Response } from 'express';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { currentActorId, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { SHEET_MIME, type SheetFormat } from '../../core/imports/sheets.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getUpload, multipartUpload } from '../../core/http/upload.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import type { FileStorage } from '../../core/storage/storage.js';
import {
  BATCH_STATES,
  BatchOut,
  BatchParams,
  ErrorLineOut,
  FormatQuery,
  ImportTypeOut,
  ROW_STATES,
  RowOut,
  TypeParams,
  UploadFields,
} from './imports.schema.js';
import { importsService } from './imports.service.js';

/** HTTP surface of the import framework (P1.17; Spec P4 §6.7). */

export interface ImportsDeps {
  readonly config: Config;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly storage: FileStorage;
  readonly jobs: JobQueue;
}

const BY_TYPE =
  'The import type’s own permission: {module}.create (e.g. lookup.create for lookup.amenity), checked in ' +
  'the handler because it depends on the type.';
const BY_BATCH =
  'Whoever uploaded the batch, or a holder of the type’s {module}.view. Anyone else gets 404. Commit and ' +
  'cancel also need {module}.create.';

/** RFC 6266: an ASCII fallback plus the real name. */
function sendFile(res: Response, body: Buffer, fileName: string, format: SheetFormat) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.status(200);
  res.setHeader('Content-Type', SHEET_MIME[format]);
  res.setHeader('Content-Length', String(body.length));
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(body);
}

export function importsModule(deps: ImportsDeps): ApiModule {
  const { config, db, platform, authz, accessLog, storage, jobs } = deps;
  const svc = importsService({ db, storage, queue: jobs, authz, accessLog });
  const upload = multipartUpload({ storage, maxBytes: config.storage.maxUploadBytes });
  const m = defineModule({ name: 'imports', path: '/imports', tag: 'Imports', platform, authz, accessLog });
  const byBatch = { params: BatchParams };

  m.route({
    method: 'get',
    path: '/types',
    summary: 'What I can import',
    description: 'The import types the caller may use (holds {module}.create), with their columns.',
    auth: { signedIn: true, reason: BY_TYPE },
    success: { status: 200, description: 'The import types', schema: ImportTypeOut },
    errors: [],
    handler: async (req, res) => {
      const items = await svc.types();
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/types/:type',
    summary: 'One import type',
    auth: { signedIn: true, reason: BY_TYPE },
    params: TypeParams,
    success: { status: 200, description: 'The import type', schema: ImportTypeOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, { params: TypeParams });
      sendOne(res, await svc.type(params.type, req.originalUrl));
    },
  });

  m.route({
    method: 'get',
    path: '/templates/:type',
    summary: 'Download the template',
    description:
      'format=xlsx (default: a Data sheet with the header row, and an Instructions sheet saying what each ' +
      'column takes) or csv (the header row only). Cells are text, so codes like "007" keep their zeros.',
    auth: { signedIn: true, reason: BY_TYPE },
    params: TypeParams,
    query: FormatQuery,
    success: { status: 200, description: 'The template file', binary: true },
    errors: [],
    handler: async (req, res) => {
      const { params, query } = getValidated(res, { params: TypeParams, query: FormatQuery });
      const format = query.format ?? 'xlsx';
      const file = await svc.template(params.type, format, req.originalUrl);
      sendFile(res, file.body, file.fileName, format);
    },
  });

  m.route({
    method: 'get',
    path: '/',
    summary: 'List imports',
    description: 'Newest first: the caller’s own batches, and every batch of the types they may view.',
    auth: { signedIn: true, reason: BY_BATCH },
    list: {
      pagination: 'page',
      filters: {
        import_type: { type: 'string', ops: ['eq', 'in'] },
        state: { type: { enum: BATCH_STATES }, ops: ['eq', 'in'] },
      },
      sorts: [],
      maxPageSize: 100,
    },
    success: { status: 200, description: 'A page of imports', schema: BatchOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.list(q, currentActorId());
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'post',
    path: '/:type',
    summary: 'Upload a file to import',
    description:
      'multipart/form-data with the filled-in template in the field "file" (.xlsx or .csv). 202: the batch, ' +
      'state validating, with its validation job. Poll GET /imports/{id} (or the job) until it is validated ' +
      '(read the counts and GET /imports/{id}/errors) or rejected (the file could not be used: problems). ' +
      'Nothing is saved until commit. To correct, fix the file and upload it again: a new batch.',
    auth: { signedIn: true, reason: BY_TYPE },
    params: TypeParams,
    body: UploadFields,
    multipart: upload,
    success: { status: 202, description: 'The batch, being validated', schema: BatchOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, { params: TypeParams, body: UploadFields });
      const b = await svc.upload(params.type, getUpload(res), currentActorId(), req.originalUrl);
      sendOne(res, b, { status: 202, location: `/api/v1/imports/${b.id}` });
    },
  });

  m.route({
    method: 'get',
    path: '/:id',
    summary: 'Read an import',
    description:
      'Its state, the row counts, the job working on it (poll while job is not null), and can_commit / ' +
      'can_cancel. The wizard reads its step from here, so it survives a reload (P5 §7.6).',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    success: { status: 200, description: 'The import', schema: BatchOut },
    errors: [],
    handler: async (_req, res) => {
      const { params } = getValidated(res, byBatch);
      const b = await svc.get(params.id, currentActorId());
      sendOne(res, b, { version: b.version });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/rows',
    summary: 'The rows of an import',
    description:
      'Each row as read, its state and errors, and the record it became. filter[state]=invalid for the bad ones.',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    list: {
      pagination: 'page',
      filters: { state: { type: { enum: ROW_STATES }, ops: ['eq', 'in'] } },
      sorts: [],
      maxPageSize: 500,
    },
    success: { status: 200, description: 'A page of rows', schema: RowOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byBatch);
      const q = getListQuery(res);
      const { items, total } = await svc.rows(params.id, currentActorId(), q);
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 50 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/errors',
    summary: 'The error report',
    description:
      'One line per error: row number (the header is row 1), column, code and message, for the rows that ' +
      'were invalid at validation or failed at commit. For the file, GET /imports/{id}/errors/file.',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    success: { status: 200, description: 'The errors', schema: ErrorLineOut },
    errors: [],
    handler: async (req, res) => {
      const { params } = getValidated(res, byBatch);
      const items = await svc.errorLines(params.id, currentActorId());
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/:id/errors/file',
    summary: 'Download the error report',
    description:
      'format=xlsx (default) or csv: row, column, code, message, then the row as it was read, so the user ' +
      'corrects the rows in the file and uploads it again.',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    query: FormatQuery,
    success: { status: 200, description: 'The error report file', binary: true },
    errors: [],
    handler: async (_req, res) => {
      const { params, query } = getValidated(res, { ...byBatch, query: FormatQuery });
      const format = query.format ?? 'xlsx';
      const file = await svc.errorFile(params.id, currentActorId(), format);
      sendFile(res, file.body, file.fileName, format);
    },
  });

  m.route({
    method: 'post',
    path: '/:id/commit',
    summary: 'Import the valid rows',
    description:
      '202: state committing, with the commit job. Only valid rows are saved; invalid ones are skipped. A row ' +
      'refused at commit (e.g. its code was added meanwhile) is marked failed and the job ends partial. ' +
      '409 INVALID_TRANSITION unless validated; 422 when no row is valid.',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    success: { status: 202, description: 'The batch, committing', schema: BatchOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byBatch);
      sendOne(res, await svc.commit(params.id, currentActorId(), req.originalUrl), { status: 202 });
    },
  });

  m.route({
    method: 'post',
    path: '/:id/cancel',
    summary: 'Cancel an import',
    description:
      'Discards the staging rows and the file of a validated or rejected batch; the batch stays, cancelled, ' +
      'as a record. A committed import cannot be cancelled.',
    auth: { signedIn: true, reason: BY_BATCH },
    ...byBatch,
    success: { status: 200, description: 'The batch, cancelled', schema: BatchOut },
    errors: ['INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byBatch);
      sendOne(res, await svc.cancel(params.id, currentActorId(), req.originalUrl));
    },
  });

  return m.build();
}
