import type { RequestHandler } from 'express';
import type { Test } from 'supertest';

import { getRequestContext } from '../../src/core/context/request-context.js';

/**
 * Test actors: act as a given user without a real sign-in.
 *
 * Since P1.02 the server authenticates with bearer tokens (core/auth/authenticate.ts), and the auth
 * suite (tests/db/auth.test.ts) signs in for real. Suites that only need "user N did this" may mount
 * `testActor()` instead: a request names its actor in a test-only header. It sets no session, so
 * session-dependent behaviour (logout, must-change-password) is not exercised this way.
 *
 * This middleware is NEVER mounted by createApp. It exists only in tests.
 */
export const TEST_ACTOR_HEADER = 'X-Test-Actor';

export function testActor(): RequestHandler {
  return (req, _res, next) => {
    const actor = req.get(TEST_ACTOR_HEADER);
    const ctx = getRequestContext();
    if (actor && ctx) ctx.actorId = actor;
    next();
  };
}

/** Sends the request as the given test actor. */
export function as(req: Test, actorId: string): Test {
  return req.set(TEST_ACTOR_HEADER, actorId);
}
