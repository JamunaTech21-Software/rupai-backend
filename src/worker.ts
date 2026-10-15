import { createDatabase } from './core/db/prisma.js';
import { startHeartbeat } from './core/jobs/heartbeat.js';
import { noQueue, redisConsumer, redisQueue } from './core/jobs/queue.js';
import { startWorker } from './core/jobs/worker.js';
import { createLogger } from './core/logging/logger.js';
import { createMailer } from './core/mail/mailer.js';
import { registerJobs } from './modules/index.js';
import { exitOnFatal, loadProcessConfig, onShutdown } from './process.js';

/**
 * Worker process entry point (P14 §2.1: one to two of them). Runs deferred and scheduled jobs, in a
 * process separate from the API so a long calculation never holds a request handler or the API's
 * connections (P4 §5.3). Takes jobs from Redis when configured, and polls the database regardless.
 *
 *   node dist/worker.js        (npm run start:worker; npm run dev:worker in development)
 */

const config = loadProcessConfig();
const logger = createLogger(config).child({ process: 'worker' });
exitOnFatal(logger);

const db = createDatabase(config);
registerJobs({ db, config, mailer: createMailer(config, logger) });
const queue = config.redis.url ? redisQueue(config.redis.url, logger) : noQueue();
const worker = startWorker({
  db,
  logger,
  queue,
  concurrency: config.jobs.concurrency,
  leaseSeconds: config.jobs.leaseSeconds,
  pollSeconds: config.jobs.pollSeconds,
  retentionDays: config.jobs.retentionDays,
  shutdownSeconds: config.jobs.shutdownSeconds,
});
const consumer = config.redis.url
  ? redisConsumer(config.redis.url, logger, config.jobs.concurrency, (id) => worker.deliver(id))
  : null;
const heartbeat = await startHeartbeat(db, logger, { kind: 'worker', appVersion: config.build.version });
// Pick up whatever is already due at once, rather than after the first poll interval.
await worker.poll();
logger.info(
  {
    concurrency: config.jobs.concurrency,
    queue: config.redis.url ? 'redis' : 'database only',
    key: heartbeat.key,
  },
  'rupai-worker started',
);

// Running jobs get JOB_SHUTDOWN_SECONDS to finish, then are handed back; a little more for the rest.
onShutdown(logger, config.jobs.shutdownSeconds + 15, async () => {
  await consumer?.close();
  await worker.stop();
  await heartbeat.stop();
  await Promise.allSettled([queue.close(), db.$disconnect()]);
});
