import { z } from 'zod';

import { recordStatusChange } from '../../core/audit/audit.js';
import { dbPermissionResolver, runAsUser } from '../../core/auth/authorize.js';
import type { Database } from '../../core/db/prisma.js';
import { withTransaction } from '../../core/db/transaction.js';
import { AppError } from '../../core/errors/app-error.js';
import { importType, type ImportType, type RowError } from '../../core/imports/registry.js';
import { readSheet, SheetError, type SheetFormat } from '../../core/imports/sheets.js';
import { defineJob, PermanentJobError } from '../../core/jobs/registry.js';
import { wholeSecond } from '../../core/jobs/store.js';
import type { FileStorage } from '../../core/storage/storage.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { COMMIT_JOB, IMPORT_AUDIT, readStored, VALIDATE_JOB } from './imports.service.js';

/**
 * The two jobs of an import (P4 §6.7: validation and commit are both jobs, 202).
 *
 *   validate  reads the file, matches the header to the type's columns, checks every row, and writes the
 *             staging rows. Safe to repeat: a re-run deletes what an interrupted run wrote and starts over
 *             (it only reads the database outside the staging rows).
 *   commit    saves the VALID rows only, each in its own transaction with a processing key, so a re-run
 *             never saves a row twice. A row refused at commit (its code was taken meanwhile) is marked
 *             failed with the reason; the others still commit, and the job ends `partial`.
 */

const Payload = z.object({ batch_id: z.string().regex(/^\d+$/) });
const CHUNK = 200;

interface Problem {
  readonly code: string;
  readonly message: string;
}

/** The header against the type's columns: which file column is which, or why the file cannot be used. */
export function matchHeader(
  header: readonly string[],
  type: ImportType,
): { ok: true; index: Map<string, number> } | { ok: false; problems: Problem[] } {
  const problems: Problem[] = [];
  if (header.length === 0 || header.every((h) => h === '')) {
    return {
      ok: false,
      problems: [{ code: 'NO_HEADER', message: 'Row 1 must hold the column names of the template.' }],
    };
  }
  const known = new Map(type.columns.map((c) => [c.name.toLowerCase(), c.name]));
  const index = new Map<string, number>();
  header.forEach((h, i) => {
    const name = known.get(h.toLowerCase());
    if (h === '') return;
    if (!name) problems.push({ code: 'UNKNOWN_COLUMN', message: `Column "${h}" is not in the template.` });
    else if (index.has(name))
      problems.push({ code: 'DUPLICATE_COLUMN', message: `Column "${h}" appears twice.` });
    else index.set(name, i);
  });
  for (const c of type.columns) {
    if (c.required && !index.has(c.name)) {
      problems.push({ code: 'MISSING_COLUMN', message: `Column "${c.name}" is required.` });
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, index };
}

async function reject(db: Database, batchId: bigint, actorId: bigint | null, problems: Problem[]) {
  await withTransaction(db, async (tx) => {
    const { count } = await tx.importBatch.updateMany({
      where: { id: batchId, state: 'validating' },
      data: {
        state: 'rejected',
        problems: problems as unknown as Prisma.InputJsonValue,
        validatedAt: wholeSecond(),
      },
    });
    if (count === 1 && actorId !== null) {
      await recordStatusChange(tx, IMPORT_AUDIT.type, batchId, 'validating', 'rejected', { actorId });
    }
  });
  return { result: { batch_id: batchId.toString(), state: 'rejected', problems } };
}

/**
 * A type whose rows belong to estates runs its check and commit as the user (D-2.06-2); others in the
 * job's unscoped context.
 */
function runner(db: Database) {
  const resolver = dbPermissionResolver(db);
  return <T>(type: ImportType, userId: bigint, work: () => Promise<T>): Promise<T> =>
    type.actsAsUser ? runAsUser(resolver, userId, work) : work();
}

export function validateImportJob(db: Database, storage: FileStorage) {
  const asUser = runner(db);
  return defineJob({
    type: VALIDATE_JOB,
    label: 'Check an import file',
    payload: Payload,
    async run(ctx) {
      const batchId = BigInt(ctx.payload.batch_id);
      const batch = await db.importBatch.findUnique({ where: { id: batchId } });
      if (!batch) throw new PermanentJobError('NOT_FOUND', 'The import batch no longer exists.');
      if (batch.state !== 'validating')
        return { result: { batch_id: ctx.payload.batch_id, state: batch.state } };
      const type = importType(batch.importType);
      if (!type)
        throw new PermanentJobError('NOT_FOUND', `Import type ${batch.importType} is not registered.`);
      if (!batch.fileKey) throw new PermanentJobError('NOT_FOUND', 'The uploaded file is missing.');

      let sheet;
      try {
        sheet = await readSheet(
          await readStored(storage, batch.fileKey),
          batch.fileFormat as SheetFormat,
          type.maxRows,
        );
      } catch (err) {
        if (err instanceof SheetError)
          return reject(db, batchId, ctx.requestedBy, [{ code: 'FILE_UNREADABLE', message: err.message }]);
        throw err;
      }
      const header = matchHeader(sheet.header, type);
      if (!header.ok) return reject(db, batchId, ctx.requestedBy, header.problems);
      if (sheet.rows.length === 0) {
        return reject(db, batchId, ctx.requestedBy, [
          { code: 'NO_ROWS', message: 'The file has no data rows below the header.' },
        ]);
      }

      // Start over: an interrupted run may have written some rows.
      await db.importRow.deleteMany({ where: { importBatchId: batchId } });
      const seen = new Map<string, number>();
      let valid = 0;
      let invalid = 0;
      for (let i = 0; i < sheet.rows.length; i += CHUNK) {
        ctx.signal.throwIfAborted();
        const chunk = sheet.rows.slice(i, i + CHUNK);
        await withTransaction(
          db,
          async (tx) => {
            const data: Prisma.ImportRowCreateManyInput[] = [];
            for (const r of chunk) {
              const row = Object.fromEntries(
                type.columns.map((c) => [c.name, r.cells[header.index.get(c.name) ?? -1] ?? '']),
              );
              const check = await asUser(type, ctx.requestedBy ?? batch.createdBy, () => type.check(row, tx));
              let errors: RowError[] = check.ok ? [] : [...check.errors];
              if (check.ok && check.key !== undefined) {
                const first = seen.get(check.key);
                if (first !== undefined) {
                  errors = [
                    { column: null, code: 'DUPLICATE_IN_FILE', message: `The same as row ${String(first)}.` },
                  ];
                } else seen.set(check.key, r.rowNumber);
              }
              if (errors.length === 0) valid += 1;
              else invalid += 1;
              data.push({
                importBatchId: batchId,
                rowNumber: r.rowNumber,
                data: row,
                state: errors.length === 0 ? 'valid' : 'invalid',
                ...(errors.length === 0 ? {} : { errors: errors as unknown as Prisma.InputJsonValue }),
              });
            }
            await tx.importRow.createMany({ data });
          },
          { timeout: 60_000 },
        );
        await ctx.progress(Math.min(i + CHUNK, sheet.rows.length), sheet.rows.length);
      }
      await withTransaction(db, async (tx) => {
        const { count } = await tx.importBatch.updateMany({
          where: { id: batchId, state: 'validating' },
          data: {
            state: 'validated',
            rowCount: sheet.rows.length,
            validCount: valid,
            errorCount: invalid,
            validatedAt: wholeSecond(),
          },
        });
        if (count === 1 && ctx.requestedBy !== null) {
          await recordStatusChange(tx, IMPORT_AUDIT.type, batchId, 'validating', 'validated', {
            actorId: ctx.requestedBy,
          });
        }
      });
      return {
        result: {
          batch_id: ctx.payload.batch_id,
          state: 'validated',
          rows: sheet.rows.length,
          valid,
          invalid,
        },
      };
    },
  });
}

/** A row refused at commit: its errors. */
class RowRefused extends Error {
  constructor(readonly errors: readonly RowError[]) {
    super('row refused');
  }
}

const refusalOf = (err: AppError): RowError[] =>
  err.details.length > 0
    ? err.details.map((d) => ({ column: d.field ?? null, code: d.code, message: d.message }))
    : [{ column: null, code: err.code, message: err.message }];

export function commitImportJob(db: Database) {
  const asUser = runner(db);
  return defineJob({
    type: COMMIT_JOB,
    label: 'Import the valid rows',
    payload: Payload,
    async run(ctx) {
      const batchId = BigInt(ctx.payload.batch_id);
      const batch = await db.importBatch.findUnique({ where: { id: batchId } });
      if (!batch) throw new PermanentJobError('NOT_FOUND', 'The import batch no longer exists.');
      if (batch.state !== 'committing')
        return { result: { batch_id: ctx.payload.batch_id, state: batch.state } };
      const type = importType(batch.importType);
      if (!type)
        throw new PermanentJobError('NOT_FOUND', `Import type ${batch.importType} is not registered.`);
      // The rows are saved as the person who uploaded and committed them.
      const actorId = ctx.requestedBy ?? batch.updatedBy ?? batch.createdBy;
      let done = 0;
      for (let after = 0; ;) {
        ctx.signal.throwIfAborted();
        const rows = await db.importRow.findMany({
          where: { importBatchId: batchId, state: 'valid', rowNumber: { gt: after } },
          orderBy: { rowNumber: 'asc' },
          take: 100,
        });
        if (rows.length === 0) break;
        for (const r of rows) {
          after = r.rowNumber;
          const key = `import_batch:${ctx.payload.batch_id}:commit:${String(r.rowNumber)}`;
          try {
            await withTransaction(db, async (tx) => {
              if (!(await ctx.once(tx, key))) return;
              const targetId = await asUser(type, actorId, async () => {
                const check = await type.check(r.data as Record<string, string>, tx);
                if (!check.ok) throw new RowRefused(check.errors);
                return type.commit(check.value, tx, actorId);
              });
              await tx.importRow.update({
                where: { id: r.id },
                data: { state: 'committed', targetId, committedAt: wholeSecond() },
              });
            });
          } catch (err) {
            const errors =
              err instanceof RowRefused ? err.errors : err instanceof AppError ? refusalOf(err) : null;
            if (errors === null) throw err; // the database, not the row: retry the job
            await withTransaction(db, async (tx) => {
              if (!(await ctx.once(tx, key))) return;
              await tx.importRow.update({
                where: { id: r.id },
                data: { state: 'failed', errors: errors as unknown as Prisma.InputJsonValue },
              });
            });
          }
          done += 1;
        }
        await ctx.progress(done, batch.validCount);
      }
      const [committed, failed] = await Promise.all([
        db.importRow.count({ where: { importBatchId: batchId, state: 'committed' } }),
        db.importRow.count({ where: { importBatchId: batchId, state: 'failed' } }),
      ]);
      await withTransaction(db, async (tx) => {
        const { count } = await tx.importBatch.updateMany({
          where: { id: batchId, state: 'committing' },
          data: {
            state: 'committed',
            committedCount: committed,
            failedCount: failed,
            committedAt: wholeSecond(),
          },
        });
        if (count === 1) {
          await recordStatusChange(tx, IMPORT_AUDIT.type, batchId, 'committing', 'committed', { actorId });
        }
      });
      return {
        state: failed > 0 ? 'partial' : 'completed',
        result: { batch_id: ctx.payload.batch_id, state: 'committed', committed, failed },
      };
    },
  });
}
