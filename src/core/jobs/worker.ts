import type { Database } from '../db/prisma.js';
import type { JobQueue } from './queue.js';
import { runJob, type RunnerDeps, type RunResult } from './runner.js';

/**
 * The worker loop (P14 §2.1: 1 to 2 worker processes; P14 §6: graceful shutdown). Jobs arrive two
 * ways, and either alone is enough:
 *   - the queue's fast path (`deliver`, called by the Redis consumer), and
 *   - a poll of the database every JOB_POLL_SECONDS for jobs that are due, or whose run died.
 * Both go through `runJob`, whose claim lets exactly one run hold a job.
 */

export interface WorkerOptions extends RunnerDeps {
  readonly concurrency: number;
  readonly pollSeconds: number;
  readonly shutdownSeconds: number;
  /** Where retries are re-announced, so they start on time rather than at the next poll. */
  readonly queue: JobQueue;
}

export interface JobWorker {
  /** Runs one job now if a slot is free (the fast path). Resolves when its run is over. */
  deliver(jobId: bigint): Promise<void>;
  /** One poll of the database. Exposed for tests; the worker calls it on its interval. */
  poll(): Promise<number>;
  readonly active: number;
  /** Stops taking work, lets running jobs finish for up to shutdownSeconds, then hands back the rest. */
  stop(): Promise<void>;
}

export function startWorker(opts: WorkerOptions): JobWorker {
  const { db, logger } = opts;
  const shutdown = new AbortController();
  const running = new Map<bigint, Promise<void>>();
  let stopping = false;

  async function run(jobId: bigint): Promise<void> {
    let r: RunResult;
    try {
      r = await runJob(opts, jobId, { shutdown: shutdown.signal });
    } catch (err) {
      // The database is unreachable or similar. The job stays as it was; the poll finds it again.
      logger.error({ err, job_id: jobId.toString() }, 'job run could not complete');
      return;
    }
    if (r.outcome === 'retry') await opts.queue.dispatch(jobId, r.retryInSeconds);
  }

  function start(jobId: bigint): Promise<void> | null {
    if (stopping || running.has(jobId) || running.size >= opts.concurrency) return null;
    const p = run(jobId).finally(() => running.delete(jobId));
    running.set(jobId, p);
    return p;
  }

  async function poll(): Promise<number> {
    const free = opts.concurrency - running.size;
    if (stopping || free <= 0) return 0;
    const due = await dueJobs(db, free + running.size);
    let started = 0;
    for (const id of due) {
      if (running.size >= opts.concurrency) break;
      if (start(id)) started += 1;
    }
    return started;
  }

  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    poll()
      .catch((err: unknown) => {
        logger.warn({ err }, 'job poll failed');
      })
      .finally(() => {
        polling = false;
      });
  }, opts.pollSeconds * 1000);
  timer.unref();

  return {
    async deliver(jobId) {
      // A full worker leaves it: the poll (here or in another worker) will take it.
      await start(jobId);
    },
    poll,
    get active() {
      return running.size;
    },
    async stop() {
      stopping = true;
      clearInterval(timer);
      const all = Promise.allSettled([...running.values()]);
      const timeout = new Promise<'timeout'>((resolve) => {
        setTimeout(() => {
          resolve('timeout');
        }, opts.shutdownSeconds * 1000).unref();
      });
      if ((await Promise.race([all, timeout])) === 'timeout') {
        logger.warn(
          { running: running.size },
          'jobs still running at the shutdown deadline; handing them back',
        );
        shutdown.abort();
        await all;
      }
    },
  };
}

/** Jobs a worker may start now: due queued jobs, oldest first, and running jobs whose lease lapsed. */
export async function dueJobs(db: Database, limit: number): Promise<bigint[]> {
  const rows = await db.$queryRaw<{ id: bigint }[]>`
    (SELECT id, available_at AS t FROM job
      WHERE state = 'queued' AND available_at <= UTC_TIMESTAMP() ORDER BY available_at, id LIMIT ${limit})
    UNION ALL
    (SELECT id, lease_until AS t FROM job
      WHERE state = 'running' AND lease_until < UTC_TIMESTAMP() ORDER BY lease_until, id LIMIT ${limit})
    ORDER BY t, id LIMIT ${limit}`;
  return rows.map((r) => r.id);
}
