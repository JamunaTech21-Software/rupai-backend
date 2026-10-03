import { statusFor, type ErrorCode } from './codes.js';

/**
 * One problem inside an error: a field-level validation failure or a per-condition invariant failure
 * (Spec P4 §3.1). `field` uses dot and index notation matching the request body, e.g. `lines.0.quantity`,
 * so the client can attach it to the right input.
 */
export interface ErrorDetail {
  readonly field?: string;
  /** An ErrorCode, or a narrower module-specific code for this one detail. */
  readonly code: string;
  readonly message: string;
  /** The numbers behind the failure, so the client can compose a better message. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/**
 * The only error type that crosses the service → HTTP boundary. Services throw it, and the error handler
 * turns it into the single error envelope. Anything else thrown becomes a 500 with no details leaked.
 */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: readonly ErrorDetail[] = [],
    /** Extra response headers, e.g. Retry-After on 429. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = statusFor(code);
  }
}

/** Shorthand factories for the errors raised by the HTTP foundation itself. */
export const Errors = {
  notFound: (message = 'The requested resource was not found.') => new AppError('NOT_FOUND', message),

  malformed: (message: string, details: ErrorDetail[] = []) =>
    new AppError('MALFORMED_REQUEST', message, details),

  validation: (details: ErrorDetail[], message = 'The request is invalid.') =>
    new AppError('VALIDATION_FAILED', message, details),

  preconditionRequired: () =>
    new AppError(
      'PRECONDITION_REQUIRED',
      'This change requires an If-Match header with the current version.',
      [{ code: 'PRECONDITION_REQUIRED', message: 'Send If-Match with the version you last read.' }],
    ),

  versionConflict: (current: { version: number; resource?: unknown }) =>
    new AppError('VERSION_CONFLICT', 'The record was changed by someone else since you read it.', [
      { code: 'VERSION_CONFLICT', message: 'Reload the record and reapply your changes.', context: current },
    ]),
} as const;
