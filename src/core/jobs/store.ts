import type { Database } from '../db/prisma.js';
import { constraintViolation } from '../db/errors.js';
import type { Tx } from '../db/transaction.js';
import type { Job, Prisma } from '../../generated/prisma/client.js';
import { jobDefinition } from './registry.js';

/**
 * Creating jobs and guarding their effects (P4 §5.3, P1 §7.7). The `job` row is the truth about a job;
 * the queue (queue.ts) only says "look at job N now".
 */

export interface NewJob {
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * (document, purpose), e.g. `payroll_run:4471:calculate`. While a job with this key is queued or
   * running, asking again returns that job instead of starting a second (P4 §5.3).
   */
  readonly dedupeKey?: string | null;
  readonly requestedBy?: bigint | null;
  readonly scheduleName?: string | null;
}

export interface CreatedJob {
  readonly job: Job;
  /** false: a live job with the same key already existed, and this is it. */
  readonly created: boolean;
}

const KEY_PATTERN = /^[a-z][a-z0-9_]*:[^\s]+$/;

/**
 * Now, to the whole second. The job columns are DATETIME(0), and MySQL ROUNDS a fractional second, so
 * 12:00:00.7 would be stored as 12:00:01: a job created "now" would not be due until a second later.
 */
export function wholeSecond(d = new Date()): Date {
  return new Date(Math.floor(d.getTime() / 1000) * 1000);
}

/**
 * Creates a job in the caller's transaction, so it exists exactly when the change that asked for it
 * commits. Hand it to the queue AFTER the commit (`JobQueue.dispatch`); if that never happens, a worker
 * finds the row anyway.
 */
export async function createJob(tx: Tx | Database, input: NewJob): Promise<CreatedJob> {
  const def = jobDefinition(input.type);
  if (!def) throw new Error(`no job is registered as ${input.type}`);
  const payload = def.payload.parse(input.payload) as Prisma.InputJsonObject;
  const dedupeKey = input.dedupeKey ?? null;
  if (dedupeKey !== null && (!KEY_PATTERN.test(dedupeKey) || dedupeKey.length > 160)) {
    throw new Error(`job dedupe key "${dedupeKey}" must look like <document>:<id>:<purpose>`);
  }
  if (dedupeKey !== null) {
    const live = await tx.job.findUnique({ where: { activeKey: dedupeKey } });
    if (live) return { job: live, created: false };
  }
  try {
    const job = await tx.job.create({
      data: {
        type: def.type,
        payload,
        dedupeKey,
        maxAttempts: def.maxAttempts ?? 3,
        availableAt: wholeSecond(),
        queuedAt: wholeSecond(),
        requestedBy: input.requestedBy ?? null,
        scheduleName: input.scheduleName ?? null,
      },
    });
    return { job, created: true };
  } catch (err) {
    // Two requests at once: the unique live key lets one through; the other returns it.
    const v = constraintViolation(err);
    if (dedupeKey !== null && v?.kind === 'unique' && v.index.includes('ux_job_active')) {
      const live = await tx.job.findUnique({ where: { activeKey: dedupeKey } });
      if (live) return { job: live, created: false };
    }
    throw err;
  }
}

/**
 * The idempotency guard of one effect (P1 §7.7): inserts the key in the transaction that makes the
 * effect. true: go ahead. false: an earlier attempt already made it (and committed), so skip.
 * If the transaction rolls back, so does the key, and the next attempt makes the effect.
 */
export async function claimProcessingKey(tx: Tx, key: string, jobId: bigint | null): Promise<boolean> {
  if (!KEY_PATTERN.test(key) || key.length > 190) {
    throw new Error(`processing key "${key}" must look like <document>:<id>:<purpose>`);
  }
  // A duplicate inserts nothing and reports 0 rows: no error, so the transaction carries on. (IGNORE,
  // not ON DUPLICATE KEY UPDATE: the app account may only insert here. The key is checked above and the
  // table has no foreign key, so a duplicate is the only thing IGNORE can swallow.)
  const inserted = await tx.$executeRaw`
    INSERT IGNORE INTO job_processing_key (\`key\`, job_id) VALUES (${key}, ${jobId})`;
  return inserted === 1;
}
