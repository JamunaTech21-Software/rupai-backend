import { createApp } from './app.js';
import { createDatabase } from './core/db/prisma.js';
import { createLogger } from './core/logging/logger.js';
import { dbAccessLog } from './core/audit/access-log.js';
import { authenticate } from './core/auth/authenticate.js';
import { dbPermissionResolver } from './core/auth/authorize.js';
import { databaseNameOf, sessionStore } from './core/auth/sessions.js';
import { tokenSigner } from './core/auth/tokens.js';
import { inlineQueue, redisQueue, type JobQueue } from './core/jobs/queue.js';
import { runJob } from './core/jobs/runner.js';
import { createMailer } from './core/mail/mailer.js';
import { createPlatform } from './core/platform.js';
import { localFileStorage } from './core/storage/storage.js';
import { buildModules } from './modules/index.js';
import { organisationStartupProblem } from './modules/organisation/organisation.service.js';
import { exitOnFatal, loadProcessConfig, onShutdown } from './process.js';

/**
 * Process entry point: loads and validates configuration, binds the HTTP port, and shuts down cleanly.
 * Every process is supervised and restarted on failure (Spec P14 §6), so a fatal error exits non-zero
 * rather than limping on.
 */

const config = loadProcessConfig();
const logger = createLogger(config);
exitOnFatal(logger);
const db = createDatabase(config);
// P3 §4.1: exactly one organisation row, or the API does not start.
const organisationProblem = await organisationStartupProblem(db).catch((err: unknown) => {
  logger.fatal({ err }, 'cannot check the organisation row');
  process.exit(1);
});
if (organisationProblem) {
  logger.fatal(organisationProblem);
  process.stderr.write(`${organisationProblem}\n`);
  process.exit(1);
}
const platform = await createPlatform(config, logger);
const authz = dbPermissionResolver(db);
const sessions = sessionStore(db, platform.redis, logger, {
  namespace: databaseNameOf(config.database.url),
});
const signer = tokenSigner({
  secret: config.auth.tokenSecret,
  previousSecret: config.auth.previousTokenSecret,
  ttlSeconds: config.auth.accessTokenSeconds,
});
const mailer = createMailer(config, logger);
const accessLog = dbAccessLog(db, logger);
const storage = localFileStorage(config.storage.dir);
// Jobs are announced on Redis for the worker processes (P1 §2.7). Without Redis (development only), they
// run here in the API process, which is fine for trying things and wrong for anything else.
let jobs: JobQueue;
if (config.redis.url) {
  jobs = redisQueue(config.redis.url, logger);
} else {
  logger.warn('REDIS_URL not set: jobs run inside the API process. Development only.');
  const runnerDeps = {
    db,
    logger,
    leaseSeconds: config.jobs.leaseSeconds,
    retentionDays: config.jobs.retentionDays,
  };
  jobs = inlineQueue(async (id) => {
    const r = await runJob(runnerDeps, id);
    if (r.outcome === 'retry') await jobs.dispatch(id, r.retryInSeconds);
  }, logger);
}
const app = createApp({
  config,
  logger,
  db,
  platform,
  authenticate: authenticate({ signer, sessions }),
  modules: buildModules({
    config,
    logger,
    db,
    platform,
    authz,
    sessions,
    signer,
    mailer,
    accessLog,
    storage,
    jobs,
  }),
  // Not ready while documents cannot be stored: uploads would fail one by one otherwise.
  readinessChecks: [{ name: 'storage', run: () => storage.check() }],
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, timezone: config.timezone }, 'rupai-backend listening');
});

onShutdown(logger, 10, async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  logger.info('server closed');
  await Promise.allSettled([jobs.close(), db.$disconnect(), platform.close()]);
});
