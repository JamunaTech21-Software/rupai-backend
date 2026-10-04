import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from 'pino';

import type { ResolvedScope } from '../scope/scope.js';

/**
 * Per-request context, available anywhere in the call chain without passing `req` around.
 * Services must never touch `req`/`res` (src/modules/README.md), so this is how they reach the
 * request-scoped logger and, from P1, the authenticated actor and scope.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Child logger bound with `request_id`. Set by the HTTP logging middleware. */
  logger?: Logger;
  /** The authenticated user's id, set by `authenticate` from P1.02. Used for per-user keys (idempotency, rate limits). */
  actorId?: string;
  /** The actor's effective permissions, resolved once per request by the first permission check. */
  permissions?: ReadonlySet<string>;
  /** The session the access token belongs to (P1.02). */
  sessionId?: string;
  /** The user must change a temporary password before using anything but their own account (P1.02). */
  mustChangePassword?: boolean;
  /**
   * Why a presented bearer token was not accepted. Public endpoints ignore it; anything that needs a
   * signed-in user answers 401 with this code, so the client knows to refresh (P5 §3.4).
   */
  authFailure?: 'UNAUTHENTICATED' | 'SESSION_EXPIRED';
  /**
   * Resolves the actor's data scope (P1.03), memoised: set by the route guard, called by the scope
   * extension the first time a scoped model is queried.
   */
  loadScope?: () => Promise<ResolvedScope>;
  /** Set by runUnscoped(reason): system work that legitimately reads across scope. */
  unscoped?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
