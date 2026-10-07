/**
 * `npm run docs:openapi`: writes the OpenAPI 3.1 document to docs/openapi.json.
 * Import that file into Postman or Insomnia ("Import → OpenAPI") to get a ready collection (Spec P4 §18.4).
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { loadConfig } from '../src/config/env.js';
import { noAccessLog } from '../src/core/audit/access-log.js';
import { staticPermissionResolver } from '../src/core/auth/authorize.js';
import { sessionStore } from '../src/core/auth/sessions.js';
import { tokenSigner } from '../src/core/auth/tokens.js';
import { createDatabase } from '../src/core/db/prisma.js';
import { buildOpenApi } from '../src/core/http/openapi.js';
import { createLogger } from '../src/core/logging/logger.js';
import { memoryMailer } from '../src/core/mail/mailer.js';
import { memoryPlatform } from '../src/core/platform.js';
import { buildModules } from '../src/modules/index.js';

const version = process.env.APP_VERSION ?? '0.0.0-dev';
// Documentation only: the client never connects, and no request is ever served.
const config = loadConfig({
  APP_ENV: 'development',
  DATABASE_URL: 'mysql://docs:docs@127.0.0.1:3306/docs',
  AUTH_TOKEN_SECRET: 'documentation-only-never-signs-a-real-token',
  LOG_LEVEL: 'silent',
});
const logger = createLogger(config);
const db = createDatabase(config);
const modules = buildModules({
  config,
  logger,
  db,
  platform: memoryPlatform(),
  authz: staticPermissionResolver([]),
  sessions: sessionStore(db, null, logger),
  signer: tokenSigner({ secret: config.auth.tokenSecret, ttlSeconds: config.auth.accessTokenSeconds }),
  mailer: memoryMailer(),
  accessLog: noAccessLog,
});
const doc = buildOpenApi(modules, { version });
mkdirSync('docs', { recursive: true });
writeFileSync('docs/openapi.json', `${JSON.stringify(doc, null, 2)}\n`);
process.stdout.write(`✔ Wrote docs/openapi.json (${Object.keys(doc.paths as object).length} paths)\n`);
