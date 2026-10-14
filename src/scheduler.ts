import { createDatabase } from './core/db/prisma.js';
import { startHeartbeat } from './core/jobs/heartbeat.js';
import { noQueue, redisQueue } from './core/jobs/queue.js';
import {
  acquireSchedulerLock,
  checkSchedules,
  SchedulerLockHeld,
  startScheduleLoop,
  syncSchedules,
} from './core/jobs/scheduler.js';
import { createLogger } from './core/logging/logger.js';
import { JOB_CATALOGUE_SCHEDULES, registerJobs } from './modules/index.js';
import { exitOnFatal, loadProcessConfig, onShutdown } from './process.js';

/**
 * Scheduler process entry point (P14 §2.1: EXACTLY one). Fires the recurring jobs; workers run them.
 * Refuses to start while another scheduler holds the lock, and exits if it loses the lock, so the
 * supervisor's restart (with backoff) is what recovers it.
 *
 *   node dist/scheduler.js     (npm run start:scheduler; npm run dev:scheduler in development)
 */

const config = loadProcessConfig();
const logger = createLogger(config).child({ process: 'scheduler' });
exitOnFatal(logger);

const db = createDatabase(config);
registerJobs({ db });
const problems = checkSchedules(JOB_CATALOGUE_SCHEDULES, config.timezone);
if (problems.length > 0) {
  logger.fatal({ problems }, 'the schedule definitions are invalid');
  process.exit(1);
}

let lock;
try {
  lock = await acquireSchedulerLock(config.database, (err) => {
    logger.fatal({ err }, 'lost the scheduler lock connection; exiting so the supervisor restarts us');
    process.exit(1);
  });
} catch (err) {
  if (err instanceof SchedulerLockHeld) {
    logger.fatal(err.message);
    process.stderr.write(`${err.message}\n`);
    await db.$disconnect();
    process.exit(1);
  }
  throw err;
}

const queue = config.redis.url ? redisQueue(config.redis.url, logger) : noQueue();
const deps = { db, logger, timezone: config.timezone, queue };
await syncSchedules(deps, JOB_CATALOGUE_SCHEDULES);
const heartbeat = await startHeartbeat(db, logger, { kind: 'scheduler', appVersion: config.build.version });
const loop = startScheduleLoop(deps, JOB_CATALOGUE_SCHEDULES);
logger.info(
  { lock: lock.name, schedules: JOB_CATALOGUE_SCHEDULES.map((s) => s.name), timezone: config.timezone },
  'rupai-scheduler started',
);

const held = lock;
onShutdown(logger, 20, async () => {
  await loop.stop();
  await heartbeat.stop();
  await held.release();
  await Promise.allSettled([queue.close(), db.$disconnect()]);
});
