import type { z } from 'zod';

import { auditCreate, recordStatusChange, type AuditedRecord } from '../../core/audit/audit.js';
import type { AccessLog } from '../../core/audit/access-log.js';
import { assertPermission, holdsPermission, type PermissionResolver } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction, type Tx } from '../../core/db/transaction.js';
import { AppError, Errors } from '../../core/errors/app-error.js';
import type { ListQuery } from '../../core/http/list-query.js';
import type { Upload } from '../../core/http/upload.js';
import { importType, importTypes, type ImportType, type RowError } from '../../core/imports/registry.js';
import { writeSheets, type SheetFormat } from '../../core/imports/sheets.js';
import type { JobQueue } from '../../core/jobs/queue.js';
import { createJob, wholeSecond } from '../../core/jobs/store.js';
import { checkFileName } from '../../core/storage/file-types.js';
import type { FileStorage } from '../../core/storage/storage.js';
import type { ImportBatch, Job, Prisma } from '../../generated/prisma/client.js';
import { toJobOut } from '../jobs/jobs.service.js';
import type { BatchOut, ErrorLineOut, ImportTypeOut, RowOut } from './imports.schema.js';

/**
 * The import lifecycle (Spec P4 §6.7, P5 §7.6): template → upload (a batch, validated by a job) → error
 * report → correct and upload again (a new batch) → commit (a job: valid rows only) → result. The batch
 * and its staging rows are kept after commit (P3 §32.5), so an import can be audited.
 *
 * Permissions are the import type's module: .create to upload, commit and cancel, .view (or having
 * uploaded it) to read a batch. A batch the caller may not read is 404.
 */

type BatchOutT = z.infer<typeof BatchOut>;
type JobRow = Job & { requester: { id: bigint; username: string } | null };
type BatchRow = ImportBatch & {
  creator: { id: bigint; username: string };
  validateJob: JobRow | null;
  commitJob: JobRow | null;
};

export const VALIDATE_JOB = 'import.validate';
export const COMMIT_JOB = 'import.commit';
export const IMPORT_AUDIT: AuditedRecord = {
  type: 'import_batch',
  class: 'operational',
  fields: ['import_type', 'file_name', 'state', 'row_count', 'valid_count', 'error_count', 'committed_count'],
};

const jobInclude = { requester: { select: { id: true, username: true } } } as const;
export const batchInclude = {
  creator: { select: { id: true, username: true } },
  validateJob: { include: jobInclude },
  commitJob: { include: jobInclude },
} as const satisfies Prisma.ImportBatchInclude;

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const live = (j: JobRow | null) => (j && (j.state === 'queued' || j.state === 'running') ? j : null);

export function toBatchOut(b: BatchRow): BatchOutT {
  const t = importType(b.importType);
  const current = live(b.commitJob) ?? live(b.validateJob);
  return {
    id: b.id.toString(),
    import_type: b.importType,
    label: t?.label ?? b.importType,
    state: b.state as BatchOutT['state'],
    file_name: b.fileName,
    file_format: b.fileFormat as BatchOutT['file_format'],
    row_count: b.rowCount,
    valid_count: b.validCount,
    error_count: b.errorCount,
    committed_count: b.committedCount,
    failed_count: b.failedCount,
    problems: (b.problems as { code: string; message: string }[] | null) ?? [],
    can_commit: b.state === 'validated' && b.validCount > 0,
    can_cancel: b.state === 'validated' || b.state === 'rejected',
    job: current ? toJobOut(current) : null,
    validate_job_id: b.validateJobId?.toString() ?? null,
    commit_job_id: b.commitJobId?.toString() ?? null,
    created_by: { id: b.creator.id.toString(), username: b.creator.username },
    created_at: b.createdAt.toISOString(),
    validated_at: iso(b.validatedAt),
    committed_at: iso(b.committedAt),
    cancelled_at: iso(b.cancelledAt),
    version: b.version,
  };
}

export function toTypeOut(t: ImportType): z.infer<typeof ImportTypeOut> {
  return {
    key: t.key,
    label: t.label,
    permission: t.permission,
    max_rows: t.maxRows,
    columns: [...t.columns],
  };
}

/** The file format, from the name and the first bytes: an .xlsx is a zip (PK), a .csv is text. */
function formatOf(name: string, head: Buffer): SheetFormat {
  const lower = name.toLowerCase();
  const refuse = (message: string) =>
    Errors.validation([{ field: 'file', code: 'FILE_TYPE_NOT_ALLOWED', message }]);
  if (lower.endsWith('.xlsx')) {
    if (head.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return 'xlsx';
    throw refuse('The file is named .xlsx but is not an Excel workbook.');
  }
  if (lower.endsWith('.csv')) {
    if (head.includes(0)) throw refuse('The file is named .csv but is not text.');
    return 'csv';
  }
  throw refuse('Send the template filled in, as .xlsx or .csv.');
}

const transition = (from: string, action: string) =>
  new AppError('INVALID_TRANSITION', `A batch that is ${from} cannot be ${action}.`, [
    { code: 'INVALID_TRANSITION', message: `Not allowed while ${from}.`, context: { state: from } },
  ]);

export interface ImportsServiceDeps {
  readonly db: Database;
  readonly storage: FileStorage;
  readonly queue: JobQueue;
  readonly authz: PermissionResolver;
  readonly accessLog: AccessLog;
}

export function importsService({ db, storage, queue, authz, accessLog }: ImportsServiceDeps) {
  function typeOrNotFound(key: string): ImportType {
    const t = importType(key);
    if (!t) throw Errors.notFound('No such import type.');
    return t;
  }
  const request = (method: string, url: string) => ({ method, originalUrl: url });

  async function batchRow(tx: Database | Tx, id: bigint): Promise<BatchRow | null> {
    return tx.importBatch.findUnique({ where: { id }, include: batchInclude });
  }

  async function reload(id: bigint): Promise<BatchRow> {
    const b = await batchRow(db, id);
    if (!b) throw Errors.notFound('No such import.');
    return b;
  }

  /** Readable by whoever uploaded it, and by holders of the type's .view. */
  async function readable(id: bigint, actorId: bigint): Promise<BatchRow> {
    const b = await batchRow(db, id);
    const t = b ? importType(b.importType) : undefined;
    if (!b || !t || (b.createdBy !== actorId && !(await holdsPermission(authz, `${t.permission}.view`)))) {
      throw Errors.notFound('No such import.');
    }
    return b;
  }

  async function startJob(type: string, batchId: bigint, purpose: string, actorId: bigint) {
    const { job, created } = await withTransaction(db, async (tx) => {
      const made = await createJob(tx, {
        type,
        payload: { batch_id: batchId.toString() },
        dedupeKey: `import_batch:${batchId.toString()}:${purpose}`,
        requestedBy: actorId,
      });
      await tx.importBatch.update({
        where: { id: batchId },
        data: purpose === 'validate' ? { validateJobId: made.job.id } : { commitJobId: made.job.id },
      });
      return made;
    });
    if (created) await queue.dispatch(job.id);
  }

  return {
    /** The import types the caller may use (holds .create). */
    async types(): Promise<z.infer<typeof ImportTypeOut>[]> {
      const out = [];
      for (const t of importTypes()) {
        if (await holdsPermission(authz, `${t.permission}.create`)) out.push(toTypeOut(t));
      }
      return out;
    },

    async type(key: string, url: string) {
      const t = typeOrNotFound(key);
      await assertPermission(authz, `${t.permission}.create`, request('GET', url), accessLog);
      return toTypeOut(t);
    },

    /**
     * The template: the columns as the header row, an example row, and (xlsx) an Instructions sheet.
     * Codes and numbers are text cells, so "007" stays "007".
     */
    async template(
      key: string,
      format: SheetFormat,
      url: string,
    ): Promise<{ body: Buffer; fileName: string }> {
      const t = typeOrNotFound(key);
      await assertPermission(authz, `${t.permission}.create`, request('GET', url), accessLog);
      const header = t.columns.map((c) => c.name);
      const body = await writeSheets(
        [
          { name: 'Data', header, rows: [] },
          {
            name: 'Instructions',
            header: ['column', 'required', 'what to write', 'example'],
            rows: [
              ...t.columns.map((c) => [c.name, c.required ? 'yes' : 'no', c.description, c.example]),
              [],
              ['', '', 'Fill the Data sheet from row 2. Keep the header row as it is.', ''],
              [
                '',
                '',
                `At most ${String(t.maxRows)} rows. Rows with errors are listed after upload; only valid rows are imported.`,
                '',
              ],
            ],
          },
        ],
        format,
      );
      return { body, fileName: `${t.key.replace('.', '-')}-template.${format}` };
    },

    /** POST /imports/{type}: stores the file, opens a batch and starts its validation job. */
    async upload(key: string, upload: Upload, actorId: bigint, url: string): Promise<BatchOutT> {
      const t = typeOrNotFound(key);
      await assertPermission(authz, `${t.permission}.create`, request('POST', url), accessLog);
      const fileName = checkFileName(upload.fileName);
      const format = formatOf(fileName, upload.temp.head);
      const fileKey = await storage.promote(upload.temp.key, 'imports');
      const id = await withTransaction(db, async (tx) => {
        const b = await tx.importBatch.create({
          data: {
            importType: t.key,
            state: 'validating',
            fileName,
            fileFormat: format,
            fileKey,
            fileSha256: upload.temp.sha256,
            fileSize: upload.temp.size,
            createdBy: actorId,
          },
          include: batchInclude,
        });
        await auditCreate(tx, IMPORT_AUDIT, b.id, toBatchOut(b), { actorId });
        await recordStatusChange(tx, IMPORT_AUDIT.type, b.id, null, 'validating', { actorId });
        return b.id;
      }).catch(async (err: unknown) => {
        await storage.remove(fileKey).catch(() => undefined);
        throw err;
      });
      await startJob(VALIDATE_JOB, id, 'validate', actorId);
      return toBatchOut(await reload(id));
    },

    async list(q: ListQuery, actorId: bigint): Promise<{ items: BatchOutT[]; total: number }> {
      // Types whose batches the caller may read in full; otherwise their own.
      const viewable: string[] = [];
      for (const t of importTypes())
        if (await holdsPermission(authz, `${t.permission}.view`)) viewable.push(t.key);
      const pick = (field: string) =>
        q.filters
          .filter((f) => f.field === field)
          .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      const types = pick('import_type');
      const states = pick('state');
      const where: Prisma.ImportBatchWhereInput = {
        AND: [
          { OR: [{ createdBy: actorId }, { importType: { in: viewable } }] },
          types.length ? { importType: { in: types } } : {},
          states.length ? { state: { in: states } } : {},
        ],
      };
      const { page, perPage } = q.page ?? { page: 1, perPage: 25 };
      const [rows, total] = await Promise.all([
        db.importBatch.findMany({
          where,
          include: batchInclude,
          orderBy: { id: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        db.importBatch.count({ where }),
      ]);
      return { items: rows.map(toBatchOut), total };
    },

    async get(id: bigint, actorId: bigint): Promise<BatchOutT> {
      return toBatchOut(await readable(id, actorId));
    },

    async rows(id: bigint, actorId: bigint, q: ListQuery) {
      await readable(id, actorId);
      const states = q.filters
        .filter((f) => f.field === 'state')
        .flatMap((f) => (Array.isArray(f.value) ? f.value.map(String) : [String(f.value)]));
      const where: Prisma.ImportRowWhereInput = {
        importBatchId: id,
        ...(states.length ? { state: { in: states } } : {}),
      };
      const { page, perPage } = q.page ?? { page: 1, perPage: 50 };
      const [rows, total] = await Promise.all([
        db.importRow.findMany({
          where,
          orderBy: { rowNumber: 'asc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
        db.importRow.count({ where }),
      ]);
      const items: z.infer<typeof RowOut>[] = rows.map((r) => ({
        row_number: r.rowNumber,
        state: r.state as z.infer<typeof RowOut>['state'],
        data: r.data as Record<string, string>,
        errors: (r.errors as RowError[] | null) ?? [],
        target_id: r.targetId,
      }));
      return { items, total };
    },

    /** The error report: one line per error (row, column, code, message), the rows invalid or failed. */
    async errorLines(id: bigint, actorId: bigint): Promise<z.infer<typeof ErrorLineOut>[]> {
      await readable(id, actorId);
      const rows = await db.importRow.findMany({
        where: { importBatchId: id, state: { in: ['invalid', 'failed'] } },
        orderBy: { rowNumber: 'asc' },
      });
      return rows.flatMap((r) =>
        ((r.errors as RowError[] | null) ?? []).map((e) => ({
          row_number: r.rowNumber,
          column: e.column,
          code: e.code,
          message: e.message,
        })),
      );
    },

    /**
     * The error report as a file: row, column, code, message, then the row as it was read, so the user
     * corrects in the file and uploads it again (a new batch).
     */
    async errorFile(
      id: bigint,
      actorId: bigint,
      format: SheetFormat,
    ): Promise<{ body: Buffer; fileName: string }> {
      const b = await readable(id, actorId);
      const t = importType(b.importType);
      const columns = t?.columns.map((c) => c.name) ?? [];
      const rows = await db.importRow.findMany({
        where: { importBatchId: id, state: { in: ['invalid', 'failed'] } },
        orderBy: { rowNumber: 'asc' },
      });
      const lines = rows.flatMap((r) => {
        const data = r.data as Record<string, string>;
        return ((r.errors as RowError[] | null) ?? []).map((e) => [
          String(r.rowNumber),
          e.column ?? '',
          e.code,
          e.message,
          ...columns.map((c) => data[c] ?? ''),
        ]);
      });
      const body = await writeSheets(
        [{ name: 'Errors', header: ['row', 'column', 'code', 'message', ...columns], rows: lines }],
        format,
      );
      return { body, fileName: `import-${id.toString()}-errors.${format}` };
    },

    /** POST /imports/{batch}/commit: valid rows only, by a job. */
    async commit(id: bigint, actorId: bigint, url: string): Promise<BatchOutT> {
      const b = await readable(id, actorId);
      const t = typeOrNotFound(b.importType);
      await assertPermission(authz, `${t.permission}.create`, request('POST', url), accessLog);
      if (b.state !== 'validated') throw transition(b.state, 'committed');
      if (b.validCount === 0) {
        throw new AppError('VALIDATION_FAILED', 'No row is valid: correct the file and upload it again.', [
          { code: 'VALIDATION_FAILED', message: 'Nothing to commit.' },
        ]);
      }
      await t.authoriseCommit?.({
        db,
        batchId: id,
        uploadedBy: b.createdBy,
        actorId,
        holds: (permission) => holdsPermission(authz, permission),
      });
      await withTransaction(db, async (tx) => {
        const { count } = await tx.importBatch.updateMany({
          where: { id, state: 'validated' },
          data: {
            state: 'committing',
            version: { increment: 1 },
            updatedAt: wholeSecond(),
            updatedBy: actorId,
          },
        });
        if (count !== 1) throw transition('no longer validated', 'committed');
        await recordStatusChange(tx, IMPORT_AUDIT.type, id, 'validated', 'committing', { actorId });
      });
      await startJob(COMMIT_JOB, id, 'commit', actorId);
      return toBatchOut(await reload(id));
    },

    /** POST /imports/{batch}/cancel: discards the staging rows and the file; the batch stays as a record. */
    async cancel(id: bigint, actorId: bigint, url: string): Promise<BatchOutT> {
      const b = await readable(id, actorId);
      const t = typeOrNotFound(b.importType);
      await assertPermission(authz, `${t.permission}.create`, request('POST', url), accessLog);
      if (b.state !== 'validated' && b.state !== 'rejected') throw transition(b.state, 'cancelled');
      await withTransaction(db, async (tx) => {
        const { count } = await tx.importBatch.updateMany({
          where: { id, state: b.state },
          data: {
            state: 'cancelled',
            cancelledAt: wholeSecond(),
            fileKey: null,
            version: { increment: 1 },
            updatedAt: wholeSecond(),
            updatedBy: actorId,
          },
        });
        if (count !== 1) throw transition('changing', 'cancelled');
        await tx.importRow.deleteMany({ where: { importBatchId: id } });
        await recordStatusChange(tx, IMPORT_AUDIT.type, id, b.state, 'cancelled', { actorId });
      });
      if (b.fileKey) await storage.remove(b.fileKey).catch(() => undefined);
      return toBatchOut(await reload(id));
    },
  };
}

export type ImportsService = ReturnType<typeof importsService>;

/** Reads a stored file whole: imports are bounded by the upload limit. */
export async function readStored(storage: FileStorage, key: string): Promise<Buffer> {
  const { stream } = await storage.open(key);
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
