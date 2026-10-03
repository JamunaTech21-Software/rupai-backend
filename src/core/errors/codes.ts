/**
 * The stable, machine-readable error codes of the API, and the HTTP status each maps to (Spec P4 §3.2,
 * §2.7). This table is the central error → status mapping. Clients branch on `code`, never on the message.
 *
 * Rules (Spec P4 §3.2, §18):
 *   - codes are only ever ADDED. An existing code is never renamed or repurposed
 *   - a renamed condition gets a new code
 */
export const ERROR_CODES = {
  // ---- request shape (400) and transport -------------------------------------------------------
  MALFORMED_REQUEST: 400, // unparseable JSON, bad query grammar
  NOT_FOUND: 404, // does not exist, OR exists outside the caller's scope (Spec P4 §4.3)
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,

  // ---- authentication (401) --------------------------------------------------------------------
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  ACCOUNT_LOCKED: 401,
  INVALID_CREDENTIALS: 401,

  // ---- authorisation (403) ---------------------------------------------------------------------
  PERMISSION_DENIED: 403,
  SCOPE_DENIED: 403,
  SELF_APPROVAL_FORBIDDEN: 403,

  // ---- validation (422) ------------------------------------------------------------------------
  VALIDATION_FAILED: 422,
  UNKNOWN_FILTER: 422,
  UNKNOWN_SORT: 422,
  UNKNOWN_INCLUDE: 422,
  RANGE_REQUIRED: 422,
  /** A mutation on a versioned resource sent without If-Match (Spec P4 §5.1). */
  PRECONDITION_REQUIRED: 422,
  /** The same Idempotency-Key reused with a different request (Spec P4 §5.2). */
  IDEMPOTENCY_KEY_REUSED: 422,

  // ---- state and concurrency (409) -------------------------------------------------------------
  INVALID_TRANSITION: 409,
  ALREADY_APPROVED: 409,
  ALREADY_POSTED: 409,
  NOT_SUBMITTED: 409,
  VERSION_CONFLICT: 409,
  /** A request with this Idempotency-Key is still being processed. */
  IDEMPOTENCY_IN_PROGRESS: 409,

  // ---- period and lock (423) -------------------------------------------------------------------
  PERIOD_CLOSED: 423,
  SEASON_CLOSED: 423,
  DOCUMENT_LOCKED: 423,
  PAYROLL_CONSUMED: 423,

  // ---- business invariants (422) ---------------------------------------------------------------
  INSUFFICIENT_STOCK: 422,
  NEGATIVE_STOCK: 422,
  LOT_ALREADY_SOLD: 422,
  RESERVATION_EXPIRED: 422,
  MIXED_OWNERSHIP_BATCH: 422,
  UNBALANCED_JOURNAL: 422,
  ACCOUNT_NOT_POSTABLE: 422,
  COST_CENTRE_REQUIRED: 422,
  DUPLICATE_POSTING: 422,
  UNAPPROVED_SOURCE: 422,
  UNDISTRIBUTED_TEAM_OUTPUT: 422,
  OVERLAPPING_PAYROLL_RUN: 422,
  RULE_AMBIGUOUS: 422,
  RULE_NOT_FOUND: 422,
  STATUTORY_RULE_UNVERIFIED: 422,
  BUDGET_EXCEEDED: 422,
  BUDGET_NOT_ACTIVE: 422,
  ALLOCATION_MISMATCH: 422,
  REFERENCED_RECORD: 422,
  DUPLICATE_KEY: 422,
  INVARIANT_VIOLATED: 422,
} as const satisfies Record<string, number>;

export type ErrorCode = keyof typeof ERROR_CODES;

export function statusFor(code: ErrorCode): number {
  return ERROR_CODES[code];
}
