import type { RequestHandler } from 'express';
import type { Test } from 'supertest';

import { getRequestContext } from '../../src/core/context/request-context.js';

/**
 * Test actors: act as a given user without a real login.
 *
 * Until authentication exists (P1.02), test routers mount `testActor()` first. A request then names its
 * actor in a test-only header, and features keyed per user (Idempotency-Key, rate limits, audit actor)
 * can be tested now.
 *
 * P1.02/P1.03 replace this with real helpers that create a user holding given roles and scope grants and
 * log in through /auth/login:
 *
 *   const token = await loginAs({ roles: ['ESTATE_MANAGER'], scope: [{ type: 'estate', id: estateA }] });
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
