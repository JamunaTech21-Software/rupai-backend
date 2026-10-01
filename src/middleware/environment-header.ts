import type { RequestHandler } from 'express';

import type { Config } from '../config/env.js';

export const ENVIRONMENT_HEADER = 'X-Environment';

/**
 * On every non-production environment, tells the web app which environment it is talking to, so it can
 * show a banner. A user cannot otherwise tell staging from production (Spec P14 §4.3). Production sends
 * nothing. P0.04 adds this header to the CORS exposed-headers list.
 */
export function environmentHeader(config: Pick<Config, 'appEnv' | 'isProduction'>): RequestHandler {
  return (_req, res, next) => {
    if (!config.isProduction) res.setHeader(ENVIRONMENT_HEADER, config.appEnv);
    next();
  };
}
