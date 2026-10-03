import express, { Router, type Express } from 'express';
import type { Logger } from 'pino';
import qs from 'qs';

import type { Config } from './config/env.js';
import type { Database } from './core/db/prisma.js';
import { docsRouter } from './core/http/docs.js';
import { databaseCheck, healthRouter, type ReadinessCheck } from './core/http/health.js';
import { buildOpenApi } from './core/http/openapi.js';
import type { DeclaredRoute } from './core/http/route.js';
import { memoryPlatform, type Platform } from './core/platform.js';
import { defaultApiRateLimit } from './core/http/rate-limit.js';
import { environmentHeader } from './middleware/environment-header.js';
import { errorHandler, notFoundHandler, requireJsonBody } from './middleware/error-handler.js';
import { httpLogger } from './middleware/http-logger.js';
import { requestContext } from './middleware/request-context.js';
import { corsPolicy, securityHeaders } from './middleware/security.js';

export const API_PREFIX = '/api/v1';

/** A bounded context's HTTP surface, mounted under /api/v1 (Spec P4 §2.1). */
export interface ApiModule {
  readonly name: string;
  /** Mount path under /api/v1, e.g. '/users'. Use '/' for a module that declares full paths. */
  readonly path: string;
  readonly router: Router;
  /** Declared routes (defineModule), used to generate the OpenAPI document. */
  readonly routes?: readonly DeclaredRoute[];
}

export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
  /** Prisma client on the DML-only app account. Passed down to module repositories as they arrive. */
  readonly db: Database;
  /** Module routers. Each epic adds its own. */
  readonly modules?: readonly ApiModule[];
  /** Shared stores (idempotency, rate limits) and their readiness checks. Defaults to in-memory. */
  readonly platform?: Platform;
  /** Extra readiness checks beyond the database and the platform's. */
  readonly readinessChecks?: readonly ReadinessCheck[];
}

/**
 * Builds the Express application without binding a port, so tests can drive it with Supertest.
 * Dependencies are injected. Nothing in here reads `process.env`.
 *
 * Request pipeline (Spec P4 §4.1):
 *   request context → logging → environment header → security headers → CORS
 *   → /health (unauthenticated, outside rate limits) → /docs (non-production)
 *   → JSON-only body guard → JSON parser (size-limited)
 *   → /api/v1: rate limit → [P1.02 authenticate → P1.03 scope → per-route authorize] → module routers
 *   → 404 → error handler (single error envelope)
 */
export function createApp({
  config,
  logger,
  db,
  modules = [],
  platform = memoryPlatform(),
  readinessChecks = [],
}: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  // ETags in this API mean "resource version" (If-Match). Express's automatic body-hash ETags would
  // be confused with them, so they are off.
  app.set('etag', false);
  app.set('trust proxy', config.http.trustProxy);
  // filter[field][op]=… needs bracket parsing. Depth and counts are bounded against abuse.
  app.set('query parser', (str: string) =>
    qs.parse(str, { depth: 2, arrayLimit: 0, parameterLimit: 100, allowDots: false, allowPrototypes: false }),
  );
  // BigInt ids serialise as strings. Prisma Decimal already serialises as a decimal string, never a float.
  app.set('json replacer', (_key: string, value: unknown) =>
    typeof value === 'bigint' ? value.toString() : value,
  );

  app.use(requestContext());
  app.use(httpLogger(logger));
  app.use(environmentHeader(config));
  app.use(securityHeaders(config));
  app.use(corsPolicy(config));

  app.use(
    healthRouter({ config, checks: [databaseCheck(db), ...platform.readinessChecks, ...readinessChecks] }),
  );
  if (config.docs.enabled) {
    app.use(docsRouter(buildOpenApi(modules, { version: config.build.version })));
  }

  app.use(requireJsonBody);
  app.use(express.json({ limit: config.http.bodyLimit, strict: true, type: 'application/json' }));

  const api = Router();
  api.use(defaultApiRateLimit(config.http.rateLimitEnabled, platform.rateLimitStore));
  for (const m of modules) api.use(m.path, m.router);
  app.use(API_PREFIX, api);

  app.use(notFoundHandler);
  app.use(errorHandler(logger));

  return app;
}
