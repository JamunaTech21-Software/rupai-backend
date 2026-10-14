import type { Readable } from 'node:stream';

import type { Logger } from 'pino';
import type { z } from 'zod';

import type { AccessLog } from '../../core/audit/access-log.js';
import { auditCreate, auditUpdate, recordStatusChange, type AuditedRecord } from '../../core/audit/audit.js';
import { toWhere, type ListFieldMap } from '../../core/db/list.js';
import type { Database } from '../../core/db/prisma.js';
import { lockRowsForUpdate, withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Upload } from '../../core/http/upload.js';
import { checkFileName, identifyFile } from '../../core/storage/file-types.js';
import type { DownloadSigner } from '../../core/storage/signed-url.js';
import type { FileStorage } from '../../core/storage/storage.js';
import {
  addDays,
  businessDateFromDb,
  businessDateToDb,
  diffDays,
  parseBusinessDate,
  todayIn,
} from '../../core/time/dates.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { day, denyWrite, iso } from '../organisation/common.js';
import { DOCUMENT_OWNERS, documentOwner, type DocumentOwner } from './documents.owners.js';
import type {
  DocumentOut,
  DocumentStatus,
  DownloadOut,
  ExpiringDocumentOut,
  PatchDocumentBody,
  ReplaceFields,
  UploadFields,
} from './documents.schema.js';

/**
 * Document attachments (Spec P3 §28.4, P2 §6.2, P4 §6.6).
 *
 *   - One implementation behind every "attachments panel": the owner is polymorphic, and decides who
 *     may see and change its documents (documents.owners.ts).
 *   - Nothing is ever deleted. Replacing a file adds a version and marks the previous one superseded;
 *     removing a document marks it archived. The file stays in storage either way.
 *   - An owner may hold several documents of one type (two licences, five agreements). Each is a SERIES
 *     (series_no) with its own versions; exactly one version of a series is current, which the database
 *     guarantees through the generated current_key.
 *   - The file is checked before it is kept: extension, declared type and content must agree
 *     (core/storage/file-types.ts). It is stored under a generated key; the uploaded name is metadata.
 *   - Downloads go through a short-lived signed link, never a path.
 */

type DocumentOutT = z.infer<typeof DocumentOut>;
type ExpiringOutT = z.infer<typeof ExpiringDocumentOut>;
type DownloadOutT = z.infer<typeof DownloadOut>;

const include = {
  documentType: { select: { id: true, code: true, name: true } },
  uploader: { select: { username: true } },
} satisfies Prisma.DocumentFileInclude;
type Row = Prisma.DocumentFileGetPayload<{ include: typeof include }>;

export const DOCUMENT_AUDIT: AuditedRecord = {
  type: 'document_file',
  class: 'master',
  fields: [
    'owner_type',
    'owner_id',
    'document_type_id',
    'series_no',
    'title',
    'file_name',
    'mime_type',
    'file_size_bytes',
    'checksum',
    'version_number',
    'issue_date',
    'expiry_date',
    'is_current',
    'status',
  ],
};

/** Filters of the expiring-documents list. */
export const EXPIRING_LIST_FIELDS: ListFieldMap = {
  expiry_date: { field: 'expiryDate', convert: (v) => businessDateToDb(parseBusinessDate(String(v))) },
  owner_type: { field: 'ownerType' },
  document_type_id: { field: 'documentTypeId', convert: (v) => BigInt(v) },
};

/** The expiring list is filtered by owner scope in the application, so the candidate set is bounded. */
const EXPIRING_SCAN_LIMIT = 5000;
const DEFAULT_EXPIRY_WINDOW_DAYS = 30;

const invalid = (field: string, message: string, code = 'VALIDATION_FAILED') =>
  Errors.validation([{ field, code, message }]);
const notCurrent = (what: string) =>
  new AppError('INVALID_TRANSITION', `Only the current version of a document can be ${what}.`, [
    { code: 'INVALID_TRANSITION', message: 'Open the current version of this document.' },
  ]);

export interface DocumentsDeps {
  readonly db: Database;
  readonly storage: FileStorage;
  readonly signer: DownloadSigner;
  readonly accessLog: AccessLog;
  readonly logger: Logger;
  readonly timezone: string;
}

export function documentsService({ db, storage, signer, accessLog, logger, timezone }: DocumentsDeps) {
  const today = () => todayIn(timezone);

  function toOut(d: Row): DocumentOutT {
    const expiry = d.expiryDate ? businessDateFromDb(d.expiryDate) : null;
    return {
      id: d.id.toString(),
      owner_type: d.ownerType,
      owner_id: d.ownerId.toString(),
      document_type_id: d.documentTypeId.toString(),
      document_type: {
        id: d.documentType.id.toString(),
        code: d.documentType.code,
        name: d.documentType.name,
      },
      series_no: d.seriesNo,
      title: d.title,
      file_name: d.fileName,
      mime_type: d.mimeType,
      file_size_bytes: d.fileSizeBytes,
      checksum: d.checksum,
      version_number: d.version,
      issue_date: day(d.issueDate),
      expiry_date: expiry,
      days_to_expiry: expiry ? diffDays(today(), expiry) : null,
      is_current: d.isCurrent,
      status: d.status as DocumentStatus,
      uploaded_by: d.uploadedBy.toString(),
      uploaded_by_name: d.uploader.username,
      version: d.rowVersion,
      created_at: d.createdAt.toISOString(),
      updated_at: iso(d.updatedAt),
    };
  }

  async function ownerOrNotFound(tx: Database | Tx, owner: DocumentOwner, ownerId: bigint): Promise<void> {
    if (!(await owner.find(tx, [ownerId])).has(ownerId)) throw Errors.notFound(`No such ${owner.label}.`);
  }

  /** The document and its owner, or 404 when either is missing or the owner is out of scope. */
  async function load(tx: Database | Tx, id: bigint): Promise<{ doc: Row; owner: DocumentOwner }> {
    const doc = await tx.documentFile.findUnique({ where: { id }, include });
    const owner = doc ? documentOwner(doc.ownerType) : undefined;
    if (!doc || !owner || !(await owner.find(tx, [doc.ownerId])).has(doc.ownerId)) {
      throw Errors.notFound('No such document.');
    }
    return { doc, owner };
  }

  async function assertWritable(tx: Database | Tx, owner: DocumentOwner, ownerId: bigint, op: string) {
    if (!(await owner.writable(tx, ownerId))) await denyWrite(accessLog, owner.module, ownerId, op);
  }

  /** Checks the uploaded file and names what it is. Nothing is kept yet. */
  function inspect(upload: Upload) {
    const fileName = checkFileName(upload.fileName);
    if (upload.temp.size === 0) throw invalid('file', 'The file is empty.', 'FILE_EMPTY');
    const type = identifyFile(fileName, upload.declaredMime, upload.temp.head);
    return { fileName, type };
  }

  /** Keeps the file, runs the database work, and takes the file back out if that work fails. */
  async function withStoredFile<T>(upload: Upload, work: (storedPath: string) => Promise<T>): Promise<T> {
    const storedPath = await storage.promote(upload.temp.key, 'documents');
    try {
      return await work(storedPath);
    } catch (err) {
      await storage.remove(storedPath).catch((cause: unknown) => {
        logger.error({ err: cause, storedPath }, 'could not remove the file of a failed upload');
      });
      throw err;
    }
  }

  return {
    /** The module whose permissions guard a document: resolved before the permission check. */
    async ownerOf(id: bigint): Promise<DocumentOwner> {
      const doc = await db.documentFile.findUnique({ where: { id }, select: { ownerType: true } });
      const owner = doc ? documentOwner(doc.ownerType) : undefined;
      if (!owner) throw Errors.notFound('No such document.');
      return owner;
    },

    /** An owner's documents: the current version of each, or every version with `history`. */
    async list(owner: DocumentOwner, ownerId: bigint, history: boolean): Promise<DocumentOutT[]> {
      await ownerOrNotFound(db, owner, ownerId);
      const rows = await db.documentFile.findMany({
        where: { ownerType: owner.type, ownerId, ...(history ? {} : { isCurrent: true }) },
        include,
        orderBy: [
          { documentType: { sortOrder: 'asc' } },
          { documentTypeId: 'asc' },
          { seriesNo: 'asc' },
          { version: 'desc' },
        ],
      });
      return rows.map(toOut);
    },

    async get(id: bigint): Promise<DocumentOutT> {
      return toOut((await load(db, id)).doc);
    },

    /** Every version of the document this row belongs to, newest first. */
    async versions(id: bigint): Promise<DocumentOutT[]> {
      const { doc } = await load(db, id);
      const rows = await db.documentFile.findMany({
        where: {
          ownerType: doc.ownerType,
          ownerId: doc.ownerId,
          documentTypeId: doc.documentTypeId,
          seriesNo: doc.seriesNo,
        },
        include,
        orderBy: { version: 'desc' },
      });
      return rows.map(toOut);
    },

    /** A new document of the owner: a new series at version 1. */
    async upload(
      owner: DocumentOwner,
      ownerId: bigint,
      fields: z.infer<typeof UploadFields>,
      upload: Upload,
      actorId: bigint,
    ): Promise<DocumentOutT> {
      const { fileName, type } = inspect(upload);
      await ownerOrNotFound(db, owner, ownerId);
      await assertWritable(db, owner, ownerId, 'document-upload');
      const documentTypeId = fields.document_type_id;

      return withStoredFile(upload, (storedPath) =>
        withTransaction(db, async (tx) => {
          // The type row is the lock that numbers the series: two uploads cannot take the same number.
          const [docType] = await lockRowsForUpdate<{ status: string }>(tx, 'document_type', {
            id: documentTypeId,
          });
          if (!docType) throw invalid('document_type_id', 'No such document type.');
          if (docType.status !== 'active')
            throw invalid('document_type_id', 'The document type is inactive.');
          const last = await tx.documentFile.aggregate({
            where: { ownerType: owner.type, ownerId, documentTypeId },
            _max: { seriesNo: true },
          });
          const created = await tx.documentFile.create({
            data: {
              ownerType: owner.type,
              ownerId,
              documentTypeId,
              seriesNo: (last._max.seriesNo ?? 0) + 1,
              title: fields.title ?? null,
              fileName,
              storedPath,
              mimeType: type.mime,
              fileSizeBytes: upload.temp.size,
              checksum: upload.temp.sha256,
              version: 1,
              issueDate: fields.issue_date ? businessDateToDb(fields.issue_date) : null,
              expiryDate: fields.expiry_date ? businessDateToDb(fields.expiry_date) : null,
              uploadedBy: actorId,
              createdBy: actorId,
            },
            include,
          });
          const out = toOut(created);
          await auditCreate(tx, DOCUMENT_AUDIT, created.id, out, { actorId });
          await recordStatusChange(tx, DOCUMENT_AUDIT.type, created.id, null, 'active', { actorId });
          return out;
        }),
      );
    },

    /** A new version of a document. The previous version is kept, marked superseded. */
    async replace(
      id: bigint,
      expectedVersion: number,
      fields: z.infer<typeof ReplaceFields>,
      upload: Upload,
      actorId: bigint,
    ): Promise<DocumentOutT> {
      const { fileName, type } = inspect(upload);
      const { doc: seen, owner } = await load(db, id);
      await assertWritable(db, owner, seen.ownerId, 'document-replace');

      return withStoredFile(upload, (storedPath) =>
        withTransaction(db, async (tx) => {
          await lockRowsForUpdate(tx, 'document_file', { id });
          const { doc: before } = await load(tx, id);
          if (!before.isCurrent) throw notCurrent('replaced');
          if (before.rowVersion !== expectedVersion) {
            throw Errors.versionConflict({ version: before.rowVersion, resource: toOut(before) });
          }
          if (before.checksum === upload.temp.sha256) {
            throw invalid('file', 'This is the same file as the current version.', 'FILE_UNCHANGED');
          }
          // Supersede first: the unique current_key may never be held by two versions.
          const superseded = await tx.documentFile.update({
            where: { id },
            data: {
              isCurrent: false,
              status: 'superseded',
              rowVersion: { increment: 1 },
              updatedAt: new Date(),
              updatedBy: actorId,
            },
            include,
          });
          await auditUpdate(tx, DOCUMENT_AUDIT, id, toOut(before), toOut(superseded), { actorId });
          await recordStatusChange(tx, DOCUMENT_AUDIT.type, id, 'active', 'superseded', { actorId });

          const created = await tx.documentFile.create({
            data: {
              ownerType: before.ownerType,
              ownerId: before.ownerId,
              documentTypeId: before.documentTypeId,
              seriesNo: before.seriesNo,
              title: fields.title ?? before.title,
              fileName,
              storedPath,
              mimeType: type.mime,
              fileSizeBytes: upload.temp.size,
              checksum: upload.temp.sha256,
              version: before.version + 1,
              // A renewed document has its own dates: the previous ones are not carried over.
              issueDate: fields.issue_date ? businessDateToDb(fields.issue_date) : null,
              expiryDate: fields.expiry_date ? businessDateToDb(fields.expiry_date) : null,
              uploadedBy: actorId,
              createdBy: actorId,
            },
            include,
          });
          const out = toOut(created);
          await auditCreate(tx, DOCUMENT_AUDIT, created.id, out, { actorId });
          await recordStatusChange(tx, DOCUMENT_AUDIT.type, created.id, null, 'active', {
            actorId,
            comment: `Replaces version ${String(before.version)}`,
          });
          return out;
        }),
      );
    },

    /** Corrects the title or dates of the current version. The file itself is never edited. */
    async update(
      id: bigint,
      expectedVersion: number,
      changes: z.infer<typeof PatchDocumentBody>,
      actorId: bigint,
    ): Promise<DocumentOutT> {
      return withTransaction(db, async (tx) => {
        const { doc: before, owner } = await load(tx, id);
        await assertWritable(tx, owner, before.ownerId, 'document-update');
        if (!before.isCurrent) throw notCurrent('changed');
        const issue = changes.issue_date !== undefined ? changes.issue_date : day(before.issueDate);
        const expiry = changes.expiry_date !== undefined ? changes.expiry_date : day(before.expiryDate);
        if (issue && expiry && expiry < issue) {
          throw invalid('expiry_date', 'Must not be before the issue date.');
        }
        const { count } = await tx.documentFile.updateMany({
          where: { id, rowVersion: expectedVersion },
          data: {
            ...(changes.title !== undefined ? { title: changes.title } : {}),
            ...(changes.issue_date !== undefined
              ? { issueDate: changes.issue_date ? businessDateToDb(changes.issue_date) : null }
              : {}),
            ...(changes.expiry_date !== undefined
              ? { expiryDate: changes.expiry_date ? businessDateToDb(changes.expiry_date) : null }
              : {}),
            rowVersion: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
        });
        if (count !== 1)
          throw Errors.versionConflict({ version: before.rowVersion, resource: toOut(before) });
        const { doc: after } = await load(tx, id);
        await auditUpdate(tx, DOCUMENT_AUDIT, id, toOut(before), toOut(after), { actorId });
        return toOut(after);
      });
    },

    /** Removes a document from use (P4 §6.6: the row and the file are retained). */
    async archive(id: bigint, actorId: bigint): Promise<void> {
      await withTransaction(db, async (tx) => {
        await lockRowsForUpdate(tx, 'document_file', { id });
        const { doc: before, owner } = await load(tx, id);
        await assertWritable(tx, owner, before.ownerId, 'document-delete');
        if (!before.isCurrent) throw notCurrent('removed');
        const after = await tx.documentFile.update({
          where: { id },
          data: {
            isCurrent: false,
            status: 'archived',
            rowVersion: { increment: 1 },
            updatedAt: new Date(),
            updatedBy: actorId,
          },
          include,
        });
        await auditUpdate(tx, DOCUMENT_AUDIT, id, toOut(before), toOut(after), { actorId });
        await recordStatusChange(tx, DOCUMENT_AUDIT.type, id, 'active', 'archived', { actorId });
      });
    },

    /** A signed link to the file, valid for a few minutes. Any version may be downloaded. */
    async downloadLink(id: bigint): Promise<DownloadOutT> {
      const { doc } = await load(db, id);
      const { expires, signature } = signer.sign(doc.id);
      return {
        url: `/api/v1/documents/${doc.id.toString()}/content?expires=${String(expires)}&signature=${signature}`,
        expires_at: new Date(expires * 1000).toISOString(),
        file_name: doc.fileName,
        mime_type: doc.mimeType,
        file_size_bytes: doc.fileSizeBytes,
      };
    },

    /**
     * The file behind a signed link. The signature is the authorisation (it was issued to a caller who
     * passed the permission and scope checks), so no user is needed here.
     */
    async content(
      id: bigint,
      expires: number,
      signature: string,
    ): Promise<{ stream: Readable; size: number; fileName: string; mimeType: string }> {
      const linkProblem = new AppError(
        'NOT_FOUND',
        'This download link is not valid or has expired. Request a new one.',
      );
      if (signer.verify(id, expires, signature) !== 'ok') throw linkProblem;
      const doc = await db.documentFile.findUnique({
        where: { id },
        select: { storedPath: true, fileName: true, mimeType: true },
      });
      if (!doc) throw linkProblem;
      try {
        const file = await storage.open(doc.storedPath);
        return { ...file, fileName: doc.fileName, mimeType: doc.mimeType };
      } catch (err) {
        // The row exists and the file does not: a storage fault, not a client error.
        logger.error({ err, documentId: id.toString() }, 'a stored document file is missing');
        throw new AppError('SERVICE_UNAVAILABLE', 'The file cannot be read at the moment.');
      }
    },

    /**
     * Current documents that have expired or expire soon, across every owner the caller may see
     * (P4 §6.6, for the expiry dashboard). Without a filter on expiry_date: everything expiring within
     * 30 days, including what has already expired.
     */
    async expiring(
      q: ListQuery,
      canView: (module: string) => Promise<boolean>,
    ): Promise<{ items: ExpiringOutT[]; total: number }> {
      const bounded = q.filters.some((f) => f.field === 'expiry_date');
      const where: Prisma.DocumentFileWhereInput = {
        AND: [
          toWhere(q, EXPIRING_LIST_FIELDS),
          { isCurrent: true, expiryDate: { not: null } },
          ...(bounded
            ? []
            : [{ expiryDate: { lte: businessDateToDb(addDays(today(), DEFAULT_EXPIRY_WINDOW_DAYS)) } }]),
        ],
      };
      const rows = await db.documentFile.findMany({
        where,
        include,
        orderBy: [{ expiryDate: 'asc' }, { id: 'asc' }],
        take: EXPIRING_SCAN_LIMIT,
      });

      // The owner decides visibility: per owner type, keep the rows whose owner the caller may see.
      const labels = new Map<string, Map<bigint, string>>();
      for (const owner of DOCUMENT_OWNERS) {
        const ids = [...new Set(rows.filter((r) => r.ownerType === owner.type).map((r) => r.ownerId))];
        if (ids.length === 0 || !(await canView(owner.module))) continue;
        labels.set(owner.type, await owner.find(db, ids));
      }
      const visible = rows.flatMap((r) => {
        const label = labels.get(r.ownerType)?.get(r.ownerId);
        return label === undefined ? [] : [{ ...toOut(r), owner_label: label }];
      });
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      return { items: visible.slice((page - 1) * perPage, page * perPage), total: visible.length };
    },
  };
}

/**
 * Inside an owner's own deletion: its documents are archived, not removed. The rows and files stay, for
 * the audit trail, though nothing lists them any more.
 */
export async function archiveDocumentsOf(
  tx: Tx,
  ownerType: string,
  ownerId: bigint,
  actorId: bigint,
): Promise<void> {
  const current = await tx.documentFile.findMany({
    where: { ownerType, ownerId, isCurrent: true },
    select: { id: true },
  });
  for (const { id } of current) {
    await tx.documentFile.update({
      where: { id },
      data: {
        isCurrent: false,
        status: 'archived',
        rowVersion: { increment: 1 },
        updatedAt: new Date(),
        updatedBy: actorId,
      },
    });
    await auditUpdate(
      tx,
      DOCUMENT_AUDIT,
      id,
      { is_current: true, status: 'active' },
      { is_current: false, status: 'archived' },
      { actorId, reason: `The ${ownerType} was deleted.` },
    );
    await recordStatusChange(tx, DOCUMENT_AUDIT.type, id, 'active', 'archived', {
      actorId,
      comment: `The ${ownerType} was deleted.`,
    });
  }
}

export type DocumentsService = ReturnType<typeof documentsService>;
