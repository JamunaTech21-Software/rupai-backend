import type { RequestHandler } from 'express';
import { ulid } from 'ulid';

import { runWithRequestContext } from '../core/context/request-context.js';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * Accept a caller-supplied request id only if it is short and plain. Anything else is replaced, so a
 * client cannot inject newlines or oversized values into the logs.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Generates (or adopts) the request id, returns it in `X-Request-Id`, and runs the rest of the request
 * inside a request context (Spec P4 §2.4: request_id is generated per request, returned to the client
 * and written to every log line).
 */
export function requestContext(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : ulid();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    res.locals.requestId = requestId;

    // req.ip honours TRUST_PROXY (set on the app before this runs), so it is the client's address.
    const userAgent = req.get('user-agent')?.slice(0, 255);
    runWithRequestContext(
      { requestId, clientIp: req.ip ?? null, ...(userAgent ? { userAgent } : {}) },
      () => {
        next();
      },
    );
  };
}
