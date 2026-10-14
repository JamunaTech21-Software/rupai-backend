import type { Logger } from 'pino';

import { runWithRequestContext } from '../context/request-context.js';
import type { Database } from '../db/prisma.js';
import { AppError } from '../errors/app-error.js';
import { newUlid } from '../ids/ids.js';
import { backoffSeconds } from './cron.js';
import { jobDefinition, PermanentJobError, type JobContext, type JobOutcome } from './registry.js';
import { claimProcessingKey, wholeSecond } from './store.js';

/**
 * Runs one job (P4 §5.3, P1 §2.7, P14 §6). Any number of workers, and any number of deliveries of the
 * same job, may call this at once: the claim is one conditional UPDATE, so exactly one run holds the job
 * at a time, under a lease it keeps renewing. A run that dies stops renewing; once the lease lapses the
 * job may be claimed again, and resumes from its checkpoint.
 *
 *   queued ──claim──▶ running ──▶ completed | partial
 *                        │
 *                        ├─ error, attempts left ──▶ queued (after backoff)
 *                        ├─ error, none left / permanent ──▶ failed   (the dead letter: kept, visible)
 *                        └─ worker shutting down ──▶ queued (the attempt is not counted)
 *
 * All times come from the database clock (UTC_TIMESTAMP), so workers on skewed clocks agree on leases.
 */

export interface RunnerDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly leaseSeconds: number;
  readonly retentionDays: number;
}

export type RunResult =
  /** Another run holds it, it is not due, or it is already finished: nothing was done. */
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'completed' | 'partial' | 'failed' }
  /** Failed this attempt; due again at `retryInSeconds`. */
  | { readonly outcome: 'retry'; readonly retryInSeconds: number }
  /** Handed back unfinished because the worker is stopping. */
  | { readonly outcome: 'released' }
  /** This run lost its lease mid-way; another run owns the job now. */
  | { readonly outcome: 'lost' };

const MESSAGE_MAX = 1000;

function describeError(err: unknown): { code: string; message: string; permanent: boolean } {
  if (err instanceof PermanentJobError) return { code: err.code, message: err.message, permanent: true };
  if (err instanceof AppError) {
    // A refusal by the business rules will refuse again: retrying it only delays the answer.
    const permanent = err.status >= 400 && err.status < 500 && err.status !== 409 && err.status !== 429;
    return { code: err.code, message: err.message, permanent };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'JOB_FAILED', message, permanent: false };
}

export async function runJob(
  deps: RunnerDeps,
  jobId: bigint,
  options: { shutdown?: AbortSignal } = {},
): Promise<RunResult> {
  const { db, leaseSeconds } = deps;
  const token = newUlid();

  const claimed = await db.$executeRaw`
    UPDATE job
       SET state = 'running', run_token = ${token},
           lease_until = UTC_TIMESTAMP() + INTERVAL ${leaseSeconds} SECOND,
           attempts = attempts + 1, started_at = COALESCE(started_at, UTC_TIMESTAMP()),
           version = version + 1, updated_at = UTC_TIMESTAMP()
     WHERE id = ${jobId} AND attempts < max_attempts
       AND ((state = 'queued' AND available_at <= UTC_TIMESTAMP())
         OR (state = 'running' AND lease_until < UTC_TIMESTAMP()))`;
  if (claimed !== 1) {
    // A run that died on its last attempt can never be claimed again: it has failed.
    const abandoned = await db.$executeRaw`
      UPDATE job
         SET state = 'failed', run_token = NULL, lease_until = NULL, error_code = 'JOB_ABANDONED',
             error_message = 'The job stopped responding on its last attempt.',
             finished_at = UTC_TIMESTAMP(), expires_at = UTC_TIMESTAMP() + INTERVAL ${deps.retentionDays} DAY,
             version = version + 1, updated_at = UTC_TIMESTAMP()
       WHERE id = ${jobId} AND state = 'running' AND lease_until < UTC_TIMESTAMP()
         AND attempts >= max_attempts`;
    return { outcome: abandoned === 1 ? 'failed' : 'skipped' };
  }

  const job = await db.job.findUniqueOrThrow({ where: { id: jobId } });
  const logger = deps.logger.child({ job_id: jobId.toString(), job_type: job.type, attempt: job.attempts });

  /** Applies an update only while this run still holds the job. */
  const asHolder = async (data: Parameters<Database['job']['updateMany']>[0]['data']) =>
    (await db.job.updateMany({ where: { id: jobId, runToken: token }, data })).count === 1;

  interface Finish {
    readonly result?: Readonly<Record<string, unknown>> | null;
    readonly code?: string;
    readonly message?: string;
  }
  const finish = async (state: 'completed' | 'partial' | 'failed', f: Finish) => {
    const result = f.result ? JSON.stringify(f.result) : null;
    await db.$executeRaw`
      UPDATE job
         SET state = ${state}, run_token = NULL, lease_until = NULL, finished_at = UTC_TIMESTAMP(),
             expires_at = UTC_TIMESTAMP() + INTERVAL ${deps.retentionDays} DAY,
             result = ${result}, error_code = ${f.code ?? null},
             error_message = ${f.message?.slice(0, MESSAGE_MAX) ?? null},
             progress_done = CASE WHEN ${state} = 'completed' AND progress_total IS NOT NULL
                                  THEN progress_total ELSE progress_done END,
             version = version + 1, updated_at = UTC_TIMESTAMP()
       WHERE id = ${jobId} AND run_token = ${token}`;
  };

  const def = jobDefinition(job.type);
  if (!def) {
    await finish('failed', {
      code: 'UNKNOWN_JOB_TYPE',
      message: `No handler is registered for ${job.type}.`,
    });
    logger.error('job failed: unknown type');
    return { outcome: 'failed' };
  }
  const parsed = def.payload.safeParse(job.payload);
  if (!parsed.success) {
    await finish('failed', { code: 'INVALID_JOB_PAYLOAD', message: parsed.error.message });
    logger.error({ err: parsed.error }, 'job failed: invalid payload');
    return { outcome: 'failed' };
  }

  const lease = new AbortController();
  const stop = new AbortController();
  const onShutdown = () => {
    stop.abort(new Error('the worker is shutting down'));
  };
  options.shutdown?.addEventListener('abort', onShutdown, { once: true });
  if (options.shutdown?.aborted) onShutdown();
  const signal = AbortSignal.any([lease.signal, stop.signal]);

  const renew = async () => {
    const held = await db.$executeRaw`
      UPDATE job SET lease_until = UTC_TIMESTAMP() + INTERVAL ${leaseSeconds} SECOND
       WHERE id = ${jobId} AND run_token = ${token}`;
    if (held !== 1 && !lease.signal.aborted) lease.abort(new Error('the lease was taken over'));
  };
  const timer = setInterval(
    () => {
      renew().catch((err: unknown) => {
        logger.warn({ err }, 'could not renew the job lease');
      });
    },
    Math.max(1, Math.floor(leaseSeconds / 3)) * 1000,
  );
  timer.unref();

  const ctx: JobContext<unknown> = {
    jobId,
    type: job.type,
    payload: parsed.data,
    attempt: job.attempts,
    checkpoint: job.checkpoint ?? null,
    requestedBy: job.requestedBy,
    logger,
    signal,
    async progress(done, total, checkpoint) {
      const setTotal = total !== undefined;
      const newTotal = total === undefined || total === null ? null : Math.max(0, Math.trunc(total));
      const setCheckpoint = checkpoint !== undefined;
      const point = setCheckpoint ? JSON.stringify(checkpoint ?? null) : null;
      const held = await db.$executeRaw`
        UPDATE job
           SET progress_total = CASE WHEN ${setTotal} THEN ${newTotal} ELSE progress_total END,
               progress_done = LEAST(${Math.max(0, Math.trunc(done))},
                                     COALESCE(CASE WHEN ${setTotal} THEN ${newTotal} ELSE progress_total END, 2147483647)),
               checkpoint = CASE WHEN ${setCheckpoint} THEN CAST(${point} AS JSON) ELSE checkpoint END,
               lease_until = UTC_TIMESTAMP() + INTERVAL ${leaseSeconds} SECOND
         WHERE id = ${jobId} AND run_token = ${token}`;
      if (held !== 1 && !lease.signal.aborted) lease.abort(new Error('the lease was taken over'));
    },
    once: (tx, key) => claimProcessingKey(tx, key, jobId),
  };

  logger.info('job started');
  try {
    const outcome: JobOutcome | undefined = await runWithRequestContext(
      { requestId: `job:${jobId.toString()}`, logger, unscoped: `job ${job.type}` },
      () => def.run(ctx),
    );
    if (lease.signal.aborted) {
      logger.warn('job finished after losing its lease; the result is discarded');
      return { outcome: 'lost' };
    }
    const state = outcome?.state ?? 'completed';
    await finish(state, { result: outcome?.result ?? null });
    logger.info({ state }, 'job finished');
    return { outcome: state };
  } catch (err) {
    if (lease.signal.aborted) {
      logger.warn({ err }, 'job stopped: its lease was taken over');
      return { outcome: 'lost' };
    }
    if (stop.signal.aborted) {
      // Not the job's fault: hand it back now, without spending an attempt.
      await asHolder({
        state: 'queued',
        runToken: null,
        leaseUntil: null,
        attempts: { decrement: 1 },
        availableAt: wholeSecond(),
      });
      logger.info('job handed back: the worker is stopping');
      return { outcome: 'released' };
    }
    const e = describeError(err);
    if (!e.permanent && job.attempts < job.maxAttempts) {
      const wait = backoffSeconds(job.attempts);
      await db.$executeRaw`
        UPDATE job
           SET state = 'queued', run_token = NULL, lease_until = NULL,
               available_at = UTC_TIMESTAMP() + INTERVAL ${wait} SECOND,
               error_code = ${e.code}, error_message = ${e.message.slice(0, MESSAGE_MAX)},
               version = version + 1, updated_at = UTC_TIMESTAMP()
         WHERE id = ${jobId} AND run_token = ${token}`;
      logger.warn({ err, retry_in_seconds: wait }, 'job attempt failed; it will be retried');
      return { outcome: 'retry', retryInSeconds: wait };
    }
    await finish('failed', { code: e.code, message: e.message });
    logger.error({ err }, 'job failed');
    return { outcome: 'failed' };
  } finally {
    clearInterval(timer);
    options.shutdown?.removeEventListener('abort', onShutdown);
  }
}
