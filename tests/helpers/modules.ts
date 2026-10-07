import type { Logger } from 'pino';

import type { Config } from '../../src/config/env.js';
import { dbAccessLog } from '../../src/core/audit/access-log.js';
import { staticPermissionResolver, type PermissionResolver } from '../../src/core/auth/authorize.js';
import { databaseNameOf, sessionStore } from '../../src/core/auth/sessions.js';
import { tokenSigner } from '../../src/core/auth/tokens.js';
import type { Database } from '../../src/core/db/prisma.js';
import { createLogger } from '../../src/core/logging/logger.js';
import { memoryMailer } from '../../src/core/mail/mailer.js';
import { memoryPlatform, type Platform } from '../../src/core/platform.js';
import type { ModuleDeps } from '../../src/modules/index.js';

/**
 * Everything buildModules needs, with test defaults: in-memory platform and mailer, no permissions,
 * a session store on the given database (and Redis, if the platform has one).
 */
export function testModuleDeps(opts: {
  config: Config;
  db: Database;
  logger?: Logger;
  platform?: Platform;
  authz?: PermissionResolver;
}): ModuleDeps & { mailer: ReturnType<typeof memoryMailer> } {
  const logger = opts.logger ?? createLogger({ appEnv: 'test', log: { level: 'silent', format: 'json' } });
  const platform = opts.platform ?? memoryPlatform();
  return {
    config: opts.config,
    logger,
    db: opts.db,
    platform,
    authz: opts.authz ?? staticPermissionResolver([]),
    sessions: sessionStore(opts.db, platform.redis, logger, {
      namespace: databaseNameOf(opts.config.database.url),
    }),
    signer: tokenSigner({
      secret: opts.config.auth.tokenSecret,
      previousSecret: opts.config.auth.previousTokenSecret,
      ttlSeconds: opts.config.auth.accessTokenSeconds,
    }),
    mailer: memoryMailer(),
    accessLog: dbAccessLog(opts.db, logger),
  };
}
