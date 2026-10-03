import type { RequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import { getRequestContext } from '../core/context/request-context.js';

/**
 * Logs one structured line per request on completion, bound with `request_id`, and puts the
 * request-bound child logger into the request context for services to use.
 * Must be mounted after `requestContext()`.
 */
export function httpLogger(logger: Logger): RequestHandler[] {
  const http = pinoHttp({
    logger,
    genReqId: (_req, res) => getRequestContext()?.requestId ?? String(res.getHeader('X-Request-Id') ?? ''),
    // Bound into req.log, so the completion line and every line logged through the request logger
    // carry request_id.
    customProps: (req) => ({ request_id: req.id }),
    customAttributeKeys: { responseTime: 'duration_ms' },
    // Health probes run every few seconds. Logging each one would bury real traffic.
    autoLogging: { ignore: (req) => (req.url ?? '').startsWith('/health') },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Keep request lines lean. Never log headers or bodies wholesale.
    serializers: {
      req: (req: { method?: string; url?: string; remoteAddress?: string }) => ({
        method: req.method,
        url: req.url,
        remote_address: req.remoteAddress,
      }),
      res: (res: { statusCode?: number }) => ({ status_code: res.statusCode }),
    },
  });

  const bindContextLogger: RequestHandler = (req, _res, next) => {
    const ctx = getRequestContext();
    if (ctx) ctx.logger = req.log;
    next();
  };

  return [http, bindContextLogger];
}
