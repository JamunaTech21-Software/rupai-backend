import type { RequestHandler } from 'express';

import { getRequestContext } from '../context/request-context.js';
import type { SessionStore } from './sessions.js';
import type { TokenSigner } from './tokens.js';

/**
 * Identifies the caller from `Authorization: Bearer <access token>` (Spec P4 §2.2, §4.1). Mounted on
 * /api/v1 before the rate limiter, so limits are per user.
 *
 *   1. verify the signature and expiry (current key, or the previous one during a rotation)
 *   2. check the session on EVERY request: not revoked, not expired, user active (sessions.ts)
 *   3. set actorId, sessionId and mustChangePassword on the request context
 *
 * It never refuses a request itself. A missing or rejected token leaves the request anonymous, with the
 * reason recorded: public endpoints (login, refresh) still work with a stale header, and everything else
 * answers 401 from its route guard (authorize.ts).
 */
export function authenticate(deps: { signer: TokenSigner; sessions: SessionStore }): RequestHandler {
  return (req, _res, next) => {
    const ctx = getRequestContext();
    const header = req.get('authorization');
    if (!ctx || header === undefined) {
      next();
      return;
    }
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header.trim());
    if (!match?.[1]) {
      ctx.authFailure = 'UNAUTHENTICATED';
      next();
      return;
    }
    const verified = deps.signer.verify(match[1]);
    if (!verified.ok) {
      ctx.authFailure = verified.reason === 'expired' ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED';
      next();
      return;
    }
    const { sub, sid } = verified.claims;
    deps.sessions.state(BigInt(sid)).then(
      (state) => {
        if (!state?.live || state.userId.toString() !== sub) {
          ctx.authFailure = 'SESSION_EXPIRED';
        } else {
          ctx.actorId = sub;
          ctx.sessionId = sid;
          ctx.mustChangePassword = state.mustChangePassword;
          if (ctx.logger) ctx.logger = ctx.logger.child({ user_id: sub });
        }
        next();
      },
      (err: unknown) => {
        next(err);
      },
    );
  };
}
