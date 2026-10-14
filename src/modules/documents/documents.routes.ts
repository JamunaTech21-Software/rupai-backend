import type { Request } from 'express';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { ApiModule } from '../../app.js';
import type { Config } from '../../config/env.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import {
  assertPermission,
  currentActorId,
  holdsPermission,
  type PermissionResolver,
} from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { requireIfMatch } from '../../core/http/concurrency.js';
import { getListQuery } from '../../core/http/list-query.js';
import { sendCreated, sendNoContent, sendOne, sendPage } from '../../core/http/response.js';
import { defineModule } from '../../core/http/route.js';
import { getUpload, multipartUpload } from '../../core/http/upload.js';
import { getValidated } from '../../core/http/validate.js';
import type { Platform } from '../../core/platform.js';
import { ALLOWED_EXTENSIONS } from '../../core/storage/file-types.js';
import { downloadSigner } from '../../core/storage/signed-url.js';
import type { FileStorage } from '../../core/storage/storage.js';
import { DOCUMENT_OWNER_TYPES, DOCUMENT_OWNERS } from './documents.owners.js';
import {
  ContentQuery,
  DocumentOut,
  DownloadOut,
  ExpiringDocumentOut,
  IdParams,
  PatchDocumentBody,
  ReplaceFields,
  UploadFields,
} from './documents.schema.js';
import { documentsService } from './documents.service.js';

/** HTTP surface of document attachments (Spec P4 §6.6). */

export interface DocumentsDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly platform: Platform;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
  readonly storage: FileStorage;
}

const byId = { params: IdParams };
const HistoryQuery = z.object({
  /** true: every version of every document, not only the current ones. */
  history: z.enum(['true', 'false']).optional(),
});
const OWNER_DECIDES =
  'The permission is the owner’s and so depends on the document: {module}.view, .edit or .delete of the ' +
  'record it is attached to (403 PERMISSION_DENIED without it).';
const FILE_RULES =
  `Send multipart/form-data with the file in the field "file". Accepted: ${ALLOWED_EXTENSIONS.join(', ')}. ` +
  'The extension, the declared type and the content must agree (422 with detail code FILE_TYPE_MISMATCH or ' +
  'FILE_TYPE_NOT_ALLOWED); a name carrying a path is refused (FILE_NAME_INVALID).';

/** RFC 6266: an ASCII fallback plus the real name, so a Bengali file name survives the download. */
function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export function documentsModule(deps: DocumentsDeps): ApiModule {
  const { config, db, platform, authz, accessLog, storage, logger } = deps;
  const signer = downloadSigner({
    secret: config.auth.tokenSecret,
    ttlSeconds: config.storage.downloadUrlSeconds,
  });
  const svc = documentsService({ db, storage, signer, accessLog, logger, timezone: config.timezone });
  const upload = multipartUpload({ storage, maxBytes: config.storage.maxUploadBytes });
  const m = defineModule({ name: 'documents', path: '/', tag: 'Documents', platform, authz, accessLog });

  /** The permission of a document is its owner's: resolved from the record, then checked. */
  async function ownerPermission(req: Request, id: bigint, action: 'view' | 'edit' | 'delete') {
    currentActorId(); // 401 before anything is read
    const owner = await svc.ownerOf(id);
    await assertPermission(authz, `${owner.module}.${action}`, req, accessLog);
  }

  // ---- per owner: /{owner}/{id}/documents ----------------------------------------------------------
  for (const owner of DOCUMENT_OWNERS) {
    m.route({
      method: 'get',
      path: `${owner.path}/:id/documents`,
      summary: `List the documents of a ${owner.label}`,
      description:
        'The current version of each document, grouped by type. `history=true` adds the superseded and ' +
        'archived versions.',
      auth: { permission: `${owner.module}.view` },
      ...byId,
      query: HistoryQuery,
      success: { status: 200, description: 'The documents', schema: DocumentOut },
      errors: [],
      handler: async (req, res) => {
        const { params, query } = getValidated(res, { ...byId, query: HistoryQuery });
        const items = await svc.list(owner, params.id, query.history === 'true');
        sendPage(req, res, items, {
          pagination: { page: 1, perPage: Math.max(items.length, 1) },
          total: items.length,
        });
      },
    });

    m.route({
      method: 'post',
      path: `${owner.path}/:id/documents`,
      summary: `Attach a document to a ${owner.label}`,
      description:
        `${FILE_RULES} Each upload is a new document, so a ${owner.label} may hold several of one type; ` +
        'to renew one, replace it instead (POST /documents/{id}/replace).',
      auth: { permission: `${owner.module}.edit` },
      ...byId,
      body: UploadFields,
      multipart: upload,
      success: { status: 201, description: 'Attached', schema: DocumentOut },
      errors: ['SCOPE_DENIED'],
      handler: async (_req, res) => {
        const { params, body } = getValidated(res, { ...byId, body: UploadFields });
        const d = await svc.upload(owner, params.id, body, getUpload(res), currentActorId());
        sendCreated(res, d, `/api/v1/documents/${d.id}`, d.version);
      },
    });
  }

  // ---- across owners ---------------------------------------------------------------------------------
  m.route({
    method: 'get',
    path: '/documents/expiring',
    summary: 'Documents that have expired or expire soon',
    description:
      'Current documents with an expiry date, across every record you may see, soonest first. Without a ' +
      'filter on expiry_date: everything expiring within 30 days, including what has already expired ' +
      '(days_to_expiry is negative). Use filter[expiry_date][from] and [to] for another window.',
    auth: { permission: 'document.view' },
    list: {
      pagination: 'page',
      filters: {
        expiry_date: { type: 'date', ops: ['from', 'to'] },
        owner_type: { type: { enum: DOCUMENT_OWNER_TYPES }, ops: ['eq', 'in'] },
        document_type_id: { type: 'id', ops: ['eq', 'in'] },
      },
      sorts: [],
      maxPageSize: 200,
    },
    success: { status: 200, description: 'A page of expiring documents', schema: ExpiringDocumentOut },
    errors: [],
    handler: async (req, res) => {
      const q = getListQuery(res);
      const { items, total } = await svc.expiring(q, (module) => holdsPermission(authz, `${module}.view`));
      sendPage(req, res, items, { pagination: q.page ?? { page: 1, perPage: 25 }, total });
    },
  });

  m.route({
    method: 'get',
    path: '/documents/:id',
    summary: 'Read a document',
    description: OWNER_DECIDES,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    success: { status: 200, description: 'The document', schema: DocumentOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      await ownerPermission(req, params.id, 'view');
      const d = await svc.get(params.id);
      sendOne(res, d, { version: d.version });
    },
  });

  m.route({
    method: 'get',
    path: '/documents/:id/versions',
    summary: 'Every version of a document',
    description: `Newest first. ${OWNER_DECIDES}`,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    success: { status: 200, description: 'The versions', schema: DocumentOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      await ownerPermission(req, params.id, 'view');
      const items = await svc.versions(params.id);
      sendPage(req, res, items, {
        pagination: { page: 1, perPage: Math.max(items.length, 1) },
        total: items.length,
      });
    },
  });

  m.route({
    method: 'get',
    path: '/documents/:id/download',
    summary: 'Get a download link for a document',
    description:
      `A signed link that works for ${String(config.storage.downloadUrlSeconds)} seconds without an ` +
      `Authorization header: open it or use it as a link target. ${OWNER_DECIDES}`,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    success: { status: 200, description: 'The link', schema: DownloadOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      await ownerPermission(req, params.id, 'view');
      sendOne(res, await svc.downloadLink(params.id));
    },
  });

  m.route({
    method: 'get',
    path: '/documents/:id/content',
    summary: 'Download a document through its signed link',
    description:
      'The target of the link from GET /documents/{id}/download. Do not build this address yourself. ' +
      'An expired or altered link answers 404.',
    auth: {
      public: true,
      reason: 'The signature is the authorisation: it is issued only after the permission and scope checks.',
    },
    ...byId,
    query: ContentQuery,
    success: { status: 200, description: 'The file', binary: true },
    errors: ['SERVICE_UNAVAILABLE'],
    handler: async (_req, res, next) => {
      const { params, query } = getValidated(res, { ...byId, query: ContentQuery });
      const file = await svc.content(params.id, Number(query.expires), query.signature);
      res.status(200);
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', String(file.size));
      res.setHeader('Content-Disposition', contentDisposition(file.fileName));
      // Never rendered in place and never cached by a shared cache: the link is the credential.
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      file.stream.on('error', (err) => {
        if (res.headersSent) res.destroy(err);
        else next(err);
      });
      file.stream.pipe(res);
    },
  });

  m.route({
    method: 'post',
    path: '/documents/:id/replace',
    summary: 'Replace a document with a new version',
    description:
      `${FILE_RULES} The previous version is kept (status superseded) and stays downloadable. The new ` +
      'version carries its own issue and expiry dates; the title is kept unless you send one. An identical ' +
      `file is refused (FILE_UNCHANGED). ${OWNER_DECIDES}`,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    body: ReplaceFields,
    multipart: upload,
    ifMatch: true,
    before: [
      // The upload parser runs before the handler, so the owner's permission is checked here, first.
      (req, _res, next) => {
        const parsed = IdParams.safeParse(req.params);
        if (!parsed.success) {
          next();
          return;
        }
        ownerPermission(req, parsed.data.id, 'edit').then(() => {
          next();
        }, next);
      },
    ],
    success: { status: 201, description: 'The new version', schema: DocumentOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED', 'SCOPE_DENIED', 'INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: ReplaceFields });
      const d = await svc.replace(params.id, requireIfMatch(req), body, getUpload(res), currentActorId());
      sendCreated(res, d, `/api/v1/documents/${d.id}`, d.version);
    },
  });

  m.route({
    method: 'patch',
    path: '/documents/:id',
    summary: 'Correct a document’s title or dates',
    description: `The current version only. The file itself is never edited: replace it instead. ${OWNER_DECIDES}`,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    body: PatchDocumentBody,
    ifMatch: true,
    success: { status: 200, description: 'Updated', schema: DocumentOut },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED', 'SCOPE_DENIED', 'INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params, body } = getValidated(res, { ...byId, body: PatchDocumentBody });
      await ownerPermission(req, params.id, 'edit');
      const d = await svc.update(params.id, requireIfMatch(req), body, currentActorId());
      sendOne(res, d, { version: d.version });
    },
  });

  m.route({
    method: 'delete',
    path: '/documents/:id',
    summary: 'Remove a document',
    description:
      'Marks the current version archived: it leaves the lists and the expiry alerts, and nothing is ' +
      `erased (the record and the file are retained). ${OWNER_DECIDES}`,
    auth: { signedIn: true, reason: 'The owner of the document decides the permission.' },
    ...byId,
    success: { status: 204, description: 'Removed' },
    errors: ['PERMISSION_DENIED', 'PASSWORD_CHANGE_REQUIRED', 'SCOPE_DENIED', 'INVALID_TRANSITION'],
    handler: async (req, res) => {
      const { params } = getValidated(res, byId);
      await ownerPermission(req, params.id, 'delete');
      await svc.archive(params.id, currentActorId());
      sendNoContent(res);
    },
  });

  return m.build();
}
