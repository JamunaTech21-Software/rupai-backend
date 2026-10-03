import type { Request } from 'express';

import { Errors } from '../errors/app-error.js';

/**
 * Optimistic concurrency (Spec P4 §5.1).
 *
 * Every mutable resource carries an integer `version`, returned both as an ETag header and as a
 * `version` attribute in the body. Mutations send `If-Match` with the version they read:
 *   - If-Match missing on a versioned resource → 422 PRECONDITION_REQUIRED. It is not silently accepted:
 *     last-write-wins on a sale or a budget is not acceptable
 *   - version mismatch → 409 VERSION_CONFLICT, with the current representation in context
 *
 * The comparison itself happens in the service, in the same transaction as the update (a conditional
 * `UPDATE … WHERE id = ? AND version = ?`), so two concurrent writers cannot both win.
 */

export function etagFor(version: number): string {
  return `"${version}"`;
}

const IF_MATCH = /^(?:W\/)?"?(\d{1,15})"?$/;

/** Reads If-Match as a version number, or `undefined` when absent. */
export function readIfMatch(req: Request): number | undefined {
  const raw = req.get('If-Match')?.trim();
  if (raw === undefined || raw === '') return undefined;
  const m = IF_MATCH.exec(raw);
  if (!m?.[1]) {
    throw Errors.malformed('If-Match must be the version from the ETag, e.g. "3".', [
      { field: 'If-Match', code: 'MALFORMED_REQUEST', message: 'Expected a quoted integer version.' },
    ]);
  }
  return Number.parseInt(m[1], 10);
}

/** Reads If-Match and refuses the request when it is missing. */
export function requireIfMatch(req: Request): number {
  const version = readIfMatch(req);
  if (version === undefined) throw Errors.preconditionRequired();
  return version;
}

/** Throws VERSION_CONFLICT unless the version the client read is the current one. */
export function assertVersion(expected: number, current: number, currentResource?: unknown): void {
  if (expected !== current) {
    throw Errors.versionConflict({
      version: current,
      ...(currentResource !== undefined ? { resource: currentResource } : {}),
    });
  }
}
