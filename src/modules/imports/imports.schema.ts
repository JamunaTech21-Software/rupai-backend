import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { JobOut } from '../jobs/jobs.schema.js';

/** Request and response schemas of the import framework (P1.17; Spec P4 §6.7, P5 §7.6). */

export const BATCH_STATES = [
  'validating',
  'validated',
  'rejected',
  'committing',
  'committed',
  'cancelled',
] as const;
export const ROW_STATES = ['valid', 'invalid', 'committed', 'failed'] as const;
export const FORMATS = ['xlsx', 'csv'] as const;

export const TypeParams = z.object({ type: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/) });
export const BatchParams = z.object({ id: zId });
export const FormatQuery = z.strictObject({ format: z.enum(FORMATS).optional() });

export const ImportTypeOut = z.object({
  key: z.string(),
  label: z.string(),
  /** The permission module: .create to upload and commit, .view to read batches. */
  permission: z.string(),
  max_rows: z.number().int(),
  columns: z.array(
    z.object({ name: z.string(), required: z.boolean(), description: z.string(), example: z.string() }),
  ),
});

const Problem = z.object({ code: z.string(), message: z.string() });
export const RowErrorOut = z.object({ column: z.string().nullable(), code: z.string(), message: z.string() });

export const BatchOut = z.object({
  id: z.string(),
  import_type: z.string(),
  label: z.string(),
  /**
   * validating (the validation job runs) → validated (read the counts and errors) → committing → committed;
   * or rejected (the file could not be read: see problems) or cancelled.
   */
  state: z.enum(BATCH_STATES),
  file_name: z.string(),
  file_format: z.enum(FORMATS),
  row_count: z.number().int(),
  valid_count: z.number().int(),
  error_count: z.number().int(),
  committed_count: z.number().int(),
  /** Valid at validation, refused at commit (e.g. the code was taken meanwhile). */
  failed_count: z.number().int(),
  /** Why a rejected file could not be read at all. Empty otherwise. */
  problems: z.array(Problem),
  /** Commit is allowed: validated with at least one valid row. Only valid rows are committed. */
  can_commit: z.boolean(),
  can_cancel: z.boolean(),
  /** The job now working on the batch (validation or commit), to poll; null when none is. */
  job: JobOut.nullable(),
  validate_job_id: z.string().nullable(),
  commit_job_id: z.string().nullable(),
  created_by: z.object({ id: z.string(), username: z.string() }),
  created_at: z.string(),
  validated_at: z.string().nullable(),
  committed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  version: z.number().int(),
});

export const ErrorLineOut = z.object({
  row_number: z.number().int(),
  column: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

export const RowOut = z.object({
  row_number: z.number().int(),
  state: z.enum(ROW_STATES),
  /** The row as read from the file. */
  data: z.record(z.string(), z.string()),
  errors: z.array(RowErrorOut),
  /** The record the row became. */
  target_id: z.string().nullable(),
});

/** The text fields sent with the file: none yet. */
export const UploadFields = z.strictObject({});
