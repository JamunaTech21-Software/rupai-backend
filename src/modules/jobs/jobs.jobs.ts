import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

import type { Database } from '../../core/db/prisma.js';
import { withTransaction } from '../../core/db/transaction.js';
import { defineJob, type ScheduleDefinition } from '../../core/jobs/registry.js';

/** The job system's own jobs: a self-test that shows the contract at work, and the retention purge. */

const SelfTestPayload = z.object({
  steps: z.number().int().min(1).max(1000),
  step_ms: z.number().int().min(0).max(60_000),
  fail_attempts: z.number().int().min(0).max(10),
});

/**
 * Does `steps` units of work, each in its own transaction guarded by a processing key, saving a
 * checkpoint after each. Stop the worker half way and the job resumes where it stopped; any unit the
 * stopped run finished but did not checkpoint is found by its key and not done again. The result counts
 * both, which is the evidence: performed + already_done = steps, every time.
 */
export function selfTestJob(db: Database) {
  return defineJob({
    type: 'system.self_test',
    label: 'Job system self-test',
    payload: SelfTestPayload,
    maxAttempts: 5,
    async run(ctx) {
      const { steps, step_ms: stepMs, fail_attempts: failAttempts } = ctx.payload;
      const from = (ctx.checkpoint as { next_step?: number } | null)?.next_step ?? 0;
      await ctx.progress(from, steps);
      let performed = 0;
      let alreadyDone = 0;
      for (let step = from; step < steps; step += 1) {
        ctx.signal.throwIfAborted();
        if (step === Math.floor(steps / 2) && ctx.attempt <= failAttempts) {
          throw new Error(`Self-test failure on attempt ${String(ctx.attempt)}, as requested.`);
        }
        if (stepMs > 0) await sleep(stepMs, undefined, { signal: ctx.signal });
        const fresh = await withTransaction(db, (tx) =>
          ctx.once(tx, `job:${ctx.jobId.toString()}:self_test:step:${String(step)}`),
        );
        if (fresh) performed += 1;
        else alreadyDone += 1;
        await ctx.progress(step + 1, steps, { next_step: step + 1 });
      }
      const keys = await db.jobProcessingKey.count({ where: { jobId: ctx.jobId } });
      return {
        result: {
          steps,
          resumed_from_step: from,
          performed_this_attempt: performed,
          found_already_done: alreadyDone,
          processing_keys: keys,
          attempt: ctx.attempt,
        },
      };
    },
  });
}

const BATCH = 1000;

/** Finished jobs past their retention (P4 §5.3: seven days), and long-gone processes' heartbeats. */
export function purgeJobsJob(db: Database) {
  return defineJob({
    type: 'system.purge_jobs',
    label: 'Purge finished jobs',
    payload: z.object({}),
    async run(ctx) {
      let jobs = 0;
      for (;;) {
        ctx.signal.throwIfAborted();
        // Deleting finished rows is idempotent by nature: a re-run finds fewer of them.
        const n = await db.$executeRaw`
          DELETE FROM job WHERE state IN ('completed', 'failed', 'partial') AND expires_at < UTC_TIMESTAMP()
          ORDER BY id LIMIT ${BATCH}`;
        jobs += n;
        await ctx.progress(jobs);
        if (n < BATCH) break;
      }
      const heartbeats = await db.$executeRaw`
        DELETE FROM process_heartbeat WHERE beat_at < UTC_TIMESTAMP() - INTERVAL 7 DAY`;
      return { result: { jobs_deleted: jobs, heartbeats_deleted: heartbeats } };
    },
  });
}

export const JOB_SCHEDULES: readonly ScheduleDefinition[] = [
  {
    name: 'system.purge_jobs',
    description: 'Removes finished jobs once their results are past retention.',
    cron: '0 3 * * *',
    jobType: 'system.purge_jobs',
  },
];
