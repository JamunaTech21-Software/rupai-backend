import { Errors } from '../errors/app-error.js';

/**
 * The file types an attachment may be (Spec P4 §6.6: "validated on MIME type, extension and size").
 *
 * A file is accepted only when three things agree: the extension of its name, the type the client
 * declared, and the CONTENT (its leading bytes). The stored type is ours, never the client's, so a
 * download is always served as what the file really is.
 */

export interface FileType {
  readonly key: string;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly mime: string;
  matches(head: Buffer): boolean;
}

const starts = (hex: string) => {
  const sig = Buffer.from(hex, 'hex');
  return (head: Buffer) => head.length >= sig.length && head.subarray(0, sig.length).equals(sig);
};
/** docx and xlsx are zip archives. The leading bytes cannot tell them apart; the extension does. */
const zip = starts('504b0304');

export const FILE_TYPES: readonly FileType[] = [
  { key: 'pdf', label: 'PDF', extensions: ['pdf'], mime: 'application/pdf', matches: starts('255044462d') },
  {
    key: 'jpeg',
    label: 'JPEG image',
    extensions: ['jpg', 'jpeg'],
    mime: 'image/jpeg',
    matches: starts('ffd8ff'),
  },
  {
    key: 'png',
    label: 'PNG image',
    extensions: ['png'],
    mime: 'image/png',
    matches: starts('89504e470d0a1a0a'),
  },
  {
    key: 'webp',
    label: 'WebP image',
    extensions: ['webp'],
    mime: 'image/webp',
    matches: (head) =>
      head.length >= 12 &&
      head.subarray(0, 4).toString('latin1') === 'RIFF' &&
      head.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    key: 'docx',
    label: 'Word document',
    extensions: ['docx'],
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    matches: zip,
  },
  {
    key: 'xlsx',
    label: 'Excel workbook',
    extensions: ['xlsx'],
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    matches: zip,
  },
];

export const ALLOWED_EXTENSIONS: readonly string[] = FILE_TYPES.flatMap((t) => t.extensions);

/** Types a browser may declare when it does not know a file: they say nothing, so they pass. */
const UNSPECIFIED = new Set(['', 'application/octet-stream']);

const refuse = (code: string, message: string, context?: Record<string, unknown>) =>
  Errors.validation([{ field: 'file', code, message, ...(context ? { context } : {}) }]);

/**
 * The file name as metadata: its last path segment is NOT taken, a name carrying a path is refused
 * outright (P13 §10: "path traversal in the filename rejected").
 */
export function checkFileName(name: string): string {
  const trimmed = name.normalize('NFC').trim();
  // eslint-disable-next-line no-control-regex
  if (
    trimmed === '' ||
    trimmed.length > 200 ||
    /[\\/\u0000-\u001f\u007f]/.test(trimmed) ||
    /^\.+$/.test(trimmed)
  ) {
    throw refuse(
      'FILE_NAME_INVALID',
      'The file name must be 1 to 200 characters, without a path or control characters.',
    );
  }
  return trimmed;
}

/** The type of an upload, or 422 when its extension is not allowed or the three do not agree. */
export function identifyFile(fileName: string, declaredMime: string, head: Buffer): FileType {
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const type = FILE_TYPES.find((t) => t.extensions.includes(extension));
  if (!type) {
    throw refuse('FILE_TYPE_NOT_ALLOWED', `Files of this type are not accepted.`, {
      extension,
      allowed: ALLOWED_EXTENSIONS,
    });
  }
  if (!type.matches(head)) {
    throw refuse('FILE_TYPE_MISMATCH', `The content of the file is not a ${type.label}.`, { extension });
  }
  const declared = declaredMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (!UNSPECIFIED.has(declared) && declared !== type.mime) {
    throw refuse('FILE_TYPE_MISMATCH', `The file was sent as ${declared}, which is not a ${type.label}.`, {
      extension,
      declared,
    });
  }
  return type;
}
