import { AsyncLocalStorage } from 'node:async_hooks';

import type { Logger } from 'pino';

/**
 * Per-request context, available anywhere in the call chain without passing `req` around.
 * Services must never touch `req`/`res` (src/modules/README.md), so this is how they reach the
 * request-scoped logger and, from P1, the authenticated actor and scope.
 */
export interface RequestContext {
  readonly requestId: string;
  /** Child logger bound with `request_id`. Set by the HTTP logging middleware. */
  logger?: Logger;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}
