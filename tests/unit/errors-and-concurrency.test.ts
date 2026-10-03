import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../src/core/errors/app-error.js';
import { ERROR_CODES, statusFor } from '../../src/core/errors/codes.js';
import { assertVersion, etagFor, readIfMatch, requireIfMatch } from '../../src/core/http/concurrency.js';

const req = (ifMatch?: string) =>
  ({ get: (h: string) => (h === 'If-Match' ? ifMatch : undefined) }) as unknown as Request;

describe('error code → HTTP status mapping (Spec P4 §2.7, §3.2)', () => {
  it.each([
    ['UNAUTHENTICATED', 401],
    ['PERMISSION_DENIED', 403],
    ['NOT_FOUND', 404],
    ['VALIDATION_FAILED', 422],
    ['UNKNOWN_FILTER', 422],
    ['INVALID_TRANSITION', 409],
    ['VERSION_CONFLICT', 409],
    ['PERIOD_CLOSED', 423],
    ['INSUFFICIENT_STOCK', 422],
    ['UNDISTRIBUTED_TEAM_OUTPUT', 422],
    ['RATE_LIMITED', 429],
    ['INTERNAL_ERROR', 500],
  ] as const)('%s → %i', (code, status) => {
    expect(statusFor(code)).toBe(status);
    expect(new AppError(code, 'x').status).toBe(status);
  });

  it('uses only the status codes the spec allows', () => {
    const allowed = new Set([400, 401, 403, 404, 409, 413, 415, 422, 423, 429, 500, 503]);
    for (const status of Object.values(ERROR_CODES)) expect(allowed.has(status)).toBe(true);
  });
});

describe('optimistic concurrency (Spec P4 §5.1)', () => {
  it('formats the ETag as the quoted version', () => {
    expect(etagFor(3)).toBe('"3"');
  });

  it.each([
    ['"3"', 3],
    ['3', 3],
    ['W/"12"', 12],
  ])('reads If-Match %s', (header, version) => {
    expect(readIfMatch(req(header))).toBe(version);
  });

  it('returns undefined when If-Match is absent, and refuses it when required (422)', () => {
    expect(readIfMatch(req())).toBeUndefined();
    expect(() => requireIfMatch(req())).toThrow(
      expect.objectContaining({ code: 'PRECONDITION_REQUIRED', status: 422 }),
    );
  });

  it('rejects a malformed If-Match with 400', () => {
    expect(() => readIfMatch(req('"abc"'))).toThrow(expect.objectContaining({ code: 'MALFORMED_REQUEST' }));
  });

  it('raises 409 VERSION_CONFLICT with the current version and resource on mismatch', () => {
    try {
      assertVersion(3, 4, { id: '7', name: 'changed' });
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ code: 'VERSION_CONFLICT', status: 409 });
      expect((e as AppError).details[0]?.context).toEqual({
        version: 4,
        resource: { id: '7', name: 'changed' },
      });
    }
  });

  it('accepts a matching version', () => {
    expect(() => {
      assertVersion(4, 4);
    }).not.toThrow();
  });
});
