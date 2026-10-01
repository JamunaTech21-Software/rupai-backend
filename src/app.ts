import express, { type Express } from 'express';
import type { Logger } from 'pino';

import type { Config } from './config/env.js';
import { environmentHeader } from './middleware/environment-header.js';
import { httpLogger } from './middleware/http-logger.js';
import { requestContext } from './middleware/request-context.js';

export interface AppDeps {
  readonly config: Config;
  readonly logger: Logger;
}

/**
 * Builds the Express application without binding a port, so tests can drive it with Supertest.
 * Dependencies are injected. Nothing in here reads `process.env`.
 *
 * Middleware order (Spec P4 §4.1 request pipeline). Later epics slot in where marked:
 *   request context → HTTP logging → environment header
 *   → [P0.04] security headers, CORS, body limits, validation, response/error envelope, health
 *   → [P1.x]  authenticate → resolve scope → authorize → module routers under /api/v1
 */
export function createApp({ config, logger }: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');

  app.use(requestContext());
  app.use(httpLogger(logger));
  app.use(environmentHeader(config));
  app.use(express.json({ limit: '1mb' }));

  // Module routers are mounted here under /api/v1 as epics deliver them.

  return app;
}
