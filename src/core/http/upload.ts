import busboy from 'busboy';
import type { RequestHandler, Response } from 'express';

import { AppError, Errors } from '../errors/app-error.js';
import { tooLarge, type FileStorage, type StoredTemp } from '../storage/storage.js';

/**
 * multipart/form-data for the routes that take a file (Spec P4 §2.3, §6.6). A route declares
 * `multipart: multipartUpload(…)`; it runs AFTER the permission check, so an unauthorised caller's file
 * is never read, and BEFORE validation, which then sees the text fields as the body.
 *
 *   - exactly one file, in the field named `file`, streamed to temporary storage (never held in memory)
 *   - text fields become `req.body` (all strings; an empty value counts as not sent)
 *   - past the size limit → 413; anything left in temporary storage is removed when the response ends,
 *     unless the handler promoted it
 */

export interface Upload {
  /** The name as the client sent it, path and all. Check it with `checkFileName` before use. */
  readonly fileName: string;
  readonly declaredMime: string;
  readonly temp: StoredTemp;
}

export interface MultipartSpec {
  readonly handler: RequestHandler;
  readonly fileField: string;
  readonly maxBytes: number;
}

const UPLOAD = 'upload';
const FIELD_BYTES = 16 * 1024;

const invalid = (field: string, message: string) =>
  Errors.validation([{ field, code: 'VALIDATION_FAILED', message }]);

export function multipartUpload(opts: {
  storage: FileStorage;
  maxBytes: number;
  fileField?: string;
}): MultipartSpec {
  const fileField = opts.fileField ?? 'file';

  const handler: RequestHandler = (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'This endpoint takes multipart/form-data.', [
        {
          field: 'Content-Type',
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Send the file and its fields as multipart/form-data.',
        },
      ]);
    }

    let parser: busboy.Busboy;
    try {
      parser = busboy({
        headers: req.headers,
        // The path is kept so that a name carrying one can be refused rather than silently trimmed.
        preservePath: true,
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: opts.maxBytes, fields: 20, fieldSize: FIELD_BYTES, parts: 22 },
      });
    } catch {
      throw Errors.malformed('The multipart request is malformed.');
    }

    const fields: Record<string, string> = {};
    let failure: Error | undefined;
    let stored: Promise<Upload | undefined> | undefined;
    let settled = false;

    const finish = (err?: unknown) => {
      if (settled) return;
      settled = true;
      req.unpipe(parser);
      if (err !== undefined) req.resume(); // drain what is left so the error response can be sent
      next(err);
    };

    parser.on('file', (name, stream, info) => {
      if (name !== fileField || stored) {
        failure ??= invalid(name, `Send exactly one file, in the field "${fileField}".`);
        stream.resume();
        return;
      }
      let truncated = false;
      stream.on('limit', () => {
        truncated = true;
      });
      stored = opts.storage.writeTemp(stream, opts.maxBytes).then(
        (temp) => {
          res.once('close', () => void opts.storage.remove(temp.key).catch(() => undefined));
          if (truncated) {
            failure ??= tooLarge(opts.maxBytes);
            return undefined;
          }
          return { fileName: info.filename ?? '', declaredMime: info.mimeType, temp };
        },
        (err: unknown) => {
          failure ??=
            err instanceof Error ? err : new Error('the upload could not be stored', { cause: err });
          return undefined;
        },
      );
    });
    parser.on('field', (name, value, info) => {
      if (info.valueTruncated || info.nameTruncated) failure ??= invalid(name, 'The value is too long.');
      else if (name in fields) failure ??= invalid(name, 'The field was sent more than once.');
      else if (value !== '') fields[name] = value;
    });
    parser.on('filesLimit', () => (failure ??= invalid(fileField, 'Send exactly one file.')));
    parser.on('fieldsLimit', () => (failure ??= Errors.malformed('The request has too many fields.')));
    parser.on('partsLimit', () => (failure ??= Errors.malformed('The request has too many parts.')));
    parser.on('error', () => {
      finish(Errors.malformed('The multipart request is malformed.'));
    });
    parser.on('close', () => {
      void (async () => {
        const upload = await stored;
        if (failure) throw failure;
        if (!upload) throw invalid(fileField, 'A file is required.');
        req.body = fields;
        res.locals[UPLOAD] = upload;
      })().then(() => {
        finish();
      }, finish);
    });
    req.on('aborted', () => {
      finish(Errors.malformed('The upload was interrupted.'));
    });
    req.pipe(parser);
  };

  return { handler, fileField, maxBytes: opts.maxBytes };
}

/** The file parsed by `multipartUpload` on this route. */
export function getUpload(res: Response): Upload {
  const upload = res.locals[UPLOAD] as Upload | undefined;
  if (!upload) throw new Error('multipartUpload() was not mounted on this route');
  return upload;
}

/** JSON routes refuse a multipart body outright (the JSON-only guard lets multipart reach the routes). */
export const refuseMultipart: RequestHandler = (req, _res, next) => {
  if (req.is('multipart/form-data')) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Request bodies must be application/json.', [
      {
        field: 'Content-Type',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Send Content-Type: application/json.',
      },
    ]);
  }
  next();
};
