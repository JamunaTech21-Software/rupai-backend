import { z } from 'zod';

import { zId } from '../../core/ids/ids.js';
import { zBusinessDate } from '../../core/time/dates.js';

/** Request and response schemas of document attachments (Spec P3 §28.4, P4 §6.6). */

export const DOCUMENT_STATUSES = ['active', 'superseded', 'archived'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const IdParams = z.object({ id: zId });

const zTitle = z.string().trim().min(1).max(150);

const datesInOrder = (v: {
  issue_date?: string | null | undefined;
  expiry_date?: string | null | undefined;
}) => !v.issue_date || !v.expiry_date || v.expiry_date >= v.issue_date;
const DATE_ORDER = { path: ['expiry_date'], message: 'Must not be before the issue date.' };

/** The text fields sent with a new document. They arrive as multipart strings. */
export const UploadFields = z
  .strictObject({
    document_type_id: zId,
    /** What tells two documents of the same type apart, e.g. "Fire licence". */
    title: zTitle.optional(),
    issue_date: zBusinessDate.optional(),
    expiry_date: zBusinessDate.optional(),
  })
  .refine(datesInOrder, DATE_ORDER);

/** The text fields sent with a replacement file. The title is kept unless a new one is sent. */
export const ReplaceFields = z
  .strictObject({
    title: zTitle.optional(),
    issue_date: zBusinessDate.optional(),
    expiry_date: zBusinessDate.optional(),
  })
  .refine(datesInOrder, DATE_ORDER);

/** Corrects the details of the current version without a new file. */
export const PatchDocumentBody = z
  .strictObject({
    title: zTitle.nullable().optional(),
    issue_date: zBusinessDate.nullable().optional(),
    expiry_date: zBusinessDate.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Send at least one field to change.' })
  .refine(datesInOrder, DATE_ORDER);

export const DocumentOut = z.object({
  id: z.string(),
  owner_type: z.string(),
  owner_id: z.string(),
  document_type_id: z.string(),
  document_type: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  /** Which document of this type, for this owner. All versions of one document share it. */
  series_no: z.number().int(),
  title: z.string().nullable(),
  file_name: z.string(),
  mime_type: z.string(),
  file_size_bytes: z.number().int(),
  /** SHA-256 of the file, hex. */
  checksum: z.string().nullable(),
  /** The document's own version: 1 for the first file, 2 after one replacement … */
  version_number: z.number().int(),
  issue_date: z.string().nullable(),
  expiry_date: z.string().nullable(),
  /** Days until expiry, negative once expired. Null without an expiry date. */
  days_to_expiry: z.number().int().nullable(),
  is_current: z.boolean(),
  status: z.enum(DOCUMENT_STATUSES),
  uploaded_by: z.string(),
  uploaded_by_name: z.string(),
  /** The record version for If-Match (also the ETag). Not the document version: see version_number. */
  version: z.number().int(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
});

export const ExpiringDocumentOut = DocumentOut.extend({
  /** The record the document belongs to, as the user knows it, e.g. "DEMO-F1 · Demo factory". */
  owner_label: z.string(),
});

export const DownloadOut = z.object({
  /** Relative to the API origin. Works without an Authorization header until `expires_at`. */
  url: z.string(),
  expires_at: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  file_size_bytes: z.number().int(),
});

export const ContentQuery = z.object({
  expires: z.string().regex(/^\d{1,12}$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
});
