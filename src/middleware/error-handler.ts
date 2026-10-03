import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

import { getRequestContext } from '../core/context/request-context.js';
import { AppError, Errors, type ErrorDetail } from '../core/errors/app-error.js';
import { getLogger } from '../core/logging/logger.js';
import { zodIssuesToDetails } from '../core/http/validate.js';

/**
 * One error shape for every failure (Spec P4 §3.1):
 *
 *   { "error": { "code", "message", "details": [{ field?, code, message, context? }], "request_id" } }
 *
 * - AppError → its own status and code
 * - body-parser failures → 400 MALFORMED_REQUEST / 413 PAYLOAD_TOO_LARGE / 415 UNSUPPORTED_MEDIA_TYPE
 * - Prisma unique / foreign-key / not-found → 422 DUPLICATE_KEY / 422 REFERENCED_RECORD / 404 NOT_FOUND
 * - anything else → 500 INTERNAL_ERROR, logged in full, with **no internal detail sent to the client**
 */

interface BodyParserError {
  type?: string;
  status?: number;
}

interface PrismaLikeError {
  name?: string;
  code?: string;
  meta?: { target?: unknown; modelName?: string };
}

function fromBodyParser(err: BodyParserError): AppError | undefined {
  switch (err.type) {
    case 'entity.parse.failed':
      return Errors.malformed('The request body is not valid JSON.');
    case 'entity.too.large':
      return new AppError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
    case 'encoding.unsupported':
    case 'charset.unsupported':
      return new AppError('UNSUPPORTED_MEDIA_TYPE', 'The request body encoding or charset is not supported.');
    default:
      return undefined;
  }
}

function fromPrisma(err: PrismaLikeError): AppError | undefined {
  if (err.name !== 'PrismaClientKnownRequestError') return undefined;
  switch (err.code) {
    case 'P2002':
      return new AppError('DUPLICATE_KEY', 'A record with the same unique value already exists.', [
        {
          code: 'DUPLICATE_KEY',
          message: 'Choose a different value.',
          context: { target: err.meta?.target },
        },
      ]);
    case 'P2003':
      return new AppError(
        'REFERENCED_RECORD',
        'The record is referenced by, or refers to, another record that prevents this change.',
      );
    case 'P2025':
      return Errors.notFound();
    default:
      return undefined;
  }
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return Errors.validation(zodIssuesToDetails(err.issues));
  if (err && typeof err === 'object') {
    return fromBodyParser(err) ?? fromPrisma(err);
  }
  return undefined;
}

function envelope(code: string, message: string, details: readonly ErrorDetail[]) {
  return { error: { code, message, details, request_id: getRequestContext()?.requestId ?? '' } };
}

export function errorHandler(rootLogger: Logger): ErrorRequestHandler {
  return (err: unknown, _req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appError = toAppError(err);
    if (appError) {
      for (const [h, v] of Object.entries(appError.headers)) res.setHeader(h, v);
      res.status(appError.status).json(envelope(appError.code, appError.message, appError.details));
      return;
    }

    // Unexpected: log everything server-side and send nothing internal to the client (Spec P13 §10).
    getLogger(rootLogger).error({ err }, 'unhandled error');
    if (err instanceof Error) res.err = err; // lets pino-http attach it to the request line
    res
      .status(500)
      .json(envelope('INTERNAL_ERROR', 'Something went wrong. Quote the request id when reporting it.', []));
  };
}

/** Unmatched routes: 404 in the standard envelope, never Express's HTML page. */
export const notFoundHandler: RequestHandler = () => {
  throw Errors.notFound('No such endpoint.');
};

/**
 * Bodies must be JSON (Spec P4 §2.3). File upload routes (P1.12) mount their own multipart parser BEFORE
 * this guard.
 */
export const requireJsonBody: RequestHandler = (req, _res, next) => {
  const hasBody =
    Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined;
  if (hasBody && !req.is('application/json')) {
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
