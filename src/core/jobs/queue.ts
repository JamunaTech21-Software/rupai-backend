import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { Logger } from 'pino';

import { newUlid } from '../ids/ids.js';

/**
 * The fast path from "a job was created" to "a worker is running it" (P1 §2.7 Figure 2.1: API → Redis →
 * worker). It carries only the job's id. It is NOT the record of the job: the `job` row is, and a worker
 * also polls the database, so a lost or doubled message changes nothing (a doubled one is refused by the
 * claim in runner.ts). The spec allows the queue to run on the database alone (P14 §3.3); that is what
 * happens when REDIS_URL is unset or Redis is down, only with the poll interval as the delay.
 */
export interface JobQueue {
  readonly kind: 'redis' | 'inline' | 'none';
  /** Says "job N is due (after `delaySeconds`)". Never throws: the database poll is the fallback. */
  dispatch(jobId: bigint, delaySeconds?: number): Promise<void>;
  close(): Promise<void>;
}

export const QUEUE_NAME = 'jobs';
/** BullMQ keeps its own key prefix (it does not support ioredis keyPrefix): rupai:bull:jobs:… */
const BULL_PREFIX = 'rupai:bull';

export function bullConnection(redisUrl: string): ConnectionOptions {
  const u = new URL(redisUrl);
  return {
    host: u.hostname,
    port: u.port ? Number.parseInt(u.port, 10) : 6379,
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    ...(u.pathname.length > 1 ? { db: Number.parseInt(u.pathname.slice(1), 10) } : {}),
    // A blocking consumer must wait on Redis indefinitely (BullMQ requirement).
    maxRetriesPerRequest: null,
  };
}

/** Producer side, for the API process (and the scheduler and worker, to dispatch retries). */
export function redisQueue(redisUrl: string, logger: Logger): JobQueue {
  const queue = new Queue(QUEUE_NAME, {
    connection: { ...bullConnection(redisUrl), enableOfflineQueue: false },
    prefix: BULL_PREFIX,
  });
  queue.on('error', (err) => {
    logger.warn({ err }, 'job queue error');
  });
  return {
    kind: 'redis',
    async dispatch(jobId, delaySeconds = 0) {
      try {
        await queue.add(
          'run',
          { id: jobId.toString() },
          {
            // A message per dispatch: retries are the database's business (attempts in runner.ts).
            jobId: `${jobId.toString()}-${newUlid()}`,
            delay: Math.max(0, delaySeconds) * 1000,
            attempts: 1,
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 1000 },
          },
        );
      } catch (err) {
        logger.warn(
          { err, job_id: jobId.toString() },
          'could not queue the job; a worker will find it by polling',
        );
      }
    },
    close: () => queue.close(),
  };
}

/** Consumer side, for the worker process. `handle` resolves when the job's run is over. */
export function redisConsumer(
  redisUrl: string,
  logger: Logger,
  concurrency: number,
  handle: (jobId: bigint) => Promise<void>,
): { close(): Promise<void> } {
  const worker = new Worker<{ id: string }>(QUEUE_NAME, async (m) => handle(BigInt(m.data.id)), {
    connection: bullConnection(redisUrl),
    prefix: BULL_PREFIX,
    concurrency,
  });
  worker.on('error', (err) => {
    logger.warn({ err }, 'job queue consumer error');
  });
  return { close: () => worker.close() };
}

/**
 * Development without Redis: runs the job in this process, soon. Never in production (Redis is required
 * there), and never in a worker (which polls).
 */
export function inlineQueue(run: (jobId: bigint) => Promise<unknown>, logger: Logger): JobQueue {
  const timers = new Set<NodeJS.Timeout>();
  return {
    kind: 'inline',
    dispatch(jobId, delaySeconds = 0) {
      const t = setTimeout(() => {
        timers.delete(t);
        run(jobId).catch((err: unknown) => {
          logger.error({ err, job_id: jobId.toString() }, 'inline job run failed');
        });
      }, delaySeconds * 1000);
      timers.add(t);
      return Promise.resolve();
    },
    close() {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      return Promise.resolve();
    },
  };
}

/** Dispatch does nothing: a worker polling the database picks the job up. Tests record what was sent. */
export function noQueue(record?: (jobId: bigint, delaySeconds: number) => void): JobQueue {
  return {
    kind: 'none',
    dispatch(jobId, delaySeconds = 0) {
      record?.(jobId, delaySeconds);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
}
